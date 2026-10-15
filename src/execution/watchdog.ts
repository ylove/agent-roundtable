// ============================================================================
// Watchdog: evaluate(state, now, obs, cfg) → WatchdogAction[]
//
// Pure and deterministic: the same blackboard, clock and observations give the same actions in
// the same order. The runner gathers the observations (process liveness, output and heartbeat
// times, watcher liveness, and times the blackboard does not keep: see observeEvents), calls
// evaluate inside store.transact against the fresh state, appends actionsToDrafts(actions), and
// performs the process operations after the commit.
//
// Idempotence: every rule checks for its own effect before acting. Escalations have ids derived
// from a key (escalationId), so an escalation already on the blackboard is never raised twice;
// state transitions (task.retried, task.released, lease.granted, thresholds_crossed, circuits,
// deadlocks) remove the condition that triggered them. The two rules whose effect is not on the
// blackboard read it from the observations: a stall from lastStallAt, a lead fallback from the
// escalation being re-routed to the lead.
// ============================================================================

import { executionTag } from "../ids.js";
import {
  CONTRACT_DEFAULTS,
  type AgentRecord,
  type AnyEvent,
  type AnyEventDraft,
  type BlackboardState,
  type Claim,
  type Lease,
  type LeaseMode,
  type LeaseRequest,
  type TaskRuntime,
  type TaskState,
} from "./types.js";
import { budgetRules, remainingUsd } from "./budget.js";
import {
  classifyFailure,
  circuitRules,
  circuitStatus,
  outcomesFromEvents,
  type CircuitConfig,
  type CircuitHistory,
  type DriverOutcome,
} from "./circuit.js";
import { deadlockRules, type DependencyNeed } from "./deadlock.js";
import {
  TERMINAL_TASK_STATES,
  draft,
  emitAction,
  escalationAction,
  escalationId,
  own,
  putOwn,
  sortedKeys,
  type WatchdogAction,
} from "./watchdog-actions.js";

export {
  WATCHDOG_SOURCE,
  actionsToDrafts,
  escalationId,
  processActions,
  type DraftOptions,
  type ProcessAction,
  type WatchdogAction,
  type WatchdogActionType,
  type WatchdogRule,
} from "./watchdog-actions.js";
export type { CircuitHistory, DriverOutcome, FailureKind, FailureSource } from "./circuit.js";
export type { DependencyNeed } from "./deadlock.js";

// ---------------------------------------------------------------------------
// Observations and configuration
// ---------------------------------------------------------------------------

export interface AgentObservation {
  pid?: number;
  /** The pid exists on this host. */
  alive: boolean;
  /** When the current process started (ms); a stall is never measured from before it. */
  startedAt?: number;
  /** Last growth of the worker's output file (ms). */
  lastOutputAt?: number;
  /** Last write of agents/<id>/heartbeat (ms). */
  lastHeartbeatAt?: number;
  /** Stalls already detected on the agent's current task, across its attempts (watchdog.stall_detected events). */
  stalls?: number;
  /** When the last of them was detected (ms). */
  lastStallAt?: number;
  /** A kill, resume or spawn for this agent is in flight: the liveness rules leave it alone. */
  busy?: boolean;
}

export interface WatcherObservation {
  alive: boolean;
  /** Last liveness write of watch/<orchestrator>.json (ms). */
  lastSeenAt?: number;
}

/** What the runner knows that the blackboard does not. Times are ms since the epoch. */
export interface Observations {
  /** By agent id. */
  agents?: Record<string, AgentObservation>;
  /** By orchestrator name. */
  watchers?: Record<string, WatcherObservation>;
  /** When each escalation was last routed, by escalation id. */
  escalations?: Record<string, { routedAt: number }>;
  /** Last renewal of each external claim, by task id. */
  claims?: Record<string, { renewedAt: number }>;
  /** Event times by seq: a claim's renewal falls back to the time of its granted_seq. */
  seqTimes?: Record<number, number>;
  /** When each huddle started, by huddle id. */
  huddles?: Record<string, { startedAt: number }>;
  /** Every submitted diff_blob per task, oldest first. */
  diffs?: Record<string, string[]>;
  /** Driver and provider failures and successes (circuit breaker). */
  outcomes?: DriverOutcome[];
  /** Circuit open/close history by driver. */
  circuits?: Record<string, CircuitHistory>;
  /** Open dependency.requested needs (not yet satisfied). */
  needs?: DependencyNeed[];
  /** Last agent.spawned time per agent: a spawn at or after a half-open circuit's until is its trial. */
  spawns?: Record<string, number>;
  /**
   * Worker deaths per task that the circuit breaker accounts for (a rate limit, auth or credit
   * failure in the driver's error), and the attempt of the latest one. They do not count against
   * max_attempts.
   */
  infraDeaths?: Record<string, { count: number; lastAttempt: number }>;
  /**
   * Per task, the attempt whose worker stopped for a pause: it exited while its task or the run
   * was paused (or its agent.exited says paused), or it was running when the pause began. Its
   * death does not count against max_attempts; it resumes on the same attempt. `context` is the
   * pause (its escalation id, or its reason); `seq` the event that recorded the stop.
   */
  pauseStops?: Record<string, { attempt: number; context: string; seq: number }>;
  /** Escalations whose lead fallback call is running now (set by the runner). */
  leadInFlight?: Record<string, boolean>;
  /** When lead_fallback was last issued per escalation (its watchdog.action audit event). */
  leadIssuedAt?: Record<string, number>;
}

export interface WatchdogConfig {
  /** No output and no heartbeat for this long while the pid lives is a stall. */
  stallMs: number;
  /** An escalation routed to an orchestrator whose watcher is not alive falls back to the lead after this long. */
  leadGraceMs: number;
  /** A lead fallback still unresolved this long after it was issued (and not in flight) is issued again. */
  leadRetryMs: number;
  /** A huddle without an outcome after this long goes to the orchestrator. */
  huddleTimeoutMs: number;
  /** A watcher whose lastSeenAt is older than this is not alive (it writes every 10 s). */
  watcherStaleMs: number;
  /** Same check signature this many times with no patch between escalates. */
  failureStreak: number;
  /** Two agents alternating on a note topic this many notes in a row suggests a micro-huddle. */
  notePingPong: number;
  /** Respawns after transient driver failures (rate limit, auth, credit) a task may use before it fails. */
  infraRetries: number;
  /** A half-open circuit's trial worker that has run this long without failing counts as a success. */
  circuitTrialMs: number;
  circuitWindowMs: number;
  circuitFailures: number;
  circuitBaseMs: number;
  circuitMaxMs: number;
}

const MIN = 60_000;
export const WATCHDOG_DEFAULTS: Readonly<WatchdogConfig> = Object.freeze({
  stallMs: 10 * MIN,
  leadGraceMs: 2 * MIN,
  leadRetryMs: 5 * MIN,
  huddleTimeoutMs: 20 * MIN,
  watcherStaleMs: 30_000,
  failureStreak: 3,
  notePingPong: 4,
  infraRetries: 20,
  circuitTrialMs: 2 * MIN,
  circuitWindowMs: 10 * MIN,
  circuitFailures: 5,
  circuitBaseMs: MIN,
  circuitMaxMs: 30 * MIN,
});

// ---------------------------------------------------------------------------
// Lease overlap (conservative static-prefix rule, design §10)
//
// TODO(WS06): switch to globsOverlap / leasesConflict from src/execution/leases.ts once PR #113
// is on release/1.0.0.
//
// A small stand-in: the full lease engine (WS06) replaces these. A glob's static prefix is its
// leading path segments without a wildcard; two globs overlap when one static prefix is a path
// prefix of the other. An exclusive lease conflicts with any overlapping lease, a shared lease
// only with an exclusive one.
// ---------------------------------------------------------------------------

export function staticPrefix(glob: string): string[] {
  const out: string[] = [];
  for (const seg of glob.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out;
}

export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return false;
  return true;
}

export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

export function leasesConflict(a: { paths: readonly string[]; mode: LeaseMode }, b: { paths: readonly string[]; mode: LeaseMode }): boolean {
  return (a.mode === "exclusive" || b.mode === "exclusive") && pathsOverlap(a.paths, b.paths);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE: ReadonlySet<TaskState> = new Set(["claimed", "in_progress"]);
/** Submitted work is being checked or merged: the claim's TTL is suspended. */
const SUSPENDED: ReadonlySet<TaskState> = new Set(["submitted", "checking", "merging"]);

function isTerminal(state: BlackboardState, task: string | undefined): boolean {
  const st = own(state.tasks, task)?.state;
  return st !== undefined && TERMINAL_TASK_STATES.has(st);
}

function isPaused(state: BlackboardState, task: string): boolean {
  return state.status === "paused" || state.paused_tasks.includes(task);
}

function seqTime(obs: Observations, seq: number): number | undefined {
  return obs.seqTimes && Object.hasOwn(obs.seqTimes, String(seq)) ? obs.seqTimes[seq] : undefined;
}

function watcherAlive(w: WatcherObservation | undefined, now: number, cfg: WatchdogConfig): boolean {
  return w?.alive === true && (w.lastSeenAt === undefined || now - w.lastSeenAt <= cfg.watcherStaleMs);
}

const minutes = (ms: number): string => `${Math.round(ms / MIN)} min`;

// ---------------------------------------------------------------------------
// Respawn gate: every path that starts a worker (retry, resume) goes through it
// ---------------------------------------------------------------------------

/** One evaluate pass: circuits this pass opens, and half-open drivers whose one trial it admitted. */
interface Pass {
  opening: ReadonlySet<string>;
  admitted: Set<string>;
}

export type RespawnBlock = "budget" | "circuit_open" | "trial_in_flight";

/** A worker spawned on the driver at or after its half-open `until`: the trial is under way. */
function trialInFlight(state: BlackboardState, obs: Observations, driver: string): boolean {
  const until = Date.parse(own(state.watchdog.circuits, driver)?.until ?? "");
  if (!Number.isFinite(until)) return false;
  return sortedKeys(state.agents).some((a) => state.agents[a].driver === driver && (own(obs.spawns, a) ?? -Infinity) >= until);
}

function respawnGate(
  state: BlackboardState,
  now: number,
  obs: Observations,
  who: { task: string; agent?: string; driver?: string },
  pass: Pass
): { ok: true; trial?: string } | { ok: false; why: RespawnBlock } {
  if (remainingUsd(state, { task: who.task, agent: who.agent }) <= 0) return { ok: false, why: "budget" };
  const d = who.driver;
  if (d === undefined) return { ok: true };
  const status = circuitStatus(state, d, now);
  if (pass.opening.has(d) || status === "open") return { ok: false, why: "circuit_open" };
  if (status === "half_open") {
    if (pass.admitted.has(d) || trialInFlight(state, obs, d)) return { ok: false, why: "trial_in_flight" };
    return { ok: true, trial: d };
  }
  return { ok: true };
}

/**
 * Whether a worker may be started for the task now: budget left (execution, task and agent), and
 * the driver's circuit closed, or half-open with no trial worker started yet (exactly one trial
 * per half-open period). The runner checks this before every spawn of its own.
 */
export function canRespawn(
  state: BlackboardState,
  now: number,
  obs: Observations,
  who: { task: string; agent?: string; driver?: string }
): { ok: boolean; why?: RespawnBlock } {
  const g = respawnGate(state, now, obs, who, { opening: new Set(), admitted: new Set() });
  return g.ok ? { ok: true } : { ok: false, why: g.why };
}

// ---------------------------------------------------------------------------
// Rules: leases and claims
// ---------------------------------------------------------------------------

/**
 * An external claim (ttl_s > 0) not renewed within its ttl expires, unless the run or the task is
 * paused or its submitted work is being checked or merged (the TTL is suspended then): its leases
 * expire, its queued lease requests are withdrawn, and the task returns to ready (the WIP stays in
 * the worktree). Leases of finished tasks (accepted, failed, cancelled) expire, and queued requests
 * of tasks without a claim (released, retried, finished) are withdrawn; a retried task requests
 * its leases again. Then queued requests are granted in queue order
 * when nothing they wait on is still held and they conflict neither with a held lease nor with an
 * earlier request that is still waiting (no overtaking).
 */
function leaseRules(state: BlackboardState, now: number, obs: Observations): WatchdogAction[] {
  const out: WatchdogAction[] = [];
  const ending = new Set<string>();
  const withdrawn = new Set<string>();

  for (const task of sortedKeys(state.claims)) {
    const claim = state.claims[task];
    const st = own(state.tasks, task)?.state;
    if (!(claim.ttl_s > 0) || isPaused(state, task) || (st !== undefined && SUSPENDED.has(st))) continue;
    const renewedAt = own(obs.claims, task)?.renewedAt ?? seqTime(obs, claim.granted_seq);
    if (renewedAt === undefined || now - renewedAt <= claim.ttl_s * 1000) continue;
    const key = `claim_expiry:${task}:${claim.granted_seq}`;
    const events: AnyEventDraft[] = [];
    for (const id of sortedKeys(state.leases)) {
      if (state.leases[id].task !== task) continue;
      ending.add(id);
      events.push(draft("lease.expired", { lease_id: id }, key));
    }
    for (const req of state.lease_queue) {
      if (req.task !== task || withdrawn.has(req.id)) continue;
      withdrawn.add(req.id);
      events.push(draft("lease.released", { lease_id: req.id }, key));
    }
    const note = `Claim by ${claim.agent} expired: not renewed within its ttl of ${claim.ttl_s} s. The work in progress stays in the worktree.`;
    events.push(draft("task.released", { task, agent: claim.agent, note }, key));
    out.push(emitAction("claim_expiry", key, task, events));
  }

  for (const id of sortedKeys(state.leases)) {
    if (ending.has(id)) continue;
    if (!isTerminal(state, state.leases[id].task)) continue;
    ending.add(id);
    const key = `lease_orphan:${id}`;
    out.push(emitAction("lease_orphan", key, id, [draft("lease.expired", { lease_id: id }, key)]));
  }

  const held: Array<Pick<Lease, "task" | "paths" | "mode">> = sortedKeys(state.leases)
    .filter((id) => !ending.has(id))
    .map((id) => state.leases[id]);
  const waiting: LeaseRequest[] = [];
  const queue = [...state.lease_queue].sort((a, b) => a.requested_seq - b.requested_seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const req of queue) {
    if (withdrawn.has(req.id) || own(state.leases, req.id)) continue;
    const rt = own(state.tasks, req.task);
    if (!rt || TERMINAL_TASK_STATES.has(rt.state) || !own(state.claims, req.task)) {
      // Nobody is waiting for it any more: dequeue it, so it neither blocks nor is granted later.
      withdrawn.add(req.id);
      const key = `lease_withdraw:${req.id}`;
      out.push(emitAction("lease_withdraw", key, req.task, [draft("lease.released", { lease_id: req.id }, key)]));
      continue;
    }
    const blocked =
      req.blocking.some((id) => {
        const l = own(state.leases, id);
        return l !== undefined && l.task !== req.task && !ending.has(id);
      }) ||
      held.some((l) => l.task !== req.task && leasesConflict(l, req)) ||
      waiting.some((w) => w.task !== req.task && leasesConflict(w, req));
    if (blocked) {
      waiting.push(req);
      continue;
    }
    const lease: Lease = {
      id: req.id,
      agent: req.agent,
      task: req.task,
      paths: [...req.paths],
      mode: req.mode,
      branch: rt.branch ?? `rt/${executionTag(state.execution)}/${req.task}`,
      reason: req.reason,
      granted_seq: 0,
    };
    held.push(lease);
    const key = `lease_grant:${req.id}`;
    out.push(emitAction("lease_grant", key, req.task, [draft("lease.granted", { lease }, key)]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules: workers (runner-spawned claims, ttl_s 0)
// ---------------------------------------------------------------------------

function deadWorker(
  state: BlackboardState,
  now: number,
  obs: Observations,
  claim: Claim,
  rt: TaskRuntime,
  rec: AgentRecord | undefined,
  lost: boolean,
  pass: Pass,
  cfg: WatchdogConfig
): WatchdogAction[] {
  const { task, agent } = claim;
  const maxAttempts = state.contract?.budget.max_attempts ?? CONTRACT_DEFAULTS.max_attempts;
  const attempt = Math.max(claim.attempt, rt.attempt);
  const next = attempt + 1;
  const how = lost ? "was lost (its process is gone)" : "exited before submitting";
  const key = `worker_dead:${task}:${attempt}`;
  const stop = own(obs.pauseStops, task);
  const paused = stop !== undefined && stop.attempt === attempt ? stop : undefined;
  const lostEvent = () => [draft("agent.exited", { agent, task, code: null, reason: "lost", ...(paused && { paused: paused.context }) }, key)];

  // Gate first: while no worker may start (budget spent, circuit open, a half-open trial already
  // running), wait. Nothing is counted; the budget and circuit rules escalate. A lost worker is
  // still recorded, under its own key, so the later retry is not mistaken for it.
  const gate = respawnGate(state, now, obs, { task, agent, driver: rec?.driver }, pass);
  if (!gate.ok) return lost ? [emitAction("worker_dead", `${key}:lost`, task, lostEvent())] : [];
  const before = lost ? lostEvent() : [];

  // A worker that stopped for a pause (an emergency, a driver circuit, a manual pause) did
  // nothing wrong: resume its session on the same attempt, counting nothing. The op repeats
  // (same key) until its agent.spawned clears the stop.
  if (paused) {
    if (gate.trial) pass.admitted.add(gate.trial);
    const why = `Worker ${agent} stopped while task ${task} was paused (${paused.context}); resuming its session on attempt ${attempt} (not counted against max_attempts).`;
    return [
      ...(before.length ? [emitAction("worker_dead", `${key}:lost`, task, before)] : []),
      { type: "resume_worker", rule: "worker_dead", key: `${key}:paused:${paused.seq}`, target: agent, agent, task, why },
    ];
  }

  // A death the circuit breaker accounts for (a rate limit, auth or credit failure) is not the
  // task's fault: it does not count against max_attempts, only against the larger infraRetries.
  const infra = own(obs.infraDeaths, task);
  const infraCount = infra?.count ?? 0;
  const transient = !lost && infra?.lastAttempt === attempt;
  const used = attempt - infraCount;
  const fail = (why: string): WatchdogAction[] => {
    const esc = escalationAction(state, "worker_dead", {
      key,
      task,
      kind: "blocker",
      with: "orchestrator",
      target: state.contract?.scope.orchestrator,
      summary: `${why} The task has failed.`,
      options: ["Retry it with another attempt", "Reassign it", "Split it", "Cancel it"],
      before: [...before, draft("task.failed", { task, why }, key)],
    });
    return esc ? [esc] : [];
  };
  if (transient && infraCount > cfg.infraRetries) {
    return fail(`Workers on task ${task} died of transient driver failures ${infraCount} times (the limit is ${cfg.infraRetries}).`);
  }
  if (!transient && used >= maxAttempts) {
    const counted = infraCount
      ? `attempt ${attempt} (${used} of ${maxAttempts} counted; ${infraCount} transient driver failure${infraCount === 1 ? "" : "s"} not counted)`
      : `attempt ${attempt} of ${maxAttempts}`;
    return fail(`Worker ${agent} ${how} on ${counted}.`);
  }
  if (gate.trial) pass.admitted.add(gate.trial);
  const why = transient
    ? `Worker ${agent} hit a transient driver failure; resuming its session as attempt ${next} (not counted against max_attempts).`
    : infraCount
      ? `Worker ${agent} ${how}; resuming its session as attempt ${next} (${used + 1} of ${maxAttempts} counted).`
      : `Worker ${agent} ${how}; resuming its session as attempt ${next} of ${maxAttempts}.`;
  return [
    emitAction("worker_dead", `${key}:retry`, task, [...before, draft("task.retried", { task, attempt: next, why }, key)]),
    { type: "spawn_retry", rule: "worker_dead", key: `${key}:spawn`, target: task, task, attempt: next },
  ];
}

function stalledWorker(
  state: BlackboardState,
  now: number,
  obs: Observations,
  claim: Claim,
  rec: AgentRecord,
  o: AgentObservation,
  pass: Pass,
  cfg: WatchdogConfig
): WatchdogAction[] {
  const { task, agent } = claim;
  const last = Math.max(o.startedAt ?? -Infinity, o.lastOutputAt ?? -Infinity, o.lastHeartbeatAt ?? -Infinity, o.lastStallAt ?? -Infinity);
  if (!Number.isFinite(last) || now - last < cfg.stallMs) return [];
  const n = (o.stalls ?? 0) + 1;
  const key = `worker_stall:${task}:${n}`;
  const idle = `no output or heartbeat for ${minutes(now - last)}`;
  const detected = draft("watchdog.stall_detected", { agent, task }, key);
  const kill: WatchdogAction = { type: "kill_worker", rule: "worker_stall", key: `${key}:kill`, target: agent, agent, reason: `Stalled: ${idle}` };
  if (n >= 2) {
    const esc = escalationAction(state, "worker_stall", {
      key,
      task,
      kind: "blocker",
      with: "orchestrator",
      target: state.contract?.scope.orchestrator,
      summary: `Worker ${agent} stalled on task ${task} again (stall ${n}: ${idle}). It was stopped and not resumed.`,
      options: ["Retry with a fresh session", "Reassign the task", "Split the task", "Cancel the task"],
      block: true,
      before: [detected],
    });
    return esc ? [esc, kill] : [];
  }
  // The resume is a respawn: the same gate as a retry. Without it, the worker is only stopped,
  // and the dead-worker rule retries it once the gate opens.
  const gate = respawnGate(state, now, obs, { task, agent, driver: rec.driver }, pass);
  if (!gate.ok) return [emitAction("worker_stall", key, task, [detected]), kill];
  if (gate.trial) pass.admitted.add(gate.trial);
  return [
    emitAction("worker_stall", key, task, [detected]),
    kill,
    { type: "resume_worker", rule: "worker_stall", key: `${key}:resume`, target: agent, agent, task, why: `Resumed after a stall (${idle}).` },
  ];
}

/**
 * For each runner claim on a claimed or in-progress task that is not paused:
 *  - the agent exited or left, or its pid is gone ("lost"): retry with attempt+1 (spawn_retry
 *    resumes the session), or fail the task and escalate once attempts are used up. Transient
 *    driver failures do not use attempts, and a worker that stopped for a pause resumes its
 *    session on the same attempt (obs.pauseStops). No retry, and no attempt accounting, while the
 *    respawn gate is shut (budget spent, circuit open or opening, a half-open trial already running);
 *  - the pid lives but there has been no output or heartbeat for stallMs: kill, and resume when
 *    the gate allows; on the task's second stall, kill, block and escalate instead.
 * A task the watchdog blocked keeps no live worker: its kill is re-issued (standing) until the
 * worker is gone. Agents with busy set, and claims whose agent the observations do not cover,
 * are left alone.
 */
function workerRules(state: BlackboardState, now: number, obs: Observations, cfg: WatchdogConfig, pass: Pass): WatchdogAction[] {
  const out: WatchdogAction[] = [];
  for (const task of sortedKeys(state.claims)) {
    const claim = state.claims[task];
    const rt = own(state.tasks, task);
    const rec = own(state.agents, claim.agent);
    const o = own(obs.agents, claim.agent);
    if (!rt || o?.busy) continue;
    if (rt.state === "blocked") {
      const escId = rt.blocked_by?.escalation;
      const esc = own(state.escalations, escId);
      if (claim.ttl_s <= 0 && esc?.agent === "watchdog" && esc.status !== "resolved" && esc.status !== "withdrawn" && rec?.status === "running") {
        const agent = claim.agent;
        out.push({ type: "kill_worker", rule: "blocked_worker", key: `${escId}:kill`, target: agent, agent, reason: "Its task is blocked", standing: true });
      }
      continue;
    }
    if (claim.ttl_s > 0 || !ACTIVE.has(rt.state) || isPaused(state, task)) continue;
    const exited = rec?.status === "exited" || rec?.status === "left";
    const lost = rec?.status === "running" && o !== undefined && !o.alive;
    if (exited || lost) out.push(...deadWorker(state, now, obs, claim, rt, rec, lost, pass, cfg));
    else if (rec?.status === "running" && o?.alive) out.push(...stalledWorker(state, now, obs, claim, rec, o, pass, cfg));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules: dependencies, repeated failure, ping-pong
// ---------------------------------------------------------------------------

/** Deps with each split task replaced by its parts (task.split records them in state.splits). */
function expandDeps(state: BlackboardState, deps: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number): void => {
    const parts = own(state.splits, d);
    if (parts && depth < 16) for (const p of parts) visit(p, depth + 1);
    else if (!out.includes(d)) out.push(d);
  };
  for (const d of deps) visit(d, 0);
  return out;
}

function depSatisfied(state: BlackboardState, dep: string): boolean {
  const t = own(state.tasks, dep);
  if (t) return t.state === "accepted";
  const i = own(state.interfaces, dep);
  return i !== undefined && i.version >= 1;
}

/**
 * A task blocked only on deps (task ids, split tasks through their parts, or interface names), with
 * no open needs, is unblocked once all are accepted or published. A dep that failed or was cancelled will never
 * finish: that escalates to the orchestrator instead (the task stays blocked on its deps).
 */
function dependencyRules(state: BlackboardState): WatchdogAction[] {
  const out: WatchdogAction[] = [];
  for (const task of sortedKeys(state.tasks)) {
    const rt = state.tasks[task];
    const raw = rt.blocked_by?.deps;
    // Open interface/artifact needs are unblocked by the publisher (post_update), not here.
    if (rt.state !== "blocked" || !raw?.length || rt.blocked_by?.escalation !== undefined || rt.blocked_by?.needs?.length) continue;
    const deps = expandDeps(state, raw);
    const dead = deps.filter((d) => {
      const st = own(state.tasks, d)?.state;
      return st === "failed" || st === "cancelled";
    });
    if (dead.length) {
      const esc = escalationAction(state, "dependency_wait", {
        // Keyed by each dep's attempt and finish, so a dep that is retried and fails again escalates again.
        key: `dependency_wait:${task}:${dead.map((d) => `${d}@${state.tasks[d].attempt}:${state.tasks[d].state}:${state.tasks[d].finished_at ?? ""}`).join(",")}`,
        task,
        kind: "blocker",
        with: "orchestrator",
        target: state.contract?.scope.orchestrator,
        summary: `Task ${task} is blocked on ${dead.map((d) => `${d} (${state.tasks[d].state})`).join(", ")}, which will not finish.`,
        options: ["Retry the dependency", "Drop the dependency with amend_contract", "Cancel the task"],
      });
      if (esc) out.push(esc);
      continue;
    }
    if (!deps.every((d) => depSatisfied(state, d))) continue;
    const key = `dependency_wait:${task}`;
    out.push(emitAction("dependency_wait", key, task, [draft("task.unblocked", { task }, key)]));
  }
  return out;
}

/** A check failing with the same signature streak ≥ failureStreak times since the last patch. */
function repeatedFailureRules(state: BlackboardState, cfg: WatchdogConfig): WatchdogAction[] {
  const out: WatchdogAction[] = [];
  for (const scope of ["task", "integration"] as const) {
    const checks = state.checks[scope];
    for (const key of sortedKeys(checks)) {
      const ck = checks[key];
      if (ck.status !== "failed" || ck.signature === undefined || ck.streak < cfg.failureStreak) continue;
      const slash = scope === "task" ? key.indexOf("/") : -1;
      const task = slash > 0 ? key.slice(0, slash) : undefined;
      const command = slash > 0 ? key.slice(slash + 1) : key;
      if (isTerminal(state, task)) continue;
      const where = task !== undefined ? `on task ${task}` : "on the integration branch";
      const esc = escalationAction(state, "repeated_failure", {
        key: `repeated_failure:${scope}:${key}:${ck.signature}:${ck.since_patch_seq}`,
        task,
        kind: "blocker",
        with: "orchestrator",
        target: state.contract?.scope.orchestrator,
        summary: `Check ${command} ${where} failed ${ck.streak} times in a row with the same error and no patch in between.`,
        question: "Should the worker change approach, or does someone else need to step in?",
        options: ["Steer the worker with a directive", "Run a huddle on the failure", "Reassign the task", "Amend the check"],
        diagnostics: {
          command_id: command,
          notes: `signature ${ck.signature}; scope ${scope}; streak ${ck.streak}${ck.blob ? `; output ${ck.blob}` : ""}`,
        },
      });
      if (esc) out.push(esc);
    }
  }
  return out;
}

/** The latest submitted diff equals an earlier, non-adjacent one: A → B → A. */
function diffPingPongRules(state: BlackboardState, obs: Observations): WatchdogAction[] {
  const out: WatchdogAction[] = [];
  for (const task of sortedKeys(obs.diffs)) {
    if (!own(state.tasks, task) || isTerminal(state, task)) continue;
    const h = obs.diffs![task];
    const n = h.length;
    if (n < 3) continue;
    const latest = h[n - 1];
    const j = h.lastIndexOf(latest, n - 2);
    if (j < 0 || j === n - 2) continue;
    const esc = escalationAction(state, "diff_ping_pong", {
      key: `diff_ping_pong:${task}:${[latest, h[j + 1]].sort().join("|")}`,
      task,
      kind: "blocker",
      with: "orchestrator",
      target: state.contract?.scope.orchestrator,
      summary: `Task ${task}'s latest submission repeats an earlier diff (A → B → A): the work is going back and forth.`,
      question: "Which version should stand?",
      options: ["Record a decision and steer the worker", "Run a huddle", "Reassign the task"],
      diagnostics: { notes: `submitted diffs: ${h.slice(j).join(" → ")}` },
    });
    if (esc) out.push(esc);
  }
  return out;
}

/** The last notePingPong notes on a topic alternate between two agents: suggest a micro-huddle between them. */
function notePingPongRules(state: BlackboardState, cfg: WatchdogConfig): WatchdogAction[] {
  const byTopic = new Map<string, BlackboardState["notes"]>();
  for (const n of state.notes) (byTopic.get(n.topic) ?? byTopic.set(n.topic, []).get(n.topic)!).push(n);
  const out: WatchdogAction[] = [];
  for (const topic of [...byTopic.keys()].sort()) {
    const list = byTopic.get(topic)!;
    const i = list.length - 1;
    if (i < 1) continue;
    const a = list[i].agent;
    const b = list[i - 1].agent;
    if (a === b) continue;
    let start = i - 1;
    while (start > 0 && list[start - 1].agent === (list[start].agent === a ? b : a)) start--;
    const run = i - start + 1;
    if (run < cfg.notePingPong) continue;
    const esc = escalationAction(state, "note_ping_pong", {
      key: `note_ping_pong:${topic}:${list[start].seq}`,
      task: own(state.agents, a)?.task,
      agent: a,
      kind: "assistance",
      with: "agent",
      target: b,
      summary: `${a} and ${b} have alternated ${run} notes on topic "${topic}" without settling it; a micro-huddle between them is suggested.`,
      question: `What do ${a} and ${b} need to agree on about "${topic}"?`,
    });
    if (esc) out.push(esc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules: huddles and unanswered escalations
// ---------------------------------------------------------------------------

/** A huddle with no outcome after huddleTimeoutMs concludes NO_OUTCOME and its escalation goes to the orchestrator. */
function huddleTimeoutRules(state: BlackboardState, now: number, obs: Observations, cfg: WatchdogConfig): WatchdogAction[] {
  const orchestrator = state.contract?.scope.orchestrator;
  if (!orchestrator) return [];
  const out: WatchdogAction[] = [];
  for (const id of sortedKeys(state.huddles)) {
    const h = state.huddles[id];
    if (h.outcome !== undefined) continue;
    const startedAt = own(obs.huddles, id)?.startedAt;
    if (startedAt === undefined || now - startedAt < cfg.huddleTimeoutMs) continue;
    const key = `huddle_timeout:${id}`;
    const events = [draft("huddle.concluded", { id, outcome: "NO_OUTCOME" }, key)];
    const esc = own(state.escalations, h.escalation);
    if (esc && (esc.status === "in_huddle" || esc.status === "open" || esc.status === "routed")) {
      events.push(draft("escalation.routed", { id: esc.id, to: orchestrator, wake: true }, key));
    }
    out.push(emitAction("huddle_timeout", key, id, events));
  }
  return out;
}

/**
 * An escalation routed to an orchestrator (the contract's, or any with a watcher entry), still
 * unresolved leadGraceMs after routing, whose watcher is not alive: route it to the contract's
 * lead (which marks it handled) and run the lead fallback. An escalation still routed to the lead
 * leadRetryMs after the fallback was last issued, with no lead call in flight, gets it again: a
 * crash between the commit and the call, or a failed call, loses nothing.
 */
function leadFallbackRules(state: BlackboardState, now: number, obs: Observations, cfg: WatchdogConfig): WatchdogAction[] {
  const c = state.contract;
  const lead = c?.authority.lead;
  if (!c || !lead) return [];
  const out: WatchdogAction[] = [];
  for (const id of sortedKeys(state.escalations)) {
    const esc = state.escalations[id];
    const to = esc.routed_to;
    if (esc.status !== "routed" || to === undefined) continue;
    if (to === lead) {
      if (own(obs.leadInFlight, id)) continue;
      const last = Math.max(own(obs.escalations, id)?.routedAt ?? -Infinity, own(obs.leadIssuedAt, id) ?? -Infinity);
      if (!Number.isFinite(last) || now - last < cfg.leadRetryMs) continue;
      out.push({ type: "lead_fallback", rule: "lead_fallback", key: `lead_fallback:${id}:again:${last}`, target: id, escalation: id });
      continue;
    }
    if (to !== c.scope.orchestrator && own(obs.watchers, to) === undefined) continue;
    const routedAt = own(obs.escalations, id)?.routedAt;
    if (routedAt === undefined || now - routedAt < cfg.leadGraceMs) continue;
    if (watcherAlive(own(obs.watchers, to), now, cfg)) continue;
    const key = `lead_fallback:${id}`;
    out.push(
      emitAction("lead_fallback", key, id, [draft("escalation.routed", { id, to: lead, wake: false }, key)]),
      { type: "lead_fallback", rule: "lead_fallback", key: `${key}:run`, target: id, escalation: id }
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const UNSETTLED: ReadonlySet<string> = new Set(["claim_expiry", "lease_orphan", "lease_withdraw", "lease_grant", "worker_dead"]);

/** A half-open circuit's trial worker that has run circuitTrialMs without failing is a success. */
function trialSuccesses(state: BlackboardState, now: number, obs: Observations, cfg: WatchdogConfig): DriverOutcome[] {
  const out: DriverOutcome[] = [];
  for (const d of sortedKeys(state.watchdog.circuits)) {
    if (circuitStatus(state, d, now) !== "half_open") continue;
    const until = Date.parse(state.watchdog.circuits[d].until!);
    for (const a of sortedKeys(state.agents)) {
      const at = own(obs.spawns, a);
      const rec = state.agents[a];
      if (rec.driver !== d || rec.status !== "running" || at === undefined || at < until) continue;
      if (own(obs.agents, a)?.alive === false || now - at < cfg.circuitTrialMs) continue;
      out.push({ driver: d, at: at + cfg.circuitTrialMs, kind: "success", message: `trial worker ${a} ran ${minutes(cfg.circuitTrialMs)}` });
    }
  }
  return out;
}

/**
 * Every rule, in a fixed order: leases and claims, workers, dependencies, repeated failure, diff
 * and note ping-pong, huddle timeouts, lead fallback, budget, circuits, then deadlocks (skipped in
 * a pass that frees leases or claims, so a cycle about to break is not reported). Actions with the
 * same type and key are emitted once, and at most one kill_worker per agent. A finished run
 * (completed, failed, aborted) yields nothing. Process operations are idempotent for the runner:
 * standing ones repeat on every pass while their condition holds.
 */
export function evaluate(state: BlackboardState, now: number, obs: Observations = {}, cfg: Partial<WatchdogConfig> = {}): WatchdogAction[] {
  if (state.status === "completed" || state.status === "failed" || state.status === "aborted") return [];
  const c: WatchdogConfig = { ...WATCHDOG_DEFAULTS, ...cfg };
  const circuit: CircuitConfig = { windowMs: c.circuitWindowMs, failures: c.circuitFailures, baseMs: c.circuitBaseMs, maxMs: c.circuitMaxMs };
  const outcomes = [...(obs.outcomes ?? []), ...trialSuccesses(state, now, obs, c)];
  const circuits = circuitRules(state, now, { outcomes, history: obs.circuits }, circuit);
  const opening = new Set(
    circuits.flatMap((a) =>
      a.type === "emit" ? a.events.flatMap((e) => (e.type === "watchdog.circuit_opened" ? [e.payload.driver] : [])) : []
    )
  );
  const pass: Pass = { opening, admitted: new Set() };
  const busy = new Set(sortedKeys(obs.agents).filter((a) => obs.agents![a].busy));
  const actions = [
    ...leaseRules(state, now, obs),
    ...workerRules(state, now, obs, c, pass),
    ...dependencyRules(state),
    ...repeatedFailureRules(state, c),
    ...diffPingPongRules(state, obs),
    ...notePingPongRules(state, c),
    ...huddleTimeoutRules(state, now, obs, c),
    ...leadFallbackRules(state, now, obs, c),
    ...budgetRules(state, { busy }),
    ...circuits,
  ];
  if (!actions.some((a) => UNSETTLED.has(a.rule))) actions.push(...deadlockRules(state, obs.needs));
  const seen = new Set<string>();
  return actions.filter((a) => {
    const k = a.type === "kill_worker" ? `kill\0${a.agent}` : `${a.type}\0${a.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The observations derivable from the log, merged under `base` (the runner's process
 * observations, which win): seq times of claims, claim renewals (the claim, any event the
 * claiming agent emits, the task's submission, checks, rejection and merge, and a resume of the
 * run or the task), spawn times, transient driver deaths per task, lead fallback issue times,
 * huddle start and escalation routing times, diff history, open
 * dependency needs, stall counts for base's agents on their current task, driver outcomes and
 * circuit history. Pass the log since the run started; a shorter window undercounts.
 */
/** Events about a claimed task that show it is being worked on: they renew an external claim. */
const RENEWS: ReadonlySet<string> = new Set([
  "task.submitted",
  "task.rejected",
  "task.checks_passed",
  "check.started",
  "check.passed",
  "check.failed",
  "check.timed_out",
  "merge.succeeded",
  "merge.conflicted",
]);

export function observeEvents(events: readonly AnyEvent[], base: Observations = {}): Observations {
  const seqTimes: Record<number, number> = {};
  const claims: Record<string, { renewedAt: number }> = {};
  const claimOf = new Map<string, string>();
  const currentTask = new Map<string, string>();
  const huddles: Record<string, { startedAt: number }> = {};
  const escalations: Record<string, { routedAt: number }> = {};
  const diffs: Record<string, string[]> = {};
  const needs = new Map<string, DependencyNeed>();
  const stalls = new Map<string, { count: number; lastAt: number }>();
  const spawns: Record<string, number> = {};
  const attemptOf = new Map<string, number>();
  const infraDeaths: Record<string, { count: number; lastAttempt: number }> = {};
  const pauseStops: Record<string, { attempt: number; context: string; seq: number }> = {};
  const pausedTasks = new Map<string, string>();
  let runPause: string | undefined;
  const live = new Map<string, string>();
  // The first record of an attempt's stop wins, so its resume keeps one key.
  const stopFor = (t: string, context: string, seq: number) => {
    const attempt = attemptOf.get(t) ?? 0;
    if (own(pauseStops, t)?.attempt !== attempt) putOwn(pauseStops, t, { attempt, context, seq });
  };
  const leadIssuedAt: Record<string, number> = {};
  const needKey = (n: DependencyNeed) => `${n.task}\0${n.need.kind}\0${n.need.ref}`;

  for (const e of events) {
    const at = Date.parse(e.ts);
    if (e.source.kind === "agent") {
      const t = claimOf.get(e.source.id);
      if (t !== undefined) putOwn(claims, t, { renewedAt: at });
    }
    const named = (e.payload as { task?: unknown }).task;
    if (typeof named === "string" && RENEWS.has(e.type) && [...claimOf.values()].includes(named)) putOwn(claims, named, { renewedAt: at });
    switch (e.type) {
      case "task.claimed":
        seqTimes[e.seq] = at;
        attemptOf.set(e.payload.task, e.payload.attempt);
        putOwn(claims, e.payload.task, { renewedAt: at });
        claimOf.set(e.payload.agent, e.payload.task);
        currentTask.set(e.payload.agent, e.payload.task);
        break;
      case "agent.spawned":
        currentTask.set(e.payload.agent, e.payload.task);
        attemptOf.set(e.payload.task, e.payload.attempt);
        putOwn(spawns, e.payload.agent, at);
        live.set(e.payload.agent, e.payload.task);
        delete pauseStops[e.payload.task];
        break;
      case "agent.exited": {
        const t = e.payload.task ?? currentTask.get(e.payload.agent);
        live.delete(e.payload.agent);
        const pause = e.payload.paused ?? (t !== undefined ? runPause ?? pausedTasks.get(t) : undefined);
        if (t !== undefined && pause !== undefined) stopFor(t, pause, e.seq);
        if (t === undefined || e.payload.reason !== "error") break;
        if (classifyFailure(e.payload.result_subtype ?? "", { source: "driver" }) === "error") break;
        putOwn(infraDeaths, t, { count: (own(infraDeaths, t)?.count ?? 0) + 1, lastAttempt: attemptOf.get(t) ?? 0 });
        break;
      }
      case "watchdog.action":
        if (e.payload.rule === "lead_fallback" && e.payload.action === "lead_fallback") putOwn(leadIssuedAt, e.payload.target, at);
        break;
      case "execution.paused": {
        // A worker running when its task is paused was told to stop: its death does not count.
        const scope = e.payload.scope;
        const context = e.correlation ?? e.payload.reason;
        if (scope === "all") runPause = context;
        else for (const t of scope) pausedTasks.set(t, context);
        for (const t of live.values()) if (scope === "all" || scope.includes(t)) stopFor(t, context, e.seq);
        break;
      }
      case "execution.resumed": {
        // Claim TTLs restart on resume (design §3).
        const scope = e.payload.scope;
        for (const t of new Set(claimOf.values())) if (scope === "all" || scope.includes(t)) putOwn(claims, t, { renewedAt: at });
        if (scope === "all") {
          runPause = undefined;
          pausedTasks.clear();
        } else for (const t of scope) pausedTasks.delete(t);
        break;
      }
      case "task.reassigned":
        claimOf.delete(e.payload.from);
        claimOf.set(e.payload.to, e.payload.task);
        break;
      case "task.released":
      case "task.retried":
      case "task.failed":
      case "task.cancelled":
      case "task.accepted":
      case "task.merged":
        for (const [a, t] of claimOf) if (t === e.payload.task) claimOf.delete(a);
        delete pauseStops[e.payload.task];
        break;
      case "huddle.started":
        putOwn(huddles, e.payload.id, { startedAt: at });
        break;
      case "escalation.routed":
        putOwn(escalations, e.payload.id, { routedAt: at });
        break;
      case "task.submitted":
        if (!Object.hasOwn(diffs, e.payload.task)) putOwn(diffs, e.payload.task, []);
        diffs[e.payload.task].push(e.payload.diff_blob);
        break;
      case "dependency.requested":
        needs.set(needKey(e.payload), { task: e.payload.task, need: { ...e.payload.need } });
        break;
      case "dependency.satisfied":
        needs.delete(needKey(e.payload));
        break;
      case "watchdog.stall_detected":
        if (e.payload.task !== undefined) {
          const s = stalls.get(e.payload.task);
          stalls.set(e.payload.task, { count: (s?.count ?? 0) + 1, lastAt: at });
        }
        break;
      default:
        break;
    }
  }

  const agents: Record<string, AgentObservation> = {};
  for (const a of sortedKeys(base.agents)) {
    const t = currentTask.get(a);
    const s = t !== undefined ? stalls.get(t) : undefined;
    putOwn(agents, a, s ? { stalls: s.count, lastStallAt: s.lastAt, ...base.agents![a] } : { ...base.agents![a] });
  }
  for (const t of sortedKeys(base.claims)) {
    const mine = own(claims, t)?.renewedAt ?? -Infinity;
    putOwn(claims, t, { renewedAt: Math.max(mine, base.claims![t].renewedAt) });
  }
  const derived = outcomesFromEvents(events);
  return {
    ...base,
    agents,
    claims,
    seqTimes: { ...seqTimes, ...base.seqTimes },
    huddles: { ...huddles, ...base.huddles },
    escalations: { ...escalations, ...base.escalations },
    diffs: { ...diffs, ...base.diffs },
    outcomes: [...derived.outcomes, ...(base.outcomes ?? [])],
    circuits: { ...derived.history, ...base.circuits },
    needs: base.needs ?? [...needs.values()],
    spawns: { ...spawns, ...base.spawns },
    infraDeaths: { ...infraDeaths, ...base.infraDeaths },
    pauseStops: { ...pauseStops, ...base.pauseStops },
    leadIssuedAt: { ...leadIssuedAt, ...base.leadIssuedAt },
  };
}
