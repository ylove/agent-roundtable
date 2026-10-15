// ============================================================================
// Global security audit log: AUDIT_DIR/audit-YYYY-MM.jsonl, one hash chain across all months
//
// Records confirmations, freezes, excusals, lease violations and purges. Each entry's prev is
// the hash of the entry before it, which for the first entry of a month is the last entry of
// the newest earlier file. Retention deletes whole month files; verification then accepts the
// first remaining entry's prev as the chain's anchor, and the prune itself is audited.
// ============================================================================

import { closeSync, fsyncSync, ftruncateSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_DIR } from "../config.js";
import { scrubDeep } from "../execution/blobs.js";
import { chainHash } from "../execution/chain.js";
import { readLines } from "../execution/jsonl.js";
import { acquireLock, type LockOptions } from "../execution/lock.js";
import { GENESIS_HASH } from "../execution/types.js";
import { mkdirPrivate } from "./fs-safe.js";
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

const AUDIT_LOCK: LockOptions = { staleMs: 10_000, timeoutMs: 30_000 };
const FILE_RE = /^audit-(\d{4})-(\d{2})\.jsonl$/;
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

/**
 * The hash of the newest complete entry, searching from the newest file back. A torn last line
 * in the newest file (a writer died mid-append; we hold the lock, so none is in flight) is cut off.
 */
function chainHead(dir: string, files: string[]): string {
  for (let i = files.length - 1; i >= 0; i--) {
    const path = join(dir, files[i]);
    let last = null as string | null;
    const r = readLines(path, 0, (line) => {
      last = line;
    });
    if (i === files.length - 1 && r.torn > 0) {
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, r.offset);
      } finally {
        closeSync(fd);
      }
      console.error(`[Audit] discarded a torn ${r.torn}-byte line at the end of ${files[i]}`);
    }
    if (last !== null) {
      let hash: unknown;
      try {
        hash = (JSON.parse(last) as { hash?: unknown }).hash;
      } catch {
        hash = undefined;
      }
      // Refuse to extend a chain whose head is unreadable: that would hide the damage.
      if (typeof hash !== "string") throw new Error(`Audit log ${files[i]}: the last entry is corrupt; run verifyAudit()`);
      return hash;
    }
  }
  return GENESIS_HASH;
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
    const prev = chainHead(dir, files);
    // Never write behind the newest file, even if the clock went back.
    const newest = files.at(-1);
    const month = monthOf(now);
    const file = newest && newest > `audit-${month}.jsonl` ? newest : `audit-${month}.jsonl`;
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
    const fd = openSync(join(dir, file), "a", 0o600);
    try {
      if (!lock.held()) throw new Error("appendAudit lost the audit lock; nothing was written");
      let off = 0;
      while (off < line.length) off += writeSync(fd, line, off, line.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return entry as unknown as AuditEntry;
  } finally {
    lock();
  }
}

/** Check every remaining entry, oldest file first. The first entry's prev is accepted as the anchor. */
export async function verifyAudit(opts: Pick<AuditOptions, "dir"> = {}): Promise<AuditVerifyResult> {
  const dir = opts.dir ?? AUDIT_DIR;
  const files = monthFiles(dir);
  let prev: string | null = null;
  let entries = 0;
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
      } else if (prev !== null && e.prev !== prev) {
        failure = "prev does not link to the previous entry";
      } else {
        let hash: string | null;
        try {
          hash = chainHash(e.prev, e);
        } catch {
          hash = null;
        }
        if (hash !== e.hash) failure = "hash does not match its content";
      }
      if (failure) return false;
      prev = e.hash;
      entries++;
    });
    if (failure) return { ok: false, entries, files: files.length, badFile: name, badLine: lineNo, reason: failure };
  }
  return { ok: true, entries, files: files.length };
}

/**
 * Delete month files whose month ended more than retentionDays ago. The newest file is always
 * kept so the chain continues. Returns the deleted file names; a prune that deleted anything is
 * itself recorded as an "audit.pruned" entry.
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
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  } finally {
    lock();
  }
  if (removed.length) {
    await appendAudit({ actor: "system", action: "audit.pruned", details: { files: removed, retention_days: retentionDays } }, opts);
  }
  return removed;
}
