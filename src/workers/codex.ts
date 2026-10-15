// ============================================================================
// The codex worker driver (optional)
//
// `codex exec --json` in the task worktree with its own workspace-write sandbox (no network), the
// user's config ignored, a core-only shell environment, and the roundtable worker server as its
// only MCP server (passed with -c, from the mcp.json prepareWorkerFiles wrote). The prompt goes in
// on stdin ("-"), with prompt.md in front of the task card, since codex takes no system prompt file.
//
// Leases are enforced at submit only: codex keeps its own sandboxed shell, which can write any file
// of the worktree, and it has no PreToolUse hook. submit_work commits only leased paths and
// rejects the submission when anything else changed. Codex reports no dollar cost and has no
// budget flag, so its usage is recorded as estimated and the watchdog enforces its budget.
// Every flag here was checked against `codex exec --help` of codex-cli 0.162.1.
// ============================================================================

import { readFileSync } from "node:fs";
import { findExecutable } from "../executables.js";
import type { RunAccumulator, WorkerDriver, WorkerHandle, WorkerLaunch, WorkerRecord } from "../execution/types.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { workerEnvExtras } from "./claude-code.js";
import { ROUNDTABLE_SERVER, type McpConfig } from "./files.js";
import { realDirectory, spawnWorker, stopGroup } from "./process.js";

/** A TOML basic string (JSON's escapes are a subset of TOML's). */
const tomlString = (s: string) => JSON.stringify(s);

export interface CodexMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The -c overrides shared by exec and exec resume. */
function codexConfig(mcp: CodexMcpServer, model?: string): string[] {
  const env = Object.entries(mcp.env).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`codex: invalid env name ${k}`);
    return `${k}=${tomlString(v)}`;
  });
  const out = [
    "-c", "shell_environment_policy.inherit=core",
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", 'approval_policy="never"',
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.command=${tomlString(mcp.command)}`,
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.args=[${mcp.args.map(tomlString).join(",")}]`,
    "-c", `mcp_servers.${ROUNDTABLE_SERVER}.env={${env.join(",")}}`,
  ];
  if (model) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new Error(`codex: invalid model ${model}`);
    out.push("-m", model);
  }
  return out;
}

/** `codex exec --json -C <wt> -s workspace-write --ignore-user-config -c … -` (pure). */
export function buildCodexArgs(l: Pick<WorkerLaunch, "cwd" | "model">, mcp: CodexMcpServer): string[] {
  if (!l.cwd.startsWith("/")) throw new Error("buildCodexArgs: cwd must be an absolute path");
  return ["exec", "--json", "-C", l.cwd, "-s", "workspace-write", "--ignore-user-config", ...codexConfig(mcp, l.model), "-"];
}

/** `codex exec resume --json --ignore-user-config -c sandbox_mode=… -c … <thread> -` (pure; cwd is the spawn's). */
export function buildCodexResumeArgs(thread: string, l: Pick<WorkerLaunch, "model">, mcp: CodexMcpServer): string[] {
  if (!/^[0-9A-Za-z][0-9A-Za-z-]{0,127}$/.test(thread)) throw new Error(`buildCodexResumeArgs: invalid thread id ${thread}`);
  return ["exec", "resume", "--json", "--ignore-user-config", "-c", 'sandbox_mode="workspace-write"', ...codexConfig(mcp, l.model), thread, "-"];
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
}

export class CodexDriver implements WorkerDriver {
  readonly id = "codex" as const;
  private readonly cliOverride?: string;
  private readonly killGraceMs: number;

  constructor(opts: CodexDriverOptions = {}) {
    this.cliOverride = opts.cli;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
  }

  private cli(): string {
    const cli = this.cliOverride ?? findExecutable("codex");
    if (!cli) throw new Error("The codex CLI is not on PATH");
    return cli;
  }

  async detect(): Promise<{ ok: boolean; version?: string; missing: string[] }> {
    try {
      this.cli();
      return { ok: true, missing: [] };
    } catch {
      return { ok: false, missing: ["the codex CLI on PATH"] };
    }
  }

  private async start(l: WorkerLaunch, args: string[]): Promise<WorkerHandle> {
    const system = readFileSync(l.appendPromptPath, "utf8");
    const env = childEnv("codex-worker", workerEnvExtras(l));
    const startedAt = new Date().toISOString();
    const { pid } = await spawnWorker({ file: this.cli(), args, cwd: realDirectory(l.cwd), env, prompt: `${system.trim()}\n\n---\n\n${l.prompt}`, outputPath: l.outputPath });
    return { agent: l.agent, task: l.task, attempt: l.attempt, pid, pgid: pid, sessionId: l.sessionId, outputPath: l.outputPath, startedAt };
  }

  launch(l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start(l, buildCodexArgs({ cwd: realDirectory(l.cwd), model: l.model }, readCodexMcpServer(l.mcpConfigPath)));
  }

  /** rec.sessionId is the codex thread id (thread.started), which the runner records from the stream. */
  resume(rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start({ ...l, sessionId: rec.sessionId }, buildCodexResumeArgs(rec.sessionId, l, readCodexMcpServer(l.mcpConfigPath)));
  }

  parse(line: string, acc: RunAccumulator): void {
    parseCodexLine(line, acc);
  }

  async stop(h: WorkerHandle, reason: string): Promise<void> {
    console.error(`[Worker] stopping ${h.agent} (pid ${h.pid}): ${scrubAndCap(reason, 200)}`);
    await stopGroup(h.pgid ?? h.pid, this.killGraceMs);
  }
}
