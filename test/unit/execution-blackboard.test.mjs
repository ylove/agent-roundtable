import { test } from "node:test";
import assert from "node:assert/strict";

const { apply, applyInPlace, initialState, checkKey, contractBlobRef, REDUCER_VERSION } = await import("../../dist/execution/blackboard.js");
const { validateDraft, PAYLOAD_SPECS } = await import("../../dist/execution/events.js");
const { createExecutionStore, openExecutionStore } = await import("../../dist/execution/store.js");
const { EVENT_TYPES, GENESIS_HASH } = await import("../../dist/execution/types.js");
const { CONTRACT_ID, makeContract, runScript, taskSpec } = await import("../fixtures/execution/script.mjs");

const newStore = () => createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc", agentsDir: "/srv/agents" });

/** A bare envelope for pure reducer tests (the reducer never checks hashes). */
let seq = 0;
const ev = (type, payload, extra = {}) => ({
  v: 1, id: `evt-${++seq}`, seq, ts: "2026-10-15T00:00:00.000Z", execution: "exe-test", mode: "execution",
  source: { kind: "runner", id: "runner", pid: 1 }, type, payload, prev: "p", hash: `h${seq}`, ...extra,
});

/** Run a list of [type, payload, resolved?] through the reducer from a fresh state. */
function reduce(steps, state = initialState("exe-test")) {
  seq = state.seq;
  for (const [type, payload, resolved] of steps) state = apply(state, ev(type, payload), resolved);
  return state;
}

/** A minimal valid payload for a spec, built from the validator's own table. */
function sample(field) {
  if (Array.isArray(field)) return [sampleShape(field[0])];
  if (typeof field === "object") return sampleShape(field);
  const alt = field.split("|")[0];
  if (alt.startsWith("'")) return alt.slice(1, -1);
  return { s: "x", id: "x", t: "text", n: 1, int: 1, b: true, null: null, "s[]": ["x"], "id[]": ["x"], "t[]": ["text"] }[alt];
}
function sampleShape(shape) {
  const out = {};
  for (const [k, f] of Object.entries(shape)) if (!k.endsWith("?")) out[k] = sample(f);
  return out;
}

test("initial state is empty, at the genesis hash", () => {
  const s = initialState("exe-1");
  assert.equal(s.execution, "exe-1");
  assert.equal(s.seq, 0);
  assert.equal(s.hash, GENESIS_HASH);
  assert.equal(s.status, "created");
  assert.deepEqual(s.checks, { task: {}, integration: {} });
  assert.equal(typeof REDUCER_VERSION, "number");
});

test("every event type validates and reduces, and each advances seq and hash", () => {
  let state = initialState("exe-test");
  const resolved = { contract: makeContract({ id: "x", version: 1 }) };
  for (const type of EVENT_TYPES) {
    const draft = validateDraft({ type, source: { kind: "runner", id: "runner", pid: 1 }, payload: sample(PAYLOAD_SPECS[type]) });
    const e = ev(type, draft.payload);
    state = apply(state, e, type === "contract.frozen" || type === "contract.amended" ? resolved : {});
    assert.equal(state.seq, e.seq, type);
    assert.equal(state.hash, e.hash, type);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, "the state holds no undefined values");
});

test("unknown types throw, and apply leaves its input untouched", () => {
  const s = initialState("exe-test");
  const before = structuredClone(s);
  assert.throws(() => apply(s, ev("task.exploded", {})), /unknown event type "task\.exploded"/);
  assert.throws(() => apply(s, ev("constructor", {})), /unknown event type/);
  const after = apply(s, ev("execution.started", {}));
  assert.equal(after.status, "running");
  assert.deepEqual(s, before);
  assert.equal(applyInPlace(s, ev("execution.failed", { reason: "x" })), s);
  assert.equal(s.status, "failed");
});

test("contract.frozen needs the resolved contract, matching its id and version", () => {
  const s = initialState("exe-test");
  const frozen = ev("contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "sha256:x" });
  assert.equal(contractBlobRef(frozen), "sha256:x");
  assert.equal(contractBlobRef(ev("contract.proposed", { blob: "sha256:y" })), undefined);
  assert.throws(() => apply(s, frozen), /was not resolved/);
  assert.throws(() => apply(s, frozen, { contract: makeContract({ version: 2 }) }), /holds "ctr-abc123-1" v2/);
  assert.throws(() => apply(s, frozen, { contract: { ...makeContract(), schema: "other" } }), /not a roundtable\.contract\/1 contract/);
  const ok = apply(s, frozen, { contract: makeContract() });
  assert.equal(ok.contract.status, "frozen");
  assert.deepEqual(ok.contract.frozen, { by: "main", at: frozen.ts, hash: "h" });
});

test("the scripted run produces the expected blackboard", async () => {
  const store = await newStore();
  const { seqs, blob } = await runScript(store);
  const s = await store.state();

  // Contract, goal, teams, interfaces, decisions
  assert.equal(s.contract.id, CONTRACT_ID);
  assert.equal(s.contract.status, "frozen");
  assert.equal(s.contract.frozen.by, "main");
  assert.equal(s.goal.ultimate, "Ship the nav bar");
  assert.deepEqual(s.teams.core, { lead: "w1", members: ["w1"] });
  assert.deepEqual(s.teams.ui, { members: ["w2"] });
  assert.equal(s.interfaces.NavProps.version, 0);
  assert.deepEqual(s.decisions.map((d) => d.id), ["d0", "d1"]);
  assert.equal(s.status, "running");

  // Tasks: a merged and accepted, b ready because its only dep is accepted
  assert.equal(s.tasks.a.state, "accepted");
  assert.equal(s.tasks.a.accepted_seq, seqs.merged);
  assert.equal(s.tasks.a.attempt, 1);
  assert.equal(s.tasks.a.last_commit, "c2");
  assert.equal(s.tasks.a.percent, 50);
  assert.equal(s.tasks.b.state, "ready");
  assert.deepEqual(s.claims, {}, "the merged task's claim is dropped");

  // Leases: L1 granted then expired; R1 still queued but no longer blocked
  assert.deepEqual(s.leases, {});
  assert.equal(s.lease_queue.length, 1);
  assert.equal(s.lease_queue[0].id, "R1");
  assert.equal(s.lease_queue[0].requested_seq, seqs.queued);
  assert.deepEqual(s.lease_queue[0].blocking, []);

  // Diffs, files, checks
  assert.deepEqual(s.diffs.a, { stat: "1 file changed", blob, commit: "c2" });
  assert.deepEqual(s.files["src/a/x.ts"], { task: "a", agent: "w1", last_commit: "c2", merged: true, at_seq: seqs.submitted2 });
  const check = s.checks.task[checkKey("task", "test", "a")];
  assert.equal(checkKey("task", "test", "a"), "a/test");
  assert.equal(check.status, "failed");
  assert.equal(check.signature, "sig-1");
  assert.equal(check.streak, 0, "the second submit reset the streak");
  assert.equal(check.since_patch_seq, seqs.submitted2);

  // Budget
  assert.equal(s.budget.spent_usd, 0.75);
  assert.equal(s.budget.estimated, true);
  assert.deepEqual(s.budget.by_agent, { w1: 0.25 });
  assert.deepEqual(s.budget.by_task, { a: 0.25 });
  assert.deepEqual(s.budget.by_team, { core: 0.25 });

  // Inbox: the contract-wide decision reaches both agents; the directive to team core only w1
  assert.deepEqual(s.inbox.w1, [
    { seq: seqs.decision, kind: "decision", id: "d1", text: "Use flexbox" },
    { seq: seqs.directive, kind: "directive", id: "dir1", text: "Re-read the contract", requires_ack: false },
  ]);
  assert.deepEqual(s.inbox.w2, [{ seq: seqs.decision, kind: "decision", id: "d1", text: "Use flexbox" }]);

  // Escalation raised (raised_seq set by the reducer) and resolved
  assert.equal(s.escalations.E1.raised_seq, seqs.raised);
  assert.equal(s.escalations.E1.status, "resolved");
  assert.deepEqual(s.escalations.E1.resolution, { action: "decide", decision: "Use the existing props", by: "main" });

  // A fresh full replay from disk derives exactly the same state
  const replayed = await (await openExecutionStore(store.id)).state();
  assert.deepEqual(replayed, s);
});

test("the check streak counts repeats of one signature and resets on a new signature or a pass", () => {
  const f = (signature) => ["check.failed", { command_id: "lint", scope: "integration", exit: 1, signature }];
  const streak = (steps) => reduce(steps).checks.integration.lint.streak;
  assert.equal(streak([f("A"), f("A"), f("A")]), 3);
  assert.equal(streak([f("A"), f("A"), f("B")]), 1);
  assert.equal(streak([f("A"), ["check.passed", { command_id: "lint", scope: "integration", duration_ms: 5 }], f("A")]), 1);
  assert.equal(streak([f("A"), f("A"), ["check.timed_out", { command_id: "lint", scope: "integration" }]]), 2);
});

test("intermediate task states follow claims, checks, rejections, blocks and retries", () => {
  const c = makeContract();
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 900 }],
  ]);
  assert.equal(s.tasks.a.state, "claimed");
  assert.equal(s.claims.a.ttl_s, 900);
  s = reduce([["task.progress", { task: "a", note: "started" }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
  s = reduce([
    ["task.submitted", { task: "a", commit: "c1", diff_blob: "d", stat: "s", files: [], rewrites: [] }],
    ["check.started", { command_id: "test", scope: "task", task: "a" }],
  ], s);
  assert.equal(s.tasks.a.state, "checking");
  s = reduce([["task.rejected", { task: "a", reasons: ["lint failed", "no lease"] }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
  assert.equal(s.tasks.a.last_note, "lint failed; no lease");
  s = reduce([["task.blocked", { task: "a", escalation: "E1" }]], s);
  assert.deepEqual([s.tasks.a.state, s.tasks.a.blocked_by], ["blocked", { escalation: "E1" }]);
  s = reduce([["task.unblocked", { task: "a" }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
  assert.equal("blocked_by" in s.tasks.a, false);
  s = reduce([["task.failed", { task: "a", why: "crashed" }]], s);
  assert.equal(s.tasks.a.state, "failed");
  assert.deepEqual(s.claims, {});
  s = reduce([["task.retried", { task: "a", attempt: 2, why: "worker died" }]], s);
  assert.deepEqual([s.tasks.a.state, s.tasks.a.attempt, "finished_at" in s.tasks.a], ["ready", 2, false]);
  s = reduce([["task.released", { task: "b", agent: "w2" }], ["task.claimed", { task: "a", agent: "w1", attempt: 2, ttl_s: 0 }], ["task.reassigned", { task: "a", from: "w1", to: "w3" }]], s);
  assert.equal(s.tasks.a.agent, "w3");
  assert.equal(s.claims.a.agent, "w3");
  s = reduce([["task.released", { task: "a", agent: "w3", note: "handing back" }]], s);
  assert.deepEqual([s.tasks.a.state, "agent" in s.tasks.a, s.tasks.a.last_note], ["ready", false, "handing back"]);
  assert.equal(s.tasks.b.state, "pending", "b still waits for a");
});

test("execution pause and resume track status and paused tasks", () => {
  let s = reduce([["execution.started", {}], ["execution.paused", { scope: ["b", "c"], reason: "r" }]]);
  assert.deepEqual([s.status, s.paused_tasks], ["running", ["b", "c"]]);
  s = reduce([["execution.resumed", { scope: ["b"] }]], s);
  assert.deepEqual(s.paused_tasks, ["c"]);
  s = reduce([["execution.paused", { scope: "all", reason: "r" }]], s);
  assert.equal(s.status, "paused");
  s = reduce([["execution.resumed", { scope: "all" }]], s);
  assert.deepEqual([s.status, s.paused_tasks], ["running", []]);
  s = reduce([["execution.completed", { integration_sha: "i" }]], s);
  assert.equal(s.status, "completed");
});

test("an amendment adds tasks, keeps runtime state, and re-gates readiness", () => {
  const v1 = makeContract();
  const v2 = makeContract({ version: 2, tasks: [taskSpec("a", [], { title: "Renamed" }), taskSpec("b", ["a", "c"]), taskSpec("c")] });
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b1" }, { contract: v1 }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 }],
    ["task.merged", { task: "a", integration_sha: "i" }],
  ]);
  assert.equal(s.tasks.b.state, "ready");
  s = reduce([["contract.amended", { contract: CONTRACT_ID, version: 2, patch_blob: "p", reason: "add c", affected_tasks: ["b", "c"], blob: "b2" }, { contract: v2 }]], s);
  assert.equal(s.contract.version, 2);
  assert.equal(s.tasks.a.state, "accepted");
  assert.equal(s.tasks.a.spec.title, "Renamed");
  assert.equal(s.tasks.c.state, "ready");
  assert.equal(s.tasks.b.state, "pending", "b now also waits for c");
  s = reduce([["task.accepted", { task: "c" }]], s);
  assert.equal(s.tasks.b.state, "ready");
  s = reduce([["contract.superseded", { contract: CONTRACT_ID, by_contract: "ctr-abc123-2" }]], s);
  assert.equal(s.contract.status, "superseded");
});

test("a split hands the task's dependents to its parts", () => {
  const c = makeContract({ tasks: [taskSpec("a"), taskSpec("b", ["a"])] });
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }],
    ["task.split", { task: "a", into: [taskSpec("a1"), taskSpec("a2", ["a1"])] }],
  ]);
  assert.equal(s.tasks.a.state, "cancelled");
  assert.match(s.tasks.a.last_note, /split into a1, a2/);
  assert.deepEqual(s.tasks.b.spec.depends_on, ["a1", "a2"]);
  assert.deepEqual([s.tasks.a1.state, s.tasks.a2.state], ["ready", "pending"]);
  s = reduce([["task.accepted", { task: "a1" }]], s);
  assert.deepEqual([s.tasks.a2.state, s.tasks.b.state], ["ready", "pending"]);
});

test("escalations, huddles, circuits and deadlocks", () => {
  const esc = { id: "E2", agent: "w1", kind: "conflict", with: "path_owner", summary: "s", blocking: false, status: "resolved", raised_seq: 99 };
  let s = reduce([
    ["escalation.raised", { escalation: esc }],
    ["escalation.routed", { id: "E2", to: "runner", format: "micro", wake: false }],
    ["huddle.started", { id: "H1", escalation: "E2", format: "micro", seats: ["w1", "w2"] }],
    ["huddle.concluded", { id: "H1", outcome: "AGREED", decision: "w2 owns it" }],
    ["escalation.awaiting_human", { id: "E2", class: "money", message: "budget" }],
    ["watchdog.circuit_opened", { driver: "codex", reason: "429", until: "2026-10-15T01:00:00Z" }],
    ["watchdog.deadlock_detected", { cycle: ["a", "b"] }],
    ["budget.threshold_crossed", { pct: 80, spent_usd: 8, budget_usd: 10 }],
    ["budget.threshold_crossed", { pct: 50, spent_usd: 5, budget_usd: 10 }],
    ["budget.extended", { by: "main", usd: 2 }],
  ]);
  assert.equal(s.escalations.E2.raised_seq, 1, "raised_seq comes from the event, not the payload");
  assert.equal(s.escalations.E2.routed_to, "runner");
  assert.equal(s.escalations.E2.huddle, "H1");
  assert.equal(s.escalations.E2.status, "awaiting_human");
  assert.equal(s.escalations.E2.emergency, "money");
  assert.deepEqual(s.huddles.H1, { escalation: "E2", format: "micro", seats: ["w1", "w2"], outcome: "AGREED", decision: "w2 owns it" });
  assert.deepEqual(s.watchdog.circuits.codex, { open: true, until: "2026-10-15T01:00:00Z", reason: "429" });
  assert.deepEqual(s.watchdog.deadlocks, [["a", "b"]]);
  assert.deepEqual(s.budget.thresholds_crossed, [50, 80]);
  assert.equal(s.budget.extensions_usd, 2);
  s = reduce([["watchdog.circuit_closed", { driver: "codex" }], ["escalation.withdrawn", { id: "E2", reason: "moot" }]], s);
  assert.deepEqual(s.watchdog.circuits.codex, { open: false, until: "2026-10-15T01:00:00Z" }, "the last open period is kept");
  assert.equal(s.escalations.E2.status, "withdrawn");
  s = reduce([["escalation.raised", { escalation: { ...esc, id: "E3" } }], ["escalation.auto_resolved", { id: "E3", rule: "dead_leaseholder" }]], s);
  assert.deepEqual(s.escalations.E3.resolution, { action: "decide", decision: "dead_leaseholder", by: "runner" });
});

test("ids such as constructor are stored as plain keys; __proto__ is not a task id", () => {
  const frozen = (c) => ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }];
  assert.throws(() => reduce([frozen(makeContract({ tasks: [taskSpec("__proto__")] }))]), /tasks\[0\]\.id is not a valid task id/);
  const c = makeContract({ tasks: [taskSpec("constructor"), taskSpec("prototype", ["constructor"])] });
  let s = reduce([frozen(c)]);
  assert.equal(s.tasks.constructor.state, "ready");
  assert.equal(Object.getPrototypeOf(s.tasks), Object.prototype);
  s = reduce([["task.accepted", { task: "constructor" }], ["task.claimed", { task: "tostring", agent: "w", attempt: 1, ttl_s: 0 }]], s);
  assert.equal(s.tasks.prototype.state, "ready");
  s = reduce([["agent.registered", { agent: "__proto__", persona: "p", driver: "external", token_sha256: "t", external: true }]], s);
  assert.equal(Object.hasOwn(s.agents, "__proto__"), true, "agent ids are stored as own keys");
  assert.equal(Object.getPrototypeOf(s.agents), Object.prototype);
  assert.equal({}.persona, undefined, "Object.prototype is untouched");
});

// ---------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------

const frozenEvent = (blob = "b") => ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob }];

test("a contract adoptContract cannot reduce is rejected, with the field named", () => {
  const bad = [
    [{ teams: {} }, /teams is not an array/],
    [{ interfaces: [null] }, /interfaces\[0\] has no name/],
    [{ decisions: [{ id: "d" }] }, /decisions\[0\] has no id or text/],
    [{ teams: [{ lead: "w1", members: [] }] }, /teams\[0\] has no id/],
    [{ teams: [{ id: "t", members: "w1" }] }, /teams\[0\]\.members/],
    [{ tasks: [taskSpec("a"), taskSpec("a")] }, /task id a appears twice/],
    [{ tasks: [{ ...taskSpec("a"), depends_on: "b" }] }, /tasks\[0\]\.depends_on/],
    [{ goal: null }, /goal is not an object/],
    [{ frozen: "yes" }, /frozen is not/],
  ];
  for (const [over, re] of bad) {
    const [type, payload] = frozenEvent();
    assert.throws(() => apply(initialState("exe-test"), ev(type, payload), { contract: makeContract(over) }), re, JSON.stringify(over));
  }
});

test("a malformed contract blob is refused before anything is written", async () => {
  const { scrubbedJSON } = await import("../../dist/execution/blobs.js");
  for (const over of [{ teams: {} }, { interfaces: [null] }, { teams: [{ lead: "w1", members: [] }] }]) {
    const store = await newStore();
    const blob = await store.putBlob(scrubbedJSON(makeContract(over)), { redact: false });
    const [type, payload] = frozenEvent(blob);
    await assert.rejects(store.transact(() => ({ events: [{ type, payload, source: { kind: "orchestrator", id: "main", pid: 1 } }] })));
    assert.equal((await store.state()).seq, 0, JSON.stringify(over));
    assert.deepEqual(await store.verify(), { ok: true, seq: 0 });
    assert.equal((await (await openExecutionStore(store.id)).state()).seq, 0, "the log still replays");
  }
});

test("finished tasks are not resurrected: refused at write time, ignored on replay", async () => {
  const c = makeContract();
  const base = reduce([[...frozenEvent(), { contract: c }], ["task.cancelled", { task: "a", why: "dropped" }], ["task.failed", { task: "b", why: "broken" }]]);
  const late = [
    ["task.submitted", { task: "a", commit: "c", diff_blob: "d", stat: "s", files: ["x"], rewrites: [] }],
    ["task.merged", { task: "a", integration_sha: "i" }],
    ["task.accepted", { task: "a" }],
    ["task.merged", { task: "b", integration_sha: "i" }],
    ["task.accepted", { task: "b" }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 2, ttl_s: 0 }],
    ["task.progress", { task: "zzz", note: "unknown task" }],
  ];
  for (const [type, payload] of late) {
    seq = base.seq;
    const e = ev(type, payload);
    assert.throws(() => apply(base, e, {}, { strict: true }), /already (cancelled|failed)|unknown task/, type);
    const after = apply(base, e);
    assert.deepEqual([after.tasks.a.state, after.tasks.b.state], ["cancelled", "failed"], `${type} is ignored on replay`);
  }
  // A failed task may still be retried or cancelled.
  seq = base.seq;
  assert.equal(apply(base, ev("task.retried", { task: "b", attempt: 2, why: "again" }), {}, { strict: true }).tasks.b.state, "ready");
  assert.equal(apply(base, ev("task.cancelled", { task: "b", why: "give up" }), {}, { strict: true }).tasks.b.state, "cancelled");

  // Through the store: the refusal happens before append.
  const store = await newStore();
  const { scrubbedJSON } = await import("../../dist/execution/blobs.js");
  const blob = await store.putBlob(scrubbedJSON(c), { redact: false });
  const src = { kind: "runner", id: "runner", pid: 1 };
  await store.transact(() => ({ events: [{ type: "contract.frozen", payload: { ...frozenEvent()[1], blob }, source: src }, { type: "task.cancelled", payload: { task: "a", why: "x" }, source: src }] }));
  await assert.rejects(store.transact(() => ({ events: [{ type: "task.merged", payload: { task: "a", integration_sha: "i" }, source: src }] })), /task a is already cancelled/);
  const s = await store.state();
  assert.deepEqual([s.seq, s.tasks.a.state, s.tasks.b.state], [2, "cancelled", "pending"]);
});

test("a split survives later amendments: dependents keep depending on the parts", () => {
  const v1 = makeContract({ tasks: [taskSpec("a"), taskSpec("b", ["a"])] });
  const v2 = makeContract({ version: 2, tasks: [taskSpec("a"), taskSpec("b", ["a"]), taskSpec("c")] });
  let s = reduce([
    [...frozenEvent(), { contract: v1 }],
    ["task.split", { task: "a", into: [taskSpec("a1"), taskSpec("a2")] }],
    ["contract.amended", { contract: CONTRACT_ID, version: 2, patch_blob: "p", reason: "add c", affected_tasks: ["c"], blob: "b2" }, { contract: v2 }],
  ]);
  assert.deepEqual(s.splits, { a: ["a1", "a2"] });
  assert.deepEqual(s.tasks.b.spec.depends_on, ["a1", "a2"]);
  assert.equal(s.tasks.a.state, "cancelled", "the split task stays cancelled");
  s = reduce([["task.accepted", { task: "a1" }], ["task.accepted", { task: "a2" }]], s);
  assert.equal(s.tasks.b.state, "ready");
  // Nested splits expand all the way down.
  s = reduce([["task.split", { task: "c", into: [taskSpec("c1"), taskSpec("c2")] }], ["task.split", { task: "c1", into: [taskSpec("c1x")] }]], s);
  const v3 = makeContract({ version: 3, tasks: [taskSpec("d", ["a", "c"])] });
  s = reduce([["contract.amended", { contract: CONTRACT_ID, version: 3, patch_blob: "p", reason: "add d", affected_tasks: ["d"], blob: "b3" }, { contract: v3 }]], s);
  assert.deepEqual(s.tasks.d.spec.depends_on, ["a1", "a2", "c1x", "c2"]);
  assert.throws(() => apply(s, ev("task.split", { task: "d", into: [taskSpec("a1")] }), {}, { strict: true }), /part a1 is already a task/);
});

test("an amended contract is marked frozen, keeping the freeze record", () => {
  const v2 = makeContract({ version: 2, status: "consenting" });
  const s = reduce([
    [...frozenEvent(), { contract: makeContract() }],
    ["contract.amended", { contract: CONTRACT_ID, version: 2, patch_blob: "p", reason: "r", affected_tasks: [], blob: "b2" }, { contract: v2 }],
  ]);
  assert.equal(s.contract.version, 2);
  assert.equal(s.contract.status, "frozen");
  assert.equal(s.contract.frozen.by, "main");
});

test("a submit resets only its own task's check streaks", () => {
  const c = makeContract({ tasks: [taskSpec("a"), taskSpec("a.b")] });
  const fail = (task) => ["check.failed", { command_id: "test", scope: "task", task, exit: 1, signature: "S" }];
  const s = reduce([
    [...frozenEvent(), { contract: c }],
    fail("a"), fail("a"), fail("a.b"), fail("a.b"),
    ["task.submitted", { task: "a", commit: "c", diff_blob: "d", stat: "s", files: [], rewrites: [] }],
  ]);
  assert.equal(s.checks.task["a/test"].streak, 0);
  assert.equal(s.checks.task["a.b/test"].streak, 2);
});

test("resubmitting the same diff is no patch: the streak keeps counting", () => {
  const c = makeContract({ tasks: [taskSpec("a")] });
  const fail = ["check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: "S" }];
  const submit = (diff_blob) => ["task.submitted", { task: "a", commit: "c", diff_blob, stat: "s", files: [], rewrites: [] }];
  const s = reduce([[...frozenEvent(), { contract: c }], submit("d1"), fail, submit("d1"), fail, submit("d1"), fail]);
  assert.equal(s.checks.task["a/test"].streak, 3);
  const patched = reduce([submit("d2"), fail], s);
  assert.equal(patched.checks.task["a/test"].streak, 1, "a different diff resets it");
});

test("threshold crossings are recorded per budget total; circuits keep their open count", () => {
  let s = reduce([
    ["budget.threshold_crossed", { pct: 50, spent_usd: 55, budget_usd: 100 }],
    ["budget.threshold_crossed", { pct: 80, spent_usd: 85, budget_usd: 100 }],
  ]);
  assert.deepEqual([s.budget.thresholds_crossed, s.budget.thresholds_budget_usd], [[50, 80], 100]);
  s = reduce([["budget.threshold_crossed", { pct: 50, spent_usd: 105, budget_usd: 200 }]], s);
  assert.deepEqual([s.budget.thresholds_crossed, s.budget.thresholds_budget_usd], [[50], 200]);
  s = reduce([["watchdog.circuit_opened", { driver: "codex", reason: "429", until: "2026-10-15T01:00:00Z", opens: 2 }]], s);
  assert.deepEqual(s.watchdog.circuits.codex, { open: true, until: "2026-10-15T01:00:00Z", reason: "429", opens: 2 });
});

test("blocked_by.needs follows dependency.requested and dependency.satisfied; task.blocked keeps the other reasons", () => {
  const c = makeContract();
  const need = (ref, kind = "interface") => ({ task: "a", need: { kind, ref } });
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 900 }],
    ["dependency.requested", need("NavProps")],
    ["task.blocked", { task: "a" }],
    ["dependency.requested", need("Theme", "artifact")],
    ["task.blocked", { task: "a" }],
    ["dependency.requested", { task: "a", need: { kind: "task", ref: "b" } }],
    ["task.blocked", { task: "a", deps: ["b"] }],
  ]);
  assert.deepEqual(s.tasks.a.blocked_by, { deps: ["b"], needs: [{ kind: "interface", ref: "NavProps" }, { kind: "artifact", ref: "Theme" }] }, "task needs are deps");
  s = reduce([["task.blocked", { task: "a", escalation: "E1" }], ["dependency.requested", need("NavProps")]], s);
  assert.deepEqual(s.tasks.a.blocked_by, { escalation: "E1", deps: ["b"], needs: [{ kind: "interface", ref: "NavProps" }, { kind: "artifact", ref: "Theme" }] }, "kept, and no duplicate need");
  s = reduce([["dependency.satisfied", { ...need("NavProps"), by_event: "evt-x" }], ["dependency.satisfied", { ...need("Theme", "artifact"), by_event: "evt-y" }]], s);
  assert.deepEqual([s.tasks.a.state, s.tasks.a.blocked_by], ["blocked", { escalation: "E1", deps: ["b"] }], "satisfying needs never unblocks by itself");
  s = reduce([["task.unblocked", { task: "a", escalation: "E1" }]], s);
  assert.equal(s.tasks.a.state, "blocked", "unblocking an escalation preserves the dependency");
  assert.deepEqual(s.tasks.a.blocked_by, { deps: ["b"] });
  s = reduce([["task.accepted", { task: "b" }], ["task.unblocked", { task: "a" }], ["dependency.requested", need("NavProps")], ["dependency.satisfied", { ...need("NavProps"), by_event: "evt-z" }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
  assert.equal("blocked_by" in s.tasks.a, false, "an unblocked task drops an emptied blocked_by");
});

test("checks and task.checks_passed bound to an older submission change nothing", () => {
  const c = makeContract();
  const sub = (commit) => ["task.submitted", { task: "a", commit, diff_blob: `d-${commit}`, stat: "s", files: [], rewrites: [] }];
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 900 }],
    sub("c1"),
  ]);
  const first = s.tasks.a.submitted_seq;
  s = reduce([["check.started", { command_id: "test", scope: "task", task: "a", commit: "c1", submitted_seq: first }], sub("c2")], s);
  const second = s.tasks.a.submitted_seq;
  s = reduce([["check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: "sig", commit: "c2", submitted_seq: second }]], s);
  const before = structuredClone(s.checks.task);
  s = reduce([
    ["check.passed", { command_id: "test", scope: "task", task: "a", duration_ms: 1, commit: "c1", submitted_seq: first }],
    ["check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: "sig", commit: "c1", submitted_seq: first }],
  ], s);
  assert.deepEqual(s.checks.task, before, "the stale checks are ignored");
  const stale = ev("task.checks_passed", { task: "a", commands: ["test"], commit: "c1", submitted_seq: first });
  assert.throws(() => apply(s, stale, {}, { strict: true }), /not its latest/);
  assert.equal(apply(s, stale).tasks.a.state, "submitted", "replay ignores it");
  const wrongCommit = ev("task.checks_passed", { task: "a", commands: ["test"], commit: "c1", submitted_seq: second });
  assert.throws(() => apply(s, wrongCommit, {}, { strict: true }), /not its latest/);
  const rejected = reduce([["task.rejected", { task: "a", reasons: ["test failed"] }]], s);
  assert.throws(() => apply(rejected, ev("task.checks_passed", { task: "a", commands: ["test"], commit: "c2", submitted_seq: second }), {}, { strict: true }), /in_progress, not checking/);
  assert.equal(apply(s, ev("task.checks_passed", { task: "a", commands: ["test"], commit: "c2", submitted_seq: second }), {}, { strict: true }).tasks.a.state, "merging");
  assert.equal(apply(rejected, ev("task.checks_passed", { task: "a", commands: ["test"] })).tasks.a.state, "merging", "an unbound one is unchanged");
});

test("v10 dissent reducer retains first firing per task and latest advisory score across amendments and replay", async () => {
  assert.equal(REDUCER_VERSION, 10);
  const { readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { canonicalJSON, sha256Hex } = await import("../../dist/execution/chain.js");
  const store = await newStore();
  const spec = { id: "risk", by: "critic", source: { kind: "manual" }, claim: "Risk", predicted_failure: "Failure", tripwire: { kind: "task_state", task: "a", state: "rejected" }, on_fire: "notify" };
  const contract = makeContract({ dissents: [spec] });
  const blob = await store.putBlob(JSON.stringify(contract));
  const source = { kind: "runner", id: "runner", pid: 1 };
  const emit = (type, payload) => store.transact(() => ({ events: [{ type, payload, source }] }));
  await emit("contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob });
  await emit("task.rejected", { task: "a", reasons: ["check failure"] });
  const rejectionSeq = (await store.state()).tasks.a.rejected_seq;
  const firing = { dissent_id: "risk", task: "a", tripped_by: "worker", evidence: "first evidence" };
  await emit("dissent.tripwire_fired", firing);
  const firedSeq = (await store.state()).seq;
  await emit("dissent.tripwire_fired", { ...firing, evidence: "duplicate" });
  await emit("dissent.scored", { dissent_id: "risk", outcome: "vindicated" });
  await store.writeSnapshot();
  const snapshot = join(store.dir, "snapshot.json");
  assert.equal(JSON.parse(readFileSync(snapshot, "utf8")).reducer_version, 10);
  await emit("dissent.scored", { dissent_id: "risk", outcome: "untested" });
  const amended = { ...contract, version: 2, dissents: [{ ...spec, claim: "Refined concern" }] };
  await emit("contract.amended", { contract: CONTRACT_ID, version: 2, patch_blob: "patch", reason: "refine", affected_tasks: [], blob: await store.putBlob(JSON.stringify(amended)) });
  const state = await store.state();
  assert.equal(state.tasks.a.rejected_seq, rejectionSeq);
  assert.deepEqual(state.dissents.risk.fires, { "tripwire:risk:a": { ...firing, seq: firedSeq } });
  assert.equal(state.dissents.risk.score, "untested");
  assert.equal(state.dissents.risk.spec.claim, "Refined concern");
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
  // An authentic v6 snapshot must be ignored, even when its state digest is valid.
  const old = JSON.parse(readFileSync(snapshot, "utf8"));
  old.reducer_version = 6;
  delete old.state.dissents;
  delete old.state.tasks.a.rejected_seq;
  old.state_sha256 = sha256Hex(canonicalJSON(old.state));
  writeFileSync(snapshot, JSON.stringify(old));
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
  rmSync(snapshot);
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});

for (const action of ["retry", "reassign"]) {
  for (const otherHold of [false, true]) {
    test(`v10 replays historical ${action} without task.unblocked (${otherHold ? "another hold remains" : "replacement can start"})`, async () => {
      const { blockingIds, taskHeld } = await import("../../dist/execution/task-holds.js");
      const { readFileSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { canonicalJSON, sha256Hex } = await import("../../dist/execution/chain.js");
      const states = [];
      for (const explicitUnblock of [false, true]) {
        const store = await newStore();
        const c = makeContract({ tasks: [taskSpec("a")] });
        const source = { kind: "runner", id: "runner", pid: 1 };
        const emit = (events) => store.transact(() => ({ events: events.map(([type, payload]) => ({ type, payload, source })) }));
        const raise = (id) => ["escalation.raised", { escalation: { id, task: "a", agent: "critic", kind: "assistance", with: "orchestrator", summary: "Risk", blocking: true, dissent_id: id, status: "open", raised_seq: 0 } }];
        await emit([
          [...frozenEvent(await store.putBlob(JSON.stringify(c)))],
          ["execution.paused", { scope: "all", reason: "Stopped before replacement claim" }],
          raise("first"), ["task.blocked", { task: "a", escalation: "first" }],
          ...(otherHold ? [raise("second"), ["task.blocked", { task: "a", escalation: "second", deps: ["external"] }],
            ["dependency.requested", { task: "a", need: { kind: "interface", ref: "Api" } }]] : []),
        ]);
        if (action === "reassign") {
          const changed = { ...c, version: 2, tasks: [{ ...c.tasks[0], persona: "replacement" }] };
          await emit([["contract.amended", { contract: c.id, version: 2, blob: await store.putBlob(JSON.stringify(changed)), patch_blob: "patch", reason: "Reassign", affected_tasks: ["a"] }]]);
        }
        await emit([
          ["task.retried", { task: "a", attempt: 2, why: action }],
          ["escalation.resolved", { id: "first", action, decision: "Try again", by: "main" }],
          ...(explicitUnblock ? [["task.unblocked", { task: "a", escalation: "first" }]] : []),
        ]);
        const state = await store.state();
        assert.equal(state.status, "paused");
        assert.equal(state.tasks.a.state, otherHold ? "blocked" : "ready");
        assert.equal(state.tasks.a.attempt, 2);
        assert.equal(state.claims.a, undefined);
        assert.equal(taskHeld(state, "a"), otherHold);
        assert.deepEqual(blockingIds(state.tasks.a), otherHold ? ["second"] : []);
        if (otherHold) assert.deepEqual(state.tasks.a.blocked_by, { escalation: "second", deps: ["external"], needs: [{ kind: "interface", ref: "Api" }] });
        states.push({ tasks: state.tasks, claims: state.claims, escalations: state.escalations, status: state.status });
        assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
        // A valid v7 snapshot can contain the stranded hold; the version bump must force replay.
        await store.writeSnapshot();
        const path = join(store.dir, "snapshot.json");
        const stale = JSON.parse(readFileSync(path, "utf8"));
        stale.reducer_version = 7;
        stale.state.tasks.a.state = "blocked";
        stale.state.tasks.a.blocked_by = { escalation: "first" };
        stale.state_sha256 = sha256Hex(canonicalJSON(stale.state));
        writeFileSync(path, JSON.stringify(stale));
        assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
      }
      assert.deepEqual(states[0], states[1], "historical and explicit-unblock logs derive identical runtime projections");
    });
  }
}

test("dissent events reject invalid scores and missing evidence and safely reduce prototype-like ids", () => {
  const source = { kind: "runner", id: "runner", pid: 1 };
  assert.throws(() => validateDraft({ type: "dissent.scored", source, payload: { dissent_id: "risk", outcome: "trusted" } }), /outcome/);
  assert.throws(() => validateDraft({ type: "dissent.tripwire_fired", source, payload: { dissent_id: "risk", tripped_by: "worker" } }), /evidence/);
  const s = reduce([
    ["dissent.tripwire_fired", { dissent_id: "constructor", tripped_by: "worker", evidence: "failed" }],
    ["dissent.scored", { dissent_id: "constructor", outcome: "refuted" }],
  ]);
  assert.equal(s.dissents.constructor.score, "refuted");
  assert.equal(Object.keys(s.dissents.constructor.fires).length, 1);
  assert.deepEqual(s, JSON.parse(JSON.stringify(s)));
});
