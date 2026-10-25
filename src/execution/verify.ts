// ============================================================================
// Event-log verification: gap-free seqs, prev links, recomputed hashes and whole batches
// ============================================================================

import { constants, readFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { SecureServer, type SecureServerOptions } from "../http/secure-server.js";
import { APP_CSP } from "../prototypes/board.js";
import { normalizeRelPath } from "../security/fs-safe.js";
import { checkPage, pageCheckSummary, pageChecksOff } from "../prototypes/page-check.js";
import { ChromeProcesses, findChrome } from "../prototypes/browser.js";
import { join } from "node:path";
import { EXECUTIONS_DIR } from "../config.js";
import { EXECUTION_ID_RE } from "../ids.js";
import { hashEvent } from "./chain.js";
import { BatchFramer, preview } from "./events.js";
import { readLines } from "./jsonl.js";
import { GENESIS_HASH, type AnyEvent, type EventEnvelope } from "./types.js";

export interface VerifyResult {
  ok: boolean;
  /** The last seq that verified (the end of the last complete batch). */
  seq: number;
  /** The first seq that did not. */
  badSeq?: number;
  reason?: string;
}

/** The recomputed hash, or null when the content cannot be canonicalized (a number such as 1e999). */
function rehash(e: EventEnvelope): string | null {
  try {
    return hashEvent(e.prev, e);
  } catch {
    return null;
  }
}

/**
 * Verify the whole chain of an execution, given its id or its directory. What readers do not
 * read yet is not part of the log and is ignored: a torn last line, or an incomplete batch at
 * the end. Any other line must verify, and a batch may only be incomplete at the end.
 */
export async function verifyExecution(idOrDir: string): Promise<VerifyResult> {
  const dir = EXECUTION_ID_RE.test(idOrDir) ? join(EXECUTIONS_DIR, idOrDir) : idOrDir;
  let executionId: string | undefined;
  try {
    executionId = (JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")) as { id?: string }).id;
  } catch {
    return { ok: false, seq: 0, badSeq: 1, reason: `cannot read ${join(dir, "execution.json")}` };
  }
  let seq = 0; // last line checked
  let committed = 0; // end of the last complete batch
  let prev = GENESIS_HASH;
  let failure: { badSeq: number; reason: string } | undefined;
  const framer = new BatchFramer();
  readLines(join(dir, "events.jsonl"), 0, (line) => {
    const next = seq + 1;
    const fail = (reason: string, badSeq = framer.openSeq ?? next) => {
      failure = { badSeq, reason };
      return false;
    };
    let e: EventEnvelope;
    try {
      e = JSON.parse(line) as EventEnvelope;
    } catch {
      return fail(`the line after seq ${seq} is not valid JSON`, next);
    }
    if (!e || typeof e !== "object" || e.v !== 1) return fail(`seq ${next}: not a version 1 event`, next);
    if (e.seq !== next) return fail(`expected seq ${next}, found ${preview(e.seq)}`, next);
    if (e.execution !== executionId) return fail(`seq ${next}: belongs to execution ${preview(e.execution)}`, next);
    if (e.prev !== prev) return fail(`seq ${next}: prev does not match the hash of seq ${seq}`, next);
    if (rehash(e) !== e.hash) return fail(`seq ${next}: hash does not match its content`, next);
    let batch: AnyEvent[] | null;
    try {
      batch = framer.push(e as AnyEvent);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    seq = e.seq;
    prev = e.hash;
    if (batch) committed = seq;
  });
  if (failure) return { ok: false, seq: committed, badSeq: failure.badSeq, reason: failure.reason };
  return { ok: true, seq: committed };
}

// Task acceptance predicates. These checks serve one committed file, never the repository root.
export interface PageLoadsPredicate { page_loads: { path: string } }
export interface PredicateResult { ok: boolean; skipped?: boolean; note: string }

export async function verifyPageLoads(
  workdir: string,
  predicate: PageLoadsPredicate,
  opts: import("../prototypes/page-check.js").PageCheckOptions & { checkPage?: typeof import("../prototypes/page-check.js").checkPage; signal?: AbortSignal; startServer?: (opts: SecureServerOptions) => Promise<Pick<SecureServer, "url" | "close">> } = {},
): Promise<PredicateResult> {
  const path = normalizeRelPath(predicate.page_loads.path);
  if (!path || /[*?]/.test(path)) return { ok: false, note: "page_loads: invalid path" };
  const off = opts.chromePath === undefined && pageChecksOff();
  const chrome = opts.chromePath ?? (off ? null : findChrome());
  if (!chrome && !opts.checkPage) return { ok: true, skipped: true, note: `page_loads: skipped (${off ? "page checks off" : "no browser"})` };
  const processes = opts.processes ?? new ChromeProcesses();
  const stop = () => processes.killAll();
  let server: Pick<SecureServer, "url" | "close"> | undefined;
  try {
    opts.signal?.throwIfAborted();
    opts.signal?.addEventListener("abort", stop, { once: true });
    const root = await realpath(workdir);
    const file = resolve(root, path);
    // A symlink in any component must not turn a page check into a read outside the worktree.
    if (await realpath(file) !== file) return { ok: false, note: "page_loads: symlink refused" };
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return { ok: false, note: "page_loads: expected a file of at most 2 MB" };
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    server = await (opts.startServer ?? SecureServer.start)({ name: "Page check", allowProxied: p => p === "/p/check/index.html", routes: [
      { path: "/p/check/index.html", handler: c => c.send(200, bytes, "text/html; charset=utf-8", { "Content-Security-Policy": APP_CSP, "X-Frame-Options": "SAMEORIGIN" }) },
    ] });
    const result = await (opts.checkPage ?? checkPage)(`${server.url}p/check/index.html`, { ...opts, ...(chrome && { chromePath: chrome }), processes });
    if (result.reason === "no browser") return { ok: true, skipped: true, note: "page_loads: skipped (no browser)" };
    return { ok: result.loaded && !result.exceptions.length && !result.reason,
      note: pageCheckSummary(result) };
  } catch {
    return { ok: false, note: "page_loads: file could not be checked" };
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    processes.killAll();
    await server?.close();
  }
}
