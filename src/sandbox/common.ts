// ============================================================================
// Sandbox: shared constants, request validation and output capping
//
// Every backend validates its own requests with these helpers too, so a backend called directly
// (not through runSandboxed) is never weaker than the run core.
// ============================================================================

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SECRET_NAME_RE } from "../security/child-env.js";
import { normalizeRelPath } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";

// ============================================================================
// Environment variables and defaults
// ============================================================================

/** Environment variables read by the sandbox (the integrator documents them in README and .env.example). */
export const SANDBOX_ENV = {
  /** Docker image for commands and checks. */
  IMAGE: "ROUNDTABLE_SANDBOX_IMAGE",
  /** Docker image for the egress proxy. */
  PROXY_IMAGE: "ROUNDTABLE_SANDBOX_PROXY_IMAGE",
  /** docker --memory, e.g. 2g. */
  MEMORY: "ROUNDTABLE_SANDBOX_MEMORY",
  /** docker --cpus, e.g. 2 or 1.5. */
  CPUS: "ROUNDTABLE_SANDBOX_CPUS",
  /** docker --pids-limit. */
  PIDS: "ROUNDTABLE_SANDBOX_PIDS",
  /** "1" opts into the local backend. */
  ALLOW_LOCAL: "ROUNDTABLE_ALLOW_LOCAL_SANDBOX",
} as const;

export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm-slim";
export const DEFAULT_PROXY_IMAGE = "node:22-alpine";

export const DEFAULT_TIMEOUT_MS = 600_000;
/** Upper bound for any single command, matching the 15-minute submit_work cap. */
export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Hard ceiling on retained output, whatever the request asks for. */
export const MAX_OUTPUT_BYTES_CEILING = 16 * 1024 * 1024;
export const TOOL_TAIL_BYTES = 8192;

export function localSandboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SANDBOX_ENV.ALLOW_LOCAL] ?? "").trim() === "1";
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Clamp a requested timeout. A non-positive or non-finite request means the default; a
 * non-positive or non-finite `max` means MAX_TIMEOUT_MS; the result never exceeds MAX_TIMEOUT_MS.
 */
export function clampTimeout(ms: number | undefined, max: number = MAX_TIMEOUT_MS): number {
  const t = positive(ms) ? Math.floor(ms) : DEFAULT_TIMEOUT_MS;
  const cap = positive(max) ? Math.min(Math.floor(max), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  return Math.max(1, Math.min(t, cap));
}

export function clampOutputBytes(n: number | undefined): number {
  const b = positive(n) ? Math.floor(n) : DEFAULT_MAX_OUTPUT_BYTES;
  return Math.max(256, Math.min(b, MAX_OUTPUT_BYTES_CEILING));
}

// ============================================================================
// Request validation
// ============================================================================

/** A request the sandbox refuses to run (bad argv, env, cwd or workdir). Never retried. */
export class SandboxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRequestError";
  }
}

const MAX_ARGV = 4096;
const MAX_ARG_BYTES = 128 * 1024;

/** Structured argv only: non-empty array of strings, no NUL, argv[0] non-empty and not an option. */
export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new SandboxRequestError("argv must be a non-empty array of strings");
  if (argv.length > MAX_ARGV) throw new SandboxRequestError(`argv has more than ${MAX_ARGV} elements`);
  for (const [i, a] of argv.entries()) {
    if (typeof a !== "string") throw new SandboxRequestError(`argv[${i}] is not a string`);
    if (a.includes("\0")) throw new SandboxRequestError(`argv[${i}] contains a NUL byte`);
    if (Buffer.byteLength(a) > MAX_ARG_BYTES) throw new SandboxRequestError(`argv[${i}] is longer than ${MAX_ARG_BYTES} bytes`);
  }
  const first = argv[0] as string;
  if (!first.trim()) throw new SandboxRequestError("argv[0] is empty");
  if (first.startsWith("-")) throw new SandboxRequestError("argv[0] must be a program, not an option");
  return argv as string[];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
/** Wrappers whose own options, assignments and values precede the real program. */
const WRAPPERS = new Set(["env", "command", "exec", "nice", "nohup", "timeout", "stdbuf", "busybox", "xargs"]);
/** Wrapper options that take a separate value. */
const VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--arg-file", "--replace", "--eof"]),
};

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * True for `sh -c …` style argv: also `bash -lc`, `env FOO=1 bash -c`, `env -S "sh -c …"`,
 * `xargs -I{} sh -c`, `timeout 10 sh -c`, `busybox sh -c`. This is a policy signal, not a
 * security boundary: `node -e` is just as arbitrary.
 */
export function isShellCommand(argv: readonly string[]): boolean {
  let i = 0;
  while (i < argv.length && WRAPPERS.has(basenameOf(argv[i]))) {
    const wrapper = basenameOf(argv[i]);
    const takesValue = VALUE_OPTS[wrapper] ?? new Set<string>();
    i++;
    for (; i < argv.length; i++) {
      const a = argv[i];
      // env -S / --split-string runs a whole command line given as one string.
      if (wrapper === "env" && /^(-S|--split-string)(=|$)|^-S./.test(a)) {
        const joined = a === "-S" || a === "--split-string" ? (argv[i + 1] ?? "") : a.replace(/^(--split-string=|-S)/, "");
        const rest = a === "-S" || a === "--split-string" ? argv.slice(i + 2) : argv.slice(i + 1);
        return isShellCommand([...joined.split(/\s+/).filter(Boolean), ...rest]);
      }
      if (a === "--") {
        i++;
        break;
      }
      if (takesValue.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
      if (wrapper === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(a)) continue;
      break;
    }
  }
  if (i >= argv.length || !SHELLS.has(basenameOf(argv[i]))) return false;
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return true;
    if (/^[-+][oO]$/.test(a)) j++; // set -o / shopt -O take a value
    else if (!a.startsWith("-") && !a.startsWith("+")) return false;
  }
  return false;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate caller-supplied variables: well-formed names, no secret-shaped names (SECRET_NAME_RE), no
 * NUL, and none of the names the sandbox sets itself (`reserved`, compared case-insensitively).
 */
export function validateEnv(env: Record<string, string> | undefined, reserved: readonly string[] = []): Record<string, string> {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new SandboxRequestError("env must be an object of strings");
  const blocked = new Set(reserved.map((r) => r.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) throw new SandboxRequestError(`env name ${JSON.stringify(k)} is not a valid variable name`);
    if (SECRET_NAME_RE.test(k)) throw new SandboxRequestError(`env name ${k} looks like a credential; secrets never enter the sandbox`);
    if (blocked.has(k.toUpperCase())) throw new SandboxRequestError(`env name ${k} is set by the sandbox and cannot be overridden`);
    if (typeof v !== "string") throw new SandboxRequestError(`env ${k} must be a string`);
    if (v.includes("\0")) throw new SandboxRequestError(`env ${k} contains a NUL byte`);
    out[k] = v;
  }
  return out;
}

/** The normalized relative cwd ("" for the workdir itself). Absolute paths and ".." are refused. */
export function resolveCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === null || cwd === "" || /^\.\/*$/.test(cwd)) return "";
  if (typeof cwd !== "string") throw new SandboxRequestError("cwd must be a string");
  const rel = normalizeRelPath(cwd);
  if (rel === null) throw new SandboxRequestError(`cwd ${JSON.stringify(cwd)} must be relative to the workdir and stay inside it`);
  return rel;
}

/**
 * An absolute host path without characters that could break out of an argv-embedded value
 * (docker --mount is CSV-parsed; seatbelt params are strings).
 */
export function validateWorkdir(workdir: unknown): string {
  if (typeof workdir !== "string" || !workdir || !isAbsolute(workdir)) throw new SandboxRequestError("workdir must be an absolute path");
  if (/[\0\n\r,"']/.test(workdir)) throw new SandboxRequestError("workdir contains characters the sandbox cannot mount safely (comma, quote or control)");
  return workdir;
}

export interface CanonicalWorkdir {
  /** The real path, resolved once; every later use (mounts, profile, cwd) uses this. */
  path: string;
  /** What the workdir's own .git is: a gitfile (worktree), a directory (checkout), or absent. */
  git: "file" | "dir" | "absent";
}

/**
 * Resolve a workdir once, refusing a workdir that is itself a symlink: a sandboxed run that could
 * replace its workdir with a link would otherwise redirect every later run (and its mount or
 * profile) to wherever the link points. A symlinked .git is refused for the same reason.
 */
export function canonicalWorkdir(workdir: unknown): CanonicalWorkdir {
  const given = validateWorkdir(workdir);
  let path: string;
  try {
    const st = lstatSync(given);
    if (st.isSymbolicLink()) throw new SandboxRequestError(`workdir ${given} is a symlink; pass the real directory`);
    if (!st.isDirectory()) throw new SandboxRequestError(`workdir ${given} is not a directory`);
    path = realpathSync(given);
  } catch (e) {
    if (e instanceof SandboxRequestError) throw e;
    throw new SandboxRequestError(`workdir ${given} does not exist`);
  }
  validateWorkdir(path);
  let git: CanonicalWorkdir["git"] = "absent";
  try {
    const st = lstatSync(join(path, ".git"));
    if (st.isSymbolicLink()) throw new SandboxRequestError("the workdir's .git is a symlink; refusing to run");
    git = st.isDirectory() ? "dir" : st.isFile() ? "file" : "absent";
    if (git === "absent") throw new SandboxRequestError("the workdir's .git is neither a file nor a directory");
  } catch (e) {
    if (e instanceof SandboxRequestError) throw e;
  }
  return { path, git };
}

// ============================================================================
// Output capping (bytes, UTF-8 safe, line-aware, head + tail)
// ============================================================================

/** Cuts move to a line boundary when one is this close. */
const LINE_SLACK = 2048;

function marker(omitted: number): string {
  return `\n[... ${omitted} bytes truncated ...]\n`;
}

/** Index <= i that does not split a UTF-8 sequence. */
function utf8Floor(buf: Buffer, i: number): number {
  let j = Math.max(0, Math.min(i, buf.length));
  while (j > 0 && j < buf.length && (buf[j] & 0xc0) === 0x80) j--;
  return j;
}

/** Index >= i that does not split a UTF-8 sequence. */
function utf8Ceil(buf: Buffer, i: number): number {
  let j = Math.max(0, Math.min(i, buf.length));
  while (j < buf.length && (buf[j] & 0xc0) === 0x80) j++;
  return j;
}

/** End index for a head of at most `n` bytes, preferring to end just after a newline. */
function headEnd(buf: Buffer, n: number): number {
  if (n <= 0) return 0;
  const nl = buf.lastIndexOf(10, n - 1);
  if (nl >= 0 && nl + 1 >= n - LINE_SLACK) return nl + 1;
  return utf8Floor(buf, n);
}

/** Start index for a tail of at most `n` bytes, preferring to start just after a newline. */
function tailStart(buf: Buffer, n: number): number {
  if (n <= 0) return buf.length;
  const start = Math.max(0, buf.length - n);
  const nl = buf.indexOf(10, start);
  if (nl >= 0 && nl + 1 <= start + LINE_SLACK && nl + 1 < buf.length) return nl + 1;
  return utf8Ceil(buf, start);
}

/**
 * Join a retained head and tail (with `gap` bytes already dropped between them) into at most `max`
 * bytes: the head, a truncation marker, the tail.
 */
function joinCapped(head: Buffer, tail: Buffer, gap: number, max: number): { text: string; truncated: boolean } {
  if (gap === 0 && head.length + tail.length <= max) {
    return { text: Buffer.concat([head, tail]).toString("utf8"), truncated: false };
  }
  const logical = head.length + gap + tail.length;
  const budget = Math.max(0, max - Buffer.byteLength(marker(logical)));
  const want = Math.floor(budget / 2);
  let h: Buffer;
  let t: Buffer;
  if (gap === 0) {
    const all = Buffer.concat([head, tail]);
    h = all.subarray(0, headEnd(all, want));
    t = all.subarray(Math.max(h.length, tailStart(all, budget - h.length)));
  } else {
    h = head.subarray(0, headEnd(head, Math.min(want, head.length)));
    t = tail.subarray(tailStart(tail, Math.min(budget - h.length, tail.length)));
  }
  const omitted = logical - h.length - t.length;
  return { text: h.toString("utf8") + marker(omitted) + t.toString("utf8"), truncated: true };
}

/** Cap a string at `max` UTF-8 bytes, keeping head and tail around a truncation marker. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  return joinCapped(Buffer.from(text, "utf8"), Buffer.alloc(0), 0, max);
}

/** The last ~`max` bytes, starting at a line boundary when one is near, with a note of what was dropped. */
export function tailText(text: string, max = TOOL_TAIL_BYTES): string {
  const buf = Buffer.from(text ?? "", "utf8");
  if (buf.length <= max) return text ?? "";
  const start = tailStart(buf, max);
  return `[... ${start} earlier bytes omitted ...]\n` + buf.subarray(start).toString("utf8");
}

/**
 * Streaming capture of combined stdout+stderr. Memory stays bounded at about 2 x max: the first
 * `max` bytes and a rolling window of the last `max` bytes. finish() scrubs secrets from what it
 * kept before the final cut, so a secret is never split by the cut (both cut points lie well
 * inside the retained windows).
 */
export class OutputCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;
  total = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer | string): void {
    let buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.total += buf.length;
    if (this.headBytes < this.max) {
      const take = Math.min(buf.length, this.max - this.headBytes);
      this.head.push(buf.subarray(0, take));
      this.headBytes += take;
      buf = buf.subarray(take);
    }
    if (!buf.length) return;
    this.tail.push(buf);
    this.tailBytes += buf.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= this.max) {
      const old = this.tail.shift()!;
      this.tailBytes -= old.length;
      this.dropped += old.length;
    }
  }

  /** Scrubbed, capped text. `scrubFn` defaults to scrubSecrets. */
  finish(scrubFn: (s: string) => string = scrub): { text: string; truncated: boolean } {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (this.dropped === 0) {
      return capText(scrubFn(Buffer.concat([head, tail]).toString("utf8")), this.max);
    }
    const h = Buffer.from(scrubFn(head.toString("utf8")), "utf8");
    const t = Buffer.from(scrubFn(tail.toString("utf8")), "utf8");
    return joinCapped(h, t, this.dropped, this.max);
  }
}
