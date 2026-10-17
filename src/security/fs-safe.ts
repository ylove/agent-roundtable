// ============================================================================
// Private, atomic file helpers (directories 0700, files 0600)
// ============================================================================

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Create a directory (and parents) with mode 0700; refuses when the final path is a symlink. */
export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Refusing to use ${dir}: not a real directory`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/**
 * Make a directory's entries durable (a file just created or renamed into it). Best effort:
 * platforms that cannot fsync a directory (EISDIR, EINVAL, EPERM, …) are ignored.
 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* not supported here */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write a file atomically: a sibling temp file is written (exclusive create, given mode), fsynced
 * and renamed over the target, and the directory is fsynced. Readers never observe a partial file.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dirname(path));
}

/** True when target resolves inside root (or is root). Purely lexical; callers also check symlinks. */
export function isContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/** A normalized repository-relative path: no absolute paths, no "..", no NUL, forward slashes. */
export function normalizeRelPath(p: string): string | null {
  if (!p || p.includes("\0") || isAbsolute(p) || /^[A-Za-z]:/.test(p)) return null;
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}
