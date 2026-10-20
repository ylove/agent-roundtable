// Usage provenance in the budget ledger (usage-visibility.md §3, §4): the event shape, the reducer's
// per-agent and per-model sums, post_update(kind: "usage") for external workers, the table ledger written
// by the usage sink, live-file staleness and the grouping and splits of collectUsage.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRun, registerWorker, runner, task } from "../fixtures/workers/run.mjs";
import { emit, frozenRun } from "../fixtures/execution/run.mjs";

const { validateDraft } = await import("../../dist/execution/events.js");
const { usageProvenance } = await import("../../dist/execution/types.js");
const { REDUCER_VERSION } = await import("../../dist/execution/blackboard.js");
const { handleToolCall } = await import("../../dist/tools.js");
const W = await import("../../dist/tools/worker.js");
const { withUsageSink, reportUsage } = await import("../../dist/providers/usage.js");
const { metered, lineFor, setLedgerHome, setServerId, busySessions, abortSession } = await import("../../dist/usage/session-scope.js");
const T = await import("../../dist/usage/table.js");
const { collectUsage } = await import("../../dist/usage/model.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { UsageMeter } = await import("../../dist/execution/escalation.js");

afterEach(() => W.resetWorkerTools());

const src = { kind: "runner", id: "runner", pid: 1 };
const usage = (over = {}) => ({
  source: "worker", agent: "builder", task: "a", provider: "provider-a", model: "model-a",
  tokens: { inputTokens: 1000, outputTokens: 200 }, usd: 0.5, estimated: false, ...over,
});

test("REDUCER_VERSION combines usage and dissent projections at version 10", () => {
  assert.equal(REDUCER_VERSION, 10);
});

test("budget.usage_recorded: provenance is optional, validated, and old events read as 1.0 meant", () => {
  const ok = validateDraft({ type: "budget.usage_recorded", source: src, payload: usage({ provenance: { tokens: "measured", usd: "estimated" } }) });
  assert.deepEqual(ok.payload.provenance, { tokens: "measured", usd: "estimated" });
  assert.throws(
    () => validateDraft({ type: "budget.usage_recorded", source: src, payload: usage({ provenance: { tokens: "guessed", usd: "measured" } }) }),
    /provenance\.tokens/
  );
  assert.throws(() => validateDraft({ type: "budget.usage_recorded", source: src, payload: usage({ provenance: { tokens: "measured" } }) }), /provenance\.usd/);
  assert.deepEqual(usageProvenance({ estimated: false }), { tokens: "measured", usd: "measured" });
  assert.deepEqual(usageProvenance({ estimated: true }), { tokens: "measured", usd: "estimated" });
  assert.deepEqual(usageProvenance({ estimated: true, provenance: { tokens: "reported", usd: "reported" } }), { tokens: "reported", usd: "reported" });
});

test("agent.stop_requested and agent.stopped validate; exits may be 'stopped'", () => {
  const req = validateDraft({ type: "agent.stop_requested", source: src, payload: { agent: "builder", by: "yitz", surface: "dashboard", reason: "token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" } });
  assert.doesNotMatch(req.payload.reason, /ghp_/, "free text is scrubbed");
  assert.throws(() => validateDraft({ type: "agent.stop_requested", source: src, payload: { agent: "builder", by: "x", surface: "email" } }), /surface/);
  assert.throws(() => validateDraft({ type: "agent.stop_requested", source: src, payload: { agent: "builder", by: "x", surface: "cli", extra: 1 } }), /not a known field/);
  validateDraft({ type: "agent.stopped", source: src, payload: { agent: "builder", task: "a", request: "evt-1", escalation: "esc-1" } });
  validateDraft({ type: "agent.exited", source: src, payload: { agent: "builder", code: null, reason: "stopped" } });
});

test("the reducer sums usage per agent and model by provenance, keeps the 1.0 totals, and files agentless spend under its source", async () => {
  const { store } = await frozenRun();
  await emit(store, "agent.registered", { agent: "builder", persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "budget.usage_recorded", usage({ provenance: { tokens: "measured", usd: "measured" }, usd: 0.5 }));
  await emit(store, "budget.usage_recorded", usage({ usd: 0.25, estimated: true, provenance: { tokens: "measured", usd: "estimated" }, tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } }));
  await emit(store, "budget.usage_recorded", usage({ model: "model-b", usd: 0.1, provenance: { tokens: "reported", usd: "reported" } }));
  // A 1.0 event: no provenance.
  await emit(store, "budget.usage_recorded", usage({ usd: 0.2 }));
  await emit(store, "budget.usage_recorded", { source: "huddle", model: "model-a", provider: "provider-a", tokens: { inputTokens: 1, outputTokens: 1 }, usd: 0.01, estimated: true });
  const s = await store.state();
  const u = s.budget.by_agent_usage.builder;
  assert.equal(u.provider, "provider-a");
  assert.deepEqual(Object.keys(u.models).sort(), ["model-a", "model-b"]);
  const a = u.models["model-a"];
  assert.deepEqual(a.tokens, { input: 1000 + 10 + 1000, output: 200 + 5 + 200, cache_read: 100, cache_write: 0 });
  assert.deepEqual(a.usd, { measured: 0.7, reported: 0, estimated: 0.25 });
  assert.deepEqual(a.tokens_prov, { measured: 1200 + 115 + 1200, reported: 0, estimated: 0 });
  assert.deepEqual(u.models["model-b"].usd, { measured: 0, reported: 0.1, estimated: 0 });
  assert.equal(u.models["model-b"].tokens_prov.reported, 1200);
  assert.deepEqual(Object.keys(s.budget.by_agent_usage).sort(), ["[huddle]", "builder"]);
  // The totals keep their meaning, so budgets and the watchdog are unchanged.
  assert.ok(Math.abs(s.budget.spent_usd - 1.06) < 1e-9);
  assert.ok(Math.abs(s.budget.by_agent.builder - 1.05) < 1e-9);
  assert.equal(s.budget.by_agent["[huddle]"], undefined);
  assert.equal(s.budget.estimated, true);
  // Replaying the log gives the same state (the reducer is deterministic).
  const again = await (await import("../../dist/execution/store.js")).openExecutionStore(store.id);
  assert.deepEqual((await again.state()).budget, s.budget);
});

test("post_update(kind: usage): an external worker's report is recorded as reported and counts toward the budget; runner-managed workers are refused", async () => {
  const run = await makeRun({ contract: { tasks: [task("api"), task("web")] } });
  const runnerToken = await registerWorker(run.store, "runner-w", "web");
  const j = (await handleToolCall("join_execution", { execution_id: run.store.id, agent: "ext-1", task_id: "api" })).content[0].text;
  const ext = { execution_id: run.store.id, agent_token: JSON.parse(j).agent_token };
  const call = async (args) => {
    const r = await handleToolCall("post_update", { ...ext, ...args });
    return { error: r.isError === true, text: r.content[0].text };
  };
  assert.equal((await handleToolCall("claim_task", { ...ext, task_id: "api" })).isError, undefined);

  assert.match((await call({ kind: "usage" })).text, /needs "tokens" or "usd"/);
  assert.match((await call({ kind: "note" })).text, /needs "text"/);
  const r = await call({ kind: "usage", tokens: { input: 1200, output: 300 }, usd: 0.4, model: "model-x" });
  assert.equal(r.error, false, r.text);
  const body = JSON.parse(r.text);
  assert.deepEqual(body.provenance, { tokens: "reported", usd: "reported" });
  const s1 = await run.store.state();
  assert.equal(s1.budget.spent_usd, 0.4, "it counts toward the budget");
  assert.deepEqual(s1.budget.by_agent_usage["ext-1"].models["model-x"].usd, { measured: 0, reported: 0.4, estimated: 0 });
  assert.equal(s1.budget.by_agent_usage["ext-1"].provider, "external");

  // Without a cost the table prices it (estimated); an absurd report is clamped and labelled.
  const priced = JSON.parse((await call({ kind: "usage", tokens: { input: 1_000_000, output: 0 }, model: "claude-sonnet-5-5" })).text);
  assert.deepEqual(priced.provenance, { tokens: "reported", usd: "estimated" });
  assert.equal(priced.usd, 2);
  const huge = JSON.parse((await call({ kind: "usage", tokens: { input: 5e12 }, usd: 1e9 })).text);
  assert.equal(huge.clamped, true);
  assert.equal(huge.usd, W.USAGE_REPORT_MAX_USD);
  assert.equal(huge.tokens.input, W.USAGE_REPORT_MAX_TOKENS);
  assert.match((await call({ kind: "usage", usd: -1 })).text, /"usd" must be at least 0/);

  const events = (await run.store.events()).filter((e) => e.type === "budget.usage_recorded");
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.source.id === "ext-1" && e.payload.estimated === false));

  // The runner measures the usage of the workers it starts: they may not report their own.
  const mine = await run.store.state();
  assert.equal(mine.agents["runner-w"].external, false);
  W.bindWorkerIdentity({ store: await openExecutionStore(run.store.id), execution: run.store.id, agent: "runner-w", tokenSha256: runnerToken.sha256 });
  const refused = await handleToolCall("post_update", { kind: "usage", usd: 1 }, "worker");
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Only external workers report their own usage/);
  assert.equal((await run.store.state()).budget.spent_usd, s1.budget.spent_usd + 2 + W.USAGE_REPORT_MAX_USD, "nothing was recorded");
});

// --- the table ledger ---------------------------------------------------------------------------

function home() {
  const dir = mkdtempSync(join(tmpdir(), "usage-home-"));
  setLedgerHome(dir);
  setServerId("srv-0123456789abcdefghjkmnpqrstvwxyz".slice(0, 12));
  return dir;
}

test("the usage sink writes one 0600 line per provider call, with provenance, and no text", async () => {
  const dir = home();
  await metered({ session: "meeting-4k9q2mzt", kind: "meeting", agent: "cfo" }, async () => {
    assert.ok(busySessions().has("meeting-4k9q2mzt"));
    reportUsage({ provider: "provider-a", model: "claude-sonnet-5-5", usage: { inputTokens: 1000, outputTokens: 500 }, chars: { input: 4000, output: 2000 } });
    // A provider that reported no usage: tokens are estimated from the lengths (4 characters a token).
    reportUsage({ provider: "provider-a", model: "claude-sonnet-5-5", chars: { input: 400, output: 80 } });
    // An unpriced model: tokens, and no cost.
    reportUsage({ provider: "provider-b", model: "mystery-model", usage: { inputTokens: 5, outputTokens: 5 } });
  });
  assert.ok(!busySessions().has("meeting-4k9q2mzt"));
  const file = join(dir, "usage", `table-${T.day()}.jsonl`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "usage")).mode & 0o777, 0o700);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].tokens, { input: 1000, output: 500, cache_read: 0, cache_write: 0 });
  assert.equal(lines[0].tokens_prov, "measured");
  assert.equal(lines[0].usd_prov, "estimated");
  assert.ok(Math.abs(lines[0].usd - (1000 * 2 + 500 * 10) / 1e6) < 1e-12);
  assert.deepEqual(lines[1].tokens, { input: 100, output: 20, cache_read: 0, cache_write: 0 });
  assert.equal(lines[1].tokens_prov, "estimated");
  assert.equal(lines[2].usd, undefined, "no price, no cost");
  assert.deepEqual(Object.keys(lines[0]).sort(), ["agent", "at", "kind", "model", "provider", "server", "session", "tokens", "tokens_prov", "usd", "usd_prov"]);
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /content|prompt|message/i);
  assert.equal(T.readTableLines([T.day()], dir).length, 3);
});

test("appendTableLine writes the known fields only: no free text can ride along", () => {
  const dir = home();
  T.appendTableLine({ at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: "cfo", provider: "p", model: "m",
    tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, tokens_prov: "measured", content: "the secret prompt", prompt: "do it" }, dir);
  const raw = readFileSync(join(dir, "usage", `table-${T.day()}.jsonl`), "utf8");
  assert.doesNotMatch(raw, /secret prompt|do it|content|prompt/);
  assert.equal(JSON.parse(raw).agent, "cfo");
});

test("an outer usage sink (a heads-down huddle) keeps the spend: the table ledger does not count it twice", async () => {
  const dir = home();
  const seen = [];
  await withUsageSink((r) => seen.push(r), () => metered({ session: "collab-4k9q2mzt", kind: "collaboration", agent: "cfo" }, async () => {
    reportUsage({ provider: "provider-a", model: "m", usage: { inputTokens: 1, outputTokens: 1 } });
  }));
  assert.equal(seen.length, 1);
  assert.equal(existsSync(join(dir, "usage", `table-${T.day()}.jsonl`)), false);
});

test("lineFor never records a $0.00 for an unknown model, and a free provider costs nothing", () => {
  const free = lineFor({ session: "meeting-aaaaaaaa", kind: "meeting", agent: "x" }, { provider: "ollama", model: "qwen3:14b", usage: { inputTokens: 10, outputTokens: 10 } }, "srv-aaaaaaaa");
  assert.equal(free.usd, 0);
  const unknown = lineFor({ session: "meeting-aaaaaaaa", kind: "meeting", agent: "x" }, { provider: "provider-b", model: "nope", usage: { inputTokens: 10, outputTokens: 10 } }, "srv-aaaaaaaa");
  assert.equal(unknown.usd, undefined);
});

test("table ledger lines are validated on the way back in and pruned by age", () => {
  const dir = home();
  mkdirSync(join(dir, "usage"), { recursive: true });
  const today = T.day();
  const good = { at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: "cfo", provider: "p", model: "m", tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, tokens_prov: "measured" };
  writeFileSync(join(dir, "usage", `table-${today}.jsonl`), [
    JSON.stringify(good), "not json", JSON.stringify({ ...good, session: "../escape" }), JSON.stringify({ ...good, tokens: { input: -5, output: "x" } }), JSON.stringify({ ...good, usd: -1 }),
  ].join("\n") + "\n");
  const lines = T.readTableLines([today], dir);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1].tokens, { input: 0, output: 0, cache_read: 0, cache_write: 0 }, "negative and non-numbers read as zero");
  assert.equal(lines[2].usd, undefined);
  writeFileSync(join(dir, "usage", "table-2020-01-01.jsonl"), "{}\n");
  assert.deepEqual(T.pruneTableLedgers(30, Date.now(), dir), ["table-2020-01-01.jsonl"]);
  assert.deepEqual(readdirSync(join(dir, "usage")), [`table-${today}.jsonl`]);
});

test("a live file whose pid is dead on this host, or whose heartbeat is older than 30 s, is gone", () => {
  const dir = home();
  const sessions = [{ id: "meeting-aaaaaaaa", kind: "meeting", agents: ["cfo"], started: new Date().toISOString() }];
  T.writeLiveFile("srv-aaaaaaaa", { pid: process.pid, started: new Date().toISOString(), sessions }, dir);
  assert.equal(statSync(join(dir, "usage", "live", "srv-aaaaaaaa.json")).mode & 0o777, 0o600);
  assert.deepEqual(T.readLiveServers(Date.now(), dir).map((s) => s.server), ["srv-aaaaaaaa"]);
  assert.deepEqual(T.readLiveServers(Date.now() + 31_000, dir), [], "stale heartbeat");
  T.writeLiveFile("srv-bbbbbbbb", { pid: 2 ** 22 + 12345, started: new Date().toISOString(), sessions: [] }, dir);
  assert.deepEqual(T.readLiveServers(Date.now(), dir).map((s) => s.server), ["srv-aaaaaaaa"], "dead pid");
  T.removeLiveFile("srv-aaaaaaaa", dir);
  assert.deepEqual(T.readLiveServers(Date.now(), dir), []);
});

test("stop requests are files: validated, and a malformed one is renamed .bad", () => {
  const dir = home();
  const req = T.writeStopRequest("srv-aaaaaaaa", { session: "meeting-aaaaaaaa", agent: "cfo", by: "yitz", surface: "cli", reason: "too slow" }, dir);
  const file = join(dir, "usage", "stops", "srv-aaaaaaaa", `${req.id}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(join(dir, "usage", "stops", "srv-aaaaaaaa", "stop-0123456789ab.json"), "{ nope");
  const got = T.readStopRequests("srv-aaaaaaaa", dir);
  assert.deepEqual(got.map((r) => r.id), [req.id]);
  assert.equal(existsSync(join(dir, "usage", "stops", "srv-aaaaaaaa", "stop-0123456789ab.json.bad")), true);
  assert.throws(() => T.writeStopRequest("srv-aaaaaaaa", { session: "../x", agent: "a", by: "b", surface: "cli" }, dir), /session id/);
  // The agent name is informational: a persona such as "josé+ops" must not get a request dropped as .bad.
  const odd = T.writeStopRequest("srv-aaaaaaaa", { session: "meeting-aaaaaaaa", agent: "josé+ops", by: "yitz", surface: "cli" }, dir);
  assert.deepEqual(T.readStopRequests("srv-aaaaaaaa", dir).filter((r) => r.id === odd.id).map((r) => r.agent), ["josé+ops"]);
  assert.equal(existsSync(join(dir, "usage", "stops", "srv-aaaaaaaa", `${odd.id}.json.bad`)), false);
  T.removeStopRequest("srv-aaaaaaaa", odd.id, dir);
  assert.throws(() => T.writeStopRequest("../x", { session: "meeting-aaaaaaaa", agent: "a", by: "b", surface: "cli" }, dir), /server id/);
  T.removeStopRequest("srv-aaaaaaaa", req.id, dir);
  assert.deepEqual(T.readStopRequests("srv-aaaaaaaa", dir), []);
});

// --- collectUsage -------------------------------------------------------------------------------

test("collectUsage groups heads-down agents and at-the-table sessions by platform, with provenance splits", async () => {
  const dir = home();
  const { store } = await frozenRun();
  await emit(store, "agent.registered", { agent: "builder", persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "agent.spawned", { agent: "builder", task: "a", attempt: 1, pid: process.pid });
  await emit(store, "budget.usage_recorded", usage({ provider: "claude-code", model: "model-a", usd: 1.62, provenance: { tokens: "measured", usd: "measured" } }));
  await emit(store, "budget.usage_recorded", usage({ agent: "fixer", provider: "claude-code", model: "model-a", usd: 0.4, estimated: false, provenance: { tokens: "reported", usd: "reported" } }));
  await emit(store, "budget.usage_recorded", { source: "huddle", provider: "provider-a", model: "m", tokens: { inputTokens: 5, outputTokens: 5 }, usd: 0.22, estimated: true, provenance: { tokens: "measured", usd: "estimated" } });
  T.appendTableLine({ at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: "cfo", provider: "provider-a", model: "m1", tokens: { input: 4000, output: 100, cache_read: 0, cache_write: 0 }, tokens_prov: "measured", usd: 0.03, usd_prov: "estimated" }, dir);
  T.appendTableLine({ at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: "cfo", provider: "provider-a", model: "m1", tokens: { input: 40, output: 10, cache_read: 0, cache_write: 0 }, tokens_prov: "estimated" }, dir);
  T.writeLiveFile("srv-aaaaaaaa", { pid: process.pid, started: new Date().toISOString(), sessions: [{ id: "meeting-aaaaaaaa", kind: "meeting", agents: ["cfo"], started: new Date().toISOString(), busy: true }] }, dir);

  const v = await collectUsage({ executions: [store.id], home: dir });
  const builder = v.agents.find((a) => a.id === "builder");
  assert.equal(builder.where, "heads-down");
  assert.equal(builder.scope, store.id);
  assert.equal(builder.provider, "claude-code");
  assert.deepEqual(builder.money, { measured: 1.62, reported: 0, estimated: 0 });
  assert.equal(builder.state, "working");
  assert.equal(builder.stoppable, true);
  const fixer = v.agents.find((a) => a.id === "fixer");
  assert.deepEqual(fixer.money, { measured: 0, reported: 0.4, estimated: 0 });
  assert.equal(fixer.state, "done");
  assert.equal(fixer.stoppable, false);
  const huddles = v.agents.find((a) => a.id === "[huddle]");
  assert.equal(huddles.label, "Huddles");
  assert.equal(huddles.stoppable, false);
  const cfo = v.agents.find((a) => a.id === "cfo");
  assert.equal(cfo.where, "at-the-table");
  assert.equal(cfo.scope, "meeting-aaaaaaaa");
  assert.equal(cfo.state, "working");
  assert.equal(cfo.stoppable, true);
  assert.deepEqual(cfo.tokens.by, { measured: 4100, reported: 0, estimated: 50 });
  assert.deepEqual(cfo.money, { measured: 0, reported: 0, estimated: 0.03 });
  // Totals keep the split: never one blended number.
  assert.deepEqual({ measured: v.totals.measured, reported: v.totals.reported, estimated: v.totals.estimated }, { measured: 1.62, reported: 0.4, estimated: 0.25 });
  assert.deepEqual(v.platforms.map((p) => p.provider).sort(), ["claude-code", "provider-a"]);
  assert.deepEqual(v.platforms.find((p) => p.provider === "provider-a").models.sort(), ["m", "m1"]);
  assert.equal(v.runs[0].id, store.id);
  assert.equal(v.runs[0].live, true);
  assert.equal(v.table.sessions, 1);
  assert.deepEqual(v.table.money, { measured: 0, reported: 0, estimated: 0.03 });

  // Once the server is gone the session reads as done and can no longer be stopped.
  T.removeLiveFile("srv-aaaaaaaa", dir);
  const after = await collectUsage({ executions: [store.id], home: dir });
  const done = after.agents.find((a) => a.id === "cfo");
  assert.equal(done.state, "done");
  assert.equal(done.stoppable, false);

  // The host agent is reported, labelled, and never part of the totals.
  const withHost = await collectUsage({ executions: [], home: dir, host: { model: "Opus 5.5", cost_usd: 3.5 } });
  const host = withHost.agents.find((a) => a.where === "host");
  assert.deepEqual(host.money, { measured: 0, reported: 3.5, estimated: 0 });
  assert.equal(withHost.totals.reported, 0);
});

test("a model with no price shows tokens, flagged unpriced, instead of $0.00", async () => {
  const dir = home();
  T.appendTableLine({ at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-aaaaaaaa", kind: "meeting", agent: "cfo", provider: "provider-b", model: "mystery", tokens: { input: 40, output: 10, cache_read: 0, cache_write: 0 }, tokens_prov: "measured" }, dir);
  T.appendTableLine({ at: new Date().toISOString(), server: "srv-aaaaaaaa", session: "meeting-bbbbbbbb", kind: "meeting", agent: "local", provider: "ollama", model: "qwen3:14b", tokens: { input: 40, output: 10, cache_read: 0, cache_write: 0 }, tokens_prov: "measured", usd: 0, usd_prov: "estimated" }, dir);
  const v = await collectUsage({ executions: [], home: dir });
  assert.equal(v.agents.find((a) => a.id === "cfo").money.unpriced, true);
  assert.equal(v.agents.find((a) => a.id === "local").money.unpriced, undefined, "a free provider costs $0.00");
});

test("huddle and consent usage: tokens the provider counted are measured, the dollars are ours (estimated)", () => {
  const meter = new UsageMeter("huddle", "a");
  // Drive the meter's own sink the way a provider call does.
  return meter.run(async () => {
    reportUsage({ provider: "provider-a", model: "claude-sonnet-5-5", usage: { inputTokens: 1000, outputTokens: 100 } });
    reportUsage({ provider: "provider-a", model: "claude-sonnet-5-5" });
    const [counted, uncounted] = meter.take(src, "corr").map((d) => d.payload);
    assert.deepEqual(counted.provenance, { tokens: "measured", usd: "estimated" });
    assert.equal(counted.estimated, true);
    assert.deepEqual(uncounted.provenance, { tokens: "estimated", usd: "estimated" }, "no usage from the provider: nothing was counted");
    for (const p of [counted, uncounted]) validateDraft({ type: "budget.usage_recorded", source: src, payload: p });
  });
});
