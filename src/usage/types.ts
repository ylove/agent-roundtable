// ============================================================================
// Usage view: one model of who is using what, on which platform (usage-visibility.md §4)
//
// The status line, the usage CLI and tool, and the dashboard Usage page all render a UsageView, so
// they never disagree. Every token count and every cost keeps its provenance: measured (counted by
// the system that did the work and read directly), reported (told to us by an agent or host) or
// estimated (computed by us). Nothing here holds message text, prompts, diffs or command output.
// ============================================================================

import type { Provenance, ProvenanceTotals } from "../execution/types.js";

export type { Provenance, ProvenanceTotals };

export const PROVENANCES: readonly Provenance[] = ["measured", "reported", "estimated"];

/** Most one report (a worker's, or the host's session cost) may claim: larger values are cut to these (usage-visibility.md section 9). */
export const REPORT_MAX_USD = 10_000;
export const REPORT_MAX_TOKENS = 1e10;

/** Tokens by class, and the same tokens split by provenance. */
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Total tokens by provenance (measured + reported + estimated = input + output + cache_read + cache_write). */
  by: ProvenanceTotals;
}

/**
 * US dollars by provenance. With no money and tokens used, either `free` (a local model: a known price of
 * zero) or `unpriced` (no price is known); every surface words these the same way (format.ts).
 */
export interface Money extends ProvenanceTotals {
  unpriced?: true;
  free?: true;
}

export type Where = "heads-down" | "at-the-table" | "host";
export type AgentState = "working" | "idle" | "stopped" | "done";

export interface UsageAgent {
  /** Persona or agent id. */
  id: string;
  where: Where;
  /** Execution id or session id ("host" for the host agent). */
  scope: string;
  /** Set for spend that belongs to no agent (huddles, consent rounds) or to the host. */
  label?: string;
  provider?: string;
  model?: string;
  /** Every model the agent used, most used first. */
  models: string[];
  tokens: Tokens;
  money: Money;
  state: AgentState;
  /** A stop request is waiting to be applied. */
  stopping?: boolean;
  stoppable: boolean;
  /** Heads-down: the task the agent holds, if any. */
  task?: string;
  /** Heads-down: the agent's money as a fraction (0-1) of the run's budget. */
  budget_share?: number;
  last_at?: string;
  /** Bounded calls charged to this identity, with dissent provenance when applicable. */
  calls?: UsageCall[];
  /** A charged requester may use different platforms for driver and persona calls. */
  platforms?: UsagePlatform[];
}

export interface UsageCall {
  call_id: string;
  source: string;
  dissent_id?: string;
  execution: string;
  task?: string;
  agent?: string;
  provider?: string;
  model: string;
  usd: number;
  estimated: boolean;
  reservation: boolean;
  provenance: { tokens: Provenance; usd: Provenance };
}

export interface UsagePlatform {
  provider: string;
  models: string[];
  tokens: Tokens;
  money: Money;
}

export interface UsageStop {
  agent: string;
  scope: string;
  at: string;
  by: string;
  status: "requested" | "stopped" | "failed";
}

/** One heads-down run at a glance (the status line's second line). */
export interface UsageRun {
  id: string;
  title?: string;
  status: string;
  tasks: { done: number; total: number };
  money: Money;
  tokens: Tokens;
  /** The run's budget in US dollars (extensions included), when it has one. */
  budget_usd?: number;
  /** Percent of the budget spent, 0-100+. */
  budget_pct?: number;
  agents: number;
  live: boolean;
}

/** At-the-table spend of the day, across every orchestrator server that wrote to the table ledger. */
export interface UsageTable {
  sessions: number;
  agents: number;
  money: Money;
  tokens: Tokens;
}

export interface UsageView {
  generated_at: string;
  totals: Money & { tokens: Tokens };
  platforms: UsagePlatform[];
  agents: UsageAgent[];
  stops: UsageStop[];
  /** Heads-down runs, live ones first. */
  runs: UsageRun[];
  table: UsageTable;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, by: { measured: 0, reported: 0, estimated: 0 } });
export const zeroMoney = (): Money => ({ measured: 0, reported: 0, estimated: 0 });

export const tokenTotal = (t: Tokens): number => t.input + t.output + t.cache_read + t.cache_write;
export const moneyTotal = (m: ProvenanceTotals): number => m.measured + m.reported + m.estimated;

const round9 = (n: number): number => Math.round(n * 1e9) / 1e9;

export function addTokens(into: Tokens, add: Pick<Tokens, "input" | "output" | "cache_read" | "cache_write">, prov: Provenance): void {
  into.input += add.input;
  into.output += add.output;
  into.cache_read += add.cache_read;
  into.cache_write += add.cache_write;
  into.by[prov] += add.input + add.output + add.cache_read + add.cache_write;
}

export function mergeTokens(into: Tokens, add: Tokens): void {
  into.input += add.input;
  into.output += add.output;
  into.cache_read += add.cache_read;
  into.cache_write += add.cache_write;
  for (const p of PROVENANCES) into.by[p] += add.by[p];
}

export function addMoney(into: Money, usd: number, prov: Provenance): void {
  into[prov] = round9(into[prov] + usd);
}

export function mergeMoney(into: Money, add: Money): void {
  for (const p of PROVENANCES) into[p] = round9(into[p] + add[p]);
  if (moneyTotal(into) > 0) {
    delete into.unpriced;
    delete into.free;
  } else if (add.unpriced || into.unpriced) {
    into.unpriced = true; // one unknown price makes the sum unknown
    delete into.free;
  } else if (add.free || into.free) into.free = true;
}

/** Plain-data clamp of a number read from a file: finite, non-negative. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
