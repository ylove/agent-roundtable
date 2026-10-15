import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDrafts, claim, escalations, eventTypes, lease, makeState, ofType, request, task } from "../fixtures/execution-state.mjs";

const { stronglyConnected, waitForGraph, findDeadlocks, deadlockRules } = await import("../../dist/execution/deadlock.js");
const { actionsToDrafts } = await import("../../dist/execution/watchdog-actions.js");

const settle = (state, actions) => applyDrafts(state, actionsToDrafts(actions));

test("Tarjan finds strongly connected components in a deterministic order", () => {
  const graph = new Map([
    ["e", ["f"]],
    ["a", ["b"]],
    ["b", ["c", "e"]],
    ["c", ["a"]],
    ["f", ["e"]],
    ["g", ["a"]],
  ]);
  const sccs = stronglyConnected(graph);
  assert.deepEqual(sccs.filter((c) => c.length > 1), [["e", "f"], ["a", "b", "c"]]);
  const reversed = new Map([...graph.entries()].reverse().map(([k, v]) => [k, [...v].reverse()]));
  assert.deepEqual(stronglyConnected(reversed), sccs, "insertion order does not matter");
});

/** a holds a lease b waits for; a needs the interface b owns. */
function leaseCycle() {
  const s = makeState({ tasks: [task("a"), task("b")] });
  claim(s, "a", "w-a");
  claim(s, "b", "w-b");
  s.interfaces.api = { spec: { name: "api", kind: "api", owner: "b", description: "" }, version: 0 };
  s.leases = { La: lease("La", "a", "w-a", ["src/shared/**"]) };
  s.lease_queue = [request("Rb", "b", "w-b", ["src/shared/types.ts"], "exclusive", ["La"], 40)];
  return { s, needs: [{ task: "a", need: { kind: "interface", ref: "api" } }] };
}

test("a cycle through a lease and an interface need is detected and escalated to the orchestrator", () => {
  const { s, needs } = leaseCycle();
  assert.deepEqual(
    waitForGraph(s, needs).map((e) => [e.from, e.to, e.via, e.ref]),
    [
      ["b", "a", "lease", "La"],
      ["a", "b", "need", "api"],
    ]
  );
  const actions = deadlockRules(s, needs);
  assert.deepEqual(eventTypes(actions), ["watchdog.deadlock_detected", "escalation.raised"]);
  assert.deepEqual(ofType(actions, "watchdog.deadlock_detected")[0].payload, { cycle: ["a", "b"] });
  const [esc] = escalations(actions);
  assert.equal(esc.kind, "blocker");
  assert.equal(esc.with, "orchestrator");
  assert.equal(esc.target, "main");
  assert.match(esc.summary, /a needs api from b; b waits for lease La held by a/);

  // Once per distinct cycle.
  const after = settle(s, actions);
  assert.deepEqual(after.watchdog.deadlocks, [["a", "b"]]);
  assert.deepEqual(deadlockRules(after, needs), []);
  // Recorded only (escalation gone from view) still counts as reported.
  const recordedOnly = { ...s, watchdog: { ...s.watchdog, deadlocks: [["b", "a"]] } };
  assert.deepEqual(deadlockRules(recordedOnly, needs), []);
});

test("publishing the interface or finishing a task breaks the cycle", () => {
  const { s, needs } = leaseCycle();
  s.interfaces.api.version = 1;
  assert.deepEqual(findDeadlocks(s, needs), []);
  const done = leaseCycle();
  done.s.tasks.a.state = "accepted";
  assert.deepEqual(findDeadlocks(done.s, done.needs), []);
});

test("blocked_by deps and contract dependencies form cycles in cycle order", () => {
  const s = makeState({ tasks: [task("c"), task("a"), task("b"), task("z", { spec: { depends_on: ["a"] } })] });
  for (const [t, dep] of [["a", "b"], ["b", "c"], ["c", "a"]]) {
    s.tasks[t].state = "blocked";
    s.tasks[t].blocked_by = { deps: [dep] };
  }
  const [d] = findDeadlocks(s);
  assert.deepEqual(d.cycle, ["a", "b", "c"]);
  assert.deepEqual(d.members, ["a", "b", "c"]);
  const [esc] = escalations(deadlockRules(s));
  assert.match(esc.summary, /^Deadlock between a, b, c: a is blocked on b; b is blocked on c; c is blocked on a\.$/);
});

test("a dependency DAG is not a deadlock, and two cycles are reported separately", () => {
  const dag = makeState({ tasks: [task("a"), task("b", { spec: { depends_on: ["a"] } }), task("c", { spec: { depends_on: ["a", "b"] } })] });
  assert.deepEqual(findDeadlocks(dag), []);

  const s = makeState({ tasks: ["p", "q", "x", "y"].map((id) => task(id)) });
  const needs = [
    { task: "p", need: { kind: "task", ref: "q" } },
    { task: "q", need: { kind: "task", ref: "p" } },
    { task: "y", need: { kind: "task", ref: "x" } },
    { task: "x", need: { kind: "task", ref: "y" } },
  ];
  assert.deepEqual(findDeadlocks(s, needs).map((d) => d.cycle), [["p", "q"], ["x", "y"]]);
  assert.equal(escalations(deadlockRules(s, needs)).length, 2);
  assert.deepEqual(findDeadlocks(s, [...needs].reverse()).map((d) => d.cycle), [["p", "q"], ["x", "y"]], "order-independent");
});

test("a larger strongly connected group reports its shortest cycle through the smallest task", () => {
  const s = makeState({ tasks: ["a", "b", "c", "d"].map((id) => task(id)) });
  const needs = [
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
    ["b", "d"],
    ["d", "b"],
  ].map(([t, ref]) => ({ task: t, need: { kind: "task", ref } }));
  const [d] = findDeadlocks(s, needs);
  assert.deepEqual(d.cycle, ["a", "b", "c"]);
  assert.deepEqual(d.members, ["a", "b", "c", "d"]);
  assert.match(escalations(deadlockRules(s, needs))[0].summary, /also includes d/);
});
