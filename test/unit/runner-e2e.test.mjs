// The runner end to end, offline: a temp repository, a contract from direct events, the local
// sandbox and a fake claude that drives the real worker MCP server (fixtures/runner/harness.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, nodeCommand, task } from "../fixtures/workers/run.mjs";
import { fakeClaude, killFakes, localSandboxSkip, ofType, startRunner, waitFor } from "../fixtures/runner/harness.mjs";

const { verifyRun } = await import("../../dist/execution/run-admin.js");
const { integrationBranch, taskBranch } = await import("../../dist/execution/git.js");
const { readRunnerInfo } = await import("../../dist/execution/runner-launch.js");

const skip = localSandboxSkip();

const twoTasks = (over = {}) => ({
  tasks: [task("a", { checks: ["unit"] }), task("b", { depends_on: ["a"], checks: ["unit"] })],
  validation: {
    commands: [
      nodeCommand("unit", "process.exit(0)"),
      nodeCommand("final", "const fs = require('fs'); fs.accessSync('src/a/a.txt'); fs.accessSync('src/b/b.txt'); console.log('both files present')"),
    ],
    final: ["final"],
  },
  ...over,
});

function within(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out: ${typeof what === "function" ? what() : what}`)), ms)))]).finally(() => clearTimeout(timer));
}

test("end to end: B after A, both merged into the integration branch, checks passed, completed and verified", { skip, timeout: 240_000 }, async (t) => {
  const fake = fakeClaude(t);
  const run = await makeRun({ contract: twoTasks() });
  const r = startRunner(run.store.id, { ROUNDTABLE_SMOKE_CHECKS: "unit" });
  t.after(() => {
    r.child.kill("SIGKILL");
    killFakes(fake);
  });
  const exit = await within(r.exited, 200_000, () => `the run to finish; runner log:\n${r.stderr()}`);
  assert.equal(exit.code, 0, r.stderr());

  const events = await run.store.events();
  const seqOf = (type, taskId) => events.find((e) => e.type === type && e.payload.task === taskId)?.seq;
  // Dependency order: B is claimed only after A is accepted.
  assert.ok(seqOf("task.accepted", "a") < seqOf("task.claimed", "b"), "B starts after A is accepted");
  assert.ok(seqOf("task.accepted", "a") < seqOf("task.accepted", "b"));
  for (const id of ["a", "b"]) {
    const claimed = events.find((e) => e.type === "task.claimed" && e.payload.task === id);
    assert.equal(claimed.payload.ttl_s, 0, "runner workers are pre-claimed with ttl 0");
    const reg = events.filter((e) => e.type === "agent.registered" && e.payload.agent === `w-${id}`);
    assert.ok(reg.length >= 1 && reg[0].seq <= claimed.seq, "registered in the claim's transaction");
    assert.equal(ofType(events, "agent.spawned").filter((e) => e.payload.task === id).length, 1, `one spawn for ${id}`);
    assert.ok(events.some((e) => e.type === "agent.attested" && e.payload.agent === `w-${id}` && e.payload.ok));
    assert.ok(events.some((e) => e.type === "merge.succeeded" && e.payload.task === id));
    assert.ok(events.some((e) => e.type === "lease.granted" && e.payload.lease.task === id));
  }

  // The integration branch holds both files.
  const integ = integrationBranch(run.store.id);
  assert.equal(git(run.root, "show", `${integ}:src/a/a.txt`), "a by w-a");
  assert.equal(git(run.root, "show", `${integ}:src/b/b.txt`), "b by w-b");
  assert.equal(git(run.root, "rev-parse", "main"), run.sha, "the base branch is untouched");

  // Integration checks: the smoke subset after each merge, then the final validation.
  const integration = events.filter((e) => e.type.startsWith("check.") && e.payload.scope === "integration");
  assert.ok(integration.some((e) => e.type === "check.passed" && e.payload.command_id === "unit"));
  assert.ok(integration.some((e) => e.type === "check.passed" && e.payload.command_id === "final"));
  assert.ok(!integration.some((e) => e.type === "check.failed"), JSON.stringify(integration.filter((e) => e.type === "check.failed")));

  // Completed, at the integration head; leases released; the chain verifies.
  const [done] = ofType(events, "execution.completed");
  assert.ok(done, r.stderr());
  assert.equal(done.payload.integration_sha, git(run.root, "rev-parse", integ));
  const state = await run.store.state();
  assert.equal(state.status, "completed");
  assert.deepEqual(Object.keys(state.leases), [], "every lease is released after acceptance");
  assert.equal((await verifyRun(run.store.id)).ok, true);

  // The budget ledger has the workers' usage.
  assert.equal(ofType(events, "budget.usage_recorded").filter((e) => e.payload.source === "worker").length, 2);
  assert.ok(Math.abs(state.budget.by_agent["w-a"] - 0.05) < 1e-9 && Math.abs(state.budget.by_agent["w-b"] - 0.05) < 1e-9);
  assert.ok(Math.abs(state.budget.spent_usd - 0.1) < 1e-9);

  // Lifecycle events and files.
  assert.equal(ofType(events, "runner.started").length, 1);
  assert.equal(ofType(events, "runner.stopped").at(-1).payload.reason, "completed");
  assert.equal(ofType(events, "runner.takeover").length, 0);
  const info = readRunnerInfo(run.store.id);
  assert.equal(info.pid, r.pid);
  assert.ok(info.stoppedAt);
  assert.ok(existsSync(join(run.store.dir, "snapshot.json")), "the runner writes the final snapshot");
  // The first card carries the task; B's lists A as a finished dependency.
  const cardB = fake.launches("w-b")[0].input;
  assert.match(cardB, /# Task b:/);
  assert.match(cardB, /`a` \(accepted\)/);
  assert.match(readFileSync(join(run.store.dir, "agents", "w-a", "runs", "1.jsonl"), "utf8"), /"type":"result"/);
});

test("crash and resume: a second runner refuses while the first lives, then takes over, adopts the live worker and completes with no second spawn", { skip, timeout: 240_000 }, async (t) => {
  const fake = fakeClaude(t, { "w-a": { waitFor: "release-a" } });
  const run = await makeRun({ contract: twoTasks() });
  const first = startRunner(run.store.id, { ROUNDTABLE_SMOKE_CHECKS: "unit" });
  t.after(() => {
    first.child.kill("SIGKILL");
    killFakes(fake);
  });
  await waitFor(async () => (await run.store.events()).some((e) => e.type === "agent.spawned" && e.payload.agent === "w-a"), 60_000, "A to spawn");
  await waitFor(() => fake.launches("w-a").length === 1, 30_000, "the fake to start");

  // While the first runner lives, a second one refuses.
  const refused = startRunner(run.store.id);
  const rr = await within(refused.exited, 30_000, "the second runner to refuse");
  assert.equal(rr.code, 1);
  assert.match(refused.stderr(), /Another runner \(pid \d+/);

  // Kill the first runner hard: no runner.stopped, the lock and runner.json stay behind.
  first.child.kill("SIGKILL");
  await first.exited;
  const [spawned] = ofType(await run.store.events(), "agent.spawned");
  assert.ok(process.kill(spawned.payload.pid, 0) === true, "the worker outlives its runner (detached)");

  const second = startRunner(run.store.id, { ROUNDTABLE_SMOKE_CHECKS: "unit" });
  t.after(() => second.child.kill("SIGKILL"));
  await waitFor(async () => (await run.store.events()).some((e) => e.type === "runner.takeover"), 30_000, "the takeover");
  await waitFor(() => /adopted w-a on a/.test(second.stderr()), 30_000, `adoption; log:\n${second.stderr()}`);
  fake.release("release-a");
  const exit = await within(second.exited, 200_000, () => `the run to finish; log:\n${second.stderr()}`);
  assert.equal(exit.code, 0, second.stderr());

  const events = await run.store.events();
  const [takeover] = ofType(events, "runner.takeover");
  assert.equal(takeover.payload.previous_pid, first.pid);
  const started = ofType(events, "runner.started");
  assert.equal(started.length, 2);
  assert.ok(takeover.seq < started[1].seq);
  assert.equal(ofType(events, "agent.spawned").filter((e) => e.payload.agent === "w-a").length, 1, "A was adopted, never spawned again");
  assert.equal(fake.launches("w-a").length, 1);
  assert.equal(ofType(events, "agent.attested").filter((e) => e.payload.agent === "w-a").length, 1, "the adopted run is not attested twice");
  assert.equal(ofType(events, "budget.usage_recorded").filter((e) => e.payload.agent === "w-a").length, 1);
  const exitA = events.find((e) => e.type === "agent.exited" && e.payload.agent === "w-a");
  assert.equal(exitA.payload.reason, "completed");
  assert.equal((await run.store.state()).status, "completed");
  assert.equal((await verifyRun(run.store.id)).ok, true);
});

test("resume reconciliation: a worker that died with its runner gets its WIP snapshotted and is resumed with an interrupted card", { skip, timeout: 240_000 }, async (t) => {
  const fake = fakeClaude(t, { "w-a": { waitFor: "never" } });
  const run = await makeRun({ contract: twoTasks({ tasks: [task("a", { checks: ["unit"] })], validation: { commands: [nodeCommand("unit", "process.exit(0)")], final: ["unit"] } }) });
  const first = startRunner(run.store.id, { ROUNDTABLE_SMOKE_CHECKS: "unit" });
  t.after(() => {
    first.child.kill("SIGKILL");
    killFakes(fake);
  });
  await waitFor(() => fake.launches("w-a").length === 1, 60_000, "A to start");
  first.child.kill("SIGKILL");
  await first.exited;
  // The worker dies too, leaving uncommitted work in its worktree.
  const [launch] = fake.launches("w-a");
  process.kill(launch.pid, "SIGKILL");
  await waitFor(() => {
    try {
      process.kill(launch.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000, "the worker to die");
  const wt = join(process.env.ROUNDTABLE_HOME, "worktrees", run.store.id, "a");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(wt, "src", "a"), { recursive: true });
  writeFileSync(join(wt, "src", "a", "draft.txt"), "half done\n");
  fake.setBehavior({});

  const second = startRunner(run.store.id, { ROUNDTABLE_SMOKE_CHECKS: "unit" });
  t.after(() => second.child.kill("SIGKILL"));
  const exit = await within(second.exited, 200_000, () => `the run to finish; log:\n${second.stderr()}`);
  assert.equal(exit.code, 0, second.stderr());
  const events = await run.store.events();
  const lost = events.find((e) => e.type === "agent.exited" && e.payload.agent === "w-a" && e.payload.reason === "lost");
  assert.ok(lost, "the dead worker is recorded as lost");
  const reRegistered = events.filter((e) => e.type === "agent.registered" && e.payload.agent === "w-a");
  assert.equal(reRegistered.length, 2, "re-registered with a fresh token");
  assert.equal(reRegistered[1].seq, lost.seq + 1, "the loss and the re-registration are one transaction");
  assert.notEqual(reRegistered[0].payload.token_sha256, reRegistered[1].payload.token_sha256);
  const second_launch = fake.launches("w-a")[1];
  assert.equal(second_launch.resume, true, "the session is resumed");
  assert.equal(second_launch.sid, fake.launches("w-a")[0].sid);
  assert.match(second_launch.input, /## You were interrupted/);
  assert.match(second_launch.input, /rt: wip snapshot/);
  assert.match(git(run.root, "log", "--format=%s", taskBranch(run.store.id, "a")), /rt: wip snapshot/);
  assert.equal(git(run.root, "show", `${integrationBranch(run.store.id)}:src/a/draft.txt`), "half done", "the WIP was kept and merged");
  assert.equal((await run.store.state()).status, "completed");
});
