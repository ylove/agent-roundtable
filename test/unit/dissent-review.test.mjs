import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeRun, nodeCommand, registerWorker, runner, task } from "../fixtures/workers/run.mjs";
import { actionsToDrafts, dissentTripwireRules, evaluate } from "../../dist/execution/watchdog.js";
import { blockingIds, taskHeld } from "../../dist/execution/task-holds.js";
import { resolveEscalation } from "../../dist/execution/escalation.js";
import { MergeQueue } from "../../dist/execution/runner-merge.js";
import { openExecutionStore } from "../../dist/execution/store.js";
import { wakeFor } from "../../dist/execution/watch.js";
import { renderDissents } from "../../dist/dashboard/render.js";
import { handleToolCall } from "../../dist/tools.js";
import { resetWorkerTools } from "../../dist/tools/worker.js";
import { Runner } from "../../dist/execution/runner.js";

const spec = (tripwire, over = {}) => ({ id: "risk", by: "critic", source: { kind: "manual" }, claim: "A regression is likely.",
  predicted_failure: "Unit validation fails.", tripwire, on_fire: "pause_and_huddle", ...over });
const check = { kind: "check_failed", check: "unit", task: "a" };
const emit = (store, type, payload) => store.transact(() => ({ events: [{ type, payload, source: runner }] }));
const fire = (store) => store.transact(({ state }) => ({ events: actionsToDrafts(dissentTripwireRules(state)) }));
async function setup(t, dissent = spec(check)) {
  const run = await makeRun({ contract: { tasks: [task("a", { checks: ["unit"] }), task("b", { persona: "critic" })],
    dissents: dissent ? [dissent] : [], validation: { commands: [nodeCommand("unit", "process.exit(1)")], final: [] } } });
  t.after(() => { resetWorkerTools(); rmSync(run.root, { recursive: true, force: true }); });
  const { token } = await registerWorker(run.store, "w-a", "a");
  const reader = await registerWorker(run.store, "w-b", "b");
  await emit(run.store, "agent.registered", { agent: "w-b", persona: "critic", driver: "claude-code", token_sha256: reader.sha256, external: false });
  await emit(run.store, "agent.spawned", { agent: "w-a", task: "a", attempt: 1, pid: 4242 });
  await emit(run.store, "agent.spawned", { agent: "w-b", task: "b", attempt: 1, pid: 4243 });
  return { ...run, token };
}
const failed = (store, extra = {}) => emit(store, "check.failed", { scope: "task", task: "a", command_id: "unit", exit: 1, signature: "regression", ...extra });
async function amend(store, dissents) {
  const c = { ...(await store.state()).contract, dissents };
  c.version++;
  return emit(store, "contract.amended", { contract: c.id, version: c.version, blob: await store.putBlob(JSON.stringify(c)), patch_blob: "patch", reason: "Update dissents", affected_tasks: [] });
}

for (const phase of ["submitted", "checking"]) {
  test(`dissent pause during ${phase} preserves the pipeline, enforces the worker hold and gates merging`, async (t) => {
    const d = spec(phase === "submitted" ? { kind: "path_touched", paths: ["src/a/**"] } : check);
    const { store, token } = await setup(t, d);
    const submitted = await emit(store, "task.submitted", { task: "a", commit: "c1", diff_blob: "diff", stat: "one file", files: ["src/a/x.ts"], rewrites: [] });
    const seq = submitted.events[0].seq;
    if (phase === "checking") {
      await emit(store, "check.started", { scope: "task", task: "a", command_id: "unit", submitted_seq: seq, commit: "c1" });
      await failed(store, { submitted_seq: seq, commit: "c1" });
    }
    await fire(store);
    let state = await store.state();
    assert.equal(state.tasks.a.state, phase);
    assert.ok(taskHeld(state, "a"));
    assert.match(Runner.prototype.startProblem.call({}, state, "a", "w-a", false, true), /held by an escalation/);
    const stopped = Runner.prototype.markPaused.call({}, { task: "a" }, [{ type: "agent.exited", payload: { agent: "w-a", task: "a", code: null, reason: "killed" } }], state);
    assert.equal(stopped[0].payload.paused, blockingIds(state.tasks.a)[0], "a dissent pause does not burn a worker attempt");
    assert.ok(evaluate(state, Date.now(), { agents: { "w-a": { alive: true } } }).some((a) => a.type === "kill_worker" && a.agent === "w-a"));
    const auth = { execution_id: store.id, agent_token: token };
    for (const [tool, args] of [["submit_work", { summary: "More work", ready: true }], ["run_command", { command_id: "unit" }],
      ["post_update", { kind: "progress", text: "Working" }], ["lease", { action: "request", paths: ["src/a/**"] }]]) {
      const result = await handleToolCall(tool, { ...auth, ...args });
      assert.equal(result.isError, true, tool);
      assert.match(result.content[0].text, /held by an escalation/, tool);
    }
    await assert.rejects(emit(store, "task.submitted", { task: "a", commit: "c2", diff_blob: "diff2", stat: "one file", files: [], rewrites: [] }), /held by an escalation/);
    await emit(store, "task.checks_passed", { task: "a", commands: ["unit"], submitted_seq: seq, commit: "c1" });
    state = await store.state();
    assert.equal(state.tasks.a.state, "merging");
    assert.ok(taskHeld(state, "a"), "completion of in-flight checks retains the hold");
    let jobs = 0;
    new MergeQueue({ isStopping: () => false, background: () => { jobs++; } }).feed(state);
    assert.equal(jobs, 0, "held work never enters the merge queue");
    await emit(store, "task.rejected", { task: "a", reasons: ["check failed"] });
    state = await store.state();
    assert.equal(state.tasks.a.state, "blocked");
    assert.ok(taskHeld(state, "a"), "rejection cannot erase the hold");
    assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
  });
}

test("resolving a dissent removes only its source; dependency b and interface needs remain", async (t) => {
  const { store } = await setup(t);
  const need = { task: "a", need: { kind: "interface", ref: "Api" } };
  await emit(store, "dependency.requested", need);
  await emit(store, "task.blocked", { task: "a", deps: ["b"] });
  await failed(store);
  await fire(store);
  const id = Object.values((await store.state()).escalations).find((e) => e.dissent_id === "risk").id;
  const result = await resolveEscalation({ store }, id, { action: "decide", decision: "Proceed carefully", resolved_by: "main" });
  assert.deepEqual(result.ops, []);
  let state = await store.state();
  assert.equal(state.tasks.a.state, "blocked");
  assert.deepEqual(state.tasks.a.blocked_by, { deps: ["b"], needs: [{ kind: "interface", ref: "Api" }] });
  await emit(store, "task.accepted", { task: "b" });
  await emit(store, "task.unblocked", { task: "a" });
  assert.equal((await store.state()).tasks.a.state, "blocked", "the interface wait remains after dependency acceptance");
  await emit(store, "dependency.satisfied", { ...need, by_event: "published" });
  await emit(store, "task.unblocked", { task: "a" });
  state = await store.state();
  assert.equal(state.tasks.a.state, "in_progress");
  assert.equal(state.tasks.a.blocked_by, undefined);
});

test("runner persona dissent delivery reaches live worker ids, persona inbox and the dashboard", async (t) => {
  const { store } = await setup(t);
  await failed(store);
  await fire(store);
  const state = await store.state();
  const notification = (await store.events()).find((e) => e.type === "directive.issued");
  assert.deepEqual(notification.payload.to, ["critic", "w-b"]);
  assert.equal(state.inbox["w-b"][0].id, state.inbox.critic[0].id);
  const firing = Object.values(state.dissents.risk.fires)[0];
  assert.deepEqual(firing.notified, ["critic", "w-b"]);
  assert.equal(firing.orchestrator_woken, false);
  const html = renderDissents({ state, header: store.header(), base: "/test/", runner: { status: "alive", detail: "Test" } });
  assert.match(html, /Notification/);
  assert.match(html, /critic, w-b/);
});

test("a persona dissent reaches every live reader; a worker-id dissent also reaches its persona seat", async (t) => {
  const { store } = await setup(t, spec(check, { on_fire: "notify" }));
  await emit(store, "agent.registered", { agent: "w-c", persona: "critic", driver: "claude-code", token_sha256: "c".repeat(64), external: false });
  await failed(store);
  await fire(store);
  let state = await store.state();
  for (const id of ["critic", "w-b", "w-c"]) assert.ok(state.inbox[id].some((i) => i.kind === "directive"), id);
  await amend(store, [spec(check, { id: "worker-risk", by: "w-b", on_fire: "notify" })]);
  await failed(store);
  await fire(store);
  state = await store.state();
  assert.deepEqual(Object.values(state.dissents["worker-risk"].fires)[0].notified, ["w-b", "critic"]);
});

test("dissent persona inbox delivery is literal even when a team has the same name", async (t) => {
  const { store } = await setup(t);
  const c = { ...(await store.state()).contract, teams: [{ id: "critic", members: ["w-a"] }] };
  c.version++;
  await emit(store, "contract.amended", { contract: c.id, version: c.version, blob: await store.putBlob(JSON.stringify(c)), patch_blob: "patch", reason: "Add a team", affected_tasks: [] });
  await failed(store);
  await fire(store);
  const state = await store.state();
  assert.ok(state.inbox.critic.some((i) => i.kind === "directive"));
  assert.ok(state.inbox["w-b"].some((i) => i.kind === "directive"));
  assert.equal(state.inbox["w-a"], undefined, "a similarly named team is not the dissenter");
});

for (const self of [false, true, "taskless"]) {
  test(`dissent ${self ? "self-trip" : "without a live reader"} ${self}: notifies and durably wakes the orchestrator`, async (t) => {
    const d = spec(self === "taskless" ? { kind: "check_failed", check: "unit" } : check,
      { by: self === "taskless" ? "main" : self ? "builder" : "absent-critic", on_fire: "huddle" });
    const { store } = await setup(t, d);
    if (self === "taskless") await emit(store, "check.failed", { scope: "integration", command_id: "unit", exit: 1, signature: "final" });
    else await failed(store);
    const actions = dissentTripwireRules(await store.state());
    assert.ok(actions.some((a) => a.type === "wake_orchestrator"));
    await fire(store);
    const events = await store.events();
    const firing = events.find((e) => e.type === "dissent.tripwire_fired");
    const state = await store.state();
    assert.equal(wakeFor(state, firing, "main").reason, "dissent");
    assert.equal(wakeFor(state, firing, "other"), null);
    assert.ok(state.inbox[d.by].some((i) => i.kind === "directive"));
    if (self) assert.equal(events.filter((e) => e.type === "escalation.raised").length, 0, "self-trips cannot seat a huddle or unrelated fallback");
    assert.ok(Object.values(state.dissents.risk.fires)[0].orchestrator_woken);
  });
}

test("new and changed tripwires ignore pre-amendment failures and changes re-arm with a new key", async (t) => {
  const { store } = await setup(t, null);
  await failed(store);
  await amend(store, [spec(check, { on_fire: "notify" })]);
  assert.deepEqual(dissentTripwireRules(await store.state()), []);
  await failed(store);
  await fire(store);
  const first = Object.keys((await store.state()).dissents.risk.fires)[0];
  await amend(store, [spec({ kind: "task_state", task: "a", state: "rejected" }, { on_fire: "notify" })]);
  assert.deepEqual(dissentTripwireRules(await store.state()), []);
  const rearmed = await store.state();
  assert.match(renderDissents({ state: rearmed, header: store.header(), base: "/test/", runner: { status: "alive", detail: "Test" } }), /Status: armed/);
  await emit(store, "task.rejected", { task: "a", reasons: ["another regression"] });
  await fire(store);
  const state = await store.state();
  const keys = Object.keys(state.dissents.risk.fires);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[1], first);
  assert.match(keys[1], /@\d+$/);
  assert.deepEqual(dissentTripwireRules(state), []);
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});

test("amending away a fired dissent prunes its projection and releases only its hold", async (t) => {
  const { store } = await setup(t);
  await emit(store, "task.blocked", { task: "a", deps: ["b"] });
  await failed(store);
  await fire(store);
  const before = await store.state();
  assert.equal(blockingIds(before.tasks.a).length, 1);
  const id = blockingIds(before.tasks.a)[0];
  await amend(store, []);
  const state = await store.state();
  assert.deepEqual(state.dissents, {});
  assert.equal(state.escalations[id].status, "withdrawn");
  assert.deepEqual(state.tasks.a.blocked_by, { deps: ["b"] });
  assert.equal(state.tasks.a.state, "blocked");
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});

test("a dissent capped at its author's limit can still route to a funded lead, or to the human if the lead is capped", async (t) => {
  const { store } = await setup(t);
  await failed(store);
  await fire(store);
  const state = await store.state();
  const e = Object.values(state.escalations).find((e) => e.dissent_id);
  state.contract.budget.per_agent_usd = 1;
  state.budget.by_agent.critic = 1;
  e.status = "routed";
  e.routed_to = "main";
  const obs = { escalations: { [e.id]: { routedAt: 0 } } };
  let actions = evaluate(state, Date.now(), obs);
  assert.ok(actions.some((a) => a.type === "lead_fallback" && a.escalation === e.id));
  state.budget.by_agent[state.contract.authority.lead] = 1;
  actions = evaluate(state, Date.now(), obs);
  assert.ok(actionsToDrafts(actions).some((d) => d.type === "escalation.awaiting_human" && d.payload.id === e.id));
  assert.ok(!actions.some((a) => a.type === "lead_fallback" && a.escalation === e.id));
});
