import { test } from "node:test";
import assert from "node:assert/strict";
import { supervise } from "../../dist/serve/supervisor.js";
import { runnerLiveness, writeRunnerInfo } from "../../dist/execution/runner-launch.js";
import { hostname } from "node:os";
import { frozenRun } from "../fixtures/execution/run.mjs";

const dead = { id: "exe", status: "running", runner: { state: "dead", pid: 42 } };
test("serve supervisor relaunches only a dead runner of an active local run", () => {
  assert.equal(supervise(dead, 0).action, "relaunch");
  for (const state of ["running", "other_host", "stopped"]) assert.equal(supervise({ ...dead, runner: { state, pid: 42, stale: true, host: "remote" } }, 0).action, "none");
  assert.equal(supervise({ ...dead, runner: { state: "stopped", pid: 42 }, alive: false }, 0).action, "relaunch");
  assert.equal(supervise({ ...dead, runner: { state: "stopped", pid: 42 }, alive: true }, 0).action, "none");
  for (const status of ["completed", "failed", "paused", "aborted"]) assert.equal(supervise({ ...dead, status }, 0).action, "none");
});

test("serve supervisor backs off, caps six relaunches per rolling hour and notifies once", () => {
  let decision = supervise(dead, 0);
  assert.deepEqual(decision.history.attempts, [0]);
  assert.equal(supervise(dead, 14_999, decision.history).action, "none");
  decision = supervise(dead, 15_000, decision.history);
  assert.equal(decision.action, "relaunch");
  assert.equal(supervise(dead, 74_999, decision.history).action, "none");
  decision = supervise(dead, 75_000, decision.history);
  assert.equal(decision.action, "relaunch");
  assert.equal(supervise(dead, 374_999, decision.history).action, "none");
  for (const at of [375_000, 675_000, 975_000]) decision = supervise(dead, at, decision.history);
  assert.equal(decision.history.attempts.length, 6);
  decision = supervise(dead, 990_000, decision.history);
  assert.equal(decision.action, "notify");
  assert.equal(supervise(dead, 1_000_000, decision.history).action, "none");
  assert.equal(supervise(dead, 3_600_000, decision.history).action, "relaunch");
});

test("serve liveness protects live pids and remote runner info even without a lock", async () => {
  const { store } = await frozenRun();
  const info = { pid: process.pid, host: hostname(), startedAt: "2000-01-01T00:00:00Z", heartbeatAt: "2000-01-01T00:00:00Z", version: "test" };
  writeRunnerInfo(store.id, info);
  assert.equal(runnerLiveness(store.id).state, "running");
  assert.equal(runnerLiveness(store.id).stale, true);
  writeRunnerInfo(store.id, { ...info, stoppedAt: new Date().toISOString() });
  assert.equal(runnerLiveness(store.id).state, "stopped", "a recorded clean stop stays stopped while its host process lives");
  writeRunnerInfo(store.id, { ...info, host: "different-host" });
  assert.equal(runnerLiveness(store.id).state, "other_host");
});
