// ============================================================================
// Private, atomic file helpers (directories 0700, files 0600)
// ============================================================================

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Create a state home with mode 0700, preserving the mode of an existing directory. */
export function ensureStateHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const st = lstatSync(home);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Refusing to use ${home}: not a real directory`);
}

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

/** Raised by the regular-file readers: ENOTREG (not a regular file, or a refused symlink) or EFBIG (over the size cap). */
export class RegularFileError extends Error {
  constructor(readonly code: "ENOTREG" | "EFBIG", message: string) {
    super(message);
    this.name = "RegularFileError";
  }
}

export interface RegularFileOptions {
  /** Refuse files larger than this many bytes. */
  maxBytes?: number;
  /** Refuse a path that is itself a symlink (O_NOFOLLOW). */
  noFollow?: boolean;
}

/**
 * Open a regular file once and judge it through the descriptor: the type and size come from fstat on
 * the open file, so what is checked is what is read. O_NONBLOCK keeps a FIFO from blocking the open.
 * The caller closes the descriptor. Other open errors (ENOENT, EACCES, …) pass through unchanged.
 */
export function openRegularFile(path: string, opts: RegularFileOptions = {}): { fd: number; stat: Stats } {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (opts.noFollow ? constants.O_NOFOLLOW : 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (err) {
    if (opts.noFollow && (err as NodeJS.ErrnoException).code === "ELOOP") throw new RegularFileError("ENOTREG", `${path} is a symlink`);
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RegularFileError("ENOTREG", `${path} is not a regular file`);
    if (opts.maxBytes !== undefined && stat.size > opts.maxBytes) throw new RegularFileError("EFBIG", `${path} is larger than ${opts.maxBytes} bytes`);
    return { fd, stat };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Read an open descriptor to its end; with maxBytes, a file that grew past it raises EFBIG. */
export function readDescriptor(fd: number, maxBytes?: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const room = maxBytes === undefined ? 65536 : Math.min(65536, maxBytes + 1 - total);
    if (room <= 0) throw new RegularFileError("EFBIG", `the file is larger than ${maxBytes} bytes`);
    const chunk = Buffer.alloc(room);
    const n = readSync(fd, chunk, 0, room, null);
    if (n === 0) break;
    chunks.push(n === room ? chunk : chunk.subarray(0, n));
    total += n;
    if (maxBytes !== undefined && total > maxBytes) throw new RegularFileError("EFBIG", `the file is larger than ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a regular file through one descriptor. The optional `accept` runs on the descriptor's stat
 * before any byte is read and throws to refuse the file.
 */
export function readRegularFile(path: string, opts: RegularFileOptions & { accept?: (stat: Stats) => void } = {}): { data: Buffer; stat: Stats } {
  const { fd, stat } = openRegularFile(path, opts);
  try {
    opts.accept?.(stat);
    return { data: readDescriptor(fd, opts.maxBytes), stat };
  } finally {
    closeSync(fd);
  }
}
