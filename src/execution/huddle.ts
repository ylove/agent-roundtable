// ============================================================================
// Huddles: the micro-huddle (two model turns at most) and format huddles run through the engines
//
// Micro-huddle (#83), for a peer escalation:
//   turn 0  the escalation itself (no model call);
//   turn 1  the counterpart's answer: a live claude-code worker answers from a fork of its own
//           session (driver.answer, read-only, $0.50 cap); anyone else through a persona call with
//           its task card, progress and diff stat;
//   turn 2  the requester's conclusion: `Outcome: AGREED | DISAGREED | NEEDS_ORCHESTRATOR` and
//           `Decision:`.
// AGREED records the decision for both tasks (it reaches both inboxes), resolves the escalation,
// unblocks the requester and resumes it with the resolution; anything else goes to the orchestrator.
//
// Format huddles (#84) run the existing engines in-process (collaboration, debate, waffle-house,
// conversation, a one-round two-agent "meeting", or a re-plan through ultraplan) on the context
// bundle, never the human's chat, with public: false and an origin tag; the lead concludes them
// in one persona call. Turns go to blobs (scrubbed); huddle.started, huddle.turn and
// huddle.concluded record them. No provider call runs inside transact.
// ============================================================================

import { join } from "node:path";
import { agentKey } from "../agents.js";
import { newId } from "../ids.js";
import { readArchivedSession } from "../sessions/archive.js";
import { collaborations, continueCollaboration, endCollaboration, startCollaboration } from "../sessions/collaborations.js";
import type { CollaborationMode } from "../sessions/modes.js";
import { endUltraplan, startUltraplan, ultraplans } from "../sessions/ultraplan.js";
import { agentDir, agentTask } from "../workers/files.js";
import { remainingUsd } from "./budget.js";
import { buildContextBundle, leasesInQuestion, readDiagnostics, targetPaths, type Diagnostics } from "./context-bundle.js";
import {
  UsageMeter,
  actorSource,
  askPersona,
  cap,
  commitIf,
  commitResolution,
  defaultAlive,
  errText,
  ev,
  own,
  parseField,
  routeToOrchestrator,
  scopeOrchestrator,
  verdictOf,
  type Actor,
  type EscalationOptions,
  type HookCtx,
  type ProcessOp,
} from "./escalation.js";
import { buildTaskCard } from "./task-card.js";
import type { AnyEventDraft, BlackboardState, Decision, Escalation, EscalationStatus, HuddleFormat, HuddleOutcome, WorkerRecord } from "./types.js";
import { taskWorktreePath } from "./worktrees.js";

/** The micro-huddle answer's dollar cap (driver.answer). */
export const MICRO_ANSWER_USD = 0.5;
/** Collaboration huddles run at most this many rounds (heads-down.md §11). */
export const HUDDLE_MAX_ROUNDS = 3;
const MICRO_OUTCOMES = ["AGREED", "DISAGREED", "NEEDS_ORCHESTRATOR"] as const;
const TRANSCRIPT_LIMIT = 16_000;
const CARD_LIMIT = 8000;
const MAX_TURN_EVENTS = 40;

// ============================================================================
// Seats
// ============================================================================

/** A huddle participant: its seat name (an agent id, else a persona key), persona and, when known, agent and task. */
export interface Seat {
  seat: string;
  persona: string;
  agent?: string;
  task?: string;
}

function seatOfAgent(state: Readonly<BlackboardState>, agent: string | undefined): Seat | undefined {
  const rec = own(state.agents, agent);
  if (!rec || !agent) return undefined;
  const task = agentTask(state, agent) ?? rec.task;
  return { seat: agent, persona: rec.persona, agent, ...(task !== undefined && { task }) };
}

function seatOfTask(state: Readonly<BlackboardState>, task: string | undefined): Seat | undefined {
  const rt = own(state.tasks, task);
  if (!rt || !task) return undefined;
  const bySeat = rt.agent ? seatOfAgent(state, rt.agent) : undefined;
  return bySeat?.task === task ? bySeat : { seat: agentKey(rt.spec.persona), persona: rt.spec.persona, task };
}

const personaSeat = (persona: string): Seat => ({ seat: agentKey(persona), persona });

/** The raiser: its agent record, else its task's persona. */
export function requesterSeat(state: Readonly<BlackboardState>, esc: Escalation): Seat | undefined {
  const a = seatOfAgent(state, esc.agent);
  if (a) return esc.task !== undefined ? { ...a, task: esc.task } : a;
  return seatOfTask(state, esc.task);
}

/**
 * Who a peer escalation is with: the target as an agent, a task, a team (its lead, else another
 * member), an interface (its owner task) or an agent's persona; otherwise the holder of a lease in
 * question, or the task that last committed a target path.
 */
export function counterpartSeat(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): Seat | undefined {
  const other = (s: Seat | undefined): Seat | undefined =>
    s && (s.agent === undefined || s.agent !== esc.agent) && (s.task === undefined || s.task !== esc.task) ? s : undefined;
  const t = esc.target;
  if (t) {
    const found = other(seatOfAgent(state, t)) ?? other(seatOfTask(state, t));
    if (found) return found;
    const team = own(state.teams, t);
    if (team) {
      const lead = team.lead !== undefined ? other(seatOfAgent(state, team.lead)) ?? (team.lead !== esc.agent ? personaSeat(team.lead) : undefined) : undefined;
      const member = team.members.map((m) => other(seatOfAgent(state, m))).find(Boolean);
      if (lead ?? member) return lead ?? member;
    }
    const owner = other(seatOfTask(state, own(state.interfaces, t)?.spec?.owner));
    if (owner) return owner;
    const byPersona = Object.values(state.agents).find((r) => r.persona === t && r.id !== esc.agent);
    if (byPersona) return other(seatOfAgent(state, byPersona.id));
  }
  for (const l of leasesInQuestion(state, esc, diag)) {
    const s = other(seatOfAgent(state, l.agent)) ?? other(seatOfTask(state, l.task));
    if (s) return s;
  }
  for (const p of targetPaths(state, esc, diag)) {
    const s = other(seatOfTask(state, own(state.files, p)?.task));
    if (s) return s;
  }
  return undefined;
}

/** The record driver.answer needs, for a counterpart that is a live claude-code worker; else undefined. */
export function liveWorkerRecord(ctx: HookCtx, state: Readonly<BlackboardState>, seat: Seat, alive: (pid: number) => boolean): WorkerRecord | undefined {
  const live = seat.agent ? ctx.worker?.(seat.agent) : undefined;
  if (ctx.worker) return live?.driver === "claude-code" && ctx.driver?.id === "claude-code" && ctx.driver.answer ? live : undefined;
  const rec = own(state.agents, seat.agent);
  if (!rec || !seat.agent || !seat.task || !ctx.driver?.answer || ctx.driver.id !== "claude-code") return undefined;
  if (rec.driver !== "claude-code" || rec.status !== "running" || !rec.session_id || rec.pid === undefined || !alive(rec.pid)) return undefined;
  const rt = own(state.tasks, seat.task);
  const attempt = rt?.attempt || own(state.claims, seat.task)?.attempt || 1;
  let outputPath: string;
  let cwd: string;
  try {
    outputPath = join(agentDir(state.execution, seat.agent), "runs", `${attempt}.jsonl`);
    cwd = rt?.worktree ?? taskWorktreePath(state.execution, seat.task);
  } catch {
    return undefined;
  }
  return {
    agent: seat.agent, task: seat.task, attempt, pid: rec.pid, pgid: rec.pid, sessionId: rec.session_id,
    outputPath, startedAt: rt?.started_at ?? "", driver: "claude-code", cwd,
  };
}

// ============================================================================
// Micro-huddle (#83)
// ============================================================================

const COUNTERPART_DIRECTIVE =
  "\n\n## Micro-huddle\n" +
  "Another worker in this heads-down run escalated to you about your work. You cannot run tools here. " +
  "Answer in a few sentences: what you can agree to, what you need from them, and anything they must not do.";

const REQUESTER_DIRECTIVE =
  "\n\n## Micro-huddle\n" +
  "You escalated to another worker in this heads-down run and they answered. Conclude for your side, in exactly the format asked.";

const ANSWER_INTRO =
  "A micro-huddle: another worker in this heads-down run escalated to you. Answer from what you know of your task in a few sentences: " +
  "what you can agree to, what you need from them, and anything they must not do. Do not use tools.";

function escalationText(esc: Escalation, req: Seat, cp: Seat): string {
  const lines = [
    `Escalation ${esc.id} from ${req.seat}${req.task ? ` (task ${req.task})` : ""} to ${cp.seat}${cp.task ? ` (task ${cp.task})` : ""}: ${esc.kind}.`,
    "",
    cap(esc.summary, 2000),
  ];
  if (esc.question) lines.push("", `Question: ${cap(esc.question, 1500)}`);
  if (esc.options?.length) lines.push("", "Options:", ...esc.options.slice(0, 10).map((o, i) => `${i + 1}. ${cap(o, 200)}`));
  return lines.join("\n");
}

function counterpartPrompt(state: Readonly<BlackboardState>, turn0: string, cp: Seat): string {
  const parts = [`## The escalation\n\n${turn0}`];
  const rt = own(state.tasks, cp.task);
  if (rt && cp.task) {
    parts.push(`## Your task\n\n${cap(buildTaskCard(state, cp.task), CARD_LIMIT)}`);
    const progress = [rt.percent !== undefined ? `${rt.percent}% done` : "", rt.last_note ? `last note: ${cap(rt.last_note, 600)}` : ""].filter(Boolean);
    if (progress.length) parts.push(`## Your progress\n\n${progress.join("; ")}`);
    const diff = own(state.diffs, cp.task);
    if (diff?.stat) parts.push(`## Your changes so far\n\n${cap(diff.stat, 1000)}`);
  }
  parts.push("Answer the escalation from your side.");
  return parts.join("\n\n");
}

function conclusionPrompt(turn0: string, cp: Seat, answer: string): string {
  return `## Your escalation\n\n${turn0}\n\n## The answer from ${cp.seat}\n\n${cap(answer, 6000)}\n\n` +
    "Reply with exactly these two lines first:\n" +
    "Outcome: AGREED | DISAGREED | NEEDS_ORCHESTRATOR\n" +
    "Decision: <what you will both do, in one or two sentences; when not AGREED, what is still open>\n\n" +
    "AGREED only when the answer settles your escalation and you can continue. NEEDS_ORCHESTRATOR when the decision belongs to the orchestrator " +
    "(scope, budget, the contract or another team).";
}

export interface MicroHuddleOptions extends EscalationOptions {
  /** Who started it: the runner (routing) or an orchestrator or the lead (resolve_escalation). */
  actor: Actor;
  /** Statuses the escalation may start from. */
  expect: EscalationStatus[];
}

/**
 * Run a micro-huddle on a peer escalation. At most two model calls (turns 1 and 2). AGREED
 * resolves the escalation (action huddle) and returns the requester's resume; anything else, or
 * a failure, routes it to the scope's orchestrator. Idempotent: an escalation not in o.expect is
 * left alone.
 */
export async function runMicroHuddle(ctx: HookCtx, id: string, o: MicroHuddleOptions = { actor: { kind: "runner" }, expect: ["open"] }): Promise<ProcessOp[]> {
  const { store } = ctx;
  const state = await store.state();
  const esc = own(state.escalations, id);
  if (!esc || !o.expect.includes(esc.status) || !state.contract) return [];
  const diag = await readDiagnostics(store, esc);
  const req = requesterSeat(state, esc);
  const cp = counterpartSeat(state, esc, diag);
  const routeAway = async () => {
    await routeToOrchestrator(ctx, id, { expect: o.expect, source: actorSource(o.actor) });
    return [];
  };
  if (!req || !cp || remainingUsd(state) <= 0) return routeAway();
  const to = await scopeOrchestrator(state, esc, diag);
  const source = actorSource(o.actor);
  const hud = newId("hud");
  const turn0 = escalationText(esc, req, cp);
  const blob0 = await store.putBlob(turn0);
  const started = await commitIf(store, id, { expect: o.expect }, () => [
    ev("huddle.started", { id: hud, escalation: id, format: "micro", seats: [req.seat, cp.seat] }, source, id),
    ev("huddle.turn", { id: hud, seat: req.seat, blob: blob0 }, source, id),
  ]);
  if (!started) return [];
  const open = { expect: ["in_huddle"] as EscalationStatus[], guard: (s: Readonly<BlackboardState>, e: Escalation) => e.huddle === hud && own(s.huddles, hud)?.outcome === undefined };
  const meter = new UsageMeter("huddle", esc.task);
  const turns: AnyEventDraft[] = [];
  const fail = async (why: string): Promise<ProcessOp[]> => {
    console.error(`[Huddle] ${hud} on ${id}: ${why}`);
    await commitIf(store, id, { ...open, always: [...turns, ...meter.take(source, id)] }, () => [
      ev("huddle.concluded", { id: hud, outcome: "NO_OUTCOME", decision: cap(why, 1000) }, source, id),
      ev("escalation.routed", { id, to, wake: true }, source, id),
    ]);
    return [];
  };

  // Turn 1: the counterpart.
  let answer: string;
  try {
    const rec = liveWorkerRecord(ctx, state, cp, o.alive ?? defaultAlive);
    if (rec) {
      const r = await meter.run(() => ctx.driver!.answer!(rec, `${ANSWER_INTRO}\n\n${turn0}`, MICRO_ANSWER_USD));
      meter.add(r.usage);
      answer = r.text;
    } else {
      answer = await askPersona(meter, ctx.llm, cp.persona, COUNTERPART_DIRECTIVE, counterpartPrompt(state, turn0, cp));
    }
  } catch (e) {
    return fail(`${cp.seat} could not answer: ${errText(e)}`);
  }
  turns.push(ev("huddle.turn", { id: hud, seat: cp.seat, blob: await store.putBlob(answer) }, source, id));

  // Turn 2: the requester concludes.
  let conclusion: string;
  try {
    conclusion = await askPersona(meter, ctx.llm, req.persona, REQUESTER_DIRECTIVE, conclusionPrompt(turn0, cp, answer));
  } catch (e) {
    return fail(`${req.seat} could not conclude: ${errText(e)}`);
  }
  turns.push(ev("huddle.turn", { id: hud, seat: req.seat, blob: await store.putBlob(conclusion) }, source, id));
  const parsed = verdictOf(conclusion, "Outcome", MICRO_OUTCOMES);
  const decision = parseField(conclusion, "Decision");
  const outcome: HuddleOutcome = parsed === "AGREED" && !decision ? "NEEDS_ORCHESTRATOR" : parsed === "UNCLEAR" ? "NEEDS_ORCHESTRATOR" : parsed;
  const always = [...turns, ...meter.take(source, id)];

  if (outcome !== "AGREED") {
    await commitIf(store, id, { ...open, always }, () => [
      ev("huddle.concluded", { id: hud, outcome, ...(decision && { decision }) }, source, id),
      ev("escalation.routed", { id, to, wake: true }, source, id),
    ]);
    return [];
  }
  const rationale = `micro-huddle ${hud} between ${req.seat} and ${cp.seat} on escalation ${id}`;
  const decisions: Decision[] = [];
  for (const scope of [req.task ?? req.agent, cp.task ?? cp.agent]) {
    if (scope && !decisions.some((d) => d.scope === scope)) decisions.push({ id: newId("dec"), scope, text: decision!, rationale, by: hud });
  }
  const c = await commitResolution(store, id, {
    action: "huddle", decision: decision!, by: hud, source, decisions, rule: "huddle",
    before: [ev("huddle.concluded", { id: hud, outcome: "AGREED", decision: decision! }, source, id)],
  }, { ...open, always });
  return c.ops;
}

// ============================================================================
// Format huddles (#84)
// ============================================================================

export interface FormatHuddleOptions {
  format: Exclude<HuddleFormat, "micro">;
  /** Personas; default the requester's, the counterpart's and the lead. */
  participants?: string[];
  actor: Actor;
  expect: EscalationStatus[];
}

export interface FormatHuddleResult {
  huddle: string;
  outcome: HuddleOutcome;
  decision?: string;
  /** The lead's optional Action line: retry or dismiss instead of decide. */
  action?: "decide" | "retry" | "dismiss";
  /** The archived session (a collaboration or ultraplan id). */
  session?: string;
  error?: string;
}

const LEAD_DIRECTIVE =
  "\n\n## Huddle conclusion\n" +
  "You are the lead of this heads-down run. Conclude the huddle below for the workers: one decision they can act on, within the contract.";

const HUDDLE_ACTIONS = ["decide", "retry", "dismiss"] as const;

function dedupe(personas: Array<string | undefined>): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const p of personas) {
    const t = p?.trim();
    if (!t || keys.has(agentKey(t))) continue;
    keys.add(agentKey(t));
    out.push(t);
  }
  return out;
}

interface EngineRun {
  session: string;
  turns: Array<{ seat: string; content: string }>;
  error?: string;
}

/** Run the format's engine in-process: public: false, no grounding, the context bundle as context. */
async function runEngine(
  format: FormatHuddleOptions["format"], participants: string[], lead: string, topic: string, context: string, ctx: HookCtx, origin: string
): Promise<EngineRun> {
  const llm = { provider: ctx.llm.provider, model: ctx.llm.model, ...(ctx.llm.baseUrl !== undefined && { baseUrl: ctx.llm.baseUrl }) };
  if (format === "replan" || format === "ultraplan") {
    const agents = participants.filter((p) => agentKey(p) !== agentKey(lead));
    const r = await startUltraplan(agents.length ? agents : [lead], topic, {
      ...llm, context, planner: lead, executionReady: true, revisionRounds: 1, public: false, origin,
    });
    let error = "error" in r && r.error ? r.error : undefined;
    if (r.status !== "finalized" && ultraplans.has(r.ultraplanId)) {
      await endUltraplan(r.ultraplanId);
      error ??= "the re-plan stopped before sign-off";
    }
    const turns = (readArchivedSession(r.ultraplanId)?.turns ?? []).map((t) => ({ seat: t.speaker, content: t.content }));
    return { session: r.ultraplanId, turns, ...(error && { error }) };
  }
  const meeting = format === "meeting";
  const agents = meeting ? participants.slice(0, 2) : participants;
  if (agents.length < 2) throw new Error(`a ${format} huddle needs two participants; got ${agents.length}`);
  const mode: CollaborationMode = meeting ? "collaborate" : format;
  const rounds = meeting ? 1 : HUDDLE_MAX_ROUNDS;
  const started = await startCollaboration(agents, topic, { ...llm, context, mode, maxRounds: rounds, public: false, grounding: false, origin });
  const cid = started.collaborationId;
  try {
    await continueCollaboration(cid, rounds);
    const { transcript } = await endCollaboration(cid, false);
    return { session: cid, turns: transcript.map((m) => ({ seat: agentKey(m.agent), content: m.content })) };
  } finally {
    if (collaborations.has(cid)) await endCollaboration(cid, false).catch(() => undefined);
  }
}

function transcriptText(turns: EngineRun["turns"]): string {
  const text = turns.map((t) => `**${t.seat}:** ${t.content}`).join("\n\n");
  return text.length <= TRANSCRIPT_LIMIT ? text : `…[earlier turns truncated]\n${text.slice(-TRANSCRIPT_LIMIT)}`;
}

/**
 * Run a format huddle: huddle.started, the engine, one huddle.turn per turn, the lead's
 * conclusion (`Decision:`, optional `Action:`), huddle.concluded (DECIDED, or NO_OUTCOME). The
 * caller applies the outcome. Undefined when the escalation could not start one (its status).
 */
export async function runFormatHuddle(ctx: HookCtx, id: string, o: FormatHuddleOptions): Promise<FormatHuddleResult | undefined> {
  const { store } = ctx;
  const state = await store.state();
  const esc = own(state.escalations, id);
  const c = state.contract;
  if (!esc || !c || !o.expect.includes(esc.status)) return undefined;
  const diag = await readDiagnostics(store, esc);
  const lead = c.authority.lead;
  const participants = dedupe(o.participants?.length ? o.participants : [requesterSeat(state, esc)?.persona, counterpartSeat(state, esc, diag)?.persona, lead]);
  const source = actorSource(o.actor);
  const hud = newId("hud");
  const started = await commitIf(store, id, { expect: o.expect }, () => [
    ev("huddle.started", { id: hud, escalation: id, format: o.format, seats: participants.map((p) => agentKey(p)) }, source, id),
  ]);
  if (!started) return undefined;
  const open = { expect: ["in_huddle"] as EscalationStatus[], guard: (s: Readonly<BlackboardState>, e: Escalation) => e.huddle === hud && own(s.huddles, hud)?.outcome === undefined };
  const meter = new UsageMeter("huddle", esc.task);
  const bundle = buildContextBundle(state, esc, { diagnostics: diag });
  const topic = cap(`Escalation ${id} in a heads-down run: ${esc.summary}`, 500);
  const origin = `huddle:${state.execution}:${id}:${hud}`;
  const conclude = async (r: FormatHuddleResult, turns: AnyEventDraft[]): Promise<FormatHuddleResult> => {
    const ok = await commitIf(store, id, { ...open, always: [...turns, ...meter.take(source, id)] }, () => [
      ev("huddle.concluded", { id: hud, outcome: r.outcome, ...(r.decision && { decision: r.decision }) }, source, id),
    ]);
    return ok ? r : { huddle: hud, outcome: "NO_OUTCOME", error: "the huddle was concluded or the escalation resolved meanwhile" };
  };

  if (remainingUsd(state) <= 0) return conclude({ huddle: hud, outcome: "NO_OUTCOME", error: "the execution budget is spent" }, []);
  let run: EngineRun;
  try {
    run = await meter.run(() => runEngine(o.format, participants, lead, topic, bundle, ctx, origin));
  } catch (e) {
    return conclude({ huddle: hud, outcome: "NO_OUTCOME", error: `the ${o.format} failed: ${errText(e)}` }, []);
  }
  const turns: AnyEventDraft[] = [];
  for (const t of run.turns.slice(-MAX_TURN_EVENTS)) turns.push(ev("huddle.turn", { id: hud, seat: t.seat || "agent", blob: await store.putBlob(t.content) }, source, id));
  if (run.error) return conclude({ huddle: hud, outcome: "NO_OUTCOME", session: run.session, error: run.error }, turns);

  const replan = o.format === "replan" || o.format === "ultraplan";
  const prompt = `${bundle}\n\n## The ${o.format} (session ${run.session})\n\n${transcriptText(run.turns)}\n\n` +
    (replan ? "The re-plan's last version amends the contract. State the decision it embodies for the workers.\n\n" : "") +
    "Reply with exactly:\nDecision: <the decision the requester and the others follow, in a few sentences>\n" +
    (replan ? "" : "Action: decide | retry | dismiss   (optional; decide unless the task should start over, or the escalation needs no answer)\n");
  let answer: string;
  try {
    answer = await askPersona(meter, ctx.llm, lead, LEAD_DIRECTIVE, prompt);
  } catch (e) {
    return conclude({ huddle: hud, outcome: "NO_OUTCOME", session: run.session, error: `the lead could not conclude: ${errText(e)}` }, turns);
  }
  turns.push(ev("huddle.turn", { id: hud, seat: agentKey(lead), blob: await store.putBlob(`Session: ${run.session}\n\n${answer}`) }, source, id));
  const decision = parseField(answer, "Decision");
  const action = replan ? "decide" : verdictOf(answer, "Action", HUDDLE_ACTIONS);
  if (!decision) return conclude({ huddle: hud, outcome: "NO_OUTCOME", session: run.session, error: "the lead's conclusion had no Decision line" }, turns);
  return conclude({ huddle: hud, outcome: "DECIDED", decision, action: action === "UNCLEAR" ? "decide" : action, session: run.session }, turns);
}
