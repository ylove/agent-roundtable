// ============================================================================
// Worker processes: detached spawns whose output goes to a file, and process-group stops
//
// A worker leads its own process group (detached), so stopping it also stops what it started
// (its MCP server, tool processes). A detached relay owns the group and scrubs stdout/stderr
// into runs/<attempt>.jsonl, surviving runner restart so adoption can keep tailing that file.
// The prompt goes in on stdin; nothing of it is ever on argv.
// ============================================================================

import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirPrivate } from "../security/fs-safe.js";

export interface SpawnWorkerOptions {
  /** Absolute path of the CLI (found on PATH by the driver). */
  file: string;
  args: string[];
  /** The task worktree. */
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, which is then closed. */
  prompt: string;
  outputPath: string;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const exits = new Map<number, Promise<WorkerExit>>();

/** A real directory (not a symlink), as its canonical path. */
export function realDirectory(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a directory`);
  return realpathSync(path);
}

/**
 * Spawn a worker detached in its own process group, stdout and stderr appended to outputPath
 * (0600), the prompt on stdin. Resolves with the pid once the process has started; rejects when
 * it could not start.
 */
export function spawnWorker(o: SpawnWorkerOptions): Promise<{ pid: number }> {
  const cwd = realDirectory(o.cwd);
  mkdirPrivate(dirname(o.outputPath));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL("./output-relay.js", import.meta.url))], {
        cwd, env: process.env, detached: true, shell: false, windowsHide: true,
        stdio: ["pipe", "ignore", "ignore", "ipc"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    const exited = new Promise<WorkerExit>((res) => child.once("exit", (code, signal) => res({ code, signal })));
    child.once("error", (e) => {
      if (child.pid === undefined) reject(e);
    });
    child.once("spawn", () => {
      const pid = child.pid!;
      // Kept after the exit, so a caller that asks late still learns how it ended (a reused pid replaces it).
      exits.set(pid, exited);
      child.stdin!.on("error", () => {
        /* the worker exited before reading all of stdin; its output says why */
      });
      child.stdin!.end(JSON.stringify({ ...o, cwd }));
    });
    let started = false;
    child.on("message", (message: { started?: boolean; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      if (message.started) { started = true; resolve({ pid: child.pid! }); }
    });
    child.once("exit", () => {
      if (!started) reject(new Error("Worker output relay exited before worker startup"));
    });
  });
}

/** How a worker this process spawned exited (undefined for one it did not spawn, such as an adopted worker). */
export function workerExit(pid: number): Promise<WorkerExit> | undefined {
  return exits.get(pid);
}

/** True while any process of the group exists. */
export function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signal a whole process group; false when it is gone. Never throws. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SIGTERM the group, wait up to graceMs for it to go, then SIGKILL whatever is left. */
export async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, "SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pgid)) await sleep(50);
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  const reaped = Date.now() + 2000;
  while (Date.now() < reaped && groupAlive(pgid)) await sleep(25);
}
