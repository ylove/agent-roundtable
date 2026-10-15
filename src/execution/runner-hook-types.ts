// ============================================================================
// WS08 integration: these interfaces must stay identical to runner-hooks.ts.
// Kept here until the runner branch lands; no dependency on that unmerged module.
// ============================================================================

import type { TaskCardOptions } from "./task-card.js";
import type { BlackboardState, Escalation, EventSource, ExecutionHeader, WorkerDriver, WorkerRecord } from "./types.js";
import type { FileExecutionStore } from "./store.js";

export interface RunnerContext {
  readonly execution: string;
  readonly store: FileExecutionStore;
  readonly header: ExecutionHeader;
  readonly source: EventSource;
  log(message: string): void;
  resumeTask(task: string, immediate?: TaskCardOptions["immediate"]): Promise<boolean>;
  worker(agent: string): WorkerRecord | undefined;
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
  escalationRouter(ctx: RunnerContext, escalation: Escalation): Promise<void>;
  leadFallback(ctx: RunnerContext, escalationId: string): Promise<void>;
  goalReview(ctx: RunnerContext, input: GoalReviewInput): Promise<GoalReview>;
}
