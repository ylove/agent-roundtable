// ============================================================================
// Watchdog actions: the union evaluate() returns, and the helpers the rule modules share
//
// An action is either "emit" (event drafts only) or a process operation the runner performs
// (kill, resume, spawn, stop spawning, lead fallback, wake). Every action names the rule that
// produced it and a deterministic key: the same situation always yields the same key, so the
// runner can dedupe and the log can correlate. Escalation ids are derived from their key, which
// is how a rule knows it has already escalated (the escalation is on the blackboard).
// ============================================================================

import { createHash } from "node:crypto";
import type {
  AnyEventDraft,
  BlackboardState,
  EmergencyClass,
  Escalation,
  EscalationDiagnostics,
  EscalationKind,
  EscalationWith,
  EventDraft,
  EventPayloads,
  EventSource,
  EventType,
  TaskState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Action union
// ---------------------------------------------------------------------------

export type WatchdogRule =
  | "dissent_tripwire"
  | "claim_expiry"
  | "lease_orphan"
  | "lease_withdraw"
  | "lease_grant"
  | "worker_dead"
  | "worker_stall"
  | "blocked_worker"
  | "dependency_wait"
  | "repeated_failure"
  | "diff_ping_pong"
  | "note_ping_pong"
  | "huddle_timeout"
  | "lead_fallback"
  | "budget_threshold"
  | "budget_exhausted"
  | "budget_cap"
  | "circuit"
  | "circuit_emergency"
  | "deadlock";

interface ActionBase {
  rule: WatchdogRule;
  /** Deterministic correlation key (an escalation id for escalating actions). */
  key: string;
  /** What the action acts on: a task, agent, escalation, orchestrator, driver or "execution". */
  target: string;
  /**
   * A process operation re-asserted on every pass while its condition holds (stop spawning, kill a
   * worker that must not run), so a crash between the commit and the operation loses nothing. Its
   * first occurrence was audited; a standing repeat is not, and it carries no events.
   */
  standing?: true;
}

export type WatchdogAction =
  /** Append these drafts. diagnostics, when present, belongs in a blob named by the escalation.raised draft. */
  | (ActionBase & { type: "emit"; events: AnyEventDraft[]; diagnostics?: EscalationDiagnostics })
  /** SIGTERM, then SIGKILL, the worker's process group. */
  | (ActionBase & { type: "kill_worker"; agent: string; reason: string })
  /** Resume the same session (--resume) for the same attempt, with `why` in the card. */
  | (ActionBase & { type: "resume_worker"; agent: string; task: string; why: string })
  /** Claim and spawn `attempt` for the task (the task.retried for it is in the same batch). */
  | (ActionBase & { type: "spawn_retry"; task: string; attempt: number })
  /** Spawn no new workers until the budget is extended. */
  | (ActionBase & { type: "stop_spawning"; reason: string })
  /** Run the lead's one persona call (Action: / Decision:) for this escalation. */
  | (ActionBase & { type: "lead_fallback"; escalation: string })
  /** Wake the orchestrator's watcher. */
  | (ActionBase & { type: "wake_orchestrator"; orchestrator: string; reason: string });

export type WatchdogActionType = WatchdogAction["type"];
export type ProcessAction = Exclude<WatchdogAction, { type: "emit" }>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The runner replaces pid (actionsToDrafts) with its own. */
export const WATCHDOG_SOURCE: Readonly<EventSource> = Object.freeze({ kind: "watchdog", id: "watchdog", pid: 0 });

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["accepted", "failed", "cancelled"]);

/** Own-property read: ids such as "constructor" must never reach Object.prototype. */
export function own<V>(map: Readonly<Record<string, V>> | undefined, key: string | undefined): V | undefined {
  return map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Own-property write that is safe for any key, "__proto__" included. */
export function putOwn<V>(map: Record<string, V>, key: string, value: V): V {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}

export function sortedKeys(map: Readonly<Record<string, unknown>> | undefined): string[] {
  return map ? Object.keys(map).sort() : [];
}

export function draft<T extends EventType>(type: T, payload: EventPayloads[T], correlation?: string): AnyEventDraft {
  const d: EventDraft<T> = { type, payload, source: { ...WATCHDOG_SOURCE } };
  if (correlation !== undefined) d.correlation = correlation;
  return d as unknown as AnyEventDraft;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Deterministic escalation id for a dedupe key: the same key always names the same escalation. */
export function escalationId(key: string): string {
  return `esc-wd${shortHash(key)}`;
}

export function emitAction(rule: WatchdogRule, key: string, target: string, events: AnyEventDraft[]): WatchdogAction {
  return { type: "emit", rule, key, target, events };
}

export interface EscalationSpec {
  dissent_id?: string;
  /** Dedupe key; the escalation id is escalationId(key). */
  key: string;
  task?: string;
  /** The raising seat; "watchdog" unless the escalation is raised on an agent's behalf. */
  agent?: string;
  kind: EscalationKind;
  with: EscalationWith;
  target?: string;
  summary: string;
  question?: string;
  options?: string[];
  /** The escalation blocks its task: blocking is set and task.blocked {task, escalation} emitted
   *  (neither for a finished task; no task.blocked for one already blocked, whose reason stands). */
  block?: boolean;
  /** Also emit escalation.awaiting_human. */
  emergency?: { class: EmergencyClass; message: string; alternatives?: string[] };
  diagnostics?: EscalationDiagnostics;
  /** Drafts emitted ahead of escalation.raised in the same action (they share its dedupe). */
  before?: AnyEventDraft[];
}

/** An emit action raising the escalation, or undefined when the blackboard already has it. */
export function escalationAction(state: BlackboardState, rule: WatchdogRule, spec: EscalationSpec): WatchdogAction | undefined {
  const id = escalationId(spec.key);
  if (Object.hasOwn(state.escalations, id)) return undefined;
  const rt = own(state.tasks, spec.task);
  const block = spec.block === true && spec.task !== undefined && rt !== undefined && !TERMINAL_TASK_STATES.has(rt.state);
  const esc: Escalation = {
    id,
    agent: spec.agent ?? "watchdog",
    kind: spec.kind,
    with: spec.with,
    summary: spec.summary,
    blocking: block,
    status: "open",
    raised_seq: 0,
  };
  if (spec.dissent_id !== undefined) esc.dissent_id = spec.dissent_id;
  if (spec.task !== undefined) esc.task = spec.task;
  if (spec.target !== undefined) esc.target = spec.target;
  if (spec.question !== undefined) esc.question = spec.question;
  if (spec.options !== undefined) esc.options = [...spec.options];
  if (spec.emergency) esc.emergency = spec.emergency.class;

  const before = (spec.before ?? []).map((d) => (d.correlation === undefined ? { ...d, correlation: id } : d));
  const events = [...before, draft("escalation.raised", { escalation: esc }, id)];
  if (block && (rt!.state !== "blocked" || spec.dissent_id !== undefined)) events.push(draft("task.blocked", { task: spec.task!, escalation: id }, id));
  if (spec.emergency) {
    const p: EventPayloads["escalation.awaiting_human"] = { id, class: spec.emergency.class, message: spec.emergency.message };
    if (spec.emergency.alternatives?.length) p.alternatives = [...spec.emergency.alternatives];
    events.push(draft("escalation.awaiting_human", p, id));
  }
  const action: WatchdogAction = { type: "emit", rule, key: id, target: spec.task ?? id, events };
  if (spec.diagnostics) action.diagnostics = { ...spec.diagnostics };
  return action;
}

/** Process operations only (what the runner performs after the drafts are committed). */
export function processActions(actions: readonly WatchdogAction[]): ProcessAction[] {
  return actions.filter((a): a is ProcessAction => a.type !== "emit");
}

// ---------------------------------------------------------------------------
// Drafts for the runner's transact
// ---------------------------------------------------------------------------

export interface DraftOptions {
  /** Stamped into every draft's source.pid (default 0). */
  pid?: number;
  /** Blob refs for emit actions' diagnostics, by action key; set as the escalation's diagnostics_blob. */
  diagnosticsBlobs?: Readonly<Record<string, string>>;
  /** Append a watchdog.action draft per action (default true). */
  audit?: boolean;
}

function actionName(a: WatchdogAction): string {
  return a.type === "emit" ? [...new Set(a.events.map((e) => e.type))].join(",") : a.type;
}

/**
 * The event drafts for a batch of actions, in order: each emit action's events, then (with audit)
 * one watchdog.action {rule, action, target} per action that is not standing, process operations
 * included. Drafts are copies; the actions are not modified.
 */
export function actionsToDrafts(actions: readonly WatchdogAction[], opts: DraftOptions = {}): AnyEventDraft[] {
  const pid = opts.pid ?? 0;
  const out: AnyEventDraft[] = [];
  const stamp = (d: AnyEventDraft): AnyEventDraft => {
    const copy = structuredClone(d);
    copy.source = { ...copy.source, pid };
    return copy;
  };
  for (const a of actions) {
    if (a.type === "emit") {
      const blob = own(opts.diagnosticsBlobs, a.key);
      for (const e of a.events) {
        const d = stamp(e);
        if (blob !== undefined && d.type === "escalation.raised") d.payload.escalation.diagnostics_blob = blob;
        out.push(d);
      }
    }
    if (opts.audit !== false && !a.standing) {
      out.push(stamp(draft("watchdog.action", { rule: a.rule, action: actionName(a), target: a.target }, a.key)));
    }
  }
  return out;
}
