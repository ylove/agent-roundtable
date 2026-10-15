// ============================================================================
// Contract lifecycle: propose, freeze and amend (heads-down.md §8)
//
// Proposing creates the execution store (contract ids carry the execution's tag), writes v1 and
// CONTRACT.md, and records execution.created + contract.proposed. Freezing records the excusals
// and contract.frozen in one batch and audits the hash. Amending a draft proposes v(N+1)
// (contract.proposed with reason and patch_blob); amending a frozen contract records
// contract.amended plus task.cancelled for removed tasks and a directive to affected agents.
// Provider calls (structuring, consent) always run outside transact.
// ============================================================================

import { execFile } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AGENTS_DIR, WORKSPACE_DIR } from "../config.js";
import { newExecutionId, newId } from "../ids.js";
import { appendAudit } from "../security/audit.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { readArchivedSession, type ArchivedSession } from "../sessions/archive.js";
import { isSessionBusy } from "../sessions/lock.js";
import { scrubbedJSON } from "./blobs.js";
import { canonicalJSON } from "./chain.js";
import {
  affectedTasks,
  applyMergePatch,
  contractHash,
  contractIdFor,
  createMergePatch,
  validateContract,
  type AffectedTasks,
} from "./contract.js";
import { blockToContract, findTaskBlock, sessionSource, structureContract, TASK_BLOCK_TAG, type SessionSource } from "./contract-parse.js";
import {
  contractRecord,
  describeConsent,
  effectiveConsent,
  loadParent,
  openContractStore,
  orchestratorSource,
  presentContract,
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
  const objections = s.objections.map((o) => `${o.agent} (${o.verdict}${o.reason ? `: ${o.reason.split(/\r?\n/)[0].slice(0, 160)}` : ""})`).join("; ");
  if (rec.status === "frozen") {
    return s.objections.length
      ? `The contract is frozen at v${rec.version}, but ${objections}. Amend it again with amend_contract, or pause the run.`
      : `Frozen at v${rec.version}. Show the contract to the human: the heads-down run starts only when they ask for it (execute).`;
  }
  if (s.in_flight) return "A consent round is in flight: wait for it to finish, then freeze_contract.";
  if (s.ready) return `Every participant agreed. Show the contract to the human, then freeze it: freeze_contract { "contract_id": "${id}", "orchestrator": "${rec.contract.scope.orchestrator}" }.`;
  const parts: string[] = [];
  if (s.objections.length) {
    parts.push(`Objections: ${objections}. Address them with amend_contract { "contract_id": "${id}", "patch": {…}, "reason": "…", "consent": true } ` +
      "(it re-asks the objectors and the affected participants), or excuse them with a reason in freeze_contract { \"excuse\": [{ \"agent\", \"reason\" }] }.");
  }
  if (s.missing.length) {
    parts.push(`No consent yet from ${s.missing.join(", ")}: ask with amend_contract { "contract_id": "${id}", "patch": {}, "reason": "consent", "consent": true }.`);
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

/** The last roundtable-tasks block among the texts (the plan argument first), with where it came from. */
function locateBlock(texts: Array<{ from: string; text?: string }>): { from: string; value: unknown } | undefined {
  for (const { from, text } of texts) {
    let value: unknown;
    try {
      value = findTaskBlock(text);
    } catch (e) {
      throw new Error(`${from}: ${errText(e)}`);
    }
    if (value !== undefined) return { from, value };
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
  const src: SessionSource | undefined = session && sessionSource(session);
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
    parent = await loadParent(o.parentContract);
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
    return c;
  };
  const parentOpt = parent && { parent: { contract: parent.contract, depth: parent.depth } };

  let source: string;
  let structure: Obj;
  if (explicit && explicit.tasks !== undefined) {
    source = "explicit";
    structure = {};
  } else {
    const block = locateBlock([
      { from: "plan", text: o.plan },
      ...(src?.blockTexts ?? []).map((text) => ({ from: o.fromSession!, text })),
    ]);
    if (block) {
      const parsed = blockToContract(block.value);
      if (parsed.errors.length) throw new Error(`The ${TASK_BLOCK_TAG} block in ${block.from} is not usable:\n- ${listErrors(parsed.errors)}`);
      source = `fenced:${block.from}`;
      structure = parsed.contract;
    } else {
      const plan = o.plan?.trim() ? o.plan : src?.planText;
      if (!plan?.trim()) throw new Error("propose_contract needs a structure: pass contract (with tasks), a plan, or from_session");
      const draft = assemble({});
      const scopePaths = isObj(draft.scope) && Array.isArray(draft.scope.paths) ? draft.scope.paths.map(String) : parent?.contract.tasks.find((t) => t.id === o.parentTask)?.paths.write ?? ["**"];
      const structured = await structureContract({
        goal: o.goal.trim(), originalPrompt, plan,
        participants: o.participants ?? (Array.isArray(draft.participants) ? draft.participants.map(String) : src?.agents ?? []),
        scopePaths,
      }, resolveConsentLLM(o.llm), async (s) => (await validateContract(assemble(s), parentOpt)).errors);
      source = `structured:${o.plan?.trim() ? "plan" : o.fromSession}`;
      structure = structured.structure;
    }
  }
  const v = await validateContract(assemble(structure), parentOpt);
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
      asked = (await requestConsent(store, contractId, { by: orchestrator, llm: o.llm })).asked;
    } catch (e) {
      warnings.push(`the consent round failed: ${errText(e)}`);
    }
  }
  return resultFor(store, contractId, { warnings, source, ...(asked && { asked }) });
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

export interface FreezeOptions {
  /** The caller: must be the contract's scope.orchestrator. */
  orchestrator: string;
  /** Objections (or missing answers) to set aside, each with a reason; every excusal is audited. */
  excuse?: Array<{ agent: string; reason: string }>;
}

const unresolved = (v: VerdictState | undefined) => !v || ((v.verdict === "OBJECT" || v.verdict === "UNCLEAR") && !v.resolved);

/** Every reason a freeze would be refused right now, given the excusals. */
function freezeBlockers(rec: ContractRecord, excuse: Array<{ agent: string; reason: string }>, orchestrator: string): string[] {
  const reasons: string[] = [];
  if (orchestrator !== rec.contract.scope.orchestrator) {
    reasons.push(`only the contract's orchestrator (${rec.contract.scope.orchestrator}) can freeze it; ${orchestrator} cannot`);
  }
  if (rec.round?.inFlight) reasons.push(`a consent round is in flight (${rec.round.pending.length} answers pending)`);
  const participants = rec.contract.participants.map((p) => p.agent);
  const excused = new Map<string, string>();
  for (const [i, x] of excuse.entries()) {
    if (!isObj(x) || typeof x.agent !== "string" || !x.agent.trim()) reasons.push(`excuse[${i}].agent is required`);
    else if (typeof x.reason !== "string" || !x.reason.trim()) reasons.push(`excuse[${i}] (${x.agent}) needs a reason`);
    else if (!participants.includes(x.agent)) reasons.push(`excuse[${i}]: ${x.agent} is not a participant`);
    else if (!unresolved(rec.verdicts[x.agent])) reasons.push(`excuse[${i}]: ${x.agent} has no objection to excuse`);
    else excused.set(x.agent, x.reason.trim());
  }
  for (const agent of participants) {
    const v = Object.hasOwn(rec.verdicts, agent) ? rec.verdicts[agent] : undefined;
    if (!unresolved(v) || excused.has(agent)) continue;
    if (!v) reasons.push(`${agent} has not consented: run a consent round or excuse them`);
    else reasons.push(`${agent} ${v.verdict === "OBJECT" ? "objects" : "is unclear, which counts as an objection"}${v.reason ? `: ${v.reason.split(/\r?\n/)[0].slice(0, 200)}` : ""}`);
  }
  return reasons;
}

/** freezeContract on an open store. */
export async function freezeContractIn(store: ExecutionStore, contractId: string, opts: FreezeOptions): Promise<ContractResult> {
  const orchestrator = typeof opts.orchestrator === "string" ? opts.orchestrator.trim() : "";
  if (!orchestrator) throw new Error("orchestrator is required: only an orchestrator can freeze a contract");
  const excuse = opts.excuse ?? [];
  const rec = await contractRecord(store, contractId);
  if (rec.superseded) throw new ContractRefusal("freeze", contractId, [`it was superseded by ${rec.superseded}`]);
  if (rec.frozen) throw new ContractRefusal("freeze", contractId, [`it is already frozen (v${rec.frozen.version} by ${rec.frozen.by}); change it with amend_contract`]);
  const reasons: string[] = [];
  let parentOpt: { parent: { contract: Contract; depth: number } } | undefined;
  const parentRef = rec.contract.scope.parent;
  if (parentRef) {
    try {
      const parent = await loadParent(parentRef.contract);
      parentOpt = { parent: { contract: parent.contract, depth: parent.depth } };
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
  const v = await validateContract(rec.contract, parentOpt);
  if (!v.ok) reasons.push(...v.errors.map((e) => `invalid: ${e}`));
  if (reasons.length) throw new ContractRefusal("freeze", contractId, reasons);

  const excusals = excuse.map((x) => ({ agent: x.agent, reason: x.reason.trim() }));
  const verdicts: Record<string, VerdictState> = structuredClone(rec.verdicts);
  for (const x of excusals) {
    const prior = verdicts[x.agent];
    const resolved = { how: "excused" as const, reason: x.reason, seq: 0 };
    verdicts[x.agent] = prior ? { ...prior, resolved } : { verdict: "EXCUSED", reason: x.reason, version: rec.version, seq: 0, resolved };
  }
  const body: Contract = { ...rec.contract, status: "frozen", consent: [] };
  delete body.frozen;
  const hash = contractHash(body);
  const final: Contract = { ...body, consent: effectiveConsent({ contract: body, verdicts }), frozen: { by: orchestrator, at: new Date().toISOString(), hash } };
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
  const warnings = [...v.warnings];
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

async function audit(warnings: string[], entry: Parameters<typeof appendAudit>[0]): Promise<void> {
  try {
    await appendAudit(entry);
  } catch (e) {
    warnings.push(`the audit log entry ${entry.action} could not be written: ${errText(e)}`);
    console.error(`[Contracts] audit ${entry.action} failed: ${errText(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Amend
// ---------------------------------------------------------------------------

export interface AmendOptions {
  /** Who amends: the orchestrator, or the lead when `authority` is given. */
  by: string;
  reason?: string;
  /**
   * The lead fallback: refuse any change these actions do not cover (add_task for new tasks,
   * reassign for persona or team changes, amend_interfaces, extend_budget within
   * authority.budget_extension_pct of the budget first frozen). Omit for the orchestrator.
   */
  authority?: AuthorityAction[];
  /** Default: the execution's own contract. */
  contractId?: string;
  /** An archived session (a replan or ultraplan) whose roundtable-tasks block replaces the structure. */
  fromSession?: string;
  /** Re-ask the affected participants (and open objectors); an object picks the provider. */
  consent?: boolean | ConsentLLMOptions;
  /** Event source; default the orchestrator, or an agent named `by` with authority. */
  source?: EventSource;
}

const PROTECTED_TOP = ["schema", "id", "version", "status", "consent", "frozen"];
const PROTECTED_SCOPE = ["orchestrator", "repo_root", "base_ref", "parent"];

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
  return rest;
}

const BUDGET_KEYS = ["usd", "per_task_usd", "per_agent_usd", "wall_clock_min"] as const;

/** What an amendment needs beyond `may` (empty when it is within the lead's authority). */
export function authorityNeeds(o: Contract, n: Contract, may: readonly AuthorityAction[], original: ContractBudget = o.budget): string[] {
  const needs: string[] = [];
  const need = (action: AuthorityAction, what: string) => {
    if (!may.includes(action)) needs.push(`${what} needs "${action}"`);
  };
  const a = affectedTasks(o, n);
  if (a.added.length) need("add_task", `adding ${a.added.join(", ")}`);
  if (a.removed.length) needs.push(`removing ${a.removed.join(", ")} is reserved to the orchestrator`);
  for (const id of a.changed) {
    const { persona: _p1, team: _t1, ...before } = o.tasks.find((t) => t.id === id)!;
    const { persona: _p2, team: _t2, ...after } = n.tasks.find((t) => t.id === id)!;
    if (same(before, after)) need("reassign", `reassigning ${id}`);
    else needs.push(`changing the spec of ${id} is reserved to the orchestrator`);
  }
  if (!same(o.interfaces, n.interfaces)) need("amend_interfaces", "changing interfaces");
  const pct = o.authority.budget_extension_pct;
  for (const key of BUDGET_KEYS) {
    const was = o.budget[key];
    const now = n.budget[key];
    if (now === was || (now !== undefined && was !== undefined && now < was) || (was === undefined && now !== undefined)) continue;
    if (now === undefined) {
      needs.push(`removing budget.${key} is reserved to the orchestrator`);
      continue;
    }
    need("extend_budget", `raising budget.${key} to ${now}`);
    const base = original[key] ?? was!;
    const limit = base * (1 + pct / 100);
    if (now > limit + 1e-9) needs.push(`budget.${key} ${now} is beyond the ${pct}% extension limit (${Math.round(limit * 100) / 100})`);
  }
  for (const key of ["max_parallel", "max_attempts"] as const) {
    if (o.budget[key] !== n.budget[key]) needs.push(`changing budget.${key} is reserved to the orchestrator`);
  }
  const rest = (c: Contract) => {
    const { tasks: _t, interfaces: _i, budget: _b, ...r } = withoutMeta(c) as unknown as Contract;
    return r;
  };
  const before = rest(o) as unknown as Obj;
  const after = rest(n) as unknown as Obj;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[key], after[key])) needs.push(`changing ${key} is reserved to the orchestrator`);
  }
  return needs;
}

/** Who re-consents: personas of affected tasks (old and new), participants never asked, open objectors. */
function participantsToAsk(rec: ContractRecord, next: Contract, affected: string[]): string[] {
  const touched = new Set<string>();
  for (const c of [rec.contract, next]) for (const t of c.tasks) if (affected.includes(t.id)) touched.add(t.persona);
  for (const { agent } of next.participants) {
    const v = Object.hasOwn(rec.verdicts, agent) ? rec.verdicts[agent] : undefined;
    if (unresolved(v)) touched.add(agent);
  }
  return next.participants.map((p) => p.agent).filter((a) => touched.has(a));
}

/** The structure in a session's roundtable-tasks block, as a merge patch over the contract. */
function sessionPatch(id: string): Obj {
  const src = sessionSource(archived(id));
  const block = locateBlock(src.blockTexts.map((text) => ({ from: id, text })));
  if (!block) throw new Error(`from_session ${id} has no ${TASK_BLOCK_TAG} block to amend the contract from`);
  const parsed = blockToContract(block.value);
  if (parsed.errors.length) throw new Error(`The ${TASK_BLOCK_TAG} block in ${id} is not usable:\n- ${listErrors(parsed.errors)}`);
  const patch = parsed.contract;
  // Commands without a final list: the final validation defaults again to every command.
  if (isObj(patch.validation) && patch.validation.final === undefined) patch.validation = { ...patch.validation, final: null };
  return patch;
}

/**
 * Amend a contract with an RFC 7396 merge patch (and/or a session's roundtable-tasks block). A
 * draft gets v(N+1) as a new proposal; a frozen contract gets contract.amended v(N+1), with removed
 * tasks cancelled and a directive to the agents of affected tasks. An empty patch with consent only
 * re-asks the participants without an agreement.
 */
export async function amendContract(store: ExecutionStore, patch: Record<string, unknown>, opts: AmendOptions): Promise<ContractResult> {
  const by = typeof opts.by === "string" ? opts.by.trim() : "";
  if (!by) throw new Error("amendContract: by is required");
  if (!isObj(patch)) throw new Error("patch must be a JSON object (an RFC 7396 merge patch)");
  const rec = await contractRecord(store, opts.contractId);
  const contractId = rec.id;
  if (rec.superseded) throw new ContractRefusal("amend", contractId, [`it was superseded by ${rec.superseded}`]);
  if (!opts.authority && by !== rec.contract.scope.orchestrator) {
    throw new ContractRefusal("amend", contractId, [`only the contract's orchestrator (${rec.contract.scope.orchestrator}) can amend it without an authority limit; ${by} cannot`]);
  }
  const problems = protectedProblems(patch);
  if (problems.length) throw new ContractRefusal("amend", contractId, problems);
  const reason = opts.reason?.trim() || `amended by ${by}`;
  const llm = typeof opts.consent === "object" ? opts.consent : undefined;
  const wantConsent = opts.consent === true || typeof opts.consent === "object";

  let parentOpt: { parent: { contract: Contract; depth: number } } | undefined;
  if (rec.contract.scope.parent) {
    const parent = await loadParent(rec.contract.scope.parent.contract);
    parentOpt = { parent: { contract: parent.contract, depth: parent.depth } };
  }
  const fromSession = opts.fromSession ? sessionPatch(opts.fromSession) : undefined;
  const merged = applyMergePatch<Obj>(fromSession ? applyMergePatch(rec.contract, fromSession) : rec.contract, patch);
  const version = rec.version + 1;
  const candidate: Obj = { ...merged, version, status: rec.frozen ? "frozen" : "draft", consent: [] };
  delete candidate.frozen;
  const v = await validateContract(candidate, parentOpt);
  if (!v.ok) throw new Error(`The amended contract is not valid:\n- ${listErrors(v.errors)}`);
  const warnings = [...v.warnings];
  const effective = createMergePatch(withoutMeta(rec.contract), withoutMeta(v.contract)) as Obj;

  if (Object.keys(effective).length === 0) {
    if (!wantConsent) throw new Error(`The patch changes nothing in ${contractId} v${rec.version}`);
    const asked = participantsToAsk(rec, rec.contract, []);
    if (asked.length) await requestConsent(store, contractId, { by, participants: asked, llm });
    else warnings.push("every participant has already agreed: nobody was asked");
    return resultFor(store, contractId, { warnings, asked });
  }
  const affected = affectedTasks(rec.contract, v.contract);
  if (opts.authority) {
    const original = rec.frozen ? (JSON.parse((await store.getBlob(rec.frozen.blob)).toString("utf8")) as Contract).budget : rec.contract.budget;
    const needs = authorityNeeds(rec.contract, v.contract, opts.authority, original);
    if (needs.length) throw new AuthorityError(contractId, needs);
  }
  const source = opts.source ?? (opts.authority ? { kind: "agent" as const, id: by, pid: process.pid } : orchestratorSource(by));
  const patchBlob = await store.putBlob(scrubbedJSON(effective), { redact: false });
  let hash: string | undefined;
  if (rec.frozen) {
    const body: Contract = { ...v.contract, status: "frozen", consent: [] };
    hash = contractHash(body);
    const final: Contract = { ...body, consent: effectiveConsent({ contract: body, verdicts: rec.verdicts }), frozen: { by, at: new Date().toISOString(), hash } };
    const blob = await store.putBlob(scrubbedJSON(final), { redact: false });
    await store.transact(async ({ state }) => {
      const now = await contractRecord(store, contractId);
      if (now.version !== rec.version) throw new Error(`Contract ${contractId} changed meanwhile (now v${now.version}); amend the latest version`);
      const m = mode(state.status);
      const events: AnyEventDraft[] = [{
        type: "contract.amended", source, mode: m, contract: contractId, contract_version: version,
        payload: { contract: contractId, version, patch_blob: patchBlob, reason, affected_tasks: affected.all, blob },
      }];
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
            text: `Contract amended to v${version}: re-read the contract before you continue (${reason}). Affected tasks: ${affected.all.join(", ")}.`,
          },
        });
      }
      return { events };
    });
    await audit(warnings, {
      actor: by, action: "contract.amended", target: contractId,
      details: { execution: store.id, version, hash, affected_tasks: affected.all, ...(opts.authority && { within_authority: opts.authority }) },
    });
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
  }
  let asked: string[] | undefined;
  if (wantConsent) {
    asked = participantsToAsk(rec, v.contract, affected.all);
    if (asked.length) {
      try {
        await requestConsent(store, contractId, { by, participants: asked, llm });
      } catch (e) {
        warnings.push(`the consent round failed: ${errText(e)}`);
      }
    }
  }
  return resultFor(store, contractId, { warnings, affected, ...(hash && { hash }), ...(asked && { asked }) });
}

/** One summary line for a result (consent outcome included). */
export function describeResult(r: ContractResult): string {
  return `${r.contractId} v${r.version} (${r.status}) · ${describeConsent(r.consent)}`;
}
