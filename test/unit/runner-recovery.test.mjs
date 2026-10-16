import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { installProcessIdentity, setProcessIdentity } from "../fixtures/execution/process-identity.mjs";
import { makeRun, runner, task } from "../fixtures/workers/run.mjs";
import { git, write } from "../fixtures/execution/git-fixture.mjs";
import { scriptedDriver, sandbox, submit, stream, resultLine } from "../fixtures/runner/driver.mjs";

installProcessIdentity();
const { Runner, readRunFile } = await import("../../dist/execution/runner.js");
const { processStart, acquireLock } = await import("../../dist/execution/lock.js");
const { runnerLiveness, runnerLockDir, writeRunnerInfo, ensureRunner } = await import("../../dist/execution/runner-launch.js");
const { taskBranch, integrationBranch } = await import("../../dist/execution/git.js");
const { snapshotWip, executionWorktreesDir } = await import("../../dist/execution/worktrees.js");
const { writeHandoff, takeHandoffs } = await import("../../dist/execution/handoff.js");
const { sweepRetention } = await import("../../dist/execution/retention.js");
const { remainingUsd } = await import("../../dist/execution/budget.js");

const emit = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));
const eventsOf = async (store, type) => (await store.events()).filter((e) => e.type === type);
async function until(fn, message = "condition") {
  const end = performance.now() + 10000;
  while (!(await fn())) {
    if (performance.now() > end) throw new Error("Timed out: " + message);
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function setup(t, contract = {}, opts = {}) {
  const run = await makeRun({ contract: { tasks: [task("a")], ...contract } });
  const driver = scriptedDriver(t);
  const create = () => {
    const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 20, ...opts });
    t.after(async () => { r.stop("test cleanup"); await r.run(); });
    return r;
  };
  const r = create();
  await r.start();
  return { ...run, driver, r, create };
}
async function stoppedRunner(r) { r.stop("simulate crash"); await r.run(); }
async function completedTask(f) {
  await f.r.tick();
  const h = f.driver.calls[0];
  await until(() => readFileSync(h.outputPath, "utf8").includes("init"));
  await submit(f.store, h);
  stream(h, [resultLine()]);
  await f.driver.stop(h);
  await until(async () => { await f.r.tick(); return (await f.store.state()).tasks.a.state === "accepted" && !f.r.hasAnyLiveWorker(); });
}
async function completionOutcome(f) {
  await until(async () => { await f.r.tick(); return (await eventsOf(f.store, "note.posted")).some((e) => e.payload.topic === "completion-outcome"); });
  await until(() => !f.r.merge.busy());
}

test("1: post-check WIP commit is excluded from the merge, and recovery never snapshots merging work", async (t) => {
  const f = await setup(t);
  await f.r.tick();
  const h = f.driver.calls[0];
  await until(() => readFileSync(h.outputPath, "utf8").includes("init"));
  await submit(f.store, h);
  const checked = (await f.store.state()).tasks.a.last_commit;
  write(h.cwd, "src/a/unchecked.txt", "not checked\n");
  const b = await snapshotWip(h.cwd, "rt: wip snapshot", [{ paths: ["src/a/**"] }]);
  assert.notEqual(b.commit, checked);
  write(h.cwd, "src/a/unsaved.txt", "must not snapshot\n");
  await f.driver.stop(h);
  await stoppedRunner(f.r);
  const resumed = f.create();
  await resumed.start();
  assert.equal(git(h.cwd, "rev-parse", "HEAD"), b.commit, "recovery does not snapshot merging work");
  await until(async () => { await resumed.tick(); return (await f.store.state()).tasks.a.state === "accepted"; });
  assert.equal(git(f.root, "show", integrationBranch(f.store.id) + ":src/a/a.txt"), "a");
  assert.equal(git(f.root, "ls-tree", "--name-only", integrationBranch(f.store.id), "src/a/unchecked.txt"), "");
  assert.equal(f.driver.calls.length, 1, "merging work needs no replacement worker");
});

test("2: child survives loss before run.json and agent.spawned; recovery adopts without a second spawn", async (t) => {
  const f = await setup(t);
  // Prevent the parent's post-spawn writes, while retaining the child-owned launch lock/receipt.
  const originalWrite = f.r.writeRun;
  const originalCommit = f.r.commit;
  f.r.writeRun = () => {};
  f.r.commit = async (drafts) => {
    if (drafts.some((e) => e.type === "agent.spawned")) throw new Error("crash after spawn");
    return originalCommit.call(f.r, drafts);
  };
  await f.r.startWorker("a", { claim: true });
  const h = f.driver.calls[0];
  await until(() => existsSync(join(f.store.dir, "agents", h.agent, "launch.json.receipt")));
  assert.equal(readRunFile(f.store.id, h.agent), null);
  assert.equal((await eventsOf(f.store, "agent.spawned")).length, 0);
  f.r.writeRun = originalWrite;
  await stoppedRunner(f.r);
  const resumed = f.create();
  await resumed.start();
  await resumed.tick();
  assert.equal(f.driver.calls.length, 1);
  assert.equal(resumed.workerRecord(h.agent).pid, h.pid);
  assert.equal((await eventsOf(f.store, "agent.spawned")).length, 1);
  assert.equal((await f.store.state()).agents[h.agent].started, processStart(h.pid));
});

test("3: process loss after check.started durably rejects and resumes the interrupted submission", async (t) => {
  const f = await setup(t);
  await f.r.tick();
  const h = f.driver.calls[0];
  await until(() => readFileSync(h.outputPath, "utf8").includes("init"));
  await submit(f.store, h, { checks: false });
  const rt = (await f.store.state()).tasks.a;
  await emit(f.store, "check.started", { scope: "task", task: "a", command_id: "pass", commit: rt.last_commit, submitted_seq: rt.submitted_seq });
  assert.equal((await f.store.state()).tasks.a.state, "checking");
  await f.driver.stop(h);
  await stoppedRunner(f.r);
  const resumed = f.create();
  await resumed.start();
  assert.equal(f.driver.calls.length, 2);
  assert.equal((await f.store.state()).tasks.a.state, "in_progress");
  assert.match((await eventsOf(f.store, "task.rejected")).at(-1).payload.reasons[0], /checks were interrupted/);
  await submit(f.store, f.driver.calls[1]);
  assert.equal((await f.store.state()).tasks.a.state, "merging");
});

test("4: crash after taking retry handoff still stops the unclaimed old attempt", async (t) => {
  const f = await setup(t);
  await f.r.tick();
  const old = f.driver.calls[0];
  await until(() => readFileSync(old.outputPath, "utf8").includes("init"));
  await emit(f.store, "task.retried", { task: "a", attempt: 2, why: "retry" });
  writeHandoff(f.store.id, [{ type: "kill_worker", rule: "escalation", key: "retry-kill", target: old.agent, agent: old.agent, reason: "retried" }], "main");
  assert.equal(takeHandoffs(f.store.id).length, 1);
  // Simulate even the legacy destructive take: durable claim/attempt state must suffice.
  rmSync(join(f.store.dir, "handoff"), { recursive: true, force: true });
  await stoppedRunner(f.r);
  const resumed = f.create();
  await resumed.start();
  await until(async () => { await resumed.tick(); return f.driver.calls.length === 2; });
  assert.equal(f.driver.calls[1].attempt, 2);
  assert.notEqual(f.driver.calls[1].pid, old.pid);
  assert.equal((await eventsOf(f.store, "agent.exited")).some((e) => e.payload.agent === old.agent), true);
});

test("6: parallel launch allocations and replayed reservations never exceed the execution cap", async (t) => {
  const f = await setup(t, { tasks: [task("a"), task("b")], budget: { usd: 10, per_task_usd: 10, max_parallel: 2, max_attempts: 3, wall_clock_min: 60 } });
  await Promise.all([f.r.startWorker("a", { claim: true }), f.r.startWorker("b", { claim: true })]);
  assert.equal(f.driver.calls.length, 1);
  assert.equal(f.driver.calls.reduce((n, c) => n + c.budgetUsd, 0), 10);
  assert.equal(remainingUsd(await f.store.state()), 0);
  const reserved = await eventsOf(f.store, "agent.registered");
  assert.equal(reserved.reduce((n, e) => n + (e.payload.budget_usd ?? 0), 0), 10);
  const { openExecutionStore } = await import("../../dist/execution/store.js");
  assert.equal(remainingUsd(await (await openExecutionStore(f.store.id)).state()), 0, "reservation survives replay");
  const h = f.driver.calls[0];
  await until(() => readFileSync(h.outputPath, "utf8").includes("init"));
  stream(h, [resultLine(2)]);
  await f.driver.stop(h);
  await until(async () => { await f.r.pollWorkers(); return (await f.store.state()).agents[h.agent].status === "exited"; });
  assert.equal(remainingUsd(await f.store.state()), 8, "result replaces the reservation with actual usage");
});

test("7: retention refuses a missing repository while a worker identity still matches", async (t) => {
  const f = await setup(t);
  await f.r.tick();
  const h = f.driver.calls[0];
  await until(() => existsSync(join(f.store.dir, "agents", h.agent, "launch.json.receipt")));
  await stoppedRunner(f.r);
  await emit(f.store, "execution.aborted", { reason: "interrupted stop" });
  rmSync(f.root, { recursive: true, force: true });
  const report = await sweepRetention({ now: Date.now() + 40 * 86400000, sessionDays: null, auditDays: null });
  assert.ok(!report.executions.includes(f.store.id));
  assert.match(report.errors.find((s) => s.includes(f.store.id)), /Workers still run/);
  assert.ok(existsSync(f.store.dir));
  assert.ok(existsSync(executionWorktreesDir(f.store.id)));
});

test("8: a reused runner pid is dead to liveness and ensureRunner reaches takeover", async () => {
  const f = await makeRun();
  const lock = runnerLockDir(f.store.id);
  mkdirSync(lock);
  const owner = { pid: process.pid, host: hostname(), at: new Date(Date.now() - 60000).toISOString(), token: "old", started: "different start" };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  writeRunnerInfo(f.store.id, { pid: process.pid, host: hostname(), startedAt: owner.at, heartbeatAt: owner.at, version: "test" });
  assert.equal(runnerLiveness(f.store.id).state, "dead");
  // A terminal run needs no new process; it must still get past the false "running" result.
  await emit(f.store, "execution.aborted", { reason: "done" });
  assert.equal((await ensureRunner(f.store.id)).status, "terminal");
  const release = await acquireLock(lock, { staleMs: 0, timeoutMs: 0 });
  release();
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ ...owner, started: processStart(process.pid) }));
  assert.equal(runnerLiveness(f.store.id).state, "running", "a matching owner with a stale heartbeat stays protected");
});

test("9a: goal review call failures persist backoff, retry after restart and escalate after three errors", async (t) => {
  let calls = 0;
  const f = await setup(t, {}, { hooks: { goalReview: async () => { calls++; throw new Error("provider unavailable"); } } });
  await completedTask(f);
  await completionOutcome(f);
  assert.equal(calls, 1);
  for (let n = 0; n < 3; n++) await f.r.tick();
  assert.equal(calls, 1);
  await stoppedRunner(f.r);
  const resumed = f.create();
  await resumed.start();
  await resumed.tick();
  await until(() => !resumed.merge.busy());
  assert.equal(calls, 1, "restart preserves backoff");
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: now + 300001 });
  await until(async () => { await resumed.tick(); return calls === 2; });
  await until(() => !resumed.merge.busy());
  t.mock.timers.setTime(now + 600002);
  await until(async () => { await resumed.tick(); return calls === 3; });
  await until(() => !resumed.merge.busy());
  assert.ok((await eventsOf(f.store, "escalation.raised")).some((e) => /goal review failed 3 times/.test(e.payload.escalation.summary)));
  assert.equal((await f.store.state()).status, "running");
  const escalation = (await eventsOf(f.store, "escalation.raised")).at(-1).payload.escalation.id;
  resumed.hooks.goalReview = async () => { calls++; return { verdict: "COMPLETE" }; };
  await emit(f.store, "escalation.resolved", { id: escalation, by: "main", action: "dismiss", decision: "provider is available again" });
  await until(async () => { await resumed.tick(); return (await f.store.state()).status === "completed"; });
  assert.equal(calls, 4);
});

test("9b: resolving an INCOMPLETE review enables another completion attempt at the same SHA", async (t) => {
  let calls = 0;
  const f = await setup(t, {}, { hooks: { goalReview: async () => ({ verdict: ++calls === 1 ? "INCOMPLETE" : "COMPLETE", reason: "review again" }) } });
  await completedTask(f);
  await completionOutcome(f);
  const esc = (await eventsOf(f.store, "escalation.raised")).at(-1).payload.escalation.id;
  await emit(f.store, "escalation.resolved", { id: esc, by: "main", action: "dismiss", decision: "Review again" });
  await until(async () => { await f.r.tick(); return (await f.store.state()).status === "completed"; });
  assert.equal(calls, 2);
});

test("9c: final validation failure can be retried after its escalation is resolved", async (t) => {
  let fail = true;
  const f = await setup(t, { validation: { commands: [{ id: "final", argv: ["true"], timeout_s: 10 }], final: ["final"] } },
    { sandbox: sandbox(async () => { if (fail) throw new Error("final validation failure"); }) });
  await completedTask(f);
  await completionOutcome(f);
  assert.equal((await f.store.state()).status, "running");
  const esc = (await eventsOf(f.store, "escalation.raised")).find((e) => /final validation failed/.test(e.payload.escalation.summary)).payload.escalation.id;
  fail = false;
  await emit(f.store, "escalation.resolved", { id: esc, by: "main", action: "dismiss", decision: "try validation again" });
  await until(async () => { await f.r.tick(); return (await f.store.state()).status === "completed"; });
  assert.equal((await eventsOf(f.store, "check.started")).length, 3, "post-merge smoke check plus two final validations");
});

test("2b: recovery cancels an unstarted launch before a late child can do work", async (t) => {
  const { reconcileLaunch } = await import("../../dist/workers/launch-intent.js");
  const { spawnWorker } = await import("../../dist/workers/process.js");
  const f = await makeRun();
  const path = join(f.store.dir, "launch.json");
  const marker = join(f.store.dir, "should-not-exist");
  const token = "b".repeat(64);
  writeFileSync(path, JSON.stringify({ token_sha256: token, at: new Date().toISOString(), run: {} }));
  assert.equal(await reconcileLaunch(path), null);
  // The relay takes the fence before starting the CLI, so a cancelled launch fails to start.
  await assert.rejects(spawnWorker({
    file: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
    cwd: f.root, env: { PATH: process.env.PATH, ROUNDTABLE_LAUNCH_INTENT: path, ROUNDTABLE_LAUNCH_SHA: token },
    prompt: "", outputPath: join(f.store.dir, "late.jsonl"),
  }), /cancelled/);
  assert.equal(existsSync(marker), false);
});

test("5b: process-group escalation rechecks identity before SIGKILL and skips unknown identities", async (t) => {
  const { stopGroup } = await import("../../dist/workers/process.js");
  const expected = processStart(process.pid);
  const signals = [];
  let groupProbes = 0;
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0 && pid < 0 && ++groupProbes > 1) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal !== 0) {
      signals.push(signal);
      if (signal === "SIGTERM") setProcessIdentity(process.pid, "reused after TERM");
    }
    return true;
  });
  t.after(() => setProcessIdentity(process.pid, undefined));
  await stopGroup(process.pid, 0, expected);
  assert.deepEqual(signals, ["SIGTERM"], "reuse during the grace period must suppress SIGKILL");
  setProcessIdentity(process.pid, "");
  signals.length = 0;
  await stopGroup(process.pid, 0, expected);
  assert.deepEqual(signals, [], "a live pid with unreadable start identity is never signalled");
});

test("1b: amended checks run in a private checkout of the checked SHA and retain its submission binding", async (t) => {
  const checkedDirs = [];
  const f = await setup(t, {}, { sandbox: sandbox(async (req) => {
    checkedDirs.push(req.workdir);
    assert.equal(readFileSync(join(req.workdir, "src/a/a.txt"), "utf8"), "checked\n");
  }) });
  await f.r.tick();
  const h = f.driver.calls[0];
  await until(() => readFileSync(h.outputPath, "utf8").includes("init"));
  await submit(f.store, h, { content: "checked\n" });
  const rt = (await f.store.state()).tasks.a;
  write(h.cwd, "src/a/a.txt", "unchecked\n");
  await snapshotWip(h.cwd, "rt: wip snapshot", [{ paths: ["src/a/**"] }]);
  const { scrubbedJSON } = await import("../../dist/execution/blobs.js");
  const c = structuredClone((await f.store.state()).contract);
  c.version++;
  c.tasks[0].checks = ["pass"];
  const blob = await f.store.putBlob(scrubbedJSON(c), { redact: false });
  const patch_blob = await f.store.putBlob("{}");
  await emit(f.store, "contract.amended", { contract: c.id, version: c.version, patch_blob, blob, reason: "new acceptance check", affected_tasks: ["a"] });
  await f.driver.stop(h);
  await until(async () => { await f.r.tick(); return (await f.store.state()).tasks.a.state === "accepted"; });
  assert.ok(checkedDirs.some((dir) => dir.includes("/checks/")));
  const passed = (await eventsOf(f.store, "task.checks_passed")).at(-1);
  assert.equal(passed.payload.commit, rt.last_commit);
  assert.equal(passed.payload.submitted_seq, rt.submitted_seq);
  assert.equal(git(f.root, "show", integrationBranch(f.store.id) + ":src/a/a.txt"), "checked");
});
