// ============================================================================
// Worker identity: the single-use token file a worker server consumes at startup
//
// The runner writes agents/<id>/token (prepareWorkerFiles) and records its sha256 in
// agent.registered. The worker server claims the file with an atomic rename (so two servers can
// never both read it), reads and unlinks it, and checks the hash against the blackboard in
// constant time. token.used keeps the hash of the last consumed token, so the same token can
// never start a second server. Only the expected path is ever read or unlinked: --token-file
// cannot point the server at another file.
// ============================================================================

import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXECUTION_ID_RE } from "../ids.js";
import { preview } from "../execution/events.js";
import { openExecutionStore, type FileExecutionStore } from "../execution/store.js";
import type { AgentRecord } from "../execution/types.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { agentDir, assertAgentId, TOKEN_RE, tokenSha256 } from "./files.js";

export class WorkerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTokenError";
  }
}

export interface WorkerIdentity {
  execution: string;
  agent: string;
  store: FileExecutionStore;
  record: AgentRecord;
}

/** Constant-time comparison of two lowercase hex digests. */
export function sameDigest(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readClaimed(path: string): string {
  const st = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!st.isFile() || st.size > 256 || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new WorkerTokenError("the token file is not a private regular file of this user");
  }
  return readFileSync(path, "utf8").trim();
}

/**
 * Claim, read and unlink the token file, then verify it against agents[agent].token_sha256.
 * Throws WorkerTokenError (the server must not start) on a wrong path, a missing or reused token,
 * an unknown agent, a departed agent or a mismatch.
 */
export async function consumeWorkerToken(opts: { execution: string; agent: string; tokenFile: string }): Promise<WorkerIdentity> {
  if (typeof opts.execution !== "string" || !EXECUTION_ID_RE.test(opts.execution)) {
    throw new WorkerTokenError(`Not an execution id: ${preview(opts.execution)}`);
  }
  try {
    assertAgentId(opts.agent);
  } catch (e) {
    throw new WorkerTokenError((e as Error).message);
  }
  const dir = agentDir(opts.execution, opts.agent);
  const expected = join(dir, "token");
  if (typeof opts.tokenFile !== "string" || resolve(opts.tokenFile) !== expected) {
    throw new WorkerTokenError(`--token-file must be ${expected}`);
  }
  const claimed = `${expected}.claimed-${process.pid}`;
  try {
    renameSync(expected, claimed);
  } catch {
    throw new WorkerTokenError("no token file: it is missing or was already used");
  }
  let token: string;
  try {
    token = readClaimed(claimed);
  } finally {
    rmSync(claimed, { force: true });
  }
  if (!TOKEN_RE.test(token)) throw new WorkerTokenError("the token file does not hold a token");
  const sha = tokenSha256(token);

  const usedPath = join(dir, "token.used");
  let used = "";
  try {
    used = readFileSync(usedPath, "utf8").trim();
  } catch {
    /* first run */
  }
  if (used && sameDigest(used, sha)) throw new WorkerTokenError("this token was already used");

  const store = await openExecutionStore(opts.execution);
  const state = await store.state();
  const record = Object.hasOwn(state.agents, opts.agent) ? state.agents[opts.agent] : undefined;
  if (!record) throw new WorkerTokenError(`agent ${opts.agent} is not registered in ${opts.execution}`);
  if (record.status === "left") throw new WorkerTokenError(`agent ${opts.agent} has left ${opts.execution}`);
  if (!sameDigest(record.token_sha256, sha)) throw new WorkerTokenError("the token does not match the agent's registration");
  writeFileAtomic(usedPath, sha + "\n");
  return { execution: opts.execution, agent: opts.agent, store, record };
}
