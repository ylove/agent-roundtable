// ============================================================================
// Postmortem state: the reducer's postmortem section (docs/design/postmortem.md §4)
//
// Findings arrive as postmortem.finding_recorded events. Their fix status follows the run: a retry
// or reassignment of the finding's task sets who fixes it, the task's next merge marks it fixed,
// a failed or cancelled task abandons it, and an integration check that passes again fixes the
// finding it failed. A draft is ready for its meeting when no fix is pending and every task with a
// finding is terminal; ready_seq records the event that made it so (the watcher wakes on it).
// blackboard.ts spreads the handlers into its table and calls postmortemAfter after every event.
// ============================================================================

import type { AnyEvent, BlackboardState, EventEnvelope, PostmortemFindingState, TaskState } from "./types.js";

type PostmortemState = NonNullable<BlackboardState["postmortem"]>;

const TERMINAL: ReadonlySet<TaskState> = new Set(["accepted", "failed", "cancelled"]);
const EVIDENCE_LIMIT = 20;

const own = <V>(map: Record<string, V>, key: string | undefined): V | undefined =>
  key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

/** Own-property write that is safe for any key, "__proto__" included. */
function put<V>(map: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

function section(s: BlackboardState): PostmortemState {
  return (s.postmortem ??= { findings: {}, meetings: {} });
}

/** The findings no meeting has covered yet: the open draft, in the order they were recorded. */
export function draftFindings(s: Readonly<BlackboardState>): PostmortemFindingState[] {
  return Object.values(s.postmortem?.findings ?? {}).filter((f) => f.pm === undefined);
}

/** What keeps the open draft from its meeting: pending fixes, and tasks with a finding that are still live. */
export function postmortemBlockers(s: Readonly<BlackboardState>): { findings: number; pending: string[]; tasks: string[] } {
  const open = draftFindings(s);
  const pending = open.filter((f) => f.fix.status === "pending").map((f) => f.id);
  const tasks = [...new Set(open.flatMap((f) => (f.task !== undefined && own(s.tasks, f.task) !== undefined && !TERMINAL.has(s.tasks[f.task].state) ? [f.task] : [])))];
  return { findings: open.length, pending, tasks };
}

export function postmortemReady(s: Readonly<BlackboardState>): boolean {
  const b = postmortemBlockers(s);
  return b.findings > 0 && b.pending.length === 0 && b.tasks.length === 0;
}

type PostmortemType = Extract<AnyEvent["type"], `postmortem.${string}`>;
type PostmortemHandlers = { readonly [T in PostmortemType]: (s: BlackboardState, e: EventEnvelope<T>) => void };

export const POSTMORTEM_HANDLERS: PostmortemHandlers = {
  /** A new finding, or (same id) a repeat of one: the count and the new evidence are added to it. */
  "postmortem.finding_recorded": (s, { ts, payload: p }) => {
    const st = section(s);
    const f = own(st.findings, p.id);
    if (f) {
      if (p.repeats !== undefined) f.repeats = Math.max(f.repeats ?? 0, p.repeats);
      for (const ref of p.evidence ?? []) {
        if (!(f.evidence ?? []).includes(ref) && (f.evidence?.length ?? 0) < EVIDENCE_LIMIT) (f.evidence ??= []).push(ref);
      }
      return;
    }
    put(st.findings, p.id, {
      id: p.id,
      at: ts,
      summary: p.summary,
      detected_by: p.detected_by,
      responsible: [...p.responsible],
      ...(p.task !== undefined && { task: p.task }),
      category: p.category,
      ...(p.evidence?.length && { evidence: p.evidence.slice(0, EVIDENCE_LIMIT) }),
      ...(p.repeats !== undefined && { repeats: p.repeats }),
      fix: { status: "pending" },
    });
  },
  "postmortem.fix_updated": (s, { payload: p }) => {
    const f = own(section(s).findings, p.id);
    if (!f) return;
    const by = p.by ?? f.fix.by;
    const ref = p.ref ?? (p.status === "pending" ? undefined : f.fix.ref);
    f.fix = { ...(by !== undefined && { by }), status: p.status, ...(ref !== undefined && { ref }) };
  },
  /** The meeting covers every finding recorded so far; later ones start the next draft. */
  "postmortem.started": (s, { payload: p }) => {
    const st = section(s);
    put(st.meetings, p.id, { format: p.format, seats: [...p.seats] });
    for (const f of Object.values(st.findings)) if (f.pm === undefined) f.pm = p.id;
  },
  "postmortem.concluded": (s, { payload: p }) => {
    const m = own(section(s).meetings, p.id);
    if (m) m.concluded = { artifacts: { ...p.artifacts }, flagged: p.flagged, record: p.record };
  },
};

/** Settle open fixes from the task and check events, then note when the draft became ready (or stopped being). */
export function postmortemAfter(s: BlackboardState, e: AnyEvent): void {
  const st = s.postmortem;
  if (!st) return;
  const open = Object.values(st.findings).filter((f) => f.pm === undefined && f.fix.status === "pending");
  const settle = (f: PostmortemFindingState, status: "fixed" | "abandoned", ref?: string) => {
    f.fix = { ...(f.fix.by !== undefined && { by: f.fix.by }), status, ...(ref !== undefined && { ref }) };
  };
  switch (e.type) {
    case "task.retried":
      for (const f of open) if (f.task === e.payload.task) f.fix = { by: s.tasks[e.payload.task]?.spec.persona ?? f.fix.by ?? "unknown", status: "pending" };
      break;
    case "task.reassigned":
      for (const f of open) if (f.task === e.payload.task) f.fix = { by: e.payload.to, status: "pending" };
      break;
    case "task.merged":
      for (const f of open) if (f.task === e.payload.task) settle(f, "fixed", e.payload.integration_sha);
      break;
    case "task.failed":
    case "task.cancelled":
      for (const f of open) if (f.task === e.payload.task) settle(f, "abandoned");
      break;
    case "check.passed":
      if (e.payload.scope === "integration") for (const f of open) if (f.detected_by === `integration check ${e.payload.command_id}`) settle(f, "fixed", e.id);
      break;
  }
  const ready = postmortemReady(s);
  if (ready && st.ready_seq === undefined) st.ready_seq = e.seq;
  else if (!ready && st.ready_seq !== undefined) delete st.ready_seq;
}
