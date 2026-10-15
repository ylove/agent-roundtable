// ============================================================================
// Contract state: what an execution's event log says about one contract
//
// The blackboard holds only frozen versions, so drafts, consent rounds and objections are read
// back from the contract.* events here: versions (each with its blob), the latest verdict per
// participant (with the version and content hash it was given on), the last consent round and the
// freeze. A verdict counts only for the version it was given on: an AGREE to v1 is no consent to v2.
// contracts/<ctr>/v<N>.json and CONTRACT.md are written for people and tools; nothing reads them back.
// ============================================================================

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { LLM_TIMEOUT_MS, PARALLEL_TURNS } from "../config.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrubDeep } from "./blobs.js";
import { remainingUsd } from "./budget.js";
import { CONTRACT_ID_RE, consentHash, contractMarkdownPath, contractPath, contractTag, renderContractMarkdown, type ParentContext } from "./contract.js";
import { executionDir, listExecutions, openExecutionStore, type FileExecutionStore } from "./store.js";
import type { AnyEvent, Contract, ContractStatus, ConsentVerdict, EventSource, EventType, ExecutionStore } from "./types.js";

export type ResolvedHow = "amended" | "withdrawn" | "excused";

export interface VerdictState {
  /** The latest answer (UNCLEAR also stands for "no answer" in an interrupted round). */
  verdict: ConsentVerdict;
  reason?: string;
  /** The contract version the answer was given on. */
  version: number;
  /** consentHash of what was asked about, when the round recorded it. */
  hash?: string;
  /** The round that recorded it. */
  round?: string;
  seq: number;
  /** An OBJECT or UNCLEAR that was later resolved; `version` is the version it was resolved on. */
  resolved?: { how: ResolvedHow; reason: string; seq: number; version: number };
}

export interface ConsentRound {
  id: string;
  version: number;
  /** consentHash of the version asked about (absent on rounds recorded before WS04 added it). */
  hash?: string;
  participants: string[];
  seq: number;
  ts: string;
  /** The process running the round. */
  pid: number;
  host?: string;
  /** Participants asked in this round whose answer is not recorded yet. */
  pending: string[];
  /** True while answers may still arrive: this process runs it, or its owner may still be alive and it is recent. */
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
  /** consentHash of the latest version (status-independent, so a draft and its freeze match). */
  hash: string;
  status: ContractStatus;
  /** contract.proposed source of v1: "explicit", "fenced:<from>" or "structured:<from>". */
  source: string;
  versions: ContractVersionRef[];
  verdicts: Record<string, VerdictState>;
  round?: ConsentRound;
  /** The first freeze (later versions are amendments). */
  frozen?: { by: string; hash: string; version: number; seq: number; blob: string };
  superseded?: string;
  /** Answers that named a round other than the current one, or repeated an answer: ignored. */
  ignored: number;
}

const CONTRACT_EVENTS: EventType[] = [
  "execution.created", "contract.proposed", "contract.consent_requested", "contract.consent_recorded",
  "contract.objection_resolved", "contract.frozen", "contract.amended", "contract.superseded",
];

/** Own-property write that is safe for any key, "__proto__" included. */
function put<V>(map: Record<string, V>, key: string, value: V): V {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

function own<V>(map: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** A plain-object copy that keeps every key an own property ("__proto__" included). */
export function ownCopy<V>(map: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of Object.keys(map)) put(out, key, map[key]);
  return out;
}

// ---------------------------------------------------------------------------
// Consent rounds running in this process
// ---------------------------------------------------------------------------

const running = new Set<string>();

export function beginConsentRound(roundId: string): void {
  running.add(roundId);
}

export function endConsentRound(roundId: string): void {
  running.delete(roundId);
}

/** However many participants a round has, it counts as in flight for at most this long. */
export const CONSENT_ROUND_STALE_CAP_MS = 10 * 60_000;

/**
 * How long a round run by another process counts as in flight before its missing answers become
 * UNCLEAR: long enough for every participant's call and re-ask, capped at CONSENT_ROUND_STALE_CAP_MS.
 * A round whose owner pid is dead on this host stops counting at once.
 */
export function consentRoundStaleMs(participants: number): number {
  return Math.min(CONSENT_ROUND_STALE_CAP_MS, Math.ceil(Math.max(1, participants) / PARALLEL_TURNS) * 2 * LLM_TIMEOUT_MS + 60_000);
}

/** True when the round's owner is known to be gone: a dead pid on this host. */
function ownerGone(round: Pick<ConsentRound, "pid" | "host">): boolean {
  return round.host === hostname() && Number.isSafeInteger(round.pid) && round.pid > 0 && !pidAlive(round.pid);
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

type OpenRound = Omit<ConsentRound, "pending" | "inFlight"> & { recorded: Set<string> };

/**
 * Build the record of `contractId` (default: the execution's own contract) from the log. An answer
 * counts only for the round it names (and only the first one per participant); an unfinished
 * round that is no longer in flight leaves its missing answers as UNCLEAR.
 */
export async function contractRecord(store: ExecutionStore, contractId?: string, now = Date.now()): Promise<ContractRecord> {
  const id = contractId ?? await primaryContractId(store);
  const events = (await store.events({ types: CONTRACT_EVENTS })).filter((e) => (e.payload as { contract?: string }).contract === id);
  const versions: ContractVersionRef[] = [];
  const verdicts: Record<string, VerdictState> = Object.create(null);
  let source = "";
  let round: OpenRound | undefined;
  let frozen: ContractRecord["frozen"];
  let superseded: string | undefined;
  let ignored = 0;
  const latestVersion = () => versions.at(-1)?.version ?? 1;
  const closeRound = () => {
    if (!round) return;
    for (const agent of round.participants) {
      if (round.recorded.has(agent)) continue;
      put(verdicts, agent, {
        verdict: "UNCLEAR", reason: "no answer was recorded: the consent round was interrupted",
        version: round.version, ...(round.hash && { hash: round.hash }), round: round.id, seq: round.seq,
      });
      round.recorded.add(agent);
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
      case "contract.consent_requested": {
        const p = e.payload;
        closeRound();
        round = {
          id: p.round ?? `seq-${e.seq}`, version: p.version, ...(p.hash && { hash: p.hash }), participants: [...p.participants],
          seq: e.seq, ts: e.ts, pid: e.source.pid, ...(p.host && { host: p.host }), recorded: new Set(),
        };
        break;
      }
      case "contract.consent_recorded": {
        const p = e.payload;
        if (round) {
          const stale = (p.round !== undefined && p.round !== round.id) ||
            (e.contract_version !== undefined && e.contract_version !== round.version) ||
            round.recorded.has(p.agent) || !round.participants.includes(p.agent);
          if (stale) {
            ignored++;
            break;
          }
          round.recorded.add(p.agent);
          put(verdicts, p.agent, {
            verdict: p.verdict, ...(p.reason !== undefined && { reason: p.reason }), version: round.version,
            ...(round.hash && { hash: round.hash }), round: round.id, seq: e.seq,
          });
        } else {
          put(verdicts, p.agent, { verdict: p.verdict, ...(p.reason !== undefined && { reason: p.reason }), version: e.contract_version ?? latestVersion(), seq: e.seq });
        }
        break;
      }
      case "contract.objection_resolved": {
        const p = e.payload;
        const v = own(verdicts, p.agent);
        const resolved = { how: p.how, reason: p.reason, seq: e.seq, version: e.contract_version ?? latestVersion() };
        if (!v) put(verdicts, p.agent, { verdict: "EXCUSED", reason: p.reason, version: resolved.version, seq: e.seq, resolved });
        else if (p.how === "excused" || v.verdict === "OBJECT" || v.verdict === "UNCLEAR") v.resolved = resolved;
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
    const inFlight = pending.length > 0 && (running.has(round.id) ||
      (!ownerGone(round) && now - Date.parse(round.ts) < consentRoundStaleMs(round.participants.length)));
    const { recorded: _r, ...rest } = round;
    if (pending.length > 0 && !inFlight) closeRound();
    open = { ...rest, pending, inFlight };
  }
  const contract = await parseBlob(store, latest.blob);
  const status: ContractStatus = superseded ? "superseded" : frozen ? "frozen" : open?.inFlight ? "consenting" : "draft";
  return {
    id, execution: store.id, version: latest.version, contract, blob: latest.blob, hash: consentHash(contract), status, source, versions,
    verdicts: ownCopy(verdicts), ignored,
    ...(open && { round: open }), ...(frozen && { frozen }), ...(superseded && { superseded }),
  };
}

// ---------------------------------------------------------------------------
// Consent views (a verdict counts only for the version, and content, it was given on)
// ---------------------------------------------------------------------------

/** The verdict given on the record's current version (same version and, when known, same content). */
export function isCurrent(rec: Pick<ContractRecord, "version" | "hash">, v: VerdictState | undefined): boolean {
  return !!v && v.version === rec.version && (v.hash === undefined || v.hash === rec.hash);
}

export type ConsentStanding =
  | { kind: "agree" }
  | { kind: "excused"; reason: string }
  | { kind: "objection"; verdict: "OBJECT" | "UNCLEAR"; reason: string }
  | { kind: "stale"; verdict: ConsentVerdict; version: number }
  | { kind: "missing" };

/** Where one participant stands on the current version. */
export function standing(rec: Pick<ContractRecord, "version" | "hash" | "verdicts">, agent: string): ConsentStanding {
  const v = own(rec.verdicts, agent);
  if (!v) return { kind: "missing" };
  if (v.resolved?.how === "excused" && v.resolved.version === rec.version) return { kind: "excused", reason: v.resolved.reason };
  if (!isCurrent(rec, v)) return { kind: "stale", verdict: v.verdict, version: v.version };
  if (v.verdict === "AGREE" || v.resolved) return { kind: "agree" };
  if (v.verdict === "EXCUSED") return { kind: "excused", reason: v.reason ?? "" };
  return { kind: "objection", verdict: v.verdict === "OBJECT" ? "OBJECT" : "UNCLEAR", reason: v.reason ?? "" };
}

export interface ConsentSummary {
  /** The version the summary is about. */
  version: number;
  participants: number;
  agree: string[];
  excused: Array<{ agent: string; reason: string }>;
  /** Unresolved OBJECT and UNCLEAR answers on this version (UNCLEAR counts as an objection). */
  objections: Array<{ agent: string; verdict: "OBJECT" | "UNCLEAR"; reason: string }>;
  /** Verdicts given on an earlier version: they need re-consent. */
  stale: Array<{ agent: string; verdict: ConsentVerdict; version: number }>;
  /** Participants with no answer at all. */
  missing: string[];
  in_flight: boolean;
  /** Every participant agreed to this version (or was excused on it), and no round is in flight. */
  ready: boolean;
}

/** One verdict per participant, in participant order: EXCUSED when excused on this version, the version noted when it is older. */
export function effectiveConsent(rec: Pick<ContractRecord, "contract" | "verdicts" | "version" | "hash">): Contract["consent"] {
  const out: Contract["consent"] = [];
  for (const { agent } of rec.contract.participants) {
    const v = own(rec.verdicts, agent);
    if (!v) continue;
    const s = standing(rec, agent);
    if (s.kind === "excused") out.push({ agent, verdict: "EXCUSED", reason: s.reason });
    else if (s.kind === "stale") out.push({ agent, verdict: v.verdict, reason: `on v${v.version}${v.reason ? `: ${v.reason}` : ""}` });
    else out.push({ agent, verdict: v.verdict, ...(v.reason !== undefined && { reason: v.reason }) });
  }
  return out;
}

export function summarizeConsent(rec: Pick<ContractRecord, "contract" | "verdicts" | "round" | "version" | "hash">): ConsentSummary {
  const s: ConsentSummary = {
    version: rec.version, participants: rec.contract.participants.length, agree: [], excused: [], objections: [], stale: [], missing: [],
    in_flight: !!rec.round?.inFlight, ready: false,
  };
  for (const { agent } of rec.contract.participants) {
    const st = standing(rec, agent);
    if (st.kind === "agree") s.agree.push(agent);
    else if (st.kind === "excused") s.excused.push({ agent, reason: st.reason });
    else if (st.kind === "objection") s.objections.push({ agent, verdict: st.verdict, reason: st.reason });
    else if (st.kind === "stale") s.stale.push({ agent, verdict: st.verdict, version: st.version });
    else s.missing.push(agent);
  }
  s.ready = !s.in_flight && s.objections.length === 0 && s.stale.length === 0 && s.missing.length === 0;
  return s;
}

/** One line per outcome, for tool results. */
export function describeConsent(s: ConsentSummary): string {
  const parts = [`${s.agree.length} of ${s.participants} agreed to v${s.version}`];
  if (s.excused.length) parts.push(`${s.excused.length} excused`);
  for (const o of s.objections) parts.push(`${o.agent} ${o.verdict === "OBJECT" ? "objects" : "is unclear (counts as an objection)"}${o.reason ? `: ${o.reason.split(/\r?\n/)[0].slice(0, 200)}` : ""}`);
  if (s.stale.length) parts.push(`not yet asked about v${s.version}: ${s.stale.map((x) => `${x.agent} (${x.verdict} on v${x.version})`).join(", ")}`);
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

export interface ParentInfo extends ParentContext {
  record: ContractRecord;
}

/** The budgets of every live child contract of `parentId`'s task `task`, except `exclude`. */
export async function siblingBudgetsUsd(parentId: string, task: string, exclude?: string): Promise<number> {
  let total = 0;
  for (const h of await listExecutions()) {
    try {
      const store = await openExecutionStore(h.id);
      const rec = await contractRecord(store);
      const parent = rec.contract.scope.parent;
      if (rec.id === exclude || rec.superseded || !parent || parent.contract !== parentId || parent.task !== task) continue;
      total += rec.contract.budget.usd;
    } catch {
      /* an execution without a readable contract is no sibling */
    }
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * The parent contract named by a child's scope.parent: its latest version, its depth (walks up at
 * most 8 levels), what it has left to spend on `task`, and what the task's other children have.
 */
export async function loadParent(parentId: string, opts: { task?: string; exclude?: string } = {}): Promise<ParentInfo> {
  const store = await openContractStore(parentId);
  const record = await contractRecord(store, parentId);
  let depth = 0;
  let at = record.contract.scope.parent?.contract;
  const seen = new Set([parentId]);
  while (at) {
    if (seen.has(at) || ++depth > 8) throw new Error(`Contract ${parentId} has a parent chain that loops or is too deep`);
    seen.add(at);
    const up = await contractRecord(await openContractStore(at), at);
    at = up.contract.scope.parent?.contract;
  }
  const state = await store.state();
  // A frozen parent has a ledger; a draft has spent nothing.
  const remaining = state.contract ? remainingUsd(state, opts.task !== undefined ? { task: opts.task } : {}) : record.contract.budget.usd;
  const siblings = opts.task !== undefined ? await siblingBudgetsUsd(parentId, opts.task, opts.exclude) : 0;
  return { record, contract: record.contract, depth, remainingUsd: remaining, siblingsUsd: siblings };
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
