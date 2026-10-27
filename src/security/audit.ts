// ============================================================================
// Global security audit log: AUDIT_DIR/audit-YYYY-MM.jsonl, one hash chain across all months
//
// Records confirmations, freezes, excusals, lease violations and purges. Each entry's prev is
// the hash of the entry before it, which for the first entry of a month is the last entry of
// the newest earlier file. The chain starts at GENESIS_HASH. Retention deletes whole month
// files and records the hash the chain now starts from in audit-anchor.json; verification
// requires the first remaining entry to link to that anchor (or to genesis if nothing was ever
// pruned), and the prune itself is audited.
// ============================================================================

import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_DIR } from "../config.js";
import { scrubDeep } from "../execution/blobs.js";
import { chainHash } from "../execution/chain.js";
import { readLines } from "../execution/jsonl.js";
import { acquireLock, type LockOptions } from "../execution/lock.js";
import { GENESIS_HASH } from "../execution/types.js";
import { fsyncDir, mkdirPrivate, writeFileAtomic } from "./fs-safe.js";
import { scrub } from "./secrets.js";

export interface AuditInput {
  /** Who acted: an orchestrator name, agent id, "human", "runner" or "system". */
  actor: string;
  /** What happened, e.g. "contract.frozen", "execution.confirmed", "lease.violation", "execution.purged". */
  action: string;
  /** What it happened to, e.g. an execution or contract id. */
  target?: string;
  /** Extra JSON-safe context; every string is scrubbed of secrets. */
  details?: Record<string, unknown>;
}

export interface AuditEntry extends AuditInput {
  v: 1;
  ts: string;
  pid: number;
  prev: string;
  /** sha256(prev + canonicalJSON(entry without hash)). */
  hash: string;
}

export interface AuditOptions {
  /** Defaults to AUDIT_DIR. */
  dir?: string;
  /** Clock override (ms since the epoch), for tests and retention sweeps. */
  now?: number;
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  files: number;
  badFile?: string;
  /** 1-based line number in badFile. */
  badLine?: number;
  reason?: string;
}

/** audit-anchor.json: where the chain starts after pruning. */
interface Anchor {
  /** The last hash of the pruned files: the first remaining entry's prev. */
  hash: string;
  /** The anchor before this prune (GENESIS_HASH at first), still valid if the prune was interrupted. */
  previous: string;
  files: string[];
  at: string;
}

/** A live holder is never displaced (execution/lock.ts); staleMs is the grace period for an ownerless lock. */
const AUDIT_LOCK: LockOptions = { staleMs: 10_000, timeoutMs: 30_000 };
const FILE_RE = /^audit-(\d{4})-(\d{2})\.jsonl$/;
const ANCHOR_FILE = "audit-anchor.json";
const DAY_MS = 86_400_000;

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Month files, oldest first (the names sort chronologically). */
function monthFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** The hash of the last complete entry of one file, or null when it has none; throws if that entry is corrupt. */
function lastHash(dir: string, name: string): { hash: string | null; offset: number; torn: number } {
  let last = null as string | null;
  const r = readLines(join(dir, name), 0, (line) => {
    last = line;
  });
  if (last === null) return { hash: null, offset: r.offset, torn: r.torn };
  let hash: unknown;
  try {
    hash = (JSON.parse(last) as { hash?: unknown }).hash;
  } catch {
    hash = undefined;
  }
  // Refuse to extend or anchor a chain whose head is unreadable: that would hide the damage.
  if (typeof hash !== "string") throw new Error(`Audit log ${name}: the last entry is corrupt; run verifyAudit()`);
  return { hash, offset: r.offset, torn: r.torn };
}

function readAnchor(dir: string): Anchor | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ANCHOR_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const a = JSON.parse(raw) as Partial<Anchor>;
  if (!a || typeof a.hash !== "string" || typeof a.previous !== "string") throw new Error(`${ANCHOR_FILE} is malformed`);
  return a as Anchor;
}

/**
 * The chain head (hash of the newest entry, searching back through older files) and the size of
 * the newest file. A torn last line in the newest file is cut off first: we hold the lock and a
 * live holder is never displaced, so it is a dead writer's.
 */
function chainHead(dir: string, files: string[]): { prev: string; newestSize: number } {
  let newestSize = 0;
  for (let i = files.length - 1; i >= 0; i--) {
    const r = lastHash(dir, files[i]);
    if (i === files.length - 1) {
      newestSize = r.offset;
      if (r.torn > 0) {
        const fd = openSync(join(dir, files[i]), "r+");
        try {
          ftruncateSync(fd, r.offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        console.error(`[Audit] discarded a torn ${r.torn}-byte line at the end of ${files[i]}`);
      }
    }
    if (r.hash !== null) return { prev: r.hash, newestSize };
  }
  return { prev: readAnchor(dir)?.hash ?? GENESIS_HASH, newestSize };
}

/** Append one entry under the audit lock. Its details (and target) are scrubbed of secrets. */
export async function appendAudit(input: AuditInput, opts: AuditOptions = {}): Promise<AuditEntry> {
  if (!input || typeof input.actor !== "string" || !input.actor || typeof input.action !== "string" || !input.action) {
    throw new Error("appendAudit: actor and action are required");
  }
  const dir = opts.dir ?? AUDIT_DIR;
  const now = opts.now ?? Date.now();
  mkdirPrivate(dir);
  const lock = await acquireLock(join(dir, "audit.lock"), AUDIT_LOCK);
  try {
    const files = monthFiles(dir);
    const { prev, newestSize } = chainHead(dir, files);
    // Never write behind the newest file, even if the clock went back.
    const newest = files.at(-1);
    const month = `audit-${monthOf(now)}.jsonl`;
    const file = newest && newest > month ? newest : month;
    const expectedSize = file === newest ? newestSize : 0;
    const entry: Record<string, unknown> = {
      v: 1,
      ts: new Date(now).toISOString(),
      pid: process.pid,
      actor: input.actor,
      action: input.action,
    };
    if (input.target !== undefined) entry.target = scrub(input.target);
    if (input.details !== undefined) entry.details = scrubDeep(input.details);
    entry.prev = prev;
    entry.hash = chainHash(prev, entry); // throws, writing nothing, if details are not JSON-safe
    const line = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    const path = join(dir, file);
    const fd = openSync(path, "a", 0o600);
    try {
      if (!lock.held()) throw new Error("appendAudit lost the audit lock; nothing was written");
      const size = fstatSync(fd).size;
      if (size !== expectedSize) throw new Error(`${file} changed while locked (${size} bytes, expected ${expectedSize}); nothing was written`);
      try {
        let off = 0;
        while (off < line.length) off += writeSync(fd, line, off, line.length - off);
        fsyncSync(fd);
      } catch (e) {
        try {
          ftruncateSync(fd, expectedSize);
        } catch {
          /* the next append cuts the torn line off */
        }
        throw e;
      }
    } finally {
      closeSync(fd);
    }
    if (expectedSize === 0) fsyncDir(dir); // the file was just created (or empty): make its directory entry durable
    return entry as unknown as AuditEntry;
  } finally {
    lock();
  }
}

/**
 * Check every remaining entry, oldest file first. The first entry must link to the prune anchor
 * (or to GENESIS_HASH if nothing was ever pruned).
 */
export async function verifyAudit(opts: Pick<AuditOptions, "dir"> = {}): Promise<AuditVerifyResult> {
  const dir = opts.dir ?? AUDIT_DIR;
  const files = monthFiles(dir);
  let anchor: Anchor | null;
  try {
    anchor = readAnchor(dir);
  } catch (e) {
    return { ok: false, entries: 0, files: files.length, badFile: ANCHOR_FILE, reason: e instanceof Error ? e.message : String(e) };
  }
  let prev: string | null = null;
  let entries = 0;
  // After an interrupted prune the chain may still start at the previous anchor, but must then reach the new one.
  let mustReach = null as string | null;
  for (const name of files) {
    let lineNo = 0;
    let failure: string | undefined;
    readLines(join(dir, name), 0, (line) => {
      lineNo++;
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        failure = "not valid JSON";
        return false;
      }
      if (!e || typeof e !== "object" || e.v !== 1 || typeof e.prev !== "string" || typeof e.hash !== "string") {
        failure = "not a version 1 audit entry";
      } else if (prev === null) {
        if (anchor && e.prev === anchor.hash) mustReach = null;
        else if (anchor && e.prev === anchor.previous) mustReach = anchor.hash;
        else if (!anchor && e.prev === GENESIS_HASH) mustReach = null;
        else failure = anchor ? "the first entry does not link to the prune anchor" : "the first entry does not start the chain, and no prune anchor is recorded";
      } else if (e.prev !== prev) {
        failure = "prev does not link to the previous entry";
      }
      if (!failure) {
        let hash: string | null;
        try {
          hash = chainHash(e.prev, e);
        } catch {
          hash = null;
        }
        if (hash !== e.hash) failure = "hash does not match its content";
      }
      if (failure) return false;
      if (e.hash === mustReach) mustReach = null;
      prev = e.hash;
      entries++;
    });
    if (failure) return { ok: false, entries, files: files.length, badFile: name, badLine: lineNo, reason: failure };
  }
  if (mustReach !== null) return { ok: false, entries, files: files.length, reason: "an interrupted prune: the chain never reaches the anchor" };
  if (anchor && entries === 0) return { ok: false, entries, files: files.length, reason: "a prune anchor is recorded but no audit entries remain" };
  return { ok: true, entries, files: files.length };
}

/**
 * Delete month files whose month ended more than retentionDays ago. The newest file is always
 * kept so the chain continues. The new starting hash is written to audit-anchor.json before
 * anything is deleted. Returns the deleted file names; a prune that deleted anything is itself
 * recorded as an "audit.pruned" entry.
 */
export async function pruneAudit(retentionDays = 365, opts: AuditOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? AUDIT_DIR;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionDays * DAY_MS;
  const removed: string[] = [];
  mkdirPrivate(dir);
  const lock = await acquireLock(join(dir, "audit.lock"), AUDIT_LOCK);
  try {
    const files = monthFiles(dir);
    for (const name of files.slice(0, -1)) {
      const [, y, m] = FILE_RE.exec(name)!;
      const monthEnd = Date.UTC(Number(y), Number(m), 1); // Date.UTC months are 0-based: this is the next month's 1st
      if (monthEnd > cutoff) break;
      removed.push(name);
    }
    if (removed.length) {
      const previous = readAnchor(dir)?.hash ?? GENESIS_HASH;
      let hash = previous;
      for (let i = removed.length - 1; i >= 0; i--) {
        const h = lastHash(dir, removed[i]).hash;
        if (h !== null) {
          hash = h;
          break;
        }
      }
      const anchor: Anchor = { hash, previous, files: removed, at: new Date(now).toISOString() };
      writeFileAtomic(join(dir, ANCHOR_FILE), JSON.stringify(anchor, null, 2) + "\n");
      for (const name of removed) rmSync(join(dir, name), { force: true });
      fsyncDir(dir);
    }
  } finally {
    lock();
  }
  if (removed.length) {
    await appendAudit({ actor: "system", action: "audit.pruned", details: { files: removed, retention_days: retentionDays } }, opts);
  }
  return removed;
}
