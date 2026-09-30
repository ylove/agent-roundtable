// Helpers shared by the concrete publishers.
import { randomBytes } from "node:crypto";
import type { Channel, SendResult } from "./types.js";

export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
export const REQUEST_TIMEOUT_MS = 15_000;

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}

const sanitize = (s: string) => s.replace(/[^-_A-Za-z0-9]/g, "-");

/**
 * Build `${prefix}-${sessionId}-${random}` (<= 64 chars, matching the ntfy topic regex).
 * The random part (22 base64url chars) is never truncated; prefix/sessionId shrink instead.
 * Never includes the session subject.
 */
export function buildChannelId(
  prefix: string,
  sessionId: string,
  random: string = randomBytes(16).toString("base64url")
): Channel {
  const rnd = sanitize(random).slice(0, 22) || sanitize(randomBytes(16).toString("base64url"));
  let p = sanitize(prefix).replace(/^-+|-+$/g, "");
  let s = sanitize(sessionId).replace(/^-+|-+$/g, "");
  const budget = 64 - rnd.length - (p ? 1 : 0) - (s ? 1 : 0) - 0;
  while (p.length + s.length > budget) {
    if (p.length > s.length) p = p.slice(0, -1);
    else s = s.slice(0, -1);
  }
  const id = [p, s, rnd].filter(Boolean).join("-");
  return { id, sessionId, suffix: rnd.slice(0, 8) };
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function failFromStatus(status: number, statusText: string, retryAfterMs?: number): SendResult {
  const error = `HTTP ${status}${statusText ? " " + statusText : ""}`;
  if (status === 401 || status === 403) return { ok: false, retryable: false, stop: "auth", error };
  if (status === 429 || status >= 500 || status === 408)
    return { ok: false, retryable: true, retryAfterMs, error };
  return { ok: false, retryable: false, error };
}
