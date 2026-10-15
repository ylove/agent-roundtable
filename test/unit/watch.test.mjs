import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRun, runner } from "../fixtures/workers/run.mjs";
import { cli } from "../fixtures/runner/harness.mjs";

const { watchExecution, readWatchFile, watcherObservations } = await import("../../dist/execution/watch.js");
const append = (store, events) => store.transact(() => ({ events: events.map(([type, payload]) => ({ type, source: runner, payload })) }));
const raise = (id) => ["escalation.raised", { escalation: { id, agent: "worker", kind: "blocker", with: "orchestrator", task: "api", summary: "Need a decision\nwith details", blocking: false, status: "open", raised_seq: 0 } }];

for (const [type, payload, reason] of [
  ["execution.completed", { integration_sha: "a".repeat(40) }, "completed"],
  ["execution.failed", { reason: "test" }, "failed"],
  ["execution.aborted", { reason: "test" }, "aborted"],
  ["budget.threshold_crossed", { pct: 80, spent_usd: 40, budget_usd: 50 }, "budget"],
  ["budget.threshold_crossed", { pct: 100, spent_usd: 50, budget_usd: 50 }, "budget"],
  ["escalation.routed", { id: "esc-test", to: "main", wake: true }, "escalation"],
  ["escalation.awaiting_human", { id: "esc-test", class: "money", message: "need budget" }, "awaiting_human"],
]) {
  test(`watch wakes on ${type} (${payload.pct ?? reason}) and CLI prints one JSON line`, async () => {
    const { store } = await makeRun();
    await append(store, [...(type.startsWith("escalation.") ? [raise("esc-test")] : []), [type, payload]]);
    const result = await cli(["watch", store.id, "--as", "main", "--timeout-min", "0.01"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const wake = JSON.parse(result.stdout);
    assert.equal(wake.reason, reason);
    assert.equal(wake.execution, store.id);
    assert.equal(wake.seq, (await store.state()).seq);
    if (type.startsWith("escalation.")) assert.equal(wake.escalation.id, "esc-test");
    assert.equal(readWatchFile(store.id, "main").cursor, wake.seq);
    assert.equal(watcherObservations(store.id).main.alive, false);
    if (type.startsWith("execution.")) assert.equal((await watchExecution(store.id, { as: "main", timeoutMin: 0 })).reason, reason);
  });
}

test("watch ignores unrelated, resolved and non-waking routes and 50%, resumes its cursor", async () => {
  const { store } = await makeRun();
  await append(store, [raise("esc-a"), ["escalation.routed", { id: "esc-a", to: "main", wake: true }], ["escalation.resolved", { id: "esc-a", action: "dismiss", decision: "done", by: "main" }], raise("esc-b"), ["escalation.routed", { id: "esc-b", to: "other", wake: true }], ["escalation.routed", { id: "esc-b", to: "main", wake: false }], ["budget.threshold_crossed", { pct: 50, spent_usd: 25, budget_usd: 50 }]]);
  assert.equal((await watchExecution(store.id, { as: "main", timeoutMin: 0 })).reason, "timeout");
  const cursor = readWatchFile(store.id, "main").cursor;
  await append(store, [["escalation.routed", { id: "esc-b", to: "main", wake: true }]]);
  const wake = await watchExecution(store.id, { as: "main", timeoutMin: 0 });
  assert.equal(wake.reason, "escalation");
  assert.ok(wake.seq > cursor);
  assert.equal((await watchExecution(store.id, { as: "main", timeoutMin: 0 })).reason, "timeout");
});

test("watch writes live observations while waiting and timeout prints exactly one line", async () => {
  const { store } = await makeRun();
  const promise = watchExecution(store.id, { as: "main", timeoutMin: 0.002, pollMs: 5, livenessMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(watcherObservations(store.id).main.alive, true);
  assert.ok(Date.parse(readWatchFile(store.id, "main").lastSeenAt) >= Date.parse(readWatchFile(store.id, "main").startedAt));
  assert.equal((await promise).reason, "timeout");
  const result = await cli(["watch", store.id, "--as", "main", "--timeout-min", "0.0001"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).reason, "timeout");
  await assert.rejects(watchExecution(store.id, { as: "../bad", timeoutMin: 0 }));
});
