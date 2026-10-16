// ============================================================================
// The runner hook interface WS10 implements. WS08's runner-hooks.ts owns it; WS10 kept a mirror
// here until the runner branch landed, and now re-exports it.
// ============================================================================

export type { GoalReview, GoalReviewInput, RunnerContext, RunnerHooks } from "./runner-hooks.js";
