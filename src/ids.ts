// ============================================================================
// Durable random identifiers (unique across server restarts and processes)
// ============================================================================

import { randomBytes } from "node:crypto";

// Crockford base32: no I, L, O or U, so ids survive being read aloud or retyped.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** n random Crockford base32 characters (5 bits each, from crypto randomness). */
export function randomBase32(n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

function timeBase32(ms: number, width: number): string {
  let out = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < width; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** `<prefix>-<8 random chars>`, e.g. collab-4k9q2mzt. */
export function newId(prefix: string): string {
  return `${prefix}-${randomBase32(8)}`;
}

/** `exe-<10 time chars><6 random chars>`: sorts by creation time, unique across hosts. */
export function newExecutionId(now = Date.now()): string {
  return `exe-${timeBase32(now, 10)}${randomBase32(6)}`;
}

export const EXECUTION_ID_RE = /^exe-[0-9a-hjkmnp-tv-z]{16}$/;

/** The 6-character tag used in branch names (rt/<tag>/<task>): the random tail of the execution id. */
export function executionTag(executionId: string): string {
  return executionId.slice(-6);
}
