// ============================================================================
// Runner hooks: where WS10 (escalation routing, huddles, the lead persona) plugs into the runner
//
// The runner calls them outside transact and never awaits them inside its tick: a hook may make
// LLM calls and take minutes. Every hook must be idempotent: after a crash, a restarted runner
// offers the same open escalation, or the same lead fallback, again. The defaults only log.
// ============================================================================

import { createHash } from "node:crypto";
import type { TaskCardOptions } from "./task-card.js";
import type {
  AnyEventDraft,
  BlackboardState,
  Escalation,
  EscalationDiagnostics,
  EventSource,
  ExecutionHeader,
  WorkerDriver,
  WorkerRecord,
} from "./types.js";
import type { FileExecutionStore } from "./store.js";

/** What a hook can use: the store, the runner's event source, and the worker controls. */
export interface RunnerContext {
  readonly execution: string;
  readonly store: FileExecutionStore;
  readonly header: ExecutionHeader;
  /** Stamp on events the hook writes for the runner ({kind: "runner", id: "runner", pid}). */
  readonly source: EventSource;
  /** One line to the runner log. */
  log(message: string): void;
  /**
   * Start the task's worker again with an immediate context in its card (a resolution, say): a
   * claimed task without a live worker is resumed in its session, a ready task is claimed and
   * started. False when it cannot start now (paused, budget, circuit, a live worker already).
   */
  resumeTask(task: string, immediate?: TaskCardOptions["immediate"]): Promise<boolean>;
  /** The live worker of an agent (for driver.answer in a micro-huddle), if any. */
  worker(agent: string): WorkerRecord | undefined;
  /** The worker driver the run uses. */
  driver(): WorkerDriver;
}

export interface GoalReviewInput {
  integrationSha: string;
  state: Readonly<BlackboardState>;
}

export interface GoalReview {
  verdict: "COMPLETE" | "INCOMPLETE";
  reason?: string;
}

export interface RunnerHooks {
  /**
   * A new escalation that is still open (the watchdog did not resolve it). Called once per
   * escalation per runner process. Routing (watchdog first, micro-huddle, orchestrator with
   * wake, lead fallback, awaiting_human) is WS10's.
   */
  escalationRouter(ctx: RunnerContext, escalation: Escalation): Promise<void>;
  /** The watchdog's lead_fallback for an escalation; obs.leadInFlight is set while it runs. */
  leadFallback(ctx: RunnerContext, escalationId: string): Promise<void>;
  /** Every task is accepted and the final validation passed: is the ultimate goal met? */
  goalReview(ctx: RunnerContext, input: GoalReviewInput): Promise<GoalReview>;
}

export const DEFAULT_HOOKS: RunnerHooks = {
  async escalationRouter(ctx, esc) {
    ctx.log(`escalation ${esc.id} (${esc.kind}, with ${esc.with}${esc.task ? `, task ${esc.task}` : ""}) is open; no escalation router is installed, so it waits for the orchestrator`);
  },
  async leadFallback(ctx, id) {
    ctx.log(`lead fallback for ${id}: no lead hook is installed`);
  },
  async goalReview() {
    return { verdict: "COMPLETE" };
  },
};

export function withDefaults(hooks: Partial<RunnerHooks> = {}): RunnerHooks {
  return { ...DEFAULT_HOOKS, ...hooks };
}

// ============================================================================
// Escalations the runner raises itself (attestation, conflicts, final validation, driver)
// ============================================================================

/** Deterministic id for a runner escalation key, so it is raised once (esc-rn…). */
export function runnerEscalationId(key: string): string {
  return `esc-rn${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export interface RunnerEscalationSpec {
  key: string;
  task?: string;
  kind: Escalation["kind"];
  summary: string;
  question?: string;
  options?: string[];
  /** Block the task (task.blocked {escalation}) unless it is finished or already blocked. */
  block?: boolean;
  diagnosticsBlob?: string;
}

/**
 * escalation.raised (to the contract's orchestrator) plus task.blocked, or nothing when the
 * blackboard already has this escalation.
 */
export function runnerEscalation(state: Readonly<BlackboardState>, spec: RunnerEscalationSpec, source: EventSource): AnyEventDraft[] {
  const id = runnerEscalationId(spec.key);
  if (Object.hasOwn(state.escalations, id)) return [];
  const rt = spec.task !== undefined && Object.hasOwn(state.tasks, spec.task) ? state.tasks[spec.task] : undefined;
  const live = rt !== undefined && !["accepted", "failed", "cancelled"].includes(rt.state);
  const block = spec.block === true && live;
  const esc: Escalation = {
    id,
    agent: "runner",
    kind: spec.kind,
    with: "orchestrator",
    summary: spec.summary,
    blocking: block,
    status: "open",
    raised_seq: 0,
    ...(spec.task !== undefined && { task: spec.task }),
    ...(state.contract?.scope.orchestrator && { target: state.contract.scope.orchestrator }),
    ...(spec.question && { question: spec.question }),
    ...(spec.options?.length && { options: spec.options }),
    ...(spec.diagnosticsBlob && { diagnostics_blob: spec.diagnosticsBlob }),
  };
  const out: AnyEventDraft[] = [{ type: "escalation.raised", source, correlation: id, payload: { escalation: esc } }];
  if (block && rt!.state !== "blocked") out.push({ type: "task.blocked", source, correlation: id, payload: { task: spec.task!, escalation: id } });
  return out;
}

export type { EscalationDiagnostics };
