// ============================================================================
// Secret scrubbing for logs, events, blobs, command output and tool errors
//
// Two layers: the exact values of secret-named environment variables (catches keys of any
// shape), then the pattern-based credential rules shared with public redaction.
// ============================================================================

import { redactArtifactSecrets, redactSecrets } from "./redaction-rules.js";

/**
 * Names that look like credentials (used by secret scrubbing, tests and the contract validator).
 * AUTH, PASS and CRED count only as whole name segments, so GIT_AUTHOR_NAME, BYPASS_CACHE and
 * session ids are not treated as secrets while ROUNDTABLE_WEBHOOK_AUTH_HEADER and DB_PASS are.
 */
export const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|(?:^|_)(?:AUTH|PASS|CREDS?)(?:_|$)/i;

/** Private exact-match values shared only with the trusted runner and output relay. */
export const SCRUB_LITERALS_ENV = "ROUNDTABLE_SCRUB_LITERALS";

const MIN_SECRET_LENGTH = 8;

interface EnvSecret {
  name: string;
  value: string;
}

/** Secret-named variables with non-trivial values, longest first so a secret containing another is replaced whole. */
function envSecrets(source: NodeJS.ProcessEnv): EnvSecret[] {
  const list: EnvSecret[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (name === SCRUB_LITERALS_ENV) continue;
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH && SECRET_NAME_RE.test(name)) list.push({ name, value });
  }
  try {
    const literals: unknown = JSON.parse(source[SCRUB_LITERALS_ENV] ?? "[]");
    if (Array.isArray(literals)) {
      for (const value of literals) {
        if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) list.push({ name: SCRUB_LITERALS_ENV, value });
      }
    }
  } catch { /* ignore malformed private configuration */ }
  return list.sort((a, b) => b.value.length - a.value.length);
}

/** The same exact-match values used by scrubConfiguredSecrets, including inherited literals. */
export function configuredSecretLiterals(source: NodeJS.ProcessEnv): string[] {
  return [...new Set(envSecrets(source).map(({ value }) => value))];
}

export interface ScrubResult {
  text: string;
  redactions: number;
}

/** Replace exact configured secret values. Safe to call on any string. */
export function scrubConfiguredSecrets(input: string, source: NodeJS.ProcessEnv = process.env): ScrubResult {
  if (!input) return { text: input, redactions: 0 };
  let text = input;
  let redactions = 0;
  const secrets = envSecrets(source);
  const privateConfig = source[SCRUB_LITERALS_ENV];
  if (privateConfig) {
    secrets.push({ name: SCRUB_LITERALS_ENV, value: privateConfig });
    secrets.push({ name: SCRUB_LITERALS_ENV, value: JSON.stringify(privateConfig).slice(1, -1) });
  }
  secrets.sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of secrets) {
    if (!text.includes(value)) continue;
    const parts = text.split(value);
    redactions += parts.length - 1;
    text = parts.join(`[redacted:env:${name}]`);
  }
  return { text, redactions };
}

/** Replace exact configured values first, then credential patterns. */
export function scrubSecrets(input: string, source: NodeJS.ProcessEnv = process.env): ScrubResult {
  let { text, redactions } = scrubConfiguredSecrets(input, source);
  const patterns = redactSecrets(text);
  for (const n of Object.values(patterns.counts)) redactions += n;
  return { text: patterns.text, redactions };
}

/**
 * Artifact-content mode: exact configured secret values plus credential-shaped patterns (vendor keys,
 * PEM blocks, JWTs, bearer/basic headers, URL credentials). Skips the generic name-based assignment
 * rule so ordinary identifiers in source code and documents survive byte for byte.
 */
export function scrubArtifactSecrets(input: string, source: NodeJS.ProcessEnv = process.env): ScrubResult {
  let { text, redactions } = scrubConfiguredSecrets(input, source);
  const patterns = redactArtifactSecrets(text);
  for (const n of Object.values(patterns.counts)) redactions += n;
  return { text: patterns.text, redactions };
}

/** Convenience: artifact-content scrubbed text only. */
export function scrubArtifact(input: string): string {
  return scrubArtifactSecrets(input).text;
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
