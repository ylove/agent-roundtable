// ============================================================================
// Human-readable times for the dashboard and the serve index
//
// Pages are rendered on the operator's own machine, so the server's locale and time zone are the
// reader's. Every rendered time keeps the exact ISO value in datetime and title for precision.
// ============================================================================

import { escapeHtml } from "../http/secure-server.js";

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000], ["month", 30 * 86_400_000], ["week", 7 * 86_400_000],
  ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000],
];
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function toMs(value: string | number | Date | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "Nov 18, 2026, 6:35 PM" in the local zone, or "" for a missing or invalid time. */
export function formatDate(value: string | number | Date | undefined): string {
  const ms = toMs(value);
  return ms === undefined ? "" : DATE_TIME.format(ms);
}

/** "3 days ago", "in 5 minutes", "just now"; "" for a missing or invalid time. */
export function relativeTime(value: string | number | Date | undefined, now: number = Date.now()): string {
  const ms = toMs(value);
  if (ms === undefined) return "";
  const delta = ms - now;
  if (Math.abs(delta) < 45_000) return "just now";
  for (const [unit, size] of UNITS) if (Math.abs(delta) >= size || unit === "minute") return RELATIVE.format(Math.round(delta / size), unit);
  return "just now";
}

/** An escaped <time> element: local date and relative time, with the exact ISO value on hover. */
export function humanTime(value: string | number | Date | undefined, now: number = Date.now()): string {
  const ms = toMs(value);
  if (ms === undefined) return `<span class="muted">unknown</span>`;
  const iso = new Date(ms).toISOString();
  return `<time datetime="${iso}" title="${iso}">${escapeHtml(formatDate(ms))} <span class="ago">· ${escapeHtml(relativeTime(ms, now))}</span></time>`;
}
