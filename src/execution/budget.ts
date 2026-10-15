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
  escalationId,
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
 * The thresholds (50, 80, 100) reached but not yet recorded for the current total. Each fires
 * once per budget epoch: thresholds_crossed belongs to the total in thresholds_budget_usd, so after
 * a budget.extended the warnings re-arm against the new total.
 */
export function thresholdCrossings(state: BlackboardState): number[] {
  const total = executionBudgetUsd(state);
  if (total <= 0) return [];
  const b = state.budget;
  const crossed = b.thresholds_budget_usd === undefined || b.thresholds_budget_usd === round6(total) ? b.thresholds_crossed : [];
  return BUDGET_THRESHOLDS.filter((t) => state.budget.spent_usd + EPS >= (total * t) / 100 && !crossed.includes(t));
}

/**
 * Budget rules:
 *  - budget.threshold_crossed for each threshold new in this budget epoch; at 80%, also wake the
 *    orchestrator;
 *  - execution budget spent: budget.exhausted and an emergency escalation awaiting the human
 *    (class money), once per total (so an extension that is spent in turn escalates again), and
 *    stop_spawning on every pass while it stays spent (standing after the first);
 *  - a task's (or agent's) cap reached: budget.exhausted {scope, ref} and a resource escalation
 *    that blocks the task, once; kill_worker on every pass while its worker still runs (unless the
 *    runner reports the agent busy).
 */
export function budgetRules(state: BlackboardState, opts: { busy?: ReadonlySet<string> } = {}): WatchdogAction[] {
  const c = state.contract;
  if (!c) return [];
  const out: WatchdogAction[] = [];
  const orchestrator = c.scope.orchestrator;
  const total = executionBudgetUsd(state);
  const spent = state.budget.spent_usd;
  const est = state.budget.estimated ? " (partly estimated)" : "";

  for (const pct of thresholdCrossings(state)) {
    const key = `budget:threshold:${round6(total)}:${pct}`;
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
    const escKey = `budget:execution:${round6(total)}`;
    const esc = escalationAction(state, "budget_exhausted", {
      key: escKey,
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
    if (esc) out.push(esc);
    out.push({
      type: "stop_spawning",
      rule: "budget_exhausted",
      key: `${escalationId(escKey)}:stop`,
      target: "execution",
      reason: message,
      ...(esc ? {} : { standing: true as const }),
    });
  }

  const capReached = (scope: "task" | "agent", ref: string, task: string | undefined, agent: string | undefined, used: number, cap: number) => {
    const what = scope === "task" ? `Task ${ref}` : `Agent ${ref}`;
    const escKey = `budget:${scope}:${ref}:${round6(cap)}`;
    const esc = escalationAction(state, "budget_cap", {
      key: escKey,
      task,
      kind: "resource",
      with: "orchestrator",
      target: orchestrator,
      summary: `${what} reached its budget cap: ${usd(used)} of ${usd(cap)}.`,
      options: ["Raise the cap with amend_contract, then retry", "Split the task", "Cancel the task"],
      block: true,
      before: [draft("budget.exhausted", { scope, ref })],
    });
    if (esc) out.push(esc);
    if (agent !== undefined && own(state.agents, agent)?.status === "running" && !opts.busy?.has(agent)) {
      out.push({
        type: "kill_worker",
        rule: "budget_cap",
        key: `${escalationId(escKey)}:kill`,
        target: agent,
        agent,
        reason: `${what} reached its budget cap`,
        ...(esc ? {} : { standing: true as const }),
      });
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
