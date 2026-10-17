// ============================================================================
// The codex worker driver (optional, opt-in with ROUNDTABLE_ALLOW_CODEX_DRIVER=1)
//
// `codex exec --json` in the task worktree, the user's config and .rules files ignored, a core-only
// shell environment, and the roundtable worker server as its only MCP server (passed with -c, from
// the mcp.json prepareWorkerFiles wrote). The prompt goes in on stdin ("-"), with prompt.md in front
// of the task card, since codex takes no system prompt file.
//
// Codex's own sandbox confines the commands it runs. Its built-in workspace-write mode lets them read
// every file the user can, so the driver passes a permissions profile instead (codexFilesystemPolicy):
// the user's home directory, ROUNDTABLE_HOME (every token, event log and other worktree) and the
// repository checkout (its .env) are unreadable; the task worktree is the one writable root; the
// node toolchain and the repository's git directory stay readable when they sit inside a denied root.
// Everything else on the machine stays readable (it is a deny list, not an allow list), and the
// profile has no network. That is what was verified with codex-cli 0.162.1 (`codex sandbox`).
//
// Leases are enforced at submit only: codex's shell can write any file of the worktree, and it has
// no PreToolUse hook. submit_work commits only leased paths and rejects the submission when
// anything else changed. Codex reports no dollar cost and has no budget flag, so its usage is priced
// from the table (estimated) and the watchdog enforces its budget.
// Every flag here was checked against `codex exec --help` and `codex exec resume --help`.
// ============================================================================

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { findExecutable } from "../executables.js";
import { executionDir } from "../execution/store.js";
import type { ExecutionHeader, RunAccumulator, WorkerDriver, WorkerHandle, WorkerLaunch, WorkerRecord } from "../execution/types.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { workerEnvExtras } from "./claude-code.js";
import { ROUNDTABLE_SERVER, type McpConfig } from "./files.js";
import { realDirectory, spawnWorker, stopGroup } from "./process.js";

/** Opt-in: codex workers can read whatever their permissions profile leaves readable on this machine. */
export const ALLOW_CODEX_ENV = "ROUNDTABLE_ALLOW_CODEX_DRIVER";

export function codexDriverAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ALLOW_CODEX_ENV] ?? "").trim() === "1";
}

const NOT_ALLOWED =
  `${ALLOW_CODEX_ENV}=1 (the codex driver is opt-in: its workers can read every file outside the user's home directory, ` +
  "ROUNDTABLE_HOME and the repository checkout)";

/** A TOML basic string (JSON's escapes are a subset of TOML's). */
const tomlString = (s: string) => JSON.stringify(s);

export interface CodexMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ============================================================================
// The permissions profile
// ============================================================================

export const CODEX_PROFILE = "roundtable";

export interface CodexFilesystemPolicy {
  /** The task worktree: the only writable root. */
  worktree: string;
  /** Roots no command may read or write. */
  deny: string[];
  /** Roots inside a denied one that commands may still read. */
  read: string[];
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** Toolchain roots commands need beyond codex's `:minimal` platform set (node's OpenSSL config on macOS). */
const PLATFORM_READ: Record<string, string[]> = {
  darwin: ["/System/Library/OpenSSL", "/usr/local", "/opt/homebrew"],
  linux: ["/usr/local", "/etc/ssl", "/usr/lib/ssl"],
};

/** Extra readable roots for other toolchains (colon-separated absolute paths). */
export const CODEX_READ_ROOTS_ENV = "ROUNDTABLE_CODEX_READ_ROOTS";

/**
 * The profile for one worker. A `none` entry puts codex's sandbox in restricted-read mode, where
 * commands read only codex's `:minimal` platform set, the temp directories and the roots listed
 * here: the worktree (the one writable root), the node toolchain (the install root of execPath),
 * the repository's git directory, the platform's toolchain roots and ROUNDTABLE_CODEX_READ_ROOTS.
 * The user's home, ROUNDTABLE_HOME and the repository checkout are denied outright, so no read
 * root (other than those named) re-opens them.
 */
export function codexFilesystemPolicy(o: {
  worktree: string;
  repoRoot: string;
  home?: string;
  roundtableHome?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): CodexFilesystemPolicy {
  const worktree = real(o.worktree);
  const deny = [...new Set([o.home ?? homedir(), o.roundtableHome ?? ROUNDTABLE_HOME, o.repoRoot].map(real))];
  const extra = ((o.env ?? process.env)[CODEX_READ_ROOTS_ENV] ?? "").split(":").map((s) => s.trim()).filter((s) => isAbsolute(s));
  const candidates = [
    dirname(dirname(real(o.execPath ?? process.execPath))),
    join(real(o.repoRoot), ".git"),
    ...(PLATFORM_READ[o.platform ?? process.platform] ?? []),
    ...extra,
  ];
  const read = [...new Set(candidates.filter((p) => existsSync(p)).map(real))].filter((p) => !under(p, worktree) && !deny.includes(p));
  return { worktree, deny, read };
}

/** `-c default_permissions=… -c permissions.roundtable.filesystem={…}` (pure). */
export function codexPermissionArgs(p: CodexFilesystemPolicy): string[] {
  const entries: Array<[string, "read" | "write" | "none"]> = [
    [":minimal", "read"],
    ...p.deny.map((d) => [d, "none"] as [string, "none"]),
    ...p.read.map((r) => [r, "read"] as [string, "read"]),
    [p.worktree, "write"],
  ];
  for (const [path] of entries) {
    if (path !== ":minimal" && (!isAbsolute(path) || /[\0-\x1f]/.test(path))) throw new Error(`codex: not an absolute path: ${path}`);
  }
  return [
    "-c", `default_permissions=${tomlString(CODEX_PROFILE)}`,
    "-c", `permissions.${CODEX_PROFILE}.filesystem={${entries.map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(",")}}`,
  ];
}

/** The -c overrides shared by exec and exec resume. */
function codexConfig(mcp: CodexMcpServer, fs: CodexFilesystemPolicy, model?: string): string[] {
  const env = Object.entries(mcp.env).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`codex: invalid env name ${k}`);
    return `${k}=${tomlString(v)}`;
  });
  const out = [
    ...codexPermissionArgs(fs),
    "-c", "shell_environment_policy.inherit=core",
    // The home directory is unreadable, and git treats an unreadable ~/.gitconfig as fatal.
    "-c", 'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null",GIT_CONFIG_NOSYSTEM="1"}',
    "-c", 'approval_policy="never"',
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.command=${tomlString(mcp.command)}`,
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.args=[${mcp.args.map(tomlString).join(",")}]`,
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.env={${env.join(",")}}`,
    // Codex asks before an MCP tool that is not read-only, and approval_policy "never" would refuse
    // lease, post_update and submit_work. The roundtable server is the worker's own interface.
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.default_tools_approval_mode="approve"`,
  ];
  if (model) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error(`codex: invalid model ${model}`);
    out.push("-m", model);
  }
  return out;
}

/** `codex exec --json -C <wt> --ignore-user-config --ignore-rules -c … -` (pure). */
export function buildCodexArgs(l: Pick<WorkerLaunch, "cwd" | "model">, mcp: CodexMcpServer, fs: CodexFilesystemPolicy): string[] {
  if (!l.cwd.startsWith("/")) throw new Error("buildCodexArgs: cwd must be an absolute path");
  return ["exec", "--json", "-C", l.cwd, "--ignore-user-config", "--ignore-rules", ...codexConfig(mcp, fs, l.model), "-"];
}

/** `codex exec resume --json --ignore-user-config --ignore-rules -c … <thread> -` (pure; cwd is the spawn's). */
export function buildCodexResumeArgs(thread: string, l: Pick<WorkerLaunch, "model">, mcp: CodexMcpServer, fs: CodexFilesystemPolicy): string[] {
  if (!/^[0-9A-Za-z][0-9A-Za-z-]{0,127}$/.test(thread)) throw new Error(`buildCodexResumeArgs: invalid thread id ${thread}`);
  return ["exec", "resume", "--json", "--ignore-user-config", "--ignore-rules", ...codexConfig(mcp, fs, l.model), thread, "-"];
}

/**
 * Agents of the execution whose single-use token file still waits for its worker server. A codex
 * worker is launched only when there are none besides its own: the runner prepares each worker's
 * files right before launching it, and waits for the other tokens to be consumed first.
 */
export function pendingTokens(execution: string, exceptAgent?: string): string[] {
  const dir = join(executionDir(execution), "agents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n !== exceptAgent && existsSync(join(dir, n, "token")));
}

function readExecutionHeader(execution: string): ExecutionHeader {
  return JSON.parse(readFileSync(join(executionDir(execution), "execution.json"), "utf8")) as ExecutionHeader;
}

/** The roundtable server from a prepared mcp.json. */
export function readCodexMcpServer(mcpConfigPath: string): CodexMcpServer {
  const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as McpConfig;
  const s = cfg?.mcpServers?.[ROUNDTABLE_SERVER];
  if (!s || typeof s.command !== "string" || !Array.isArray(s.args)) throw new Error(`${mcpConfigPath} has no ${ROUNDTABLE_SERVER} server`);
  return { command: s.command, args: s.args.map(String), env: { ...(s.env ?? {}) } };
}

const TEXT_MAX = 4000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** One line of `codex exec --json`: thread.started, item.completed, turn.completed (usage), turn.failed, error. */
export function parseCodexLine(line: string, acc: RunAccumulator & { mcpTools?: string[] }): void {
  acc.lines++;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== "object") return;
  switch (o.type) {
    case "thread.started":
      if (typeof o.thread_id === "string") acc.sessionId = o.thread_id;
      break;
    case "item.completed": {
      const item = (o.item ?? {}) as Record<string, unknown>;
      const kind = item.type ?? item.item_type;
      if ((kind === "agent_message" || kind === "assistant_message") && typeof item.text === "string" && item.text.trim()) {
        acc.lastText = item.text.trim().slice(-TEXT_MAX);
      } else if (kind === "mcp_tool_call" && typeof item.server === "string") {
        if (!(acc.mcpServers ??= []).includes(item.server)) acc.mcpServers.push(item.server);
      }
      break;
    }
    case "turn.completed": {
      const u = (o.usage ?? {}) as Record<string, unknown>;
      const prev = acc.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      acc.usage = {
        inputTokens: prev.inputTokens + num(u.input_tokens),
        outputTokens: prev.outputTokens + num(u.output_tokens) + num(u.reasoning_output_tokens),
        cacheReadTokens: (prev.cacheReadTokens ?? 0) + num(u.cached_input_tokens),
      };
      acc.done = true;
      acc.resultSubtype ??= "success";
      break;
    }
    case "turn.failed": {
      const err = (o.error ?? {}) as { message?: unknown };
      acc.done = true;
      acc.isError = true;
      acc.resultSubtype = "error";
      if (typeof err.message === "string") acc.lastText = scrubAndCap(err.message, TEXT_MAX);
      break;
    }
    case "error":
      acc.isError = true;
      if (typeof o.message === "string") acc.lastText = scrubAndCap(o.message, TEXT_MAX);
      break;
  }
}

export interface CodexDriverOptions {
  cli?: string;
  killGraceMs?: number;
  /** Source of ROUNDTABLE_ALLOW_CODEX_DRIVER (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export class CodexDriver implements WorkerDriver {
  readonly id = "codex" as const;
  private readonly cliOverride?: string;
  private readonly killGraceMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: CodexDriverOptions = {}) {
    this.cliOverride = opts.cli;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
    this.env = opts.env ?? process.env;
  }

  private cli(): string {
    const cli = this.cliOverride ?? findExecutable("codex");
    if (!cli) throw new Error("The codex CLI is not on PATH");
    return cli;
  }

  /** Not ok unless ROUNDTABLE_ALLOW_CODEX_DRIVER=1 and codex is on PATH. */
  async detect(): Promise<{ ok: boolean; version?: string; missing: string[] }> {
    const missing: string[] = [];
    if (!codexDriverAllowed(this.env)) missing.push(NOT_ALLOWED);
    try {
      this.cli();
    } catch {
      missing.push("the codex CLI on PATH");
    }
    return { ok: missing.length === 0, missing };
  }

  /** Refuse unless opted in and no other worker's token file is still on disk. */
  private preflight(l: WorkerLaunch): void {
    if (!codexDriverAllowed(this.env)) throw new Error(`The codex driver needs ${NOT_ALLOWED}`);
    const pending = pendingTokens(l.execution, l.agent);
    if (pending.length) {
      throw new Error(
        `Not launching a codex worker while ${pending.join(", ")} ${pending.length === 1 ? "has" : "have"} an unconsumed token file; ` +
          "launch it once their worker servers have started (prepare each worker's files right before its launch)"
      );
    }
  }

  private policy(l: WorkerLaunch): CodexFilesystemPolicy {
    return codexFilesystemPolicy({ worktree: realDirectory(l.cwd), repoRoot: readExecutionHeader(l.execution).repo_root });
  }

  private async start(l: WorkerLaunch, args: string[]): Promise<WorkerHandle> {
    const system = readFileSync(l.appendPromptPath, "utf8");
    const env = childEnv("codex-worker", workerEnvExtras(l));
    const startedAt = new Date().toISOString();
    const { pid, started } = await spawnWorker({ file: this.cli(), args, cwd: realDirectory(l.cwd), env, prompt: `${system.trim()}\n\n---\n\n${l.prompt}`, outputPath: l.outputPath });
    return { agent: l.agent, task: l.task, attempt: l.attempt, pid, pgid: pid, started, sessionId: l.sessionId, outputPath: l.outputPath, startedAt };
  }

  launch(l: WorkerLaunch): Promise<WorkerHandle> {
    this.preflight(l);
    return this.start(l, buildCodexArgs({ cwd: realDirectory(l.cwd), model: l.model }, readCodexMcpServer(l.mcpConfigPath), this.policy(l)));
  }

  /** rec.sessionId is the codex thread id (thread.started), which the runner records from the stream. */
  resume(rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle> {
    this.preflight(l);
    return this.start({ ...l, sessionId: rec.sessionId }, buildCodexResumeArgs(rec.sessionId, l, readCodexMcpServer(l.mcpConfigPath), this.policy(l)));
  }

  parse(line: string, acc: RunAccumulator): void {
    parseCodexLine(line, acc);
  }

  async stop(h: WorkerHandle, reason: string): Promise<void> {
    console.error(`[Worker] stopping ${h.agent} (pid ${h.pid}): ${scrubAndCap(reason, 200)}`);
    await stopGroup(h.pgid ?? h.pid, this.killGraceMs, h.started);
  }
}
