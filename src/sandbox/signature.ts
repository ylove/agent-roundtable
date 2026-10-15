// ============================================================================
// Failure signatures for repeated-failure detection
//
// The watchdog escalates when the same check fails with the same signature three times with no
// patch in between. Run-to-run noise (colors, timestamps, durations, temp paths, addresses, pids,
// ephemeral ports) is normalized away first, so only the substance of a failure is hashed.
//
// Which lines count: passing-test lines and pass summaries never do (test names often contain
// "error" or "fail"). When strong failure markers are present (not ok, ✖, AssertionError, Error:,
// FAIL, panic, Traceback, npm ERR!, compiler errors) the signature covers each marker and the few
// lines after it, where the expected/actual detail sits; otherwise weaker error-like lines; else
// the tail. Long selections keep their first 30 and last 30 lines, so a late failure still counts.
// ============================================================================

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/** Lines kept for the signature: the first and last half of the selection. */
export const SIGNATURE_LINES = 60;
/** Lines after a strong marker that belong to it (assertion detail, the first stack frames). */
const MARKER_CONTEXT = 8;

const ERROR_LIKE_RE = /error|fail|assert|expected|exception|panic|✖|not ok/i;
const STRONG_RE =
  /\bnot ok\b|✖|●|AssertionError|Error:|\bFAIL(?:ED|URE)?\b|\bpanic|Traceback|npm ERR!|^npm error\b|\berror(?:\[\w+\])?:|\berror TS\d+/;
/** Passing tests and pass summaries (TAP, node --test spec, jest, mocha). */
const PASS_RE =
  /^\s*(?:ok\s|✔|✓|PASS\b)|^\s*(?:#|ℹ)\s*(?:Subtest:|pass\s+\d+|fail\s+0\b|tests\s+\d+|suites\s+\d+|cancelled\s+\d+|skipped\s+\d+|todo\s+\d+|duration_ms\b)/;

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
  // Epoch-millisecond timestamps (2001-2033).
  [/\b1\d{12}\b/g, "<epoch>"],
  // Ephemeral (5-digit) ports after a host; chosen ports such as 80, 443 or 8080 stay.
  [/\b(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]):\d{5}\b/gi, "$1:<port>"],
  [/\b(port)\b(\s*[:=#]?\s*)\d{5}\b/gi, "$1$2<n>"],
  // Pids: "pid 1234", "PID: 1234".
  [/\b(pid)\b(\s*[:=#]?\s*)\d+/gi, "$1$2<n>"],
  // TAP duration fields (node --test).
  [/\b(duration_ms)(\s*:\s*)[\d.]+/g, "$1$2<dur>"],
  // Durations: 12ms, 1.2s, 3 min, 450µs.
  [/\b\d+(?:\.\d+)?\s?(?:ns|µs|μs|us|ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?)\b/gi, "<dur>"],
];

/**
 * Normalize command output for hashing: strip ANSI codes, unify line endings (a bare CR, as in
 * progress bars, starts a new line), replace temp paths, timestamps (ISO, clock, epoch ms), hex
 * addresses, UUIDs, ephemeral ports, pids and durations with placeholders, and trim trailing
 * whitespace.
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

function headAndTail(lines: string[]): string[] {
  const half = SIGNATURE_LINES / 2;
  return lines.length <= SIGNATURE_LINES ? lines : [...lines.slice(0, half), ...lines.slice(-half)];
}

/**
 * The lines a signature is computed over: strong failure markers with their context, else
 * error-like lines, else the last 60 lines. Pass lines never count. At most 60 (first 30 + last 30).
 */
export function signatureLines(output: string): string[] {
  const lines = normalizeOutput(output)
    .split("\n")
    .filter((l) => l.trim() !== "");
  const keep = lines.map((l) => !PASS_RE.test(l));
  const picked = new Set<number>();
  lines.forEach((l, i) => {
    if (!keep[i] || !STRONG_RE.test(l)) return;
    for (let j = i; j < Math.min(lines.length, i + 1 + MARKER_CONTEXT); j++) if (keep[j]) picked.add(j);
  });
  if (picked.size) return headAndTail([...picked].sort((a, b) => a - b).map((i) => lines[i]));
  const weak = lines.filter((l, i) => keep[i] && ERROR_LIKE_RE.test(l));
  if (weak.length) return headAndTail(weak);
  return lines.slice(-SIGNATURE_LINES);
}

/** sha256 hex of `commandId + "\n" + normalized lines`. Equal for reruns of the same failure. */
export function failureSignature(commandId: string, output: string): string {
  return createHash("sha256")
    .update(`${commandId}\n${signatureLines(output).join("\n")}`)
    .digest("hex");
}
