// ============================================================================
// The running draft: findings recorded while testing sends fixers back (§4)
//
// A scope is one heads-down execution or one piece of at-the-table work, always within one project.
// An execution's findings live in its event log (so a crash loses none and the blackboard and the
// dashboard see them); an at-the-table scope keeps them in drafts/<pm>.json. Evidence is refs only.
// ============================================================================

import { realpathSync } from "node:fs";
import { agentKey } from "../agents.js";
import { ID_RE } from "../execution/events.js";
import { EXECUTION_ID_RE, newId } from "../ids.js";
import { orchestratorSource } from "../execution/contract-state.js";
import { postmortemBlockers, draftFindings } from "../execution/postmortem-state.js";
import { openExecutionStore, type FileExecutionStore } from "../execution/store.js";
import type { PostmortemCategory, PostmortemFinding, PostmortemFindingState, PostmortemFixStatus } from "../execution/types.js";
import { normalizeRelPath } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import type { ProjectRef } from "./project.js";
import { findDraft, saveDraft, withProjectLock } from "./store.js";
import { CATEGORIES, LIMITS, type DraftFile, type PostmortemScope } from "./types.js";

const clean = (s: unknown): string => scrub(String(s ?? "")).replace(/\s+/g, " ").trim();

/** The scope a call names: exactly one of execution_id and work. */
export function scopeOf(a: { execution_id?: unknown; work?: unknown }): PostmortemScope {
  const hasExe = typeof a.execution_id === "string" && a.execution_id !== "";
  const hasWork = typeof a.work === "string" && a.work.trim() !== "";
  if (hasExe === hasWork) throw new Error("pass exactly one of execution_id (a heads-down run) and work (a short label for at-the-table work, such as \"checkout redesign\")");
  if (hasExe) {
    if (!EXECUTION_ID_RE.test(a.execution_id as string)) throw new Error(`execution_id is not a heads-down run id (exe-…): ${JSON.stringify(String(a.execution_id).slice(0, 40))}`);
    return { execution_id: a.execution_id as string };
  }
  const work = clean(a.work);
  if (work.length > LIMITS.work) throw new Error(`work is longer than ${LIMITS.work} characters: use a short label`);
  return { work };
}

export const scopeLabel = (s: PostmortemScope): string => (s.execution_id !== undefined ? `run ${s.execution_id}` : `work "${s.work}"`);

/** Refs only: a blob ref, an event id, a commit sha or a repository path. Never command output. */
export function isEvidenceRef(ref: string): boolean {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > LIMITS.evidenceRef) return false;
  if (/^sha256:[0-9a-f]{64}$/.test(ref) || /^evt-[0-9a-z]{8}$/.test(ref) || /^[0-9a-f]{7,64}$/.test(ref)) return true;
  return !/\s/.test(ref) && normalizeRelPath(ref) !== null;
}

/** The execution of an execution-scoped call, checked to belong to the project. */
export async function executionOf(proj: ProjectRef, scope: PostmortemScope): Promise<FileExecutionStore> {
  const store = await openExecutionStore(scope.execution_id!);
  let root: string;
  try {
    root = realpathSync(store.header().repo_root);
  } catch {
    root = store.header().repo_root;
  }
  if (root !== proj.root) throw new Error(`${scope.execution_id} belongs to another repository (${root}), not to project ${proj.key}`);
  return store;
}

export interface FindingInput {
  summary: string;
  detected_by: string;
  responsible: string[];
  category: PostmortemCategory;
  task?: string;
  evidence?: string[];
}

/** A checked, scrubbed finding (no id, time or fix yet). */
export function checkFinding(input: FindingInput): Required<Pick<FindingInput, "summary" | "detected_by" | "responsible" | "category">> & Pick<FindingInput, "task" | "evidence"> {
  const summary = clean(input.summary);
  if (!summary) throw new Error("finding.summary is required: what went wrong");
  if (summary.length > LIMITS.summary) throw new Error(`finding.summary is longer than ${LIMITS.summary} characters`);
  const detected_by = clean(input.detected_by);
  if (!detected_by) throw new Error("finding.detected_by is required: the check, test or reviewer that caught it");
  if (detected_by.length > LIMITS.detectedBy) throw new Error(`finding.detected_by is longer than ${LIMITS.detectedBy} characters`);
  if (!CATEGORIES.includes(input.category)) throw new Error(`finding.category must be one of: ${CATEGORIES.join(", ")}`);
  if (input.task !== undefined && !ID_RE.test(input.task)) throw new Error("finding.task must be a task id (lowercase letters, digits, '.', '_' or '-'; at most 64)");
  const names = (input.responsible ?? []).map((r) => clean(r)).filter(Boolean);
  if (!names.length) throw new Error("finding.responsible needs at least one agent (a persona name, or \"orchestrator\")");
  if (names.length > LIMITS.responsible || names.some((n) => n.length > LIMITS.responsibleName)) throw new Error("finding.responsible has too many or too long names");
  const responsible = [...new Set(names.map((n) => (n.toLowerCase() === "orchestrator" ? "orchestrator" : agentKey(n))))];
  const evidence = (input.evidence ?? []).map((e) => String(e).trim());
  if (evidence.length > LIMITS.evidence) throw new Error(`finding.evidence has more than ${LIMITS.evidence} refs`);
  for (const e of evidence) {
    if (!isEvidenceRef(e)) throw new Error(`finding.evidence takes refs only (a sha256: blob ref, an event id, a commit sha or a repository path), not ${JSON.stringify(e.slice(0, 60))}: the server never copies command output into a finding`);
  }
  return { summary, detected_by, responsible, category: input.category, ...(input.task !== undefined && { task: input.task }), ...(evidence.length && { evidence }) };
}

/** The open draft of a scope (created on first use). */
async function draftFor(proj: ProjectRef, scope: PostmortemScope): Promise<DraftFile> {
  const found = findDraft(proj.key, scope);
  if (found) return found;
  const d: DraftFile = { v: 1, pm: newId("pm"), project: proj.key, scope, created: new Date().toISOString(), findings: [] };
  saveDraft(d);
  return d;
}

export interface DraftView {
  pm: string;
  project: string;
  scope: PostmortemScope;
  findings: PostmortemFinding[];
  /** Findings whose fix is still pending, and tasks with a finding that are not terminal yet. */
  pending: string[];
  in_flight: string[];
  ready: boolean;
}

function viewOf(d: DraftFile, findings: PostmortemFinding[], blockers: { pending: string[]; tasks: string[] }): DraftView {
  return {
    pm: d.pm, project: d.project, scope: d.scope, findings,
    pending: blockers.pending, in_flight: blockers.tasks,
    ready: findings.length > 0 && blockers.pending.length === 0 && blockers.tasks.length === 0,
  };
}

/** The draft of a scope as it stands now (an execution's rebuilt from its events). */
export async function readDraft(proj: ProjectRef, scope: PostmortemScope, create = false): Promise<DraftView | undefined> {
  const existing = findDraft(proj.key, scope);
  if (!existing && !create) {
    if (scope.execution_id === undefined) return undefined;
    // An execution's findings are in its log even before anyone asked for the draft.
    const store = await executionOf(proj, scope);
    if (!draftFindings(await store.state()).length) return undefined;
  }
  const d = existing ?? (await withProjectLock(proj.key, () => draftFor(proj, scope)));
  if (scope.execution_id !== undefined) {
    const state = await (await executionOf(proj, scope)).state();
    return viewOf(d, draftFindings(state).map(toFinding), postmortemBlockers(state));
  }
  const pending = d.findings.filter((f) => f.fix?.status === "pending").map((f) => f.id);
  return viewOf(d, d.findings, { pending, tasks: [] });
}

function toFinding(f: PostmortemFindingState): PostmortemFinding {
  const { pm: _pm, ...rest } = f;
  return rest;
}

/** Record one finding in the draft of a scope. Returns its id and the draft's state. */
export async function recordFinding(proj: ProjectRef, scope: PostmortemScope, input: FindingInput): Promise<{ id: string; draft: DraftView }> {
  const f = checkFinding(input);
  const id = newId("pmf");
  if (scope.execution_id !== undefined) {
    const store = await executionOf(proj, scope);
    await store.transact(({ state }) => {
      if (f.task !== undefined && !Object.hasOwn(state.tasks, f.task)) throw new Error(`task ${JSON.stringify(f.task)} is not a task of ${scope.execution_id}`);
      return {
        events: [{
          type: "postmortem.finding_recorded",
          source: orchestratorSource(state.contract?.scope.orchestrator ?? "orchestrator"),
          payload: { id, summary: f.summary, detected_by: f.detected_by, responsible: f.responsible, category: f.category, ...(f.task !== undefined && { task: f.task }), ...(f.evidence && { evidence: f.evidence }) },
        }],
      };
    });
  } else {
    await withProjectLock(proj.key, async () => {
      const d = await draftFor(proj, scope);
      d.findings.push({ id, at: new Date().toISOString(), ...f, ...(f.task !== undefined && { task: f.task }), fix: { status: "pending" } });
      saveDraft(d);
    });
  }
  return { id, draft: (await readDraft(proj, scope, true))! };
}

export interface FixInput {
  by?: string;
  status: PostmortemFixStatus;
  ref?: string;
}

/** Set a finding's fix status (and who fixes it). */
export async function updateFix(proj: ProjectRef, scope: PostmortemScope, findingId: string, fix: FixInput): Promise<DraftView> {
  if (!["pending", "fixed", "abandoned"].includes(fix.status)) throw new Error("fix.status must be pending, fixed or abandoned");
  const by = fix.by !== undefined ? clean(fix.by).slice(0, LIMITS.responsibleName) : undefined;
  if (fix.ref !== undefined && !isEvidenceRef(fix.ref)) throw new Error("fix.ref takes a ref only (a commit sha, an event id, a blob ref or a repository path)");
  if (scope.execution_id !== undefined) {
    const store = await executionOf(proj, scope);
    await store.transact(({ state }) => {
      const f = Object.hasOwn(state.postmortem?.findings ?? {}, findingId) ? state.postmortem!.findings[findingId] : undefined;
      if (!f || f.pm !== undefined) throw new Error(`${findingId} is not a finding of the open draft of ${scope.execution_id}`);
      return {
        events: [{
          type: "postmortem.fix_updated",
          source: orchestratorSource(state.contract?.scope.orchestrator ?? "orchestrator"),
          payload: { id: findingId, status: fix.status, ...(by && { by }), ...(fix.ref !== undefined && { ref: fix.ref }) },
        }],
      };
    });
  } else {
    await withProjectLock(proj.key, () => {
      const d = findDraft(proj.key, scope);
      const f = d?.findings.find((x) => x.id === findingId);
      if (!d || !f) throw new Error(`${findingId} is not a finding of the open draft of ${scopeLabel(scope)}`);
      const prev = f.fix;
      f.fix = {
        ...((by ?? prev?.by) !== undefined && { by: (by ?? prev?.by)! }),
        status: fix.status,
        ...((fix.ref ?? (fix.status === "pending" ? undefined : prev?.ref)) !== undefined && { ref: (fix.ref ?? prev?.ref)! }),
      };
      saveDraft(d);
    });
  }
  return (await readDraft(proj, scope, true))!;
}
