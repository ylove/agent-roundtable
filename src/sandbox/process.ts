// ============================================================================
// Sandbox: process spawning, output capture and the in-flight kill registry
//
// Every sandboxed process runs in its own process group (detached), so a timeout, an abort or a
// shutdown kills the whole tree, not just the leader. The group is also killed when the leader
// exits, so background processes never outlive the command.
// ============================================================================

import { spawn } from "node:child_process";
import { OutputCapture } from "./common.js";

const POSIX = process.platform !== "win32";
/** How long a pre-kill hook (docker kill) may take before the client is killed anyway. */
const PRE_KILL_GRACE_MS = 10_000;
/** After the leader exits (or is killed), how long to wait for the pipes to drain. */
const DRAIN_GRACE_MS = 2_000;

/**
 * SIGKILL a process group (POSIX) or a single process. Never throws. There is deliberately no
 * fallback to the bare pid: after the leader has been reaped, that pid may belong to someone else.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(POSIX ? -pid : pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ============================================================================
// Kill registry
// ============================================================================

interface Inflight {
  label: string;
  /** Starts every synchronous kill step at once; resolves when the asynchronous ones finish. */
  stop(): Promise<void>;
}

const inflight = new Set<Inflight>();
let shuttingDown = false;

export function registerInflight(entry: Inflight): () => void {
  if (shuttingDown) void entry.stop();
  else inflight.add(entry);
  return () => {
    inflight.delete(entry);
  };
}

export function sandboxShuttingDown(): boolean {
  return shuttingDown;
}

/** Number of sandboxed processes (and egress proxies) currently running. */
export function sandboxedInFlight(): number {
  return inflight.size;
}

/**
 * Kill every in-flight sandboxed process and egress proxy, and refuse new runs from now on (for
 * server or runner shutdown). The synchronous part (process-group SIGKILL, spawning `docker kill`)
 * happens before this returns, so it is usable from an 'exit' hook; await it when you can.
 */
export async function killAllSandboxed(): Promise<void> {
  shuttingDown = true;
  const entries = [...inflight];
  inflight.clear();
  await Promise.allSettled(entries.map((e) => e.stop()));
}

// ============================================================================
// Spawn with capture
// ============================================================================

export interface CaptureOptions {
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Label for the registry and logs. */
  label: string;
  /** Runs before the client is SIGKILLed on timeout, abort or shutdown (e.g. `docker kill <name>`). */
  beforeKill?: () => Promise<void>;
  /** Runs after a kill, without being awaited (e.g. `docker rm -f <name>`). */
  afterKill?: () => void;
  /** false for helper commands (docker kill, probes): not registered, and allowed during shutdown. */
  track?: boolean;
}

export interface CaptureResult {
  exit: number | null;
  signal?: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Scrubbed and capped. */
  output: string;
  truncated: boolean;
  /** Set when the process could not be started, or the run was refused. */
  error?: string;
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      }
    );
  });
}

function failed(started: number, error: string, aborted = false): CaptureResult {
  return { exit: null, timedOut: false, aborted, durationMs: Date.now() - started, output: error, truncated: false, error };
}

/**
 * Spawn `file args` (argv, shell:false, own process group), capture combined output into a capped
 * buffer and enforce the timeout and abort signal. Never throws; a start failure is reported in
 * `error` (and `output`) with exit null.
 */
export function spawnCaptured(file: string, args: string[], o: CaptureOptions): Promise<CaptureResult> {
  const started = Date.now();
  const track = o.track !== false;
  if (track && shuttingDown) return Promise.resolve(failed(started, "sandbox is shutting down"));
  if (o.signal?.aborted) return Promise.resolve(failed(started, "aborted before start", true));
  return new Promise((resolve) => {
    const out = new OutputCapture(o.maxOutputBytes);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        env: o.env,
        cwd: o.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: POSIX,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      resolve(failed(started, `could not start ${o.label}: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const pid = child.pid;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killed = false;
    let killing: Promise<void> | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let startError: string | undefined;
    let drain: NodeJS.Timeout | undefined;

    const kill = (): Promise<void> => {
      if (killing) return killing;
      killed = true;
      killing = (async () => {
        if (o.beforeKill) await bounded(o.beforeKill(), PRE_KILL_GRACE_MS);
        killTree(pid);
        try {
          o.afterKill?.();
        } catch {
          /* best effort */
        }
      })();
      return killing;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      o.signal?.removeEventListener("abort", onAbort);
      untrack();
      const { text, truncated } = out.finish();
      const output = startError ? (text ? `${text}\n${startError}` : startError) : text;
      resolve({
        exit: exitCode,
        signal: exitSignal ?? (killed ? "SIGKILL" : undefined),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        output,
        truncated,
        error: startError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      void kill();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const untrack = track
      ? registerInflight({
          label: o.label,
          stop: () => {
            aborted = true;
            return kill();
          },
        })
      : () => {};

    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => out.push(c));
    child.on("error", (e) => {
      startError = `could not start ${o.label}: ${e.message}`;
      if (exitCode === null && !drain) drain = setTimeout(finish, 50);
    });
    child.on("exit", (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      // The command finished: a slow pipe drain is not a timeout.
      clearTimeout(timer);
      // Background processes left in the group die with the command.
      killTree(pid);
      if (drain) clearTimeout(drain);
      drain = setTimeout(finish, DRAIN_GRACE_MS);
    });
    child.on("close", () => finish());
  });
}

/** Run a short helper command (docker CLI, probes) and return its exit code and output. Never throws. */
export async function runQuiet(
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: boolean; exit: number | null; output: string }> {
  const r = await spawnCaptured(file, args, { env, timeoutMs, maxOutputBytes: 64 * 1024, label: file, signal, track: false });
  return { ok: r.exit === 0 && !r.timedOut && !r.error, exit: r.exit, output: r.output.trim() };
}
