import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCastingCall } from "../../dist/casting/casting.js";
import { renderRoster, renderCastingMarkdown } from "../../dist/casting/report.js";
import { ROUNDTABLE_HOME, PARALLEL_TURNS } from "../../dist/config.js";
import { readTableLines } from "../../dist/usage/table.js";
import { tools, handleToolCall } from "../../dist/tools.js";
import { json, stubFetch } from "./helpers.mjs";

const agents = ["architect", "engineer", "researcher", "reviewer"];
const dir = fileURLToPath(new URL("../fixtures/casting", import.meta.url));
const options = { brief: "Build a queue module", agents, agentsDir: dir, provider: "openai_compatible", model: "claude-sonnet-5-5", seats: 4 };
const verdict = () => ({ agents: agents.map(key => ({ key, verdict: "cast", role: `Own ${key}`, strengths: ["Clear lane"], risks: [], overlapsWith: [] })), redundancy: [], gaps: ["Operations"], recommended: { seats: [...agents], teamA: ["architect", "engineer"], teamB: ["researcher"], judges: ["reviewer"] } });
const noSignal = () => new AbortController().signal;

function setup(t, script = {}) {
  const previous = process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1/v1";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL; else process.env.OPENAI_COMPATIBLE_BASE_URL = previous; });
  let active = 0, peak = 0, questionCalls = 0, verdictCalls = 0;
  const calls = stubFetch(t, async (_url, init) => {
    active++; peak = Math.max(peak, active);
    try {
      const request = JSON.parse(init.body), prompt = request.messages.at(-1).content;
      let content;
      if (prompt.includes("Audition in at most 120 words")) {
        const persona = /You are the (\w+)/.exec(request.messages[0].content)?.[1];
        if (script.audition) await script.audition(persona, init);
        if (persona === script.fail) throw new Error("Persona failed with secret-canary-value");
        content = script.long ? "Evidence ".repeat(200) : `I own ${persona}; push back on scope creep; implementation outside my lane.`;
      } else if (prompt.includes("Cross-examine each persona")) {
        questionCalls++;
        content = (script.badQuestions || (script.retryQuestions && questionCalls === 1)) ? "not JSON" : JSON.stringify(Object.fromEntries(agents.filter(a => a !== script.fail).map(a => [a, "What evidence would change your approach?"])));
      } else if (prompt.includes("Answer in at most 80 words")) content = script.long ? "Answer ".repeat(200) : "I would verify the key assumption before committing.";
      else if (prompt.includes("Return a roster report JSON object")) {
        verdictCalls++;
        content = (script.badVerdict || (script.retryVerdict && verdictCalls === 1)) ? (verdictCalls === 1 ? "```json\n{bad\n```" : '{"agents":"wrong"}') : JSON.stringify(script.verdict ?? verdict());
      } else throw new Error("Unexpected casting prompt");
      return json(200, { choices: [{ message: { content }, finish_reason: "stop" }], model: request.model, usage: { prompt_tokens: 100, completion_tokens: 30 } });
    } finally { active--; }
  });
  return { calls, peak: () => peak, questionCalls: () => questionCalls, verdictCalls: () => verdictCalls };
}
async function run(t, script = {}, overrides = {}, signal = noSignal(), observer) {
  const fetch = setup(t, script), events = [];
  const report = await runCastingCall({ ...options, ...overrides }, { async onEvent(event) { events.push(event); await observer?.(event); } }, signal);
  return { ...fetch, events, report };
}
const archiveFor = async report => JSON.parse(await readFile(join(ROUNDTABLE_HOME, "casting", `${report.id}.json`), "utf8"));
const assertNote = async (report, pattern) => {
  assert.match(report.note, pattern);
  assert.ok(renderRoster(report).indexOf(report.note) < renderRoster(report).indexOf("architect ["));
  assert.ok(renderCastingMarkdown(report).indexOf(report.note) < renderCastingMarkdown(report).indexOf("| Persona |"));
  assert.match(renderCastingMarkdown(report), /Gaps: not assessed/);
  const archive = await archiveFor(report);
  assert.equal(archive.note, report.note);
  assert.equal(archive.events.find(e => e.type === "roster").report.note, report.note);
};

test("dry run makes zero fetch calls, needs no keys and preserves input order", async t => {
  const calls = stubFetch(t, () => { throw new Error("No provider calls allowed"); });
  const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN", "OPENAI_COMPATIBLE_BASE_URL"];
  for (const key of keys) { const before = process.env[key]; delete process.env[key]; t.after(() => { if (before !== undefined) process.env[key] = before; }); }
  const report = await runCastingCall({ brief: "A policy", agentsDir: dir, dryRun: true, seats: 2 }, { onEvent() { throw new Error("Broken observer"); } }, noSignal());
  assert.equal(calls.length, 0);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.agents.map(a => a.key), agents);
  assert.deepEqual(report.recommended.seats, agents.slice(0, 2));
  assert.deepEqual(report.gaps, []);
  assert.equal(report.usage.totalCostUsd, 0);
  assert.match(report.note, /^Static checks only, no auditions/);
  assert.match(renderRoster(report), /Gaps: not assessed/);
  assert.equal(report.usage.unpricedTokens, undefined);
  assert.match(renderCastingMarkdown(report), /Gaps: not assessed/);
});

test("dry-run redundancy keeps only the first cluster member eligible", async t => {
  stubFetch(t, () => { throw new Error("No fetch"); });
  const fixture = await mkdtemp(join(tmpdir(), "casting-cluster-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(fixture, { recursive: true, force: true }); });
  for (const key of ["a", "b", "c"]) await writeFile(join(fixture, `${key}.md`), "---\ndescription: shared specialty\n---\n" + "same expertise ".repeat(40));
  const report = await runCastingCall({ brief: "Brief", agentsDir: fixture, dryRun: true }, { onEvent() {} }, noSignal());
  assert.deepEqual(report.agents.map(a => a.verdict), ["cast", "redundant", "redundant"]);
  assert.deepEqual(report.recommended.seats, ["a"]);
});

test("happy path auditions, examines, meters and archives private report plus transcript", async t => {
  const { report, events, calls, peak } = await run(t);
  assert.match(report.id, /^cast-[0-9a-f-]{36}$/);
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1).type, "end");
  assert.equal(events.at(-2).type, "roster");
  assert.equal(calls.length, 10);
  assert.ok(peak() <= PARALLEL_TURNS);
  assert.ok(calls.every(c => c.signal instanceof AbortSignal));
  assert.equal(events.filter(e => e.type === "turn" && e.round === "audition").length, 4);
  assert.equal(events.filter(e => e.type === "turn" && e.round === "answer").length, 4);
  assert.equal(events[0].seats.at(-1).name, "casting director");
  assert.ok(events[0].seats.every(s => s.reason && !s.prompt));
  assert.deepEqual(report.recommended, verdict().recommended);
  assert.deepEqual(report.gaps, ["Operations"]);
  assert.ok(report.usage.totalCostUsd > 0);
  assert.equal(report.usage.unpricedTokens, undefined);
  assert.equal(report.note, undefined);
  const archive = await archiveFor(report);
  assert.deepEqual(archive.events, events);
  assert.deepEqual(archive.agents, report.agents);
  const latest = JSON.parse(await readFile(join(ROUNDTABLE_HOME, "casting", "latest.json"), "utf8"));
  assert.deepEqual(latest, archive);
  for (const path of [`${report.id}.json`, "latest.json"]) assert.equal((await stat(join(ROUNDTABLE_HOME, "casting", path))).mode & 0o777, 0o600);
  assert.equal((await stat(join(ROUNDTABLE_HOME, "casting"))).mode & 0o777, 0o700);
  const ledger = readTableLines([new Date().toISOString().slice(0, 10)], ROUNDTABLE_HOME).filter(line => line.session === report.id);
  assert.equal(ledger.length, 10);
  assert.ok(ledger.every(line => line.kind === "casting"));
});

test("malformed director verdict retries with validation feedback then falls back", async t => {
  const { report, calls, verdictCalls } = await run(t, { badVerdict: true });
  assert.equal(verdictCalls(), 2);
  const prompts = calls.filter(c => c.body.messages.at(-1).content.includes("Return a roster report"));
  assert.match(prompts[1].body.messages.at(-1).content, /Previous response failed validation/);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.dryRun, undefined);
  assert.deepEqual(report.recommended.seats, agents);
  assert.equal((await archiveFor(report)).id, report.id);
  await assertNote(report, /Director verdict unavailable; static roster from lint and similarity only; gaps not assessed\./);
});

test("malformed questions retry once and fall back without answers or another director call", async t => {
  const { report, calls, questionCalls, verdictCalls } = await run(t, { badQuestions: true });
  assert.equal(questionCalls(), 2); assert.equal(verdictCalls(), 0);
  assert.equal(calls.length, 6);
  assert.deepEqual(report.gaps, []);
  await assertNote(report, /Director questions unavailable; static roster from lint and similarity only; gaps not assessed\./);
});

test("unknown director keys are dropped everywhere in the final report", async t => {
  const output = verdict();
  output.agents.push({ key: "intruder", verdict: "cast", strengths: [], risks: [], overlapsWith: [] });
  output.agents[0].overlapsWith = ["engineer", "intruder"];
  output.redundancy = [{ keys: ["architect", "engineer", "intruder"], reason: "Shared" }];
  output.recommended.seats.push("intruder");
  output.recommended.judges.push("intruder");
  const { report } = await run(t, { verdict: output });
  assert.doesNotMatch(JSON.stringify(report), /intruder/);
});

test("failed persona becomes unclear and is removed from recommendations; error is scrubbed", async t => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "secret-canary-value";
  t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  const { report, events } = await run(t, { fail: "engineer" });
  const failed = report.agents.find(a => a.key === "engineer");
  assert.equal(failed.verdict, "unclear");
  assert.match(failed.risks.join(" "), /Persona failed/);
  assert.ok(!report.recommended.seats.includes("engineer"));
  assert.ok(!report.recommended.teamA.includes("engineer"));
  assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(await archiveFor(report)), /secret-canary-value/);
  assert.equal(events.at(-1).aborted, false);
});

test("abort mid-run cuts in-flight calls, stops scheduling and still archives", async t => {
  const controller = new AbortController();
  const { report, events, calls } = await run(t, { audition: async (_persona, init) => {
    controller.abort(new Error("Stopped by test"));
    await new Promise((resolve, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); });
  } }, {}, controller.signal);
  assert.ok(calls.length <= PARALLEL_TURNS);
  assert.equal(events.at(-1).aborted, true);
  assert.ok(report.agents.every(a => a.verdict === "unclear"));
  assert.equal((await archiveFor(report)).id, report.id);
  await assertNote(report, /Stopped before completion; roster is partial\./);
});

test("a running cast is a live session that stop reaches, and leaves the live list when done", async t => {
  const { liveSessions, stopSession } = await import("../../dist/usage/table-service.js");
  let id, reached;
  const gotCall = new Promise(resolve => { reached = resolve; });
  const running = run(t, { audition: async (_persona, init) => {
    reached();
    await new Promise((resolve, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); });
  } }, {}, noSignal(), event => { if (event.type === "start") id = event.id; });
  await gotCall;
  const live = liveSessions().find(s => s.id === id);
  assert.equal(live.kind, "casting");
  assert.ok(agents.every(key => live.agents.includes(key)));
  assert.equal((await stopSession({ session: id, by: "test", surface: "cli" })).status, "stopped");
  const { report, events } = await running;
  assert.equal(events.at(-1).aborted, true);
  await assertNote(report, /Stopped before completion; roster is partial\./);
  assert.equal(liveSessions().some(s => s.id === id), false);
});

test("deadline settles a provider that ignores abort and archives available results", async t => {
  const { report, events, calls } = await run(t, { audition: () => new Promise(() => {}) }, { maxSeconds: 0.03 });
  assert.ok(calls.length <= PARALLEL_TURNS);
  assert.equal(events.at(-1).aborted, true);
  assert.equal((await archiveFor(report)).id, report.id);
  await assertNote(report, /Stopped before completion; roster is partial\./);
});

test("no-examine skips questions and answers", async t => {
  const { calls, questionCalls, report } = await run(t, {}, { examine: false });
  assert.equal(questionCalls(), 0); assert.equal(calls.length, 5);
  assert.deepEqual(report.gaps, ["Operations"]);
});

test("MCP casting_call is registered, validates options and sends progress for every event", async t => {
  const definition = tools.find(tool => tool.name === "casting_call");
  assert.ok(definition); assert.deepEqual(definition.inputSchema.required, ["brief"]);
  const fetch = setup(t), progress = [];
  const result = await handleToolCall("casting_call", { brief: options.brief, agents, agents_dir: dir, seats: 4, provider: options.provider, model: options.model }, "orchestrator", { progress: (...args) => progress.push(args) });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /roundtable duel/);
  assert.equal(fetch.calls.length, 10);
  assert.ok(progress.some(p => /audition/.test(p[2])));
  assert.ok(progress.some(p => /questions/.test(p[2])));
  assert.ok(progress.some(p => /answer/.test(p[2])));
  assert.ok(progress.some(p => /roster/.test(p[2])));
  const archive = await archiveFor(result.structuredContent.report);
  assert.equal(progress.length, archive.events.length);
  assert.equal(result.structuredContent.archive_id, archive.id);
  for (const args of [{ brief: "x", agents: ["one"] }, { brief: "x", seats: 1.5 }, { brief: "x", provider: "unknown" }]) assert.equal((await handleToolCall("casting_call", args)).isError, true);
});

test("static fallback backfills requested seats after a failed audition", async t => {
  const { report } = await run(t, { fail: "architect", badVerdict: true }, { seats: 2 });
  assert.equal(report.agents[0].verdict, "unclear");
  assert.deepEqual(report.recommended.seats, ["engineer", "researcher"]);
  assert.deepEqual(report.gaps, []);
});

test("dry-run validates seat assignments without calling providers", async t => {
  const calls = stubFetch(t, () => { throw new Error("No fetch"); });
  for (const seat of ["outsider=openai", "architect=unknown", "architect", "architect=openai,architect=openai", { architect: { provider: "unknown" } }]) {
    await assert.rejects(runCastingCall({ ...options, dryRun: true, seat }, { onEvent() {} }, noSignal()), error => error.exitCode === 2);
  }
  assert.equal(calls.length, 0);
});

test("pre-aborted runs and a zero deadline need no credentials and still archive", async t => {
  const calls = stubFetch(t, () => { throw new Error("No fetch"); });
  for (const overrides of [{ signal: AbortSignal.abort() }, { maxSeconds: 0 }]) {
    const events = [];
    const report = await runCastingCall({ brief: "Brief", agentsDir: dir, ...(overrides.maxSeconds === 0 && { maxSeconds: 0 }) }, { onEvent: e => events.push(e) }, overrides.signal ?? noSignal());
    assert.equal(events.at(-1).aborted, true);
    assert.deepEqual(report.recommended.seats, []);
    assert.equal((await archiveFor(report)).id, report.id);
    await assertNote(report, /Stopped before completion; roster is partial\./);
  }
  assert.equal(calls.length, 0);
});

test("MCP dry-run treats null optional arguments as absent and validates overrides", async t => {
  const calls = stubFetch(t, () => { throw new Error("No fetch"); });
  const result = await handleToolCall("casting_call", { brief: "Brief", agents_dir: dir, dry_run: true, agents: null, seats: null, provider: null, examine: null });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.report.dryRun, true);
  assert.ok(result.structuredContent.routing.every(s => s.reason));
  assert.equal((await handleToolCall("casting_call", { brief: "Brief", agents_dir: dir, dry_run: true, seat: { architect: { provider: "bad" } } })).isError, true);
  assert.equal(calls.length, 0);
});

test("persona and director overrides keep routing reasons and route their own calls", async t => {
  const { calls, events } = await run(t, {}, { seat: { architect: { model: "persona-model" }, "casting-director": { provider: "openai_compatible", model: "director-model" } } });
  const start = events[0];
  assert.equal(start.seats.find(s => s.id === "architect").model, "persona-model");
  assert.match(start.seats.at(-1).reason, /explicit/);
  for (const call of calls) {
    const system = call.body.messages[0].content;
    if (system.startsWith("You are the casting director")) assert.equal(call.body.model, "director-model");
    else if (system.startsWith("You are the architect")) assert.equal(call.body.model, "persona-model");
  }
});

test("CLI missing credentials return exit 2 without a fetch", async t => {
  const { runCastCli } = await import("../../dist/cli-cast.js");
  const calls = stubFetch(t, () => { throw new Error("No fetch"); });
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });
  let error = "";
  const code = await runCastCli(["Brief", "--agents-dir", dir, "--seat", [...agents, "casting-director"].map(a => `${a}=openai`).join(",")], { output: { write() {} }, error: { write: s => { error += s; } } });
  assert.equal(code, 2);
  assert.match(error, /Missing OPENAI_API_KEY/);
  assert.equal(calls.length, 0);
});

test("valid director JSON on retry completes the full report", async t => {
  const { report, questionCalls, verdictCalls } = await run(t, { retryQuestions: true, retryVerdict: true });
  assert.equal(questionCalls(), 2); assert.equal(verdictCalls(), 2);
  assert.deepEqual(report.gaps, ["Operations"]);
  assert.deepEqual(report.recommended, verdict().recommended);
  assert.equal(report.note, undefined);
});

test("unpriced usage sums persona and director tokens and marks the total estimated", async t => {
  const { report, events } = await run(t, {}, { model: "unpriced-casting-model" });
  assert.deepEqual(report.usage, { totalCostUsd: 0, unpricedTokens: 1300, estimated: true });
  const usage = events.filter(e => e.type === "usage").at(-1);
  assert.equal(report.usage.unpricedTokens, usage.perSeat.reduce((n, seat) => n + seat.unpricedTokens, 0));
  assert.equal(usage.perSeat.find(s => s.seatId === "casting-director").unpricedTokens, 260);
  assert.deepEqual((await archiveFor(report)).usage, report.usage);
  for (const render of [renderRoster, renderCastingMarkdown]) assert.match(render(report), /Usage: \$0\.0000 \(\+1300 tokens unpriced\) \(estimated\)/);
});

test("mixed priced and unpriced usage retains both known spend and unknown tokens", async t => {
  const { report } = await run(t, {}, { seat: { architect: { model: "unpriced-casting-model" } } });
  assert.ok(report.usage.totalCostUsd > 0);
  assert.equal(report.usage.unpricedTokens, 260);
  assert.equal(report.usage.estimated, true);
});

test("MCP returns unpriced usage in markdown and both structured usage fields", async t => {
  setup(t);
  const result = await handleToolCall("casting_call", { brief: options.brief, agents, agents_dir: dir, seats: 4, provider: options.provider, model: "unpriced-casting-model" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Usage: \$0\.0000 \(\+1300 tokens unpriced\)/);
  assert.deepEqual(result.structuredContent.usage, { totalCostUsd: 0, unpricedTokens: 1300, estimated: true });
  assert.deepEqual(result.structuredContent.report.usage, result.structuredContent.usage);
});

test("MCP exposes director fallback prominently and leaves gaps unassessed", async t => {
  setup(t, { badQuestions: true });
  const result = await handleToolCall("casting_call", { brief: options.brief, agents, agents_dir: dir, seats: 4, provider: options.provider, model: options.model });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^## Casting Call\n\n\*\*Note: Director questions unavailable;/);
  assert.match(result.content[0].text, /Gaps: not assessed/);
  assert.match(result.structuredContent.report.note, /Director questions unavailable/);
});

test("auditions and answers are capped before display and reuse", async t => {
  const { events } = await run(t, { long: true });
  for (const round of ["audition", "answer"]) {
    const turns = events.filter(e => e.type === "turn" && e.round === round);
    assert.equal(turns.length, 4);
    assert.ok(turns.every(e => e.text.split(/\s+/).length <= (round === "audition" ? 120 : 80)));
  }
});

test("CLI Ctrl-C still streams and archives a final report and returns exit 1", async t => {
  const { runCastCli } = await import("../../dist/cli-cast.js");
  let interrupted = false;
  setup(t, { audition: () => { if (!interrupted) { interrupted = true; process.emit("SIGINT"); } } });
  let output = "";
  const assignments = [...agents, "casting-director"].map(a => `${a}=openai_compatible:claude-sonnet-5-5`).join(",");
  const code = await runCastCli(["Brief", "--agents-dir", dir, "--seat", assignments, "--json"], { output: { write: s => { output += s; } }, error: { write() {} } });
  assert.equal(code, 1);
  const lines = output.trim().split("\n").map(JSON.parse);
  assert.equal(lines.at(-2).type, "end");
  assert.equal(lines.at(-2).aborted, true);
  assert.equal((await archiveFor(lines.at(-1))).id, lines.at(-1).id);
});
