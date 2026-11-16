import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

// The foundation preload puts all state and configuration under a temporary home.
const { estimateSessionCost } = await import("../../dist/usage/estimate.js");
const { budgetEstimate } = await import("../../dist/providers/router.js");
const { estimateUsd } = await import("../../dist/execution/pricing.js");
const { MAX_TOKENS, ROUNDTABLE_HOME, SESSIONS_DIR, ACTIVITY_LOG_PATH } = await import("../../dist/config.js");
const { startUltraplan, submitPlan, endUltraplan, ultraplans, listUltraplans, formatUltraplanEstimate } = await import("../../dist/sessions/ultraplan.js");
const { readArchivedSession } = await import("../../dist/sessions/archive.js");
const { sessionCapView, stopCappedSession } = await import("../../dist/usage/session-caps.js");
const { withUsageSink } = await import("../../dist/providers/usage.js");
const { providerHealth } = await import("../../dist/providers/health.js");
await import("../../dist/usage/table-service.js"); // Install the normal session cap stop path.
const { handleToolCall, tools } = await import("../../dist/tools.js");

const fixture = name => fileURLToPath(new URL(`../fixtures/ultraplan/${name}.md`, import.meta.url));
const cfo = fixture("cfo"), skeptic = fixture("skeptic"), planner = fixture("planner");
const baseUrl = "http://localhost:1234/v1";
const opts = { provider: "openai_compatible", model: "claude-sonnet-5-5", baseUrl };
const toolOpts = { provider: opts.provider, model: opts.model, base_url: baseUrl };
const tokens = { inputTokens: 100, outputTokens: 20 };
const close = id => handleToolCall("end_ultraplan", { ultraplan_id: id });
const trailer = text => JSON.parse(/```json\n([\s\S]*)\n```$/.exec(text)[1]);
const files = dir => existsSync(dir) ? readdirSync(dir).sort() : [];

function fakeProvider(t, beforeCall, measured = true) {
  return stubFetch(t, (url, init) => {
    if (url.endsWith("/api/tags")) return json(200, { models: [] });
    beforeCall?.();
    const req = JSON.parse(init.body);
    const prompt = req.messages.at(-1).content;
    const content = prompt.includes("**Final plan") ? "Sign-off: APPROVE\nReady."
      : prompt.includes("The first line must be EXACTLY") ? "Verdict: APPROVE\nClear."
        : "1. Deliver with checks.";
    if (url.endsWith("/api/chat")) return json(200, { model: req.model, message: { content }, ...(measured && { prompt_eval_count: 100, eval_count: 20 }) });
    assert.equal(url, `${baseUrl}/chat/completions`, `Unexpected request: ${url}`);
    return json(200, { model: req.model, choices: [{ message: { content } }],
      ...(measured && { usage: { prompt_tokens: 100, completion_tokens: 20 } }) });
  });
}

function env(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
}

afterEach(() => assert.equal(ultraplans.size, 0, "no live sessions left behind"));

test("shared estimator prices each seat, keeps free calls free, and labels conservative prices", () => {
  const known = { seat: "a", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 2000 };
  const free = { seat: "b", provider: "ollama", model: "unknown-local", ...tokens };
  const unknown = { seat: "c", provider: "openai_compatible", model: "unknown-cost-model", ...tokens };
  const result = estimateSessionCost({ calls: [known, known, free, unknown, { ...known, seat: "d" }] });
  const price = estimateUsd(known.model, known, { provider: known.provider }).usd;
  const conservative = budgetEstimate(unknown.provider, unknown.model, unknown).usd;
  assert.equal(price, 0.022);
  assert.equal(result.calls, 5);
  assert.equal(result.perSeat.length, 4);
  assert.equal(result.usd, Math.round((3 * price + conservative) * 1e9) / 1e9);
  assert.equal(result.estimated, true);
  assert.deepEqual(result.perSeat.map(line => [line.seat, line.calls, line.usd, line.estimated]),
    [["a", 2, 2 * price, false], ["b", 1, 0, false], ["c", 1, conservative, true], ["d", 1, price, false]]);
  assert.equal(result.perSeat[0].inputTokens, 2000);
  assert.equal(result.perSeat[0].outputTokens, 4000);
  assert.equal(estimateSessionCost({ calls: [known, free] }).estimated, false);
  assert.deepEqual(estimateSessionCost({ calls: [] }), { usd: 0, calls: 0, perSeat: [], estimated: false });
  assert.match(formatUltraplanEstimate(result), /unknown-cost-model \$[\d.]+ \(estimated\)/);
  for (const n of [-1, NaN, Infinity, 1.5]) assert.throws(() => estimateSessionCost({ calls: [{ ...known, inputTokens: n }] }), /token bounds/);
});

test("dry_run returns the same estimate as a real start with zero provider calls and no session state", async t => {
  let observed;
  const calls = fakeProvider(t, () => assert.ok(observed, "estimate precedes the first provider call"));
  const before = files(SESSIONS_DIR);
  const activity = existsSync(ACTIVITY_LOG_PATH);
  const args = { agents: [cfo, skeptic], task: "Ship", context: "Budget and risks", max_usd: 10, ...toolOpts };
  const dry = await handleToolCall("start_ultraplan", { ...args, dry_run: true });
  assert.equal(dry.isError, undefined, dry.content[0].text);
  const preview = JSON.parse(dry.content[0].text);
  assert.equal(preview.status, "dry_run");
  assert.equal(preview.dry_run, true);
  assert.equal(preview.ultraplanId, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(listUltraplans(), []);
  assert.deepEqual(files(SESSIONS_DIR), before);
  assert.equal(existsSync(ACTIVITY_LOG_PATH), activity);
  assert.deepEqual(preview.usage, { spent_usd: 0, max_usd: 10, cap_reached: false });
  assert.match(preview.estimate_line, /^Estimated cost: up to \$[\d.]+ \(6 agent calls;/);
  assert.match(preview.usage_line, /^Usage: spent \$0\.0000 of \$10 cap$/);
  const real = await startUltraplan(args.agents, args.task, { ...opts, context: args.context, maxUsd: 10,
    onEstimate: estimate => { assert.equal(calls.length, 0); observed = estimate; } });
  assert.equal(real.phase, "input", "normal starts still run the input phase");
  assert.equal(calls.length, 2);
  assert.deepEqual(real.estimate, preview.estimate);
  assert.deepEqual(real.estimate, observed);
  assert.equal(sessionCapView(real.ultraplanId).maxUsd, 10);
  await endUltraplan(real.ultraplanId);
});

test("dry runs skip public channels and connector startup but still validate connector names", async t => {
  const calls = fakeProvider(t);
  const path = join(ROUNDTABLE_HOME, "config.json");
  mkdirSync(ROUNDTABLE_HOME, { recursive: true });
  writeFileSync(path, JSON.stringify({ connectors: { offline: { command: "/usr/bin/false", args: [], env: {} } } }));
  t.after(() => rmSync(path, { force: true }));
  const preview = await startUltraplan([cfo], "Plan", { ...opts, dryRun: true, public: true, connectors: ["offline"], maxUsd: 1 });
  assert.equal(preview.status, "dry_run");
  assert.equal(calls.length, 0, "no provider or public requests");
  for (const dryRun of [true, false]) {
    await assert.rejects(startUltraplan([cfo], "Plan", { ...opts, dryRun, connectors: ["missing"] }), /Unknown connector/);
  }
});

test("dry_run validates the same arguments as a real start", async t => {
  const calls = fakeProvider(t);
  for (const bad of [
    { task: " " }, { agents: [] }, { agents: [fixture("missing")] }, { max_usd: 0 },
    { revision_rounds: "3" }, { draft_plan: {} }, { provider: "bad-provider" },
    { provider: "ollama", base_url: baseUrl }, { seat_connectors: { other: ["missing"] } },
  ]) {
    const args = { agents: [cfo], task: "Plan", ...toolOpts, ...bad };
    const dry = await handleToolCall("start_ultraplan", { ...args, dry_run: true });
    const real = await handleToolCall("start_ultraplan", args);
    assert.equal(dry.isError, true, JSON.stringify(bad));
    assert.deepEqual(dry, real);
  }
  assert.equal(calls.length, 0);
  const tool = tools.find(tool => tool.name === "start_ultraplan");
  assert.equal(tool.inputSchema.properties.dry_run.type, "boolean");
  assert.ok(tool.description.includes("Call with dry_run: true first to get the cost estimate without calling any agent; when it is above $0, show it to the person before starting."));
});

test("automatic seats use their resolved model and output ceiling before any preflight", async t => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN", "OLLAMA_URL"]) env(t, key, undefined);
  env(t, "OPENAI_COMPATIBLE_BASE_URL", baseUrl);
  const path = join(ROUNDTABLE_HOME, "config.json");
  writeFileSync(path, JSON.stringify({ routing: { openai_compatible: { judge: { model: "bounded-cost-model", maxOutputTokens: 128 } } } }));
  t.after(() => rmSync(path, { force: true }));
  providerHealth.clear();
  let estimate;
  const calls = fakeProvider(t, () => assert.ok(estimate, "even preflight follows the estimate"));
  const dry = await startUltraplan([cfo], "Plan", { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(dry.routing[0].provider, "openai_compatible");
  assert.equal(dry.estimate.perSeat[0].model, "bounded-cost-model");
  assert.equal(dry.estimate.perSeat[0].outputTokens, 3 * 128);
  assert.equal(dry.estimate.estimated, true);
  const real = await startUltraplan([cfo], "Plan", { onEstimate: value => { estimate = value; assert.equal(calls.length, 0); } });
  assert.deepEqual(real.estimate, dry.estimate);
  assert.equal(calls.length, 2, "health preflight plus input turn");
  assert.equal(calls[1].body.max_tokens, 128);
  await endUltraplan(real.ultraplanId);
});

test("planner estimates include input, all clamped review and revision rounds, and sign-off", async t => {
  const calls = fakeProvider(t);
  for (const [requested, rounds] of [[undefined, 1], [-1, 1], [2, 2], [9, 3]]) {
    for (const draftPlan of [undefined, "A supplied draft."]) {
      const options = { ...opts, planner, revisionRounds: requested, draftPlan };
      const dry = await startUltraplan([cfo, skeptic], "Plan", { ...options, dryRun: true });
      const count = 2 * ((draftPlan ? 0 : 1) + rounds + 1) + (draftPlan ? 0 : 1) + rounds;
      assert.equal(dry.estimate.calls, count);
      assert.equal(dry.estimate.perSeat.find(line => line.seat === "planner").calls, (draftPlan ? 0 : 1) + rounds);
      const before = calls.length;
      const real = await startUltraplan([cfo, skeptic], "Plan", options);
      assert.equal(real.status, "finalized");
      assert.equal(calls.length - before, count);
      assert.deepEqual(real.estimate, dry.estimate);
      assert.ok(real.estimate.usd >= real.usage.spent_usd);
    }
  }
});

test("longer topic, context and draft raise the input bound, with an allowance for future plans", async () => {
  const short = await startUltraplan([cfo], "Plan", { ...opts, dryRun: true, draftPlan: "Draft" });
  const long = await startUltraplan([cfo], "Plan".repeat(100), { ...opts, dryRun: true, context: "Background".repeat(100), draftPlan: "Draft".repeat(100) });
  assert.equal(short.estimate.calls, 2);
  assert.ok(long.estimate.usd > short.estimate.usd);
  assert.ok(short.estimate.perSeat[0].inputTokens >= MAX_TOKENS);
  const ignored = await startUltraplan([cfo], "Plan", { ...opts, dryRun: true, draftPlan: "Draft", revisionRounds: 3 });
  assert.deepEqual(ignored.estimate, short.estimate, "revision_rounds applies only to planner runs");
});

test("all-Ollama estimates and usage stay $0.00 without an estimated flag", async t => {
  const calls = fakeProvider(t, undefined, false);
  const local = { provider: "ollama", model: "qwen3:14b" };
  const dry = await startUltraplan([cfo, skeptic], "Plan", { ...local, dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(dry.estimate.usd, 0);
  assert.equal(dry.estimate.estimated, false);
  assert.ok(dry.estimate.perSeat.every(line => line.usd === 0 && !line.estimated));
  assert.match(formatUltraplanEstimate(dry.estimate), /^Estimated cost: up to \$0\.00/);
  assert.doesNotMatch(formatUltraplanEstimate(dry.estimate), /\(estimated\)/);
  const start = await startUltraplan([cfo, skeptic], "Plan", local);
  assert.deepEqual(start.estimate, dry.estimate);
  assert.deepEqual(start.usage, { spent_usd: 0 });
  const reviewed = await submitPlan(start.ultraplanId, "Ship");
  assert.deepEqual(reviewed.usage, { spent_usd: 0 });
  const final = await submitPlan(start.ultraplanId, undefined, true);
  assert.deepEqual(final.usage, { spent_usd: 0 });
  assert.deepEqual(readArchivedSession(final.ultraplanId).usage, final.usage);
});

test("start, submit, end and archive carry cumulative metered spend and one usage line", async t => {
  const calls = fakeProvider(t);
  const oneCall = estimateUsd(opts.model, tokens, { provider: opts.provider }).usd;
  const startResponse = await handleToolCall("start_ultraplan", { agents: [cfo], task: "Plan", max_usd: 1, ...toolOpts });
  assert.equal(startResponse.isError, undefined, startResponse.content[0].text);
  const start = JSON.parse(startResponse.content[0].text);
  assert.deepEqual(start.usage, { spent_usd: oneCall, max_usd: 1, cap_reached: false, estimated: true });
  assert.match(start.usage_line, /^Usage: spent \$0\.0004 of \$1 cap \(estimated\)$/);
  const submitted = await handleToolCall("submit_plan", { ultraplan_id: start.ultraplanId, plan: "Deliver" });
  const review = JSON.parse(submitted.content[0].text);
  assert.equal(review.usage.spent_usd, 2 * oneCall);
  assert.match(review.usage_line, /^Usage: /);
  const ended = await close(start.ultraplanId);
  const end = trailer(ended.content[0].text);
  assert.deepEqual(end.usage, review.usage);
  assert.equal((ended.content[0].text.match(/^Usage: /gm) ?? []).length, 1);
  const archive = readArchivedSession(start.ultraplanId);
  assert.deepEqual(archive.usage, end.usage);
  assert.match(archive.document.markdown, /^Usage: spent \$0\.0008 of \$1 cap \(estimated\)$/m);
  assert.equal(calls.length, 2, "ending does not call a provider");
});

test("final submit reports spend without a cap and includes sign-off in the archive", async t => {
  fakeProvider(t);
  const start = await startUltraplan([cfo], "Plan", opts);
  assert.equal(start.usage.max_usd, undefined);
  assert.equal(start.usage.cap_reached, undefined);
  const done = await handleToolCall("submit_plan", { ultraplan_id: start.ultraplanId, plan: "Deliver", final: true });
  const final = trailer(done.content[0].text);
  assert.equal(final.usage.spent_usd, 2 * start.usage.spent_usd);
  assert.equal(final.usage.estimated, true);
  assert.match(done.content[0].text, /^Usage: \$0\.0008 \(estimated\)$/m);
  assert.deepEqual(readArchivedSession(start.ultraplanId).usage, final.usage);
});

test("unpriced spend uses the cap rate and an outer usage sink receives reports once", async t => {
  fakeProvider(t);
  const reports = [];
  const unknown = { ...opts, model: "unknown-cost-model", maxUsd: 1 };
  const start = await withUsageSink(report => reports.push(report), () => startUltraplan([cfo], "Plan", unknown));
  const oneCall = budgetEstimate(unknown.provider, unknown.model, tokens).usd;
  assert.equal(start.usage.spent_usd, oneCall);
  assert.equal(start.usage.estimated, true);
  const final = await withUsageSink(report => reports.push(report), () => submitPlan(start.ultraplanId, "Deliver", true));
  assert.equal(reports.length, 2);
  assert.equal(final.usage.spent_usd, 2 * oneCall);
  assert.equal(sessionCapView(start.ultraplanId).spentUsd, 2 * oneCall);
  assert.deepEqual(readArchivedSession(start.ultraplanId).usage, final.usage);
});

test("a cap below the estimate adds a note and allows the normal input round", async t => {
  const calls = fakeProvider(t);
  const args = { agents: [cfo], task: "Plan", max_usd: 0.01, ...toolOpts };
  const dry = JSON.parse((await handleToolCall("start_ultraplan", { ...args, dry_run: true })).content[0].text);
  assert.equal(calls.length, 0);
  assert.ok(dry.estimate.usd > args.max_usd);
  assert.match(dry.estimateNote, /exceeds the \$0\.01 cap.*Starting is allowed; the cap still stops/);
  const response = await handleToolCall("start_ultraplan", args);
  assert.equal(response.isError, undefined, response.content[0].text);
  const start = JSON.parse(response.content[0].text);
  assert.deepEqual(start.estimate, dry.estimate);
  assert.equal(start.estimateNote, dry.estimateNote);
  assert.equal(start.phase, "input");
  assert.equal(calls.length, 1);
  assert.equal(start.usage.cap_reached, false);
  await close(start.ultraplanId);
});

test("a reached cap is reflected in the result, usage line and stopped archive", async t => {
  fakeProvider(t);
  const start = await startUltraplan([cfo], "Plan", { ...opts, maxUsd: 0.0001 });
  assert.equal(start.usage.cap_reached, true);
  await stopCappedSession(start.ultraplanId);
  assert.equal(sessionCapView(start.ultraplanId).reached, true);
  const archive = readArchivedSession(start.ultraplanId);
  assert.deepEqual(archive.usage, start.usage);
  assert.match(archive.document.markdown, /Usage: .*\(stopped by spend cap\).*\(estimated\)/);
});
