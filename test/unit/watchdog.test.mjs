import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN,
  SEC,
  T0,
  World,
  agent,
  applyDrafts,
  claim,
  emitted,
  escalations,
  eventTypes,
  fresh,
  lease,
  makeState,
  ofType,
  opsOf,
  request,
  task,
} from "../fixtures/execution-state.mjs";

const { applyInPlace } = await import("../../dist/execution/blackboard.js");
const { circuitStatus } = await import("../../dist/execution/circuit.js");
const { validateDraft } = await import("../../dist/execution/events.js");
const {
  evaluate,
  actionsToDrafts,
  observeEvents,
  staticPrefix,
  globsOverlap,
  leasesConflict,
  escalationId,
  processActions,
  canRespawn,
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
  const s = makeState({ tasks: [task("done", { state: "failed" }), task("next")] });
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
  // Nothing new; the kill stands until the worker is gone (a lost kill is re-issued).
  const later = evaluate(s, T0 + 12 * MIN, obs);
  assert.deepEqual(fresh(later), []);
  assert.deepEqual(later.map((a) => [a.type, a.agent, a.standing]), [["kill_worker", "w-t", true]]);
  assert.deepEqual(actionsToDrafts(later), [], "standing: no audit events");
  s.agents["w-t"].status = "exited";
  assert.deepEqual(evaluate(s, T0 + 13 * MIN, obs), []);
});

// ---------------------------------------------------------------------------
// Dependency wait
// ---------------------------------------------------------------------------

test("a task blocked on deps is unblocked once every dep is accepted or published and no need is open", () => {
  const cases = [
    { deps: ["a", "b"], a: "accepted", b: "in_progress", want: false },
    { deps: ["a", "b"], a: "accepted", b: "accepted", want: true },
    { deps: ["api"], iface: 1, want: true },
    { deps: ["api"], iface: 0, want: false },
    { deps: ["a"], a: "accepted", escalation: "esc-1", want: false },
    { deps: ["a"], a: "accepted", needs: [{ kind: "interface", ref: "Theme" }], want: false },
    { deps: ["a"], a: "accepted", needs: [], want: true },
  ];
  for (const c of cases) {
    const s = makeState({ tasks: [task("a", { state: c.a ?? "ready" }), task("b", { state: c.b ?? "ready" }), task("t")] });
    s.tasks.t.state = "blocked";
    s.tasks.t.blocked_by = { deps: c.deps, ...(c.escalation ? { escalation: c.escalation } : {}), ...(c.needs ? { needs: c.needs } : {}) };
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
  assert.deepEqual(evaluate(routedState("lead"), T0, { ...dead, escalations: { "esc-2": { routedAt: T0 - 3 * MIN } } }), [], "with the lead, within its retry window");
  assert.deepEqual(
    evaluate(routedState("lead"), T0, old).map((a) => [a.type, a.escalation]),
    [["lead_fallback", "esc-2"]],
    "still with the lead past the retry window: issued again"
  );
  assert.deepEqual(evaluate(routedState("lead"), T0, { ...old, leadInFlight: { "esc-2": true } }), [], "a lead call is running");
  assert.deepEqual(evaluate(routedState("lead"), T0, { ...old, leadIssuedAt: { "esc-2": T0 - MIN } }), [], "issued again a minute ago");
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

const busyObs = (over = {}, settled = false) => ({
  agents: { "w-stuck": { alive: true, startedAt: T0 - 60 * MIN, lastOutputAt: T0 - 20 * MIN, ...over } },
  escalations: { "esc-2": { routedAt: settled ? T0 : T0 - 5 * MIN } },
  ...(settled ? { leadIssuedAt: { "esc-2": T0 } } : {}),
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
  const obs = busyObs({ stalls: 1, lastStallAt: T0, startedAt: T0 + 500 }, true);
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
    obs = busyObs({ stalls: 1, lastStallAt: T0, startedAt: T0 + 500 }, true);
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
  assert.deepEqual(obs.claims, { t: { renewedAt: T0 - 35 * MIN }, e: { renewedAt: T0 - 20 * MIN } }, "a submission renews the claim");
  assert.deepEqual(obs.spawns, { "w-t": T0 - 50 * MIN });
  assert.deepEqual(obs.infraDeaths, { t: { count: 1, lastAttempt: 1 } }, "the rate-limit exit is a transient driver failure");
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

// ---------------------------------------------------------------------------
// Conformance with the store: every draft validates, and the strict reducer agrees
// ---------------------------------------------------------------------------

/** The drafts through validateDraft and the real reducer in strict mode (the store's write path). */
function applyStrict(state, drafts) {
  const s = structuredClone(state);
  for (const d of drafts) {
    const v = validateDraft(d);
    const seq = s.seq + 1;
    const event = { ...v, v: 1, id: `evt-${seq}`, seq, ts: new Date(T0).toISOString(), execution: s.execution, mode: "execution", prev: "0".repeat(64), hash: "0".repeat(64) };
    applyInPlace(s, event, {}, { strict: true });
  }
  return s;
}

/** The parts of the blackboard the watchdog's events change. */
const touched = (s) => ({
  tasks: Object.fromEntries(Object.entries(s.tasks).map(([k, t]) => [k, { state: t.state, attempt: t.attempt, blocked_by: t.blocked_by }])),
  claims: Object.keys(s.claims).sort(),
  leases: Object.keys(s.leases).sort(),
  queue: s.lease_queue.map((r) => [r.id, r.blocking]),
  escalations: Object.fromEntries(Object.entries(s.escalations).map(([k, e]) => [k, [e.status, e.routed_to, e.emergency, e.blocking]])),
  huddles: s.huddles,
  agents: Object.fromEntries(Object.entries(s.agents).map(([k, a]) => [k, a.status])),
  thresholds: s.budget.thresholds_crossed,
  circuits: s.watchdog.circuits,
  deadlocks: s.watchdog.deadlocks,
});

const conformance = [
  { name: "claim expiry and queue grants", state: leaseScenario, obs: () => ({ seqTimes: { 10: T0 - 16 * MIN } }) },
  { name: "most rules at once", state: busyState, obs: () => busyObs(), next: () => busyObs({ stalls: 1, lastStallAt: T0, startedAt: T0 + 500 }, true) },
  { name: "a lost worker", state: workerState, obs: () => ({ agents: { "w-t": { alive: false } } }) },
  { name: "the last attempt", state: () => workerState({ attempt: 3, status: "exited" }), obs: () => ({}) },
  { name: "a second stall", state: workerState, obs: () => ({ agents: live({ stalls: 1, lastStallAt: T0 - 40 * MIN }) }) },
  { name: "a huddle timeout", state: () => huddleState(), obs: () => ({ huddles: { "hud-1": { startedAt: T0 - 21 * MIN } } }) },
  {
    name: "a lead fallback",
    state: () => routedState(),
    obs: () => ({ escalations: { "esc-2": { routedAt: T0 - 3 * MIN } }, watchers: { main: { alive: false } } }),
  },
  {
    name: "budget exhaustion and a task cap",
    state: () => {
      const s = makeState({ tasks: [task("t")] });
      claim(s, "t", "w-t");
      s.budget = { ...s.budget, spent_usd: 100, by_task: { t: 20 } };
      return s;
    },
    obs: () => ({}),
  },
  { name: "an auth emergency", state: () => makeState(), obs: () => ({ outcomes: [{ driver: "claude-code", at: T0 - MIN, kind: "auth", message: "Not logged in" }] }) },
  {
    name: "a deadlock",
    state: () => {
      const s = makeState({ tasks: [task("a"), task("b")] });
      claim(s, "a", "w-a");
      claim(s, "b", "w-b");
      s.leases = { La: lease("La", "a", "w-a", ["src/a/**"]), Lb: lease("Lb", "b", "w-b", ["src/b/**"]) };
      s.lease_queue = [request("Qa", "a", "w-a", ["src/b/**"], "exclusive", ["Lb"], 70), request("Qb", "b", "w-b", ["src/a/**"], "exclusive", ["La"], 71)];
      return s;
    },
    obs: () => ({}),
  },
];

for (const c of conformance) {
  test(`store conformance: ${c.name}`, () => {
    const s = c.state();
    const actions = evaluate(s, T0, c.obs());
    assert.ok(actions.length > 0, "the scenario fires");
    const drafts = actionsToDrafts(actions, { pid: 1234 });
    const real = applyStrict(s, drafts);
    assert.deepEqual(touched(real), touched(applyDrafts(s, drafts)), "the test reducer agrees with the real one");
    assert.deepEqual(fresh(evaluate(real, T0 + 1000, (c.next ?? c.obs)())), [], "idempotent on the real blackboard");
  });
}

// ---------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------

test("claims do not expire while the run or the task is paused; a resume restarts the ttl", () => {
  const obs = { seqTimes: { 10: T0 - 16 * MIN } };
  const paused = Object.assign(leaseScenario(), { status: "paused" });
  assert.deepEqual(evaluate(paused, T0, obs).filter((a) => a.rule === "claim_expiry"), []);
  const taskPaused = Object.assign(leaseScenario(), { paused_tasks: ["a"] });
  assert.deepEqual(evaluate(taskPaused, T0, obs).filter((a) => a.rule === "claim_expiry"), []);

  const s = makeState({ tasks: [task("e")] });
  claim(s, "e", "ext-1", { ttl_s: 900, granted_seq: 4 });
  const events = [
    ev(4, 45, "task.claimed", { task: "e", agent: "ext-1", attempt: 1, ttl_s: 900 }),
    ev(5, 40, "execution.paused", { scope: "all", reason: "lunch" }),
    ev(6, 5, "execution.resumed", { scope: "all" }),
  ];
  assert.deepEqual(observeEvents(events).claims.e, { renewedAt: T0 - 5 * MIN });
  assert.deepEqual(evaluate(s, T0, observeEvents(events)), []);
});

test("a worker that died of the failure that trips its driver's circuit is not respawned into it", () => {
  const s = workerState({ status: "exited" });
  const actions = evaluate(s, T0, { outcomes: [{ driver: "claude-code", at: T0 - MIN, kind: "rate_limit", message: "429 Too Many Requests" }] });
  assert.deepEqual(actions.map((a) => a.rule), ["circuit"]);
  // Once the circuit is half-open, the retry goes ahead (one trial).
  const later = settle(s, actions);
  const trial = evaluate(later, T0 + 2 * MIN, {});
  assert.deepEqual(opsOf(trial).map((a) => [a.type, a.attempt]), [["spawn_retry", 2]]);
});

test("a held lost worker and its later retry have distinct keys", () => {
  const s = workerState();
  s.budget.spent_usd = 100;
  const obs = { agents: { "w-t": { alive: false } } };
  const held = evaluate(s, T0, obs).filter((a) => a.rule === "worker_dead");
  assert.deepEqual(held.map((a) => [a.key, eventTypes([a])]), [["worker_dead:t:1:lost", ["agent.exited"]]]);
  const after = settle(s, held);
  after.budget.extensions_usd = 50;
  const retry = evaluate(after, T0, obs).filter((a) => a.rule === "worker_dead");
  assert.deepEqual(retry.map((a) => a.key), ["worker_dead:t:1:retry", "worker_dead:t:1:spawn"]);
});

test("a task blocked on a dep that failed or was cancelled escalates; a split dep waits for its parts", () => {
  const blocked = (deps, ...tasks) => {
    const s = makeState({ tasks: [...tasks, task("t", { state: "blocked", blocked_by: { deps } })] });
    return s;
  };
  for (const st of ["failed", "cancelled"]) {
    const s = blocked(["a"], task("a", { state: st }));
    const actions = evaluate(s, T0, {});
    const [esc] = escalations(actions);
    assert.equal(esc.kind, "blocker", st);
    assert.equal(esc.task, "t");
    assert.match(esc.summary, new RegExp(`a \\(${st}\\), which will not finish`));
    assert.deepEqual(eventTypes(actions), ["escalation.raised"], "the task stays blocked on its deps");
    assert.deepEqual(evaluate(settle(s, actions), T0, {}), []);
  }

  const split = blocked(["a"], task("a", { state: "cancelled" }), task("a1", { state: "accepted" }), task("a2", { state: "in_progress" }));
  split.splits = { a: ["a1", "a2"] };
  assert.deepEqual(evaluate(split, T0, {}), [], "waiting for a2");
  split.tasks.a2.state = "accepted";
  assert.deepEqual(eventTypes(evaluate(split, T0, {})), ["task.unblocked"]);
});

// ---------------------------------------------------------------------------
// Second review round
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();
const RATE_LIMITED = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}';

test("a 4-minute rate-limit outage with 4 workers: nothing fails, one trial per half-open period, all resume after", () => {
  const ids = ["a", "b", "c", "d"];
  const w = new World(makeState({ tasks: ids.map((t) => task(t)) }));
  for (const t of ids) {
    w.emit("agent.registered", { agent: `w-${t}`, persona: "dev", driver: "claude-code", token_sha256: "0".repeat(64), external: false });
    w.emit("task.claimed", { task: t, agent: `w-${t}`, attempt: 1, ttl_s: 0 });
    w.emit("agent.spawned", { agent: `w-${t}`, task: t, attempt: 1, pid: 1000 });
  }
  const outageEnd = T0 + 4 * MIN;
  let dying = ids.map((t) => [T0 + 5 * SEC, t]);
  const trials = new Map(); // half-open period (its until) -> spawns in it
  for (let i = 0; i < 120; i++) {
    for (const [, t] of dying.filter(([at]) => at <= w.now)) {
      w.emit("agent.exited", { agent: `w-${t}`, task: t, code: 1, reason: "error", result_subtype: RATE_LIMITED });
    }
    dying = dying.filter(([at]) => at > w.now);
    const status = circuitStatus(w.state, "claude-code", w.now);
    const until = w.state.watchdog.circuits["claude-code"]?.until;
    const actions = w.step({ agents: Object.fromEntries(ids.map((t) => [`w-${t}`, { alive: w.state.agents[`w-${t}`].status === "running" }])) });
    const spawned = actions.filter((a) => a.type === "spawn_retry");
    if (status === "open") assert.equal(spawned.length, 0, `no spawn while open (pass ${i})`);
    if (status === "half_open") trials.set(until, (trials.get(until) ?? 0) + spawned.length);
    for (const a of spawned) {
      w.emit("task.claimed", { task: a.task, agent: `w-${a.task}`, attempt: a.attempt, ttl_s: 0 });
      w.emit("agent.spawned", { agent: `w-${a.task}`, task: a.task, attempt: a.attempt, pid: 2000 + i });
      if (w.now < outageEnd) dying.push([w.now + 15 * SEC, a.task]);
    }
    w.now += 10 * SEC;
  }
  assert.ok(trials.size >= 2, "the circuit went half-open more than once");
  for (const [until, n] of trials) assert.ok(n <= 1, `one trial in the half-open period ending ${until}`);
  assert.equal(w.log.filter((e) => e.type === "task.failed").length, 0, "no task failed");
  assert.equal(circuitStatus(w.state, "claude-code", w.now), "closed");
  for (const t of ids) {
    assert.equal(w.state.tasks[t].state, "claimed", t);
    assert.equal(w.state.agents[`w-${t}`].status, "running", t);
  }
});

test("a half-open circuit admits exactly one trial: one retry or resume per period", () => {
  const s = makeState({ tasks: ["a", "b", "c", "d"].map((id) => task(id)) });
  for (const t of ["a", "b", "c"]) claim(s, t, `w-${t}`, { agentOver: { status: "exited" } });
  claim(s, "d", "w-d");
  s.watchdog.circuits["claude-code"] = { open: true, until: iso(T0 - SEC), reason: "429", opens: 1 };
  const obs = { agents: { "w-d": { alive: true, startedAt: T0 - 30 * MIN, lastOutputAt: T0 - 11 * MIN } } };
  const actions = evaluate(s, T0, obs);
  assert.deepEqual(opsOf(actions).map((a) => [a.type, a.task ?? a.agent]), [
    ["spawn_retry", "a"],
    ["kill_worker", "w-d"],
  ]);
  // Once the trial worker is spawned, nobody else starts until the circuit closes.
  const after = settle(s, actions);
  claim(after, "a", "w-a", { attempt: 2 });
  const trial = { ...obs, spawns: { "w-a": T0 + SEC } };
  assert.deepEqual(opsOf(evaluate(after, T0 + 10 * SEC, trial)).filter((a) => a.type !== "kill_worker"), []);
  assert.deepEqual(canRespawn(after, T0 + 10 * SEC, trial, { task: "b", agent: "w-b", driver: "claude-code" }), { ok: false, why: "trial_in_flight" });
  assert.deepEqual(canRespawn(after, T0 + 10 * SEC, {}, { task: "b", agent: "w-b", driver: "codex" }), { ok: true });
  // The trial survives circuitTrialMs: the circuit closes.
  const closing = evaluate(after, T0 + SEC + 2 * MIN, { ...trial, agents: { ...trial.agents, "w-a": { alive: true } } });
  assert.ok(emitted(closing).some((e) => e.type === "watchdog.circuit_closed"));
});

test("transient driver deaths do not use attempts; they have their own cap", () => {
  const dead = (infraDeaths) => evaluate(workerState({ attempt: 3, status: "exited" }), T0, { infraDeaths }).filter((a) => a.rule === "worker_dead");
  assert.deepEqual(opsOf(dead({ t: { count: 2, lastAttempt: 3 } })).map((a) => a.attempt), [4], "the third attempt died of a rate limit");
  assert.deepEqual(opsOf(dead({ t: { count: 2, lastAttempt: 2 } })).map((a) => a.attempt), [4], "only one counted attempt was used");
  assert.match(ofType(dead({ t: { count: 2, lastAttempt: 3 } }), "task.retried")[0].payload.why, /transient driver failure.*not counted/);
  const capped = dead({ t: { count: 21, lastAttempt: 3 } });
  assert.deepEqual(eventTypes(capped), ["task.failed", "escalation.raised"]);
  assert.match(escalations(capped)[0].summary, /transient driver failures 21 times \(the limit is 20\)/);
  const counted = evaluate(workerState({ attempt: 4, status: "exited" }), T0, { infraDeaths: { t: { count: 1, lastAttempt: 1 } } });
  assert.match(escalations(counted)[0].summary, /attempt 4 \(3 of 3 counted; 1 transient driver failure not counted\)/);
});

test("while the respawn gate is shut a dead worker waits; no attempt is counted or failed", () => {
  for (const [label, mut] of [
    ["circuit open", (s) => (s.watchdog.circuits["claude-code"] = { open: true, until: iso(T0 + 10 * MIN), reason: "429" })],
    ["budget spent", (s) => (s.budget.spent_usd = 100)],
  ]) {
    const s = workerState({ attempt: 3, status: "exited" });
    mut(s);
    assert.deepEqual(evaluate(s, T0, {}).filter((a) => a.rule === "worker_dead"), [], label);
  }
});

test("a stalled worker is resumed only through the respawn gate, and killed once", () => {
  const stalled = { "w-t": { alive: true, startedAt: T0 - 30 * MIN, lastOutputAt: T0 - 11 * MIN } };
  const cases = [
    ["the task cap is reached", (s) => Object.assign(s.budget, { spent_usd: 20, by_task: { t: 20 } }), ["kill_worker"]],
    ["the budget is spent", (s) => Object.assign(s.budget, { spent_usd: 100, thresholds_crossed: [50, 80, 100], thresholds_budget_usd: 100 }), ["kill_worker", "stop_spawning"]],
    ["the circuit is open", (s) => (s.watchdog.circuits["claude-code"] = { open: true, until: iso(T0 + 10 * MIN), reason: "429" }), ["kill_worker"]],
    ["the circuit is half-open", (s) => (s.watchdog.circuits["claude-code"] = { open: true, until: iso(T0 - MIN), reason: "429" }), ["kill_worker", "resume_worker"]],
    [
      "a half-open trial is already running",
      (s) => {
        s.watchdog.circuits["claude-code"] = { open: true, until: iso(T0 - MIN), reason: "429" };
        s.agents["w-x"] = agent("w-x");
      },
      ["kill_worker"],
      { "w-x": T0 - 30 * SEC },
    ],
  ];
  for (const [label, mut, ops, spawns] of cases) {
    const s = workerState();
    mut(s);
    const actions = evaluate(s, T0, { agents: stalled, ...(spawns ? { spawns } : {}) });
    assert.deepEqual(opsOf(actions).map((a) => a.type), ops, label);
  }
});

test("claims and leases of submitted work being checked or merged do not expire", () => {
  for (const phase of ["checking", "merging"]) {
    const w = new World(makeState({ tasks: [task("e")] }));
    const ext = { kind: "agent", id: "ext-1", pid: 7 };
    w.emit("agent.registered", { agent: "ext-1", persona: "dev", driver: "external", token_sha256: "0".repeat(64), external: true });
    w.emit("task.claimed", { task: "e", agent: "ext-1", attempt: 1, ttl_s: 900 });
    w.emit("lease.granted", { lease: lease("L1", "e", "ext-1", ["src/e/**"]) });
    w.now += 5 * MIN;
    w.emit("task.submitted", { task: "e", commit: "c1", diff_blob: "sha256:d1", stat: "1 file", files: ["src/e/x.ts"], rewrites: [] }, ext);
    w.emit("check.started", { command_id: "test", scope: "task", task: "e" });
    if (phase === "merging") w.emit("task.checks_passed", { task: "e", commands: ["test"] });
    w.now += 16 * MIN;
    assert.deepEqual(w.step().filter((a) => a.rule === "claim_expiry"), [], phase);
    assert.equal(w.state.tasks.e.state, phase);
    assert.deepEqual(Object.keys(w.state.leases), ["L1"]);
    if (phase !== "checking") continue;
    // Rejected back to the worker: the TTL restarts from the rejection.
    w.emit("task.rejected", { task: "e", reasons: ["test failed"] });
    w.now += 10 * MIN;
    assert.deepEqual(w.step().filter((a) => a.rule === "claim_expiry"), []);
    w.now += 6 * MIN;
    assert.equal(w.step().filter((a) => a.rule === "claim_expiry").length, 1, "15 min after the rejection");
  }
});

test("a dependency that fails, is retried, and fails again escalates again", () => {
  const s = makeState({ tasks: [task("a", { state: "in_progress" }), task("b", { state: "blocked", blocked_by: { deps: ["a"] }, spec: { depends_on: ["a"] } })] });
  const w = new World(s);
  const orch = { kind: "orchestrator", id: "main", pid: 1 };
  w.emit("task.failed", { task: "a", why: "boom" });
  const first = escalations(w.step());
  assert.equal(first.length, 1);
  w.emit("escalation.resolved", { id: first[0].id, action: "retry", decision: "retry a", by: "main" }, orch);
  w.emit("task.retried", { task: "a", attempt: 2, why: "orchestrator retry" }, orch);
  assert.deepEqual(escalations(w.step()), []);
  w.now += MIN;
  w.emit("task.failed", { task: "a", why: "boom again" });
  const second = escalations(w.step());
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first[0].id);
});

test("resubmitting the same diff is no patch: the repeated failure escalates", () => {
  const s = makeState({ tasks: [task("t")] });
  claim(s, "t", "w-t");
  const w = new World(s);
  const wt = { kind: "agent", id: "w-t", pid: 7 };
  const raised = [];
  for (let i = 0; i < 6; i++) {
    w.emit("task.submitted", { task: "t", commit: `c${i}`, diff_blob: "sha256:same", stat: "1 file", files: ["src/t/x.ts"], rewrites: [] }, wt);
    w.emit("check.started", { command_id: "test", scope: "task", task: "t" });
    w.emit("check.failed", { command_id: "test", scope: "task", task: "t", exit: 1, signature: "sig-1" });
    w.emit("task.rejected", { task: "t", reasons: ["test failed"] });
    raised.push(...escalations(w.step({ agents: { "w-t": { alive: true, startedAt: w.now } } })));
    w.now += MIN;
  }
  assert.equal(w.state.checks.task["t/test"].streak, 6);
  assert.deepEqual(raised.map((e) => e.summary.match(/failed (\d+) times/)?.[1]), ["3"], "once, on the third identical cycle");
});

test("crash recovery: a lost lead fallback is issued again from the log alone", () => {
  const s = makeState();
  s.escalations["esc-2"] = { id: "esc-2", agent: "w-x", kind: "blocker", with: "orchestrator", summary: "help", blocking: false, status: "open", raised_seq: 5 };
  const w = new World(s);
  w.emit("escalation.routed", { id: "esc-2", to: "main", wake: true });
  w.now += 3 * MIN;
  const lead = (actions) => actions.filter((a) => a.type === "lead_fallback").map((a) => a.escalation);
  assert.deepEqual(lead(w.step({ watchers: { main: { alive: false } } })), ["esc-2"], "issued; the runner dies before the call");
  assert.equal(w.state.escalations["esc-2"].routed_to, "lead");
  w.now += 2 * MIN;
  assert.deepEqual(lead(w.step()), [], "within the retry window");
  w.now += 4 * MIN;
  assert.deepEqual(lead(w.step()), ["esc-2"], "a restarted runner, observations rebuilt from the log");
  w.now += MIN;
  assert.deepEqual(lead(w.step()), [], "spaced by its own audit event");
  w.now += 6 * MIN;
  assert.deepEqual(lead(w.step({ leadInFlight: { "esc-2": true } })), [], "not while a call runs");
  assert.deepEqual(lead(w.step()), ["esc-2"]);
});

test("crash recovery: stop_spawning stands while the budget is spent, without new events", () => {
  const s = makeState();
  s.budget.spent_usd = 100;
  const w = new World(s);
  const first = w.step();
  assert.deepEqual(opsOf(first).map((a) => [a.type, a.standing]), [["wake_orchestrator", undefined], ["stop_spawning", undefined]]);
  const logged = w.log.length;
  const again = w.step(); // the op was lost; a restarted runner evaluates again
  assert.deepEqual(again.map((a) => [a.type, a.standing]), [["stop_spawning", true]]);
  assert.equal(w.log.length, logged, "no duplicate events");
});

test("queued lease requests of tasks without a claim are withdrawn", () => {
  const s = makeState({ tasks: [task("y"), task("z", { state: "accepted" })] });
  s.lease_queue = [request("R1", "y", "w-y", ["src/a/**"], "exclusive", [], 10), request("R2", "z", "w-z", ["src/b/**"], "shared", [], 11)];
  const actions = evaluate(s, T0, {});
  assert.deepEqual(
    actions.map((a) => [a.rule, a.events[0].type, a.events[0].payload.lease_id]),
    [
      ["lease_withdraw", "lease.released", "R1"],
      ["lease_withdraw", "lease.released", "R2"],
    ]
  );
  const after = applyStrict(s, actionsToDrafts(actions));
  assert.deepEqual(after.lease_queue, []);
  assert.deepEqual(evaluate(after, T0, {}), []);
});

test("a worker stopped by an emergency pause resumes on the same attempt; it never burns max_attempts", () => {
  const w = new World(workerState({ attempt: 3 }));
  const runnerSrc = { kind: "runner", id: "runner", pid: 1 };
  const dead = (base) => w.step(base).filter((a) => a.rule === "worker_dead");
  w.emit("agent.spawned", { agent: "w-t", task: "t", attempt: 3, pid: 4242 });
  w.commit([{ type: "execution.paused", source: runnerSrc, correlation: "esc-emergency", payload: { scope: ["t"], reason: "escalation esc-emergency awaits the human (credentials)" } }]);
  w.emit("agent.exited", { agent: "w-t", task: "t", code: 0, reason: "completed" });
  assert.deepEqual(dead(), [], "nothing while paused");
  w.commit([{ type: "execution.resumed", source: runnerSrc, correlation: "esc-emergency", payload: { scope: ["t"], reason: "escalation esc-emergency was resolved" } }]);
  const resumed = dead();
  assert.deepEqual(eventTypes(resumed), [], "no task.retried, no task.failed");
  assert.deepEqual(opsOf(resumed).map((a) => [a.type, a.task]), [["resume_worker", "t"]]);
  assert.match(opsOf(resumed)[0].why, /esc-emergency.*attempt 3 \(not counted/);
  assert.deepEqual(opsOf(dead()).map((a) => a.key), opsOf(resumed).map((a) => a.key), "repeats until a worker starts");
  assert.equal(w.state.tasks.t.attempt, 3);
  // Once it runs again, a real death on the last attempt counts.
  w.emit("agent.spawned", { agent: "w-t", task: "t", attempt: 3, pid: 4243 });
  w.emit("agent.exited", { agent: "w-t", task: "t", code: 1, reason: "error" });
  assert.deepEqual(eventTypes(dead()), ["task.failed", "escalation.raised"]);
});

test("a worker lost during a run pause is recorded as paused and resumed on the same attempt", () => {
  const w = new World(workerState({ attempt: 3 }));
  w.emit("agent.spawned", { agent: "w-t", task: "t", attempt: 3, pid: 4242 });
  w.emit("execution.paused", { scope: "all", reason: "Manual inspection" });
  w.emit("execution.resumed", { scope: "all", reason: "Inspected" });
  const actions = w.step({ agents: { "w-t": { alive: false, pid: 4242 } } }).filter((a) => a.rule === "worker_dead");
  assert.deepEqual(ofType(actions, "agent.exited").map((e) => e.payload), [{ agent: "w-t", task: "t", code: null, reason: "lost", paused: "Manual inspection" }]);
  assert.deepEqual(eventTypes(actions), ["agent.exited"]);
  assert.deepEqual(opsOf(actions).map((a) => [a.type, a.task]), [["resume_worker", "t"]]);
  // Recorded, it stays uncounted on the next pass, under the same key.
  assert.deepEqual(opsOf(w.step().filter((a) => a.rule === "worker_dead")).map((a) => a.key), opsOf(actions).map((a) => a.key));
  assert.equal(observeEvents([w.log.find((e) => e.type === "agent.exited")]).pauseStops.t.context, "Manual inspection", "the marker alone is enough");
  assert.equal(observeEvents(w.log).pauseStops.t.attempt, 3);
});
