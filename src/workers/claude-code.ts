// ============================================================================
// The claude-code worker driver
//
// A worker is `claude -p` in its task worktree with exactly five file tools and the roundtable MCP
// server: no shell, no web, no subagents, no other MCP servers, no user or project settings
// (--restricted), no permission prompts, a dollar cap, and the PreToolUse lease hook from its
// settings.json. buildWorkerArgs is pure; there are no positional arguments (several flags are
// variadic), and the task card goes in on stdin. --bare is never used: it skips hooks.
//
// Every flag here was checked against `claude --help` of CLI 2.1.300. --append-system-prompt-file
// is listed there only as "--append-system-prompt[-file]", and detect() accepts either spelling.
// ============================================================================

import { reportUsage } from "../providers/usage.js";
import { execFile, spawn } from "node:child_process";
import { ROUNDTABLE_HOME } from "../config.js";
import { findExecutable } from "../executables.js";
import { preview } from "../execution/events.js";
import type {
  RunAccumulator,
  TokenUsage,
  UsageRecord,
  WorkerDriver,
  WorkerHandle,
  WorkerLaunch,
  WorkerRecord,
} from "../execution/types.js";
import { childEnv, SECRET_NAME_RE } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { ROUNDTABLE_SERVER } from "./files.js";
import { realDirectory, signalGroup, spawnWorker, stopGroup } from "./process.js";

// ============================================================================
// Flags
// ============================================================================

/** The built-in tools a worker has. Bash is never among them: commands go through run_command. */
export const WORKER_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"] as const;
export const WORKER_ALLOWED_TOOLS = `${WORKER_TOOLS.join(" ")} mcp__${ROUNDTABLE_SERVER}`;
export const WORKER_DISALLOWED_TOOLS = "Bash WebFetch WebSearch Task Agent";
export const ROUNDTABLE_TOOL_PREFIX = `mcp__${ROUNDTABLE_SERVER}__`;

/** Flags every worker run needs; detect() reports the ones this CLI lacks and launch() refuses without them. */
export const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--verbose",
  "--session-id",
  "--resume",
  "--fork-session",
  "--append-system-prompt-file",
  "--mcp-config",
  "--strict-mcp-config",
  "--settings",
  "--restricted",
  "--tools",
  "--allowedTools",
  "--disallowedTools",
  "--permission-mode",
  "--permission-prompts",
  "--max-budget-usd",
  "--disable-slash-commands",
  "--no-chrome",
] as const;

/** Optional flags: left out (with a warning) when this CLI lacks them. */
export interface ClaudeCaps {
  model: boolean;
  fallbackModel: boolean;
  effort: boolean;
}

export const FULL_CAPS: ClaudeCaps = { model: true, fallbackModel: true, effort: true };

export function hasFlag(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|[\\s,])${esc}(?![\\w-])`, "m").test(help)) return true;
  // "--append-system-prompt[-file]" in the help of CLI 2.1.x
  const m = /^(--[a-z-]+)-file$/.exec(flag);
  return !!m && help.includes(`${m[1]}[-file]`);
}

/** Missing required flags and the optional capabilities, from `claude --help`. */
export function parseClaudeHelp(help: string): { missing: string[]; caps: ClaudeCaps } {
  return {
    missing: REQUIRED_FLAGS.filter((f) => !hasFlag(help, f)),
    caps: { model: hasFlag(help, "--model"), fallbackModel: hasFlag(help, "--fallback-model"), effort: hasFlag(help, "--effort") },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** A dollar amount for --max-budget-usd: at least one cent, at most four decimals. */
export function formatUsd(usd: number): string {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0.01) {
    throw new Error(`A worker needs a budget of at least $0.01, not ${preview(usd)}`);
  }
  return String(Math.round(usd * 10_000) / 10_000);
}

function absolute(name: string, p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new Error(`buildWorkerArgs: ${name} must be an absolute path`);
  return p;
}

/**
 * The worker's argv (without the program). Pure. `resume` continues launch.sessionId with --resume
 * instead of starting it with --session-id.
 */
export function buildWorkerArgs(l: WorkerLaunch, caps: ClaudeCaps = FULL_CAPS, opts: { resume?: boolean } = {}): string[] {
  if (typeof l.sessionId !== "string" || !UUID_RE.test(l.sessionId)) throw new Error(`buildWorkerArgs: sessionId must be a UUID, not ${preview(l.sessionId)}`);
  const args = ["-p", "--output-format", "stream-json", "--verbose", opts.resume ? "--resume" : "--session-id", l.sessionId];
  const optional: Array<[keyof ClaudeCaps, string, string | undefined]> = [
    ["model", "--model", l.model],
    ["fallbackModel", "--fallback-model", l.fallbackModel],
    ["effort", "--effort", l.effort],
  ];
  for (const [cap, flag, value] of optional) {
    if (value === undefined || value === "") continue;
    if (cap === "effort" ? !EFFORTS.has(value) : !MODEL_RE.test(value)) throw new Error(`buildWorkerArgs: invalid ${flag} ${preview(value)}`);
    if (caps[cap]) args.push(flag, value);
    else console.error(`[Worker] this claude CLI has no ${flag}; running without it`);
  }
  args.push(
    "--append-system-prompt-file", absolute("appendPromptPath", l.appendPromptPath),
    "--mcp-config", absolute("mcpConfigPath", l.mcpConfigPath),
    "--strict-mcp-config",
    "--settings", absolute("settingsPath", l.settingsPath),
    "--restricted",
    "--tools", WORKER_TOOLS.join(","),
    "--allowedTools", WORKER_ALLOWED_TOOLS,
    "--disallowedTools", WORKER_DISALLOWED_TOOLS,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--max-budget-usd", formatUsd(l.budgetUsd),
    "--disable-slash-commands",
    "--no-chrome",
  );
  return args;
}

/**
 * The argv of a read-only answer from a worker's context: a fork of its session (the live one is
 * untouched) with no tools at all (--tools "" for the built-ins; no MCP server is loaded and mcp__*
 * is denied besides), no settings files, no prompts and a dollar cap.
 */
export function buildAnswerArgs(sessionId: string, maxUsd: number): string[] {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) throw new Error(`answer: sessionId must be a UUID, not ${preview(sessionId)}`);
  return [
    "-p", "--resume", sessionId, "--fork-session",
    "--output-format", "json",
    "--restricted",
    "--tools", "",
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--max-budget-usd", formatUsd(maxUsd),
    "--disable-slash-commands",
    "--no-chrome",
  ];
}

// ============================================================================
// Stream parsing and attestation
// ============================================================================

/** RunAccumulator plus what the claude-code stream also reports. */
export interface WorkerRunAccumulator extends RunAccumulator {
  model?: string;
  /** MCP server name → status from system/init ("connected", "failed", …). */
  mcpStatus?: Record<string, string>;
  numTurns?: number;
  permissionDenials?: number;
  /** Usage of each assistant message seen (by message id): what was spent if no result line arrives. */
  messageUsage?: Record<string, TokenUsage>;
  errors?: string[];
}

export function newAccumulator(): WorkerRunAccumulator {
  return { done: false, lines: 0 };
}

const TEXT_MAX = 4000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Claude usage fields as TokenUsage. */
export function claudeTokens(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const t: TokenUsage = { inputTokens: num(o.input_tokens), outputTokens: num(o.output_tokens) };
  if (o.cache_read_input_tokens !== undefined) t.cacheReadTokens = num(o.cache_read_input_tokens);
  if (o.cache_creation_input_tokens !== undefined) t.cacheWriteTokens = num(o.cache_creation_input_tokens);
  return t;
}

/** The model that cost the most in a result's modelUsage. */
function mainModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let best: string | undefined;
  let cost = -1;
  for (const [name, u] of Object.entries(modelUsage as Record<string, { costUSD?: unknown }>)) {
    const c = num(u?.costUSD);
    if (c > cost) {
      best = name;
      cost = c;
    }
  }
  return best;
}

/** One line of `--output-format stream-json --verbose`. Lines that are not JSON (stderr noise) are counted and skipped. */
export function parseClaudeLine(line: string, acc: WorkerRunAccumulator): void {
  acc.lines++;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== "object") return;
  if (o.type === "system" && o.subtype === "init") {
    if (typeof o.session_id === "string") acc.sessionId = o.session_id;
    acc.tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === "string") : [];
    const servers = Array.isArray(o.mcp_servers) ? (o.mcp_servers as Array<{ name?: unknown; status?: unknown }>) : [];
    acc.mcpServers = servers.map((s) => String(s?.name ?? ""));
    acc.mcpStatus = Object.fromEntries(servers.map((s) => [String(s?.name ?? ""), String(s?.status ?? "")]));
    if (typeof o.model === "string") acc.model = o.model;
  } else if (o.type === "assistant") {
    const msg = o.message as { id?: unknown; content?: unknown; usage?: unknown; model?: unknown } | undefined;
    const blocks = Array.isArray(msg?.content) ? (msg!.content as Array<{ type?: unknown; text?: unknown }>) : [];
    const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n").trim();
    if (text) acc.lastText = text.slice(-TEXT_MAX);
    const usage = claudeTokens(msg?.usage);
    if (usage && typeof msg?.id === "string") (acc.messageUsage ??= {})[msg.id] = usage;
    if (!acc.model && typeof msg?.model === "string") acc.model = msg.model;
  } else if (o.type === "result") {
    acc.done = true;
    if (typeof o.subtype === "string") acc.resultSubtype = o.subtype;
    acc.isError = o.is_error === true;
    if (typeof o.total_cost_usd === "number" && Number.isFinite(o.total_cost_usd)) acc.costUsd = o.total_cost_usd;
    const usage = claudeTokens(o.usage);
    if (usage) acc.usage = usage;
    if (typeof o.result === "string" && o.result.trim()) acc.lastText = o.result.trim().slice(-TEXT_MAX);
    if (typeof o.session_id === "string") acc.sessionId ??= o.session_id;
    if (typeof o.num_turns === "number") acc.numTurns = o.num_turns;
    if (Array.isArray(o.permission_denials)) acc.permissionDenials = o.permission_denials.length;
    if (Array.isArray(o.errors)) acc.errors = o.errors.filter((e): e is string => typeof e === "string").slice(0, 10);
    acc.model = mainModel(o.modelUsage) ?? acc.model;
  }
}

/** Sum of the per-message usage seen so far (for a run killed before its result line). */
export function messageUsageTotal(acc: WorkerRunAccumulator): TokenUsage | undefined {
  const all = Object.values(acc.messageUsage ?? {});
  if (!all.length) return undefined;
  const t: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const u of all) {
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.cacheReadTokens! += u.cacheReadTokens ?? 0;
    t.cacheWriteTokens! += u.cacheWriteTokens ?? 0;
  }
  return t;
}

export interface AttestationExpectation {
  /** Built-in tools the worker may have. */
  tools: readonly string[];
  /** MCP tools must carry this prefix. */
  mcpToolPrefix: string;
  /** The MCP servers the worker must have, exactly. */
  mcpServers: readonly string[];
}

export const WORKER_ATTESTATION: AttestationExpectation = {
  tools: WORKER_TOOLS,
  mcpToolPrefix: ROUNDTABLE_TOOL_PREFIX,
  mcpServers: [ROUNDTABLE_SERVER],
};

export interface AttestationResult {
  ok: boolean;
  tools: string[];
  mcp_servers: string[];
  /** Tools and servers outside the expected set. */
  unexpected: string[];
  reasons: string[];
}

/**
 * Check what system/init reported against the expected set: every tool is one of the file tools
 * or mcp__roundtable__*, and the MCP servers are exactly [roundtable], connected. Anything else
 * means the worker must be killed and an escalation raised.
 */
export function attest(acc: RunAccumulator, expected: AttestationExpectation = WORKER_ATTESTATION): AttestationResult {
  const tools = acc.tools ?? [];
  const servers = acc.mcpServers ?? [];
  const reasons: string[] = [];
  const unexpected: string[] = [];
  if (acc.tools === undefined) reasons.push("no system/init line reported the tools");
  for (const t of tools) if (!expected.tools.includes(t) && !t.startsWith(expected.mcpToolPrefix)) unexpected.push(t);
  if (unexpected.length) reasons.push(`unexpected tools: ${unexpected.join(", ")}`);
  const extra = servers.filter((s) => !expected.mcpServers.includes(s));
  const missing = expected.mcpServers.filter((s) => !servers.includes(s));
  if (extra.length) {
    unexpected.push(...extra.map((s) => `mcp server ${s}`));
    reasons.push(`unexpected MCP servers: ${extra.join(", ")}`);
  }
  if (missing.length && acc.tools !== undefined) reasons.push(`missing MCP servers: ${missing.join(", ")}`);
  const status = (acc as WorkerRunAccumulator).mcpStatus ?? {};
  for (const s of expected.mcpServers) {
    if (Object.hasOwn(status, s) && status[s] !== "connected") reasons.push(`MCP server ${s} is ${status[s] || "not connected"}`);
  }
  return { ok: reasons.length === 0, tools: [...tools], mcp_servers: [...servers], unexpected, reasons };
}

// ============================================================================
// The driver
// ============================================================================

export interface ClaudeCodeDriverOptions {
  /** The claude binary (default: found on PATH at each call). */
  cli?: string;
  /** SIGTERM → SIGKILL grace for stop() (default 10 s). */
  killGraceMs?: number;
  /** answer() timeout (default 5 minutes). */
  answerTimeoutMs?: number;
}

export interface DetectResult {
  ok: boolean;
  version?: string;
  missing: string[];
  caps: ClaudeCaps;
  cli?: string;
}

const HELP_TIMEOUT_MS = 15_000;
const ANSWER_OUTPUT_MAX = 4 * 1024 * 1024;

function runForText(file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: childEnv("claude-worker"), encoding: "utf8", timeout: HELP_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? "") })
    );
  });
}

/**
 * What a worker's environment adds to its childEnv profile: the identity the lease hook reads, the
 * state directory, and ROUNDTABLE_DOTENV=off for every roundtable process it starts (the hook).
 * Secret-named entries of l.env are dropped.
 */
export function workerEnvExtras(l: Pick<WorkerLaunch, "execution" | "agent" | "env">): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(l.env ?? {})) {
    if (typeof v !== "string") continue;
    if (SECRET_NAME_RE.test(k)) {
      console.error(`[Worker] not passing ${k} to the worker (secret-named)`);
      continue;
    }
    extra[k] = v;
  }
  return {
    ...extra,
    ROUNDTABLE_EXECUTION_ID: l.execution,
    ROUNDTABLE_AGENT_ID: l.agent,
    ROUNDTABLE_HOME: extra.ROUNDTABLE_HOME ?? ROUNDTABLE_HOME,
    ROUNDTABLE_DOTENV: "off",
  };
}

const detections = new Map<string, { result: Promise<DetectResult>; expires: number }>();

/** Forget cached detections (tests swap fake CLIs). */
export function resetClaudeDetection(): void {
  detections.clear();
}

export class ClaudeCodeDriver implements WorkerDriver {
  readonly id = "claude-code" as const;
  private readonly cliOverride?: string;
  private readonly killGraceMs: number;
  private readonly answerTimeoutMs: number;

  constructor(opts: ClaudeCodeDriverOptions = {}) {
    this.cliOverride = opts.cli;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
    this.answerTimeoutMs = opts.answerTimeoutMs ?? 300_000;
  }

  private cli(): string {
    const cli = this.cliOverride ?? findExecutable("claude");
    if (!cli) throw new Error("The claude CLI is not on PATH");
    return cli;
  }

  /** Cache capabilities per binary; failed preflights expire after a minute. */
  detect(): Promise<DetectResult> {
    let cli: string;
    try {
      cli = this.cli();
    } catch {
      return Promise.resolve({ ok: false, missing: ["the claude CLI on PATH"], caps: { model: false, fallbackModel: false, effort: false } });
    }
    let d = detections.get(cli);
    if (!d || d.expires <= Date.now()) {
      const result = (async () => {
        const help = await runForText(cli, ["--help"]);
        if (!help.ok || !help.stdout.trim()) {
          return { ok: false, missing: ["a claude CLI that answers --help"], caps: { model: false, fallbackModel: false, effort: false }, cli };
        }
        const { missing, caps } = parseClaudeHelp(help.stdout);
        const ver = await runForText(cli, ["--version"]);
        const version = /\d+\.\d+\.\d+/.exec(ver.stdout)?.[0];
        return { ok: missing.length === 0, missing, caps, cli, ...(version && { version }) };
      })();
      d = { result, expires: Infinity };
      const cached = d;
      result.then((r) => { if (!r.ok) cached.expires = Date.now() + 60_000; });
      detections.set(cli, d);
    }
    return d.result;
  }

  private async start(l: WorkerLaunch, resume: boolean): Promise<WorkerHandle> {
    const d = await this.detect();
    if (!d.ok || !d.cli) throw new Error(`The claude CLI cannot run workers: missing ${d.missing.join(", ")}`);
    const args = buildWorkerArgs(l, d.caps, { resume });
    const env = childEnv("claude-worker", workerEnvExtras(l));
    const startedAt = new Date().toISOString();
    const { pid, started } = await spawnWorker({ file: d.cli, args, cwd: l.cwd, env, prompt: l.prompt, outputPath: l.outputPath });
    console.error(`[Worker] ${l.agent} ${resume ? "resumed" : "started"} on ${l.task} (attempt ${l.attempt}, pid ${pid}, session ${l.sessionId})`);
    return { agent: l.agent, task: l.task, attempt: l.attempt, pid, pgid: pid, started, sessionId: l.sessionId, outputPath: l.outputPath, startedAt };
  }

  /** Start a worker: detached in its own process group, cwd the task worktree, output appended to l.outputPath, the card on stdin. */
  launch(l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start(l, false);
  }

  /** Continue rec's session (--resume) with a new prompt; l carries the fresh files, budget and output path. */
  resume(rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start({ ...l, sessionId: rec.sessionId }, true);
  }

  parse(line: string, acc: RunAccumulator): void {
    parseClaudeLine(line, acc as WorkerRunAccumulator);
  }

  /** SIGTERM the worker's process group, then SIGKILL after the grace period (10 s by default). */
  async stop(h: WorkerHandle, reason: string): Promise<void> {
    const pgid = h.pgid ?? h.pid;
    console.error(`[Worker] stopping ${h.agent} (pid ${h.pid}): ${scrubAndCap(reason, 200)}`);
    await stopGroup(pgid, this.killGraceMs, h.started);
  }

  /**
   * A read-only answer from a live worker's context for a micro-huddle: a forked session with no
   * tools, in the worker's worktree (where its session lives), the question on stdin. The live run
   * is not disturbed. Usage is reported as huddle spend.
   */
  async answer(rec: WorkerRecord, question: string, maxUsd: number, signal?: AbortSignal): Promise<{ text: string; usage?: UsageRecord }> {
    signal?.throwIfAborted();
    const cli = (await this.detect()).cli ?? this.cli();
    signal?.throwIfAborted();
    const args = buildAnswerArgs(rec.sessionId, maxUsd);
    const cwd = realDirectory(rec.cwd);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(cli, args, { cwd, env: childEnv("claude-worker", { ROUNDTABLE_DOTENV: "off" }), detached: true, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const abort = () => signalGroup(child.pid ?? 0, "SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(child.pid ?? 0, "SIGKILL");
      }, this.answerTimeoutMs);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (s: string) => {
        stdout = (stdout + s).slice(-ANSWER_OUTPUT_MAX);
      });
      child.stderr!.on("data", (s: string) => {
        if (stderr.length < 64 * 1024) stderr += s;
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(question);
    });
    let r: Record<string, unknown> | undefined;
    for (const line of out.stdout.trim().split("\n").reverse()) {
      try {
        const o = JSON.parse(line);
        if (o && o.type === "result") {
          r = o;
          break;
        }
      } catch {
        /* not the result line */
      }
    }
    // A failed/stopped fork can still carry billed usage. Report it before interpreting its outcome.
    const cost = typeof r?.total_cost_usd === "number" && Number.isFinite(r.total_cost_usd) && r.total_cost_usd >= 0 ? r.total_cost_usd : undefined;
    const tokens = claudeTokens(r?.usage);
    if (tokens || cost !== undefined) reportUsage({ provider: "claude-code", model: mainModel(r?.modelUsage) ?? "claude-code", ...(tokens && { usage: tokens }), ...(cost !== undefined && { usd: cost }) });
    signal?.throwIfAborted();
    if (out.timedOut) throw new Error(`answer: claude timed out after ${this.answerTimeoutMs} ms`);
    if (!r || out.code !== 0 || r.is_error === true || typeof r.result !== "string") {
      const detail = scrubAndCap((typeof r?.result === "string" ? r.result : "") || out.stderr.trim() || out.stdout.trim(), 500);
      throw new Error(`answer: claude exited with ${out.code ?? "a signal"}${r?.subtype ? ` (${String(r.subtype)})` : ""}: ${detail || "no output"}`);
    }
    const usage: UsageRecord = {
      source: "huddle",
      agent: rec.agent,
      task: rec.task,
      provider: "claude-code",
      model: mainModel(r.modelUsage) ?? "claude-code",
      tokens: tokens ?? { inputTokens: 0, outputTokens: 0 },
      usd: cost ?? 0,
      estimated: cost === undefined,
      provenance: { tokens: tokens ? "measured" : "estimated", usd: cost === undefined ? "estimated" : "measured" },
    };
    return { text: r.result, usage };
  }
}
