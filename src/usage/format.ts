// ============================================================================
// Wording of usage figures, shared by the status line, the usage CLI and the tool (usage-visibility.md §3)
//
// Words, not just symbols: a figure says whether it was measured, reported or estimated. The status
// line abbreviates measured / reported to meas / rep (docs/usage.md); colour is never the only signal. Estimated
// money carries "≈". A total that mixes provenances shows the split, never one blended number, and a
// cost that cannot be known shows the tokens with "no price" rather than $0.00.
// ============================================================================

import { moneyTotal, tokenTotal, PROVENANCES, type Money, type Provenance, type ProvenanceTotals, type Tokens } from "./types.js";

export type Style = "words" | "abbr";

export const WORDS: Record<Provenance, string> = { measured: "measured", reported: "reported", estimated: "estimated" };
export const ABBR: Record<Provenance, string> = { measured: "meas", reported: "rep", estimated: "estimated" };

/** What a model that costs nothing (a local one) shows instead of a price. */
export const FREE_LABEL = "free (local model)";
/** What a model whose price is unknown shows: its tokens, and this. */
export const NO_PRICE_LABEL = "no price";

/** One-sentence meanings, for legends and help text. */
export const MEANING: Record<Provenance, string> = {
  measured: "counted by whoever did the work and read directly",
  reported: "told to us by an agent or the host, so we cannot check it",
  estimated: "worked out by us, from prices, text length or a retained paid-call allowance",
};

/** $0.92, $12.40, $1,204.00; "<$0.01" for a sliver. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A budget: $20 when whole, else $20.50. */
export function usdBudget(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : usd(n);
}

/** 842, 4.1k, 1.2M. */
export function tokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
}

const label = (p: Provenance, style: Style): string => (style === "abbr" ? ABBR[p] : WORDS[p]);

/** ["$1.62 measured", "$0.40 reported", "≈$0.22 estimated"]: only the provenances that have money. */
export function moneyParts(m: ProvenanceTotals, style: Style = "words"): string[] {
  const out: string[] = [];
  for (const p of PROVENANCES) {
    if (m[p] <= 0) continue;
    out.push(`${p === "estimated" ? "≈" : ""}${usd(m[p])} ${label(p, style)}`);
  }
  return out;
}

/** ["4.1k tok measured", "50 tok estimated"]. */
export function tokenParts(t: Tokens, style: Style = "words"): string[] {
  const out: string[] = [];
  for (const p of PROVENANCES) if (t.by[p] > 0) out.push(`${tokensShort(t.by[p])} tok ${label(p, style)}`);
  return out;
}

/** "$1.62 measured + ≈$0.22 estimated", or "" without money. */
export function moneyText(m: ProvenanceTotals, style: Style = "words"): string {
  return moneyParts(m, style).join(" + ");
}

/** "$1.84 = $1.62 measured + ≈$0.22 estimated" when two or more provenances are mixed, else the single figure. */
export function totalText(m: ProvenanceTotals, style: Style = "words"): string {
  const parts = moneyParts(m, style);
  if (parts.length < 2) return parts[0] ?? usd(0);
  return `${usd(moneyTotal(m))} = ${parts.join(" + ")}`;
}

/**
 * What an agent or platform has used: its money when any is known; the tokens too when the money is
 * estimated from them (so the measured count is not hidden behind a guess); "no price" for tokens
 * with no cost at all. Without any use: "no usage yet".
 */
export function useText(money: Money, tokens: Tokens, style: Style = "words"): string {
  const parts: string[] = [];
  const known = money.measured + money.reported > 0;
  if (!known && tokenTotal(tokens) > 0) parts.push(tokenParts(tokens, style).join(" + "));
  if (moneyTotal(money) > 0) parts.push(moneyText(money, style));
  else if (money.free) parts.push(`${usd(0)} ${FREE_LABEL}`);
  else if (tokenTotal(tokens) > 0 || money.unpriced) parts.push(NO_PRICE_LABEL);
  return parts.length ? parts.join(" ") : "no usage yet";
}
