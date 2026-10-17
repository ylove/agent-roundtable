// ============================================================================
// Starting the runner and judging whether one is alive (heads-down.md §2)
//
//   executions/<exe>/runner.lock/   the runner's mkdir lock (lock.ts): never taken from a live pid
//   executions/<exe>/runner.json    {pid, host, startedAt, heartbeatAt, version}, rewritten every 5 s;
//                                   stoppedAt and stopReason once it stops cleanly
//   executions/<exe>/runner.log     the runner's stdout and stderr (0600)
//
// A runner is alive while the pid that holds runner.lock lives on this host. A heartbeat older than
// 30 s marks it stale (reported, never stolen: a stalled holder must not wake up next to a second
// runner). A runner whose pid is dead is replaced; one on another host is refused.
//
// This module stays light: orchestrator tools call ensureRunner on every touch of a live run.
// ============================================================================

import { spawn } from "node:child_process";
import { closeSync, existsSync, fchmodSync, openSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { childEnv } from "../security/child-env.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { processReused, readLockOwner } from "./lock.js";
import { executionDir } from "./store.js";

export const RUNNER_HEARTBEAT_MS = 5_000;
/** A heartbeat older than this is stale (the pid is still checked before anything is replaced). */
export const RUNNER_STALE_MS = 30_000;

export interface RunnerInfo {
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  version: string;
  /** Set when the runner stopped cleanly; a runner.json without it after the pid died means a crash. */
  stoppedAt?: string;
  stopReason?: string;
}

export const runnerLockDir = (exe: string): string => join(executionDir(exe), "runner.lock");
export const runnerInfoPath = (exe: string): string => join(executionDir(exe), "runner.json");
export const runnerLogPath = (exe: string): string => join(executionDir(exe), "runner.log");

/** runner.json, or null when it is missing or malformed. */
export function readRunnerInfo(exe: string): RunnerInfo | null {
  try {
    const r = JSON.parse(readFileSync(runnerInfoPath(exe), "utf8")) as RunnerInfo;
    return r && Number.isSafeInteger(r.pid) && typeof r.heartbeatAt === "string" ? r : null;
  } catch {
    return null;
  }
}

export function writeRunnerInfo(exe: string, info: RunnerInfo): void {
  writeFileAtomic(runnerInfoPath(exe), JSON.stringify(info) + "\n");
}

export function newRunnerInfo(now = new Date()): RunnerInfo {
  const at = now.toISOString();
  return { pid: process.pid, host: hostname(), startedAt: at, heartbeatAt: at, version: VERSION };
}

export type RunnerLiveness =
  | { state: "running"; pid: number; heartbeatAt?: string; /** No heartbeat for 30 s, but its pid lives: reported, never replaced. */ stale: boolean }
  | { state: "stopped"; pid?: number; stoppedAt?: string; reason?: string }
  | { state: "dead"; pid: number; heartbeatAt?: string }
  | { state: "other_host"; pid: number; host: string };

/** Whether a runner holds the execution now, judged by runner.lock's owner and runner.json. */
export function runnerLiveness(exe: string, now = Date.now()): RunnerLiveness {
  const info = readRunnerInfo(exe);
  const owner = readLockOwner(runnerLockDir(exe));
  const heartbeat = info && (!owner || info.pid === owner.pid) ? info.heartbeatAt : undefined;
  if (owner) {
    if (owner.host !== hostname()) return { state: "other_host", pid: owner.pid, host: owner.host };
    if (pidAlive(owner.pid) && !processReused(owner.pid, owner.started)) {
      const at = heartbeat ? Date.parse(heartbeat) : NaN;
      const stale = !Number.isFinite(at) ? Date.parse(owner.at) < now - RUNNER_STALE_MS : now - at > RUNNER_STALE_MS;
      return { state: "running", pid: owner.pid, ...(heartbeat && { heartbeatAt: heartbeat }), stale };
    }
    return { state: "dead", pid: owner.pid, ...(heartbeat && { heartbeatAt: heartbeat }) };
  }
  if (!info) return { state: "stopped" };
  if (info.stoppedAt) return { state: "stopped", pid: info.pid, stoppedAt: info.stoppedAt, ...(info.stopReason && { reason: info.stopReason }) };
  return { state: "dead", pid: info.pid, heartbeatAt: info.heartbeatAt };
}

// ============================================================================
// Launching
// ============================================================================

export interface LaunchRunnerOptions {
  /** The built CLI (default: dist/index.js of this package). */
  cliPath?: string;
  /** Default process.execPath. */
  execPath?: string;
  /** Added to childEnv("runner") (tests). */
  env?: Record<string, string>;
}

const defaultCli = (): string => fileURLToPath(new URL("../index.js", import.meta.url));

/**
 * Start `agent-roundtable run <exe>` detached, in its own session, with stdout and stderr appended
 * to runner.log (0600) and cwd the repository root, so it outlives the MCP host and the server's
 * process group. Returns its pid; the runner itself takes runner.lock (a second one refuses).
 */
export function launchRunner(exe: string, opts: LaunchRunnerOptions = {}): { pid: number; log: string } {
  const dir = executionDir(exe);
  let repoRoot: string;
  try {
    repoRoot = (JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")) as { repo_root: string }).repo_root;
  } catch {
    throw new Error(`Execution ${exe} not found`);
  }
  if (typeof repoRoot !== "string" || !existsSync(repoRoot)) throw new Error(`Execution ${exe}: its repository ${String(repoRoot)} is gone`);
  const log = runnerLogPath(exe);
  const fd = openSync(log, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const child = spawn(opts.execPath ?? process.execPath, [opts.cliPath ?? defaultCli(), "run", exe], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: repoRoot,
      env: childEnv("runner", opts.env ?? {}),
      shell: false,
      windowsHide: true,
    });
    child.on("error", () => {
      /* reported through runner.log and the next ensureRunner */
    });
    if (child.pid === undefined) throw new Error("the runner did not start");
    child.unref();
    return { pid: child.pid, log };
  } finally {
    closeSync(fd);
  }
}

export interface EnsureRunnerResult {
  /** running: one holds the run; launched: none did and one was started; terminal: the run is over, none is needed. */
  status: "running" | "launched" | "terminal";
  pid?: number;
  heartbeatAt?: string;
  stale?: boolean;
}

const TERMINAL = new Set(["completed", "failed", "aborted"]);

/**
 * Make sure a runner holds the execution: start one when none is alive (its pid dead, or it
 * stopped). A live runner is never replaced, however stale its heartbeat. Throws when a runner on
 * another host holds it. Every orchestrator tool that touches a live run calls this.
 */
export async function ensureRunner(exe: string, opts: LaunchRunnerOptions = {}): Promise<EnsureRunnerResult> {
  const live = runnerLiveness(exe);
  if (live.state === "other_host") {
    throw new Error(`Execution ${exe} is held by a runner on host ${live.host} (pid ${live.pid}); 1.0 supports one host per home directory`);
  }
  if (live.state === "running") return { status: "running", pid: live.pid, stale: live.stale, ...(live.heartbeatAt && { heartbeatAt: live.heartbeatAt }) };
  const { openExecutionStore } = await import("./store.js");
  const state = await (await openExecutionStore(exe)).state();
  if (TERMINAL.has(state.status)) return { status: "terminal" };
  return { status: "launched", pid: launchRunner(exe, opts).pid };
}
