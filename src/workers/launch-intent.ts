// A launch is fenced before spawn. The child holds its own lock and publishes its identity
// before starting the CLI. Recovery either adopts that owner or cancels the intent under the
// same lock; a child scheduled after cancellation cannot start work.
import { readFileSync } from "node:fs";
import { acquireLock, LockTimeoutError, processMatches, readLockOwner } from "../execution/lock.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import type { RunFile } from "../execution/runner.js";

export interface LaunchIntent {
  token_sha256: string;
  at: string;
  cancelled?: boolean;
  run: RunFile;
}

export const launchLock = (path: string, token: string): string => `${path}.${token}.lock`;

export function readLaunchIntent(path: string): LaunchIntent | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as LaunchIntent; } catch { return null; }
}

/** null: fenced off and safe to replace; a RunFile: adopt; undefined: uncertain, retry later. */
export async function reconcileLaunch(path: string): Promise<RunFile | null | undefined> {
  const intent = readLaunchIntent(path);
  if (!intent || intent.cancelled) return null;
  const lock = launchLock(path, intent.token_sha256);
  try {
    const release = await acquireLock(lock, { staleMs: 10_000, timeoutMs: 0 });
    try {
      writeFileAtomic(path, JSON.stringify({ ...intent, cancelled: true }) + "\n");
      return null;
    } finally { release(); }
  } catch (e) {
    if (!(e instanceof LockTimeoutError)) throw e;
    const owner = readLockOwner(lock);
    if (!owner || !processMatches(owner.pid, owner.started)) return undefined;
    return { ...intent.run, pid: owner.pid, pgid: owner.pid, started: owner.started };
  }
}
