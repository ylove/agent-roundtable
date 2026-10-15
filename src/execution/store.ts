// ============================================================================
// Execution store: EXECUTIONS_DIR/<id>/ holds one heads-down run's event log and blackboard
//
//   execution.json   immutable header, written once
//   events.jsonl     append-only, one event per line, seq gap-free from 1, hash-chained
//   events.lock/     mkdir lock that serializes writers across processes
//   snapshot.json    {reducer_version, seq, offset, hash, state}; replay starts there when it checks out
//   contracts/       contracts/<ctr>/v<N>.json and CONTRACT.md (the contract tools write them)
//   blobs/           content-addressed blobs (blobs.ts)
//
// Writes go through transact(). Reads take no lock: they tail from a byte offset, and a line
// without its final newline is still being written (or was torn by a crash), so it is not read.
// ============================================================================

import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXECUTIONS_DIR } from "../config.js";
import { EXECUTION_ID_RE, newExecutionId, newId } from "../ids.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { applyInPlace, assertResolved, contractBlobRef, initialState, REDUCER_VERSION, type Resolved } from "./blackboard.js";
import { getBlob, putBlob } from "./blobs.js";
import { hashEvent } from "./chain.js";
import { validateDraft } from "./events.js";
import { readLineEndingAt, readLines } from "./jsonl.js";
import { acquireLock, type LockOptions, type LockRelease } from "./lock.js";
import {
  GENESIS_HASH,
  type AnyEvent,
  type AnyEventDraft,
  type BlackboardState,
  type Contract,
  type EventType,
  type ExecutionHeader,
  type ExecutionStore,
  type TransactContext,
} from "./types.js";
import { verifyExecution, type VerifyResult } from "./verify.js";

export { REDUCER_VERSION } from "./blackboard.js";

/** Stale after 10 s (heads-down.md §3): a transaction must finish well within that. */
const EVENTS_LOCK: LockOptions = { staleMs: 10_000, timeoutMs: 30_000 };

export interface CreateExecutionOptions {
  repoRoot: string;
  baseSha: string;
  agentsDir: string;
  /** Defaults to a fresh newExecutionId(). */
  id?: string;
}

export interface SnapshotFile {
  reducer_version: number;
  seq: number;
  /** Byte offset in events.jsonl just past the event at `seq`. */
  offset: number;
  hash: string;
  state: BlackboardState;
}

export interface FileExecutionStore extends ExecutionStore {
  /** Atomically write snapshot.json for the current tail. The runner calls this every 500 events or 60 s. */
  writeSnapshot(): Promise<{ seq: number; offset: number }>;
}

type TransactFn<R> = (
  ctx: TransactContext
) => { events: AnyEventDraft[]; result?: R } | Promise<{ events: AnyEventDraft[]; result?: R }>;

const clone = <T>(v: T): T => structuredClone(v);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The directory of an execution; throws unless `id` is a well-formed execution id. */
export function executionDir(id: string): string {
  if (typeof id !== "string" || !EXECUTION_ID_RE.test(id)) throw new Error(`Not an execution id: ${JSON.stringify(id)}`);
  return join(EXECUTIONS_DIR, id);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

class Store implements FileExecutionStore {
  readonly id: string;
  readonly dir: string;
  private readonly hdr: ExecutionHeader;
  private readonly eventsPath: string;
  private readonly lockDir: string;
  private readonly blobsDir: string;
  private readonly snapshotPath: string;
  private st: BlackboardState;
  /** Bytes of events.jsonl already applied to `st` (always the end of a complete line). */
  private offset = 0;
  /** Transactions of this process run one at a time, so they never poll the lock against each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, header: ExecutionHeader) {
    this.id = header.id;
    this.dir = dir;
    this.hdr = header;
    this.eventsPath = join(dir, "events.jsonl");
    this.lockDir = join(dir, "events.lock");
    this.blobsDir = join(dir, "blobs");
    this.snapshotPath = join(dir, "snapshot.json");
    this.st = initialState(header.id);
  }

  header(): ExecutionHeader {
    return { ...this.hdr };
  }

  /** Start from a valid snapshot when there is one, then replay the rest of the log. */
  load(): void {
    const snap = this.readSnapshot();
    if (snap) {
      this.st = snap.state;
      this.offset = snap.offset;
    }
    this.tail();
  }

  private warn(msg: string): void {
    console.error(`[Store] ${this.id}: ${msg}`);
  }

  /**
   * A snapshot is used only when its reducer_version is ours, it is internally consistent, and the
   * line ending at its offset is the event at its seq with its hash. Anything else means a full replay.
   */
  private readSnapshot(): SnapshotFile | null {
    let raw: string;
    try {
      raw = readFileSync(this.snapshotPath, "utf8");
    } catch {
      return null;
    }
    let snap: SnapshotFile;
    try {
      snap = JSON.parse(raw) as SnapshotFile;
    } catch {
      this.warn("snapshot.json is not valid JSON; replaying the full log");
      return null;
    }
    if (!snap || snap.reducer_version !== REDUCER_VERSION) return null; // another reducer: replay with this one
    const st = snap.state;
    if (
      !Number.isSafeInteger(snap.seq) || snap.seq < 0 ||
      !Number.isSafeInteger(snap.offset) || snap.offset < 0 ||
      !st || typeof st !== "object" || st.execution !== this.id || st.seq !== snap.seq || st.hash !== snap.hash
    ) {
      this.warn("snapshot.json is inconsistent; replaying the full log");
      return null;
    }
    if (snap.seq === 0) return snap.offset === 0 && snap.hash === GENESIS_HASH ? snap : null;
    let at: { seq?: unknown; hash?: unknown } | null = null;
    try {
      const line = readLineEndingAt(this.eventsPath, snap.offset);
      at = line === null ? null : JSON.parse(line);
    } catch {
      at = null;
    }
    if (!at || at.seq !== snap.seq || at.hash !== snap.hash) {
      this.warn(`snapshot.json does not match the event at seq ${snap.seq}; replaying the full log`);
      return null;
    }
    return snap;
  }

  /** Parse one complete line and check it extends the chain we hold. A bad line throws. */
  private parse(line: string, at: number): AnyEvent {
    const where = `${this.eventsPath} at byte ${at}`;
    let ev: AnyEvent;
    try {
      ev = JSON.parse(line) as AnyEvent;
    } catch {
      throw new Error(`Corrupt event line in ${where} (after seq ${this.st.seq})`);
    }
    if (!ev || typeof ev !== "object" || ev.v !== 1 || typeof ev.type !== "string" || typeof ev.hash !== "string") {
      throw new Error(`Corrupt event line in ${where} (after seq ${this.st.seq}): not a version 1 event`);
    }
    if (ev.seq !== this.st.seq + 1) throw new Error(`Event log gap in ${where}: expected seq ${this.st.seq + 1}, found ${ev.seq}`);
    if (ev.prev !== this.st.hash) throw new Error(`Event chain broken in ${where}: seq ${ev.seq} does not link to seq ${this.st.seq}`);
    if (ev.execution !== this.id) throw new Error(`Event in ${where} belongs to execution ${ev.execution}`);
    return ev;
  }

  /** Fetch what apply needs beyond the event: the contract behind contract.frozen/amended. */
  private resolve(ev: AnyEvent): Resolved {
    const ref = contractBlobRef(ev);
    if (!ref) return {};
    let contract: Contract;
    try {
      contract = JSON.parse(getBlob(this.blobsDir, ref).toString("utf8")) as Contract;
    } catch (e) {
      throw new Error(`${ev.type} (seq ${ev.seq}): cannot read the contract blob ${ref}: ${errText(e)}`);
    }
    const resolved = { contract };
    assertResolved(ev, resolved);
    return resolved;
  }

  /** Apply every complete line after our offset. Returns the count of trailing bytes with no newline. */
  private tail(): number {
    return readLines(this.eventsPath, this.offset, (line, start, end) => {
      const ev = this.parse(line, start);
      applyInPlace(this.st, ev, this.resolve(ev));
      this.offset = end;
    }).torn;
  }

  /** Under the lock no append is in flight, so bytes after the last newline are a dead writer's torn line. */
  private discardTorn(torn: number): void {
    const fd = openSync(this.eventsPath, "r+");
    try {
      ftruncateSync(fd, this.offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.warn(`discarded a torn ${torn}-byte line after seq ${this.st.seq}`);
  }

  private envelope(d: AnyEventDraft, seq: number, ts: string, prev: string): AnyEvent {
    const env: Record<string, unknown> = { v: 1, id: newId("evt"), seq, ts, execution: this.id };
    if (d.contract !== undefined) env.contract = d.contract;
    if (d.contract_version !== undefined) env.contract_version = d.contract_version;
    env.mode = d.mode ?? "execution";
    env.source = d.source;
    env.type = d.type;
    env.payload = d.payload;
    if (d.causation !== undefined) env.causation = d.causation;
    if (d.correlation !== undefined) env.correlation = d.correlation;
    env.prev = prev;
    env.hash = hashEvent(prev, env as unknown as AnyEvent);
    return env as unknown as AnyEvent;
  }

  /** One write on an O_APPEND fd, then fsync; refuses if the lock was lost or the log moved meanwhile. */
  private append(buf: Buffer, lock: LockRelease, expectedSize: number): void {
    const fd = openSync(this.eventsPath, "a", 0o600);
    try {
      if (!lock.held()) {
        throw new Error(`transact lost ${this.lockDir} (held longer than ${EVENTS_LOCK.staleMs} ms?); nothing was written`);
      }
      const size = fstatSync(fd).size;
      if (size !== expectedSize || this.offset !== expectedSize) {
        throw new Error(`events.jsonl changed during the transaction (${size} bytes, expected ${expectedSize}); nothing was written`);
      }
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private async runTransaction<R>(fn: TransactFn<R>): Promise<{ events: AnyEvent[]; result?: R }> {
    const lock = await acquireLock(this.lockDir, EVENTS_LOCK);
    try {
      const torn = this.tail();
      if (torn > 0) this.discardTorn(torn);
      const base = { seq: this.st.seq, hash: this.st.hash, offset: this.offset };
      const out = await fn({ state: clone(this.st), header: this.header() });
      if (!out || !Array.isArray(out.events)) throw new Error("transact: fn must return { events: [...] }");
      const drafts = out.events.map((d) => validateDraft(d));
      if (drafts.length === 0) return { events: [], result: out.result };
      const ts = new Date().toISOString();
      const events: AnyEvent[] = [];
      const resolved: Resolved[] = [];
      let prev = base.hash;
      for (const [i, d] of drafts.entries()) {
        const ev = this.envelope(d, base.seq + i + 1, ts, prev);
        resolved.push(this.resolve(ev)); // a contract blob must exist and match before anything is written
        events.push(ev);
        prev = ev.hash;
      }
      const buf = Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
      this.append(buf, lock, base.offset);
      events.forEach((ev, i) => applyInPlace(this.st, ev, resolved[i]));
      this.offset = base.offset + buf.length;
      return { events, result: out.result };
    } finally {
      lock();
    }
  }

  transact<R = void>(fn: TransactFn<R>): Promise<{ events: AnyEvent[]; result?: R }> {
    const run = this.queue.then(() => this.runTransaction(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async state(): Promise<BlackboardState> {
    this.tail();
    return clone(this.st);
  }

  async events(opts: { sinceSeq?: number; types?: EventType[]; limit?: number } = {}): Promise<AnyEvent[]> {
    const since = opts.sinceSeq ?? 0;
    const types = opts.types ? new Set<string>(opts.types) : null;
    const limit = opts.limit ?? Infinity;
    const out: AnyEvent[] = [];
    if (limit <= 0) return out;
    // Pollers ask for what is new: everything after our offset has seq > st.seq >= since.
    const from = since >= this.st.seq ? this.offset : 0;
    readLines(this.eventsPath, from, (line, start) => {
      let ev: AnyEvent;
      try {
        ev = JSON.parse(line) as AnyEvent;
      } catch {
        throw new Error(`Corrupt event line in ${this.eventsPath} at byte ${start}`);
      }
      if (ev.seq <= since || (types && !types.has(ev.type))) return;
      out.push(ev);
      if (out.length >= limit) return false;
    });
    return out;
  }

  async putBlob(content: string | Buffer, opts?: { redact?: boolean }): Promise<string> {
    return putBlob(this.blobsDir, content, opts);
  }

  async getBlob(ref: string): Promise<Buffer> {
    return getBlob(this.blobsDir, ref);
  }

  verify(): Promise<VerifyResult> {
    return verifyExecution(this.dir);
  }

  async writeSnapshot(): Promise<{ seq: number; offset: number }> {
    this.tail();
    const snap: SnapshotFile = {
      reducer_version: REDUCER_VERSION,
      seq: this.st.seq,
      offset: this.offset,
      hash: this.st.hash,
      state: this.st,
    };
    writeFileAtomic(this.snapshotPath, JSON.stringify(snap));
    return { seq: snap.seq, offset: snap.offset };
  }
}

// ---------------------------------------------------------------------------
// Creating, opening, listing
// ---------------------------------------------------------------------------

/** Create a new execution directory (0700) with its header, an empty log, contracts/ and blobs/. */
export async function createExecutionStore(opts: CreateExecutionOptions): Promise<FileExecutionStore> {
  for (const key of ["repoRoot", "baseSha", "agentsDir"] as const) {
    if (typeof opts[key] !== "string" || !opts[key]) throw new Error(`createExecutionStore: ${key} is required`);
  }
  const id = opts.id ?? newExecutionId();
  const dir = executionDir(id);
  mkdirPrivate(EXECUTIONS_DIR);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Execution ${id} already exists`);
    throw e;
  }
  mkdirPrivate(dir);
  mkdirPrivate(join(dir, "contracts"));
  mkdirPrivate(join(dir, "blobs"));
  writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600, flag: "wx" });
  const header: ExecutionHeader = {
    id,
    schema: 1,
    repo_root: resolve(opts.repoRoot),
    base_sha: opts.baseSha,
    agents_dir: resolve(opts.agentsDir),
    created: new Date().toISOString(),
  };
  // Written last: a directory without execution.json is an interrupted create, not an execution.
  writeFileAtomic(join(dir, "execution.json"), JSON.stringify(header, null, 2) + "\n");
  const store = new Store(dir, header);
  store.load();
  return store;
}

function readHeader(dir: string, id: string): ExecutionHeader {
  let header: ExecutionHeader;
  try {
    header = JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")) as ExecutionHeader;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Execution ${id} not found`);
    throw new Error(`Execution ${id}: cannot read execution.json: ${errText(e)}`);
  }
  if (!header || header.schema !== 1 || header.id !== id) throw new Error(`Execution ${id}: execution.json is not a schema 1 header for this id`);
  return header;
}

/** Open an existing execution: load its snapshot if valid, then replay the tail of its log. */
export async function openExecutionStore(id: string): Promise<FileExecutionStore> {
  const dir = executionDir(id);
  const store = new Store(dir, readHeader(dir, id));
  store.load();
  return store;
}

/** Headers of every execution under EXECUTIONS_DIR, oldest first (ids sort by creation time). */
export async function listExecutions(): Promise<ExecutionHeader[]> {
  let names: string[];
  try {
    names = readdirSync(EXECUTIONS_DIR);
  } catch {
    return [];
  }
  const out: ExecutionHeader[] = [];
  for (const name of names.sort()) {
    if (!EXECUTION_ID_RE.test(name)) continue;
    try {
      out.push(readHeader(join(EXECUTIONS_DIR, name), name));
    } catch {
      /* interrupted create or unreadable: not listed */
    }
  }
  return out;
}
