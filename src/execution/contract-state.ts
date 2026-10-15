// ============================================================================
// Contract state: what an execution's event log says about one contract
//
// The blackboard holds only frozen versions, so drafts, consent rounds and objections are read
// back from the contract.* events here: versions (each with its blob), the latest verdict per
// participant, the last consent round and the freeze. contracts/<ctr>/v<N>.json and CONTRACT.md
// are written for people and tools; nothing reads them back.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LLM_TIMEOUT_MS, PARALLEL_TURNS } from "../config.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrubDeep } from "./blobs.js";
import { CONTRACT_ID_RE, contractMarkdownPath, contractPath, contractTag, renderContractMarkdown } from "./contract.js";
import { executionDir, listExecutions, openExecutionStore, type FileExecutionStore } from "./store.js";
import type { AnyEvent, Contract, ContractStatus, ConsentVerdict, EventSource, EventType, ExecutionStore } from "./types.js";

export type ResolvedHow = "amended" | "withdrawn" | "excused";

export interface VerdictState {
  /** The latest answer (UNCLEAR also stands for "no answer" in an interrupted round). */
  verdict: ConsentVerdict;
  reason?: string;
  /** The contract version the answer was given on. */
  version: number;
  seq: number;
  /** An OBJECT or UNCLEAR that was later resolved. */
  resolved?: { how: ResolvedHow; reason: string; seq: number };
}

export interface ConsentRound {
  version: number;
  participants: string[];
  seq: number;
  ts: string;
  /** Participants asked in this round whose answer is not recorded yet. */
  pending: string[];
  /** True while answers may still arrive: this process runs the round, or it started recently. */
  inFlight: boolean;
}

export interface ContractVersionRef {
  version: number;
  blob: string;
  type: "contract.proposed" | "contract.frozen" | "contract.amended";
  seq: number;
}

export interface ContractRecord {
  id: string;
  execution: string;
  version: number;
  /** The latest version exactly as stored in its blob. */
  contract: Contract;
  blob: string;
  status: ContractStatus;
  /** contract.proposed source of v1: "explicit", "fenced:<from>" or "structured:<from>". */
  source: string;
  versions: ContractVersionRef[];
  verdicts: Record<string, VerdictState>;
  round?: ConsentRound;
  /** The first freeze (later versions are amendments). */
  frozen?: { by: string; hash: string; version: number; seq: number; blob: string };
  superseded?: string;
}

const CONTRACT_EVENTS: EventType[] = [
  "execution.created", "contract.proposed", "contract.consent_requested", "contract.consent_recorded",
  "contract.objection_resolved", "contract.frozen", "contract.amended", "contract.superseded",
];

// ---------------------------------------------------------------------------
// Consent rounds running in this process
// ---------------------------------------------------------------------------

const running = new Set<string>();

export function beginConsentRound(contractId: string): void {
  running.add(contractId);
}

export function endConsentRound(contractId: string): void {
  running.delete(contractId);
}

/**
 * How long a round started by another (possibly dead) process counts as in flight: every
 * participant may need a call and a stricter re-ask, PARALLEL_TURNS at a time, each up to the
 * provider timeout. After that its missing answers count as UNCLEAR.
 */
export function consentRoundStaleMs(participants: number): number {
  return Math.ceil(Math.max(1, participants) / PARALLEL_TURNS) * 2 * LLM_TIMEOUT_MS + 60_000;
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

/** The source an orchestrator-side writer stamps on its events. */
export function orchestratorSource(id: string): EventSource {
  return { kind: "orchestrator", id, pid: process.pid };
}

/** The contract this execution was created for (execution.created names it). */
export async function primaryContractId(store: ExecutionStore): Promise<string> {
  const [created] = await store.events({ types: ["execution.created"], limit: 1 });
  if (!created || created.type !== "execution.created") throw new Error(`Execution ${store.id} has no contract yet`);
  return created.payload.contract;
}

async function parseBlob(store: ExecutionStore, ref: string): Promise<Contract> {
  return JSON.parse((await store.getBlob(ref)).toString("utf8")) as Contract;
}

/**
 * Build the record of `contractId` (default: the execution's own contract) from the log. An
 * unfinished consent round that is no longer in flight leaves its missing answers as UNCLEAR.
 */
export async function contractRecord(store: ExecutionStore, contractId?: string, now = Date.now()): Promise<ContractRecord> {
  const id = contractId ?? await primaryContractId(store);
  const events = (await store.events({ types: CONTRACT_EVENTS })).filter((e) => (e.payload as { contract?: string }).contract === id);
  const versions: ContractVersionRef[] = [];
  const verdicts: Record<string, VerdictState> = {};
  let source = "";
  let round: (Omit<ConsentRound, "pending" | "inFlight"> & { recorded: Set<string> }) | undefined;
  let frozen: ContractRecord["frozen"];
  let superseded: string | undefined;
  const latestVersion = () => versions.at(-1)?.version ?? 1;
  const closeRound = () => {
    if (!round) return;
    for (const agent of round.participants) {
      if (round.recorded.has(agent)) continue;
      verdicts[agent] = { verdict: "UNCLEAR", reason: "no answer was recorded: the consent round was interrupted", version: round.version, seq: round.seq };
    }
  };
  for (const e of events as AnyEvent[]) {
    switch (e.type) {
      case "contract.proposed":
        if (!source) source = e.payload.source;
        versions.push({ version: e.payload.version, blob: e.payload.blob, type: e.type, seq: e.seq });
        break;
      case "contract.frozen":
        frozen ??= { by: e.payload.by, hash: e.payload.hash, version: e.payload.version, seq: e.seq, blob: e.payload.blob! };
        versions.push({ version: e.payload.version, blob: e.payload.blob!, type: e.type, seq: e.seq });
        break;
      case "contract.amended":
        versions.push({ version: e.payload.version, blob: e.payload.blob!, type: e.type, seq: e.seq });
        break;
      case "contract.consent_requested":
        closeRound();
        round = { version: e.payload.version, participants: [...e.payload.participants], seq: e.seq, ts: e.ts, recorded: new Set() };
        break;
      case "contract.consent_recorded": {
        const p = e.payload;
        verdicts[p.agent] = { verdict: p.verdict, ...(p.reason !== undefined && { reason: p.reason }), version: round?.version ?? latestVersion(), seq: e.seq };
        round?.recorded.add(p.agent);
        break;
      }
      case "contract.objection_resolved": {
        const p = e.payload;
        const v = verdicts[p.agent];
        const resolved = { how: p.how, reason: p.reason, seq: e.seq };
        if (!v) verdicts[p.agent] = { verdict: "EXCUSED", reason: p.reason, version: latestVersion(), seq: e.seq, resolved };
        else if (v.verdict === "OBJECT" || v.verdict === "UNCLEAR") v.resolved = resolved;
        break;
      }
      case "contract.superseded":
        superseded = e.payload.by_contract;
        break;
      default:
        break;
    }
  }
  const latest = versions.reduce<ContractVersionRef | undefined>((best, v) => (!best || v.version >= best.version ? v : best), undefined);
  if (!latest) throw new Error(`Contract ${id} not found in execution ${store.id}`);
  let open: ConsentRound | undefined;
  if (round) {
    const pending = round.participants.filter((a) => !round!.recorded.has(a));
    const inFlight = pending.length > 0 && (running.has(id) || now - Date.parse(round.ts) < consentRoundStaleMs(round.participants.length));
    if (pending.length > 0 && !inFlight) closeRound();
    open = { version: round.version, participants: round.participants, seq: round.seq, ts: round.ts, pending, inFlight };
  }
  const contract = await parseBlob(store, latest.blob);
  const status: ContractStatus = superseded ? "superseded" : frozen ? "frozen" : open?.inFlight ? "consenting" : "draft";
  return {
    id, execution: store.id, version: latest.version, contract, blob: latest.blob, status, source, versions, verdicts,
    ...(open && { round: open }), ...(frozen && { frozen }), ...(superseded && { superseded }),
  };
}

// ---------------------------------------------------------------------------
// Consent views
// ---------------------------------------------------------------------------

export interface ConsentSummary {
  participants: number;
  agree: string[];
  excused: Array<{ agent: string; reason: string }>;
  /** Unresolved OBJECT and UNCLEAR answers (UNCLEAR counts as an objection). */
  objections: Array<{ agent: string; verdict: "OBJECT" | "UNCLEAR"; reason: string }>;
  /** Participants with no answer yet. */
  missing: string[];
  in_flight: boolean;
  /** Every participant agreed or was excused, and no round is in flight. */
  ready: boolean;
}

/** One verdict per participant that has one, in participant order (EXCUSED for an excused objection). */
export function effectiveConsent(rec: Pick<ContractRecord, "contract" | "verdicts">): Contract["consent"] {
  const out: Contract["consent"] = [];
  for (const { agent } of rec.contract.participants) {
    const v = Object.hasOwn(rec.verdicts, agent) ? rec.verdicts[agent] : undefined;
    if (!v) continue;
    if (v.resolved?.how === "excused") out.push({ agent, verdict: "EXCUSED", reason: v.resolved.reason });
    else out.push({ agent, verdict: v.verdict, ...(v.reason !== undefined && { reason: v.reason }) });
  }
  return out;
}

export function summarizeConsent(rec: Pick<ContractRecord, "contract" | "verdicts" | "round">): ConsentSummary {
  const s: ConsentSummary = { participants: rec.contract.participants.length, agree: [], excused: [], objections: [], missing: [], in_flight: !!rec.round?.inFlight, ready: false };
  for (const { agent } of rec.contract.participants) {
    const v = Object.hasOwn(rec.verdicts, agent) ? rec.verdicts[agent] : undefined;
    if (!v) s.missing.push(agent);
    else if (v.resolved?.how === "excused" || v.verdict === "EXCUSED") s.excused.push({ agent, reason: v.resolved?.reason ?? v.reason ?? "" });
    else if (v.verdict === "AGREE" || v.resolved) s.agree.push(agent);
    else s.objections.push({ agent, verdict: v.verdict === "OBJECT" ? "OBJECT" : "UNCLEAR", reason: v.reason ?? "" });
  }
  s.ready = !s.in_flight && s.objections.length === 0 && s.missing.length === 0;
  return s;
}

/** One line per outcome, for tool results. */
export function describeConsent(s: ConsentSummary): string {
  const parts = [`${s.agree.length} of ${s.participants} agreed`];
  if (s.excused.length) parts.push(`${s.excused.length} excused`);
  for (const o of s.objections) parts.push(`${o.agent} ${o.verdict === "OBJECT" ? "objects" : "is unclear (counts as an objection)"}${o.reason ? `: ${o.reason.split(/\r?\n/)[0].slice(0, 200)}` : ""}`);
  if (s.missing.length) parts.push(`no answer yet from ${s.missing.join(", ")}`);
  if (s.in_flight) parts.push("a consent round is in flight");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Finding a contract's execution, its parent, and writing its files
// ---------------------------------------------------------------------------

/** Open the execution store holding `contractId` (contract ids carry the execution's 6-character tag). */
export async function openContractStore(contractId: string): Promise<FileExecutionStore> {
  const tag = contractTag(contractId);
  if (!tag) throw new Error(`Not a contract id: ${JSON.stringify(String(contractId).slice(0, 80))} (expected ctr-<6 characters>-<n>)`);
  const matches = (await listExecutions()).filter((h) => h.id.endsWith(tag) && existsSync(join(executionDir(h.id), "contracts", contractId)));
  if (matches.length === 0) throw new Error(`Contract ${contractId} not found`);
  if (matches.length > 1) throw new Error(`Contract id ${contractId} is ambiguous: executions ${matches.map((h) => h.id).join(", ")}`);
  return openExecutionStore(matches[0].id);
}

export interface ParentInfo {
  record: ContractRecord;
  contract: Contract;
  /** Sub-orchestration depth of the parent (0 for a top-level contract). */
  depth: number;
}

/** The parent contract named by a child's scope.parent, with its depth (walks up at most 8 levels). */
export async function loadParent(parentId: string): Promise<ParentInfo> {
  const record = await contractRecord(await openContractStore(parentId), parentId);
  let depth = 0;
  let at = record.contract.scope.parent?.contract;
  const seen = new Set([parentId]);
  while (at) {
    if (seen.has(at) || ++depth > 8) throw new Error(`Contract ${parentId} has a parent chain that loops or is too deep`);
    seen.add(at);
    const up = await contractRecord(await openContractStore(at), at);
    at = up.contract.scope.parent?.contract;
  }
  return { record, contract: record.contract, depth };
}

/** Write contracts/<ctr>/v<N>.json and CONTRACT.md (strings scrubbed of secrets). Returns both paths. */
export function writeContractFiles(store: { dir: string }, c: Contract): { json: string; markdown: string } {
  if (!CONTRACT_ID_RE.test(c.id)) throw new Error(`Not a contract id: ${c.id}`);
  const json = contractPath(store, c.id, c.version);
  const markdown = contractMarkdownPath(store, c.id);
  mkdirPrivate(dirname(json));
  const clean = scrubDeep(c);
  writeFileAtomic(json, JSON.stringify(clean, null, 2) + "\n");
  writeFileAtomic(markdown, renderContractMarkdown(clean));
  return { json, markdown };
}

/** The latest version with its effective status and consent, as tools show it. */
export function presentContract(rec: ContractRecord): Contract {
  return { ...rec.contract, status: rec.status, consent: effectiveConsent(rec) };
}
