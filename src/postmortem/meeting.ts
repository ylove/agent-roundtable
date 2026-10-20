// ============================================================================
// The postmortem meeting: hold it at the table, then conclude it with the orchestrator's decisions (§5, §6, §8)
//
// hold_postmortem runs the meeting through the collaboration engine (collaborate, or waffle-house
// when one agent is responsible for every finding) on a bounded context, with public: false and
// origin postmortem:<pm>; the orchestrator's opening is turn 0. It returns the transcript and the
// proposed artifacts. hold_postmortem(conclude) records the orchestrator's closing statement and
// applies the accepted artifacts only. No provider call runs inside a lock or transact.
// ============================================================================

import { agentKey, isPathLikeRef, loadAgent } from "../agents.js";
import type { LLMProvider } from "../config.js";
import { orchestratorSource } from "../execution/contract-state.js";
import { scoreDissent, validateDissentScore } from "../execution/dissent-scoring.js";
import { postmortemBlockers } from "../execution/postmortem-state.js";
import type { AnyEventDraft, BlackboardState, PostmortemArtifactKind, PostmortemFinding, PostmortemFormat } from "../execution/types.js";
import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { newId } from "../ids.js";
import { withUsageSink } from "../providers/usage.js";
import { lineFor } from "../usage/session-scope.js";
import { collaborations, continueCollaboration, endCollaboration, startCollaboration, ORCHESTRATOR } from "../sessions/collaborations.js";
import { applyMemory, applyPersonaAddendum, artifactCounts, parseArtifactBlock } from "./artifacts.js";
import { buildPostmortemContext, withholdHumanWords } from "./context.js";
import { reviewedDissents } from "./dissents.js";
import { executionOf, readDraft, scopeLabel } from "./draft.js";
import { addLessons, activeLessons, type NewLesson } from "./lessons.js";
import { requireEnabled, type ProjectRef } from "./project.js";
import { renderRecord, summaryParagraph } from "./record.js";
import { POSTMORTEM_ORIGIN_PREFIX, registerPostmortemSession } from "./sessions.js";
import { findRecord, loadLessons, readProject, recordPath, removeDraft, saveRecord, withProjectLock } from "./store.js";
import { FLAG_CATEGORIES, LIMITS, type AppliedArtifact, type Artifact, type FlagRecord, type PostmortemRecord, type PostmortemScope, type Turn } from "./types.js";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clean = (s: string, max: number) => {
  const t = scrub(s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
};

export interface HoldInput {
  project: ProjectRef;
  scope: PostmortemScope;
  opening: string;
  participants?: string[];
  format?: PostmortemFormat;
  rounds?: number;
  llm: { provider?: LLMProvider; model?: string; baseUrl?: string };
  memoryTarget?: "claude";
}

export type HoldResult =
  | { status: "nothing_to_learn"; message: string }
  | {
      status: "held";
      pm: string;
      project: string;
      scope: PostmortemScope;
      format: PostmortemFormat;
      rounds: number;
      seats: string[];
      transcript: Turn[];
      findings: PostmortemFinding[];
      dissents: NonNullable<PostmortemRecord["dissents"]>;
      proposed_artifacts: Array<Pick<Artifact, "id" | "kind" | "target" | "findings" | "text" | "outcome">>;
      rejected_lines: string[];
      warnings: string[];
      record: string;
      next: string;
    };

// ---------------------------------------------------------------------------
// Seats and format
// ---------------------------------------------------------------------------

interface Seats {
  /** Agent refs the engine loads, in turn order (the defender first in a waffle-house). */
  refs: string[];
  /** Their keys, as the record names them. */
  keys: string[];
  format: PostmortemFormat;
  defender?: string;
}

function chooseSeats(findings: readonly PostmortemFinding[], state: Readonly<BlackboardState> | undefined, extra: readonly string[], forced?: PostmortemFormat): Seats {
  const refs = new Map<string, string>(); // key → ref
  const add = (ref: string | undefined) => {
    const r = ref?.trim();
    if (!r || r.toLowerCase() === "orchestrator") return;
    const k = agentKey(r);
    // A ref that names where the persona lives (a path) replaces the bare key a finding gave it.
    if (!refs.has(k) || (refs.get(k) === k && isPathLikeRef(r))) refs.set(k, r);
  };
  // Responsible agents first, the most responsible first: they sit nearest the charge.
  const weight = new Map<string, number>();
  for (const f of findings) for (const r of f.responsible) if (r !== "orchestrator") weight.set(agentKey(r), (weight.get(agentKey(r)) ?? 0) + 1);
  const rawRef = (key: string) => Object.values(state?.agents ?? {}).find((a) => agentKey(a.persona) === key)?.persona ?? key;
  for (const k of [...weight.keys()].sort((a, b) => weight.get(b)! - weight.get(a)! || a.localeCompare(b))) add(rawRef(k));
  for (const a of Object.values(state?.agents ?? {})) if (!a.external) add(a.persona);
  for (const e of extra) add(e);
  const keys = [...refs.keys()];
  if (keys.length > LIMITS.seats) throw new Error(`a postmortem meeting seats at most ${LIMITS.seats} agents besides the orchestrator; ${keys.length} were named`);
  const sole = weight.size === 1 && !findings.some((f) => f.responsible.includes("orchestrator")) ? [...weight.keys()][0] : undefined;
  const format = forced ?? (sole !== undefined ? "waffle-house" : "collaborate");
  if (format === "waffle-house") {
    const defender = sole ?? keys[0];
    const order = [defender, ...keys.filter((k) => k !== defender)];
    return { refs: order.map((k) => refs.get(k)!), keys: order, format, defender };
  }
  return { refs: keys.map((k) => refs.get(k)!), keys, format };
}

function refusal(scope: PostmortemScope, pending: string[], tasks: string[]): Error {
  const parts: string[] = [];
  if (pending.length) parts.push(`${pending.length} finding${pending.length === 1 ? " has" : "s have"} a fix still pending (${pending.slice(0, 8).join(", ")})`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? " with a finding is" : "s with findings are"} not finished (${tasks.slice(0, 8).join(", ")})`);
  return new Error(
    `hold_postmortem is refused for ${scopeLabel(scope)} while work is still in flight: ${parts.join("; ")}. ` +
      "Wait until every fix has settled (the watcher wakes you with reason postmortem_ready), or settle one yourself with postmortem(action: \"fix\")."
  );
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

export async function holdPostmortem(i: HoldInput): Promise<HoldResult> {
  requireEnabled(i.project);
  const view = await readDraft(i.project, i.scope);
  if (!view || !view.findings.length) {
    if (view) removeDraft(i.project.key, view.pm);
    return { status: "nothing_to_learn", message: `Nothing to learn: ${scopeLabel(i.scope)} has no findings, so no postmortem meeting is held.` };
  }
  if (view.pending.length || view.in_flight.length) throw refusal(i.scope, view.pending, view.in_flight);

  const store = i.scope.execution_id !== undefined ? await executionOf(i.project, i.scope) : undefined;
  const state = store ? await store.state() : undefined;
  if (state) {
    const b = postmortemBlockers(state);
    if (b.pending.length || b.tasks.length) throw refusal(i.scope, b.pending, b.tasks);
  }
  // The human's own words are not the meeting's: withhold them from the orchestrator's text if it repeats them.
  const protectedTexts = [
    ...(state?.goal?.original_prompt ? [state.goal.original_prompt] : []),
    ...(store ? (await store.events({ types: ["execution.started"], limit: 1 })).flatMap((e) => (e.type === "execution.started" ? [e.payload.confirmation] : [])) : []),
  ];
  const opening = withholdHumanWords(clean(i.opening, LIMITS.opening), protectedTexts);
  if (!opening) throw new Error("opening is required: the orchestrator's account of what happened, including its own part");

  const seats = chooseSeats(view.findings, state, i.participants ?? [], i.format);
  if (seats.refs.length < 2) {
    throw new Error(
      `a postmortem meeting needs at least two agents besides the orchestrator; ${seats.refs.length ? `only ${seats.keys.join(", ")} is known` : "none is known"}. ` +
        "Pass participants (the agents that did the work) to add seats."
    );
  }
  const missing: string[] = [];
  for (const ref of seats.refs) {
    try {
      await loadAgent(ref);
    } catch (e) {
      missing.push(`${ref}: ${errText(e).split("\n")[0]}`);
    }
  }
  if (missing.length) throw new Error(`these seats cannot be loaded as personas: ${missing.join("; ")}`);

  const rounds = i.rounds ?? LIMITS.rounds.default;
  if (!Number.isInteger(rounds) || rounds < LIMITS.rounds.min || rounds > LIMITS.rounds.max) throw new Error(`rounds must be ${LIMITS.rounds.min} to ${LIMITS.rounds.max}`);
  const lessons = activeLessons(i.project.key);
  const context = buildPostmortemContext({
    scope: i.scope, format: seats.format, seats: seats.keys, ...(seats.defender !== undefined && { defender: seats.defender }),
    opening, findings: view.findings, ...(state && { state }), lessons,
  });
  const topic = seats.format === "waffle-house"
    ? `Postmortem of ${scopeLabel(i.scope)}: ${seats.defender} defends its handling of every finding against the charge in the context`
    : `Postmortem of ${scopeLabel(i.scope)}: why each finding happened and what prevents it next time`;

  // The meeting: the engine, in-process, nothing public, no human seat.
  const usage: AnyEventDraft[] = [];
  const source = orchestratorSource(state?.contract?.scope.orchestrator ?? "orchestrator");
  let session = "";
  const transcript: Turn[] = [];
  try {
    const meeting = async () => {
      const llm = { ...(i.llm.provider && { provider: i.llm.provider }), ...(i.llm.model && { model: i.llm.model }), ...(i.llm.baseUrl && { baseUrl: i.llm.baseUrl }) };
      const started = await startCollaboration(seats.refs, topic, {
        ...llm, context, mode: seats.format, maxRounds: rounds, public: false, prototype: false, grounding: false,
        origin: `${POSTMORTEM_ORIGIN_PREFIX}${view.pm}`,
      });
      session = started.collaborationId;
      registerPostmortemSession(session);
      try {
        await continueCollaboration(session, rounds);
        for (const m of (await endCollaboration(session, false)).transcript) {
          if (m.agent !== ORCHESTRATOR) transcript.push({ seat: agentKey(m.agent), content: scrub(m.content) });
        }
      } finally {
        if (collaborations.has(session)) await endCollaboration(session, false).catch(() => undefined);
      }
    };
    // The run owns these calls; standalone meetings keep using the table ledger.
    await (store ? withUsageSink((report) => {
      if (!report.agent) throw new Error("Postmortem usage has no speaking persona");
      const line = lineFor({ session: session || view.pm, kind: "postmortem", agent: report.agent }, report, "");
      const tokens = line.tokens!;
      usage.push({ type: "budget.usage_recorded", source, correlation: view.pm, payload: {
        source: "postmortem", call_id: newId("call"), agent: line.agent, provider: report.provider, model: report.model,
        tokens: { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cache_read, cacheWriteTokens: tokens.cache_write },
        usd: report.usd ?? line.usd ?? 0, estimated: report.usd === undefined,
        provenance: { tokens: line.tokens_prov!, usd: report.usd === undefined ? "estimated" : "measured" },
      } });
    }, meeting) : meeting());
  } catch (e) {
    throw new Error(`the postmortem meeting for ${scopeLabel(i.scope)} stopped: ${errText(e)}. The draft is unchanged; hold it again when the provider is back.`);
  } finally {
    // Flush before publication too: failed turns and a failed/overlapping hold still cost money.
    if (store && usage.length) await store.transact(() => ({ events: usage }));
  }
  if (!transcript.length) throw new Error("the postmortem meeting produced no turns; the draft is unchanged");

  const dissents = reviewedDissents(state);
  const last = transcript[transcript.length - 1].content;
  const { artifacts, rejected } = parseArtifactBlock(last, seats.keys, new Set(view.findings.map((f) => f.id)), new Set(Object.keys(dissents)));
  const warnings: string[] = [];
  if (!artifacts.length) {
    warnings.push(rejected.length ? "none of the lines in the last turn's artifact block could be used" : "the last turn had no artifact block, so the meeting proposed no artifacts");
  }

  const heldAt = new Date().toISOString();
  const rec: PostmortemRecord = {
    v: 1, pm: view.pm, project: i.project.key, scope: i.scope, status: "held", created: heldAt, held_at: heldAt,
    format: seats.format, rounds, seats: ["orchestrator", ...seats.keys], refs: Object.fromEntries(seats.keys.map((k, n) => [k, seats.refs[n]])), session,
    ...(i.memoryTarget === "claude" && { memory_target: "claude" as const }),
    opening, findings: view.findings, dissents, transcript, proposed: artifacts, rejected_lines: rejected,
  };
  await withProjectLock(i.project.key, async () => {
    const existing = findRecord(view.pm);
    if (existing) throw new Error(`postmortem ${view.pm} is already ${existing.status}; another hold completed first; the existing record is unchanged`);
    saveRecord(rec, renderRecord(rec));
    removeDraft(i.project.key, view.pm);
    if (store) {
      await store.transact(() => ({
        events: [
          { type: "postmortem.started", source, payload: { id: view.pm, format: seats.format, seats: rec.seats } } as AnyEventDraft,
        ],
      }));
    }
  });
  return {
    status: "held", pm: view.pm, project: i.project.key, scope: i.scope, format: seats.format, rounds, seats: rec.seats,
    transcript: [{ seat: "orchestrator", content: opening }, ...transcript], findings: view.findings,
    dissents, proposed_artifacts: artifacts.map(({ id, kind, target, findings, text, outcome }) => ({ id, kind, target, findings, text, ...(outcome && { outcome }) })),
    rejected_lines: rejected, warnings, record: recordPath(i.project.key, view.pm, "md"),
    next:
      `Read the transcript, then close the meeting with your own words: hold_postmortem { "action": "conclude", "pm": "${view.pm}", "closing": "…", "accept": [artifact ids], "reject": [{ "id", "why" }] }. ` +
      "When accepting dissent_score, also pass orchestrator (the contract’s orchestrator identity). Only accepted artifacts take effect. Tell the human the meeting happened; they can read every turn with postmortem(action: \"read\").",
  };
}

// ---------------------------------------------------------------------------
// Conclude
// ---------------------------------------------------------------------------

export interface ConcludeInput {
  pm: string;
  /** Required when accepting dissent_score artifacts, as for score_dissent. */
  orchestrator?: string;
  closing: string;
  accept?: string[];
  reject?: Array<{ id: string; why: string }>;
}

export interface ConcludeResult {
  status: "concluded";
  pm: string;
  already_concluded?: true;
  record: string;
  summary: string;
  accepted: string[];
  rejected: Array<{ id: string; why: string }>;
  not_accepted: string[];
  applied: AppliedArtifact[];
  follow_ups: Array<{ id: string; target: string; text: string }>;
  flagged: FlagRecord[];
  lessons_added: number;
  warnings: string[];
  tell_the_human: string;
}

function resultOf(r: PostmortemRecord, warnings: string[], lessonsAdded: number, already = false): ConcludeResult {
  const accepted = r.accepted ?? [];
  return {
    status: "concluded", pm: r.pm, ...(already && { already_concluded: true as const }), record: recordPath(r.project, r.pm, "md"),
    summary: r.summary ?? summaryParagraph(r), accepted, rejected: r.rejected ?? [],
    not_accepted: r.proposed.map((a) => a.id).filter((id) => !accepted.includes(id) && !(r.rejected ?? []).some((x) => x.id === id)),
    applied: r.applied ?? [],
    follow_ups: r.proposed.filter((a) => a.kind === "fix" && accepted.includes(a.id)).map((a) => ({ id: a.id, target: a.target, text: a.text })),
    flagged: r.flagged ?? [], lessons_added: lessonsAdded, warnings,
    tell_the_human: `${r.summary ?? summaryParagraph(r)} The record is at ${recordPath(r.project, r.pm, "md")}; show it verbatim if they want to read it.${r.applied?.some((a) => a.audit_pending) ? " A scoring audit is still pending; repeat conclude to finish it." : ""}`,
  };
}

const LESSON_KIND: Partial<Record<PostmortemArtifactKind, NewLesson["kind"]>> = { rule: "rule", agent_rule: "agent_rule", contract_rule: "contract_rule" };

export async function concludePostmortem(i: ConcludeInput): Promise<ConcludeResult> {
  const found = findRecord(i.pm);
  if (!found) throw new Error(`No held postmortem ${i.pm}. hold_postmortem returns its pm id; postmortem(action: "list") lists them.`);
  if (found.status === "concluded") return finishConclusion(found, [], 0, true);

  const known = new Set(found.proposed.map((a) => a.id));
  const accept = [...new Set(i.accept ?? [])];
  const reject = (i.reject ?? []).map((x) => ({ id: x.id, why: clean(x.why, 400) }));
  const unknown = [...accept, ...reject.map((x) => x.id)].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown artifact id${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; the proposed ones are ${[...known].join(", ") || "none"}`);
  const both = accept.filter((id) => reject.some((x) => x.id === id));
  if (both.length) throw new Error(`${both.join(", ")} is in both accept and reject`);
  const project = readProject(found.project);
  if (!project) throw new Error(`project ${found.project} is gone from the postmortem store`);
  const proj: ProjectRef = { key: found.project, root: project.repo_root };

  const assessments = found.proposed.filter((a) => a.kind === "dissent_score" && accept.includes(a.id));
  if (assessments.length) requireEnabled(proj);
  const protectedTexts: string[] = [];
  const store = found.scope.execution_id !== undefined ? await executionOf(proj, found.scope).catch(() => undefined) : undefined;
  if (store) {
    const s = await store.state();
    if (s.goal?.original_prompt) protectedTexts.push(s.goal.original_prompt);
    for (const e of await store.events({ types: ["execution.started"], limit: 1 })) if (e.type === "execution.started") protectedTexts.push(e.payload.confirmation);
  }
  if (assessments.length) {
    if (!store) throw new Error("dissent_score requires the reviewed execution to be available");
    const state = await store.state();
    for (const a of assessments) validateDissentScore(state, {
      contractId: state.contract?.id ?? "", orchestrator: i.orchestrator ?? "", dissentId: a.target, outcome: a.outcome!,
    });
  }
  const closing = withholdHumanWords(clean(i.closing, LIMITS.closing), protectedTexts);
  if (!closing) throw new Error("closing is required: your closing statement for the record");

  const warnings: string[] = [];
  let record!: PostmortemRecord;
  let lessonsAdded = 0;
  await withProjectLock(found.project, async () => {
    const rec = findRecord(i.pm);
    if (!rec || rec.status === "concluded") {
      record = rec ?? found;
      return;
    }
    // A damaged lessons.json fails here, before any persona or memory file is written.
    loadLessons(rec.project);
    const applied: AppliedArtifact[] = [];
    const lessons: NewLesson[] = [];
    const now = new Date();
    const audit = (done: AppliedArtifact) => auditApplied(rec, done);
    for (const a of rec.proposed.filter((x) => accept.includes(x.id))) {
      try {
        let done: AppliedArtifact;
        if (a.kind === "dissent_score") {
          requireEnabled(proj);
          if (!store) throw new Error("dissent_score requires the reviewed execution to be available");
          const state = await store.state();
          await scoreDissent(store, {
            contractId: state.contract?.id ?? "", orchestrator: i.orchestrator ?? "", dissentId: a.target, outcome: a.outcome!,
            operationKey: `postmortem:${rec.pm}:${a.id}:${a.hash}`,
            reviewed: rec.dissents?.[a.target] ?? {},
          });
          done = { id: a.id, kind: a.kind, target: a.target, hash: a.hash, path: store.dir, note: `advisory assessment: ${a.outcome}` };
        } else if (a.kind === "persona_addendum") done = await applyPersonaAddendum(a, rec.pm, now, rec.refs?.[a.target]);
        else if (a.kind === "memory") done = applyMemory(a, rec.pm, { key: rec.project, root: proj.root }, rec.memory_target === "claude");
        else if (a.kind === "fix") done = { id: a.id, kind: a.kind, target: a.target, hash: a.hash, note: "recorded as a follow-up; nothing was changed" };
        else {
          lessons.push({ kind: LESSON_KIND[a.kind]!, target: a.kind === "agent_rule" ? a.target : "project", text: a.text, pm: rec.pm, findings: a.findings });
          done = { id: a.id, kind: a.kind, target: a.target, hash: a.hash, path: "lessons.json", note: "added to the project's lessons" };
        }
        // File and scoring writes are audited immediately; lesson writes are audited after persistence.
        if (a.kind === "dissent_score") {
          try { await audit(done); }
          catch (e) {
            done.audit_pending = true;
            warnings.push(`${a.id} was applied but its audit is pending: ${errText(e)}. Repeat conclude to retry the audit.`);
          }
        } else if (a.kind === "persona_addendum" || a.kind === "memory") await audit(done);
        applied.push(done);
      } catch (e) {
        warnings.push(`${a.id} (${a.kind} → ${a.target}) was accepted but not applied: ${errText(e)}`);
        applied.push({ id: a.id, kind: a.kind, target: a.target, hash: a.hash, note: `failed: ${errText(e)}` });
      }
    }
    const ok = new Set(applied.filter((a) => !a.note?.startsWith("failed")).map((a) => a.id));
    // Flags: a finding that misread the prompt, the project or the contract is recorded as such, with the clearer wording accepted for it.
    const flagged: FlagRecord[] = rec.findings.filter((f) => FLAG_CATEGORIES.includes(f.category)).map((f) => {
      const clearer = rec.proposed.filter((a) => ok.has(a.id) && a.findings.includes(f.id) && a.kind !== "memory" && a.kind !== "dissent_score").map((a) => a.text).join(" ");
      return { finding: f.id, category: f.category, misread: f.summary, ...(clearer && { clearer: clearer.slice(0, 600) }) };
    });
    for (const f of flagged) {
      lessons.push({ kind: "flag", target: "project", flag: true, text: `${f.misread}${f.clearer ? ` Clearer: ${f.clearer}` : ""}`.slice(0, 1200), pm: rec.pm, findings: [f.finding] });
    }
    lessonsAdded = lessons.length ? addLessons(rec.project, lessons, now.toISOString()).length : 0;
    for (const a of rec.proposed.filter((x) => ok.has(x.id) && x.kind !== "persona_addendum" && x.kind !== "memory" && x.kind !== "dissent_score")) await audit(applied.find((x) => x.id === a.id)!);
    const concluded: PostmortemRecord = {
      ...rec, status: "concluded", concluded_at: now.toISOString(), closing,
      accepted: accept, rejected: reject, applied, flagged,
    };
    concluded.summary = summaryParagraph({ ...concluded, applied: applied.filter((a) => ok.has(a.id)), accepted: accept.filter((id) => ok.has(id)) });
    saveRecord(concluded, renderRecord(concluded));
    record = concluded;
  });

  return finishConclusion(record, warnings, lessonsAdded);
}

/** Retry outstanding audit/publication work without applying accepted artifacts again. */
async function finishConclusion(record: PostmortemRecord, warnings: string[], lessonsAdded: number, already = false): Promise<ConcludeResult> {
  let current = record;
  await withProjectLock(record.project, async () => {
    current = findRecord(record.pm) ?? record;
    if (already) {
      for (const done of current.applied ?? []) {
        if (!done.audit_pending) continue;
        try {
          await auditApplied(current, done);
          delete done.audit_pending;
          saveRecord(current, renderRecord(current));
        } catch (e) {
          done.audit_pending = true;
          warnings.push(`${done.id} was applied but its audit is pending: ${errText(e)}. Repeat conclude to retry the audit.`);
        }
      }
    }
    // Do not publish a completed record until every successful scoring write is audited.
    if (current.applied?.some((a) => a.audit_pending)) return;
    if (current.scope.execution_id === undefined) return;
    try {
      const project = readProject(current.project);
      if (!project) throw new Error(`project ${current.project} is gone from the postmortem store`);
      const store = await executionOf({ key: current.project, root: project.repo_root }, current.scope);
      const ok = (current.applied ?? []).filter((a) => !a.note?.startsWith("failed"));
      await store.transact(async ({ state }) => {
        const published = (await store.events({ types: ["postmortem.concluded"] })).some((e) => e.type === "postmortem.concluded" && e.payload.id === current.pm);
        if (published) return { events: [] };
        const blob = await store.putBlob(renderRecord(current));
        return { events: [{
          type: "postmortem.concluded", source: orchestratorSource(state.contract?.scope.orchestrator ?? "orchestrator"),
          payload: { id: current.pm, artifacts: artifactCounts(ok), flagged: current.flagged?.length ?? 0, record: blob },
        } as AnyEventDraft] };
      });
    } catch (e) {
      warnings.push(`the run's log could not record the conclusion: ${errText(e)}. Repeat conclude to retry publication.`);
    }
  });
  return resultOf(current, warnings, lessonsAdded, already);
}

function auditApplied(rec: PostmortemRecord, done: AppliedArtifact): Promise<unknown> {
  return appendAudit({ actor: "orchestrator", action: "postmortem.applied", target: rec.pm, details: { artifact: done.id, kind: done.kind, target: done.target, path: done.path, hash: done.hash, project: rec.project } });
}
