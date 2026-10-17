// Blackboard builders and a minimal reducer for the watchdog tests.
//
// applyDrafts mirrors the reducer (src/execution/blackboard.ts) for exactly the event types the
// watchdog emits, so a test can apply evaluate()'s drafts by hand and evaluate again. Any other
// type throws, so a new watchdog event cannot slip through untested. The watchdog tests also check
// that it agrees with the real reducer on every scenario.

const BB = await import("../../dist/execution/blackboard.js");
const EV = await import("../../dist/execution/events.js");
const WD = await import("../../dist/execution/watchdog.js");

export const MIN = 60_000;
export const SEC = 1000;
export const T0 = Date.parse("2026-10-15T12:00:00.000Z");
export const RUNNER = { kind: "runner", id: "runner", pid: 1 };

export function contract(over = {}) {
  return {
    schema: "roundtable.contract/1",
    id: "ctr-abc123-1",
    version: 1,
    status: "frozen",
    title: "Test contract",
    goal: { ultimate: "Ship the feature", original_prompt: "Ship the feature", artifacts: [] },
    scope: { orchestrator: "main", repo_root: "/repo", base_ref: "main", paths: ["**"] },
    participants: [],
    teams: [],
    tasks: [],
    interfaces: [],
    decisions: [],
    validation: { commands: [], final: [] },
    budget: { usd: 100, per_task_usd: 20, wall_clock_min: 120, max_parallel: 3, max_attempts: 3 },
    authority: { lead: "lead", may: ["retry", "reassign", "resolve_merge"], budget_extension_pct: 0 },
    sandbox: { backend: "docker", image: "node:22" },
    workers: { driver: "claude-code", model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5" },
    consent: [],
    ...over,
    budget: { usd: 100, per_task_usd: 20, wall_clock_min: 120, max_parallel: 3, max_attempts: 3, ...over.budget },
  };
}

export function task(id, over = {}) {
  const { spec, ...rest } = over;
  return {
    spec: { id, title: id, persona: "dev", kind: "build", depends_on: [], paths: { write: [`src/${id}/**`] }, acceptance: [], checks: [], ...spec },
    state: "ready",
    attempt: 0,
    ...rest,
  };
}

export function agent(id, over = {}) {
  return { id, persona: "dev", driver: "claude-code", external: false, token_sha256: "0".repeat(64), status: "running", ...over };
}

/** A complete BlackboardState; tasks/agents are arrays of records, everything else overrides. contract: null for none. */
export function makeState({ tasks = [], agents = [], contract: c = contract(), budget = {}, watchdog = {}, ...rest } = {}) {
  const s = {
    execution: "exe-0000000000abc123",
    seq: 100,
    hash: "0".repeat(64),
    status: "running",
    paused_tasks: [],
    contract: c,
    goal: c?.goal,
    interfaces: {},
    decisions: [],
    tasks: Object.fromEntries(tasks.map((t) => [t.spec.id, t])),
    claims: {},
    leases: {},
    lease_queue: [],
    files: {},
    diffs: {},
    checks: { task: {}, integration: {} },
    escalations: {},
    huddles: {},
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    teams: {},
    budget: { spent_usd: 0, estimated: false, by_agent: {}, by_task: {}, by_team: {}, thresholds_crossed: [], extensions_usd: 0, ...budget },
    notes: [],
    inbox: {},
    watchdog: { circuits: {}, deadlocks: [], ...watchdog },
    ...rest,
  };
  if (c === null) {
    delete s.contract;
    delete s.goal;
  }
  return s;
}

/** Put a runner worker (ttl 0) or an external agent (ttl > 0) on a task. */
export function claim(state, taskId, agentId, { attempt = 1, ttl_s = 0, granted_seq = 10, taskState = "in_progress", agentOver = {} } = {}) {
  state.tasks[taskId].state = taskState;
  state.tasks[taskId].agent = agentId;
  state.tasks[taskId].attempt = attempt;
  state.claims[taskId] = { task: taskId, agent: agentId, attempt, ttl_s, granted_seq };
  state.agents[agentId] = agent(agentId, { task: taskId, pid: 4242, external: ttl_s > 0, ...agentOver });
  return state;
}

export function lease(id, taskId, agentId, paths, mode = "exclusive", granted_seq = 20) {
  return { id, agent: agentId, task: taskId, paths, mode, branch: `rt/abc123/${taskId}`, reason: "edit", granted_seq };
}

export function request(id, taskId, agentId, paths, mode, blocking, requested_seq) {
  return { id, agent: agentId, task: taskId, paths, mode, reason: "edit", requested_seq, blocking };
}

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

export const emitted = (actions) => actions.filter((a) => a.type === "emit").flatMap((a) => a.events);
export const eventTypes = (actions) => emitted(actions).map((e) => e.type);
export const ofType = (actions, type) => emitted(actions).filter((e) => e.type === type);
export const opsOf = (actions) => actions.filter((a) => a.type !== "emit");
export const escalations = (actions) => ofType(actions, "escalation.raised").map((e) => e.payload.escalation);
/** Actions that are not standing repeats: what a pass newly decided. */
export const fresh = (actions) => actions.filter((a) => !a.standing);

// ---------------------------------------------------------------------------
// A small runner simulator over the real store pieces
// ---------------------------------------------------------------------------

/**
 * evaluate → actionsToDrafts → validateDraft → the strict reducer, with a log that observeEvents
 * rebuilds the observations from on every step (as the runner would after a restart).
 */
export class World {
  constructor(state, now = T0) {
    this.state = structuredClone(state);
    this.now = now;
    this.log = [];
  }
  commit(drafts) {
    for (const d of drafts) {
      const v = EV.validateDraft(d);
      const seq = this.state.seq + 1;
      const event = { ...v, v: 1, id: `evt-${seq}`, seq, ts: new Date(this.now).toISOString(), execution: this.state.execution, mode: "execution", prev: "0".repeat(64), hash: "0".repeat(64) };
      BB.applyInPlace(this.state, event, {}, { strict: true });
      this.log.push(event);
    }
  }
  emit(type, payload, source = RUNNER) {
    this.commit([{ type, payload, source }]);
  }
  /** One watchdog pass; `base` is the runner's process observations. Returns the actions. */
  step(base = {}, cfg = {}) {
    const actions = WD.evaluate(this.state, this.now, WD.observeEvents(this.log, base), cfg);
    this.commit(WD.actionsToDrafts(actions, { pid: 99 }));
    return actions;
  }
}

// ---------------------------------------------------------------------------
// Minimal reducer
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["accepted", "failed", "cancelled"]);

function endLease(s, id) {
  delete s.leases[id];
  s.lease_queue = s.lease_queue.filter((r) => r.id !== id).map((r) => ({ ...r, blocking: r.blocking.filter((b) => b !== id) }));
}

const depsAccepted = (s, rt) => rt.spec.depends_on.every((d) => s.tasks[d]?.state === "accepted");

const HANDLERS = {
  "lease.granted": (s, p, seq) => {
    s.leases[p.lease.id] = { ...structuredClone(p.lease), granted_seq: seq };
    s.lease_queue = s.lease_queue.filter((r) => r.id !== p.lease.id);
  },
  "lease.released": (s, p) => endLease(s, p.lease_id),
  "lease.expired": (s, p) => endLease(s, p.lease_id),
  "task.released": (s, p) => {
    const rt = s.tasks[p.task];
    const claimed = p.task in s.claims;
    delete s.claims[p.task];
    if (!rt || !claimed || TERMINAL.has(rt.state)) return;
    rt.state = "ready";
    delete rt.agent;
    if (p.note !== undefined) rt.last_note = p.note;
  },
  "task.retried": (s, p) => {
    const rt = s.tasks[p.task];
    if (!rt || rt.state === "accepted" || rt.state === "cancelled") return;
    rt.state = "ready";
    rt.attempt = p.attempt;
    rt.last_note = p.why;
    delete rt.agent;
    delete rt.blocked_by;
    delete s.claims[p.task];
  },
  "task.failed": (s, p) => {
    const rt = s.tasks[p.task];
    if (!rt) return;
    rt.state = "failed";
    rt.last_note = p.why;
    delete rt.blocked_by;
    delete s.claims[p.task];
  },
  "task.blocked": (s, p) => {
    const rt = s.tasks[p.task];
    if (!rt || TERMINAL.has(rt.state)) return;
    const prev = rt.state === "blocked" ? rt.blocked_by : undefined;
    rt.state = "blocked";
    const escalation = p.escalation ?? prev?.escalation;
    const deps = [...new Set([...(prev?.deps ?? []), ...(p.deps ?? [])])];
    const needs = rt.blocked_by?.needs;
    rt.blocked_by = {
      ...(escalation !== undefined ? { escalation } : {}),
      ...(deps.length || p.deps ? { deps } : {}),
      ...(needs?.length ? { needs } : {}),
    };
  },
  "task.unblocked": (s, p) => {
    const rt = s.tasks[p.task];
    if (!rt || rt.state !== "blocked") return;
    delete rt.blocked_by;
    rt.state = s.claims[p.task] ? "in_progress" : depsAccepted(s, rt) ? "ready" : "pending";
  },
  "agent.exited": (s, p) => {
    const rec = s.agents[p.agent];
    if (!rec) return;
    rec.status = "exited";
    delete rec.pid;
  },
  "escalation.raised": (s, p, seq) => {
    s.escalations[p.escalation.id] = { ...structuredClone(p.escalation), status: "open", raised_seq: seq };
  },
  "escalation.routed": (s, p) => {
    const esc = s.escalations[p.id];
    if (!esc) return;
    esc.status = "routed";
    esc.routed_to = p.to;
  },
  "escalation.awaiting_human": (s, p) => {
    const esc = s.escalations[p.id];
    if (!esc) return;
    esc.status = "awaiting_human";
    esc.emergency = p.class;
  },
  "huddle.concluded": (s, p) => {
    const h = s.huddles[p.id];
    if (!h) return;
    h.outcome = p.outcome;
    if (p.decision !== undefined) h.decision = p.decision;
  },
  "budget.threshold_crossed": (s, p) => {
    if (s.budget.thresholds_budget_usd !== undefined && s.budget.thresholds_budget_usd !== p.budget_usd) s.budget.thresholds_crossed = [];
    s.budget.thresholds_budget_usd = p.budget_usd;
    if (!s.budget.thresholds_crossed.includes(p.pct)) s.budget.thresholds_crossed = [...s.budget.thresholds_crossed, p.pct].sort((a, b) => a - b);
  },
  "budget.exhausted": () => {},
  "watchdog.action": () => {},
  "watchdog.stall_detected": () => {},
  "watchdog.circuit_opened": (s, p) => {
    s.watchdog.circuits[p.driver] = { open: true, until: p.until, reason: p.reason, ...(p.opens !== undefined ? { opens: p.opens } : {}) };
  },
  "watchdog.circuit_closed": (s, p) => {
    const until = s.watchdog.circuits[p.driver]?.until;
    s.watchdog.circuits[p.driver] = until !== undefined ? { open: false, until } : { open: false };
  },
  "watchdog.deadlock_detected": (s, p) => {
    s.watchdog.deadlocks.push([...p.cycle]);
  },
};

/** A copy of `state` with the drafts applied in order (seq advances by one per draft). */
export function applyDrafts(state, drafts) {
  const s = structuredClone(state);
  for (const d of drafts) {
    const h = HANDLERS[d.type];
    if (!h) throw new Error(`applyDrafts: no handler for ${d.type}`);
    s.seq += 1;
    h(s, d.payload, s.seq);
  }
  return s;
}
