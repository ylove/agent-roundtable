// ============================================================================
// Secret scrubbing for logs, events, blobs, command output and tool errors
//
// Two layers: the exact values of secret-named environment variables (catches keys of any
// shape), then the pattern-based credential rules shared with public redaction.
// ============================================================================

import { redactSecrets } from "../publishers/redact.js";
import { SECRET_NAME_RE } from "./child-env.js";

const MIN_SECRET_LENGTH = 8;

interface EnvSecret {
  name: string;
  value: string;
}

/** Secret-named variables with non-trivial values, longest first so a secret containing another is replaced whole. */
function envSecrets(source: NodeJS.ProcessEnv): EnvSecret[] {
  const list: EnvSecret[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && SECRET_NAME_RE.test(name)) list.push({ name, value });
  }
  return list.sort((a, b) => b.value.length - a.value.length);
}

export interface ScrubResult {
  text: string;
  redactions: number;
}

/** Replace exact env secret values and credential patterns. Safe to call on any string. */
export function scrubSecrets(input: string, source: NodeJS.ProcessEnv = process.env): ScrubResult {
  if (!input) return { text: input, redactions: 0 };
  let text = input;
  let redactions = 0;
  for (const { name, value } of envSecrets(source)) {
    if (!text.includes(value)) continue;
    const parts = text.split(value);
    redactions += parts.length - 1;
    text = parts.join(`[redacted:env:${name}]`);
  }
  const patterns = redactSecrets(text);
  for (const n of Object.values(patterns.counts)) redactions += n;
  return { text: patterns.text, redactions };
}

/** Convenience: scrubbed text only. */
export function scrub(input: string): string {
  return scrubSecrets(input).text;
}

/** Scrub then cap, for error messages that echo remote or child output. */
export function scrubAndCap(input: string, max: number): string {
  const text = scrub(input);
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}
