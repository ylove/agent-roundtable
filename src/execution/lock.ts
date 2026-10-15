// ============================================================================
// Cross-process mkdir locks with stale detection and atomic steal
//
// A lock is a directory created with mkdir (atomic on local filesystems) holding
// owner.json {pid, host, token, at}. It is stale when its pid is dead on this host or `at` is
// older than staleMs. A contender steals a stale lock by renaming it aside, so of several
// contenders exactly one moves it; the rest find it gone and race for a fresh mkdir.
//
// A holder can still lose its lock: by holding it past staleMs, or in the narrow window of a
// steal race. Code that commits shared state must call held() immediately before committing.
// ============================================================================

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate } from "../security/fs-safe.js";

export interface LockOptions {
  /** A lock whose owner.json `at` is older than this is stale, even if its pid is alive. */
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
    super(
      `Timed out after ${timeoutMs} ms waiting for lock ${lockDir}` +
        (owner ? ` (held by pid ${owner.pid} on ${owner.host} since ${owner.at})` : "")
    );
    this.name = "LockTimeoutError";
  }
}

const OWNER_FILE = "owner.json";
const MAX_WAIT_MS = 5000;

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
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
      typeof o.host === "string" &&
      typeof o.token === "string" &&
      typeof o.at === "string"
    ) {
      return o as LockOwner;
    }
  } catch {
    /* missing, mid-creation, or garbage */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Taking, judging and stealing
// ---------------------------------------------------------------------------

/**
 * mkdir the lock, then publish owner.json with link(2), which fails if owner.json already exists.
 * That catches the one race mkdir alone cannot: our fresh, still-empty directory being replaced
 * by a lock that a steal restored (rename may replace an empty directory).
 */
function tryCreate(lockDir: string, token: string): boolean {
  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    if (errCode(e) !== "ENOENT") throw e;
    mkdirPrivate(dirname(lockDir));
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (e2) {
      if (errCode(e2) === "EEXIST") return false;
      throw e2;
    }
  }
  const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: new Date().toISOString() };
  const tmp = join(lockDir, `.owner.${token}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, join(lockDir, OWNER_FILE));
    } catch (e) {
      if (errCode(e) === "EEXIST") return false; // the directory is someone else's now
      renameSync(tmp, join(lockDir, OWNER_FILE)); // filesystems without hard links
    }
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false; // moved away under us
    throw e;
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

/** Dead pid on this host, or older than staleMs (by owner.at, else by directory mtime). */
function isStale(seen: Seen, staleMs: number, now: number): boolean {
  const o = seen.owner;
  if (o && o.host === hostname() && o.pid > 0 && !pidAlive(o.pid)) return true;
  const at = o ? Date.parse(o.at) : NaN;
  return now - (Number.isFinite(at) ? at : seen.mtimeMs) > staleMs;
}

/**
 * Remove the lock if it is stale. Returns true when the caller should retry mkdir at once (the
 * lock is gone or was removed), false when it is live and the caller should wait.
 */
function stealIfStale(lockDir: string, staleMs: number): boolean {
  const seen = inspect(lockDir);
  if (!seen) return true;
  if (!isStale(seen, staleMs, Date.now())) return false;
  const aside = `${lockDir}.stale.${rand()}`;
  try {
    renameSync(lockDir, aside);
  } catch (e) {
    if (errCode(e) === "ENOENT") return true; // another contender moved it first
    throw e;
  }
  if (readLockOwner(aside)?.token !== seen.owner?.token) {
    // Between our look and the rename, the stale lock was replaced by a live one: put it back.
    try {
      renameSync(aside, lockDir);
      return false;
    } catch {
      /* lockDir was taken again meanwhile; the lock we moved is lost and its holder's held() is false */
    }
  }
  rmSync(aside, { recursive: true, force: true });
  const o = seen.owner;
  console.error(`[Lock] removed stale lock ${lockDir}${o ? ` (pid ${o.pid} on ${o.host}, taken ${o.at})` : " (no owner)"}`);
  return true;
}

function makeRelease(lockDir: string, token: string): LockRelease {
  let done = false;
  const held = () => readLockOwner(lockDir)?.token === token;
  const release = () => {
    if (done) return false;
    done = true;
    if (!held()) return false;
    // Rename first, so a steal racing this release cannot make us delete the stealer's lock.
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

/** Take the lock at `lockDir`, waiting with exponential backoff (5 ms doubling to 5 s, jittered). */
export async function acquireLock(lockDir: string, opts: LockOptions): Promise<LockRelease> {
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + opts.timeoutMs;
  let delay = Math.max(1, opts.waitMs ?? 5);
  for (;;) {
    if (tryCreate(lockDir, token)) return makeRelease(lockDir, token);
    if (stealIfStale(lockDir, opts.staleMs)) continue;
    const left = deadline - Date.now();
    if (left <= 0) throw new LockTimeoutError(lockDir, opts.timeoutMs, readLockOwner(lockDir));
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
