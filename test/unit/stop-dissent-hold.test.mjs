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

test("a stop escalation raised on a task a dissent already holds joins the hold and survives its release", () => {
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

  s = reduce([["escalation.resolved", { id: dissentId, action: "decide", decision: "ok", by: "main" }]], s);
  assert.equal(s.tasks.a.state, "blocked", "the stop escalation still holds the task");
  assert.equal(s.tasks.a.blocked_by.escalation, stopId);

  s = reduce([["escalation.resolved", { id: stopId, action: "decide", decision: "reworked", by: "main" }]], s);
  assert.equal(s.tasks.a.state, "in_progress");
});
