// ============================================================================
// Event-log verification: gap-free seqs, prev links and recomputed hashes
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTIONS_DIR } from "../config.js";
import { EXECUTION_ID_RE } from "../ids.js";
import { hashEvent } from "./chain.js";
import { readLines } from "./jsonl.js";
import { GENESIS_HASH, type EventEnvelope } from "./types.js";

export interface VerifyResult {
  ok: boolean;
  /** The last seq that verified. */
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
 * Verify the whole chain of an execution, given its id or its directory. A torn last line (no
 * newline yet) is not part of the log and is ignored; any complete line must verify.
 */
export async function verifyExecution(idOrDir: string): Promise<VerifyResult> {
  const dir = EXECUTION_ID_RE.test(idOrDir) ? join(EXECUTIONS_DIR, idOrDir) : idOrDir;
  let executionId: string | undefined;
  try {
    executionId = (JSON.parse(readFileSync(join(dir, "execution.json"), "utf8")) as { id?: string }).id;
  } catch {
    return { ok: false, seq: 0, badSeq: 1, reason: `cannot read ${join(dir, "execution.json")}` };
  }
  let seq = 0;
  let prev = GENESIS_HASH;
  let failure: string | undefined;
  readLines(join(dir, "events.jsonl"), 0, (line) => {
    const at = `seq ${seq + 1}`;
    let e: EventEnvelope;
    try {
      e = JSON.parse(line) as EventEnvelope;
    } catch {
      failure = `the line after seq ${seq} is not valid JSON`;
      return false;
    }
    if (!e || typeof e !== "object" || e.v !== 1) failure = `${at}: not a version 1 event`;
    else if (e.seq !== seq + 1) failure = `expected seq ${seq + 1}, found ${JSON.stringify(e.seq)}`;
    else if (e.execution !== executionId) failure = `${at}: belongs to execution ${JSON.stringify(e.execution)}`;
    else if (e.prev !== prev) failure = `${at}: prev does not match the hash of seq ${seq}`;
    else if (rehash(e) !== e.hash) failure = `${at}: hash does not match its content`;
    if (failure) return false;
    seq = e.seq;
    prev = e.hash;
  });
  return failure ? { ok: false, seq, badSeq: seq + 1, reason: failure } : { ok: true, seq };
}
