// ============================================================================
// Contract lifecycle: propose, freeze and amend (heads-down.md §8)
//
// Proposing creates the execution store (contract ids carry the execution's tag), writes v1 and
// CONTRACT.md, and records execution.created + contract.proposed. Freezing needs every participant's
// AGREE on the current version (or an audited excusal), records the excusals and contract.frozen in
// one batch and audits the hash. Amending a draft proposes v(N+1) (contract.proposed with reason and
// patch_blob), which every participant must consent to again; amending a frozen contract records
// contract.amended plus task.cancelled for removed tasks and a directive to affected agents, and a
// change to its budget, scope, sandbox, authority, validation, workers or goal first needs everyone's
// consent (or an audited override). Provider calls (structuring, consent) always run outside transact.
// ============================================================================

import { execFile } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AGENTS_DIR, WORKSPACE_DIR } from "../config.js";
import { loadAgent } from "../agents.js";
import { newExecutionId, newId } from "../ids.js";
import { appendAudit } from "../security/audit.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { readArchivedSession, type ArchivedSession } from "../sessions/archive.js";
import { sessionDissentDrafts } from "../sessions/dissents.js";
import { isSessionBusy } from "../sessions/lock.js";
import { scrubbedJSON } from "./blobs.js";
import { pausedBy } from "./escalation.js";
import { canonicalJSON } from "./chain.js";
import {
  affectedTasks,
  applyMergePatch,
  contractHash,
  contractIdFor,
  createMergePatch,
  CONTRACT_LIMITS,
  validateContract,
  type AffectedTasks,
  type CheckOptions,
} from "./contract.js";
import { blockToContract, findTaskBlock, sessionSource, structureContract, TASK_BLOCK_TAG, type BlockText, type SessionSource } from "./contract-parse.js";
import {
  contractRecord,
  describeConsent,
  effectiveConsent,
  loadParent,
  openContractStore,
  orchestratorSource,
  presentContract,
  ownCopy,
  standing,
  summarizeConsent,
  writeContractFiles,
  type ConsentSummary,
  type ContractRecord,
  type ParentInfo,
  type VerdictState,
} from "./contract-state.js";
import { requestConsent, resolveConsentLLM, type ConsentLLMOptions } from "./consent.js";
import { createExecutionStore } from "./store.js";
import {
  CONTRACT_SCHEMA,
  type AnyEventDraft,
  type AuthorityAction,
  type Contract,
  type ContractBudget,
  type ContractStatus,
  type EventSource,
  type ExecutionStore,
} from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mode = (status: string) => (status === "created" ? "deliberation" as const : "execution" as const);
const parentOpt = (p: ParentInfo | undefined): CheckOptions =>
  p ? { parent: { contract: p.contract, depth: p.depth, remainingUsd: p.remainingUsd, siblingsUsd: p.siblingsUsd } } : {};

// ---------------------------------------------------------------------------
// Git: the repository top level and the base commit (a deliberately tiny helper)
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
/** No fsmonitor daemon and no hooks: resolving a ref must never run repository code. */
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", [...GIT_SAFE, "-C", cwd, ...args], {
      env: childEnv("git"), timeout: 15_000, maxBuffer: 1 << 20, encoding: "utf8",
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(scrubAndCap((err.stderr || err.message || String(e)).trim().split("\n")[0], 300));
  }
}

/** The real path of the git top level containing `dir`, and the commit `ref` names there. */
export async function resolveRepo(dir: string, ref = "HEAD"): Promise<{ root: string; sha: string }> {
  const start = resolve(dir);
  let root: string;
  try {
    root = realpathSync(await git(start, ["rev-parse", "--show-toplevel"]));
  } catch (e) {
    throw new Error(`repo_dir ${start} is not inside a git repository (${errText(e)})`);
  }
  if (typeof ref !== "string" || !ref.trim() || ref.startsWith("-") || /[\0\s]/.test(ref)) {
    throw new Error(`base_ref ${JSON.stringify(String(ref).slice(0, 80))} is not a valid git ref`);
  }
  let sha: string;
  try {
    sha = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    sha = "";
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`base_ref ${JSON.stringify(ref)} does not name a commit in ${root}`);
  return { root, sha };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ContractResult {
  contractId: string;
  executionId: string;
  version: number;
  status: ContractStatus;
  /** The latest version, with its effective status and consent. */
  contract: Contract;
  warnings: string[];
  consent: ConsentSummary;
  /** propose: where the structure came from ("explicit", "fenced:<from>", "structured:<from>"). */
  source?: string;
  /** freeze, and amendments of a frozen contract: the frozen sha256. */
  hash?: string;
  /** amend: the tasks the amendment touches. */
  affected?: AffectedTasks;
  /** Participants asked in a consent round run by this call. */
  asked?: string[];
  paths: { json: string; markdown: string };
  next: string;
}

/** Refused for reasons the caller can fix (all of them listed). */
export class ContractRefusal extends Error {
  constructor(readonly action: string, readonly contractId: string, readonly reasons: string[]) {
    super(`Cannot ${action} ${contractId}:\n- ${reasons.join("\n- ")}`);
    this.name = "ContractRefusal";
  }
}

/** An amendment outside the lead's authority: `needs` lists what it would take. */
export class AuthorityError extends Error {
  constructor(readonly contractId: string, readonly needs: string[]) {
    super(`Amendment of ${contractId} refused: outside the lead's authority:\n- ${needs.join("\n- ")}`);
    this.name = "AuthorityError";
  }
}

function nextStep(rec: ContractRecord, s: ConsentSummary): string {
  const id = rec.id;
  const v = rec.version;
  const objections = s.objections.map((o) => `${o.agent} (${o.verdict}${o.reason ? `: ${o.reason.split(/\r?\n/)[0].slice(0, 160)}` : ""})`).join("; ");
  const unasked = [...s.stale.map((x) => `${x.agent} (${x.verdict} on v${x.version})`), ...s.missing];
  if (rec.status === "frozen") {
    const parts = [`Frozen at v${v}.`];
    if (s.objections.length) parts.push(`On v${v}: ${objections}. Amend it again with amend_contract, or pause the run.`);
    if (unasked.length) parts.push(`Not asked about v${v}: ${unasked.join(", ")}.`);
    if (parts.length === 1) parts.push("Show the contract to the human: the heads-down run starts only when they ask for it (execute).");
    return parts.join(" ");
  }
  if (s.in_flight) return `A consent round on v${v} is in flight: wait for it to finish (or pass abandon_round to freeze_contract if its process died), then freeze_contract.`;
  if (s.ready) return `Every participant agreed to v${v}. Show the contract to the human, then freeze it: freeze_contract { "contract_id": "${id}", "orchestrator": "${rec.contract.scope.orchestrator}" }.`;
  const parts: string[] = [];
  if (s.objections.length) {
    parts.push(`Objections to v${v}: ${objections}. Address them with amend_contract { "contract_id": "${id}", "patch": {…}, "reason": "…", "consent": true } ` +
      "(every participant is asked about the new version), or excuse them with a reason in freeze_contract { \"excuse\": [{ \"agent\", \"reason\" }] }.");
  }
  if (unasked.length) {
    parts.push(`Nobody has consented to v${v} yet from: ${unasked.join(", ")}. Ask with amend_contract { "contract_id": "${id}", "patch": {}, "reason": "consent", "consent": true }.`);
  }
  return parts.join(" ");
}

async function resultFor(store: ExecutionStore, contractId: string, extra: Partial<ContractResult> & { warnings: string[] }): Promise<ContractResult> {
  const rec = await contractRecord(store, contractId);
  const contract = presentContract(rec);
  const summary = summarizeConsent(rec);
  let paths: ContractResult["paths"];
  try {
    paths = writeContractFiles(store, contract);
  } catch (e) {
    extra.warnings.push(`could not write the contract files: ${errText(e)}`);
    paths = { json: "", markdown: "" };
  }
  return {
    contractId, executionId: store.id, version: rec.version, status: rec.status, contract, consent: summary,
    ...(rec.frozen && { hash: contract.frozen?.hash ?? rec.frozen.hash }),
    ...extra, paths, next: nextStep(rec, summary),
  };
}

async function audit(warnings: string[], entry: Parameters<typeof appendAudit>[0]): Promise<void> {
  try {
    await appendAudit(entry);
  } catch (e) {
    warnings.push(`the audit log entry ${entry.action} could not be written: ${errText(e)}`);
    console.error(`[Contracts] audit ${entry.action} failed: ${errText(e)}`);
  }
}

/** The contract as it will be stored (strings scrubbed), with status set and without consent or freeze record: what the hash covers. */
function storedBody(c: Contract, status: ContractStatus): Contract {
  const body = JSON.parse(scrubbedJSON({ ...c, status, consent: [] })) as Contract;
  delete body.frozen;
  return body;
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export interface ProposeContractOptions {
  /** The ultimate goal (goal.ultimate). */
  goal: string;
  /** The orchestrator that owns the contract; only it can freeze it. */
  orchestrator: string;
  title?: string;
  /** The human's request, verbatim; defaults to the archived session's task or topic. */
  originalPrompt?: string;
  /** Repository paths or URLs the goal refers to. */
  artifacts?: string[];
  /** An archived session (an ultraplan, collaboration, …) to build from. */
  fromSession?: string;
  /** Plan text: searched for a roundtable-tasks block, else structured by a provider call. */
  plan?: string;
  /** An explicit contract (with tasks, it is the structure; without, it overlays the structure). */
  contract?: Record<string, unknown>;
  parentContract?: string;
  parentTask?: string;
  /** Agent refs that must consent (default: the session's agents and the task personas). */
  participants?: string[];
  /** Default WORKSPACE_DIR (or the parent's repository); resolved to the git top level. */
  repoDir?: string;
  /** Default HEAD (or the parent's base); resolved to a commit sha. */
  baseRef?: string;
  /** Run the consent round right away. */
  consent?: boolean;
  llm?: ConsentLLMOptions;
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split(/\r?\n/)[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function artifactRefs(list: string[] | undefined): Contract["goal"]["artifacts"] | undefined {
  return list?.map((ref) => ({ kind: /^https?:\/\//i.test(ref) ? "url" : "file", ref }));
}

function archived(id: string): ArchivedSession {
  const r = readArchivedSession(id);
  if (!r) {
    throw new Error(`from_session not found in the archive: ${id}. Pass the id of an ended session ` +
      "(an ultraplan closes with submit_plan final: true or end_ultraplan; a collaboration with end_collaboration).");
  }
  return r;
}

/** The last roundtable-tasks block of the first text that has one, with where it came from. */
function locateBlock(texts: Array<BlockText | { from: string; text?: string; warn?: string }>): { from: string; value: unknown; warn?: string } | undefined {
  for (const { from, text, warn } of texts) {
    let value: unknown;
    try {
      value = findTaskBlock(text);
    } catch (e) {
      throw new Error(`${from}: ${errText(e)}`);
    }
    if (value !== undefined) return { from, value, ...(warn && { warn }) };
  }
  return undefined;
}

function listErrors(errors: string[], max = 40): string {
  return errors.slice(0, max).join("\n- ") + (errors.length > max ? `\n- … and ${errors.length - max} more` : "");
}

const PROTECTED_PROPOSAL = ["id", "version", "status", "consent", "frozen"] as const;

/** Build, validate and store a new contract (draft v1) in a new execution; optionally run consent. */
export async function proposeContract(o: ProposeContractOptions): Promise<ContractResult> {
  if (typeof o.goal !== "string" || !o.goal.trim()) throw new Error("goal is required: state the ultimate goal the contract delivers");
  if (typeof o.orchestrator !== "string" || !o.orchestrator.trim()) throw new Error("orchestrator is required: name yourself (e.g. main)");
  if ((o.parentContract === undefined) !== (o.parentTask === undefined)) throw new Error("parent_contract and parent_task go together");
  const warnings: string[] = [];
  const orchestrator = o.orchestrator.trim();
  const session = o.fromSession ? archived(o.fromSession) : undefined;
  const sessionDissents = session ? sessionDissentDrafts(session) : [];
  const src: SessionSource | undefined = session && sessionSource(session);
  if (src?.kind === "ultraplan" && src.signedOff === false) {
    warnings.push(`${o.fromSession} was not signed off: an objection or unclear sign-off stands, or it was ended without sign-off`);
    if (session?.document?.signoffs.some((s) => s.verdict === "OBJECT" && s.content.length > CONTRACT_LIMITS.dissent_claim)) {
      warnings.push("Imported OBJECT text was capped at 500 characters; the full sign-off remains in the source archive. Refine its prediction and tripwire before freeze.");
    }
  }
  const originalPrompt = o.originalPrompt?.trim() ? o.originalPrompt : src?.topic?.trim() ? src.topic : undefined;
  if (!originalPrompt) throw new Error("original_prompt is required: pass the human's request verbatim (or from_session, whose task is used)");

  const explicit: Obj | undefined = o.contract === undefined ? undefined : isObj(o.contract) ? { ...o.contract } : undefined;
  if (o.contract !== undefined && !explicit) throw new Error("contract must be a JSON object");
  for (const key of PROTECTED_PROPOSAL) {
    if (explicit && explicit[key] !== undefined) {
      warnings.push(`contract.${key} is set by propose_contract; the value given was ignored`);
      delete explicit[key];
    }
  }

  let parent: ParentInfo | undefined;
  if (o.parentContract && o.parentTask) {
    parent = await loadParent(o.parentContract, { task: o.parentTask });
    const task = parent.contract.tasks.find((t) => t.id === o.parentTask);
    if (!task) throw new Error(`parent_task ${o.parentTask} is not a task of ${o.parentContract}`);
    const allowed = [task.persona, parent.contract.scope.orchestrator];
    if (!allowed.includes(orchestrator)) {
      throw new Error(`Only the parent task's persona (${task.persona}) or the parent's orchestrator (${parent.contract.scope.orchestrator}) can orchestrate a child contract of ${o.parentContract}/${o.parentTask}`);
    }
  }
  const explicitScope = explicit && isObj(explicit.scope) ? explicit.scope : {};
  const repoDir = o.repoDir ?? (typeof explicitScope.repo_root === "string" ? explicitScope.repo_root : undefined) ?? parent?.contract.scope.repo_root ?? WORKSPACE_DIR;
  const baseRef = o.baseRef ?? (typeof explicitScope.base_ref === "string" ? explicitScope.base_ref : undefined) ?? parent?.contract.scope.base_ref ?? "HEAD";
  const { root, sha } = await resolveRepo(repoDir, baseRef);

  const executionId = newExecutionId();
  const contractId = contractIdFor(executionId, 1);
  const artifacts = artifactRefs(o.artifacts);
  const fixed: Obj = {
    schema: CONTRACT_SCHEMA, id: contractId, version: 1, status: "draft", consent: [],
    goal: { ultimate: o.goal.trim(), original_prompt: originalPrompt, ...(artifacts && { artifacts }), ...(o.fromSession && { source_session: o.fromSession }) },
    scope: { orchestrator, repo_root: root, base_ref: sha, ...(o.parentContract && o.parentTask && { parent: { contract: o.parentContract, task: o.parentTask } }) },
    ...(o.title?.trim() && { title: o.title.trim() }),
    ...(o.participants?.length && { participants: o.participants }),
  };
  const assemble = (structure: Obj): Obj => {
    const c = applyMergePatch<Obj>(applyMergePatch(structure, explicit ?? {}), fixed);
    if (c.title === undefined) c.title = firstLine(o.goal);
    if (c.participants === undefined && src && Array.isArray(c.tasks)) {
      const personas = c.tasks.map((t) => (isObj(t) && typeof t.persona === "string" ? t.persona : "")).filter(Boolean);
      c.participants = [...new Set([...src.agents, ...personas])];
    }
    if (session?.kind === "ultraplan" && session.document?.signedOff === false) {
      if (c.dissents != null && !Array.isArray(c.dissents)) return c; // Preserve malformed input for validation.
      const dissents = Array.isArray(c.dissents) ? [...c.dissents] : [];
      for (const [i, s] of session.document.signoffs.entries()) {
        if (s.verdict !== "OBJECT") continue;
        const participants = Array.isArray(c.participants) ? [...c.participants] : [];
        if (!participants.some((p) => p === s.agent || (isObj(p) && p.agent === s.agent))) participants.push(s.agent);
        c.participants = participants;
        let id = `ultraplan-object-${i + 1}`;
        while (dissents.some((d) => isObj(d) && d.id === id)) id += "-x";
        const text = s.content.trim() || "OBJECT sign-off: specify the predicted failure and tripwire before freeze.";
        dissents.push({ id, by: s.agent, source: { kind: "ultraplan", ref: session.id },
          claim: text.slice(0, CONTRACT_LIMITS.dissent_claim), predicted_failure: text.slice(0, CONTRACT_LIMITS.dissent_prediction), on_fire: "huddle" });
      }
      c.dissents = dissents;
    }
    if (sessionDissents.length) {
      if (c.dissents != null && !Array.isArray(c.dissents)) return c;
      const dissents = Array.isArray(c.dissents) ? [...c.dissents] : [];
      const participants = Array.isArray(c.participants) ? [...c.participants] : [];
      for (const d of sessionDissents) {
        let id = d.id;
        while (dissents.some((existing) => isObj(existing) && existing.id === id)) id += "-x";
        dissents.push({ ...d, id });
        if (!participants.some((p) => p === d.by || (isObj(p) && p.agent === d.by))) participants.push(d.by);
      }
      c.dissents = dissents;
      c.participants = participants;
    }
    return c;
  };
  const checkOpts = parentOpt(parent);

  let source: string;
  let structure: Obj;
  if (explicit && explicit.tasks !== undefined) {
    source = "explicit";
    structure = {};
  } else {
    const block = locateBlock([{ from: "plan", text: o.plan }, ...(src?.blockTexts ?? [])]);
    if (block) {
      const parsed = blockToContract(block.value);
      if (parsed.errors.length) throw new Error(`The ${TASK_BLOCK_TAG} block in ${block.from} is not usable:\n- ${listErrors(parsed.errors)}`);
      source = `fenced:${block.from.startsWith(o.fromSession ?? "\0") ? o.fromSession : block.from}`;
      structure = parsed.contract;
      if (block.warn) warnings.push(block.warn);
    } else {
      const plan = o.plan?.trim() ? o.plan : src?.planText;
      if (!plan?.trim()) throw new Error("propose_contract needs a structure: pass contract (with tasks), a plan, or from_session");
      if (!o.plan?.trim() && src?.kind === "ultraplan") {
        warnings.push(`no plan version of ${o.fromSession} has a ${TASK_BLOCK_TAG} block: the structure comes from a structuring call over the final plan (start the ultraplan with execution_ready: true to get one)`);
      }
      const draft = assemble({});
      const scopePaths = isObj(draft.scope) && Array.isArray(draft.scope.paths) ? draft.scope.paths.map(String) : parent?.contract.tasks.find((t) => t.id === o.parentTask)?.paths.write ?? ["**"];
      const structured = await structureContract({
        goal: o.goal.trim(), originalPrompt, plan,
        participants: o.participants ?? (Array.isArray(draft.participants) ? draft.participants.map(String) : src?.agents ?? []),
        scopePaths,
      }, resolveConsentLLM(o.llm), async (s) => (await validateContract(assemble(s), checkOpts)).errors);
      source = `structured:${o.plan?.trim() ? "plan" : o.fromSession}`;
      structure = structured.structure;
    }
  }
  const v = await validateContract(assemble(structure), checkOpts);
  if (!v.ok) throw new Error(`The contract is not valid:\n- ${listErrors(v.errors)}`);
  warnings.push(...v.warnings);

  const store = await createExecutionStore({ repoRoot: root, baseSha: sha, agentsDir: resolve(AGENTS_DIR), id: executionId });
  const by = orchestratorSource(orchestrator);
  try {
    const blob = await store.putBlob(scrubbedJSON(v.contract), { redact: false });
    writeContractFiles(store, v.contract);
    await store.transact(() => ({
      events: [
        { type: "execution.created", source: by, mode: "deliberation", contract: contractId, contract_version: 1,
          payload: { repo_root: root, base_sha: sha, contract: contractId, contract_version: 1 } },
        { type: "contract.proposed", source: by, mode: "deliberation", contract: contractId, contract_version: 1,
          payload: { contract: contractId, version: 1, source, blob } },
      ],
    }));
  } catch (e) {
    rmSync(store.dir, { recursive: true, force: true }); // nothing references a store whose first transaction failed
    throw e;
  }
  let asked: string[] | undefined;
  if (o.consent) {
    try {
      const round = await requestConsent(store, contractId, { by: orchestrator, llm: o.llm });
      asked = round.asked;
      if (round.dropped) warnings.push(round.dropped);
    } catch (e) {
      warnings.push(`the consent round failed: ${errText(e)}`);
    }
  }
  return resultFor(store, contractId, { warnings, source, ...(asked && { asked }) });
}

// ---------------------------------------------------------------------------
// Draft dissents
// ---------------------------------------------------------------------------

export interface FileDissentOptions {
  by: string;
  contractId?: string;
  /** Agent callers must come from the tool layer's authenticated worker identity. */
  source?: EventSource;
  /** The objector explicitly consents to this new version while retaining their dissent. */
  resolveObjection?: boolean;
  /** Orchestrator-only excusal: remove the draft by id, retaining its prior blob and this reason. */
  excuseReason?: string;
}

/** File or replace a structured draft concern, or explicitly excuse it. Every edit creates v(N+1). */
export async function fileDissent(store: ExecutionStore, input: Record<string, unknown>, opts: FileDissentOptions): Promise<ContractResult> {
  const rec = await contractRecord(store, opts.contractId);
  const source = opts.source ?? orchestratorSource(opts.by);
  const orchestrator = source.kind === "orchestrator" && opts.by === rec.contract.scope.orchestrator;
  const agent = source.kind === "agent" && rec.contract.participants.some((p) => p.agent === opts.by);
  if (source.id !== opts.by || (!orchestrator && !agent)) throw new ContractRefusal("file dissent", rec.id, ["only the contract's orchestrator or an authenticated participant may file"]);
  if (rec.frozen || rec.superseded) throw new ContractRefusal("file dissent", rec.id, ["dissents can only be filed while the contract is a draft"]);
  if (rec.round?.inFlight) throw new ContractRefusal("file dissent", rec.id, ["a consent round is in flight; wait for it to finish"]);
  if (!isObj(input)) throw new Error("dissent must be an object");
  const existing = (rec.contract.dissents ?? []).find((d) => d.id === input.id);
  const excusing = opts.excuseReason !== undefined;
  let dissent: Record<string, unknown>;
  let reason: string;
  if (excusing) {
    if (!orchestrator) throw new Error("only the contract's orchestrator may excuse a dissent");
    if (!existing) throw new Error(`Unknown dissent ${String(input.id)}`);
    if (typeof opts.excuseReason !== "string" || !opts.excuseReason.trim()) throw new Error("excuse_reason must be non-empty");
    if (opts.resolveObjection) throw new Error("excusing a dissent does not resolve an objection");
    dissent = { ...existing };
    reason = `Excused dissent ${existing.id}: ${opts.excuseReason.trim()}`;
  } else {
    if (agent && ((input.by !== undefined && input.by !== opts.by) || (existing && existing.by !== opts.by))) {
      throw new Error("an agent may file or replace only their own dissent");
    }
    dissent = { ...input, ...(agent && { by: opts.by }) };
    if (opts.resolveObjection) {
      const s = standing(rec, opts.by);
      if (dissent.by !== opts.by || s.kind !== "objection" || s.verdict !== "OBJECT") {
        throw new Error("how: dissented requires the objector's own unresolved OBJECT on the current version");
      }
      dissent.source = { kind: "consent", ref: `${rec.id}:v${rec.version}` };
    }
    reason = `${existing ? "Updated" : "Filed"} dissent ${String(dissent.id)} by ${String(dissent.by)}`;
  }
  const dissents: unknown[] = (rec.contract.dissents ?? []).filter((d) => d.id !== dissent.id);
  if (!excusing) dissents.push(dissent);
  const parent = rec.contract.scope.parent
    ? await loadParent(rec.contract.scope.parent.contract, { task: rec.contract.scope.parent.task, exclude: rec.id }) : undefined;
  const v = await validateContract({ ...rec.contract, status: "draft", version: rec.version + 1, consent: [], dissents }, parentOpt(parent));
  if (!v.ok) throw new Error(`The dissent is not valid:\n- ${listErrors(v.errors)}`);
  const blob = await store.putBlob(scrubbedJSON(v.contract), { redact: false });
  const patchBlob = await store.putBlob(scrubbedJSON({ dissents: v.contract.dissents }), { redact: false });
  await store.transact(async () => {
    const now = await contractRecord(store, rec.id);
    if (now.frozen || now.superseded || now.version !== rec.version || now.round?.inFlight) throw new Error("The draft changed meanwhile; review the latest version before filing");
    if (opts.resolveObjection && now.verdicts[opts.by]?.seq !== rec.verdicts[opts.by]?.seq) throw new Error("The objection changed meanwhile; review it before resolving");
    const events: AnyEventDraft[] = [{
      type: "contract.proposed", source, mode: "deliberation", contract: rec.id, contract_version: v.contract.version,
      payload: { contract: rec.id, version: v.contract.version, source: "dissent", blob, reason, patch_blob: patchBlob },
    }];
    if (opts.resolveObjection) events.push({
      type: "contract.objection_resolved", source, mode: "deliberation", contract: rec.id, contract_version: v.contract.version,
      payload: { contract: rec.id, agent: opts.by, how: "dissented", reason, dissent_id: dissent.id as string },
    });
    return { events };
  });
  const warnings = [...v.warnings];
  if (excusing) await audit(warnings, { actor: opts.by, action: "contract.dissent_excused", target: rec.id,
    details: { execution: store.id, version: v.contract.version, dissent_id: dissent.id, reason: opts.excuseReason!.trim() } });
  return resultFor(store, rec.id, { warnings });
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

export interface FreezeOptions {
  /** The caller: must be the contract's scope.orchestrator. */
  orchestrator: string;
  /** Objections, stale or missing answers to set aside, each with a reason; every excusal is audited. */
  excuse?: Array<{ agent: string; reason: string }>;
  /**
   * Declare a consent round whose process died (or hangs) abandoned: its missing answers are
   * recorded as UNCLEAR (so they still need excusing) and the abandonment is audited.
   */
  abandonRound?: boolean;
}

/** Every reason a freeze would be refused right now, given the excusals. */
function freezeBlockers(rec: ContractRecord, excuse: Array<{ agent: string; reason: string }>, orchestrator: string): string[] {
  const reasons: string[] = [];
  if (orchestrator !== rec.contract.scope.orchestrator) {
    reasons.push(`only the contract's orchestrator (${rec.contract.scope.orchestrator}) can freeze it; ${orchestrator} cannot`);
  }
  if (rec.round?.inFlight) reasons.push(`a consent round is in flight (${rec.round.pending.length} answers pending); wait, or pass abandon_round if its process died`);
  for (const d of rec.contract.dissents ?? []) {
    if (!d.tripwire) reasons.push(`dissent ${d.id} needs a tripwire before freeze or explicit excusal with file_dissent (excuse_reason)`);
  }
  const participants = rec.contract.participants.map((p) => p.agent);
  const excused = new Set<string>();
  const ok = (agent: string) => ["agree", "excused"].includes(standing(rec, agent).kind);
  for (const [i, x] of excuse.entries()) {
    if (!isObj(x) || typeof x.agent !== "string" || !x.agent.trim()) reasons.push(`excuse[${i}].agent is required`);
    else if (typeof x.reason !== "string" || !x.reason.trim()) reasons.push(`excuse[${i}] (${x.agent}) needs a reason`);
    else if (!participants.includes(x.agent)) reasons.push(`excuse[${i}]: ${x.agent} is not a participant`);
    else if (ok(x.agent)) reasons.push(`excuse[${i}]: ${x.agent} already agreed to v${rec.version}: there is nothing to excuse`);
    else excused.add(x.agent);
  }
  for (const agent of participants) {
    if (ok(agent) || excused.has(agent)) continue;
    const s = standing(rec, agent);
    if (s.kind === "missing") reasons.push(`${agent} has not consented: run a consent round or excuse them`);
    else if (s.kind === "stale") reasons.push(`${agent} answered ${s.verdict} on v${s.version}, not on v${rec.version}: ask again (amend_contract with patch {} and consent: true) or excuse them`);
    else if (s.kind === "objection") reasons.push(`${agent} ${s.verdict === "OBJECT" ? "objects" : "is unclear, which counts as an objection"}${s.reason ? `: ${s.reason.split(/\r?\n/)[0].slice(0, 200)}` : ""}`);
  }
  return reasons;
}

/** Record UNCLEAR for the pending participants of the open round (only if it is still the same round). */
async function abandonRound(store: ExecutionStore, rec: ContractRecord, orchestrator: string, warnings: string[]): Promise<void> {
  const round = rec.round;
  if (!round || round.pending.length === 0) {
    warnings.push("abandon_round: there was no unfinished consent round");
    return;
  }
  const source = orchestratorSource(orchestrator);
  await store.transact(async ({ state }) => {
    const now = await contractRecord(store, rec.id);
    if (now.round?.id !== round.id) return { events: [] };
    return {
      events: now.round.pending.map((agent) => ({
        type: "contract.consent_recorded" as const, source, mode: mode(state.status), contract: rec.id, contract_version: round.version,
        payload: { contract: rec.id, agent, verdict: "UNCLEAR" as const, reason: "no answer: the orchestrator abandoned the consent round", round: round.id },
      })),
    };
  });
  await audit(warnings, {
    actor: orchestrator, action: "contract.consent_round_abandoned", target: rec.id,
    details: { execution: store.id, version: round.version, round: round.id, pending: round.pending, owner_pid: round.pid, ...(round.host && { owner_host: round.host }) },
  });
}

/** freezeContract on an open store. */
export async function freezeContractIn(store: ExecutionStore, contractId: string, opts: FreezeOptions): Promise<ContractResult> {
  const orchestrator = typeof opts.orchestrator === "string" ? opts.orchestrator.trim() : "";
  if (!orchestrator) throw new Error("orchestrator is required: only an orchestrator can freeze a contract");
  const excuse = opts.excuse ?? [];
  const warnings: string[] = [];
  let rec = await contractRecord(store, contractId);
  if (rec.superseded) throw new ContractRefusal("freeze", contractId, [`it was superseded by ${rec.superseded}`]);
  if (rec.frozen) throw new ContractRefusal("freeze", contractId, [`it is already frozen (v${rec.frozen.version} by ${rec.frozen.by}); change it with amend_contract`]);
  if (opts.abandonRound) {
    if (orchestrator !== rec.contract.scope.orchestrator) {
      throw new ContractRefusal("freeze", contractId, [`only the contract's orchestrator (${rec.contract.scope.orchestrator}) can abandon a consent round`]);
    }
    await abandonRound(store, rec, orchestrator, warnings);
    rec = await contractRecord(store, contractId);
  }
  const reasons: string[] = [];
  let parent: ParentInfo | undefined;
  const parentRef = rec.contract.scope.parent;
  if (parentRef) {
    try {
      parent = await loadParent(parentRef.contract, { task: parentRef.task, exclude: contractId });
      if (!parent.record.frozen) reasons.push(`its parent ${parentRef.contract} is not frozen`);
      const task = parent.contract.tasks.find((t) => t.id === parentRef.task);
      const allowed = [task?.persona, parent.contract.scope.orchestrator].filter(Boolean);
      if (!allowed.includes(orchestrator)) reasons.push(`a child contract is frozen by its parent task's persona or the parent's orchestrator (${allowed.join(" or ")}), not ${orchestrator}`);
    } catch (e) {
      reasons.push(`its parent ${parentRef.contract} could not be loaded: ${errText(e)}`);
    }
  }
  const sourceSession = rec.contract.goal.source_session;
  if (sourceSession && isSessionBusy(sourceSession)) reasons.push(`its source session ${sourceSession} is busy: wait for its turn to finish`);
  reasons.push(...freezeBlockers(rec, excuse, orchestrator));
  const v = await validateContract(rec.contract, parentOpt(parent));
  if (!v.ok) reasons.push(...v.errors.map((e) => `invalid: ${e}`));
  if (reasons.length) throw new ContractRefusal("freeze", contractId, reasons);

  const excusals = excuse.map((x) => ({ agent: x.agent, reason: x.reason.trim() }));
  const verdicts: Record<string, VerdictState> = ownCopy(structuredClone(rec.verdicts));
  for (const x of excusals) {
    const prior = Object.hasOwn(verdicts, x.agent) ? verdicts[x.agent] : undefined;
    const resolved = { how: "excused" as const, reason: x.reason, seq: 0, version: rec.version };
    Object.defineProperty(verdicts, x.agent, {
      value: prior ? { ...prior, resolved } : { verdict: "EXCUSED", reason: x.reason, version: rec.version, seq: 0, resolved },
      writable: true, enumerable: true, configurable: true,
    });
  }
  // The hash covers what is stored: the scrubbed contract (a secret this process knows is redacted first).
  const body = storedBody(rec.contract, "frozen");
  const hash = contractHash(body);
  const final: Contract = {
    ...body, consent: effectiveConsent({ contract: body, verdicts, version: rec.version, hash: rec.hash }),
    frozen: { by: orchestrator, at: new Date().toISOString(), hash },
  };
  const blob = await store.putBlob(scrubbedJSON(final), { redact: false });
  const source = orchestratorSource(orchestrator);
  await store.transact(async ({ state }) => {
    const now = await contractRecord(store, contractId);
    if (now.frozen) throw new Error(`Contract ${contractId} was frozen meanwhile`);
    if (now.version !== rec.version) throw new Error(`Contract ${contractId} changed meanwhile (now v${now.version}); review it and freeze again`);
    const late = freezeBlockers(now, excusals, orchestrator);
    if (late.length) throw new ContractRefusal("freeze", contractId, late);
    const events: AnyEventDraft[] = excusals.map((x) => ({
      type: "contract.objection_resolved", source, mode: mode(state.status), contract: contractId, contract_version: rec.version,
      payload: { contract: contractId, agent: x.agent, how: "excused", reason: x.reason },
    }));
    events.push({
      type: "contract.frozen", source, mode: mode(state.status), contract: contractId, contract_version: rec.version,
      payload: { contract: contractId, version: rec.version, by: orchestrator, hash, blob },
    });
    return { events };
  });
  warnings.push(...v.warnings);
  for (const x of excusals) {
    await audit(warnings, { actor: orchestrator, action: "contract.objection_excused", target: contractId, details: { execution: store.id, version: rec.version, agent: x.agent, reason: x.reason } });
  }
  await audit(warnings, { actor: orchestrator, action: "contract.frozen", target: contractId, details: { execution: store.id, version: rec.version, hash } });
  return resultFor(store, contractId, { warnings, hash });
}

/** Freeze a consented contract. Only its orchestrator may; excusals are recorded and audited. */
export async function freezeContract(contractId: string, opts: FreezeOptions): Promise<ContractResult> {
  return freezeContractIn(await openContractStore(contractId), contractId, opts);
}

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

export interface AmendOptions {
  /** Who amends: the orchestrator (or a child's parent orchestrator), or the lead when `authority` is given. */
  by: string;
  reason?: string;
  /**
   * The lead fallback: `by` must be authority.lead, these actions must be within authority.may,
   * and any change they do not cover is refused (see authorityNeeds). Omit for the orchestrator.
   */
  authority?: AuthorityAction[];
  /** Default: the execution's own contract. */
  contractId?: string;
  /** An archived session (a replan or ultraplan) whose roundtable-tasks block replaces the structure. */
  fromSession?: string;
  /** Ask participants (an object picks the provider): everyone for a draft or a run-wide change, the affected ones otherwise. */
  consent?: boolean | ConsentLLMOptions;
  /** Orchestrator only: apply a run-wide change to a frozen contract without everyone's consent (audited). */
  overrideConsent?: boolean;
  /** Event source; default the orchestrator, or an agent named `by` with authority. */
  source?: EventSource;
}

const PROTECTED_TOP = ["schema", "id", "version", "status", "consent", "frozen"];
const PROTECTED_SCOPE = ["orchestrator", "repo_root", "base_ref", "parent"];
/** Changes to these touch every participant: on a frozen contract they need everyone's consent first. */
export const RUN_WIDE_FIELDS = ["budget", "scope", "sandbox", "authority", "validation", "workers", "goal", "dissents"] as const;

function protectedProblems(patch: Obj): string[] {
  const out = PROTECTED_TOP.filter((k) => Object.hasOwn(patch, k)).map((k) => `patch may not change ${k}`);
  if (isObj(patch.scope)) {
    for (const k of PROTECTED_SCOPE) {
      if (Object.hasOwn(patch.scope, k)) out.push(`patch may not change scope.${k}`);
    }
  } else if (Object.hasOwn(patch, "scope")) {
    out.push("patch may not replace scope");
  }
  if (isObj(patch.goal)) {
    if (Object.hasOwn(patch.goal, "original_prompt")) out.push("patch may not change goal.original_prompt: it is the human's request, verbatim");
  } else if (Object.hasOwn(patch, "goal")) {
    out.push("patch may not replace goal");
  }
  return out;
}

function withoutMeta(c: Contract): Obj {
  const { version: _v, status: _s, consent: _c, frozen: _f, ...rest } = c;
  // Historical blobs predate this optional field: its empty default is not an amendment.
  return { ...rest, dissents: c.dissents ?? [] };
}

const BUDGET_KEYS = ["usd", "per_task_usd", "per_agent_usd", "wall_clock_min"] as const;

/**
 * What an amendment needs beyond `may`, default-deny over every field (empty when the lead may make
 * it). Allowed: new tasks with add_task; persona or team changes with reassign (and adding their
 * personas as participants); interface changes with amend_interfaces; budget and time increases
 * with extend_budget, up to authority.budget_extension_pct above the budget first frozen. Everything
 * else, decreases included, is reserved to the orchestrator.
 */
export function authorityNeeds(o: Contract, n: Contract, may: readonly AuthorityAction[], original: ContractBudget = o.budget): string[] {
  const needs: string[] = [];
  const need = (action: AuthorityAction, what: string) => {
    if (!may.includes(action)) needs.push(`${what} needs "${action}"`);
  };
  const reserved = (what: string) => needs.push(`${what} is reserved to the orchestrator`);
  const before = withoutMeta(o);
  const after = withoutMeta(n);
  const a = affectedTasks(o, n);
  const bringable = new Set<string>(); // personas an added or reassigned task may bring in as participants
  // Tasks first: they decide which new participants are allowed.
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((x, y) => Number(y === "tasks") - Number(x === "tasks"));
  for (const key of keys) {
    if (same(before[key], after[key])) continue;
    switch (key) {
      case "tasks": {
        if (a.added.length) {
          need("add_task", `adding ${a.added.join(", ")}`);
          for (const id of a.added) bringable.add(n.tasks.find((t) => t.id === id)!.persona);
        }
        if (a.removed.length) reserved(`removing ${a.removed.join(", ")}`);
        for (const id of a.changed) {
          const { persona: p1, team: _t1, ...rest1 } = o.tasks.find((t) => t.id === id)!;
          const { persona: p2, team: _t2, ...rest2 } = n.tasks.find((t) => t.id === id)!;
          if (!same(rest1, rest2)) reserved(`changing the spec of ${id}`);
          else {
            need("reassign", `reassigning ${id}`);
            if (p1 !== p2) bringable.add(p2);
          }
        }
        if (!a.added.length && !a.removed.length && !a.changed.length) reserved("reordering tasks");
        break;
      }
      case "interfaces":
        need("amend_interfaces", "changing interfaces");
        break;
      case "budget": {
        const pct = o.authority.budget_extension_pct;
        for (const k of BUDGET_KEYS) {
          const was = o.budget[k];
          const now = n.budget[k];
          if (now === was) continue;
          if (now === undefined) reserved(`removing budget.${k}`);
          else if (was === undefined) reserved(`adding budget.${k}`);
          else if (now < was) reserved(`lowering budget.${k} to ${now}`);
          else {
            need("extend_budget", `raising budget.${k} to ${now}`);
            const limit = (original[k] ?? was) * (1 + pct / 100);
            if (now > limit + 1e-9) needs.push(`budget.${k} ${now} is beyond the ${pct}% extension limit (${Math.round(limit * 100) / 100})`);
          }
        }
        for (const k of ["max_parallel", "max_attempts"] as const) if (o.budget[k] !== n.budget[k]) reserved(`changing budget.${k}`);
        break;
      }
      case "participants": {
        const old = new Map(o.participants.map((p) => [p.agent, p]));
        const removed = o.participants.filter((p) => !n.participants.some((x) => x.agent === p.agent));
        const changed = n.participants.filter((p) => old.has(p.agent) && !same(old.get(p.agent), p));
        const added = n.participants.filter((p) => !old.has(p.agent));
        if (removed.length || changed.length) reserved("removing or changing participants");
        for (const p of added) {
          if (!bringable.has(p.agent)) reserved(`adding participant ${p.agent}, who is not the persona of an added or reassigned task`);
          else if (!may.includes("add_task") && !may.includes("reassign")) needs.push(`adding participant ${p.agent} needs "add_task" or "reassign"`);
        }
        if (!removed.length && !changed.length && !added.length) reserved("reordering participants");
        break;
      }
      default:
        reserved(`changing ${key}`);
    }
  }
  return needs;
}

/** Participants without an agreement on the record's current version. */
function notAgreed(rec: ContractRecord, participants = rec.contract.participants.map((p) => p.agent)): string[] {
  return participants.filter((a) => !["agree", "excused"].includes(standing(rec, a).kind));
}

/** The structure in a session's roundtable-tasks block, as a merge patch over the contract. */
function sessionPatch(id: string): { patch: Obj; warn?: string } {
  const src = sessionSource(archived(id));
  const block = locateBlock(src.blockTexts);
  if (!block) throw new Error(`from_session ${id} has no ${TASK_BLOCK_TAG} block in ${src.kind === "ultraplan" ? "any plan version" : "its summary or turns"} to amend the contract from`);
  const parsed = blockToContract(block.value);
  if (parsed.errors.length) throw new Error(`The ${TASK_BLOCK_TAG} block in ${block.from} is not usable:\n- ${listErrors(parsed.errors)}`);
  const patch = parsed.contract;
  // Commands without a final list: the final validation defaults again to every command.
  if (isObj(patch.validation) && patch.validation.final === undefined) patch.validation = { ...patch.validation, final: null };
  return { patch, ...(block.warn && { warn: block.warn }) };
}

/**
 * Amend a contract with an RFC 7396 merge patch (and/or a session's roundtable-tasks block).
 *
 * - A draft gets v(N+1) as a new proposal; every participant must consent to it again before a freeze.
 * - A frozen contract gets contract.amended v(N+1), with removed tasks cancelled and a directive to
 *   the agents of affected tasks. A run-wide change (RUN_WIDE_FIELDS) by the orchestrator needs
 *   consent (asked about the candidate first, applied only if everyone agrees) or overrideConsent.
 * - With `authority` (the lead): `by` must be authority.lead, `authority` within authority.may, and
 *   the change within authorityNeeds; such a change was consented to as part of the authority.
 * - An empty patch with consent only asks the participants without an agreement on this version.
 */
export async function amendContract(store: ExecutionStore, patch: Record<string, unknown>, opts: AmendOptions): Promise<ContractResult> {
  const by = typeof opts.by === "string" ? opts.by.trim() : "";
  if (!by) throw new Error("amendContract: by is required");
  if (!isObj(patch)) throw new Error("patch must be a JSON object (an RFC 7396 merge patch)");
  const rec = await contractRecord(store, opts.contractId);
  const contractId = rec.id;
  const c = rec.contract;
  if (rec.superseded) throw new ContractRefusal("amend", contractId, [`it was superseded by ${rec.superseded}`]);
  let parent: ParentInfo | undefined;
  if (c.scope.parent) parent = await loadParent(c.scope.parent.contract, { task: c.scope.parent.task, exclude: contractId });
  if (opts.authority) {
    const problems: string[] = [];
    if (by !== c.authority.lead) problems.push(`only the lead (${c.authority.lead}) amends within the authority; ${by} cannot`);
    const beyond = opts.authority.filter((x) => !c.authority.may.includes(x));
    if (beyond.length) problems.push(`the contract's authority.may (${c.authority.may.join(", ") || "none"}) does not grant ${beyond.join(", ")}`);
    if (opts.overrideConsent) problems.push("only the orchestrator can override consent");
    if (problems.length) throw new ContractRefusal("amend", contractId, problems);
  } else {
    const allowed = [c.scope.orchestrator, ...(parent ? [parent.contract.scope.orchestrator] : [])];
    if (!allowed.includes(by)) {
      throw new ContractRefusal("amend", contractId, [`only the contract's orchestrator (${allowed.join(" or ")}) can amend it without an authority limit; ${by} cannot`]);
    }
  }
  const problems = protectedProblems(patch);
  if (problems.length) throw new ContractRefusal("amend", contractId, problems);
  const reason = opts.reason?.trim() || `amended by ${by}`;
  const llm = typeof opts.consent === "object" ? opts.consent : undefined;
  const wantConsent = opts.consent === true || typeof opts.consent === "object";
  const warnings: string[] = [];

  const fromSession = opts.fromSession ? sessionPatch(opts.fromSession) : undefined;
  if (fromSession?.warn) warnings.push(fromSession.warn);
  const merged = applyMergePatch<Obj>(fromSession ? applyMergePatch(c, fromSession.patch) : c, patch);
  const version = rec.version + 1;
  const candidate: Obj = { ...merged, version, status: rec.frozen ? "frozen" : "draft", consent: [] };
  delete candidate.frozen;
  const v = await validateContract(candidate, parentOpt(parent));
  if (!v.ok) throw new Error(`The amended contract is not valid:\n- ${listErrors(v.errors)}`);
  warnings.push(...v.warnings);
  const effective = createMergePatch(withoutMeta(c), withoutMeta(v.contract)) as Obj;

  if (Object.keys(effective).length === 0) {
    if (!wantConsent) throw new Error(`The patch changes nothing in ${contractId} v${rec.version}`);
    const asked = notAgreed(rec);
    if (asked.length) {
      const round = await requestConsent(store, contractId, { by, participants: asked, llm });
      if (round.dropped) warnings.push(round.dropped);
    } else warnings.push(`every participant has already agreed to v${rec.version}: nobody was asked`);
    return resultFor(store, contractId, { warnings, asked });
  }
  const affected = affectedTasks(c, v.contract);
  if (opts.authority) {
    const original = rec.frozen ? (JSON.parse((await store.getBlob(rec.frozen.blob)).toString("utf8")) as Contract).budget : c.budget;
    const needs = authorityNeeds(c, v.contract, opts.authority, original);
    if (needs.length) throw new AuthorityError(contractId, needs);
    // A participant the lead brings in must be a real persona, even where the agents directory is unavailable.
    for (const p of v.contract.participants.filter((x) => !c.participants.some((y) => y.agent === x.agent))) {
      try {
        await loadAgent(p.agent);
      } catch (e) {
        throw new AuthorityError(contractId, [`the new participant ${p.agent} does not resolve: ${errText(e).split("\n")[0]}`]);
      }
    }
  }
  const runWide = RUN_WIDE_FIELDS.filter((k) => Object.hasOwn(effective, k));
  const source = opts.source ?? (opts.authority ? { kind: "agent" as const, id: by, pid: process.pid } : orchestratorSource(by));
  const patchBlob = await store.putBlob(scrubbedJSON(effective), { redact: false });
  let hash: string | undefined;
  let asked: string[] | undefined;
  if (rec.frozen) {
    const body = storedBody(v.contract, "frozen");
    hash = contractHash(body);
    const final: Contract = { ...body, consent: effectiveConsent(rec), frozen: { by, at: new Date().toISOString(), hash } };
    // A run-wide change by the orchestrator: everyone is asked about the candidate first, unless overridden.
    if (runWide.length && !opts.authority) {
      if (opts.overrideConsent) {
        await audit(warnings, {
          actor: by, action: "contract.consent_overridden", target: contractId,
          details: { execution: store.id, version, fields: runWide, reason },
        });
        warnings.push(`consent overridden for the change to ${runWide.join(", ")} (audited)`);
      } else if (wantConsent) {
        const round = await requestConsent(store, contractId, { by, llm, candidate: final });
        asked = round.asked;
        if (round.dropped) throw new ContractRefusal("amend", contractId, [round.dropped]);
        const against = round.answers.filter((x) => x.verdict !== "AGREE");
        if (against.length) {
          throw new ContractRefusal("amend", contractId, against.map((x) => `${x.agent} ${x.verdict === "OBJECT" ? "objects" : "is unclear"} to v${version}${x.reason ? `: ${x.reason.split(/\r?\n/)[0].slice(0, 200)}` : ""}`)
            .concat(`the change to ${runWide.join(", ")} was not applied`));
        }
      } else {
        throw new ContractRefusal("amend", contractId, [
          `changing ${runWide.join(", ")} of a frozen contract touches every participant: pass consent: true (everyone is asked first, and it applies only if all agree) or override_consent: true (audited)`,
        ]);
      }
    }
    const blob = await store.putBlob(scrubbedJSON(final), { redact: false });
    await store.transact(async ({ state }) => {
      const now = await contractRecord(store, contractId);
      if (now.version !== rec.version) throw new Error(`Contract ${contractId} changed meanwhile (now v${now.version}); amend the latest version`);
      const m = mode(state.status);
      const events: AnyEventDraft[] = [{
        type: "contract.amended", source, mode: m, contract: contractId, contract_version: version,
        payload: { contract: contractId, version, patch_blob: patchBlob, reason, affected_tasks: affected.all, blob },
      }];
      const removedDissents = (c.dissents ?? []).filter((d) => !final.dissents.some((next) => next.id === d.id));
      const withdrawing = Object.values(state.escalations).filter((e) =>
        removedDissents.some((d) => d.id === e.dissent_id) && e.status !== "resolved" && e.status !== "withdrawn").map((e) => e.id);
      for (const dissent of removedDissents) {
        for (const e of Object.values(state.escalations)) {
          if (e.dissent_id !== dissent.id || e.status === "resolved" || e.status === "withdrawn") continue;
          events.push({ type: "escalation.withdrawn", source, payload: { id: e.id, reason: `Dissent ${dissent.id} removed by amendment v${version}` } });
          const rt = e.task && Object.hasOwn(state.tasks, e.task) ? state.tasks[e.task] : undefined;
          if (e.task && e.blocking && rt && !["accepted", "failed", "cancelled"].includes(rt.state)) {
            events.push({ type: "task.unblocked", source, payload: { task: e.task, escalation: e.id } });
          }
          const paused = await pausedBy(store, state, e.id, withdrawing);
          if (paused.length) events.push({ type: "execution.resumed", source, correlation: e.id,
            payload: { scope: paused, reason: `Dissent ${dissent.id} removed by amendment v${version}` } });
        }
      }
      for (const task of affected.removed) {
        const rt = Object.hasOwn(state.tasks, task) ? state.tasks[task] : undefined;
        if (!rt || rt.state === "accepted" || rt.state === "cancelled") continue;
        events.push({ type: "task.cancelled", source, mode: m, contract: contractId, contract_version: version, payload: { task, why: `removed by amendment v${version}: ${reason}` } });
      }
      const to = [...new Set(affected.all.map((t) => (Object.hasOwn(state.tasks, t) ? state.tasks[t].agent : undefined)).filter((a): a is string => !!a))];
      if (to.length) {
        events.push({
          type: "directive.issued", source, mode: m, contract: contractId, contract_version: version,
          payload: {
            id: newId("dir"), to, requires_ack: true,
            text: `Contract amended to v${version}: re-read the contract before you continue (${reason}). Affected tasks: ${affected.all.join(", ")}. Their checks run again on your next submission.`,
          },
        });
      }
      return { events };
    });
    await audit(warnings, {
      actor: by, action: "contract.amended", target: contractId,
      details: { execution: store.id, version, hash, affected_tasks: affected.all, removed_dissents: (c.dissents ?? []).filter((d) => !final.dissents.some((next) => next.id === d.id)).map((d) => d.id), ...(runWide.length && { run_wide: runWide }), ...(opts.authority && { within_authority: opts.authority }) },
    });
    // A task-level change: the personas of the affected tasks are asked afterwards, when wanted.
    if (wantConsent && asked === undefined) {
      const personas = new Set<string>();
      for (const x of [c, v.contract]) for (const t of x.tasks) if (affected.all.includes(t.id)) personas.add(t.persona);
      asked = v.contract.participants.map((p) => p.agent).filter((a) => personas.has(a));
      if (asked.length) await consentAfter(store, contractId, by, asked, llm, warnings);
    }
  } else {
    const blob = await store.putBlob(scrubbedJSON(v.contract), { redact: false });
    await store.transact(async () => {
      const now = await contractRecord(store, contractId);
      if (now.frozen) throw new Error(`Contract ${contractId} was frozen meanwhile; amend the frozen version`);
      if (now.version !== rec.version) throw new Error(`Contract ${contractId} changed meanwhile (now v${now.version}); amend the latest version`);
      if (now.round?.inFlight) throw new Error(`A consent round for ${contractId} is in flight; amend after it finishes`);
      return {
        events: [{
          type: "contract.proposed", source, mode: "deliberation", contract: contractId, contract_version: version,
          payload: { contract: contractId, version, source: "amendment", blob, reason, patch_blob: patchBlob },
        }],
      };
    });
    // Every participant consented to the old draft, not this one: everyone is asked again.
    if (wantConsent) {
      asked = v.contract.participants.map((p) => p.agent);
      await consentAfter(store, contractId, by, asked, llm, warnings);
    }
  }
  return resultFor(store, contractId, { warnings, affected, ...(hash && { hash }), ...(asked && { asked }) });
}

async function consentAfter(store: ExecutionStore, contractId: string, by: string, participants: string[], llm: ConsentLLMOptions | undefined, warnings: string[]): Promise<void> {
  try {
    const round = await requestConsent(store, contractId, { by, participants, llm });
    if (round.dropped) warnings.push(round.dropped);
  } catch (e) {
    warnings.push(`the consent round failed: ${errText(e)}`);
  }
}

/** One summary line for a result (consent outcome included). */
export function describeResult(r: ContractResult): string {
  return `${r.contractId} v${r.version} (${r.status}) · ${describeConsent(r.consent)}`;
}
