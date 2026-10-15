// WS11: execution_status. Focus scoring, weighted completion and the ETA as pure functions, then the
// tool's list mode, summary, views and the context bundle (no chat, no secrets).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeRun, runner, task } from "../fixtures/workers/run.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { setOrchestratorDeps } = await import("../../dist/execution/orchestrator.js");
const S = await import("../../dist/execution/status-report.js");

let ensured;
let restore;
beforeEach(() => {
  ensured = [];
  restore = setOrchestratorDeps({ ensureRunner: async (exe) => (ensured.push(exe), { status: "running", pid: 4242 }) });
});
afterEach(() => restore());

const parse = (r) => {
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

const rt = (id, state, over = {}) => ({ spec: { id, title: `Task ${id}`, persona: "builder", kind: "build", depends_on: [], paths: { write: [`src/${id}/**`] }, acceptance: [], checks: [] }, state, attempt: 0, ...over });

const NAV_TASKS = [
  task("api", { title: "HTTP client", paths: { write: ["src/api/**"] } }),
  task("build-nav-bar", { title: "Build the navigation bar", team: "web", paths: { write: ["src/components/navbar/**"] } }),
  task("header", { title: "Site header", paths: { write: ["src/components/nav/**"] } }),
  task("styles", { title: "Theme tokens", paths: { write: ["src/styles/**"] } }),
];
const NAV_INTERFACES = [{ name: "MenuTokens", kind: "type", owner: "styles", description: "Colours and spacing", consumers: ["header"] }];

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test("focus: words and 3+-character prefixes across ids, titles, teams, path segments and interfaces", async () => {
  const run = await makeRun({ contract: { tasks: NAV_TASKS, interfaces: NAV_INTERFACES } });
  const state = await run.store.state();
  assert.deepEqual(S.focusTokens("How close is the nav?"), ["nav"]);
  assert.deepEqual(S.focusTokens("the status"), ["the", "status"], "only stop words: keep them");
  const ids = (focus) => S.matchFocus(state, focus).map((m) => m.task);
  assert.deepEqual(ids("nav"), ["build-nav-bar", "header"], "an id word, and a path segment");
  assert.deepEqual(ids("navigation"), ["build-nav-bar", "header"], "a prefix either way");
  assert.deepEqual(ids("menu tokens"), ["styles", "header"], "an interface owned (styles) or consumed (header)");
  assert.deepEqual(ids("web"), ["build-nav-bar"], "the team");
  assert.deepEqual(ids("http"), ["api"], "the title");
  assert.deepEqual(ids("zebra"), []);
  assert.equal(S.focusScore(["nav"], ["nav"]), 3);
  assert.equal(S.focusScore(["nav"], ["navbar"]), 2);
  assert.equal(S.focusScore(["bar"], ["navbar"]), 1);
  assert.equal(S.focusScore(["na"], ["navbar"]), 0, "prefixes need three characters");
});

test("weighted completion: accepted 1, submitted 0.8, otherwise the reported percent or 0.4; cancelled left out", () => {
  const tasks = [
    rt("a", "accepted"), rt("b", "submitted"), rt("c", "in_progress", { percent: 50, agent: "w" }),
    rt("d", "in_progress", { agent: "w" }), rt("e", "pending"), rt("f", "cancelled"),
  ];
  assert.equal(S.weightedCompletion(tasks), 54);
  assert.equal(S.weightedCompletion([]), 0);
  assert.equal(S.weightedCompletion([rt("x", "checking"), rt("y", "merging")]), 80);
});

test("ETA: the median accepted duration × the remaining work ÷ the parallelism", () => {
  const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
  const tasks = {
    a: rt("a", "accepted", { started_at: at(0), finished_at: at(10) }),
    b: rt("b", "accepted", { started_at: at(0), finished_at: at(30) }),
    c: rt("c", "accepted", { started_at: at(0), finished_at: at(20) }),
    d: rt("d", "pending"), e: rt("e", "pending"), f: rt("f", "in_progress", { percent: 50, agent: "w" }),
    g: rt("g", "cancelled"),
  };
  const state = { tasks, contract: { budget: { max_parallel: 2 } } };
  const now = Date.UTC(2026, 0, 2);
  const eta = S.estimateEta(state, Object.values(tasks), now);
  assert.equal(eta.median_task_min, 20);
  assert.equal(eta.remaining_tasks, 2.5);
  assert.equal(eta.parallelism, 2);
  assert.equal(eta.minutes, 25);
  assert.equal(eta.at, new Date(now + 25 * 60_000).toISOString());
  assert.equal(S.estimateEta(state, [tasks.d], now).parallelism, 1, "never more parallel than the work left");
  assert.equal(S.estimateEta(state, [tasks.a], now).minutes, 0);
  const fresh = S.estimateEta({ tasks: { d: tasks.d }, contract: { budget: { max_parallel: 3 } } }, [tasks.d], now);
  assert.equal(fresh.minutes, undefined);
  assert.match(fresh.note, /no task has been accepted yet/);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

test("execution_status lists every run without an id, newest first", async () => {
  const one = await makeRun({ contract: { tasks: [task("a")] } });
  const two = await makeRun({ contract: { tasks: [task("b")] }, start: false });
  const r = parse(await handleToolCall("execution_status", {}));
  const ids = r.executions.map((e) => e.execution_id);
  assert.ok(ids.indexOf(two.store.id) < ids.indexOf(one.store.id), "newest first");
  const entry = r.executions.find((e) => e.execution_id === one.store.id);
  assert.equal(entry.status, "running");
  assert.equal(entry.title, "Test contract");
  assert.equal(entry.completion_pct, 0);
  assert.equal(r.executions.find((e) => e.execution_id === two.store.id).status, "created");
  assert.equal(parse(await handleToolCall("execution_status", { limit: 1 })).executions.length, 1);
  assert.deepEqual(ensured, [], "listing restarts no runner");
});

test("execution_status answers \"how close is the nav?\" with focused completion, blockers, checks, budget and health", async () => {
  const run = await makeRun({ contract: { tasks: NAV_TASKS, interfaces: NAV_INTERFACES } });
  const exe = run.store.id;
  const emit = (events) => run.store.transact(() => ({ events: events.map((e) => ({ source: runner, ...e })) }));
  await emit([
    { type: "agent.registered", payload: { agent: "w-nav", persona: "builder", driver: "claude-code", token_sha256: "a".repeat(64), external: false } },
    { type: "task.claimed", payload: { task: "build-nav-bar", agent: "w-nav", attempt: 1, ttl_s: 0 } },
    { type: "task.progress", source: { kind: "agent", id: "w-nav", task: "build-nav-bar", pid: 1 }, payload: { task: "build-nav-bar", percent: 60, note: "Links done, dropdown next" } },
    { type: "agent.registered", payload: { agent: "w-header", persona: "builder", driver: "claude-code", token_sha256: "b".repeat(64), external: false } },
    { type: "task.claimed", payload: { task: "header", agent: "w-header", attempt: 1, ttl_s: 0 } },
    { type: "check.started", payload: { command_id: "pass", scope: "task", task: "header" } },
    { type: "check.passed", payload: { command_id: "pass", scope: "task", task: "header", duration_ms: 20 } },
    { type: "escalation.raised", correlation: "esc-nav", payload: { escalation: { id: "esc-nav", agent: "w-header", task: "header", kind: "ambiguity", with: "orchestrator", summary: "Sticky or static header?", question: "Sticky?", options: ["sticky", "static"], blocking: true, status: "open", raised_seq: 0 } } },
    { type: "task.blocked", payload: { task: "header", escalation: "esc-nav" } },
    { type: "escalation.awaiting_human", payload: { id: "esc-nav", class: "human_action", message: "Ask the human" } },
    { type: "budget.usage_recorded", payload: { agent: "w-nav", task: "build-nav-bar", source: "worker", model: "m", tokens: { inputTokens: 10, outputTokens: 5 }, usd: 4, estimated: false } },
  ]);
  const r = parse(await handleToolCall("execution_status", { execution_id: exe, focus: "how close is the nav?" }));
  assert.deepEqual(ensured, [exe], "a live run gets ensureRunner");
  assert.deepEqual(r.focus.matches.map((m) => m.task), ["build-nav-bar", "header"]);
  // build-nav-bar in progress at 60% (0.6), header blocked with an agent (0.4): 50%.
  assert.equal(r.completion_pct, 50);
  assert.equal(r.run_completion_pct, 25);
  assert.equal(r.tasks.total, 2);
  assert.deepEqual(r.blockers.map((b) => b.kind).sort(), ["awaiting_human", "blocked_task"]);
  assert.equal(r.latest_checks[0].check, "header/pass");
  assert.equal(r.latest_checks[0].status, "passed");
  assert.equal(r.budget.spent_usd, 4);
  assert.equal(r.budget.budget_usd, 50);
  assert.equal(r.budget.pct, 8);
  assert.equal(r.eta.minutes, undefined, "no accepted task yet");
  assert.equal(r.runner.state, "stopped");
  assert.deepEqual(r.dashboard, { requested: false });
  assert.equal(r.github, undefined, "chat_only: no GitHub section");
  assert.equal(r.watchers.main.alive, false);
  assert.ok(r.next.some((n) => /watcher is not running/.test(n)) && r.next.some((n) => /awaits the human/.test(n)), JSON.stringify(r.next));
  assert.equal(r.escalations.awaiting_human, 1);

  const esc = parse(await handleToolCall("execution_status", { execution_id: exe, view: "escalations" }));
  assert.equal(esc.escalations[0].id, "esc-nav");
  assert.deepEqual(esc.escalations[0].options, ["sticky", "static"]);
  const tasks = parse(await handleToolCall("execution_status", { execution_id: exe, view: "tasks", focus: "nav" }));
  assert.deepEqual(tasks.tasks.map((t) => [t.id, t.weight_pct]), [["build-nav-bar", 60], ["header", 40]]);
  assert.deepEqual(tasks.tasks[1].checks, [{ command: "pass", status: "passed" }]);
  const events = parse(await handleToolCall("execution_status", { execution_id: exe, view: "events", since_seq: 3, limit: 2 }));
  assert.deepEqual(events.events.map((e) => e.seq), [4, 5]);
  assert.equal(events.next_since_seq, 5);
  const focusedEvents = parse(await handleToolCall("execution_status", { execution_id: exe, view: "events", focus: "header", since_seq: 0 }));
  assert.ok(focusedEvents.events.length && focusedEvents.events.every((e) => JSON.stringify(e).includes("header")));
  const budget = parse(await handleToolCall("execution_status", { execution_id: exe, view: "budget" }));
  assert.deepEqual(budget.budget.by_agent, { "w-nav": 4 });
  const nothing = parse(await handleToolCall("execution_status", { execution_id: exe, focus: "zebra" }));
  assert.match(nothing.warnings[0], /Nothing in the run matches "zebra"/);
  assert.equal(nothing.completion_pct, 25);
});

test("execution_status view context: blackboard only, no confirmation, no original prompt, no secrets", async (t) => {
  const run = await makeRun({ contract: { tasks: NAV_TASKS, interfaces: NAV_INTERFACES } });
  const exe = run.store.id;
  const secret = "zq7Xv2pL9mW4rT8sK3nB";
  await run.store.transact(() => ({
    events: [
      { type: "note.posted", source: { kind: "agent", id: "w-nav", pid: 1 }, payload: { topic: "nav", text: `Deploy token is ${secret}, nav uses flexbox`, refs: [] } },
      { type: "escalation.raised", source: runner, correlation: "esc-nav", payload: { escalation: { id: "esc-nav", agent: "w-nav", task: "build-nav-bar", kind: "ambiguity", with: "orchestrator", summary: "Dropdown or mega menu?", blocking: false, status: "open", raised_seq: 0 } } },
    ],
  }));
  // Set after the note was written, so only the context's own scrub can catch it.
  process.env.ROUNDTABLE_WS11_TEST_API_KEY = secret;
  t.after(() => delete process.env.ROUNDTABLE_WS11_TEST_API_KEY);
  const whole = parse(await handleToolCall("execution_status", { execution_id: exe, view: "context" }));
  const focused = parse(await handleToolCall("execution_status", { execution_id: exe, view: "context", focus: "nav" }));
  const escalation = parse(await handleToolCall("execution_status", { execution_id: exe, view: "context", focus: "esc-nav" }));
  for (const r of [whole, focused, escalation]) {
    assert.ok(!r.context.includes(secret), "a secret reached the context");
    assert.ok(!r.context.includes("Please build the test app"), "the human's original prompt reached the context");
    assert.ok(!/confirmation|"go"/.test(r.context), "the confirmation reached the context");
    assert.match(r.context, /## Contract/);
    assert.match(r.next, /to_table: true/);
  }
  assert.match(whole.context, /Deploy token is \[redacted:env:ROUNDTABLE_WS11_TEST_API_KEY\]/);
  assert.match(whole.context, /Ship the test app/);
  assert.match(whole.context, /MenuTokens/);
  assert.match(whole.context, /Dropdown or mega menu\?/);
  assert.deepEqual(focused.tasks, ["build-nav-bar", "header"]);
  assert.ok(!focused.context.includes("`api`"), "focus keeps other tasks out");
  assert.equal(escalation.escalation, "esc-nav");
  assert.match(escalation.context, /## Escalation esc-nav/);
});
