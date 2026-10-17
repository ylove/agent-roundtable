// Stopping one agent (usage-visibility.md §6): heads-down (request, runner, exit, escalation, watcher
// wake, handoff) and at the table (request, abort, ended as stopped, the next call's answer), through
// the CLI's target resolution, control_execution and the usage tool.
import { installProcessIdentity } from "../fixtures/execution/process-identity.mjs";
installProcessIdentity();
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, registerWorker, runner, task } from "../fixtures/workers/run.mjs";
import { emit, frozenRun } from "../fixtures/execution/run.mjs";
import { waitFor } from "../fixtures/runner/harness.mjs";
import { sandbox, scriptedDriver } from "../fixtures/runner/driver.mjs";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { Runner, workerAgentId } = await import("../../dist/execution/runner.js");
const { taskBranch } = await import("../../dist/execution/git.js");
const { taskWorktreePath } = await import("../../dist/execution/worktrees.js");
const { wakeFor } = await import("../../dist/execution/watch.js");
const { requestAgentStop, stopRefusal, StopRefusal } = await import("../../dist/usage/stop.js");
const { buildRunHandoff, buildSessionHandoff } = await import("../../dist/usage/handoff.js");
const { resolveStopTarget, stopAgent } = await import("../../dist/usage/control.js");
const { collectUsage } = await import("../../dist/usage/model.js");
const { handleToolCall } = await import("../../dist/tools.js");
const { setOrchestratorDeps } = await import("../../dist/execution/orchestrator.js");
const T = await import("../../dist/usage/table.js");
const S = await import("../../dist/usage/session-scope.js");
const { startTableService, stopSession, liveSessions } = await import("../../dist/usage/table-service.js");
const { meetings } = await import("../../dist/sessions/meetings.js");
const { localMeetings, liveLocalMeetingPids } = await import("../../dist/sessions/local-meetings.js");
const { readArchivedSession } = await import("../../dist/sessions/archive.js");
const { isSessionBusy } = await import("../../dist/sessions/lock.js");
const { ROUNDTABLE_HOME, SESSIONS_DIR } = await import("../../dist/config.js");

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../fixtures/agents/sample.md");
const BASE = "http://localhost:1234/v1";

let restore;
beforeEach(() => {
  restore = setOrchestratorDeps({ ensureRunner: async () => ({ status: "running", pid: 4242 }) });
});
afterEach(() => restore());

const append = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));
const eventsOf = async (store, type) => (await store.events()).filter((e) => e.type === type);
const parse = (r) => {
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

// --- heads-down: the runner -------------------------------------------------------------------------

async function setup(t, contract = { tasks: [task("a")] }) {
  const run = await makeRun({ contract });
  const driver = scriptedDriver(t);
  const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 10, tickMs: 10 });
  await r.start();
  t.after(async () => { r.stop("test cleanup"); await r.run(); });
  return { ...run, r, driver };
}

async function tickUntil(r, predicate) {
  await waitFor(async () => { await r.tick(); return predicate(); }, 10000, "runner condition");
}

test("stop, heads-down: request -> worker stopped -> agent.exited {stopped} -> agent.stopped -> blocker escalation and a blocked task, never retried", async (t) => {
  const { store, root, r, driver } = await setup(t);
  await r.tick();
  assert.equal(driver.calls.length, 1);
  const agent = workerAgentId("a");
  assert.equal((await store.state()).agents[agent].status, "running");

  const asked = await requestAgentStop(store, { agent, by: "the human (command line)", surface: "cli", reason: "it is going the wrong way" });
  assert.equal(asked.task, "a");
  const requested = (await eventsOf(store, "agent.stop_requested"))[0];
  assert.equal(asked.request, requested.id);
  assert.equal((await store.state()).agents[agent].stop.state, "requested");

  await tickUntil(r, async () => (await store.state()).agents[agent].stop?.state === "stopped");
  const events = await store.events({ sinceSeq: requested.seq - 1 });
  const order = events.map((e) => e.type).filter((x) => ["agent.stop_requested", "agent.exited", "agent.stopped", "escalation.raised", "task.blocked"].includes(x));
  assert.deepEqual(order, ["agent.stop_requested", "agent.exited", "agent.stopped", "escalation.raised", "task.blocked"]);
  const exited = events.find((e) => e.type === "agent.exited");
  assert.equal(exited.payload.reason, "stopped");
  const stopped = events.find((e) => e.type === "agent.stopped");
  const esc = events.find((e) => e.type === "escalation.raised").payload.escalation;
  assert.deepEqual(stopped.payload, { agent, task: "a", request: requested.id, escalation: esc.id });
  assert.equal(esc.kind, "blocker");
  assert.equal(esc.with, "orchestrator");
  assert.equal(esc.blocking, true);
  assert.equal(esc.summary, `${agent} was stopped by the human (command line).`);
  assert.ok(esc.options.some((o) => /resolve_escalation/.test(o)) && esc.options.some((o) => /handoff/.test(o)));
  const state = await store.state();
  assert.equal(state.tasks.a.state, "blocked");
  assert.equal(state.tasks.a.blocked_by.escalation, esc.id);
  assert.equal(state.agents[agent].status, "exited");

  // Not retried, and the work in progress is kept.
  for (let i = 0; i < 8; i++) await r.tick();
  assert.equal(driver.calls.length, 1, "no new worker");
  assert.equal((await eventsOf(store, "task.retried")).length, 0);
  assert.equal((await store.state()).tasks.a.state, "blocked");
  assert.ok(existsSync(taskWorktreePath(store.id, "a")), "the worktree stays");
  assert.match(git(root, "branch", "--list", taskBranch(store.id, "a")), /rt\//, "the branch stays");
  assert.equal((await eventsOf(store, "agent.stopped")).length, 1, "settled once");

  // The watcher wakes the orchestrator with the two choices.
  const routed = await append(store, "escalation.routed", { id: esc.id, to: "main", wake: true });
  const wake = wakeFor(await store.state(), routed.events[0], "main");
  assert.equal(wake.reason, "agent_stopped");
  assert.equal(wake.escalation.id, esc.id);
  assert.match(wake.message, new RegExp(`${agent} was stopped by the human \\(command line\\) while it worked on task a`));
  assert.match(wake.message, /resolve_escalation\(escalation_id: "[^"]+", action: reassign, retry, amend or decide\)/);
  assert.match(wake.message, /control_execution\(action: "handoff"\)/);
  // Any other escalation is still the plain escalation wake.
  assert.equal(wakeFor(await store.state(), { ...routed.events[0], payload: { ...routed.events[0].payload, id: "esc-other" } }, "main").reason, "escalation");

  // Usage shows the stop and the stopped agent.
  const view = await collectUsage({ executions: [store.id], table: false });
  assert.equal(view.agents.find((a) => a.id === agent).state, "stopped");
  assert.equal(view.stops[0].status, "stopped");
  assert.equal(view.stops[0].by, "the human (command line)");
});

test("stop, heads-down: a stop for a worker that already finished is not a stop of anything", async (t) => {
  const { store, r, driver } = await setup(t);
  await r.tick();
  const agent = workerAgentId("a");
  await requestAgentStop(store, { agent, by: "the human (dashboard)", surface: "dashboard" });
  await tickUntil(r, async () => (await store.state()).agents[agent].stop?.state === "stopped");
  // Asking again after it stopped: the agent has no live process any more.
  await assert.rejects(() => requestAgentStop(store, { agent, by: "x", surface: "cli" }), /no live process/);
  assert.equal(driver.calls.length, 1);
});

test("stop: plain refusals for an unknown agent, an external worker, an agent without a process and a finished run", async () => {
  const run = await makeRun({ contract: { tasks: [task("a"), task("b")] } });
  await registerWorker(run.store, "w-a", "a");
  await append(run.store, "agent.registered", { agent: "ext-1", persona: "dev", driver: "external", token_sha256: "t", external: true });
  await append(run.store, "agent.registered", { agent: "idle-1", persona: "dev", driver: "claude-code", token_sha256: "t2", external: false });
  const state = await run.store.state();
  assert.match(stopRefusal(state, "ghost"), /There is no agent "ghost" in this run \(agents: .*w-a/);
  assert.match(stopRefusal(state, "ext-1"), /external worker.*steer/s);
  assert.match(stopRefusal(state, "idle-1"), /no live process \(it is registered\)/);
  assert.equal(stopRefusal(state, "constructor"), stopRefusal(state, "constructor"));
  assert.match(stopRefusal(state, "constructor"), /There is no agent/, "inherited names are not agents");
  await assert.rejects(() => requestAgentStop(run.store, { agent: "ext-1", by: "x", surface: "tool" }), StopRefusal);
  await append(run.store, "execution.aborted", { reason: "done" });
  assert.match(stopRefusal(await run.store.state(), "w-a"), /aborted/);
});

test("control_execution stop_agent and handoff, through the tool", async () => {
  const run = await makeRun({ contract: { tasks: [task("a"), task("b")] } });
  const token = await registerWorker(run.store, "w-a", "a");
  void token;
  await append(run.store, "agent.spawned", { agent: "w-a", task: "a", attempt: 1, pid: process.pid });
  await append(run.store, "task.progress", { task: "a", percent: 40, note: "halfway, key ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" });
  await append(run.store, "agent.registered", { agent: "ext-1", persona: "dev", driver: "external", token_sha256: "t", external: true });

  const id = run.store.id;
  const none = await handleToolCall("control_execution", { execution_id: id, action: "stop_agent" });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /"targets" is required for stop_agent/);
  const refused = await handleToolCall("control_execution", { execution_id: id, action: "stop_agent", targets: ["ext-1", "ghost"] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /external worker/);

  const r = parse(await handleToolCall("control_execution", { execution_id: id, action: "stop_agent", targets: ["w-a", "ext-1"], reason: "the human said stop" }));
  assert.deepEqual(r.requested, [{ agent: "w-a", task: "a" }]);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].agent, "ext-1");
  assert.match(r.next, /agent_stopped/);
  const ev = (await eventsOf(run.store, "agent.stop_requested"))[0];
  assert.deepEqual(ev.payload, { agent: "w-a", by: "main (for the human)", surface: "tool", reason: "the human said stop" });
  assert.equal(ev.source.kind, "orchestrator");
  // Again: the waiting request is returned, nothing new is recorded.
  assert.equal(parse(await handleToolCall("control_execution", { execution_id: id, action: "stop_agent", targets: ["w-a"] })).requested[0].already, true);
  assert.equal((await eventsOf(run.store, "agent.stop_requested")).length, 1);

  // handoff pauses the live run and writes HANDOFF.md.
  const h = parse(await handleToolCall("control_execution", { execution_id: id, action: "handoff", reason: "stepping away" }));
  assert.equal(h.paused, true);
  assert.equal(h.status, "paused");
  assert.equal(h.path, join(run.store.dir, "HANDOFF.md"));
  assert.equal(readFileSync(h.path, "utf8"), h.document);
  assert.equal(parse(await handleToolCall("control_execution", { execution_id: id, action: "handoff" })).paused, false, "already paused");
  for (const want of ["# Handoff: Test contract", "Where things stand", "## Tasks", "`a` Task a", "halfway, key [redacted", "w-a", "stopped by main (for the human)", "agent-roundtable status", "control_execution(execution_id", `watch ${id} --as main`]) {
    assert.ok(h.document.includes(want), want);
  }
  assert.ok(!h.document.includes("ghp_"), "scrubbed");
  assert.equal((await run.store.state()).status, "paused");
});

test("the handoff holds no confirmation, original prompt, diff or command output, and scrubs every string", async () => {
  const { store } = await frozenRun();
  const state0 = await store.state();
  const prompt = state0.goal.original_prompt;
  assert.ok(prompt && prompt.length > 5);
  await emit(store, "agent.registered", { agent: "w-a", persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "task.claimed", { task: "a", agent: "w-a", attempt: 1, ttl_s: 0 });
  const diff = await store.putBlob("diff --git a/secret.txt b/secret.txt\n+DIFF-BODY-MARKER\n");
  await emit(store, "task.submitted", { task: "a", commit: "c1", diff_blob: diff, stat: "STAT-MARKER 1 file changed", files: ["secret.txt"], rewrites: [] });
  const out = await store.putBlob("OUTPUT-MARKER boom");
  await emit(store, "check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: "SIG-MARKER", output_blob: out });
  await emit(store, "task.progress", { task: "b", note: "mail alice@example.com token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 line1\nline2 | pipe" });
  await emit(store, "agent.stop_requested", { agent: "w-a", by: "the human (dashboard)", surface: "dashboard", reason: "because" });
  const doc = buildRunHandoff(await store.state(), new Date("2030-01-01T00:00:00Z"));
  for (const banned of [prompt, "go ahead", "DIFF-BODY-MARKER", "STAT-MARKER", "OUTPUT-MARKER", "SIG-MARKER", "ghp_"]) assert.ok(!doc.includes(banned), banned);
  assert.ok(doc.includes("Written 2030-01-01T00:00:00.000Z"));
  assert.match(doc, /\| `b` .*\| mail .*\[redacted/);
  assert.ok(!/line1\nline2/.test(doc), "one line per cell");
  assert.match(doc, /\\\| pipe/, "pipes cannot break the table");
});

// --- at the table -----------------------------------------------------------------------------------

/** A provider whose first reply is immediate and whose later calls hang until their signal fires. */
function hangingProvider(t, { hangFrom = 1 } = {}) {
  const calls = stubFetch(t, (_u, init, i) => {
    if (i < hangFrom) return json(200, { choices: [{ message: { content: `reply ${i}` } }], model: "served", usage: { prompt_tokens: 10, completion_tokens: 5 } });
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new DOMException("aborted", "AbortError")), { once: true }));
  });
  return calls;
}

async function startMeeting() {
  const r = parse(await handleToolCall("start_meeting", { agent: sample, agenda: "plan the offsite", provider: "openai_compatible", model: "m", base_url: BASE }));
  return r.meeting_id ?? r.meetingId ?? /meeting-[0-9a-z]{8}/.exec(JSON.stringify(r))[0];
}

test("stop, at the table: the turn in flight is cut, the session ends as stopped, and the next call says so", async (t) => {
  hangingProvider(t);
  const id = await startMeeting();
  assert.ok(meetings.has(id));
  const turn = handleToolCall("say", { meeting_id: id, message: "go on" });
  await waitFor(() => isSessionBusy(id), 3000, "the turn to be in flight");
  assert.equal(liveSessions().find((s) => s.id === id).busy, true);
  const done = await stopSession({ session: id, by: "the human (command line)", surface: "cli", reason: "enough" });
  assert.equal(done.status, "stopped");
  const cut = await turn;
  assert.equal(cut.isError, true);
  assert.match(cut.content[0].text, /Stopped: the session was stopped by a person/);
  assert.ok(!meetings.has(id), "ended");
  assert.equal(isSessionBusy(id), false);

  // Archived as stopped, with who and why; the ledger and the audit log know.
  const archived = readArchivedSession(id);
  assert.equal(archived.stopped.by, "the human (command line)");
  assert.equal(archived.stopped.reason, "enough");
  const lines = T.readTableLines([T.day()]);
  const stopLine = lines.find((l) => l.event === "stopped" && l.session === id);
  assert.equal(stopLine.by, "the human (command line)");
  assert.ok(lines.some((l) => l.session === id && l.tokens && l.tokens_prov === "measured"), "the calls before the stop were metered");

  // The next tool call that names the session answers {status: "stopped"}.
  const next = parse(await handleToolCall("say", { meeting_id: id, message: "hello?" }));
  assert.equal(next.status, "stopped");
  assert.equal(next.session, id);
  assert.equal(next.by, "the human (command line)");
  assert.match(next.next, /continue without/);
  assert.match(next.next, /usage\(action: "handoff"/);
  assert.equal(parse(await handleToolCall("end_meeting", { meeting_id: id })).status, "stopped");

  // usage(report) lists recent stops, then the handoff is written under sessions/.
  const report = parse(await handleToolCall("usage", { action: "report" }));
  assert.ok(report.stops.some((s) => s.scope === id && s.status === "stopped"));
  const h = parse(await handleToolCall("usage", { action: "handoff", session_id: id }));
  assert.equal(h.path, join(SESSIONS_DIR, `${id}.handoff.md`));
  assert.match(h.document, /Stopped by the human \(command line\)/);
  assert.match(h.document, /No summary was written/);
  assert.match((await handleToolCall("usage", { action: "handoff", session_id: "meeting-zzzzzzzz" })).content[0].text, /not archived/);
  assert.match((await handleToolCall("usage", { action: "handoff" })).content[0].text, /needs "session_id"/);
});

test("stop, at the table: a request file for this server is picked up within a second and removed", async (t) => {
  hangingProvider(t, { hangFrom: 99 });
  const id = await startMeeting();
  const service = startTableService({ beatMs: 20, pollMs: 20 });
  t.after(() => service.close());
  const live = T.readLiveServers().find((s) => s.server === service.serverId);
  assert.ok(live.sessions.some((s) => s.id === id));
  const view = await collectUsage({ executions: [] });
  assert.equal(view.agents.find((a) => a.scope === id)?.stoppable ?? true, true);

  const req = T.writeStopRequest(service.serverId, { session: id, agent: "sample", by: "the human (dashboard)", surface: "cli" });
  await waitFor(() => !meetings.has(id), 5000, "the session to be stopped");
  await waitFor(() => !existsSync(join(ROUNDTABLE_HOME, "usage", "stops", service.serverId, `${req.id}.json`)), 3000, "the request to be removed");
  assert.equal(S.stoppedSessions.get(id).by, "the human (dashboard)");
  // A request for a session this server does not hold is simply dropped.
  const ghost = T.writeStopRequest(service.serverId, { session: "meeting-zzzzzzzz", agent: "x", by: "x", surface: "cli" });
  await waitFor(() => !existsSync(join(ROUNDTABLE_HOME, "usage", "stops", service.serverId, `${ghost.id}.json`)), 3000, "the ghost request to be dropped");
  service.close();
  assert.equal(T.readLiveServers().some((s) => s.server === service.serverId), false, "the live file goes with a clean shutdown");
});

test("stop, at the table: usage(action: stop) from the tool stops a session of this very server", async (t) => {
  hangingProvider(t, { hangFrom: 99 });
  const id = await startMeeting();
  const service = startTableService({ beatMs: 10_000, pollMs: 10_000 });
  t.after(() => service.close());
  const r = parse(await handleToolCall("usage", { action: "stop", agent: "sample", reason: "asked in chat" }));
  assert.equal(r.status, "stopped");
  assert.equal(r.where, "at-the-table");
  assert.equal(r.scope, id);
  assert.match(r.message, /was stopped and ended/);
  assert.ok(!meetings.has(id));
  assert.equal(readArchivedSession(id).stopped.by, "the orchestrator (for the human)");
  assert.equal(readArchivedSession(id).stopped.reason, "asked in chat");
  // Nothing of that name is running now.
  const again = await handleToolCall("usage", { action: "stop", agent: "sample" });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /not running right now|No agent named/);
  assert.match((await handleToolCall("usage", { action: "stop" })).content[0].text, /"agent" is required/);
});

test("stop target resolution: one running agent needs no scope; a name in two places says where; the rest explain", async () => {
  const mk = (over) => ({
    id: "cfo", where: "at-the-table", scope: "meeting-aaaaaaaa", provider: "p", models: [], tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, by: { measured: 0, reported: 0, estimated: 0 } },
    money: { measured: 0, reported: 0, estimated: 0 }, state: "working", stoppable: true, ...over,
  });
  const view = (agents) => ({ agents, stops: [], runs: [], platforms: [], table: {}, totals: {}, generated_at: "" });
  const exe = "exe-0123456789abcdef";
  assert.deepEqual(resolveStopTarget(view([mk()]), "cfo"), { where: "at-the-table", agent: "cfo", session: "meeting-aaaaaaaa" });
  assert.deepEqual(resolveStopTarget(view([mk({ where: "heads-down", scope: exe, id: "w-a" })]), "w-a"), { where: "heads-down", agent: "w-a", execution: exe });
  const two = view([mk(), mk({ where: "heads-down", scope: exe })]);
  assert.throws(() => resolveStopTarget(two, "cfo"), /more than one place.*--session meeting-aaaaaaaa or --execution exe-0123456789abcdef|more than one place.*--execution exe-0123456789abcdef or --session meeting-aaaaaaaa/);
  assert.equal(resolveStopTarget(two, "cfo", { execution: exe }).where, "heads-down");
  assert.equal(resolveStopTarget(two, "cfo", { session: "meeting-aaaaaaaa" }).where, "at-the-table");
  assert.throws(() => resolveStopTarget(two, "cfo", { session: "meeting-bbbbbbbb" }), /No agent named "cfo" in that scope/);
  assert.throws(() => resolveStopTarget(view([mk()]), "ghost"), /No agent named "ghost" is known\. Agents that can be stopped: cfo/);
  assert.throws(() => resolveStopTarget(view([]), "ghost"), /Nothing is running that can be stopped/);
  assert.throws(() => resolveStopTarget(view([mk({ stoppable: false, state: "done" })]), "cfo"), /not running right now \(it is done\)/);
  assert.throws(() => resolveStopTarget(view([mk({ stoppable: false, provider: "external", where: "heads-down" })]), "cfo"), /external worker.*steer/s);
  assert.throws(() => resolveStopTarget(view([mk({ stoppable: false, stopping: true })]), "cfo"), /already on its way/);
  assert.throws(() => resolveStopTarget(view([mk({ where: "host", id: "host", scope: "host", stoppable: false })]), "host"), /No agent named/, "the host cannot be stopped from here");
});

test("the stop CLI: validation, plain errors and exit codes", async () => {
  const { spawnSync } = await import("node:child_process");
  const bin = join(here, "..", "..", "dist", "index.js");
  const run = (...args) => spawnSync(process.execPath, [bin, "stop", ...args], { encoding: "utf8", env: { ...process.env } });
  assert.equal(run().status, 2);
  assert.match(run().stderr, /stop needs an agent/);
  assert.equal(run("cfo", "--execution", "nope").status, 2);
  assert.equal(run("cfo", "--session", "Bad Id").status, 2);
  assert.match(run("cfo", "--execution", "exe-0123456789abcdef", "--session", "meeting-aaaaaaaa").stderr, /not both/);
  const unknown = run("ghost");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /agent-roundtable stop: No agent named "ghost" is known/);
  assert.equal(unknown.stdout, "");
});

test("the stop CLI path: a heads-down agent is found and asked to stop, with a plain message", async () => {
  const run = await makeRun({ contract: { tasks: [task("a")] } });
  await registerWorker(run.store, "w-a", "a");
  await append(run.store, "agent.spawned", { agent: "w-a", task: "a", attempt: 1, pid: process.pid });
  const ensured = [];
  const out = await stopAgent("w-a", {}, { surface: "cli", reason: "too slow", ensureRunner: async (exe) => (ensured.push(exe), { status: "running" }) });
  assert.equal(out.status, "requested");
  assert.equal(out.where, "heads-down");
  assert.equal(out.scope, run.store.id);
  assert.deepEqual(ensured, [run.store.id]);
  assert.match(out.message, /Stop requested for w-a\. The runner stops it on its next tick/);
  const [ev] = await eventsOf(run.store, "agent.stop_requested");
  assert.deepEqual(ev.payload, { agent: "w-a", by: "the human (command line)", surface: "cli", reason: "too slow" });
  assert.equal(ev.source.kind, "human");
  const again = await stopAgent("w-a", { execution: run.store.id }, { surface: "cli", ensureRunner: async () => ({ status: "running" }) }).catch((e) => e);
  assert.ok(again instanceof StopRefusal || again.status === "requested", "a second ask is answered, never crashes");
});

// --- local meetings --------------------------------------------------------------------------------

test("stop, at the table: a local meeting's CLI process group is stopped with the session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const script = join(dir, "claude");
  writeFileSync(
    script,
    `#!${process.execPath}\nif (process.argv.includes("--help")) { process.stdout.write("  --permission-prompts --restricted --settings --strict-mcp-config --tools --permission-mode --disable-slash-commands --no-chrome\\n"); process.exit(0); }\n` +
      `let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (d) => (input += d));\nprocess.stdin.on("end", () => {\n` +
      `  if (input.includes("HANG")) { setInterval(() => {}, 1000); return; }\n  process.stdout.write("fake reply");\n});\n`
  );
  chmodSync(script, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  const started = parse(await handleToolCall("start_local_meeting", { agent: sample, agenda: "agenda" }));
  const id = started.meeting_id ?? /local-[0-9a-z]{8}/.exec(JSON.stringify(started))[0];
  assert.ok(localMeetings.has(id));
  const turn = handleToolCall("say_local", { meeting_id: id, message: "HANG please" });
  await waitFor(() => liveLocalMeetingPids().length === 1, 5000, "the CLI to be running");
  const pid = liveLocalMeetingPids()[0];
  assert.ok(isSessionBusy(id));
  const done = await stopSession({ session: id, by: "the human (command line)", surface: "cli" });
  assert.equal(done.status, "stopped");
  const cut = await turn;
  assert.equal(cut.isError, true);
  assert.match(cut.content[0].text, /Stopped/);
  assert.ok(!localMeetings.has(id));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000, "the CLI process to be gone");
  const lines = T.readTableLines([T.day()]).filter((l) => l.session === id);
  assert.ok(lines.some((l) => l.kind === "local-meeting" && l.provider === "claude-cli" && l.tokens_prov === "estimated"), "the CLI turns are metered, estimated from length");
  assert.ok(lines.some((l) => l.event === "stopped"));
  assert.equal(readArchivedSession(id).stopped.by, "the human (command line)");
});

test("a session handoff is generated from the archive: no turn text", () => {
  const a = {
    id: "meeting-aaaaaaaa", kind: "meeting", agents: ["cfo"], topic: "Q3 budget", started: "2030-01-01T00:00:00Z", ended: "2030-01-01T00:10:00Z",
    transcript: "TRANSCRIPT-MARKER", turns: [{ role: "caller", speaker: "caller", content: "TURN-MARKER ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" }],
    summary: "SUMMARY-MARKER", public: null,
  };
  const ended = buildSessionHandoff(a, new Date("2030-01-02T00:00:00Z"));
  assert.ok(ended.includes("SUMMARY-MARKER") && ended.includes("Q3 budget") && ended.includes("1 turn"));
  assert.ok(!ended.includes("TURN-MARKER") && !ended.includes("TRANSCRIPT-MARKER") && !ended.includes("ghp_"));
  const stopped = buildSessionHandoff({ ...a, stopped: { by: "the human (dashboard)", at: "2030-01-01T00:05:00Z", reason: "slow" } }, new Date());
  assert.ok(stopped.includes("Stopped by the human (dashboard)") && stopped.includes("(slow)"));
  assert.ok(!stopped.includes("SUMMARY-MARKER"), "a stopped session's summary is not trusted to describe it");
});
