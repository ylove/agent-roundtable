// ============================================================================
// Session spend caps: cumulative metered spend, including estimates for unpriced calls
// ============================================================================

import { budgetEstimate } from "../providers/router.js";
import type { TableLine } from "./table.js";

export interface SessionCap { maxUsd: number; spentUsd: number; reached: boolean }
interface CapState extends SessionCap { onReached?: () => void; onSpend?: () => void }
const caps = new Map<string, CapState>();
const stopping = new Map<string, Promise<void>>();
let stopper: ((id: string) => Promise<unknown>) | undefined;

/** Optional caps accept a positive finite dollar amount. Values are never echoed. */
export function validateSessionCap(maxUsd: unknown): asserts maxUsd is number | undefined {
  if (maxUsd !== undefined && (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new Error("max_usd / --max-usd must be a positive finite number.");
  }
}

export function setSessionCap(id: string, maxUsd: number | undefined, spentUsd = 0, onReached?: () => void): void {
  validateSessionCap(maxUsd);
  caps.delete(id);
  if (maxUsd !== undefined) caps.set(id, { maxUsd, spentUsd, reached: spentUsd >= maxUsd, onReached });
}
export function sessionCapView(id: string): SessionCap | undefined {
  const cap = caps.get(id);
  return cap && { maxUsd: cap.maxUsd, spentUsd: cap.spentUsd, reached: cap.reached };
}
export function clearSessionCap(id: string): void { caps.delete(id); }
export function sweepSessionCaps(live: ReadonlySet<string>): void {
  for (const id of caps.keys()) if (!live.has(id)) caps.delete(id);
}
export function setCapObserver(id: string, onSpend: () => void): void { const cap = caps.get(id); if (cap) cap.onSpend = onSpend; }
/** The table service supplies its normal stop path without a dependency from metering to the service. */
export function setCapStopper(fn: (id: string) => Promise<unknown>): void { stopper = fn; }
export function stopCappedSession(id: string): Promise<void> {
  if (stopping.has(id)) return stopping.get(id)!;
  const cap = caps.get(id);
  if (!cap?.reached) return Promise.resolve();
  const stop = async () => { if (cap.onReached) cap.onReached(); else await stopper?.(id); };
  const pending = stop().finally(() => { stopping.delete(id); });
  stopping.set(id, pending);
  return pending;
}

/** Known free models cost zero; unknown prices use the routing budget estimate. */
export function sessionSpend(line: TableLine): number {
  if (line.usd !== undefined) return line.usd;
  const t = line.tokens;
  if (!t) return 0;
  return budgetEstimate(line.provider ?? "", line.model ?? "", {
    inputTokens: t.input + t.cache_read + t.cache_write, outputTokens: t.output,
  }).usd;
}

/** Returns true exactly once, on the call that reaches the cap. */
export function recordSessionSpend(id: string, line: TableLine): boolean {
  const cap = caps.get(id);
  if (!cap) return false;
  cap.spentUsd += sessionSpend(line);
  const reached = !cap.reached && cap.spentUsd >= cap.maxUsd;
  cap.reached ||= reached;
  cap.onSpend?.();
  return reached;
}
