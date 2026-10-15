import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN,
  T0,
  agent,
  applyDrafts,
  claim,
  emitted,
  escalations,
  eventTypes,
  lease,
  makeState,
  ofType,
  opsOf,
  request,
  task,
} from "../fixtures/execution-state.mjs";

const {
  evaluate,
  actionsToDrafts,
  observeEvents,
  staticPrefix,
  globsOverlap,
  leasesConflict,
  escalationId,
  processActions,
  WATCHDOG_DEFAULTS,
} = await import("../../dist/execution/watchdog.js");

/** Apply a pass's drafts (audit included: watchdog.action is a no-op on the blackboard). */
const settle = (state, actions) => applyDrafts(state, actionsToDrafts(actions));

// ---------------------------------------------------------------------------
// Lease overlap
// ---------------------------------------------------------------------------

test("static-prefix overlap is conservative and segment-wise", () => {
  const cases = [
    ["src/**", "src/a.ts", true],
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/a/*.ts", "src/a/b/c.ts", true],
    ["src/a*", "src/b.ts", true],
    ["src/a/**", "src/b/**", false],
    ["src/ab/**", "src/a/**", false],
    ["**", "docs/x.md", true],
    ["./src/x", "src/x/y", true],
    ["docs/**", "src/**", false],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(globsOverlap(a, b), want, `${a} vs ${b}`);
    assert.equal(globsOverlap(b, a), want, `${b} vs ${a}`);
  }
  assert.deepEqual(staticPrefix("src/a/*.ts"), ["src", "a"]);
  assert.deepEqual(staticPrefix("**"), []);
});

test("exclusive conflicts with any overlap, shared only with exclusive", () => {
  const cases = [
    ["shared", "shared", ["src/**"], ["src/a"], false],
    ["shared", "exclusive", ["src/**"], ["src/a"], true],
    ["exclusive", "exclusive", ["src/**"], ["src/a"], true],
    ["exclusive", "exclusive", ["src/**"], ["docs/a"], false],
  ];
  for (const [ma, mb, pa, pb, want] of cases) {
    assert.equal(leasesConflict({ mode: ma, paths: pa }, { mode: mb, paths: pb }), want, `${ma}/${mb}`);
  }
});

// ---------------------------------------------------------------------------
// Claim expiry and queue grants
// ---------------------------------------------------------------------------

function leaseScenario() {
  const s = makeState({ tasks: ["a", "b", "c", "d", "e", "f", "g"].map((id) => task(id)) });
  claim(s, "a", "ext-1", { ttl_s: 900, granted_seq: 10, agentOver: { driver: "external" } });
  for (const id of ["b", "c", "d", "e", "f", "g"]) claim(s, id, `w-${id}`);
  s.leases = { L1: lease("L1", "a", "ext-1", ["src/**"]), L9: lease("L9", "f", "w-f", ["docs/**"]) };
  s.lease_queue = [
    request("R1", "b", "w-b", ["src/a/**"], "shared", ["L1"], 30),
    request("R2", "c", "w-c", ["src/b/**"], "shared", ["L1"], 31),
    request("R3", "d", "w-d", ["src/**"], "exclusive", ["L1"], 32),
    request("R5", "g", "w-g", ["src/c/**"], "shared", ["L1"], 33),
    request("R4", "e", "w-e", ["docs/**"], "shared", ["L9"], 34),
    request("Ra", "a", "ext-1", ["lib/**"], "exclusive", ["L9"], 35),
  ];
  return s;
}

test("an expired external claim frees its leases and the queue head is granted in order", () => {
  const s = leaseScenario();
  const obs = { seqTimes: { 10: T0 - 16 * MIN } }; // ttl 900 s = 15 min
  const actions = evaluate(s, T0, obs);

  const expiry = actions.find((a) => a.rule === "claim_expiry");
  assert.equal(expiry.target, "a");
  assert.deepEqual(
    expiry.events.map((e) => [e.type, e.payload.lease_id ?? e.payload.task]),
    [
      ["lease.expired", "L1"],
      ["lease.released", "Ra"],
      ["task.released", "a"],
    ]
  );
  assert.equal(expiry.events[2].payload.agent, "ext-1");
  assert.match(expiry.events[2].payload.note, /worktree/);

  // R1 and R2 are shared and disjoint; R3 (exclusive) conflicts with them; R5 may not overtake R3; R4 waits for L9.
  const granted = ofType(actions, "lease.granted").map((e) => e.payload.lease);
  assert.deepEqual(granted.map((l) => l.id), ["R1", "R2"]);
  assert.deepEqual(granted[0], {
    id: "R1",
    agent: "w-b",
    task: "b",
    paths: ["src/a/**"],
    mode: "shared",
    branch: "rt/abc123/b",
    reason: "edit",
    granted_seq: 0,
  });
  for (const e of emitted(actions)) assert.deepEqual(e.source, { kind: "watchdog", id: "watchdog", pid: 0 });

  // Idempotent: once applied, nothing is left to do.
  const after = settle(s, actions);
  assert.equal(after.tasks.a.state, "ready");
  assert.deepEqual(Object.keys(after.leases).sort(), ["L9", "R1", "R2"]);
  assert.deepEqual(evaluate(after, T0 + 1000, obs), []);
});

test("a renewed, unknown or runner claim does not expire", () => {
  const s = leaseScenario();
  assert.deepEqual(evaluate(s, T0, { claims: { a: { renewedAt: T0 - 5 * MIN } }, seqTimes: { 10: T0 - 60 * MIN } }), []);
  assert.deepEqual(evaluate(s, T0, {}), [], "no renewal time known");
  const runner = makeState({ tasks: [task("x")] });
  claim(runner, "x", "w-x", { ttl_s: 0, granted_seq: 10 });
  assert.deepEqual(evaluate(runner, T0, { seqTimes: { 10: T0 - 600 * MIN } }), []);
});

test("leases of finished tasks expire and free their waiters", () => {
  const s = makeState({ tasks: [task("done", { state: "accepted" }), task("next")] });
  claim(s, "next", "w-next");
  s.leases = { L2: lease("L2", "done", "w-done", ["src/**"]) };
  s.lease_queue = [request("R1", "next", "w-next", ["src/x/**"], "exclusive", ["L2"], 40)];
  const actions = evaluate(s, T0, {});
  assert.deepEqual(
    actions.map((a) => [a.rule, a.events[0].type]),
    [
      ["lease_orphan", "lease.expired"],
      ["lease_grant", "lease.granted"],
    ]
  );
  assert.deepEqual(evaluate(settle(s, actions), T0, {}), []);
});

// ---------------------------------------------------------------------------
// Dead or lost workers
// ---------------------------------------------------------------------------

function workerState({ attempt = 1, status = "running" } = {}) {
  const s = makeState({ tasks: [task("t")] });
  claim(s, "t", "w-t", { attempt, agentOver: { status } });
  return s;
}

const deadCases = [
  {
    name: "an exited worker is retried with attempt+1",
    state: () => workerState({ status: "exited" }),
    obs: {},
    events: ["task.retried"],
    ops: [["spawn_retry", { task: "t", attempt: 2 }]],
  },
  {
    name: "a lost worker (pid gone) is recorded and retried",
    state: () => workerState(),
    obs: { agents: { "w-t": { alive: false, pid: 4242 } } },
    events: ["agent.exited", "task.retried"],
    ops: [["spawn_retry", { task: "t", attempt: 2 }]],
  },
  {
    name: "the last attempt fails the task and escalates",
    state: () => workerState({ attempt: 3, status: "exited" }),
    obs: {},
    events: ["task.failed", "escalation.raised"],
    ops: [],
  },
  {
    name: "a busy agent is left alone",
    state: () => workerState(),
    obs: { agents: { "w-t": { alive: false, busy: true } } },
    events: [],
    ops: [],
  },
  {
    name: "a running agent the runner reports nothing about is left alone",
    state: () => workerState(),
    obs: {},
    events: [],
    ops: [],
  },
  {
    name: "a paused task is not retried",
    state: () => Object.assign(workerState({ status: "exited" }), { paused_tasks: ["t"] }),
    obs: {},
    events: [],
    ops: [],
  },
  {
    name: "a task at its budget cap is not respawned",
    state: () => {
      const s = workerState({ status: "exited" });
      s.budget.spent_usd = 20;
      s.budget.by_task = { t: 20 };
      return s;
    },
    obs: {},
    events: [],
    ops: [],
  },
  {
    name: "an open circuit on the driver holds the retry (a lost worker is still recorded)",
    state: () => {
      const s = workerState();
      s.watchdog.circuits["claude-code"] = { open: true, until: new Date(T0 + MIN).toISOString(), reason: "429" };
      return s;
    },
    obs: { agents: { "w-t": { alive: false } } },
    events: ["agent.exited"],
    ops: [],
  },
];

for (const c of deadCases) {
  test(`worker: ${c.name}`, () => {
    const s = c.state();
    const actions = evaluate(s, T0, c.obs).filter((a) => a.rule === "worker_dead");
    assert.deepEqual(eventTypes(actions), c.events);
    assert.deepEqual(
      opsOf(actions).map(({ type, task, attempt }) => [type, { task, attempt }]),
      c.ops
    );
    const after = settle(s, actions);
    assert.deepEqual(evaluate(after, T0 + 1000, c.obs).filter((a) => a.rule === "worker_dead"), [], "idempotent");
  });
}

test("worker: the failure escalation names the attempts and goes to the orchestrator", () => {
  const s = workerState({ attempt: 3, status: "exited" });
  const actions = evaluate(s, T0, {});
  const [esc] = escalations(actions);
  assert.equal(esc.kind, "blocker");
  assert.equal(esc.with, "orchestrator");
  assert.equal(esc.target, "main");
  assert.equal(esc.task, "t");
  assert.equal(esc.blocking, false);
  assert.match(esc.summary, /attempt 3 of 3/);
  assert.equal(ofType(actions, "task.failed")[0].payload.task, "t");
  const after = settle(s, actions);
  assert.equal(after.tasks.t.state, "failed");
  assert.equal(after.escalations[esc.id].status, "open");
});

// ---------------------------------------------------------------------------
// Stalls
// ---------------------------------------------------------------------------

const live = (over = {}) => ({ "w-t": { alive: true, pid: 4242, startedAt: T0 - 30 * MIN, lastOutputAt: T0 - 11 * MIN, ...over } });

const stallCases = [
  { name: "first stall: kill, then resume", obs: live(), ops: ["kill_worker", "resume_worker"], events: ["watchdog.stall_detected"] },
  {
    name: "second stall on the task: kill, block and escalate",
    obs: live({ stalls: 1, lastStallAt: T0 - 40 * MIN }),
    ops: ["kill_worker"],
    events: ["watchdog.stall_detected", "escalation.raised", "task.blocked"],
  },
  { name: "recent output", obs: live({ lastOutputAt: T0 - 5 * MIN }), ops: [], events: [] },
  { name: "a recent heartbeat counts as activity", obs: live({ lastHeartbeatAt: T0 - MIN }), ops: [], events: [] },
  { name: "a stall just handled is not repeated", obs: live({ stalls: 1, lastStallAt: T0 - MIN }), ops: [], events: [] },
  { name: "a freshly resumed process gets its own window", obs: live({ startedAt: T0 - 2 * MIN }), ops: [], events: [] },
  { name: "no times known", obs: { "w-t": { alive: true } }, ops: [], events: [] },
];

for (const c of stallCases) {
  test(`stall: ${c.name}`, () => {
    const s = workerState();
    const actions = evaluate(s, T0, { agents: c.obs });
    assert.deepEqual(eventTypes(actions), c.events);
    assert.deepEqual(opsOf(actions).map((a) => a.type), c.ops);
  });
}

test("stall: a task waiting on its submit checks is not a stall", () => {
  const s = workerState();
  s.tasks.t.state = "checking";
  assert.deepEqual(evaluate(s, T0, { agents: live() }), []);
});

test("stall: the full sequence, applied by hand, escalates on the second stall only", () => {
  let s = workerState();
  let obs = { agents: live() };
  const first = evaluate(s, T0, obs);
  assert.deepEqual(opsOf(first).map((a) => [a.type, a.agent]), [
    ["kill_worker", "w-t"],
    ["resume_worker", "w-t"],
  ]);
  assert.equal(opsOf(first)[1].task, "t");
  assert.match(opsOf(first)[0].reason, /no output or heartbeat for 11 min/);

  // The runner applies it: the stall is counted, the resumed process starts, prints nothing.
  s = settle(s, first);
  obs = { agents: live({ stalls: 1, lastStallAt: T0, startedAt: T0 + 1000 }) };
  assert.deepEqual(evaluate(s, T0 + 2000, obs), [], "nothing new right after");

  const second = evaluate(s, T0 + 11 * MIN, obs);
  const [esc] = escalations(second);
  assert.equal(esc.kind, "blocker");
  assert.equal(esc.blocking, true);
  assert.match(esc.summary, /stall 2/);
  assert.deepEqual(opsOf(second).map((a) => a.type), ["kill_worker"]);
  s = settle(s, second);
  assert.equal(s.tasks.t.state, "blocked");
  assert.deepEqual(s.tasks.t.blocked_by, { escalation: esc.id });
  assert.deepEqual(evaluate(s, T0 + 12 * MIN, obs), []);
});

// ---------------------------------------------------------------------------
// Dependency wait
// ---------------------------------------------------------------------------

test("a task blocked on deps is unblocked once every dep is accepted or published", () => {
  const cases = [
    { deps: ["a", "b"], a: "accepted", b: "in_progress", want: false },
    { deps: ["a", "b"], a: "accepted", b: "accepted", want: true },
    { deps: ["api"], iface: 1, want: true },
    { deps: ["api"], iface: 0, want: false },
    { deps: ["a"], a: "accepted", escalation: "esc-1", want: false },
  ];
  for (const c of cases) {
    const s = makeState({ tasks: [task("a", { state: c.a ?? "ready" }), task("b", { state: c.b ?? "ready" }), task("t")] });
    s.tasks.t.state = "blocked";
    s.tasks.t.blocked_by = { deps: c.deps, ...(c.escalation ? { escalation: c.escalation } : {}) };
    if (c.iface !== undefined) s.interfaces.api = { version: c.iface };
    const actions = evaluate(s, T0, {});
    assert.deepEqual(eventTypes(actions), c.want ? ["task.unblocked"] : [], JSON.stringify(c));
    if (c.want) assert.deepEqual(evaluate(settle(s, actions), T0, {}), []);
  }
});

// ---------------------------------------------------------------------------
// Repeated failure and diff ping-pong
// ---------------------------------------------------------------------------

function failing(streak, since_patch_seq = 0, signature = "sig-1") {
  const s = makeState({ tasks: [task("t")] });
  claim(s, "t", "w-t");
  s.checks.task["t/unit"] = { status: "failed", signature, streak, since_patch_seq, blob: "sha256:out", at_seq: 90 };
  return s;
}

test("three identical check failures with no patch escalate once, with diagnostics", () => {
  assert.deepEqual(evaluate(failing(2), T0, {}), []);
  const s = failing(3);
  const actions = evaluate(s, T0, {});
  assert.equal(actions.length, 1);
  const [a] = actions;
  assert.equal(a.rule, "repeated_failure");
  assert.equal(a.diagnostics.command_id, "unit");
  assert.match(a.diagnostics.notes, /signature sig-1/);
  assert.match(a.diagnostics.notes, /sha256:out/);
  const [esc] = escalations(actions);
  assert.equal(esc.kind, "blocker");
  assert.equal(esc.with, "orchestrator");
  assert.equal(esc.task, "t");
  assert.match(esc.summary, /unit on task t failed 3 times/);

  // The same streak growing is the same escalation.
  const after = settle(s, actions);
  after.checks.task["t/unit"].streak = 4;
  assert.deepEqual(evaluate(after, T0, {}), []);

  // A patch resets the streak; a new streak of 3 after it is a new escalation.
  after.checks.task["t/unit"] = { ...after.checks.task["t/unit"], streak: 0, since_patch_seq: 150 };
  assert.deepEqual(evaluate(after, T0, {}), []);
  after.checks.task["t/unit"].streak = 3;
  const again = escalations(evaluate(after, T0, {}));
  assert.equal(again.length, 1);
  assert.notEqual(again[0].id, esc.id);
});

test("an integration check streak escalates without a task; a finished task's does not", () => {
  const s = makeState({ tasks: [task("t", { state: "accepted" })] });
  s.checks.integration.smoke = { status: "failed", signature: "sig-2", streak: 3, since_patch_seq: 0, at_seq: 1 };
  s.checks.task["t/unit"] = { status: "failed", signature: "sig-1", streak: 5, since_patch_seq: 0, at_seq: 1 };
  const escs = escalations(evaluate(s, T0, {}));
  assert.equal(escs.length, 1);
  assert.equal(escs[0].task, undefined);
  assert.match(escs[0].summary, /integration branch/);
});

test("diff ping-pong A → B → A escalates; adjacent repeats and fresh diffs do not", () => {
  const cases = [
    [["A", "B", "A"], true],
    [["A", "B", "C", "A"], true],
    [["A", "B", "A", "B"], true],
    [["A", "A"], false],
    [["A", "B"], false],
    [["A", "B", "B"], false],
    [["A", "B", "C"], false],
  ];
  for (const [history, want] of cases) {
    const s = makeState({ tasks: [task("t", { state: "in_progress" })] });
    const actions = evaluate(s, T0, { diffs: { t: history } });
    assert.equal(escalations(actions).length, want ? 1 : 0, history.join(""));
    if (want) {
      assert.equal(actions[0].rule, "diff_ping_pong");
      assert.deepEqual(evaluate(settle(s, actions), T0, { diffs: { t: history } }), []);
    }
  }
});

// ---------------------------------------------------------------------------
// Note ping-pong
// ---------------------------------------------------------------------------

test("two agents alternating four notes on a topic get a micro-huddle suggestion", () => {
  const cases = [
    [["x", "y", "x", "y"], true],
    [["x", "x", "y", "x", "y"], true],
    [["x", "y", "x"], false],
    [["x", "y", "z", "y"], false],
    [["x", "y", "y", "x"], false],
  ];
  for (const [seq, want] of cases) {
    const s = makeState({ agents: [agent("x", { task: "tx" }), agent("y", { task: "ty" })] });
    s.notes = seq.map((a, i) => ({ seq: 50 + i, agent: a, topic: "api-shape", text: `note ${i}`, refs: [] }));
    s.notes.push({ seq: 70, agent: "x", topic: "other", text: "unrelated", refs: [] });
    const escs = escalations(evaluate(s, T0, {}));
    assert.equal(escs.length, want ? 1 : 0, seq.join(""));
    if (want) {
      const [esc] = escs;
      assert.equal(esc.kind, "assistance");
      assert.equal(esc.with, "agent");
      assert.deepEqual([esc.agent, esc.target].sort(), ["x", "y"]);
      assert.equal(esc.task, `t${esc.agent}`);
      assert.match(esc.summary, /micro-huddle/);
    }
  }
});

test("note ping-pong is suggested once per run of alternation", () => {
  const s = makeState({ agents: [agent("x"), agent("y")] });
  s.notes = ["x", "y", "x", "y"].map((a, i) => ({ seq: 50 + i, agent: a, topic: "t", text: "", refs: [] }));
  const after = settle(s, evaluate(s, T0, {}));
  after.notes.push({ seq: 60, agent: "x", topic: "t", text: "", refs: [] });
  assert.deepEqual(evaluate(after, T0, {}), [], "the same run continuing");
});

// ---------------------------------------------------------------------------
// Huddle timeout and lead fallback
// ---------------------------------------------------------------------------

function huddleState(outcome) {
  const s = makeState({ tasks: [task("t", { state: "blocked" })] });
  s.escalations["esc-1"] = {
    id: "esc-1",
    task: "t",
    agent: "w-t",
    kind: "conflict",
    with: "path_owner",
    summary: "s",
    blocking: true,
    status: "in_huddle",
    huddle: "hud-1",
    raised_seq: 50,
  };
  s.huddles["hud-1"] = { escalation: "esc-1", format: "micro", seats: ["w-t", "w-u"], ...(outcome ? { outcome } : {}) };
  return s;
}

test("a huddle without an outcome after the timeout concludes and goes to the orchestrator", () => {
  const s = huddleState();
  const obs = { huddles: { "hud-1": { startedAt: T0 - 21 * MIN } } };
  const actions = evaluate(s, T0, obs);
  assert.deepEqual(
    emitted(actions).map((e) => [e.type, e.payload]),
    [
      ["huddle.concluded", { id: "hud-1", outcome: "NO_OUTCOME" }],
      ["escalation.routed", { id: "esc-1", to: "main", wake: true }],
    ]
  );
  assert.deepEqual(evaluate(settle(s, actions), T0, obs), []);

  assert.deepEqual(evaluate(huddleState("AGREED"), T0, obs), [], "concluded");
  assert.deepEqual(evaluate(s, T0, { huddles: { "hud-1": { startedAt: T0 - 5 * MIN } } }), [], "still within the timeout");
  assert.deepEqual(evaluate(s, T0, {}), [], "start time unknown");
  assert.equal(evaluate(s, T0, obs, { huddleTimeoutMs: 30 * MIN }).length, 0, "configurable");
});

function routedState(to = "main", status = "routed") {
  const s = makeState({ tasks: [task("t", { state: "blocked" })] });
  s.escalations["esc-2"] = {
    id: "esc-2",
    task: "t",
    agent: "w-t",
    kind: "ambiguity",
    with: "orchestrator",
    summary: "Which API shape?",
    blocking: true,
    status,
    routed_to: to,
    raised_seq: 60,
  };
  return s;
}

test("an unanswered escalation falls back to the lead when the orchestrator's watcher is not alive", () => {
  const routed = { escalations: { "esc-2": { routedAt: T0 - 3 * MIN } } };
  const cases = [
    { name: "watcher dead", watchers: { main: { alive: false } }, want: true },
    { name: "no watcher at all", watchers: {}, want: true },
    { name: "watcher alive", watchers: { main: { alive: true, lastSeenAt: T0 - 5000 } }, want: false },
    { name: "watcher alive but stale", watchers: { main: { alive: true, lastSeenAt: T0 - 2 * MIN } }, want: true },
  ];
  for (const c of cases) {
    const s = routedState();
    const obs = { ...routed, watchers: c.watchers };
    const actions = evaluate(s, T0, obs);
    if (!c.want) {
      assert.deepEqual(actions, [], c.name);
      continue;
    }
    assert.deepEqual(
      actions.map((a) => [a.type, a.rule]),
      [
        ["emit", "lead_fallback"],
        ["lead_fallback", "lead_fallback"],
      ],
      c.name
    );
    assert.equal(actions[1].escalation, "esc-2");
    assert.deepEqual(actions[0].events[0].payload, { id: "esc-2", to: "lead", wake: false });
    assert.deepEqual(evaluate(settle(s, actions), T0 + 1000, obs), [], `${c.name}: idempotent`);
  }
});

test("lead fallback waits out the grace period and skips other routes", () => {
  const dead = { watchers: { main: { alive: false } } };
  assert.deepEqual(evaluate(routedState(), T0, { ...dead, escalations: { "esc-2": { routedAt: T0 - MIN } } }), []);
  const old = { ...dead, escalations: { "esc-2": { routedAt: T0 - 10 * MIN } } };
  assert.deepEqual(evaluate(routedState("lead"), T0, old), [], "already with the lead");
  assert.deepEqual(evaluate(routedState("w-u"), T0, old), [], "routed to a peer, not an orchestrator");
  assert.deepEqual(evaluate(routedState("main", "awaiting_human"), T0, old), [], "awaiting the human");
  assert.deepEqual(evaluate(routedState(), T0, { watchers: dead.watchers }), [], "routing time unknown");
});

// ---------------------------------------------------------------------------
// Whole passes
// ---------------------------------------------------------------------------

/** One state where most rules fire at once. */
function busyState() {
  const s = makeState({
    tasks: ["dead", "stuck", "dep", "blocked", "flaky", "chatty"].map((id) => task(id)),
    budget: { spent_usd: 85, by_task: { dead: 1 } },
  });
  claim(s, "dead", "w-dead", { agentOver: { status: "exited" } });
  claim(s, "stuck", "w-stuck");
  s.tasks.dep.state = "accepted";
  s.tasks.blocked.state = "blocked";
  s.tasks.blocked.blocked_by = { deps: ["dep"] };
  s.checks.task["flaky/unit"] = { status: "failed", signature: "sig", streak: 3, since_patch_seq: 0, at_seq: 80 };
  s.agents.x = agent("x");
  s.agents.y = agent("y");
  s.notes = ["x", "y", "x", "y"].map((a, i) => ({ seq: 50 + i, agent: a, topic: "naming", text: "", refs: [] }));
  Object.assign(s.escalations, routedState().escalations);
  return s;
}

const busyObs = (over = {}) => ({
  agents: { "w-stuck": { alive: true, startedAt: T0 - 60 * MIN, lastOutputAt: T0 - 20 * MIN, ...over } },
  escalations: { "esc-2": { routedAt: T0 - 5 * MIN } },
  watchers: { main: { alive: false } },
  diffs: { chatty: ["A", "B", "A"] },
  outcomes: [{ driver: "codex", at: T0 - MIN, kind: "rate_limit", message: "429 Too Many Requests" }],
});

test("idempotence: once a pass's events are applied (and its process operations observed), the next pass emits nothing", () => {
  const s = busyState();
  const first = evaluate(s, T0, busyObs());
  const rules = new Set(first.map((a) => a.rule));
  for (const r of ["worker_dead", "worker_stall", "dependency_wait", "repeated_failure", "diff_ping_pong", "note_ping_pong", "lead_fallback", "budget_threshold", "circuit"]) {
    assert.ok(rules.has(r), `rule ${r} fired`);
  }
  assert.equal(new Set(first.map((a) => `${a.type}:${a.key}`)).size, first.length, "keys are unique");
  assert.deepEqual(evaluate(s, T0, busyObs()), first, "deterministic");

  const after = settle(s, first);
  // The runner performed the stall kill+resume and counted the stall.
  const obs = busyObs({ stalls: 1, lastStallAt: T0, startedAt: T0 + 500 });
  assert.deepEqual(evaluate(after, T0 + 1000, obs), []);
});

test("idempotence: repeated passes reach a fixed point without repeating any key", () => {
  let s = busyState();
  // Add a deadlock so the deferred rule runs in a later pass.
  s.tasks.l1 = task("l1");
  s.tasks.l2 = task("l2");
  claim(s, "l1", "w-l1");
  claim(s, "l2", "w-l2");
  s.leases = { La: lease("La", "l1", "w-l1", ["src/a/**"]), Lb: lease("Lb", "l2", "w-l2", ["src/b/**"]) };
  s.lease_queue = [
    request("Q1", "l1", "w-l1", ["src/b/**"], "exclusive", ["Lb"], 70),
    request("Q2", "l2", "w-l2", ["src/a/**"], "exclusive", ["La"], 71),
  ];
  const seen = new Set();
  let obs = busyObs();
  let passes = 0;
  for (;;) {
    const actions = evaluate(s, T0 + passes * 1000, obs);
    if (actions.length === 0) break;
    for (const a of actions) {
      const k = `${a.type}:${a.key}`;
      assert.ok(!seen.has(k), `key repeated: ${k}`);
      seen.add(k);
    }
    s = settle(s, actions);
    obs = busyObs({ stalls: 1, lastStallAt: T0, startedAt: T0 + 500 });
    assert.ok(++passes < 5, "converges");
  }
  assert.equal(passes, 2, "the deadlock waits for the pass after the retry");
  assert.deepEqual(s.watchdog.deadlocks, [["l1", "l2"]]);
});

test("a finished run is left alone", () => {
  for (const status of ["completed", "failed", "aborted"]) {
    const s = Object.assign(busyState(), { status });
    assert.deepEqual(evaluate(s, T0, busyObs()), []);
  }
});

test("defaults match the design", () => {
  assert.equal(WATCHDOG_DEFAULTS.stallMs, 10 * MIN);
  assert.equal(WATCHDOG_DEFAULTS.leadGraceMs, 2 * MIN);
  assert.equal(WATCHDOG_DEFAULTS.failureStreak, 3);
  assert.equal(WATCHDOG_DEFAULTS.notePingPong, 4);
});

// ---------------------------------------------------------------------------
// Drafts and observations
// ---------------------------------------------------------------------------

test("actionsToDrafts stamps the pid, audits every action and fills diagnostics blobs", () => {
  const s = busyState();
  const actions = evaluate(s, T0, busyObs());
  const snapshot = structuredClone(actions);
  const flaky = actions.find((a) => a.rule === "repeated_failure");
  const drafts = actionsToDrafts(actions, { pid: 777, diagnosticsBlobs: { [flaky.key]: "sha256:diag" } });

  assert.deepEqual(actions, snapshot, "actions are not modified");
  for (const d of drafts) assert.deepEqual(d.source, { kind: "watchdog", id: "watchdog", pid: 777 });
  const audits = drafts.filter((d) => d.type === "watchdog.action");
  assert.equal(audits.length, actions.length);
  assert.deepEqual(
    audits.find((d) => d.payload.action === "spawn_retry").payload,
    { rule: "worker_dead", action: "spawn_retry", target: "dead" }
  );
  const raised = drafts.filter((d) => d.type === "escalation.raised").map((d) => d.payload.escalation);
  assert.equal(raised.find((e) => e.id === flaky.key).diagnostics_blob, "sha256:diag");
  assert.ok(raised.filter((e) => e.id !== flaky.key).every((e) => e.diagnostics_blob === undefined));
  assert.equal(drafts.filter((d) => d.correlation === flaky.key).length, 2, "the escalation and its audit share the key");

  assert.equal(actionsToDrafts(actions, { audit: false }).filter((d) => d.type === "watchdog.action").length, 0);
  assert.deepEqual(processActions(actions).map((a) => a.type).sort(), ["kill_worker", "lead_fallback", "resume_worker", "spawn_retry", "wake_orchestrator"]);
});

test("escalation ids are deterministic and distinct per key", () => {
  assert.equal(escalationId("k1"), escalationId("k1"));
  assert.notEqual(escalationId("k1"), escalationId("k2"));
  assert.match(escalationId("k1"), /^esc-wd[0-9a-f]{12}$/);
});

const ev = (seq, minutesAgo, type, payload, source = { kind: "runner", id: "runner", pid: 1 }) => ({
  v: 1,
  id: `evt-${seq}`,
  seq,
  ts: new Date(T0 - minutesAgo * MIN).toISOString(),
  execution: "exe-0000000000abc123",
  mode: "execution",
  source,
  type,
  payload,
  prev: "0".repeat(64),
  hash: "0".repeat(64),
});

test("observeEvents derives times, history and needs from the log; process observations win", () => {
  const ext = { kind: "agent", id: "ext-1", pid: 9 };
  const events = [
    ev(1, 60, "agent.registered", { agent: "w-t", persona: "dev", driver: "claude-code", token_sha256: "x", external: false }),
    ev(2, 50, "task.claimed", { task: "t", agent: "w-t", attempt: 1, ttl_s: 0 }),
    ev(3, 50, "agent.spawned", { agent: "w-t", task: "t", attempt: 1, pid: 4242 }),
    ev(4, 45, "task.claimed", { task: "e", agent: "ext-1", attempt: 1, ttl_s: 900 }),
    ev(5, 20, "task.progress", { task: "e", note: "working" }, ext),
    ev(6, 40, "task.submitted", { task: "t", commit: "c1", diff_blob: "A", stat: "", files: [], rewrites: [] }),
    ev(7, 35, "task.submitted", { task: "t", commit: "c2", diff_blob: "B", stat: "", files: [], rewrites: [] }),
    ev(8, 30, "watchdog.stall_detected", { agent: "w-t", task: "t" }),
    ev(9, 25, "huddle.started", { id: "hud-1", escalation: "esc-1", format: "micro", seats: [] }),
    ev(10, 24, "escalation.routed", { id: "esc-1", to: "main", wake: true }),
    ev(11, 23, "dependency.requested", { task: "t", need: { kind: "interface", ref: "api" } }),
    ev(12, 22, "dependency.requested", { task: "t", need: { kind: "task", ref: "e" } }),
    ev(13, 21, "dependency.satisfied", { task: "t", need: { kind: "task", ref: "e" }, by_event: "evt-x" }),
    ev(14, 15, "agent.exited", { agent: "w-t", task: "t", code: 1, reason: "error", result_subtype: "rate_limit_error" }),
    ev(15, 14, "watchdog.circuit_opened", { driver: "claude-code", reason: "429", until: new Date(T0).toISOString() }),
  ];
  const obs = observeEvents(events, { agents: { "w-t": { alive: true, lastOutputAt: T0 } }, huddles: { "hud-1": { startedAt: 5 } } });
  assert.equal(obs.seqTimes[2], T0 - 50 * MIN);
  assert.deepEqual(obs.claims, { t: { renewedAt: T0 - 50 * MIN }, e: { renewedAt: T0 - 20 * MIN } });
  assert.deepEqual(obs.agents["w-t"], { stalls: 1, lastStallAt: T0 - 30 * MIN, alive: true, lastOutputAt: T0 });
  assert.deepEqual(obs.huddles, { "hud-1": { startedAt: 5 } }, "base wins");
  assert.deepEqual(obs.escalations, { "esc-1": { routedAt: T0 - 24 * MIN } });
  assert.deepEqual(obs.diffs, { t: ["A", "B"] });
  assert.deepEqual(obs.needs, [{ task: "t", need: { kind: "interface", ref: "api" } }]);
  assert.deepEqual(obs.outcomes, [{ driver: "claude-code", at: T0 - 15 * MIN, kind: "rate_limit", message: "rate_limit_error" }]);
  assert.deepEqual(obs.circuits, { "claude-code": { opens: 1, openedAt: T0 - 14 * MIN } });
});

test("observeEvents feeds evaluate: an external claim renewed by its agent's events does not expire", () => {
  const s = makeState({ tasks: [task("e")] });
  claim(s, "e", "ext-1", { ttl_s: 900, granted_seq: 4 });
  const ext = { kind: "agent", id: "ext-1", pid: 9 };
  const claimed = ev(4, 45, "task.claimed", { task: "e", agent: "ext-1", attempt: 1, ttl_s: 900 });
  assert.equal(evaluate(s, T0, observeEvents([claimed])).filter((a) => a.rule === "claim_expiry").length, 1);
  const renewed = [claimed, ev(5, 10, "task.progress", { task: "e", note: "still here" }, ext)];
  assert.deepEqual(evaluate(s, T0, observeEvents(renewed)), []);
});

// ---------------------------------------------------------------------------
// Budget, circuit and deadlock rules inside evaluate
// ---------------------------------------------------------------------------

test("budget rules run inside evaluate", () => {
  const s = makeState({ budget: { spent_usd: 81 } });
  assert.deepEqual(
    evaluate(s, T0, {}).map((a) => [a.rule, a.type]),
    [
      ["budget_threshold", "emit"],
      ["budget_threshold", "emit"],
      ["budget_threshold", "wake_orchestrator"],
    ]
  );
});

test("circuits run inside evaluate", () => {
  const s = makeState();
  const actions = evaluate(s, T0, { outcomes: [{ driver: "claude-code", at: T0 - MIN, kind: "rate_limit", message: "429" }] });
  assert.deepEqual(actions.map((a) => a.rule), ["circuit"]);
  assert.equal(settle(s, actions).watchdog.circuits["claude-code"].open, true);
});

test("evaluate reports deadlocks from the needs in its observations", () => {
  const s = makeState({ tasks: [task("a"), task("b")] });
  claim(s, "a", "w-a");
  claim(s, "b", "w-b");
  s.interfaces.api = { spec: { name: "api", kind: "api", owner: "b", description: "" }, version: 0 };
  s.leases = { La: lease("La", "a", "w-a", ["src/shared/**"]) };
  s.lease_queue = [request("Rb", "b", "w-b", ["src/shared/types.ts"], "exclusive", ["La"], 40)];
  const needs = [{ task: "a", need: { kind: "interface", ref: "api" } }];
  const actions = evaluate(s, T0, { needs });
  assert.deepEqual(actions.map((a) => a.rule), ["deadlock"]);
  assert.deepEqual(evaluate(settle(s, actions), T0, { needs }), []);
});
