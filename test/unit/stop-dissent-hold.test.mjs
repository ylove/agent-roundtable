import { test } from "node:test";
import assert from "node:assert/strict";

const { apply, initialState } = await import("../../dist/execution/blackboard.js");
const { runnerEscalation, runnerEscalationId } = await import("../../dist/execution/runner-hooks.js");
const { CONTRACT_ID, makeContract } = await import("../fixtures/execution/script.mjs");

let seq = 0;
const ev = (type, payload) => ({
  v: 1, id: `evt-${++seq}`, seq, ts: "2026-10-15T00:00:00.000Z", execution: "exe-test", mode: "execution",
  source: { kind: "runner", id: "runner", pid: 1 }, type, payload, prev: "p", hash: `h${seq}`,
});
function reduce(steps, state = initialState("exe-test")) {
  seq = state.seq;
  for (const [type, payload, resolved] of steps) state = apply(state, ev(type, payload), resolved);
  return state;
}

const runner = { kind: "runner", id: "runner", pid: 1 };
function raise(state, key, extra = {}) {
  const drafts = runnerEscalation(state, { key, task: "a", kind: "blocker", summary: "held", block: true }, runner)
    .map((d) => (d.type === "escalation.raised" ? { ...d, payload: { escalation: { ...d.payload.escalation, ...extra } } } : d));
  return reduce(drafts.map((d) => [d.type, d.payload]), state);
}

for (const releaseFirst of ["dissent", "stop"]) test(`a Stop joins a dissent hold exactly once; releasing ${releaseFirst} preserves the other`, () => {
  let s = reduce([
    ["contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h", blob: "b" }, { contract: makeContract() }],
    ["task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 900 }],
    ["task.progress", { task: "a", note: "started" }],
  ]);
  const dissentId = runnerEscalationId("dissent-hold");
  const stopId = runnerEscalationId("agent_stopped:req-1");

  s = raise(s, "dissent-hold", { dissent_id: "risk" });
  assert.deepEqual([s.tasks.a.state, s.tasks.a.blocked_by], ["blocked", { escalation: dissentId }]);

  s = raise(s, "agent_stopped:req-1");
  assert.deepEqual(s.tasks.a.blocked_by.escalations?.slice().sort(), [dissentId, stopId].sort(), "both holds are recorded");
  assert.deepEqual(runnerEscalation(s, { key: "agent_stopped:req-1", task: "a", kind: "blocker", summary: "held", block: true }, runner), [], "replaying the Stop emits no duplicate hold");

  const [firstId, remainingId] = releaseFirst === "dissent" ? [dissentId, stopId] : [stopId, dissentId];
  s = reduce([["escalation.resolved", { id: firstId, action: "decide", decision: "ok", by: "main" }]], s);
  assert.equal(s.tasks.a.state, "blocked", "the other escalation still holds the task");
  assert.equal(s.tasks.a.blocked_by.escalation, remainingId);

  s = reduce([["escalation.resolved", { id: remainingId, action: "decide", decision: "reworked", by: "main" }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
});
