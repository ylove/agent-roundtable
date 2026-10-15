// ============================================================================
// Blackboard: the pure reducer that projects the event log into shared state
//
// apply(state, event, resolved) is deterministic, so every process that replays the same log
// derives the same state. The one input not carried by the event itself is the full contract
// behind contract.frozen and contract.amended: the event names it by blob ref, and the store
// fetches that blob (hash-verified) and passes it in as `resolved.contract`. apply never reads
// the disk.
//
// Rules:
//  - Unknown event types throw.
//  - An event naming a task, agent, lease or escalation the state does not know changes nothing
//    for that part: the log is never rejected after the fact.
//  - The reducer never stores undefined, so a state equals its own JSON round trip (snapshots).
//  - Stored objects are copies; callers may keep and mutate the events they passed in.
// ============================================================================

import {
  CONTRACT_SCHEMA,
  GENESIS_HASH,
  type AgentRecord,
  type AnyEvent,
  type BlackboardState,
  type CheckState,
  type Contract,
  type EventEnvelope,
  type EventType,
  type TaskRuntime,
  type TaskSpec,
  type TaskState,
} from "./types.js";

/** Bump whenever apply's output for an existing log changes; snapshots of other versions are ignored. */
export const REDUCER_VERSION = 1;

/** Inputs apply cannot read from the event: the contract named by a contract.frozen/amended blob. */
export interface Resolved {
  contract?: Contract;
}

export function initialState(executionId: string): BlackboardState {
  return {
    execution: executionId,
    seq: 0,
    hash: GENESIS_HASH,
    status: "created",
    paused_tasks: [],
    interfaces: {},
    decisions: [],
    tasks: {},
    claims: {},
    leases: {},
    lease_queue: [],
    files: {},
    diffs: {},
    checks: { task: {}, integration: {} },
    escalations: {},
    huddles: {},
    agents: {},
    teams: {},
    budget: { spent_usd: 0, estimated: false, by_agent: {}, by_task: {}, by_team: {}, thresholds_crossed: [], extensions_usd: 0 },
    notes: [],
    inbox: {},
    watchdog: { circuits: {}, deadlocks: [] },
  };
}

/** The blob ref the store must resolve before applying this event, if any. */
export function contractBlobRef(event: AnyEvent): string | undefined {
  return event.type === "contract.frozen" || event.type === "contract.amended" ? event.payload.blob : undefined;
}

/** The resolved contract for a contract.frozen/amended event; throws if it is missing or does not match. */
export function assertResolved(event: AnyEvent, resolved: Resolved): Contract {
  if (event.type !== "contract.frozen" && event.type !== "contract.amended") {
    throw new Error(`${event.type} carries no contract`);
  }
  const c = resolved.contract as Partial<Contract> | undefined;
  const where = `${event.type} (seq ${event.seq}, ${event.payload.contract} v${event.payload.version})`;
  if (!c || typeof c !== "object") throw new Error(`${where}: the contract from payload.blob was not resolved`);
  if (c.schema !== CONTRACT_SCHEMA) throw new Error(`${where}: the blob is not a ${CONTRACT_SCHEMA} contract`);
  if (c.id !== event.payload.contract || c.version !== event.payload.version) {
    throw new Error(`${where}: the blob holds ${c.id} v${c.version}`);
  }
  if (!c.goal || typeof c.goal !== "object" || !Array.isArray(c.tasks)) throw new Error(`${where}: the blob has no goal or tasks`);
  for (const t of c.tasks) {
    if (!t || typeof t.id !== "string" || !Array.isArray(t.depends_on)) throw new Error(`${where}: a task has no id or depends_on`);
  }
  return c as Contract;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);

/** Own-property read: ids such as "constructor" must never reach Object.prototype. */
function own<V>(map: Record<string, V>, key: string | undefined): V | undefined {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Own-property write that is safe for any key, "__proto__" included. */
function put<V>(map: Record<string, V>, key: string, value: V): V {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

function addUsd(map: Record<string, number>, key: string, usd: number): void {
  put(map, key, (own(map, key) ?? 0) + usd);
}

const TERMINAL: ReadonlySet<TaskState> = new Set(["accepted", "failed", "cancelled"]);

function depsAccepted(s: BlackboardState, spec: TaskSpec): boolean {
  return spec.depends_on.every((d) => own(s.tasks, d)?.state === "accepted");
}

/** pending → ready once every dependency is accepted; with demote, unclaimed ready → pending when one is not. */
function refreshReadiness(s: BlackboardState, demote = false): void {
  for (const rt of Object.values(s.tasks)) {
    if (rt.state === "pending" && depsAccepted(s, rt.spec)) rt.state = "ready";
    else if (demote && rt.state === "ready" && !depsAccepted(s, rt.spec)) rt.state = "pending";
  }
}

function dropClaim(s: BlackboardState, task: string): void {
  if (Object.hasOwn(s.claims, task)) delete s.claims[task];
}

function finish(s: BlackboardState, id: string, rt: TaskRuntime, state: TaskState, ts: string, note?: string): void {
  rt.state = state;
  rt.finished_at = ts;
  if (note !== undefined) rt.last_note = note;
  delete rt.blocked_by;
  dropClaim(s, id);
}

function accept(s: BlackboardState, id: string, e: AnyEvent): void {
  const rt = own(s.tasks, id);
  if (!rt || rt.state === "accepted") return;
  rt.accepted_seq = e.seq;
  finish(s, id, rt, "accepted", e.ts);
  refreshReadiness(s);
}

function markMerged(s: BlackboardState, task: string): void {
  for (const f of Object.values(s.files)) if (f.task === task) f.merged = true;
}

function addMember(s: BlackboardState, team: string, agent: string): void {
  const t = own(s.teams, team) ?? put(s.teams, team, { members: [] });
  if (!t.members.includes(agent)) t.members.push(agent);
}

/** Install a contract version: goal, teams, interfaces, decisions and tasks (new tasks start pending or ready). */
function adoptContract(s: BlackboardState, c: Contract): void {
  s.contract = c;
  s.goal = clone(c.goal);
  for (const t of c.teams ?? []) {
    for (const m of t.members ?? []) addMember(s, t.id, m);
    if (!own(s.teams, t.id)) put(s.teams, t.id, { members: [] });
    if (t.lead !== undefined) own(s.teams, t.id)!.lead = t.lead;
  }
  for (const i of c.interfaces ?? []) {
    const cur = own(s.interfaces, i.name);
    put(s.interfaces, i.name, { ...cur, spec: clone(i), version: cur?.version ?? 0 });
  }
  for (const d of c.decisions ?? []) if (!s.decisions.some((x) => x.id === d.id)) s.decisions.push(clone(d));
  for (const spec of c.tasks) {
    const rt = own(s.tasks, spec.id);
    if (rt) rt.spec = clone(spec);
    else put(s.tasks, spec.id, { spec: clone(spec), state: "pending", attempt: 0 });
  }
  refreshReadiness(s, true);
}

/** Key of a check in BlackboardState.checks[scope]: "<task>/<command_id>" for task checks, else the command id. */
export function checkKey(scope: "task" | "integration", commandId: string, task?: string): string {
  return scope === "task" && task ? `${task}/${commandId}` : commandId;
}

function deliver(s: BlackboardState, agent: string, item: BlackboardState["inbox"][string][number]): void {
  (own(s.inbox, agent) ?? put(s.inbox, agent, [])).push(item);
}

/** Agent ids, with team ids expanded to their members; first occurrence order, no duplicates. */
function expandTargets(s: BlackboardState, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) for (const a of own(s.teams, id)?.members ?? [id]) if (!out.includes(a)) out.push(a);
  return out;
}

/** Who a decision reaches: "contract" → every registered agent; a team → its members; a task → its agent; an agent. */
function decisionTargets(s: BlackboardState, scope: string): string[] {
  if (scope === "contract") return Object.keys(s.agents);
  const team = own(s.teams, scope);
  if (team) return [...team.members];
  const rt = own(s.tasks, scope);
  if (rt) return rt.agent ? [rt.agent] : [];
  return own(s.agents, scope) ? [scope] : [];
}

// ---------------------------------------------------------------------------
// Handlers: one per event type (the mapped type makes a missing one a compile error)
// ---------------------------------------------------------------------------

type Handler<T extends EventType> = (s: BlackboardState, e: EventEnvelope<T>, r: Resolved) => void;
type Handlers = { readonly [T in EventType]: Handler<T> };

/** Recorded in the log (seq and hash advance) with no other effect on the blackboard. */
const none = () => {};

const HANDLERS: Handlers = {
  // --- execution: status and paused tasks ---------------------------------
  "execution.created": (s) => {
    s.status = "created";
  },
  "execution.started": (s) => {
    s.status = "running";
  },
  /** "all" pauses the run; a task list is added to paused_tasks (task states are left as they are). */
  "execution.paused": (s, { payload: p }) => {
    if (p.scope === "all") s.status = "paused";
    else for (const t of p.scope) if (!s.paused_tasks.includes(t)) s.paused_tasks.push(t);
  },
  /** "all" resumes the run and clears paused_tasks; a task list is removed from it. */
  "execution.resumed": (s, { payload: p }) => {
    if (p.scope === "all") {
      s.paused_tasks = [];
      if (s.status === "paused") s.status = "running";
    } else {
      const drop = new Set(p.scope);
      s.paused_tasks = s.paused_tasks.filter((t) => !drop.has(t));
    }
  },
  "execution.steered": none, // the directive.issued that accompanies a steer fills the inboxes
  "execution.mode_changed": none,
  "execution.completed": (s) => {
    s.status = "completed";
  },
  "execution.failed": (s) => {
    s.status = "failed";
  },
  "execution.aborted": (s) => {
    s.status = "aborted";
  },

  // --- contract ------------------------------------------------------------
  "contract.proposed": none, // contract holds the frozen version only
  "contract.consent_requested": none,
  "contract.consent_recorded": none,
  "contract.objection_resolved": none,
  /** Sets contract (stamped frozen with by and hash) and goal; creates or updates tasks. */
  "contract.frozen": (s, e, r) => {
    const c = clone(assertResolved(e, r));
    adoptContract(s, { ...c, status: "frozen", frozen: { by: e.payload.by, at: c.frozen?.at ?? e.ts, hash: e.payload.hash } });
  },
  /** Sets contract and goal to the new version. New tasks are added; existing tasks get the new spec
   *  and keep their runtime state; tasks missing from the new version are left for the amending
   *  tool to cancel explicitly. */
  "contract.amended": (s, e, r) => {
    adoptContract(s, clone(assertResolved(e, r)));
  },
  "contract.superseded": (s, { payload: p }) => {
    if (s.contract?.id === p.contract) s.contract.status = "superseded";
  },

  // --- runner (heartbeats are files, not events) ---------------------------
  "runner.started": none,
  "runner.takeover": none,
  "runner.stopped": none,

  // --- agents and teams ----------------------------------------------------
  /** Adds or refreshes the agent (a resume rotates its token) and its team membership. */
  "agent.registered": (s, { payload: p }) => {
    const rec: AgentRecord = {
      ...own(s.agents, p.agent),
      id: p.agent,
      persona: p.persona,
      driver: p.driver,
      external: p.external,
      token_sha256: p.token_sha256,
      status: "registered",
    };
    if (p.team !== undefined) rec.team = p.team;
    put(s.agents, p.agent, rec);
    if (p.team !== undefined) addMember(s, p.team, p.agent);
  },
  "agent.spawned": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.task = p.task;
    rec.pid = p.pid;
    if (p.session_id !== undefined) rec.session_id = p.session_id;
    rec.status = "running";
  },
  "agent.attested": none,
  "agent.exited": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.status = "exited";
    delete rec.pid;
  },
  "agent.left": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.status = "left";
    delete rec.pid;
  },

  // --- tasks and claims ----------------------------------------------------
  "task.ready": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (rt && !TERMINAL.has(rt.state)) rt.state = "ready";
  },
  /** state claimed; the claim records agent, attempt, ttl and the granting seq. */
  "task.claimed": (s, e) => {
    const p = e.payload;
    const rt = own(s.tasks, p.task);
    if (!rt || TERMINAL.has(rt.state)) return;
    rt.state = "claimed";
    rt.agent = p.agent;
    rt.attempt = p.attempt;
    rt.started_at ??= e.ts;
    put(s.claims, p.task, { task: p.task, agent: p.agent, attempt: p.attempt, ttl_s: p.ttl_s, granted_seq: e.seq });
  },
  /** Claim dropped; a claimed task returns to ready (its WIP stays in the worktree). */
  "task.released": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    const claimed = Object.hasOwn(s.claims, p.task);
    dropClaim(s, p.task);
    if (!rt || !claimed || TERMINAL.has(rt.state)) return;
    rt.state = "ready";
    delete rt.agent;
    if (p.note !== undefined) rt.last_note = p.note;
  },
  /** percent and last_note; a claimed task moves to in_progress. */
  "task.progress": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt) return;
    if (p.percent !== undefined) rt.percent = p.percent;
    rt.last_note = p.note;
    if (rt.state === "claimed") rt.state = "in_progress";
  },
  /** state submitted; diffs and files updated; the task's check streaks reset (a new patch). */
  "task.submitted": (s, e) => {
    const p = e.payload;
    const rt = own(s.tasks, p.task);
    if (!rt) return;
    rt.state = "submitted";
    rt.last_commit = p.commit;
    rt.submitted_seq = e.seq;
    put(s.diffs, p.task, { stat: p.stat, blob: p.diff_blob, commit: p.commit });
    const agent = rt.agent ?? e.source.id;
    for (const f of p.files) put(s.files, f, { task: p.task, agent, last_commit: p.commit, merged: false });
    const prefix = `${p.task}/`;
    for (const [key, c] of Object.entries(s.checks.task)) {
      if (key.startsWith(prefix)) {
        c.streak = 0;
        c.since_patch_seq = e.seq;
      }
    }
  },
  "task.checks_passed": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (rt && !TERMINAL.has(rt.state)) rt.state = "merging";
  },
  /** Back to in_progress while claimed (the worker is resumed with the reasons), else ready. */
  "task.rejected": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt || TERMINAL.has(rt.state)) return;
    rt.state = own(s.claims, p.task) ? "in_progress" : "ready";
    rt.last_note = p.reasons.join("; ");
  },
  /** Accepted (claim dropped, files merged); integration streaks reset; dependents whose deps are all accepted become ready. */
  "task.merged": (s, e) => {
    markMerged(s, e.payload.task);
    for (const c of Object.values(s.checks.integration)) {
      c.streak = 0;
      c.since_patch_seq = e.seq;
    }
    accept(s, e.payload.task, e);
  },
  /** Accepted without a merge (for example a review task); dependents as for task.merged. */
  "task.accepted": (s, e) => {
    accept(s, e.payload.task, e);
  },
  "task.blocked": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt || TERMINAL.has(rt.state)) return;
    rt.state = "blocked";
    const by: NonNullable<TaskRuntime["blocked_by"]> = {};
    if (p.escalation !== undefined) by.escalation = p.escalation;
    if (p.deps !== undefined) by.deps = [...p.deps];
    rt.blocked_by = by;
  },
  /** in_progress while claimed, else ready or pending by its dependencies. */
  "task.unblocked": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt || rt.state !== "blocked") return;
    delete rt.blocked_by;
    rt.state = own(s.claims, p.task) ? "in_progress" : depsAccepted(s, rt.spec) ? "ready" : "pending";
  },
  /** New attempt: ready again (also from failed), claim dropped. */
  "task.retried": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt || rt.state === "accepted" || rt.state === "cancelled") return;
    rt.state = "ready";
    rt.attempt = p.attempt;
    rt.last_note = p.why;
    delete rt.agent;
    delete rt.finished_at;
    delete rt.blocked_by;
    dropClaim(s, p.task);
  },
  "task.reassigned": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt) return;
    rt.agent = p.to;
    const claim = own(s.claims, p.task);
    if (claim) claim.agent = p.to;
  },
  /** The parts become tasks; dependents of the split task now depend on the parts; the split task is cancelled. */
  "task.split": (s, e) => {
    const p = e.payload;
    const rt = own(s.tasks, p.task);
    if (!rt) return;
    const ids = p.into.map((t) => t.id);
    for (const spec of p.into) if (!own(s.tasks, spec.id)) put(s.tasks, spec.id, { spec: clone(spec), state: "pending", attempt: 0 });
    for (const other of Object.values(s.tasks)) {
      const deps = other.spec.depends_on;
      if (!deps.includes(p.task)) continue;
      other.spec.depends_on = [...new Set(deps.flatMap((d) => (d === p.task ? ids : [d])))];
    }
    finish(s, p.task, rt, "cancelled", e.ts, `split into ${ids.join(", ")}`);
    refreshReadiness(s);
  },
  "task.failed": (s, e) => {
    const rt = own(s.tasks, e.payload.task);
    if (rt) finish(s, e.payload.task, rt, "failed", e.ts, e.payload.why);
  },
  "task.cancelled": (s, e) => {
    const rt = own(s.tasks, e.payload.task);
    if (rt) finish(s, e.payload.task, rt, "cancelled", e.ts, e.payload.why);
  },

  // --- leases --------------------------------------------------------------
  /** Lease stored with granted_seq = this seq; a queued request with the same id leaves the queue. */
  "lease.granted": (s, e) => {
    const lease = { ...clone(e.payload.lease), granted_seq: e.seq };
    put(s.leases, lease.id, lease);
    s.lease_queue = s.lease_queue.filter((r) => r.id !== lease.id);
  },
  /** Request queued (or replaced, by id) with requested_seq = this seq. */
  "lease.queued": (s, e) => {
    const req = { ...clone(e.payload.request), requested_seq: e.seq };
    const i = s.lease_queue.findIndex((r) => r.id === req.id);
    if (i >= 0) s.lease_queue[i] = req;
    else s.lease_queue.push(req);
  },
  "lease.released": (s, { payload: p }) => endLease(s, p.lease_id),
  "lease.expired": (s, { payload: p }) => endLease(s, p.lease_id),
  "lease.revoked": (s, { payload: p }) => endLease(s, p.lease_id),
  "lease.violation": none,

  // --- interfaces and artifacts --------------------------------------------
  /** Version bumped (0 → 1 on first publish); path, blob and publishing task recorded. */
  "artifact.published": (s, { payload: p }) => {
    const cur = own(s.interfaces, p.name);
    const next: BlackboardState["interfaces"][string] = { ...cur, version: (cur?.version ?? 0) + 1, task: p.task };
    if (p.path !== undefined) next.path = p.path;
    if (p.blob !== undefined) next.blob = p.blob;
    put(s.interfaces, p.name, next);
  },
  "artifact.changed": (s, { payload: p }) => {
    put(s.interfaces, p.name, { ...own(s.interfaces, p.name), version: p.version });
  },

  // --- dependencies (the watchdog's task.blocked / task.unblocked carry the effect) ---
  "dependency.requested": none,
  "dependency.satisfied": none,

  // --- checks: [scope][checkKey] -------------------------------------------
  /** status running; a submitted task moves to checking. */
  "check.started": (s, e) => {
    const p = e.payload;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    put(s.checks[p.scope], key, { streak: 0, since_patch_seq: 0, ...cur, status: "running", at_seq: e.seq });
    const rt = p.scope === "task" ? own(s.tasks, p.task) : undefined;
    if (rt?.state === "submitted") rt.state = "checking";
  },
  /** status passed; the failure streak resets to 0. */
  "check.passed": (s, e) => {
    const p = e.payload;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    put(s.checks[p.scope], key, { status: "passed", streak: 0, since_patch_seq: cur?.since_patch_seq ?? 0, at_seq: e.seq });
  },
  /** status failed; streak + 1 when the signature is unchanged, else 1. */
  "check.failed": (s, e) => {
    const p = e.payload;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    const next: CheckState = {
      status: "failed",
      signature: p.signature,
      streak: cur?.signature === p.signature ? cur.streak + 1 : 1,
      since_patch_seq: cur?.since_patch_seq ?? 0,
      at_seq: e.seq,
    };
    if (p.output_blob !== undefined) next.blob = p.output_blob;
    put(s.checks[p.scope], key, next);
  },
  /** status timed_out; the streak is kept. */
  "check.timed_out": (s, e) => {
    const p = e.payload;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    put(s.checks[p.scope], key, { streak: 0, since_patch_seq: 0, ...cur, status: "timed_out", at_seq: e.seq });
  },
  "command.completed": none,

  // --- merges ----------------------------------------------------------------
  "merge.succeeded": (s, { payload: p }) => markMerged(s, p.task),
  "merge.conflicted": none, // the runner follows with a resume or an escalation

  // --- notes, decisions, directives ------------------------------------------
  "note.posted": (s, e) => {
    const p = e.payload;
    s.notes.push({ seq: e.seq, agent: e.source.id, topic: p.topic, text: p.text, refs: [...p.refs] });
  },
  /** Recorded (replacing one with the same id) and delivered to the inboxes of its scope's agents. */
  "decision.recorded": (s, e) => {
    const d = clone(e.payload.decision);
    const i = s.decisions.findIndex((x) => x.id === d.id);
    if (i >= 0) s.decisions[i] = d;
    else s.decisions.push(d);
    for (const a of decisionTargets(s, d.scope)) deliver(s, a, { seq: e.seq, kind: "decision", id: d.id, text: d.text });
  },
  /** Delivered to each addressed agent; team ids expand to their members. */
  "directive.issued": (s, e) => {
    const p = e.payload;
    for (const a of expandTargets(s, p.to)) {
      deliver(s, a, { seq: e.seq, kind: "directive", id: p.id, text: p.text, requires_ack: p.requires_ack });
    }
  },
  "directive.acknowledged": (s, { payload: p }) => {
    for (const item of own(s.inbox, p.agent) ?? []) {
      if (item.kind === "directive" && item.id === p.id && item.requires_ack) item.requires_ack = false;
    }
  },

  // --- escalations and huddles -----------------------------------------------
  /** Stored as open with raised_seq = this seq (the task blocks only through task.blocked). */
  "escalation.raised": (s, e) => {
    const esc = { ...clone(e.payload.escalation), status: "open" as const, raised_seq: e.seq };
    put(s.escalations, esc.id, esc);
  },
  "escalation.routed": (s, { payload: p }) => {
    const esc = own(s.escalations, p.id);
    if (!esc) return;
    esc.status = "routed";
    esc.routed_to = p.to;
  },
  /** Resolved by the watchdog: action "decide", decision = the rule. */
  "escalation.auto_resolved": (s, e) => {
    const esc = own(s.escalations, e.payload.id);
    if (!esc) return;
    esc.status = "resolved";
    esc.resolution = { action: "decide", decision: e.payload.rule, by: e.source.id };
  },
  "escalation.resolved": (s, { payload: p }) => {
    const esc = own(s.escalations, p.id);
    if (!esc) return;
    esc.status = "resolved";
    esc.resolution = { action: p.action, decision: p.decision, by: p.by };
  },
  "escalation.awaiting_human": (s, { payload: p }) => {
    const esc = own(s.escalations, p.id);
    if (!esc) return;
    esc.status = "awaiting_human";
    esc.emergency = p.class;
  },
  "escalation.withdrawn": (s, { payload: p }) => {
    const esc = own(s.escalations, p.id);
    if (esc) esc.status = "withdrawn";
  },
  /** Huddle stored; its escalation moves to in_huddle. */
  "huddle.started": (s, { payload: p }) => {
    put(s.huddles, p.id, { escalation: p.escalation, format: p.format, seats: [...p.seats] });
    const esc = own(s.escalations, p.escalation);
    if (!esc) return;
    esc.status = "in_huddle";
    esc.huddle = p.id;
  },
  "huddle.turn": none, // the turn lives in its blob
  "huddle.concluded": (s, { payload: p }) => {
    const h = own(s.huddles, p.id);
    if (!h) return;
    h.outcome = p.outcome;
    if (p.decision !== undefined) h.decision = p.decision;
  },

  // --- budget --------------------------------------------------------------
  /** Adds usd to the execution total and to the agent, the task, and the team (the agent's, else the task's). */
  "budget.usage_recorded": (s, { payload: p }) => {
    const b = s.budget;
    b.spent_usd += p.usd;
    if (p.estimated) b.estimated = true;
    if (p.agent !== undefined) addUsd(b.by_agent, p.agent, p.usd);
    if (p.task !== undefined) addUsd(b.by_task, p.task, p.usd);
    const team = own(s.agents, p.agent)?.team ?? own(s.tasks, p.task)?.spec.team;
    if (team !== undefined) addUsd(b.by_team, team, p.usd);
  },
  "budget.threshold_crossed": (s, { payload: p }) => {
    const t = s.budget.thresholds_crossed;
    if (!t.includes(p.pct)) {
      t.push(p.pct);
      t.sort((a, b) => a - b);
    }
  },
  "budget.exhausted": none,
  "budget.extended": (s, { payload: p }) => {
    s.budget.extensions_usd += p.usd;
  },

  // --- watchdog and sandbox ------------------------------------------------
  "watchdog.action": none,
  "watchdog.circuit_opened": (s, { payload: p }) => {
    put(s.watchdog.circuits, p.driver, { open: true, until: p.until, reason: p.reason });
  },
  "watchdog.circuit_closed": (s, { payload: p }) => {
    put(s.watchdog.circuits, p.driver, { open: false });
  },
  "watchdog.deadlock_detected": (s, { payload: p }) => {
    s.watchdog.deadlocks.push([...p.cycle]);
  },
  "watchdog.stall_detected": none,
  "sandbox.degraded": none,
};

/** Lease gone: removed from leases, from the queue (a withdrawn request), and from every request's blocking list. */
function endLease(s: BlackboardState, id: string): void {
  if (Object.hasOwn(s.leases, id)) delete s.leases[id];
  s.lease_queue = s.lease_queue
    .filter((r) => r.id !== id)
    .map((r) => (r.blocking.includes(id) ? { ...r, blocking: r.blocking.filter((b) => b !== id) } : r));
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** apply, mutating `state` instead of copying it (the store's replay loop). */
export function applyInPlace(state: BlackboardState, event: AnyEvent, resolved: Resolved = {}): BlackboardState {
  const handler = Object.hasOwn(HANDLERS, event.type) ? (HANDLERS[event.type] as Handler<EventType>) : undefined;
  if (!handler) throw new Error(`Blackboard: unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`);
  handler(state, event as EventEnvelope, resolved);
  state.seq = event.seq;
  state.hash = event.hash;
  return state;
}

/** The state after `event`; `state` is not modified. */
export function apply(state: BlackboardState, event: AnyEvent, resolved: Resolved = {}): BlackboardState {
  return applyInPlace(clone(state), event, resolved);
}
