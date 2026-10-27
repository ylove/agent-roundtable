import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRun, nodeCommand, registerWorker, runner, task } from "../fixtures/workers/run.mjs";
import { git, write } from "../fixtures/execution/git-fixture.mjs";
import { waitFor } from "../fixtures/runner/harness.mjs";
import { goodInit, resultLine, sandbox, scriptedDriver, stream, submit } from "../fixtures/runner/driver.mjs";

const { Runner, readRunFile } = await import("../../dist/execution/runner.js");
const { integrationBranch, taskBranch } = await import("../../dist/execution/git.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { leaseDrafts, decideLeaseRequest } = await import("../../dist/execution/leases.js");
const { scrubbedJSON } = await import("../../dist/execution/blobs.js");
const { verifyRun } = await import("../../dist/execution/run-admin.js");

const append = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));
const eventsOf = async (store, type) => (await store.events()).filter((e) => e.type === type);
const oneTask = { tasks: [task("a")] };

async function setup(t, contract = oneTask, behavior, opts = {}) {
  const run = await makeRun({ contract });
  const driver = scriptedDriver(t, behavior);
  const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 10, tickMs: 10, ...opts });
  await r.start();
  t.after(async () => { r.stop("test cleanup"); await r.run(); });
  return { ...run, r, driver };
}

async function tickUntil(r, predicate) {
  await waitFor(async () => { await r.tick(); return predicate(); }, 10000, "runner condition");
}

test("scheduler preclaims/registers in one transaction, respects dependencies, merges and completes with usage", async (t) => {
  const checks = [];
  const { store, root, sha, r, driver } = await setup(t, {
    tasks: [task("a"), task("b", { depends_on: ["a"] })],
    validation: { commands: [nodeCommand("final", "process.exit(0)")], final: ["final"] },
  }, undefined, { sandbox: sandbox(async (req) => {
    checks.push(req.workdir);
    // A post-merge check holds the accepted task's lease, even if the watchdog ticks meanwhile.
    await r.tick();
    const state = await store.state();
    if (checks.length <= 2) assert.ok(Object.values(state.leases).some((l) => state.tasks[l.task].state === "accepted"));
  }) });
  await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal(driver.calls[0].task, "a");
  for (const id of ["a", "b"]) {
    const h = driver.calls.at(-1);
    await waitFor(() => existsSync(h.outputPath) && readFileSync(h.outputPath, "utf8").includes("init"));
    await submit(store, h);
    stream(h, [resultLine()]);
    await driver.stop(h);
    await tickUntil(r, async () => (await store.state()).tasks[id].state === "accepted");
    if (id === "a") await tickUntil(r, () => driver.calls.length === 2);
  }
  await tickUntil(r, async () => (await store.state()).status === "completed");
  const events = await store.events();
  const accepted = events.filter((e) => e.type === "task.accepted");
  assert.deepEqual(accepted.map((e) => e.payload.task), ["a", "b"]);
  assert.ok(accepted[0].seq < events.find((e) => e.type === "task.claimed" && e.payload.task === "b").seq);
  for (const claim of events.filter((e) => e.type === "task.claimed")) {
    const reg = events.find((e) => e.seq === claim.seq - 1);
    assert.equal(reg.type, "agent.registered");
    assert.equal(reg.batch.n, claim.batch.n);
    assert.equal(claim.payload.ttl_s, 0);
  }
  assert.equal(driver.calls.length, 2);
  assert.equal(git(root, "show", `${integrationBranch(store.id)}:src/a/a.txt`), "a");
  assert.equal(git(root, "show", `${integrationBranch(store.id)}:src/b/b.txt`), "b");
  assert.equal(git(root, "rev-parse", "main"), sha);
  assert.ok(checks.length >= 3, "checks after both merges and at completion");
  assert.equal((await store.state()).budget.spent_usd, 0.1);
  assert.equal((await verifyRun(store.id)).ok, true);
});

test("parallel scheduling, paused tasks, duplicate process ops and in-flight spawns", async (t) => {
  const { store, r, driver } = await setup(t, { tasks: [task("a"), task("b"), task("c")] });
  await append(store, "execution.paused", { scope: ["c"], reason: "hold" });
  await Promise.all([r.startWorker("a", { claim: true }), r.startWorker("a", { claim: true })]);
  assert.equal(driver.calls.length, 1);
  const op = { type: "spawn_retry", task: "b", attempt: 1, rule: "worker_dead", key: "test:b", target: "b" };
  await r.applyProcessOps([op, op]);
  await r.tick();
  assert.deepEqual(driver.calls.map((h) => h.task), ["a", "b"]);
  await append(store, "execution.paused", { scope: "all", reason: "hold" });
  assert.equal(await r.startWorker("c", { claim: true }), false);
});

test("max_parallel applies to retry process ops and hooks as well as scheduling", async (t) => {
  const { r, driver } = await setup(t, { tasks: [task("a"), task("b")], budget: { usd: 50, per_task_usd: 10, max_parallel: 1, max_attempts: 3, wall_clock_min: 60 } });
  await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal(await r.startWorker("b", { claim: true }), false);
});

test("dying worker is retried once with a fresh token and the same session", async (t) => {
  const { r, store, driver } = await setup(t, oneTask, (_l, n) => ({ exit: n === 0 }));
  await r.tick();
  await tickUntil(r, () => driver.calls.length === 2);
  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(driver.calls.length, 2);
  assert.equal(driver.calls[1].resume, true);
  assert.equal(driver.calls[1].sessionId, driver.calls[0].sessionId);
  assert.equal(driver.calls[1].attempt, 2);
  const regs = await eventsOf(store, "agent.registered");
  assert.notEqual(regs[0].payload.token_sha256, regs[1].payload.token_sha256);
});

test("same check failure three times raises one escalation with a diagnostics blob", async (t) => {
  const { r, store, driver } = await setup(t);
  await r.tick();
  const blob = await store.putBlob("same failing command");
  for (let n = 0; n < 3; n++) await append(store, "check.failed", { command_id: "unit", scope: "task", task: "a", exit: 1, signature: "a".repeat(64), output_blob: blob });
  await r.tick();
  const [esc] = await eventsOf(store, "escalation.raised");
  assert.ok(esc.payload.escalation.diagnostics_blob);
  assert.ok((await store.getBlob(esc.payload.escalation.diagnostics_blob)).length);
  await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal((await eventsOf(store, "escalation.raised")).length, 1);
});

test("100% budget stops new tasks, keeps the stop standing and re-arms after extension", async (t) => {
  const budget = { usd: 1, per_task_usd: 10, max_parallel: 1, max_attempts: 3, wall_clock_min: 60 };
  const { r, store, driver } = await setup(t, { tasks: [task("a"), task("b")], budget });
  await r.tick();
  const h = driver.calls[0];
  await waitFor(() => readFileSync(h.outputPath, "utf8").includes("init"));
  stream(h, [resultLine(1)]);
  await driver.stop(h);
  for (let n = 0; n < 3; n++) await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal((await store.state()).budget.spent_usd, 1);
  assert.ok((await eventsOf(store, "budget.threshold_crossed")).some((e) => e.payload.pct === 100));
  assert.equal((await eventsOf(store, "escalation.awaiting_human")).length, 1);
  await append(store, "budget.extended", { by: "main", usd: 10 });
  await tickUntil(r, () => driver.calls.length === 2);
});

test("half-open driver admits one trial across sequential and concurrent spawns", async (t) => {
  const { r, store, driver } = await setup(t, { tasks: [task("a"), task("b"), task("c")] });
  await append(store, "watchdog.circuit_opened", { driver: "claude-code", reason: "test", until: new Date(Date.now() - 1000).toISOString(), opens: 1 });
  await Promise.all([r.startWorker("a", { claim: true }), r.startWorker("b", { claim: true })]);
  await r.tick();
  assert.equal(driver.calls.length, 1);
});

test("failed attestation escalates even when the worker already exited", async (t) => {
  const { r, store, driver } = await setup(t, oneTask, () => ({ exit: true, init: { ...goodInit, tools: ["Bash"] } }));
  await r.tick();
  await tickUntil(r, async () => (await eventsOf(store, "escalation.raised")).length > 0);
  const [attested] = await eventsOf(store, "agent.attested");
  assert.equal(attested.payload.ok, false);
  assert.equal((await store.state()).tasks.a.state, "blocked");
  assert.equal(driver.calls.length, 1);
});

test("adoption restores init, result and per-message usage at the saved offset without a second spawn", async (t) => {
  const { r, store, driver } = await setup(t);
  await r.tick();
  const h = driver.calls[0];
  await waitFor(() => readFileSync(h.outputPath, "utf8").includes("init"));
  stream(h, [resultLine(0.25)]);
  await r.tick();
  await submit(store, h);
  const persisted = readRunFile(store.id, "w-a");
  assert.equal(persisted.monitor.acc.done, true);
  assert.equal(persisted.attested, true);
  r.stop("restart");
  await r.run();
  const adopted = new Runner(store.id, { drivers: { "claude-code": driver }, sandbox: sandbox() });
  await adopted.start();
  t.after(async () => { adopted.stop("test cleanup"); await adopted.run(); });
  assert.equal(driver.calls.length, 1);
  await driver.stop(h);
  await tickUntil(adopted, async () => (await eventsOf(store, "agent.exited")).length > 0);
  assert.equal((await eventsOf(store, "agent.exited"))[0].payload.reason, "completed");
  assert.equal((await eventsOf(store, "budget.usage_recorded")).length, 1);
  assert.equal((await eventsOf(store, "agent.attested")).length, 1);
  assert.equal(driver.calls.length, 1);
});

test("startup reconciles a registered claim with no pid, resumes after pause instead of leaving it stuck", async (t) => {
  const run = await makeRun({ contract: oneTask });
  await registerWorker(run.store, "w-a", "a");
  await append(run.store, "execution.paused", { scope: "all", reason: "paused before launch" });
  const driver = scriptedDriver(t);
  const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox() });
  await r.start();
  t.after(async () => { r.stop("test cleanup"); await r.run(); });
  assert.equal(driver.calls.length, 0);
  assert.equal((await run.store.state()).agents["w-a"].status, "exited");
  await append(run.store, "execution.resumed", { scope: "all", reason: "go" });
  await tickUntil(r, () => driver.calls.length === 1);
});

test("lost worker WIP is committed under its leases and loss/registration share a transaction", async (t) => {
  const { r, store, root, driver } = await setup(t);
  await r.tick();
  const h = driver.calls[0];
  write(h.cwd, "src/a/draft.txt", "half done\n");
  await driver.stop(h);
  r.stop("restart");
  await r.run();
  const resumed = new Runner(store.id, { drivers: { "claude-code": driver }, sandbox: sandbox() });
  await resumed.start();
  t.after(async () => { resumed.stop("test cleanup"); await resumed.run(); });
  assert.equal(driver.calls.length, 2);
  assert.equal(driver.calls[1].resume, true);
  assert.match(driver.calls[1].prompt, /You were interrupted/);
  assert.match(driver.calls[1].prompt, /rt: wip snapshot/);
  const events = await store.events();
  const lost = events.find((e) => e.type === "agent.exited" && e.payload.reason === "lost");
  const reg = events.find((e) => e.seq === lost.seq + 1);
  assert.equal(reg.type, "agent.registered");
  assert.equal(reg.batch.n, lost.batch.n);
  assert.equal(git(root, "show", `${taskBranch(store.id, "a")}:src/a/draft.txt`), "half done");
});

test("amended checks of accepted tasks run again and failures prevent completion", async (t) => {
  let fail = false;
  const { r, store, driver } = await setup(t, oneTask, undefined, { sandbox: sandbox(async () => { if (fail) throw new Error("amended acceptance failed"); }), hooks: { goalReview: async () => ({ verdict: "INCOMPLETE" }) } });
  await r.tick();
  const h = driver.calls[0];
  await submit(store, h);
  stream(h, [resultLine()]);
  await driver.stop(h);
  await tickUntil(r, async () => (await store.state()).tasks.a.state === "accepted");
  await tickUntil(r, () => !r.hasAnyLiveWorker());
  const state = await store.state();
  const amended = structuredClone(state.contract);
  amended.version++;
  amended.tasks[0].checks = ["extra"];
  amended.validation.commands.push(nodeCommand("extra", "process.exit(0)"));
  const blob = await store.putBlob(scrubbedJSON(amended), { redact: false });
  const patch = await store.putBlob("{}");
  fail = true;
  r.hooks.goalReview = async () => ({ verdict: "COMPLETE" });
  await append(store, "contract.amended", { contract: amended.id, version: amended.version, patch_blob: patch, reason: "new acceptance check", affected_tasks: ["a"], blob });
  await tickUntil(r, async () => (await eventsOf(store, "escalation.raised")).some((e) => /amended checks/.test(e.payload.escalation.summary)));
  assert.equal((await store.state()).status, "running");
});

test("runner emits failure once a failed task's escalation is closed", async (t) => {
  const { r, store } = await setup(t);
  await append(store, "task.failed", { task: "a", why: "watchdog exhausted attempts" });
  await r.tick();
  assert.equal((await store.state()).status, "failed");
});

test("external tool heartbeats renew claims and snapshots run on the event and time thresholds", async (t) => {
  const { r, store } = await setup(t);
  const { ensureAgentDir } = await import("../../dist/workers/files.js");
  const { writeFileSync } = await import("node:fs");
  await append(store, "agent.registered", { agent: "external", persona: "builder", driver: "external", external: true, token_sha256: "a".repeat(64) });
  await append(store, "task.claimed", { task: "a", agent: "external", attempt: 1, ttl_s: 900 });
  const heartbeat = join(ensureAgentDir(store.id, "external"), "heartbeat");
  writeFileSync(heartbeat, "alive");
  const obs = r.observations(await store.state());
  assert.ok(Date.now() - obs.claims.a.renewedAt < 1000);
  await store.transact(() => ({ events: Array.from({ length: 501 }, (_, n) => ({ type: "note.posted", source: runner, payload: { topic: "test", text: `note ${n}`, refs: [] } })) }));
  await r.tick();
  assert.ok(JSON.parse(readFileSync(join(store.dir, "snapshot.json"), "utf8")).seq >= 500);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60001 });
  await append(store, "note.posted", { topic: "test", text: "one more", refs: [] });
  await r.tick();
  assert.equal(JSON.parse(readFileSync(join(store.dir, "snapshot.json"), "utf8")).seq, (await store.state()).seq);
});

test("idle exit measures from execution.paused, and new process ops are held during shutdown", async (t) => {
  const { r, store, driver } = await setup(t, oneTask, undefined, { idleExitMs: 0 });
  await append(store, "execution.paused", { scope: "all", reason: "idle" });
  await r.tick();
  assert.equal(r.isStopping(), true);
  await append(store, "execution.resumed", { scope: "all", reason: "resume elsewhere" });
  assert.equal(await r.startWorker("a", { claim: true }), false);
  assert.equal(driver.calls.length, 0);
});

test("driver API failures survive replay as transient circuit failures", async (t) => {
  const error = { ...resultLine(), is_error: true, subtype: "error_during_execution", result: "API Error: 429 rate_limit_error" };
  const { r, store, driver } = await setup(t, oneTask, () => ({ exit: true, result: error }));
  await r.tick();
  await tickUntil(r, async () => (await store.state()).watchdog.circuits["claude-code"]?.open);
  assert.equal(driver.calls.length, 1);
  const [exit] = await eventsOf(store, "agent.exited");
  assert.match(exit.payload.result_subtype, /rate_limit_error/);
  assert.equal(r.observations(await store.state()).infraDeaths.a.count, 1);
});

test("a failed spawn-event append preserves the live process and repairs its event without launching twice", async (t) => {
  const { r, store, driver } = await setup(t);
  const transact = r.store.transact.bind(r.store);
  let fail = true;
  r.store.transact = (fn) => transact(async (ctx) => {
    const out = await fn(ctx);
    if (fail && out.events.some((e) => e.type === "agent.spawned")) { fail = false; throw new Error("injected append failure"); }
    return out;
  });
  await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal((await store.state()).agents["w-a"].status, "registered");
  await r.tick();
  assert.equal(driver.calls.length, 1);
  assert.equal((await store.state()).agents["w-a"].status, "running");
  assert.equal((await eventsOf(store, "agent.spawned")).length, 1);
  assert.equal((await eventsOf(store, "agent.exited")).length, 0);
});

test("inside merge conflicts keep leases and resume the worker with a conflict-resolution card", async (t) => {
  const { r, store, root, driver } = await setup(t);
  const { integrationWorktreePath } = await import("../../dist/execution/worktrees.js");
  await r.tick();
  const first = driver.calls[0];
  await submit(store, first);
  const integration = integrationWorktreePath(store.id);
  write(integration, "src/a/a.txt", "independent integration change\n");
  git(integration, "add", "src/a/a.txt");
  git(integration, "commit", "-q", "-m", "integration change");
  await tickUntil(r, () => driver.calls.length === 2);
  const resumed = driver.calls[1];
  assert.equal(resumed.resume, true);
  assert.match(resumed.prompt, /Resolve the merge conflicts/);
  assert.match(resumed.prompt, /src\/a\/a.txt/);
  assert.ok(Object.values((await store.state()).leases).some((l) => l.task === "a"));
  assert.match(readFileSync(join(resumed.cwd, "src/a/a.txt"), "utf8"), /<<<<<<</);
  await submit(store, resumed, { content: "resolved\n" });
  stream(resumed, [resultLine()]);
  await driver.stop(resumed);
  await tickUntil(r, async () => (await store.state()).tasks.a.state === "accepted");
  assert.equal(git(root, "show", `${integrationBranch(store.id)}:src/a/a.txt`), "resolved");
  const events = await store.events();
  const lost = events.find((e) => e.type === "agent.exited" && e.payload.agent === "w-a");
  assert.equal(events.find((e) => e.seq === lost.seq + 1).type, "task.rejected");
  assert.equal(events.find((e) => e.seq === lost.seq + 2).type, "agent.registered");
});

test("a vanished resume session starts fresh and retains the WIP diff in its card", async (t) => {
  const { r, store, driver } = await setup(t, oneTask, (_l, n) => ({ sessionGone: n === 1 }));
  await r.tick();
  const first = driver.calls[0];
  write(first.cwd, "src/a/draft.txt", "saved work\n");
  await driver.stop(first);
  r.stop("restart");
  await r.run();
  const next = new Runner(store.id, { drivers: { "claude-code": driver }, sandbox: sandbox() });
  await next.start();
  t.after(async () => { next.stop("test cleanup"); await next.run(); });
  await tickUntil(next, () => driver.calls.length === 3);
  assert.equal(driver.calls[1].resume, true);
  assert.equal(driver.calls[2].resume, false);
  assert.notEqual(driver.calls[2].sessionId, first.sessionId);
  assert.match(driver.calls[2].prompt, /session could not be resumed/);
  assert.match(driver.calls[2].prompt, /1 file changed/);
  assert.equal(readFileSync(join(driver.calls[2].cwd, "src/a/draft.txt"), "utf8"), "saved work\n");
});

test("a run that ends stops its previews (bounded, best effort); a run that is only stopped does not", async (t) => {
  const stopped = [];
  const { store, r, driver } = await setup(t, oneTask, undefined, { stopPreviews: async (exe) => { stopped.push(exe); throw new Error("docker is gone"); } });
  await r.tick();
  const h = driver.calls.at(-1);
  await waitFor(() => existsSync(h.outputPath) && readFileSync(h.outputPath, "utf8").includes("init"));
  await submit(store, h);
  stream(h, [resultLine()]);
  await driver.stop(h);
  await tickUntil(r, async () => (await store.state()).status === "completed");
  r.stop("finished");
  await r.run();
  assert.deepEqual(stopped, [store.id], "stopped once, for this run; a failing stop never fails the run");
  assert.equal((await store.state()).status, "completed");
});

test("a runner stopped before the run ends leaves its previews alone", async (t) => {
  const stopped = [];
  const { store, r } = await setup(t, oneTask, undefined, { stopPreviews: async (exe) => { stopped.push(exe); } });
  r.stop("operator stop");
  await r.run();
  assert.notEqual((await store.state()).status, "completed");
  assert.deepEqual(stopped, []);
});
