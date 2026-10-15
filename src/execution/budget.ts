// ============================================================================
// Budget: remaining spend for a worker, threshold crossings, and the budget watchdog rules
//
// Pure functions over BlackboardState.budget (the ledger the reducer keeps from
// budget.usage_recorded and budget.extended) and the frozen contract's ContractBudget.
// budget.extended raises the execution total; per-task and per-agent caps change only through
// a contract amendment (TaskSpec.budget_usd, ContractBudget.per_task_usd / per_agent_usd).
// ============================================================================

import type { BlackboardState } from "./types.js";
import {
  TERMINAL_TASK_STATES,
  draft,
  emitAction,
  escalationAction,
  own,
  sortedKeys,
  type WatchdogAction,
} from "./watchdog-actions.js";

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

const EPS = 1e-9;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The execution's total budget: the contract's usd plus every budget.extended. 0 without a contract. */
export function executionBudgetUsd(state: BlackboardState): number {
  return state.contract ? state.contract.budget.usd + state.budget.extensions_usd : 0;
}

/** A task's cap: its spec's budget_usd, else the contract's per_task_usd. */
export function taskCapUsd(state: BlackboardState, task: string): number | undefined {
  if (!state.contract) return undefined;
  return own(state.tasks, task)?.spec.budget_usd ?? state.contract.budget.per_task_usd;
}

export function agentCapUsd(state: BlackboardState): number | undefined {
  return state.contract?.budget.per_agent_usd;
}

/**
 * What may still be spent: min(execution remaining, the task's remaining, the agent's remaining),
 * never below 0. This is the worker's --max-budget-usd. 0 without a contract (fail closed).
 */
export function remainingUsd(state: BlackboardState, scope: { task?: string; agent?: string } = {}): number {
  if (!state.contract) return 0;
  const b = state.budget;
  let rem = executionBudgetUsd(state) - b.spent_usd;
  if (scope.task !== undefined) {
    const cap = taskCapUsd(state, scope.task);
    if (cap !== undefined) rem = Math.min(rem, cap - (own(b.by_task, scope.task) ?? 0));
  }
  if (scope.agent !== undefined) {
    const cap = agentCapUsd(state);
    if (cap !== undefined) rem = Math.min(rem, cap - (own(b.by_agent, scope.agent) ?? 0));
  }
  return Math.max(0, round6(rem));
}

/** Percent of the execution budget spent (0 without a budget). */
export function spentPct(state: BlackboardState): number {
  const total = executionBudgetUsd(state);
  return total > 0 ? (state.budget.spent_usd / total) * 100 : 0;
}

/**
 * The thresholds (50, 80, 100) reached but not yet in thresholds_crossed. Each fires once per
 * run: after a budget.extended the percentage can fall back under a recorded threshold, and it
 * does not fire again (exhaustion of the extended total is still caught by budgetRules).
 */
export function thresholdCrossings(state: BlackboardState): number[] {
  const total = executionBudgetUsd(state);
  if (total <= 0) return [];
  const crossed = state.budget.thresholds_crossed;
  return BUDGET_THRESHOLDS.filter((t) => state.budget.spent_usd + EPS >= (total * t) / 100 && !crossed.includes(t));
}

/**
 * Budget rules:
 *  - budget.threshold_crossed for each new threshold; at 80%, also wake the orchestrator;
 *  - execution budget spent: budget.exhausted, an emergency escalation awaiting the human
 *    (class money), and stop_spawning. Keyed by the total, so an extension that is spent in
 *    turn escalates again;
 *  - a task's (or agent's) cap reached: budget.exhausted {scope, ref}, a resource escalation that
 *    blocks the task, and kill_worker when its worker is running.
 */
export function budgetRules(state: BlackboardState): WatchdogAction[] {
  const c = state.contract;
  if (!c) return [];
  const out: WatchdogAction[] = [];
  const orchestrator = c.scope.orchestrator;
  const total = executionBudgetUsd(state);
  const spent = state.budget.spent_usd;
  const est = state.budget.estimated ? " (partly estimated)" : "";

  for (const pct of thresholdCrossings(state)) {
    const key = `budget:threshold:${pct}`;
    out.push(
      emitAction("budget_threshold", key, "execution", [
        draft("budget.threshold_crossed", { pct, spent_usd: round6(spent), budget_usd: round6(total) }, key),
      ])
    );
    if (pct === 80) {
      out.push({
        type: "wake_orchestrator",
        rule: "budget_threshold",
        key: `${key}:wake`,
        target: orchestrator,
        orchestrator,
        reason: `The run has spent ${usd(spent)} of its ${usd(total)} budget${est}, past 80%.`,
      });
    }
  }

  if (total > 0 && spent + EPS >= total) {
    const message =
      `The execution budget is spent: ${usd(spent)} of ${usd(total)}${est}. ` +
      "No new workers will start until the budget is extended.";
    const esc = escalationAction(state, "budget_exhausted", {
      key: `budget:execution:${round6(total)}`,
      kind: "emergency",
      with: "orchestrator",
      target: orchestrator,
      summary: message,
      emergency: {
        class: "money",
        message,
        alternatives: [
          "Extend the budget, then resume the run",
          "Cancel the remaining tasks and keep what is merged",
          "Abort the run (worktrees and the log are kept)",
        ],
      },
      before: [draft("budget.exhausted", { scope: "execution" })],
    });
    if (esc) {
      out.push(esc, { type: "stop_spawning", rule: "budget_exhausted", key: `${esc.key}:stop`, target: "execution", reason: message });
    }
  }

  const capReached = (scope: "task" | "agent", ref: string, task: string | undefined, agent: string | undefined, used: number, cap: number) => {
    const what = scope === "task" ? `Task ${ref}` : `Agent ${ref}`;
    const esc = escalationAction(state, "budget_cap", {
      key: `budget:${scope}:${ref}:${round6(cap)}`,
      task,
      kind: "resource",
      with: "orchestrator",
      target: orchestrator,
      summary: `${what} reached its budget cap: ${usd(used)} of ${usd(cap)}.`,
      options: ["Raise the cap with amend_contract, then retry", "Split the task", "Cancel the task"],
      block: true,
      before: [draft("budget.exhausted", { scope, ref })],
    });
    if (!esc) return;
    out.push(esc);
    if (agent !== undefined && own(state.agents, agent)?.status === "running") {
      out.push({ type: "kill_worker", rule: "budget_cap", key: `${esc.key}:kill`, target: agent, agent, reason: `${what} reached its budget cap` });
    }
  };

  for (const task of sortedKeys(state.tasks)) {
    const rt = state.tasks[task];
    if (TERMINAL_TASK_STATES.has(rt.state)) continue;
    const cap = taskCapUsd(state, task);
    const used = own(state.budget.by_task, task) ?? 0;
    if (cap === undefined || used + EPS < cap) continue;
    capReached("task", task, task, rt.agent ?? own(state.claims, task)?.agent, used, cap);
  }

  const agentCap = agentCapUsd(state);
  if (agentCap !== undefined) {
    for (const agent of sortedKeys(state.budget.by_agent)) {
      const used = state.budget.by_agent[agent];
      if (used + EPS < agentCap) continue;
      const rec = own(state.agents, agent);
      const rt = own(state.tasks, rec?.task);
      // An agent with nothing left to do (not running, its task finished) needs no escalation.
      if (rec?.status !== "running" && (!rt || TERMINAL_TASK_STATES.has(rt.state))) continue;
      capReached("agent", agent, rec?.task, agent, used, agentCap);
    }
  }
  return out;
}
