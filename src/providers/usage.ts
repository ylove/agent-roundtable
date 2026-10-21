// ============================================================================
// Usage sink: token usage of every provider call, reported to whoever runs the work
//
// withUsageSink(sink, fn) makes `sink` active for fn and every async continuation it starts
// (AsyncLocalStorage), so budgets can be kept without threading a parameter through the engines.
// chatCompletion reports each completion there, so callLLMDetailed, callLLM and the chat_completion
// tool all do. Without a sink, reporting is a no-op.
//
// withAbortSignal(signal, fn) does the same for a stop: chatCompletion combines the active signal with
// its timeout, so stopping a session aborts the provider call in flight (usage-visibility.md §6).
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMCompletionResult } from "./shared.js";

export interface UsageReport {
  provider: string;
  /** Speaking persona, attached by the enclosing session when an outer ledger owns the call. */
  agent?: string;
  /** The model the provider reports having used (falls back to the requested one). */
  model: string;
  /** Absent when the provider reported none (Replicate, some local servers). */
  usage?: LLMCompletionResult["usage"];
  /** A driver may report a measured cost along with provider token usage. */
  usd?: number;
  /** External runtimes report their own counts; API response counts are measured by default. */
  tokensProvenance?: "measured" | "reported";
  /** Lengths (not text) of the request and the reply, so a call without usage can still be estimated. */
  chars?: { input: number; output: number };
}

/** Kept outside UsageReport so existing usage sinks retain their exact payload contract. */
export interface ProviderOutcome {
  provider: string;
  model: string;
  outcome: "ok" | "auth" | "rate_limit" | "timeout" | "error";
  latency_ms: number;
  /** Endpoint hash for operator-pointable providers (see endpointFingerprint). */
  endpoint?: string;
  /** Credential hash (see credentialFingerprint); never the key. */
  cred?: string;
}
type OutcomeSink = (outcome: ProviderOutcome) => void;
const outcomeContext = new AsyncLocalStorage<ProviderOutcome>();
const failureSink = new AsyncLocalStorage<OutcomeSink | undefined>();
export const activeProviderOutcome = (): ProviderOutcome | undefined => outcomeContext.getStore();
export function withProviderOutcome<T>(outcome: ProviderOutcome, fn: () => T): T { return outcomeContext.run(outcome, fn); }
export function withProviderFailureSink<T>(sink: OutcomeSink | undefined, fn: () => T): T { return failureSink.run(sink, fn); }
export function reportProviderFailure(outcome: ProviderOutcome): void {
  try { failureSink.getStore()?.(outcome); } catch { /* Diagnostics must not change provider failures. */ }
}

export type UsageSink = (report: UsageReport) => void;

const active = new AsyncLocalStorage<UsageSink>();
const stopSignal = new AsyncLocalStorage<AbortSignal>();

/** A provider call was cut short because its session was stopped (not a timeout or a provider error). */
export class StoppedError extends Error {
  constructor(message = "Stopped: the session was stopped by a person") {
    super(message);
    this.name = "StoppedError";
  }
}

/** The sink active here, if any (a nested scope chains to it or leaves the accounting to it). */
export function activeUsageSink(): UsageSink | undefined {
  return active.getStore();
}

/** Run fn with `signal` active for every provider call it starts. A nested call replaces it for the nested scope. */
export function withAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return stopSignal.run(signal, fn);
}

export function activeAbortSignal(): AbortSignal | undefined {
  return stopSignal.getStore();
}

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
