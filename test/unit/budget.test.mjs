import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDrafts, claim, contract, escalations, eventTypes, makeState, ofType, opsOf, task } from "../fixtures/execution-state.mjs";

const { remainingUsd, thresholdCrossings, budgetRules, executionBudgetUsd, spentPct } = await import("../../dist/execution/budget.js");
const { actionsToDrafts } = await import("../../dist/execution/watchdog-actions.js");

const settle = (state, actions) => applyDrafts(state, actionsToDrafts(actions));

// ---------------------------------------------------------------------------
// Remaining budget
// ---------------------------------------------------------------------------

test("remainingUsd is the smallest of execution, task and agent remaining, never negative", () => {
  const cases = [
    { name: "execution only", budget: { spent_usd: 30 }, scope: {}, want: 70 },
    { name: "task cap binds", budget: { spent_usd: 30, by_task: { t: 15 } }, scope: { task: "t" }, want: 5 },
    { name: "spec budget_usd overrides per_task_usd", budget: { spent_usd: 30, by_task: { big: 15 } }, scope: { task: "big" }, want: 35 },
    { name: "agent cap binds", per_agent: 10, budget: { spent_usd: 30, by_agent: { a: 8 } }, scope: { task: "t", agent: "a" }, want: 2 },
    { name: "an extension raises the execution total", budget: { spent_usd: 95, extensions_usd: 50 }, scope: {}, want: 55 },
    { name: "overspent", budget: { spent_usd: 130 }, scope: {}, want: 0 },
    { name: "an unknown task gets the per-task cap", budget: { spent_usd: 0 }, scope: { task: "nope" }, want: 20 },
  ];
  for (const c of cases) {
    const s = makeState({
      tasks: [task("t"), task("big", { spec: { budget_usd: 50 } })],
      contract: contract({ budget: c.per_agent ? { per_agent_usd: c.per_agent } : {} }),
      budget: c.budget,
    });
    assert.equal(remainingUsd(s, c.scope), c.want, c.name);
  }
  assert.equal(remainingUsd(makeState({ contract: null })), 0, "no contract: fail closed");
  const s = makeState({ budget: { spent_usd: 0.1 + 0.2 } });
  assert.equal(remainingUsd(s), 99.7, "rounded");
  assert.equal(executionBudgetUsd(makeState({ budget: { extensions_usd: 25 } })), 125);
  assert.equal(spentPct(makeState({ budget: { spent_usd: 40 } })), 40);
});

test("thresholdCrossings reports the 50/80/100 thresholds reached and not yet recorded", () => {
  const cases = [
    [49.99, [], []],
    [50, [], [50]],
    [85, [], [50, 80]],
    [85, [50], [80]],
    [100, [], [50, 80, 100]],
    [120, [50, 80, 100], []],
  ];
  for (const [spent, crossed, want] of cases) {
    const s = makeState({ budget: { spent_usd: spent, thresholds_crossed: crossed } });
    assert.deepEqual(thresholdCrossings(s), want, `${spent} with ${crossed}`);
  }
  // Percent of the extended total.
  assert.deepEqual(thresholdCrossings(makeState({ budget: { spent_usd: 100, extensions_usd: 100 } })), [50]);
  assert.deepEqual(thresholdCrossings(makeState({ contract: null, budget: { spent_usd: 100 } })), []);
});

// ---------------------------------------------------------------------------
// Budget rules
// ---------------------------------------------------------------------------

test("budget: 50% records the threshold only", () => {
  const s = makeState({ budget: { spent_usd: 55 } });
  const actions = budgetRules(s);
  assert.deepEqual(eventTypes(actions), ["budget.threshold_crossed"]);
  assert.deepEqual(ofType(actions, "budget.threshold_crossed")[0].payload, { pct: 50, spent_usd: 55, budget_usd: 100 });
  assert.deepEqual(opsOf(actions), []);
  assert.deepEqual(budgetRules(settle(s, actions)), []);
});

test("budget: 80% records the threshold and wakes the orchestrator", () => {
  const s = makeState({ budget: { spent_usd: 81, thresholds_crossed: [50], estimated: true } });
  const actions = budgetRules(s);
  assert.deepEqual(eventTypes(actions), ["budget.threshold_crossed"]);
  const [wake] = opsOf(actions);
  assert.equal(wake.type, "wake_orchestrator");
  assert.equal(wake.orchestrator, "main");
  assert.match(wake.reason, /\$81\.00 of its \$100\.00 budget \(partly estimated\)/);
  assert.deepEqual(budgetRules(settle(s, actions)), []);
});

test("budget: 100% exhausts the run, stops spawning and awaits the human (money)", () => {
  const s = makeState({ budget: { spent_usd: 100.5, thresholds_crossed: [50, 80] } });
  const actions = budgetRules(s);
  assert.deepEqual(eventTypes(actions), ["budget.threshold_crossed", "budget.exhausted", "escalation.raised", "escalation.awaiting_human"]);
  assert.deepEqual(ofType(actions, "budget.exhausted")[0].payload, { scope: "execution" });
  const [esc] = escalations(actions);
  assert.equal(esc.kind, "emergency");
  assert.equal(esc.emergency, "money");
  assert.equal(esc.target, "main");
  const [waiting] = ofType(actions, "escalation.awaiting_human");
  assert.equal(waiting.payload.id, esc.id);
  assert.equal(waiting.payload.class, "money");
  assert.match(waiting.payload.message, /\$100\.50 of \$100\.00/);
  assert.ok(waiting.payload.alternatives.some((a) => /Extend the budget/.test(a)));
  assert.deepEqual(opsOf(actions).map((a) => a.type), ["stop_spawning"]);

  const after = settle(s, actions);
  assert.equal(after.escalations[esc.id].status, "awaiting_human");
  assert.deepEqual(budgetRules(after), [], "once");

  // The human extends the budget; spending through the extension escalates again.
  after.budget.extensions_usd = 50;
  assert.deepEqual(budgetRules(after), []);
  after.budget.spent_usd = 150;
  const again = budgetRules(after);
  assert.deepEqual(eventTypes(again), ["budget.exhausted", "escalation.raised", "escalation.awaiting_human"]);
  assert.notEqual(escalations(again)[0].id, esc.id);
});

test("budget: a task at its cap is killed, blocked and escalated as a resource", () => {
  const s = makeState({ tasks: [task("t"), task("big", { spec: { budget_usd: 50 } }), task("done", { state: "accepted" })] });
  claim(s, "t", "w-t");
  s.budget = { ...s.budget, spent_usd: 50, by_task: { t: 20, big: 25, done: 30 } };
  const actions = budgetRules(s);
  assert.deepEqual(eventTypes(actions), ["budget.threshold_crossed", "budget.exhausted", "escalation.raised", "task.blocked"]);
  assert.deepEqual(ofType(actions, "budget.exhausted")[0].payload, { scope: "task", ref: "t" });
  const [esc] = escalations(actions);
  assert.equal(esc.kind, "resource");
  assert.equal(esc.task, "t");
  assert.equal(esc.blocking, true);
  assert.match(esc.summary, /Task t reached its budget cap: \$20\.00 of \$20\.00/);
  assert.deepEqual(opsOf(actions).map((a) => [a.type, a.agent]), [["kill_worker", "w-t"]]);

  const after = settle(s, actions);
  assert.equal(after.tasks.t.state, "blocked");
  assert.deepEqual(budgetRules(after), []);
});

test("budget: an agent at its per-agent cap is escalated; one with nothing left to do is not", () => {
  const s = makeState({ tasks: [task("t"), task("u", { state: "accepted" })], contract: contract({ budget: { per_agent_usd: 5 } }) });
  claim(s, "t", "w-t");
  claim(s, "u", "w-u", { taskState: "accepted", agentOver: { status: "exited" } });
  s.budget = { ...s.budget, spent_usd: 12, by_agent: { "w-t": 6, "w-u": 6 }, by_task: { t: 6, u: 6 } };
  const actions = budgetRules(s);
  assert.deepEqual(ofType(actions, "budget.exhausted").map((e) => e.payload), [{ scope: "agent", ref: "w-t" }]);
  assert.deepEqual(opsOf(actions).map((a) => a.agent), ["w-t"]);
});

test("budget: a cap reached on an already blocked task escalates without replacing its block", () => {
  const s = makeState({ tasks: [task("t", { state: "blocked", blocked_by: { escalation: "esc-first" } })] });
  s.budget = { ...s.budget, spent_usd: 20, by_task: { t: 20 } };
  const actions = budgetRules(s);
  assert.deepEqual(eventTypes(actions), ["budget.exhausted", "escalation.raised"]);
  assert.equal(escalations(actions)[0].blocking, true);
  assert.deepEqual(settle(s, actions).tasks.t.blocked_by, { escalation: "esc-first" });
});
