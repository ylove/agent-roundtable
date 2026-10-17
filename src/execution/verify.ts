// ============================================================================
// Event-log verification: gap-free seqs, prev links, recomputed hashes and whole batches
// ============================================================================

import { readFileSync } from "node:fs";
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
