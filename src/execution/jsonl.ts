// ============================================================================
// Append-only JSONL reading: complete lines from a byte offset; a torn last line is left alone
// ============================================================================

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK = 1 << 20;

export interface ReadResult {
  /** Offset just past the last complete line read (where the next read should start). */
  offset: number;
  /** File size when the read started. */
  size: number;
  /** Bytes after the last newline: a line still being written, or one torn by a crash. */
  torn: number;
}

/**
 * Call onLine(text, start, end) for every newline-terminated line from `fromOffset` to the size
 * the file had when the read started; `end` is the offset after the newline. Return false from
 * onLine to stop early. A missing file reads as empty. Throws when the file is shorter than
 * `fromOffset` (it was truncated or replaced).
 */
export function readLines(
  path: string,
  fromOffset: number,
  onLine: (text: string, start: number, end: number) => boolean | void
): ReadResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (fromOffset > 0) throw new Error(`${path} is missing but ${fromOffset} bytes were already read`);
    return { offset: 0, size: 0, torn: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    if (size < fromOffset) throw new Error(`${path} shrank to ${size} bytes below the ${fromOffset} already read`);
    let pos = fromOffset; // file position of buf[0]
    let carry = Buffer.alloc(0);
    let lineStart = fromOffset;
    while (pos + carry.length < size) {
      const want = Math.min(CHUNK, size - pos - carry.length);
      const chunk = Buffer.allocUnsafe(want);
      const got = readSync(fd, chunk, 0, want, pos + carry.length);
      if (got <= 0) break;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl !== -1; nl = buf.indexOf(10, from)) {
        const end = pos + nl + 1;
        if (onLine(buf.toString("utf8", from, nl), lineStart, end) === false) {
          return { offset: end, size, torn: 0 };
        }
        lineStart = end;
        from = nl + 1;
      }
      pos += from;
      carry = Buffer.from(buf.subarray(from));
    }
    return { offset: lineStart, size, torn: size - lineStart };
  } finally {
    closeSync(fd);
  }
}

/**
 * The newline-terminated line that ends exactly at `endOffset`, or null when there is none
 * (no newline there, or the line is longer than `maxBytes`).
 */
export function readLineEndingAt(path: string, endOffset: number, maxBytes = 64 * 1024): string | null {
  if (endOffset <= 0) return null;
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size < endOffset) return null;
    const start = Math.max(0, endOffset - maxBytes);
    const buf = Buffer.alloc(endOffset - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    if (got !== buf.length || buf[buf.length - 1] !== 10) return null;
    const prevNl = buf.length >= 2 ? buf.lastIndexOf(10, buf.length - 2) : -1;
    if (prevNl === -1 && start > 0) return null;
    return buf.toString("utf8", prevNl + 1, buf.length - 1);
  } finally {
    closeSync(fd);
  }
}
