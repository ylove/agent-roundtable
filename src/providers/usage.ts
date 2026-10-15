// ============================================================================
// Usage sink: token usage of every provider call, reported to whoever runs the work
//
// withUsageSink(sink, fn) makes `sink` active for fn and every async continuation it starts
// (AsyncLocalStorage), so budgets can be kept without threading a parameter through the engines.
// chatCompletion reports each completion there, so callLLMDetailed, callLLM and the chat_completion
// tool all do. Without a sink, reporting is a no-op.
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMCompletionResult } from "./shared.js";

export interface UsageReport {
  provider: string;
  /** The model the provider reports having used (falls back to the requested one). */
  model: string;
  /** Absent when the provider reported none (Replicate, some local servers). */
  usage?: LLMCompletionResult["usage"];
}

export type UsageSink = (report: UsageReport) => void;

const active = new AsyncLocalStorage<UsageSink>();

/** Run fn with `sink` active. A nested withUsageSink replaces it for the nested scope only. */
export function withUsageSink<T>(sink: UsageSink, fn: () => T): T {
  return active.run(sink, fn);
}

/** Report to the active sink, if any. A failing sink is logged and never fails the provider call. */
export function reportUsage(report: UsageReport): void {
  const sink = active.getStore();
  if (!sink) return;
  try {
    sink(report);
  } catch (e) {
    console.error(`[Providers] usage sink failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
