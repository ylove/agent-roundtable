// ============================================================================
// Failure signatures for repeated-failure detection
//
// The watchdog escalates when the same check fails with the same signature three times with no
// patch in between. Run-to-run noise (colors, timestamps, durations, temp paths, addresses, pids,
// ports) is normalized away first, so only the substance of a failure is hashed.
// ============================================================================

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/** Lines kept for the signature. */
export const SIGNATURE_LINES = 60;

const ERROR_LIKE_RE = /error|fail|assert|expected|exception|panic|✖|not ok/i;

// CSI sequences, OSC sequences (terminated by BEL or ST), then any other two-byte escape.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The system temp directory, as written and as resolved (macOS: /var/folders -> /private/var/folders). */
function tempRoots(): string[] {
  const roots = new Set<string>();
  for (const t of [tmpdir()]) {
    const clean = t.replace(/\/+$/, "");
    if (clean.length > 1) roots.add(clean);
    try {
      const real = realpathSync(t).replace(/\/+$/, "");
      if (real.length > 1) roots.add(real);
    } catch {
      /* missing temp dir */
    }
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

// A path token continues until whitespace, a quote or a bracket. `:line:col` suffixes stay with it.
const PATH_TAIL = String.raw`[^\s'"\x60<>()\[\]{},;]*`;
// Not preceded by a path character (so /home/x/tmp is left alone) and ending at a segment boundary.
const TEMP_PATH_RE = new RegExp(String.raw`(?<![\w.~/-])(?:/private)?/(?:tmp|var/folders|var/tmp)(?![\w.-])(?:/${PATH_TAIL})?`, "g");

const RULES: Array<[RegExp, string]> = [
  // ISO 8601 timestamps and dates.
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<ts>"],
  // Clock times (12:34:56, 12:34:56.789), with an optional AM/PM.
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?[AP]M)?\b/gi, "<time>"],
  // Hex addresses and pointers.
  [/\b0x[0-9a-f]{4,}\b/gi, "<addr>"],
  // UUIDs (session and request ids).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  // Loopback host:port pairs.
  [/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\b/gi, "$1:<port>"],
  // Explicit pid / port mentions: "pid 1234", "PID: 1234", "port=8080".
  [/\b(pid|port)\b(\s*[:=#]?\s*)\d+/gi, "$1$2<n>"],
  // TAP duration fields (node --test).
  [/\b(duration_ms)(\s*:\s*)[\d.]+/g, "$1$2<dur>"],
  // Durations: 12ms, 1.2s, 3 min, 450µs.
  [/\b\d+(?:\.\d+)?\s?(?:ns|µs|μs|us|ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?)\b/gi, "<dur>"],
];

/**
 * Normalize command output for hashing: strip ANSI codes, unify line endings (a bare CR, as in
 * progress bars, starts a new line), replace temp paths, timestamps, clock times, hex addresses,
 * UUIDs, loopback ports, pids and durations with placeholders, and trim trailing whitespace.
 */
export function normalizeOutput(output: string): string {
  let text = String(output ?? "")
    .replace(ANSI_RE, "")
    .replace(/\r\n?/g, "\n");
  for (const root of tempRoots()) {
    text = text.replace(new RegExp(String.raw`(?<![\w.~/-])${escapeRe(root)}(?![\w.-])(?:/${PATH_TAIL})?`, "g"), "<tmp>");
  }
  text = text.replace(TEMP_PATH_RE, "<tmp>");
  for (const [re, rep] of RULES) text = text.replace(re, rep);
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
}

/** The lines a signature is computed over: the first 60 error-like lines, else the last 60 lines. */
export function signatureLines(output: string): string[] {
  const lines = normalizeOutput(output)
    .split("\n")
    .filter((l) => l.trim() !== "");
  const errors = lines.filter((l) => ERROR_LIKE_RE.test(l));
  return errors.length ? errors.slice(0, SIGNATURE_LINES) : lines.slice(-SIGNATURE_LINES);
}

/** sha256 hex of `commandId + "\n" + normalized lines`. Equal for reruns of the same failure. */
export function failureSignature(commandId: string, output: string): string {
  return createHash("sha256")
    .update(`${commandId}\n${signatureLines(output).join("\n")}`)
    .digest("hex");
}
