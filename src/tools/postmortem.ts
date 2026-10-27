// ============================================================================
// The postmortem tool (docs/design/postmortem.md §9)
//
// Orchestrator server only. It keeps the project's opt-in, the running draft of findings, the
// lessons and the records; hold_postmortem (hold-postmortem.ts) runs the meeting. The logic lives
// in src/postmortem/.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readDraft, recordFinding, scopeLabel, scopeOf, updateFix, type DraftView } from "../postmortem/draft.js";
import { activeLessons, viewOf } from "../postmortem/lessons.js";
import { signOffPostmortem } from "../postmortem/meeting.js";
import { isEnabled, requireEnabled, resolveProject, setEnabled, type ProjectRef } from "../postmortem/project.js";
import { renderRecord } from "../postmortem/record.js";
import { findRecord, listDrafts, listProjectKeys, listRecords, loadDraft, pendingPostmortems, readProject, recordPath } from "../postmortem/store.js";
import { CATEGORIES, LIMITS, PM_ID_RE } from "../postmortem/types.js";
import { POSTMORTEM } from "./names.js";
import { ORCHESTRATOR_ONLY, type ToolArgs, type ToolDefinition } from "./shared.js";

export const POSTMORTEM_ACTIONS = ["enable", "disable", "record", "fix", "draft", "lessons", "list", "read", "pending", "signoff"] as const;

export const EXECUTION_ID = { type: "string", pattern: "^exe-[0-9a-hjkmnp-tv-z]{16}$", description: "The heads-down run (exe-…) the draft belongs to. Give this or work." } as const;
export const WORK = { type: "string", maxLength: LIMITS.work, description: "A short label for at-the-table work (for example \"checkout redesign\") when there is no run. Give this or execution_id." } as const;
export const PROJECT = {
  type: "string",
  maxLength: 1000,
  description: "The project: a directory inside its git repository (resolved with git rev-parse --show-toplevel; refused outside a git work tree or with submodules), or a project key returned earlier.",
} as const;
export const PM_PATTERN = "^pm-[0-9a-hjkmnp-tv-z]{8}$";

export const missing = (tool: string, field: string, why: string): never => {
  throw new Error(`${tool}: "${field}" is required ${why}`);
};

export function checkScope(tool: string, a: Record<string, unknown>): void {
  const exe = a.execution_id !== undefined && a.execution_id !== null;
  const work = a.work !== undefined && a.work !== null;
  if (exe === work) throw new Error(`${tool}: pass exactly one of execution_id (a heads-down run) and work (a short label for at-the-table work)`);
}

function checkPostmortemArgs(a: Record<string, unknown>): void {
  const action = a.action as string | undefined;
  const need = (field: string, why: string) => a[field] === undefined || a[field] === null || a[field] === "" ? missing(POSTMORTEM, field, why) : undefined;
  switch (action) {
    case "enable":
    case "disable":
      need("project", `for ${action}`);
      need("reason", "and must quote the human's own words");
      break;
    case "record":
      need("project", "for record");
      checkScope(POSTMORTEM, a);
      need("finding", "for record: {summary, detected_by, responsible[], category}");
      break;
    case "fix":
      need("project", "for fix");
      checkScope(POSTMORTEM, a);
      need("finding_id", "for fix");
      need("fix", "for fix: {status, by?, ref?}");
      if (!(a.fix as Record<string, unknown>).status) missing(POSTMORTEM, "fix.status", "(pending, fixed or abandoned)");
      break;
    case "draft":
      need("project", "for draft");
      checkScope(POSTMORTEM, a);
      break;
    case "signoff":
      need("pm", "for signoff");
      need("orchestrator", "for signoff: the human-supplied identity");
      need("accept", "for signoff: explicit artifact ids");
      if (!Array.isArray(a.accept) || !a.accept.length) throw new Error("accept must list at least one pending artifact id");
      break;
    case "pending":
    case "lessons":
    case "list":
      need("project", `for ${action}`);
      break;
    case "read":
      need("pm", "for read");
      break;
  }
}

export const postmortemTools: ToolDefinition[] = [
  {
    name: POSTMORTEM,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkPostmortemArgs,
    annotations: { title: "Postmortem", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Postmortem mode: while testing sends fixers back, you keep a running draft of every finding; when all fixers are done the agents that did the work meet with you (hold_postmortem) and leave actionable artifacts, kept per project and read back before the next plan. " +
      "Off by default: action enable turns it on for a project ONLY when the human asked for postmortem meetings, retrospectives, or agents improving themselves or each other; reason quotes their words verbatim (recorded in the project's log and the audit log). " +
      "Nothing infers it. A heads-down run inherits it from its contract (propose_contract sets it); the runner then records a finding by itself when a submission is sent back after testing. disable turns it off and keeps stored postmortems. " +
      "record adds a finding to the draft of a scope (execution_id for a run, or work for at-the-table work): {summary, detected_by, responsible[] (persona names, or \"orchestrator\"), category, task?, evidence[] (refs only: sha256: blob refs, event ids, commit shas, paths)}. " +
      "fix sets a finding's fix {status: pending|fixed|abandoned, by?, ref?}; in a run, retries, merges and failures update fixes by themselves. draft returns the findings, what is still pending and whether the meeting can be held. " +
      "Persisted kinds (rule, agent_rule, contract_rule, persona_addendum, memory) need a person’s sign-off: orchestrator (the human-supplied identity) and explicit accept ids. pending lists pending text and hashes for a project; signoff applies selected pending ids from a concluded pm. Without sign-off they stay visible in the record and never enter prompts. lessons returns the active lessons, pending count and accepted_before_signoff markers for legacy lessons (which keep flowing into prompts, whether or not the mode is on); list shows its drafts and postmortems; read returns a postmortem's full record (every turn) for you to show the human verbatim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...POSTMORTEM_ACTIONS], description: "enable, disable, record, fix, draft, lessons, list, read, pending or signoff." },
        project: PROJECT,
        execution_id: EXECUTION_ID,
        work: WORK,
        reason: { type: "string", maxLength: LIMITS.reason, description: "enable / disable: the human's own words asking for it (or for turning it off), quoted verbatim. Never invent it." },
        finding: {
          type: "object",
          additionalProperties: false,
          description: "record: the finding.",
          properties: {
            summary: { type: "string", maxLength: LIMITS.summary, description: "What went wrong, in at most 600 characters.", "x-nonblank": true },
            detected_by: { type: "string", maxLength: LIMITS.detectedBy, description: "The check, test or reviewer that caught it.", "x-nonblank": true },
            responsible: { type: "array", maxItems: LIMITS.responsible, items: { type: "string" }, description: "The agents whose work was sent back: persona names, or \"orchestrator\" for your own part." },
            category: { type: "string", enum: [...CATEGORIES], description: "prompt_misread, project_misread, contract_ambiguity, implementation, test_gap or process. The first three are flagged and warn future plans." },
            task: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "The heads-down task id, when the finding is about one." },
            evidence: { type: "array", maxItems: LIMITS.evidence, items: { type: "string" }, description: "Refs only: sha256: blob refs, event ids, commit shas or repository paths. Command output is refused." },
          },
          required: ["summary", "detected_by", "responsible", "category"],
        },
        finding_id: { type: "string", maxLength: 40, description: "fix: the finding (pmf-…)." },
        fix: {
          type: "object",
          additionalProperties: false,
          description: "fix: the finding's fix.",
          properties: {
            by: { type: "string", maxLength: LIMITS.responsibleName, description: "Who fixes it (an agent, a task, or yourself)." },
            status: { type: "string", enum: ["pending", "fixed", "abandoned"], description: "pending, fixed or abandoned." },
            ref: { type: "string", maxLength: LIMITS.evidenceRef, description: "A ref to the fix: a commit sha, an event id or a path." },
          },
          required: ["status"],
        },
        orchestrator: { type: "string", maxLength: 200, "x-nonblank": true, description: "signoff: the human-supplied identity; must match the frozen contract’s orchestrator for a run." },
        accept: { type: "array", minItems: 1, maxItems: LIMITS.artifacts, items: { type: "string", maxLength: 16 }, description: "signoff: explicit pending artifact ids to apply." },
        pm: { type: "string", pattern: PM_PATTERN, description: "read / signoff: the postmortem (pm-…) hold_postmortem returned." },
      },
      required: ["action"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const render = (body: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });

function draftBody(d: DraftView, extra: Record<string, unknown> = {}) {
  return {
    pm: d.pm, project: d.project, scope: d.scope, findings: d.findings, pending_fixes: d.pending, tasks_in_flight: d.in_flight, ready: d.ready,
    next: d.ready
      ? "Every fix has settled: hold the meeting with hold_postmortem { project, execution_id | work, opening } (you write the opening)."
      : d.findings.length
        ? "Not ready: wait for the pending fixes and unfinished tasks, or settle a fix yourself with postmortem(action: \"fix\")."
        : "No findings yet.",
    ...extra,
  };
}

function listBody(p: ProjectRef) {
  const project = readProject(p.key);
  return {
    project: p.key, repo_root: p.root, postmortem_mode: isEnabled(p.key) ? "on" : "off",
    ...(project?.postmortem.enabled && { enabled_since: project.postmortem.since }),
    drafts: listDrafts(p.key).map((d) => ({ pm: d.pm, scope: d.scope, findings: d.findings.length, created: d.created })),
    postmortems: listRecords(p.key).map((r) => ({
      pm: r.pm, status: r.status, scope: r.scope, format: r.format, held_at: r.held_at, ...(r.concluded_at && { concluded_at: r.concluded_at }),
      findings: r.findings.length, proposed: r.proposed.length, ...(r.accepted && { accepted: r.accepted.length }), pending: r.pending?.length ?? 0, record: recordPath(r.project, r.pm, "md"),
    })),
  };
}

/** Dispatch the postmortem tool. Errors are thrown to handleToolCall, which formats them. */
export async function handlePostmortemTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  if (name !== POSTMORTEM) throw new Error(`Unknown tool: ${name}`);
  // null means "not given", as in validation.
  const a = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined)) as Record<string, unknown>;
  const action = a.action as (typeof POSTMORTEM_ACTIONS)[number];
  if (action === "signoff") return render(await signOffPostmortem({ pm: a.pm as string, orchestrator: a.orchestrator as string, accept: a.accept as string[] }));
  if (action === "read") {
    const pm = a.pm as string;
    if (!PM_ID_RE.test(pm)) throw new Error(`"pm" is not a postmortem id (pm-…)`);
    const rec = findRecord(pm);
    if (rec) return { content: [{ type: "text", text: renderRecord(rec) }] };
    for (const key of listProjectKeys()) {
      const d = loadDraft(key, pm);
      if (d) return render({ pm, status: "draft", project: key, scope: d.scope, findings: d.findings, note: "This draft has not been held yet; a run's findings are in its log (postmortem action draft)." });
    }
    throw new Error(`No postmortem ${pm}. postmortem(action: "list", project) lists them.`);
  }
  const project = await resolveProject(a.project as string);
  switch (action) {
    case "enable":
    case "disable": {
      const file = await setEnabled(project, action === "enable", a.reason as string);
      return render({
        project: project.key, repo_root: project.root, postmortem_mode: file.postmortem.enabled ? "on" : "off",
        next: file.postmortem.enabled
          ? "Postmortem mode is on for this project. A contract proposed for it now carries postmortem: {enabled: true}, and a heads-down run records findings by itself; record the ones you learn at the table."
          : "Postmortem mode is off. Stored postmortems and lessons are kept; lessons are still read before the next plan.",
      });
    }
    case "record": {
      requireEnabled(project);
      const scope = scopeOf(a);
      const r = await recordFinding(project, scope, a.finding as never);
      return render({ recorded: r.id, ...draftBody(r.draft) });
    }
    case "fix": {
      requireEnabled(project);
      return render(draftBody(await updateFix(project, scopeOf(a), a.finding_id as string, a.fix as never)));
    }
    case "draft": {
      const scope = scopeOf(a);
      const d = await readDraft(project, scope);
      return render(d ? draftBody(d) : { project: project.key, scope, findings: [], ready: false, next: `No findings are recorded for ${scopeLabel(scope)}.` });
    }
    case "pending":
      return render({ project: project.key, pending: pendingPostmortems(project.key) });
    case "lessons":
      return render({ pending: pendingPostmortems(project.key).length, ...viewOf(project.key, activeLessons(project.key)), postmortem_mode: isEnabled(project.key) ? "on" : "off" });
    case "list":
      return render(listBody(project));
    default:
      throw new Error(`Unknown action: ${String(action)}`);
  }
}
