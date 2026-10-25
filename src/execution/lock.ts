// ============================================================================
// Cross-process mkdir locks that are never taken from a live holder
//
// A lock is a directory created with mkdir (atomic on local filesystems) holding
// owner.json {pid, host, token, at, started?}. A holder keeps the lock for as long as its process
// lives, however long that is: a holder stalled by a GC pause, swap, SIGSTOP or a suspended
// laptop must never wake up next to a second writer, so waiters time out instead of stealing.
//
// A lock is cleared only when its owner is known to be gone:
//  - its pid is dead on this host, or the pid is alive but belongs to another process (pid reuse,
//    detected by comparing the process start time recorded in `started`); or
//  - owner.json is missing or unreadable after a grace period of staleMs (by directory mtime):
//    its creator died between mkdir and publishing owner.json.
// A lock owned by another host is never cleared: 1.0 supports one host per home directory.
// Several contenders may race to clear a dead lock; the rename that moves it aside succeeds for
// one of them, and all then race for a fresh mkdir.
// ============================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { pidAlive } from "../prototypes/sandbox.js";

export interface LockOptions {
  /**
   * Grace period for a lock directory without a readable owner.json. It is also the age after
   * which a live owner pid is checked for reuse. It never makes a live holder's lock stale.
   */
  staleMs: number;
  /** Give up with LockTimeoutError after waiting this long. */
  timeoutMs: number;
  /** First backoff delay in ms (default 5); it doubles on every retry, up to 5 s. */
  waitMs?: number;
}

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  /** ISO time the lock was taken. */
  at: string;
  /** The holder process's start time as `ps` reports it (UTC); guards against pid reuse. */
  started?: string;
}

/** Releases the lock if owner.json still carries our token; true when it removed it. */
export type LockRelease = (() => boolean) & {
  readonly token: string;
  /** True while owner.json carries our token. */
  held(): boolean;
};

export class LockTimeoutError extends Error {
  readonly code = "ELOCKTIMEOUT";
  constructor(readonly lockDir: string, readonly timeoutMs: number, readonly owner: LockOwner | null) {
    super(`Timed out after ${timeoutMs} ms waiting for lock ${lockDir}${describeOwner(lockDir, owner)}`);
    this.name = "LockTimeoutError";
  }
}

function describeOwner(lockDir: string, o: LockOwner | null): string {
  if (!o) return "";
  if (o.host !== hostname()) {
    return ` (held by pid ${o.pid} on host ${o.host}, which is not this host; if that is this machine under an earlier name and the process is gone, remove ${lockDir})`;
  }
  return ` (held by pid ${o.pid} since ${o.at}; a lock is never taken from a live process, so if it is stuck, stop it)`;
}

const OWNER_FILE = "owner.json";
const MAX_WAIT_MS = 5000;

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rand = () => randomBytes(4).toString("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The parsed owner.json of a lock directory, or null when it is missing or malformed. */
export function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (
      o &&
      typeof o === "object" &&
      Number.isSafeInteger(o.pid) &&
      (o.pid as number) > 0 &&
      typeof o.host === "string" &&
      typeof o.token === "string" &&
      typeof o.at === "string" &&
      (o.started === undefined || typeof o.started === "string")
    ) {
      return o as LockOwner;
    }
  } catch {
    /* missing, mid-creation, or garbage */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process identity (pid reuse guard)
// ---------------------------------------------------------------------------

/** A process's start time from `ps` (UTC, second resolution), or null when it is unknown. */
export function processStart(pid: number): string | null {
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH || "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
    });
    const out = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim().replace(/\s+/g, " ") : "";
    return out || null;
  } catch {
    return null;
  }
}

/** True only for a live process whose recorded start identity can still be verified. */
export function processMatches(pid: number, started: string | undefined): boolean {
  return started !== undefined && pidAlive(pid) && processStart(pid) === started;
}

/** Proven pid reuse. Unknown identities preserve a lock owner's protection. */
export function processReused(pid: number, started: string | undefined): boolean {
  if (!started) return false;
  const current = processStart(pid);
  return current !== null && current !== started;
}

let selfStart: string | null | undefined;
const ownStart = (): string | null => (selfStart === undefined ? (selfStart = processStart(process.pid)) : selfStart);

// ---------------------------------------------------------------------------
// Taking, judging and clearing
// ---------------------------------------------------------------------------

/**
 * mkdir the lock, then publish owner.json with link(2), which fails if owner.json already exists.
 * That catches the one race mkdir alone cannot: our fresh, still-empty directory being replaced
 * by a lock that a clearing contender restored (rename may replace an empty directory). Without
 * hard links the lock fails closed. The parent directory must exist: a lock never recreates it.
 */
function tryCreate(lockDir: string, token: string): boolean {
  // Before mkdir: the ps spawn takes tens of ms, and a holder killed between mkdir and owner.json
  // leaves an ownerless lock that only ages out after staleMs.
  const started = ownStart();
  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    if (errCode(e) === "ENOENT") throw new Error(`Cannot take lock ${lockDir}: ${dirname(lockDir)} does not exist`);
    throw e;
  }
  const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: new Date().toISOString(), ...(started ? { started } : {}) };
  const tmp = join(lockDir, `.owner.${token}.tmp`);
  try {
    try {
      writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    } catch (e) {
      // A contender clearing a stale lock can rename or remove our fresh directory under us; macOS
      // reports that as EINVAL from open(2) inside it. Same meaning as ENOENT: the directory is not ours.
      if (errCode(e) === "EINVAL") return false;
      throw e;
    }
    linkSync(tmp, join(lockDir, OWNER_FILE));
    return true;
  } catch (e) {
    if (errCode(e) === "EEXIST" || errCode(e) === "ENOENT") return false; // the directory is someone else's now
    rmSync(tmp, { force: true });
    try {
      rmdirSync(lockDir);
    } catch {
      /* not empty: not ours */
    }
    throw new Error(`Cannot take lock ${lockDir}: ${errText(e)} (the lock needs a local filesystem with hard links)`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

interface Seen {
  owner: LockOwner | null;
  mtimeMs: number;
}

function inspect(lockDir: string): Seen | null {
  try {
    const st = statSync(lockDir);
    return { owner: readLockOwner(lockDir), mtimeMs: st.mtimeMs };
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** True only when the owner is known to be gone (see the header); a live holder is never gone. */
function ownerGone(seen: Seen, staleMs: number, now: number): boolean {
  const o = seen.owner;
  if (!o) return now - seen.mtimeMs > staleMs;
  if (o.host !== hostname()) return false;
  if (!pidAlive(o.pid)) return true;
  // The pid is alive. It is the holder unless the pid was reused, which is checked (one ps spawn)
  // only once the lock is older than staleMs.
  const at = Date.parse(o.at);
  if (o.started === undefined || !(now - (Number.isFinite(at) ? at : seen.mtimeMs) > staleMs)) return false;
  return processReused(o.pid, o.started);
}

/**
 * Remove the lock if its owner is gone. Returns true when the caller should retry mkdir at once
 * (the lock is gone or was removed), false when it is live and the caller should wait.
 */
function clearIfGone(lockDir: string, staleMs: number): boolean {
  const seen = inspect(lockDir);
  if (!seen) return true;
  if (!ownerGone(seen, staleMs, Date.now())) return false;
  const aside = `${lockDir}.stale.${rand()}`;
  try {
    renameSync(lockDir, aside);
  } catch (e) {
    if (errCode(e) === "ENOENT") return true; // another contender moved it first
    throw e;
  }
  if (readLockOwner(aside)?.token !== seen.owner?.token) {
    // Between our look and the rename, the dead lock was replaced by a live one: put it back.
    try {
      renameSync(aside, lockDir);
      return false;
    } catch {
      rmSync(aside, { recursive: true, force: true });
      console.error(`[Lock] a live lock on ${lockDir} was displaced while clearing a dead one; its holder will see it lost`);
      return true;
    }
  }
  rmSync(aside, { recursive: true, force: true });
  const o = seen.owner;
  console.error(`[Lock] cleared dead lock ${lockDir}${o ? ` (pid ${o.pid}, taken ${o.at})` : " (no owner)"}`);
  return true;
}

function makeRelease(lockDir: string, token: string): LockRelease {
  let done = false;
  const held = () => readLockOwner(lockDir)?.token === token;
  const release = () => {
    if (done) return false;
    done = true;
    if (!held()) return false;
    // Rename first, so a contender racing this release cannot make us delete its lock.
    const aside = `${lockDir}.released.${rand()}`;
    try {
      renameSync(lockDir, aside);
    } catch {
      return false;
    }
    const ours = readLockOwner(aside)?.token === token;
    if (!ours) {
      try {
        renameSync(aside, lockDir);
        return false;
      } catch {
        /* a third holder exists; the lock we moved is lost either way */
      }
    }
    rmSync(aside, { recursive: true, force: true });
    return ours;
  };
  return Object.assign(release, { token, held }) as LockRelease;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Take the lock at `lockDir` (its parent must exist), waiting with exponential backoff (5 ms
 * doubling to 5 s, jittered). A lock whose holder is alive is waited for, never taken; the wait
 * ends with LockTimeoutError.
 */
export async function acquireLock(lockDir: string, opts: LockOptions): Promise<LockRelease> {
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + opts.timeoutMs;
  let delay = Math.max(1, opts.waitMs ?? 5);
  for (;;) {
    if (tryCreate(lockDir, token)) return makeRelease(lockDir, token);
    const cleared = clearIfGone(lockDir, opts.staleMs);
    // The deadline holds on every path, including the immediate retry after a clear.
    const left = deadline - Date.now();
    if (left <= 0) throw new LockTimeoutError(lockDir, opts.timeoutMs, readLockOwner(lockDir));
    if (cleared) {
      // Retry at once, but yield first: contenders that keep clearing must not hold the event loop.
      await new Promise<void>((r) => setImmediate(r));
      continue;
    }
    await sleep(Math.min(left, delay / 2 + (Math.random() * delay) / 2));
    delay = Math.min(delay * 2, MAX_WAIT_MS);
  }
}

/** Run fn while holding the lock; always releases. fn receives the release handle (for held()). */
export async function withLock<T>(
  lockDir: string,
  opts: LockOptions,
  fn: (lock: LockRelease) => T | Promise<T>
): Promise<T> {
  const release = await acquireLock(lockDir, opts);
  try {
    return await fn(release);
  } finally {
    release();
  }
}
