// Prototype sandbox on disk: a root outside any git work tree, one mkdtemp directory per session,
// one directory per prototype version. Files are written, never executed.
import { existsSync, realpathSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTOTYPE_DIR } from "../config.js";
import { redact } from "../publishers/redact.js";
import { validatePath, type PrototypeFile } from "./parse.js";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Real path of `p`, resolving the nearest existing ancestor (the rest may not exist yet). */
function realpathOfNearest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync(cur);
  } catch {
    /* keep the resolved path */
  }
  return tail.length ? join(real, ...tail) : real;
}

/** The directory holding a `.git` entry at or above `p`, or null. */
export function findGitWorkTree(p: string): string | null {
  let cur = p;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Refuse a root that is a symlink, not a directory, or owned by another user. False when it does not exist. */
async function checkRootEntry(abs: string, given: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const refuse = (why: string) =>
    new Error(`Refusing to use the prototype directory "${given}": ${why}. Set ROUNDTABLE_PROTOTYPE_DIR to a directory you own.`);
  if (st.isSymbolicLink()) throw refuse("it is a symbolic link");
  if (!st.isDirectory()) throw refuse("it is not a directory");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw refuse("it is owned by another user");
  return true;
}

/**
 * Prepare the sandbox root: refuse a root inside a git work tree, a symlinked root and a root owned by
 * another user; create it (or force it) to mode 0700 and write a `.gitignore` of `*`. Returns the real
 * path of the root. Throws a clear error on refusal.
 */
export async function ensurePrototypeRoot(root: string = PROTOTYPE_DIR): Promise<string> {
  const abs = resolve(root);
  const git = findGitWorkTree(realpathOfNearest(abs));
  if (git) {
    throw new Error(
      `Refusing to use the prototype directory "${root}": it is inside a git work tree (${git}). ` +
        `Prototype files must never touch a repository; set ROUNDTABLE_PROTOTYPE_DIR to a directory outside any repository.`
    );
  }
  if (!(await checkRootEntry(abs, root))) {
    await mkdir(abs, { recursive: true, mode: 0o700 });
    await checkRootEntry(abs, root); // whatever is there now must pass the same checks
  }
  await chmod(abs, 0o700);
  const real = realpathSync(abs);
  await writeFile(join(real, ".gitignore"), "*\n", { mode: 0o600 });
  return real;
}

const sanitize = (s: string) => (String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "session");

/** Session directories this process created and has not released: the sweep never touches them. */
const ownSessionDirs = new Set<string>();

/** Create a fresh 0700 directory for one session and record its owner (pid, host, time) in owner.json. */
export async function createSessionDir(root: string, sessionId: string): Promise<string> {
  const dir = await mkdtemp(join(root, sanitize(sessionId) + "-"));
  ownSessionDirs.add(dir);
  await chmod(dir, 0o700);
  const owner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
  await writeFile(join(dir, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  return dir;
}

/** The session is over (its directory is being removed): from now on the sweep may take what is left. */
export function releaseSessionDir(dir: string): void {
  ownSessionDirs.delete(dir);
}

function contained(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * Write validated files under `dir` (which must already exist). Every path is re-validated and
 * containment-checked; symlinks are refused; directories are created one level at a time (never
 * recreating a removed parent) with mode 0700 and files with 0600. With `redactContent`, each file
 * passes through redact() first. Returns the files as written. Throws on any problem.
 */
export async function materializeFiles(
  dir: string,
  files: PrototypeFile[],
  opts: { redactContent: boolean }
): Promise<PrototypeFile[]> {
  const base = resolve(dir);
  const st = await lstat(base);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("prototype directory is not a plain directory");
  const written: PrototypeFile[] = [];
  for (const f of files) {
    const err = validatePath(f.path);
    if (err) throw new Error(err);
    const target = resolve(base, ...f.path.split("/"));
    if (!contained(base, target)) throw new Error(`path "${f.path}" escapes the prototype directory`);
    // Create intermediate directories one by one, refusing anything that is not a plain directory.
    const segments = f.path.split("/").slice(0, -1);
    let cur = base;
    for (const seg of segments) {
      cur = join(cur, seg);
      try {
        const s = await lstat(cur);
        if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`"${seg}" in "${f.path}" is not a directory`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await mkdir(cur, { mode: 0o700 });
      }
    }
    const content = opts.redactContent ? redact(f.content).text : f.content;
    // "wx" fails if anything (a file or a symlink, even a dangling one) already exists at the path.
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    written.push({ path: f.path, content });
  }
  return written;
}

/** Defensive guard: never remove a filesystem root or a relative path. */
function removable(dir: string): boolean {
  if (!dir || !isAbsolute(dir)) return false;
  const r = resolve(dir);
  return dirname(r) !== r;
}

/** rm -rf, best effort. Returns false (and logs) on failure; never throws. */
export async function removeDir(dir: string): Promise<boolean> {
  if (!removable(dir)) return false;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (e) {
    console.error(`[Prototype] could not remove ${dir}: ${errText(e)}`);
    return false;
  }
}

/** Synchronous rm -rf for process exit. Never throws. */
export function removeDirSync(dir: string): boolean {
  if (!removable(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** True if a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A session directory left without a readable owner.json is swept once it is older than this. */
export const UNOWNED_SESSION_MAX_AGE_MS = 60 * 60 * 1000;
/** Any session directory, whatever its host or pid, is swept once it is older than this. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** mkdtemp names: the sanitized session id, "-", six random characters. */
const SESSION_DIR_NAME = /^[A-Za-z0-9_-]{1,40}-[A-Za-z0-9]{6}$/;
const PROTOTYPE_DIR_NAME = /^P\d{1,4}v\d{1,4}$/;

/**
 * True when a directory holds nothing but a session's own entries (owner.json and P<n>v<n>
 * directories). The sweep removes nothing else, so a root shared with other files stays safe.
 */
async function looksLikeSessionDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.every(
      (e) => (e.name === "owner.json" && e.isFile()) || (PROTOTYPE_DIR_NAME.test(e.name) && e.isDirectory())
    );
  } catch {
    return false;
  }
}

interface Owner {
  pid?: unknown;
  host?: unknown;
  createdAt?: unknown;
}

/** Whether one session directory is stale (see sweepStaleSessionDirs). */
async function isStale(dir: string, now: number, host: string): Promise<boolean> {
  const st = await lstat(dir);
  let owner: Owner | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
    if (parsed && typeof parsed === "object") owner = parsed as Owner;
  } catch {
    owner = null;
  }
  if (!owner) return now - st.mtimeMs > UNOWNED_SESSION_MAX_AGE_MS;
  const pid = typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : 0;
  const created = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
  const age = now - (Number.isFinite(created) ? created : st.mtimeMs);
  if (age > SESSION_MAX_AGE_MS) return true;
  return owner.host === host && pid > 0 && pid !== process.pid && !pidAlive(pid);
}

/**
 * Remove prototype session directories left behind. Never one of this process's own live sessions, and
 * only directories whose contents look like a session (owner.json and P<n>v<n> directories). One goes when
 *  - its owner.json names this host and a pid that is no longer running (and is not this process), or
 *  - it is older than 24 hours, whatever its host or pid (hosts and containers sharing the root), or
 *  - it has no readable owner.json and is older than 1 hour (an interrupted start or exit).
 * Never throws; returns the count removed.
 */
export async function sweepStaleSessionDirs(root: string = PROTOTYPE_DIR, now: number = Date.now()): Promise<number> {
  let removed = 0;
  try {
    if (!existsSync(root)) return 0;
    const base = realpathSync(root);
    const host = hostname();
    const entries = await readdir(base, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !SESSION_DIR_NAME.test(ent.name)) continue;
      const dir = join(base, ent.name);
      if (ownSessionDirs.has(dir)) continue;
      try {
        if ((await isStale(dir, now, host)) && (await looksLikeSessionDir(dir)) && (await removeDir(dir))) removed++;
      } catch {
        /* vanished meanwhile or unreadable: leave it */
      }
    }
  } catch (e) {
    console.error(`[Prototype] sweep of ${root} failed: ${errText(e)}`);
  }
  return removed;
}
