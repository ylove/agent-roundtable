import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveExecutable } from "../executables.js";
import { childEnv } from "../security/child-env.js";
import { scrubSecrets } from "../security/secrets.js";
import { signalGroup } from "../workers/process.js";
import { argvPrompt, RUNTIME_MODEL, runtimePath, validateRuntimeSpec, type RuntimeSpec, type UsagePath } from "./spec.js";

export interface RuntimeResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}
export interface RuntimeRunOptions { model?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; runtimeName?: string }

// Leave room for the environment and platform overhead (notably macOS ARG_MAX).
const MAX_ARG_BYTES = 100 * 1024;
const MAX_ARGV_BYTES = 128 * 1024;
const ERROR_SUMMARY_CHARS = 2000;

/** Decode only error events; malformed JSONL lines must not hide a later error. */
function stdoutError(stdout: string, mode: RuntimeSpec["output"]["mode"]): string | undefined {
  const lines = mode === "json" ? [stdout] : stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: unknown;
    try { event = JSON.parse(lines[i]); } catch { continue; }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const type = runtimePath(event, "type");
    if (type !== "turn.failed" && type !== "error" && !(mode === "json" && type === undefined)) continue;
    const error = runtimePath(event, "error");
    const message = typeof error === "string" ? error : runtimePath(error, "message") ?? (type === "error" ? runtimePath(event, "message") : undefined);
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}

/** Runtime env adds only names explicitly authorized by the profile. */
export function runtimeEnv(spec: RuntimeSpec, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return childEnv("runtime", Object.fromEntries((spec.env ?? []).map(name => [name, source[name]])), source);
}

async function execute(spec: RuntimeSpec, prompt: string, opts: RuntimeRunOptions, probe = false): Promise<string> {
  validateRuntimeSpec(spec);
  opts.signal?.throwIfAborted();
  if (opts.model !== undefined && !RUNTIME_MODEL.test(opts.model)) throw new Error("Invalid runtime model; use a model identifier beginning with a letter or digit.");
  if (!probe && opts.model && !spec.modelFlag) throw new Error("This runtime does not support a model override.");
  const source = opts.env ?? process.env;
  const clean = (s: string) => scrubSecrets(s, source).text;
  const binary = resolveExecutable(spec.argv[0], source.PATH);
  if (!binary) throw new Error(`Runtime binary not found: ${clean(spec.argv[0])}`);
  const args = probe ? [...(spec.versionArgv ?? [])] : spec.argv.slice(1).map(v => v === "{prompt}" ? argvPrompt(prompt) : v);
  if (!probe && opts.model && spec.modelFlag) {
    // Keep option/value pairs intact; stdin's positional marker stays last.
    args.splice(args.at(-1) === "-" && !spec.argv.includes("{prompt}") ? args.length - 1 : args.length, 0, spec.modelFlag, opts.model);
  }
  const argBytes = [binary, ...args].map(arg => Buffer.byteLength(arg));
  const oversizedArg = argBytes.some(bytes => bytes > MAX_ARG_BYTES);
  if (oversizedArg || argBytes.reduce((sum, bytes) => sum + bytes + 1, 0) > MAX_ARGV_BYTES) {
    throw new Error(`Runtime ${clean(opts.runtimeName ?? basename(spec.argv[0]))}: ${oversizedArg ? "an argument exceeds the 100 KiB limit" : "total arguments exceed the 128 KiB limit"}; use a stdin-capable runtime profile or override argv in config.json to send the prompt on stdin.`);
  }
  const temporary = spec.cwd ? undefined : await mkdtemp(join(tmpdir(), "roundtable-runtime-"));
  try {
    opts.signal?.throwIfAborted();
    const timeoutMs = probe ? Math.min(spec.timeoutMs ?? 5000, 5000) : spec.timeoutMs ?? 120_000;
    const stdoutCap = spec.stdoutMaxBytes ?? 1_048_576;
    const stderrCap = spec.stderrMaxBytes ?? 65_536;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: spec.cwd ?? temporary, env: runtimeEnv(spec, source), shell: false, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
      let outBytes = 0, errBytes = 0;
      let failure: string | undefined;
      let closed = false, exited = false, drainExpired = false, settled = false;
      let code: number | null = null, exitSignal: NodeJS.Signals | null = null;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let postKillDrain: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        // A detached descendant can keep the pipes open after the direct child is reaped.
        // Once draining expires, the exit event suffices; close is no longer required.
        if (settled || escalation || (!closed && !(failure && drainExpired && (exited || child.pid === undefined)))) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(postKillDrain);
        opts.signal?.removeEventListener("abort", abort);
        child.removeAllListeners();
        child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.stdin.removeAllListeners();
        // A CLI that exited successfully may still have started descendants holding no pipes.
        if (child.pid) { signalGroup(child.pid, "SIGTERM"); signalGroup(child.pid, "SIGKILL"); }
        const tail = clean(stderr.toString("utf8")).slice(-ERROR_SUMMARY_CHARS);
        if (failure || code !== 0) {
          const raw = stdout.toString("utf8");
          const summary = spec.output.mode === "text" ? clean(raw).trim().slice(-ERROR_SUMMARY_CHARS)
            : clean(stdoutError(raw, spec.output.mode) ?? "").slice(0, ERROR_SUMMARY_CHARS);
          reject(new Error(`Runtime ${failure ?? `exited with ${exitSignal ?? code}`}${summary ? `; stdout ${spec.output.mode === "text" ? "tail" : "error"}: ${summary}` : ""}${tail ? `; stderr tail: ${errBytes > stderrCap ? "[truncated] " : ""}${tail}` : ""}`));
        }
        // Structured stdout must remain raw until parsing and numeric usage extraction finish.
        else resolve(stdout.toString("utf8"));
      };
      const stop = (why: string) => {
        if (failure) return;
        failure = why;
        if (child.pid) {
          signalGroup(child.pid, "SIGTERM");
          escalation = setTimeout(() => {
            signalGroup(child.pid!, "SIGKILL");
            escalation = undefined;
            if (!closed) postKillDrain = setTimeout(() => {
              drainExpired = true;
              child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
              finish();
            }, 500);
            finish();
          }, 250);
        }
      };
      const abort = () => stop("aborted");
      timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (spec.output.mode === "text") stdout = Buffer.concat([stdout, chunk]).subarray(-stdoutCap);
        else if (stdout.length < stdoutCap) stdout = Buffer.concat([stdout, chunk.subarray(0, stdoutCap - stdout.length)]);
        if (outBytes > stdoutCap) stop("stdout exceeded byte cap [truncated]");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        stderr = Buffer.concat([stderr, chunk]).subarray(-stderrCap);
        if (errBytes > stderrCap) stop("stderr exceeded byte cap [truncated]");
      });
      child.once("error", error => { stop(`spawn failed: ${clean(error.message)}`); });
      child.once("exit", (c, s) => { code = c; exitSignal = s; exited = true; finish(); });
      child.once("close", (c, s) => { code = c; exitSignal = s; closed = true; finish(); });
      child.stdin.on("error", () => { /* A CLI can exit before consuming its prompt; close reports the error. */ });
      child.stdin.end(probe || spec.argv.includes("{prompt}") ? undefined : prompt);
    });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
/** Decoration-only lines and leading Hermes/status lines are removed; prose is preserved. */
export function stripRuntimeDecoration(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)
    .filter(line => !/^[\s─━═┌┐└┘│╭╮╰╯+|=_*-]+$/.test(line))
    .join("\n").replace(/^(?:\s*(?:hermes(?: agent)?\b[^\n]*|loading\b[^\n]*|connected\b[^\n]*)\n)+/i, "").trim();
}
/** First available path wins; wildcard components sum numeric values across model entries. */
function usageNumber(event: unknown, paths: UsagePath | undefined): number | undefined {
  const walk = (value: unknown, parts: string[]): number | undefined => {
    if (!parts.length) return number(value);
    const [key, ...rest] = parts;
    if (key !== "*") return walk(runtimePath(value, key), rest);
    if (!value || typeof value !== "object") return undefined;
    const counts = Object.values(value).map(v => walk(v, rest));
    return counts.length && counts.every(v => v !== undefined) ? number((counts as number[]).reduce((a, b) => a + b, 0)) : undefined;
  };
  for (const path of typeof paths === "string" ? [paths] : paths ?? []) {
    const value = walk(event, path.split("."));
    if (value !== undefined) return value;
  }
  return undefined;
}
/** The final text and usage of a runtime's stdout, by the profile's output mode (shared by seats and heads-down workers). */
export function parseRuntimeOutput(spec: RuntimeSpec, stdout: string, env: NodeJS.ProcessEnv = process.env): RuntimeResult {
  const output = spec.output;
  let text: unknown;
  let usage: RuntimeResult["usage"], costUsd: number | undefined;
  const extract = (event: unknown) => {
    if (!spec.usage) return;
    const input = usageNumber(event, spec.usage.inputTokens);
    const out = usageNumber(event, spec.usage.outputTokens);
    if (input !== undefined && out !== undefined && Number.isSafeInteger(input) && Number.isSafeInteger(out)) {
      usage = output.mode === "jsonl" && usage
        ? { inputTokens: usage.inputTokens + input, outputTokens: usage.outputTokens + out }
        : { inputTokens: input, outputTokens: out };
    }
    const cost = usageNumber(event, spec.usage.costUsd);
    if (cost !== undefined) costUsd = output.mode === "jsonl" ? (costUsd ?? 0) + cost : cost;
  };
  if (output.mode === "text") text = output.stripDecoration ? stripRuntimeDecoration(stdout) : stdout.trim();
  else {
    let events: unknown[];
    try { events = output.mode === "json" ? [JSON.parse(stdout)] : stdout.split(/\r?\n/).filter(v => v.trim()).map(v => JSON.parse(v)); }
    catch { throw new Error("Runtime returned invalid JSON output."); }
    for (const event of events) {
      extract(event);
      if (output.mode === "json" || Object.entries(output.filter).every(([path, expected]) => {
        const actual = runtimePath(event, path);
        return Array.isArray(expected) ? expected.includes(actual as string) : actual === expected;
      })) text = runtimePath(event, output.path);
    }
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("Runtime returned no final text at the configured output path.");
  return { text: scrubSecrets(text, env).text, ...(usage && { usage }), ...(costUsd !== undefined && { costUsd }) };
}
export async function runRuntime(spec: RuntimeSpec, prompt: string, opts: RuntimeRunOptions = {}): Promise<RuntimeResult> {
  return parseRuntimeOutput(spec, await execute(spec, prompt, opts), opts.env ?? process.env);
}
export async function detectRuntime(spec: RuntimeSpec, opts: RuntimeRunOptions = {}): Promise<{ found: boolean; path?: string; version?: string; ok: boolean; error?: string }> {
  validateRuntimeSpec(spec);
  const path = resolveExecutable(spec.argv[0], (opts.env ?? process.env).PATH);
  if (!path) return { found: false, ok: false };
  try {
    const version = spec.versionArgv ? scrubSecrets(await execute(spec, "", opts, true), opts.env ?? process.env).text.trim().slice(0, 200) : undefined;
    return { found: true, path, ok: true, ...(version && { version }) };
  } catch (error) {
    opts.signal?.throwIfAborted();
    return { found: true, path, ok: false, error: error instanceof Error ? error.message : "Runtime version probe failed." };
  }
}
