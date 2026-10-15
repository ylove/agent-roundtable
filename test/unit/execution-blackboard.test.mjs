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
  return { s: "x", t: "text", n: 1, int: 1, b: true, null: null, "s[]": ["x"], "t[]": ["text"] }[alt];
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
  assert.throws(() => apply(s, frozen, { contract: makeContract({ version: 2 }) }), /holds ctr-abc123-1 v2/);
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
  assert.deepEqual(s.files["src/a/x.ts"], { task: "a", agent: "w1", last_commit: "c2", merged: true });
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
  assert.deepEqual(s.watchdog.circuits.codex, { open: false });
  assert.equal(s.escalations.E2.status, "withdrawn");
  s = reduce([["escalation.raised", { escalation: { ...esc, id: "E3" } }], ["escalation.auto_resolved", { id: "E3", rule: "dead_leaseholder" }]], s);
  assert.deepEqual(s.escalations.E3.resolution, { action: "decide", decision: "dead_leaseholder", by: "runner" });
});

test("ids such as constructor and __proto__ are stored as plain keys", () => {
  const c = makeContract({ tasks: [taskSpec("constructor"), taskSpec("__proto__", ["constructor"])] });
  let s = reduce([["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: c }]]);
  assert.equal(s.tasks.constructor.state, "ready");
  assert.equal(Object.getPrototypeOf(s.tasks), Object.prototype);
  assert.equal(Object.hasOwn(s.tasks, "__proto__"), true);
  s = reduce([["task.accepted", { task: "constructor" }], ["task.claimed", { task: "toString", agent: "w", attempt: 1, ttl_s: 0 }]], s);
  assert.equal(s.tasks["__proto__"].state, "ready");
  assert.equal(Object.hasOwn(s.claims, "toString"), false, "unknown tasks are ignored, even inherited names");
  assert.equal({}.state, undefined, "Object.prototype is untouched");
});
