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
//  - Strict mode (the store's write path) throws on an invalid task transition: a task event
//    naming an unknown task, or one that would move a task out of accepted, failed or cancelled.
//    Replay is lenient and ignores such an event, so a log is never rejected after the fact.
//  - Outside task events, an event naming an agent, lease or escalation the state does not
//    know changes nothing for that part.
//  - The reducer never stores undefined, so a state equals its own JSON round trip (snapshots).
//  - Stored objects are copies; callers may keep and mutate the events they passed in.
// ============================================================================

import { ID_RE, preview } from "./events.js";
import { blockingIds, taskHeld, tripwireKey } from "./task-holds.js";
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

/**
 * Bump whenever apply's output for an existing log changes; snapshots of other versions are ignored.
 * 2: split map, terminal-state guards, amended contracts marked frozen.
 * 3: an identical resubmitted diff is no patch; threshold epochs; circuit open counts.
 * 4: blocked_by.needs; task.blocked keeps the other reasons; checks bound to an older submission
 *    are ignored and a bound task.checks_passed for one is refused.
 * 5: worker start identities and budget reservations; bound amendment rechecks while merging.
 * 6: dissent firings and advisory scores; retained task rejection evidence.
 * 7: source-specific holds, pipeline-safe dissent pauses, amendment generations and delivery records.
 * 8: escalation resolution releases its own hold, including historical retries without an unblock.
 */
export const REDUCER_VERSION = 8;

/** Inputs apply cannot read from the event: the contract named by a contract.frozen/amended blob. */
export interface Resolved {
  contract?: Contract;
}

export interface ApplyOptions {
  /** Throw on an invalid task transition instead of ignoring the event (the store's write path). */
  strict?: boolean;
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
    dissents: {},
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
    splits: {},
  };
}

/** The blob ref the store must resolve before applying this event, if any. */
export function contractBlobRef(event: AnyEvent): string | undefined {
  return event.type === "contract.frozen" || event.type === "contract.amended" ? event.payload.blob : undefined;
}

// ---------------------------------------------------------------------------
// Contract checks: everything adoptContract reads must have the shape it expects
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optString = (v: unknown) => v === undefined || nonEmpty(v);

function contractProblem(c: unknown): string | null {
  if (!isObj(c)) return "the blob is not a JSON object";
  if (c.schema !== CONTRACT_SCHEMA) return `the blob is not a ${CONTRACT_SCHEMA} contract`;
  if (!isObj(c.goal)) return "goal is not an object";
  for (const key of ["teams", "interfaces", "decisions", "tasks"]) if (!Array.isArray(c[key])) return `${key} is not an array`;
  if (c.frozen !== undefined && !(isObj(c.frozen) && nonEmpty(c.frozen.by) && nonEmpty(c.frozen.at) && typeof c.frozen.hash === "string")) {
    return "frozen is not {by, at, hash}";
  }
  for (const [i, t] of (c.teams as unknown[]).entries()) {
    if (!isObj(t) || !nonEmpty(t.id)) return `teams[${i}] has no id`;
    if (!optString(t.lead)) return `teams[${i}].lead is not a string`;
    if (!Array.isArray(t.members) || !t.members.every(nonEmpty)) return `teams[${i}].members is not an array of strings`;
  }
  for (const [i, f] of (c.interfaces as unknown[]).entries()) if (!isObj(f) || !nonEmpty(f.name)) return `interfaces[${i}] has no name`;
  for (const [i, d] of (c.decisions as unknown[]).entries()) {
    if (!isObj(d) || !nonEmpty(d.id) || typeof d.text !== "string") return `decisions[${i}] has no id or text`;
  }
  const ids = new Set<string>();
  for (const [i, t] of (c.tasks as unknown[]).entries()) {
    if (!isObj(t) || typeof t.id !== "string" || !ID_RE.test(t.id)) return `tasks[${i}].id is not a valid task id`;
    if (ids.has(t.id)) return `task id ${t.id} appears twice`;
    ids.add(t.id);
    if (!Array.isArray(t.depends_on) || !t.depends_on.every((d) => typeof d === "string" && ID_RE.test(d))) {
      return `tasks[${i}].depends_on is not an array of task ids`;
    }
    if (!optString(t.team)) return `tasks[${i}].team is not a string`;
  }
  return null;
}

/** The resolved contract for a contract.frozen/amended event; throws if it is missing, malformed or another version. */
export function assertResolved(event: AnyEvent, resolved: Resolved): Contract {
  if (event.type !== "contract.frozen" && event.type !== "contract.amended") {
    throw new Error(`${event.type} carries no contract`);
  }
  const where = `${event.type} (seq ${event.seq}, ${preview(event.payload.contract)} v${event.payload.version})`;
  const c = resolved.contract as Partial<Contract> | undefined;
  if (c === undefined) throw new Error(`${where}: the contract from payload.blob was not resolved`);
  const problem = contractProblem(c);
  if (problem) throw new Error(`${where}: ${problem}`);
  if (c.id !== event.payload.contract || c.version !== event.payload.version) {
    throw new Error(`${where}: the blob holds ${preview(c.id)} v${Number.isSafeInteger(c.version) ? c.version : preview(c.version)}`);
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

interface Ctx {
  resolved: Resolved;
  strict: boolean;
}

/** An invalid transition: thrown in strict mode (nothing is written), ignored on replay. */
function refuse(x: Ctx, message: string): undefined {
  if (x.strict) throw new Error(message);
  return undefined;
}

/**
 * The task a task.* event names, or undefined (refused) when it is unknown or terminal. States in
 * `allow` are terminal states this event may still act on.
 */
function liveTask(s: BlackboardState, e: AnyEvent, x: Ctx, allow: readonly TaskState[] = []): TaskRuntime | undefined {
  const id = (e.payload as { task: string }).task;
  const rt = own(s.tasks, id);
  if (!rt) return refuse(x, `${e.type}: unknown task ${preview(id)}`);
  if (TERMINAL.has(rt.state) && !allow.includes(rt.state)) return refuse(x, `${e.type}: task ${id} is already ${rt.state}`);
  return rt;
}

/** A task check bound to a submission that is no longer the task's latest. */
function staleCheck(s: BlackboardState, p: { scope: "task" | "integration"; task?: string; submitted_seq?: number }): boolean {
  return p.scope === "task" && p.submitted_seq !== undefined && own(s.tasks, p.task)?.submitted_seq !== p.submitted_seq;
}

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

/** Dependencies with every split task replaced by its parts (recursively), first occurrence order. */
function expandSplits(s: BlackboardState, deps: string[]): string[] {
  const splits = s.splits ?? {};
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    const parts = own(splits, d);
    if (parts && depth < 16) for (const p of parts) visit(p, depth + 1);
    else if (!out.includes(d)) out.push(d);
  };
  for (const d of deps) visit(d, 0);
  return out;
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

/** Accept a live (non-failed, non-cancelled) task and promote its dependents; accepting twice is a no-op. */
function accept(s: BlackboardState, id: string, rt: TaskRuntime, e: AnyEvent): void {
  if (rt.state === "accepted") return;
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
function adoptContract(s: BlackboardState, c: Contract, seq: number): void {
  const amended = s.contract !== undefined;
  s.contract = c;
  s.goal = clone(c.goal);
  for (const id of Object.keys(s.dissents)) {
    if ((c.dissents ?? []).some((d) => d.id === id)) continue;
    delete s.dissents[id];
    for (const e of Object.values(s.escalations)) {
      if (e.dissent_id !== id || e.status === "resolved" || e.status === "withdrawn") continue;
      e.status = "withdrawn";
      if (e.task && own(s.tasks, e.task)) releaseBlock(s, e.task, e.id);
    }
  }
  for (const d of c.dissents ?? []) {
    let rec = own(s.dissents, d.id);
    if (!rec) {
      rec = put(s.dissents, d.id, { fires: {}, armed_seq: amended ? seq : 0 });
      if (Object.values(s.escalations).some((e) => e.dissent_id === d.id)) rec.generation = seq;
    } else if (JSON.stringify(rec.spec?.tripwire) !== JSON.stringify(d.tripwire)) {
      rec.generation = seq;
      rec.armed_seq = seq;
    }
    rec.spec = clone(d);
  }
  for (const t of c.teams) {
    const team = own(s.teams, t.id) ?? put(s.teams, t.id, { members: [] });
    for (const m of t.members) if (!team.members.includes(m)) team.members.push(m);
    if (t.lead !== undefined) team.lead = t.lead;
  }
  for (const i of c.interfaces) {
    const cur = own(s.interfaces, i.name);
    put(s.interfaces, i.name, { ...cur, spec: clone(i), version: cur?.version ?? 0 });
  }
  for (const d of c.decisions) if (!s.decisions.some((x) => x.id === d.id)) s.decisions.push(clone(d));
  for (const spec of c.tasks) {
    const next = { ...clone(spec), depends_on: expandSplits(s, spec.depends_on) };
    const rt = own(s.tasks, spec.id);
    if (rt) rt.spec = next;
    else put(s.tasks, spec.id, { spec: next, state: "pending", attempt: 0 });
  }
  refreshReadiness(s, true);
}

/** Release only the named source. Dependency/need waits survive an escalation resolution. */
function releaseBlock(s: BlackboardState, task: string, escalation?: string): void {
  const rt = s.tasks[task];
  const by = { ...rt.blocked_by };
  const ids = blockingIds(rt).filter((id) => escalation !== undefined ? id !== escalation :
    own(s.escalations, id) && !["resolved", "withdrawn"].includes(s.escalations[id].status));
  delete by.escalation;
  delete by.escalations;
  if (ids.length) by.escalation = ids[0];
  if (ids.length > 1) by.escalations = ids;
  const deps = expandSplits(s, by.deps ?? []).filter((id) => {
    const dep = own(s.tasks, id);
    return dep ? dep.state !== "accepted" : !((own(s.interfaces, id)?.version ?? 0) >= 1);
  });
  if (deps.length) by.deps = deps;
  else delete by.deps;
  if (by.needs?.length === 0) delete by.needs;
  if (Object.keys(by).length) rt.blocked_by = by;
  else delete rt.blocked_by;
  if (rt.state === "blocked" && !rt.blocked_by) {
    rt.state = own(s.claims, task) ? "in_progress" : depsAccepted(s, rt.spec) ? "ready" : "pending";
  }
}

/** Key of a check in BlackboardState.checks[scope]: "<task>/<command_id>" for task checks, else the command id. */
export function checkKey(scope: "task" | "integration", commandId: string, task?: string): string {
  return scope === "task" && task ? `${task}/${commandId}` : commandId;
}

/** The task of a task-scope check key (task ids never contain "/"), or undefined. */
function checkTask(key: string): string | undefined {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : undefined;
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

type Handler<T extends EventType> = (s: BlackboardState, e: EventEnvelope<T>, x: Ctx) => void;
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
  "contract.frozen": (s, e, x) => {
    const c = clone(assertResolved(e, x.resolved));
    adoptContract(s, { ...c, status: "frozen", frozen: { by: e.payload.by, at: c.frozen?.at ?? e.ts, hash: e.payload.hash } }, e.seq);
  },
  /** Sets contract (status frozen; freeze record from the blob, else kept) and goal. New tasks are
   *  added; existing tasks get the new spec and keep their runtime state; dependencies on split
   *  tasks are rewritten to the parts; tasks missing from the new version are left for the
   *  amending tool to cancel explicitly. */
  "contract.amended": (s, e, x) => {
    const c = clone(assertResolved(e, x.resolved));
    const frozen = c.frozen ?? (s.contract?.frozen ? clone(s.contract.frozen) : undefined);
    adoptContract(s, { ...c, status: "frozen", ...(frozen ? { frozen } : {}) }, e.seq);
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
    if (p.budget_usd !== undefined) rec.budget_reserved_usd = p.budget_usd;
    else delete rec.budget_reserved_usd;
    if (p.team !== undefined) rec.team = p.team;
    put(s.agents, p.agent, rec);
    if (p.team !== undefined) addMember(s, p.team, p.agent);
  },
  "agent.spawned": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.task = p.task;
    rec.pid = p.pid;
    if (p.started !== undefined) rec.started = p.started;
    else delete rec.started;
    if (p.session_id !== undefined) rec.session_id = p.session_id;
    rec.status = "running";
  },
  "agent.attested": none,
  "agent.exited": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.status = "exited";
    delete rec.pid;
    delete rec.started;
    delete rec.budget_reserved_usd;
  },
  "agent.left": (s, { payload: p }) => {
    const rec = own(s.agents, p.agent);
    if (!rec) return;
    rec.status = "left";
    delete rec.pid;
    delete rec.started;
    delete rec.budget_reserved_usd;
  },

  // --- tasks and claims (unknown or terminal tasks are refused; see liveTask) ---
  "task.ready": (s, e, x) => {
    const rt = liveTask(s, e, x);
    if (rt) rt.state = "ready";
  },
  /** state claimed; the claim records agent, attempt, ttl and the granting seq. */
  "task.claimed": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    rt.state = "claimed";
    rt.agent = p.agent;
    rt.attempt = p.attempt;
    rt.started_at ??= e.ts;
    put(s.claims, p.task, { task: p.task, agent: p.agent, attempt: p.attempt, ttl_s: p.ttl_s, granted_seq: e.seq });
  },
  /** Claim dropped (also on a finished task); a claimed live task returns to ready (its WIP stays in the worktree). */
  "task.released": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x, ["accepted", "failed", "cancelled"]);
    if (!rt) return;
    const claimed = Object.hasOwn(s.claims, p.task);
    dropClaim(s, p.task);
    if (!claimed || TERMINAL.has(rt.state)) return;
    rt.state = "ready";
    delete rt.agent;
    if (p.note !== undefined) rt.last_note = p.note;
  },
  /** percent and last_note; a claimed task moves to in_progress. */
  "task.progress": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    if (p.percent !== undefined) rt.percent = p.percent;
    rt.last_note = p.note;
    if (rt.state === "claimed") rt.state = "in_progress";
  },
  /**
   * state submitted; diffs and files updated. The task's check streaks reset only for a new patch:
   * a diff_blob that differs from the task's previous submission. Resubmitting the same diff is no
   * patch, so the same failure keeps counting (heads-down.md §11).
   */
  "task.submitted": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    if (taskHeld(s, p.task, true)) return refuse(x, `task.submitted: task ${p.task} is held by an escalation`);
    rt.state = "submitted";
    rt.last_commit = p.commit;
    rt.submitted_seq = e.seq;
    const patched = own(s.diffs, p.task)?.blob !== p.diff_blob;
    put(s.diffs, p.task, { stat: p.stat, blob: p.diff_blob, commit: p.commit });
    const agent = rt.agent ?? e.source.id;
    for (const f of p.files) put(s.files, f, { task: p.task, agent, last_commit: p.commit, merged: false, at_seq: e.seq });
    if (!patched) return;
    for (const [key, c] of Object.entries(s.checks.task)) {
      if (checkTask(key) === p.task) {
        c.streak = 0;
        c.since_patch_seq = e.seq;
      }
    }
  },
  /** merging. One bound to a submission (submitted_seq) is refused unless it is the task's latest and checking (or an amendment recheck while merging). */
  "task.checks_passed": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    if (p.submitted_seq !== undefined) {
      if (rt.submitted_seq !== p.submitted_seq || (p.commit !== undefined && rt.last_commit !== p.commit)) {
        return refuse(x, `task.checks_passed: submission ${p.submitted_seq} of ${p.task} is not its latest`);
      }
      if (rt.state !== "submitted" && rt.state !== "checking" && rt.state !== "merging") return refuse(x, `task.checks_passed: task ${p.task} is ${rt.state}, not checking`);
    }
    rt.state = "merging";
  },
  /** Back to in_progress while claimed (the worker is resumed with the reasons), else ready. */
  "task.rejected": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    rt.state = taskHeld(s, p.task) || rt.blocked_by?.deps?.length || rt.blocked_by?.needs?.length ? "blocked" : own(s.claims, p.task) ? "in_progress" : "ready";
    rt.last_note = p.reasons.join("; ");
    rt.rejected_seq = e.seq;
  },
  /** Accepted (claim dropped, files merged); integration streaks reset; dependents whose deps are all accepted become ready. */
  "task.merged": (s, e, x) => {
    const rt = liveTask(s, e, x, ["accepted"]);
    if (!rt) return;
    markMerged(s, e.payload.task);
    for (const c of Object.values(s.checks.integration)) {
      c.streak = 0;
      c.since_patch_seq = e.seq;
    }
    accept(s, e.payload.task, rt, e);
  },
  /** Accepted without a merge (for example a review task); dependents as for task.merged. */
  "task.accepted": (s, e, x) => {
    const rt = liveTask(s, e, x, ["accepted"]);
    if (rt) accept(s, e.payload.task, rt, e);
  },
  /** Accumulate source-specific reasons; a dissent hold preserves an in-flight pipeline state. */
  "task.blocked": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    const prev = rt.blocked_by;
    const dissent = own(s.escalations, p.escalation)?.dissent_id;
    if (!dissent || !["submitted", "checking", "merging"].includes(rt.state)) rt.state = "blocked";
    rt.blocked_seq = e.seq;
    const by: NonNullable<TaskRuntime["blocked_by"]> = {};
    const escalation = p.escalation ?? prev?.escalation;
    if (escalation !== undefined) by.escalation = escalation;
    const ids = [...new Set([...blockingIds(rt), ...(p.escalation ? [p.escalation] : [])])];
    if (ids.length > 1) by.escalations = ids;
    const deps = [...new Set([...(prev?.deps ?? []), ...(p.deps ?? [])])];
    if (deps.length || p.deps !== undefined) by.deps = deps;
    if (rt.blocked_by?.needs?.length) by.needs = rt.blocked_by.needs;
    rt.blocked_by = by;
  },
  /** Release one escalation source (or satisfied dependency reasons); resume only after every reason clears. */
  "task.unblocked": (s, e, x) => {
    const rt = liveTask(s, e, x);
    if (!rt) return;
    releaseBlock(s, e.payload.task, e.payload.escalation);
  },
  /** New attempt (also from failed), claim dropped; unrelated blocking sources survive. */
  "task.retried": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x, ["failed"]);
    if (!rt) return;
    rt.state = "ready";
    rt.attempt = p.attempt;
    rt.last_note = p.why;
    delete rt.agent;
    delete rt.finished_at;
    dropClaim(s, p.task);
    releaseBlock(s, p.task);
    rt.state = rt.blocked_by ? "blocked" : "ready";
  },
  "task.reassigned": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    rt.agent = p.to;
    const claim = own(s.claims, p.task);
    if (claim) claim.agent = p.to;
  },
  /** The parts become tasks and are recorded in splits; dependents of the split task (now and in
   *  later contract versions) depend on the parts; the split task is cancelled. */
  "task.split": (s, e, x) => {
    const p = e.payload;
    const rt = liveTask(s, e, x);
    if (!rt) return;
    const ids = p.into.map((t) => t.id);
    const clash = ids.find((id) => id === p.task || own(s.tasks, id));
    if (clash !== undefined) return refuse(x, `task.split: part ${clash} is already a task`);
    for (const spec of p.into) put(s.tasks, spec.id, { spec: clone(spec), state: "pending", attempt: 0 });
    put((s.splits ??= {}), p.task, ids);
    for (const other of Object.values(s.tasks)) {
      if (other.spec.depends_on.includes(p.task)) other.spec.depends_on = expandSplits(s, other.spec.depends_on);
    }
    finish(s, p.task, rt, "cancelled", e.ts, `split into ${ids.join(", ")}`);
    refreshReadiness(s);
  },
  "task.failed": (s, e, x) => {
    const rt = liveTask(s, e, x);
    if (rt) finish(s, e.payload.task, rt, "failed", e.ts, e.payload.why);
  },
  /** Cancels a live or failed task. */
  "task.cancelled": (s, e, x) => {
    const rt = liveTask(s, e, x, ["failed"]);
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

  // --- dependencies (task.blocked / task.unblocked carry the state change) ---
  /** An interface or artifact need joins the task's blocked_by.needs (task needs are deps). */
  "dependency.requested": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    if (!rt || TERMINAL.has(rt.state) || p.need.kind === "task") return;
    const needs = rt.blocked_by?.needs ?? [];
    if (needs.some((n) => n.kind === p.need.kind && n.ref === p.need.ref)) return;
    rt.blocked_by = { ...rt.blocked_by, needs: [...needs, { kind: p.need.kind, ref: p.need.ref }] };
  },
  /** The need leaves blocked_by.needs; the other reasons stay. */
  "dependency.satisfied": (s, { payload: p }) => {
    const rt = own(s.tasks, p.task);
    const needs = rt?.blocked_by?.needs;
    if (!rt?.blocked_by || !needs) return;
    const left = needs.filter((n) => !(n.kind === p.need.kind && n.ref === p.need.ref));
    if (left.length) rt.blocked_by.needs = left;
    else delete rt.blocked_by.needs;
    if (rt.state !== "blocked" && !Object.keys(rt.blocked_by).length) delete rt.blocked_by;
  },

  // --- checks: [scope][checkKey] (a task check bound to an older submission is ignored) ---
  /** status running; a submitted task moves to checking. */
  "check.started": (s, e) => {
    const p = e.payload;
    if (staleCheck(s, p)) return;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    put(s.checks[p.scope], key, { streak: 0, since_patch_seq: 0, ...cur, status: "running", at_seq: e.seq });
    const rt = p.scope === "task" ? own(s.tasks, p.task) : undefined;
    if (rt?.state === "submitted") rt.state = "checking";
  },
  /** status passed; the failure streak resets to 0. */
  "check.passed": (s, e) => {
    const p = e.payload;
    if (staleCheck(s, p)) return;
    const key = checkKey(p.scope, p.command_id, p.task);
    const cur = own(s.checks[p.scope], key);
    put(s.checks[p.scope], key, { status: "passed", streak: 0, since_patch_seq: cur?.since_patch_seq ?? 0, at_seq: e.seq });
  },
  /** status failed; streak + 1 when the signature is unchanged, else 1. */
  "check.failed": (s, e) => {
    const p = e.payload;
    if (staleCheck(s, p)) return;
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
    if (staleCheck(s, p)) return;
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
  /** Dissent notifications address literal identity inboxes; ordinary team directives expand. */
  "directive.issued": (s, e) => {
    const p = e.payload;
    const targets = e.correlation?.startsWith("tripwire:") ? [...new Set(p.to)] : expandTargets(s, p.to);
    for (const a of targets) {
      deliver(s, a, { seq: e.seq, kind: "directive", id: p.id, text: p.text, requires_ack: p.requires_ack });
    }
  },
  "directive.acknowledged": (s, { payload: p }) => {
    for (const item of own(s.inbox, p.agent) ?? []) {
      if (item.kind === "directive" && item.id === p.id && item.requires_ack) item.requires_ack = false;
    }
  },

  "dissent.tripwire_fired": (s, e) => {
    const p = e.payload;
    const rec = own(s.dissents, p.dissent_id) ?? put(s.dissents, p.dissent_id, { fires: {} });
    const key = tripwireKey(p.dissent_id, p.task, p.generation);
    if (!own(rec.fires, key)) put(rec.fires, key, { ...clone(p), seq: e.seq });
  },
  "dissent.scored": (s, e) => {
    const rec = own(s.dissents, e.payload.dissent_id) ?? put(s.dissents, e.payload.dissent_id, { fires: {} });
    rec.score = e.payload.outcome;
    rec.scored_seq = e.seq;
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
    if (esc.task && own(s.tasks, esc.task)) releaseBlock(s, esc.task, esc.id);
  },
  "escalation.resolved": (s, { payload: p }) => {
    const esc = own(s.escalations, p.id);
    if (!esc) return;
    esc.status = "resolved";
    esc.resolution = { action: p.action, decision: p.decision, by: p.by };
    if (esc.task && own(s.tasks, esc.task)) releaseBlock(s, esc.task, esc.id);
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
    if (p.source === "worker" && p.agent !== undefined) {
      const agent = own(s.agents, p.agent);
      if (agent) delete agent.budget_reserved_usd;
    }
    if (p.estimated) b.estimated = true;
    if (p.agent !== undefined) addUsd(b.by_agent, p.agent, p.usd);
    if (p.task !== undefined) addUsd(b.by_task, p.task, p.usd);
    const team = own(s.agents, p.agent)?.team ?? own(s.tasks, p.task)?.spec.team;
    if (team !== undefined) addUsd(b.by_team, team, p.usd);
  },
  /**
   * Recorded per budget epoch: a threshold crossed at a new total (after budget.extended) starts a
   * new list. A list recorded before epochs existed is adopted by the first total named.
   */
  "budget.threshold_crossed": (s, { payload: p }) => {
    const b = s.budget;
    if (b.thresholds_budget_usd !== undefined && b.thresholds_budget_usd !== p.budget_usd) b.thresholds_crossed = [];
    b.thresholds_budget_usd = p.budget_usd;
    const t = b.thresholds_crossed;
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
    const c: BlackboardState["watchdog"]["circuits"][string] = { open: true, until: p.until, reason: p.reason };
    if (p.opens !== undefined) c.opens = p.opens;
    put(s.watchdog.circuits, p.driver, c);
  },
  /** Closed; `until` keeps the end of the last open period, so that incident is not counted again. */
  "watchdog.circuit_closed": (s, { payload: p }) => {
    const until = own(s.watchdog.circuits, p.driver)?.until;
    put(s.watchdog.circuits, p.driver, until !== undefined ? { open: false, until } : { open: false });
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

/** apply, mutating `state` instead of copying it (the store's replay loop and dry run). */
export function applyInPlace(state: BlackboardState, event: AnyEvent, resolved: Resolved = {}, opts: ApplyOptions = {}): BlackboardState {
  const handler = Object.hasOwn(HANDLERS, event.type) ? (HANDLERS[event.type] as Handler<EventType>) : undefined;
  if (!handler) throw new Error(`Blackboard: unknown event type ${preview(event.type)} at seq ${event.seq}`);
  handler(state, event as EventEnvelope, { resolved, strict: opts.strict === true });
  state.seq = event.seq;
  state.hash = event.hash;
  return state;
}

/** The state after `event`; `state` is not modified. */
export function apply(state: BlackboardState, event: AnyEvent, resolved: Resolved = {}, opts: ApplyOptions = {}): BlackboardState {
  return applyInPlace(clone(state), event, resolved, opts);
}
