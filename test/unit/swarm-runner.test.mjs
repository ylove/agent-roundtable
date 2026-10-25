import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeRun, registerWorker, task, runner } from "../fixtures/workers/run.mjs";
import { write, git } from "../fixtures/execution/git-fixture.mjs";
import { scriptedDriver, sandbox, resultLine, stream } from "../fixtures/runner/driver.mjs";

const { processStart } = await import("../../dist/execution/lock.js");
const { setOrchestratorDeps } = await import("../../dist/execution/orchestrator.js");
const { Runner } = await import("../../dist/execution/runner.js");
const { handleToolCall } = await import("../../dist/tools.js");
const { resetWorkerTools } = await import("../../dist/tools/worker.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { integrationBranch } = await import("../../dist/execution/git.js");
const { taskWorktreePath } = await import("../../dist/execution/worktrees.js");
const { renderDagSvg, layers } = await import("../../dist/dashboard/dag-svg.js");
const { renderTaskDetail, renderOverview } = await import("../../dist/dashboard/render.js");
const { executionStatusReport } = await import("../../dist/execution/status-report.js");
const { decideLeaseRequest, leaseDrafts, leasesFor, pathCovered } = await import("../../dist/execution/leases.js");

process.env.ROUNDTABLE_ALLOW_LOCAL_SANDBOX = "1";
afterEach(resetWorkerTools);
const budget = { usd: 100, per_task_usd: 10, wall_clock_min: 60, max_parallel: 1, max_agents: 2, max_subtasks: 16, max_attempts: 3 };
const sub = (id, extra = {}) => ({ id, title: `Build ${id}`, instructions: `Implement ${id}`, paths: [`src/a/${id}/**`], ...extra });
const append = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));
async function tool(store, agent, name, args = {}) {
  const token = readFileSync(join(store.dir, "agents", agent, "token"), "utf8").trim();
  const result = await handleToolCall(name, { execution_id: store.id, agent_token: token, ...args }, "orchestrator");
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
async function until(r, fn, message = "runner condition") {
  const deadline = Date.now() + 15000;
  do {
    await r.tick();
    if (await fn()) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}
async function setup(t, extra = {}) {
  const run = await makeRun({ contract: { tasks: [task("a"), task("b")], budget, ...extra } });
  const driver = scriptedDriver(t);
  const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 10, tickMs: 10, mergeGraceMs: 0 });
  await r.start();
  t.after(async () => { r.stop("test cleanup"); await r.run(); });
  await r.tick();
  return { ...run, r, driver };
}
async function spawn(store, ids) {
  return tool(store, "w-a", "spawn_subtasks", { subtasks: ids.map((id) => sub(id)) });
}
async function complete(store, driver, taskId) {
  const h = driver.calls.find((c) => c.task === taskId);
  const name = taskId.split(".").at(-1);
  const path = taskId.includes(".") ? `src/a/${name}/done.txt` : `src/${name}/done.txt`;
  write(h.cwd, path, `${name} done\n`);
  await tool(store, h.agent, "submit_work", { summary: `${name} implemented`, ready: true });
  stream(h, [resultLine(0.25)]);
  await driver.stop(h);
}

test("children use max_agents independently of max_parallel, merge and fan in through host git", { skip: processStart(process.pid) ? false : "sandbox blocks ps process identities" }, async (t) => {
  const { store, r, driver } = await setup(t);
  assert.deepEqual(driver.calls.map((c) => c.task), ["a"]);
  assert.deepEqual((await spawn(store, ["x", "y"])).children, ["a.x", "a.y"]);
  const waiting = await tool(store, "w-a", "await_subtasks", { timeout_s: 0 });
  assert.equal(waiting.still_running, true);
  const before = Date.now();
  const timed = await tool(store, "w-a", "await_subtasks", { timeout_s: 0.02 });
  assert.equal(timed.still_running, true);
  assert.ok(Date.now() - before < 500);
  await r.tick();
  assert.deepEqual(driver.calls.map((c) => c.task), ["a", "a.x"]);
  assert.equal(await r.startWorker("a.y", { claim: true }), false);
  assert.equal(await r.startWorker("b", { claim: true }), false);
  assert.match(driver.calls[1].prompt, /Implement x/);
  const state = await store.state();
  assert.equal(pathCovered("src/a/x/done.txt", leasesFor(state, "a")), false);
  assert.equal(pathCovered("src/a/x/done.txt", leasesFor(state, "a.x")), true);
  write(driver.calls[0].cwd, "src/a/own.txt", "parent WIP\n");
  await complete(store, driver, "a.x");
  await until(r, () => driver.calls.some((c) => c.task === "a.y"));
  await until(r, async () => (await store.state()).tasks["a.x"].state === "accepted", "a.x merged");
  await complete(store, driver, "a.y");
  await until(r, async () => !!(await store.state()).tasks.a.subtasks_joined, "children joined into parent");
  const joined = await tool(store, "w-a", "await_subtasks", { timeout_s: 0 });
  assert.equal(joined.ready, true);
  assert.equal(joined.still_running, false);
  assert.deepEqual(joined.children.map((c) => [c.status, c.merged, c.summary]), [["accepted", true, "x implemented"], ["accepted", true, "y implemented"]]);
  assert.deepEqual(joined.children[0].files, ["src/a/x/done.txt"]);
  const wt = taskWorktreePath(store.id, "a");
  assert.equal(readFileSync(join(wt, "src/a/x/done.txt"), "utf8"), "x done\n");
  assert.equal(readFileSync(join(wt, "src/a/y/done.txt"), "utf8"), "y done\n");
  assert.equal(readFileSync(join(wt, "src/a/own.txt"), "utf8"), "parent WIP\n");
  assert.match(git(wt, "log", "-1", "--format=%s"), /rt: sync .* into a/);
  assert.equal(git(wt, "merge-base", "--is-ancestor", integrationBranch(store.id), "HEAD"), "");
  const after = await store.state();
  assert.equal(after.budget.by_task.a ?? 0, 0, "children do not charge parent");
  assert.equal(after.budget.by_task["a.x"], 0.25);
  assert.equal(after.budget.by_task["a.y"], 0.25);
  assert.equal(after.budget.spent_usd, 0.5);
  assert.equal(pathCovered("src/a/x/done.txt", leasesFor(after, "a")), true);
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), after);
  await complete(store, driver, "a");
  await until(r, () => driver.calls.some((c) => c.task === "b"));
});

test("runner restart retains batch and pending fan-in, and cancellation reaps children", { skip: processStart(process.pid) ? false : "sandbox blocks ps process identities" }, async (t) => {
  const { store, r, driver } = await setup(t, { tasks: [task("a")] });
  await spawn(store, ["x"]);
  await tool(store, "w-a", "await_subtasks", { timeout_s: 0 });
  await r.tick();
  const before = await store.state();
  r.stop("restart"); await r.run();
  const adopted = new Runner(store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 10, mergeGraceMs: 0 });
  await adopted.start();
  t.after(async () => { adopted.stop("cleanup"); await adopted.run(); });
  assert.deepEqual((await store.state()).tasks, before.tasks);
  assert.equal(driver.calls.length, 2);
  await append(store, "task.cancelled", { task: "a", why: "cancel swarm" });
  await until(adopted, async () => (await store.events()).some((e) => e.type === "agent.exited" && e.payload.task === "a.x"));
  assert.equal((await store.state()).tasks["a.x"].state, "cancelled");
  assert.ok((await store.events()).some((e) => e.type === "task.cancelled" && e.payload.task === "a.x"));
});

test("DAG, task page, dashboard budget and execution_status show the swarm tree", async (t) => {
  const { store, header } = await makeRun({ contract: { tasks: [task("a")], budget } });
  const { token } = await registerWorker(store, "w-a", "a");
  const { writeFileAtomic } = await import("../../dist/security/fs-safe.js");
  const { ensureAgentDir } = await import("../../dist/workers/files.js");
  writeFileAtomic(join(ensureAgentDir(store.id, "w-a"), "token"), token);
  await store.transact(({ state }) => ({ events: [leaseDrafts.granted(decideLeaseRequest(state, { task: "a", agent: "w-a", paths: ["src/a/**"] }).grant, runner)] }));
  t.after(setOrchestratorDeps({ ensureRunner: async () => ({ status: "already_running" }) }));
  await spawn(store, ["x", "y"]);
  const state = await store.state();
  const svg = renderDagSvg(state);
  assert.equal((svg.match(/class="edge parent-edge"/g) ?? []).length, 2);
  assert.match(svg, /stroke-dasharray="5 4"/);
  assert.ok(layers(state.tasks).get("a.x") > layers(state.tasks).get("a"));
  const ctx = { state, header, base: "/test/", runner: { status: "unknown", detail: "" } };
  assert.match(renderTaskDetail(ctx, "a", { outputs: {}, events: [] }), /Children.*a.x.*a.y/);
  assert.match(renderOverview(ctx), /max agents 2 · max subtasks 16/);
  const report = await executionStatusReport({ execution_id: store.id, view: "tasks" });
  const parent = report.tasks.find((task) => task.id === "a");
  assert.deepEqual(parent.children.map((task) => [task.id, task.parent]), [["a.x", "a"], ["a.y", "a"]]);
});

test("scheduler admission and real git fan-in run without worker processes and survive restart", async (t) => {
  const { store } = await makeRun({ contract: { tasks: [task("a"), task("b")], budget } });
  const { ensureAgentDir } = await import("../../dist/workers/files.js");
  const { writeFileAtomic } = await import("../../dist/security/fs-safe.js");
  const auth = {};
  async function joinAgent(agent, taskId) {
    const result = await handleToolCall("join_execution", { execution_id: store.id, agent, task_id: taskId });
    assert.equal(result.isError, undefined, result.content[0].text);
    auth[agent] = JSON.parse(result.content[0].text).agent_token;
    writeFileAtomic(join(ensureAgentDir(store.id, agent), "token"), auth[agent]);
    await tool(store, agent, "claim_task", { task_id: taskId });
  }
  let r = new Runner(store.id, { sandbox: sandbox(), lockTimeoutMs: 10 });
  await r.start();
  t.after(async () => { r.stop("cleanup"); await r.run(); });
  await joinAgent("parent", "a");
  await tool(store, "parent", "lease", { action: "request", paths: ["src/a/**"] });
  await tool(store, "parent", "spawn_subtasks", { subtasks: [sub("bad")] });
  await append(store, "task.failed", { task: "a.bad", why: "try another approach" });
  const failed = await tool(store, "parent", "await_subtasks", { timeout_s: 0 });
  assert.equal(failed.children[0].status, "failed");
  await tool(store, "parent", "spawn_subtasks", { subtasks: [sub("x"), sub("y")] });
  let s = await store.state();
  assert.equal(r.startProblem(s, "a.x", "w-a.x", true), null, "child fits beside one parent when max_parallel is 1");
  assert.match(r.startProblem(s, "b", "w-b", true), /max_parallel/);
  await joinAgent("child-x", "a.x");
  s = await store.state();
  assert.match(r.startProblem(s, "a.y", "w-a.y", true), /max_agents/);
  await tool(store, "child-x", "lease", { action: "request", paths: ["src/a/x/**"] });
  const wt = taskWorktreePath(store.id, "a");
  write(wt, "src/a/own.txt", "parent WIP\n");
  await tool(store, "parent", "await_subtasks", { timeout_s: 0 });
  for (const name of ["x", "y"]) {
    if (name === "y") await joinAgent("child-y", "a.y");
    const child = `child-${name}`;
    await tool(store, child, "lease", { action: "request", paths: [`src/a/${name}/**`] });
    write(taskWorktreePath(store.id, `a.${name}`), `src/a/${name}/done.txt`, `${name} done\n`);
    await tool(store, child, "post_update", { kind: "usage", usd: 0.25, model: "test" });
    await tool(store, child, "submit_work", { summary: `${name} implemented`, ready: true });
    const deadline = Date.now() + 10000;
    do {
      r.merge.feed(await store.state());
      await delay(20);
    } while (((await store.state()).tasks[`a.${name}`].state !== "accepted" || r.merge.busy()) && Date.now() < deadline);
    assert.equal((await store.state()).tasks[`a.${name}`].state, "accepted");
  }
  const pending = await store.state();
  assert.equal(pending.tasks.a.subtasks_waiting, true);
  assert.equal(pending.budget.by_task.a ?? 0, 0);
  assert.equal(pending.budget.by_task["a.x"], 0.25);
  assert.equal(pending.budget.spent_usd, 0.5);
  r.stop("restart before fan-in"); await r.run();
  rmSync(join(store.dir, "snapshot.json"), { force: true });
  r = new Runner(store.id, { sandbox: sandbox(), lockTimeoutMs: 10 });
  await r.start();
  r.joinSubtasks(await store.state());
  const deadline = Date.now() + 10000;
  while (!(await store.state()).tasks.a.subtasks_joined && Date.now() < deadline) await delay(20);
  const ready = await tool(store, "parent", "await_subtasks", { timeout_s: 0 });
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert.deepEqual(ready.children.map((c) => [c.status, c.merged, c.summary]), [["accepted", true, "x implemented"], ["accepted", true, "y implemented"]]);
  assert.deepEqual(ready.children[0].files, ["src/a/x/done.txt"]);
  for (const name of ["x", "y"]) assert.equal(readFileSync(join(wt, `src/a/${name}/done.txt`), "utf8"), `${name} done\n`);
  assert.equal(readFileSync(join(wt, "src/a/own.txt"), "utf8"), "parent WIP\n");
  assert.match(git(wt, "log", "-1", "--format=%s"), /rt: sync .* into a/);
  assert.equal(git(wt, "merge-base", "--is-ancestor", integrationBranch(store.id), "HEAD"), "");
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), await store.state());
  await tool(store, "parent", "submit_work", { summary: "parent done", ready: true });
  assert.equal((await store.state()).tasks.a.state, "merging");
});

test("waiting parents reserve the last agent slot so their children can start and finish", async () => {
  const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
  for (const max_agents of [2, 3]) {
    const ids = ["a", "b", "c"].slice(0, max_agents);
    const { store, header } = await makeRun({ contract: { tasks: ids.map((id) => task(id)), budget: { ...budget, max_parallel: max_agents, max_agents } } });
    const r = new Runner(store.id);
    r.store = store;
    const auth = {};
    async function call(id, name, args = {}) {
      const result = await handleToolCall(name, { execution_id: store.id, agent_token: auth[id], ...args }, "orchestrator");
      return { error: result.isError === true, body: JSON.parse(result.content[0].text.replace(/^Error: /, "")) };
    }
    for (const id of ids) {
      auth[id] = (await registerWorker(store, `parent-${id}`, id)).token;
      await ensureTaskWorktree(header, id);
      await store.transact(({ state }) => ({ events: [leaseDrafts.granted(decideLeaseRequest(state, { agent: `parent-${id}`, task: id, paths: [`src/${id}/**`] }).grant, runner)] }));
      const spawned = await call(id, "spawn_subtasks", { subtasks: [sub("x", { paths: [`src/${id}/x/**`] })] });
      if (id === ids.at(-1)) {
        assert.equal(spawned.error, true);
        assert.match(spawned.body.error, /max_agents.*free worker slot/);
      } else {
        assert.equal(spawned.error, false, JSON.stringify(spawned.body));
        assert.equal((await call(id, "await_subtasks", { timeout_s: 0 })).body.still_running, true);
      }
    }
    const extra = ids.at(-1);
    await append(store, "task.released", { task: extra, agent: `parent-${extra}` });
    assert.match(r.startProblem(await store.state(), extra, `w-${extra}`, true), /reserves.*unstarted subtasks/);
    assert.equal(await r.startWorker(extra, { claim: true }), false);
    for (const id of ids.slice(0, -1)) {
      const child = `${id}.x`;
      assert.equal(r.startProblem(await store.state(), child, `w-${child}`, true), null);
      await registerWorker(store, `w-${child}`, child);
      assert.equal((await store.state()).tasks[child].state, "claimed");
      assert.equal(await r.startWorker(extra, { claim: true }), false);
      await append(store, "task.accepted", { task: child });
      assert.equal((await store.state()).tasks[child].state, "accepted");
    }
    assert.equal(r.startProblem(await store.state(), extra, `w-${extra}`, true), null);
    assert.deepEqual(await (await openExecutionStore(store.id)).state(), await store.state());
  }
});
