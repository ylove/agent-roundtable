// Prototype sandbox on disk: a root outside any git work tree, one mkdtemp directory per session,
// one directory per prototype version. Files are written, never executed.
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/**
 * Prepare the sandbox root: refuse a root inside a git work tree, create it (0700) and write a
 * `.gitignore` of `*`. Returns the real path of the root. Throws a clear error on refusal.
 */
export async function ensurePrototypeRoot(root: string = PROTOTYPE_DIR): Promise<string> {
  const real = realpathOfNearest(root);
  const git = findGitWorkTree(real);
  if (git) {
    throw new Error(
      `Refusing to use the prototype directory "${root}": it is inside a git work tree (${git}). ` +
        `Prototype files must never touch a repository; set ROUNDTABLE_PROTOTYPE_DIR to a directory outside any repository.`
    );
  }
  await mkdir(real, { recursive: true, mode: 0o700 });
  await writeFile(join(real, ".gitignore"), "*\n", { mode: 0o600 });
  return real;
}

const sanitize = (s: string) => (String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "session");

/** Create a fresh directory for one session and record the owning pid in owner.json. */
export async function createSessionDir(root: string, sessionId: string): Promise<string> {
  const dir = await mkdtemp(join(root, sanitize(sessionId) + "-"));
  await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  return dir;
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

/**
 * Remove session directories left behind by dead processes (owner.json pid no longer alive).
 * Directories without a readable owner.json are left alone. Never throws; returns the count removed.
 */
export async function sweepStaleSessionDirs(root: string = PROTOTYPE_DIR): Promise<number> {
  let removed = 0;
  try {
    if (!existsSync(root)) return 0;
    const entries = await readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = join(root, ent.name);
      try {
        const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as { pid?: unknown };
        const pid = typeof owner.pid === "number" ? owner.pid : NaN;
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        if (pidAlive(pid)) continue;
        if (await removeDir(dir)) removed++;
      } catch {
        /* no or unreadable owner.json: not ours to remove */
      }
    }
  } catch (e) {
    console.error(`[Prototype] sweep of ${root} failed: ${errText(e)}`);
  }
  return removed;
}

/** Child directories of a root (for diagnostics and tests). */
export function listSessionDirs(root: string = PROTOTYPE_DIR): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}
