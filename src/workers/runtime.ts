// ============================================================================
// The runtime worker driver: a runtime profile (hermes, openclaw, gemini or a configured one) as a
// heads-down worker, `workers.driver: "runtime:<name>"`, opt-in with ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1
//
// The runtime runs under a small wrapper (runtime-wrapper.ts) that the output relay starts in the
// task worktree: the wrapper takes the prompt (prompt.md, then the task card) on stdin, fills the
// profile's `{prompt}` argument or writes it to the runtime's stdin, runs the profile's argv with an
// allowlisted environment, and relays the runtime's output as JSON lines that the monitor reads.
// When the runtime exits 0 the wrapper reports its final text, usage and cost (estimated from text
// lengths and priced from the pricing table when the runtime reports none).
//
// How the worker submits:
//  - a profile with MCP support (gemini) is given the roundtable worker server through a settings file
//    (RUNTIME_SETTINGS_FILE, named by GEMINI_CLI_SYSTEM_SETTINGS_PATH) and calls submit_work itself;
//  - any other profile cannot call tools: the wrapper consumes the worker's token itself, before the
//    runtime starts, and on exit 0 calls the same submit_work with the runtime's final output as the
//    summary. A non-zero exit fails the attempt and nothing is submitted.
// Leases are enforced at submit only (submit_work commits leased paths and rejects anything else).
//
// Confinement: gemini is started with its own --sandbox flag. The other profiles have none: their
// commands run with the user's permissions inside the task worktree, and the launch log says so.
// ============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../executables.js";
import type { RunAccumulator, RuntimeDriverId, WorkerDriver, WorkerHandle, WorkerLaunch, WorkerRecord } from "../execution/types.js";
import { getRuntime } from "../runtimes/registry.js";
import type { RuntimeSpec } from "../runtimes/spec.js";
import {
  buildRuntimeWorkerArgv, GEMINI_SETTINGS_ENV, RUNTIME_WORKERS_NOT_ALLOWED, runtimeDriverName, runtimeDriverProblem, runtimeWorkersAllowed,
  workerProfile, type RuntimeWorkerProfile,
} from "../runtimes/worker.js";
import { childEnv } from "../security/child-env.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { scrubAndCap } from "../security/secrets.js";
import { workerEnvExtras } from "./claude-code.js";
import { pendingTokens, readCodexMcpServer } from "./codex.js";
import { ROUNDTABLE_SERVER, RUNTIME_SETTINGS_FILE } from "./files.js";
import { realDirectory, spawnWorker, stopGroup } from "./process.js";

// ----------------------------------------------------------------------------
// The wrapper's lines (runtime-wrapper.ts writes them; the driver's parse reads them)
// ----------------------------------------------------------------------------

export const LINE_OUTPUT = "roundtable.runtime.output";
export const LINE_HEARTBEAT = "roundtable.runtime.heartbeat";
export const LINE_RESULT = "roundtable.runtime.result";

/** The final line of a run. `usage_estimated` is true when the token counts come from text lengths. */
export interface RuntimeResultLine {
  type: typeof LINE_RESULT;
  ok: boolean;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  usage_estimated: boolean;
  cost_usd?: number;
  model?: string;
  submitted?: boolean;
}

/** What the wrapper is started with (one JSON argument; no secret and no prompt in it). */
export interface RuntimeWrapperConfig {
  v: 1;
  runtime: string;
  binary: string;
  /** The runtime's arguments with the single whole-argument `{prompt}` placeholder, if it takes the prompt on argv. */
  args: string[];
  output: RuntimeSpec["output"];
  usage?: RuntimeSpec["usage"];
  stdoutMaxBytes: number;
  /** "driver": the wrapper submits when the runtime exits 0; "server": the runtime submits through the worker server. */
  submit: "driver" | "server";
  model?: string;
  execution: string;
  agent: string;
  tokenFile: string;
}

const TEXT_MAX = 4000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Roughly four characters per token: the estimate used when a runtime reports no usage. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/** One line of the wrapper's stream into the accumulator; anything else (and any other `type`) is ignored. */
export function parseRuntimeLine(line: string, acc: RunAccumulator): void {
  acc.lines++;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== "object" || o.type !== LINE_RESULT) return;
  const u = (o.usage ?? {}) as Record<string, unknown>;
  const prev = acc.usage ?? { inputTokens: 0, outputTokens: 0 };
  acc.usage = { inputTokens: prev.inputTokens + num(u.inputTokens), outputTokens: prev.outputTokens + num(u.outputTokens) };
  if (o.usage_estimated === true) acc.tokensEstimated = true;
  if (typeof o.cost_usd === "number" && Number.isFinite(o.cost_usd) && o.cost_usd >= 0) acc.costUsd = (acc.costUsd ?? 0) + o.cost_usd;
  if (typeof o.model === "string") (acc as RunAccumulator & { model?: string }).model = o.model;
  if (typeof o.text === "string" && o.text.trim()) acc.lastText = o.text.trim().slice(-TEXT_MAX);
  acc.done = true;
  if (o.ok === true) acc.resultSubtype ??= "success";
  else {
    acc.isError = true;
    acc.resultSubtype = "error";
  }
}

// ----------------------------------------------------------------------------
// The driver
// ----------------------------------------------------------------------------

export interface RuntimeWorkerDriverOptions {
  killGraceMs?: number;
  /** Source of ROUNDTABLE_ALLOW_RUNTIME_WORKERS and the api-key variables (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Replace the wrapper script (tests). */
  wrapperPath?: string;
}

const WRAPPER = fileURLToPath(new URL("./runtime-wrapper.js", import.meta.url));

/** The runtime's profile and spec, or why it cannot run a worker. */
function resolveRuntime(id: RuntimeDriverId, env: NodeJS.ProcessEnv): { name: string; spec: RuntimeSpec; profile: RuntimeWorkerProfile } {
  const problem = runtimeDriverProblem(id, env);
  if (problem) throw new Error(`The ${id} driver: ${problem}`);
  const name = runtimeDriverName(id);
  return { name, spec: getRuntime(name)!, profile: workerProfile(name) };
}

/** The launch log line: what confines the runtime's commands, said plainly. */
export function confinementNote(name: string, profile: RuntimeWorkerProfile): string {
  return profile.sandboxed
    ? `${name}'s commands are confined by ${name}'s own sandbox flag`
    : `${name} has no sandbox flag: its commands run with the user's permissions inside the task worktree`;
}

export class RuntimeWorkerDriver implements WorkerDriver {
  readonly id: RuntimeDriverId;
  private readonly killGraceMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly wrapper: string;

  constructor(id: RuntimeDriverId, opts: RuntimeWorkerDriverOptions = {}) {
    this.id = id;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
    this.env = opts.env ?? process.env;
    this.wrapper = opts.wrapperPath ?? WRAPPER;
  }

  /** Not ok unless the opt-in is set, the runtime is known and its binary is on PATH. */
  async detect(): Promise<{ ok: boolean; version?: string; missing: string[] }> {
    const missing: string[] = [];
    if (!runtimeWorkersAllowed(this.env)) missing.push(RUNTIME_WORKERS_NOT_ALLOWED);
    else {
      const problem = runtimeDriverProblem(this.id, this.env);
      if (problem) missing.push(problem);
      else if (!resolveExecutable(getRuntime(runtimeDriverName(this.id))!.argv[0], this.env.PATH)) missing.push(`the ${runtimeDriverName(this.id)} CLI on PATH`);
    }
    return { ok: missing.length === 0, missing };
  }

  /** Refuse connectors, a missing opt-in and any other worker's unconsumed token file. */
  private preflight(l: WorkerLaunch): void {
    if (l.connectors?.length) throw new Error("Connectors are not supported by runtime workers; use claude-code.");
    if (!runtimeWorkersAllowed(this.env)) throw new Error(`The ${this.id} driver needs ${RUNTIME_WORKERS_NOT_ALLOWED}`);
    // The runtime may be unsandboxed: no other worker's single-use token may be readable while it runs.
    const pending = pendingTokens(l.execution, l.agent);
    if (pending.length) {
      throw new Error(
        `Not launching a ${this.id} worker while ${pending.join(", ")} ${pending.length === 1 ? "has" : "have"} an unconsumed token file; ` +
          "launch it once their worker servers have started (prepare each worker's files right before its launch)"
      );
    }
  }

  /** The wrapper's config, and the settings file the profile's MCP server needs (pure but for the PATH lookup). */
  private plan(l: WorkerLaunch): { config: RuntimeWrapperConfig; profile: RuntimeWorkerProfile; name: string } {
    const { name, spec, profile } = resolveRuntime(this.id, this.env);
    const binary = resolveExecutable(spec.argv[0], this.env.PATH);
    if (!binary) throw new Error(`The ${name} CLI is not on PATH`);
    const [, ...args] = buildRuntimeWorkerArgv(spec, profile, l.model);
    const config: RuntimeWrapperConfig = {
      v: 1, runtime: name, binary, args, output: spec.output,
      ...(spec.usage && { usage: spec.usage }),
      stdoutMaxBytes: spec.stdoutMaxBytes ?? 16_777_216,
      submit: profile.mcp ? "server" : "driver",
      ...(l.model && { model: l.model }),
      execution: l.execution, agent: l.agent, tokenFile: join(dirname(l.mcpConfigPath), "token"),
    };
    return { config, profile, name };
  }

  private async start(l: WorkerLaunch): Promise<WorkerHandle> {
    this.preflight(l);
    const { config, profile, name } = this.plan(l);
    const cwd = realDirectory(l.cwd);
    const extras: Record<string, string | undefined> = { ...workerEnvExtras(l) };
    // The runtime's own login is used. Only with ROUNDTABLE_WORKER_AUTH=api_key do the profile's key variables pass.
    const spec = getRuntime(name)!;
    for (const k of [...(spec.env ?? []), ...(((this.env.ROUNDTABLE_WORKER_AUTH ?? "").toLowerCase() === "api_key") ? profile.apiKeyEnv : [])]) {
      if (typeof this.env[k] === "string") extras[k] = this.env[k];
    }
    const cleanupPaths: string[] = [];
    if (profile.mcp) {
      const settings = join(dirname(l.mcpConfigPath), RUNTIME_SETTINGS_FILE);
      const server = readCodexMcpServer(l.mcpConfigPath); // refuses connector servers
      writeFileAtomic(settings, JSON.stringify({ mcpServers: { [ROUNDTABLE_SERVER]: { command: server.command, args: server.args, env: server.env, trust: true } } }) + "\n");
      extras[GEMINI_SETTINGS_ENV] = settings;
      cleanupPaths.push(settings);
    }
    const env = childEnv("runtime-worker", extras, this.env);
    const system = readFileSync(l.appendPromptPath, "utf8");
    console.error(`[Worker] ${l.agent} starting on ${l.task} with runtime ${name} (attempt ${l.attempt}): ${confinementNote(name, profile)}`);
    const startedAt = new Date().toISOString();
    const { pid, started } = await spawnWorker({
      file: process.execPath, args: [this.wrapper, JSON.stringify(config)], cwd, env,
      prompt: `${system.trim()}\n\n---\n\n${l.prompt}`, outputPath: l.outputPath, cleanupPaths,
    });
    return { agent: l.agent, task: l.task, attempt: l.attempt, pid, pgid: pid, started, sessionId: l.sessionId, outputPath: l.outputPath, startedAt };
  }

  launch(l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start(l);
  }

  /** Runtime conversations are not resumed: a resume starts a fresh run with the new task card. */
  resume(_rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle> {
    return this.start(l);
  }

  parse(line: string, acc: RunAccumulator): void {
    parseRuntimeLine(line, acc);
  }

  async stop(h: WorkerHandle, reason: string): Promise<void> {
    console.error(`[Worker] stopping ${h.agent} (pid ${h.pid}): ${scrubAndCap(reason, 200)}`);
    await stopGroup(h.pgid ?? h.pid, this.killGraceMs, h.started);
  }
}
