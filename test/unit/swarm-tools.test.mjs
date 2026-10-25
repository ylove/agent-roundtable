import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRun, registerWorker, runner, task, contractFor } from "../fixtures/workers/run.mjs";

const { handleToolCall, toolsFor } = await import("../../dist/tools.js");
const { resetWorkerTools } = await import("../../dist/tools/worker.js");
const { spawnSpecs } = await import("../../dist/execution/swarms.js");
const { checkContract, consentHash, renderContractMarkdown } = await import("../../dist/execution/contract.js");
const { decideLeaseRequest, leaseDrafts, leasesFor, pathCovered } = await import("../../dist/execution/leases.js");
const { agentLeasesProjection } = await import("../../dist/workers/files.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { decidePreToolUse } = await import("../../dist/workers/hook.js");
const { taskWorktreePath } = await import("../../dist/execution/worktrees.js");
const { WORKER_DISALLOWED_TOOLS } = await import("../../dist/workers/claude-code.js");
const { WORKER_TOOL_NAMES } = await import("../../dist/tools/names.js");
const { remainingUsd } = await import("../../dist/execution/budget.js");

afterEach(resetWorkerTools);
const budget = { usd: 100, per_task_usd: 10, wall_clock_min: 60, max_parallel: 1, max_agents: 2, max_subtasks: 16, max_attempts: 3 };
const sub = (id = "x", extra = {}) => ({ id, title: `Build ${id}`, instructions: `Implement ${id}`, paths: [`src/a/${id}/**`], ...extra });
const append = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));
async function call(name, auth, args = {}) {
  const r = await handleToolCall(name, { ...auth, ...args }, "orchestrator");
  return { error: r.isError === true, body: JSON.parse(r.content[0].text.replace(/^Error: /, "")) };
}
async function setup(extra = {}) {
  const run = await makeRun({ contract: { tasks: [task("a", { checks: ["pass"] })], budget, ...extra } });
  const { token } = await registerWorker(run.store, "parent", "a");
  await ensureTaskWorktree(run.header, "a");
  await run.store.transact(({ state }) => ({ events: [leaseDrafts.granted(decideLeaseRequest(state, { agent: "parent", task: "a", paths: ["src/a/**"] }).grant, runner)] }));
  return { ...run, auth: { execution_id: run.store.id, agent_token: token } };
}

test("swarm contract fields validate, change consent and survive freeze and replay", async () => {
  const draft = contractFor("ctr-abc123-1", { status: "draft", tasks: [task("a")], budget, teams: [], authority: { lead: "builder", may: ["retry"], budget_extension_pct: 0 }, sandbox: { backend: "local", image: "node:22" } });
  const valid = checkContract(draft);
  assert.equal(valid.ok, true, valid.errors.join("\n"));
  assert.equal(valid.contract.budget.max_agents, 2);
  assert.equal(valid.contract.budget.max_subtasks, 16);
  assert.match(renderContractMarkdown(valid.contract), /max agents 2 · max subtasks 16/);
  for (const [field, values] of [["max_agents", [0, 33, 1.5, "2"]], ["max_subtasks", [0, 65, 1.5, "4"]]]) {
    for (const value of values) assert.equal(checkContract({ ...draft, budget: { ...budget, [field]: value } }).ok, false, `${field}: ${value}`);
  }
  const off = structuredClone(valid.contract);
  delete off.budget.max_agents;
  assert.notEqual(consentHash(off), consentHash(valid.contract));
  const run = await setup();
  const reopened = await openExecutionStore(run.store.id);
  assert.deepEqual((await reopened.state()).contract.budget, budget);
  for (const max_agents of [undefined, 1]) {
    const state = structuredClone(await run.store.state());
    state.contract.budget.max_agents = max_agents;
    assert.throws(() => spawnSpecs(state, "a", "parent", [sub()]), /not enabled/);
  }
});

test("spawn refuses depth, caps, budgets, paths, siblings, ids, dependencies and open children", async () => {
  const { store } = await setup();
  const base = await store.state();
  const check = (mutate, inputs, re) => {
    const s = structuredClone(base); mutate(s);
    assert.throws(() => spawnSpecs(s, "a", "parent", inputs), re);
  };
  check((s) => { s.tasks.a.spec.parent = "other"; }, [sub()], /depth/);
  check((s) => { s.contract.budget.max_subtasks = 1; }, [sub("x"), sub("y")], /max_subtasks/);
  check((s) => { s.budget.spent_usd = 95; }, [sub()], /execution budget/);
  check((s) => { s.budget.by_task.a = 10; }, [sub()], /no budget/);
  check(() => {}, [sub("x", { paths: ["src/else/**"] })], /outside the parent's leases/);
  const shared = structuredClone(base);
  Object.values(shared.leases)[0].mode = "shared";
  assert.equal(spawnSpecs(shared, "a", "parent", [sub()])[0].id, "a.x");
  check(() => {}, [sub("x"), sub("y", { paths: ["src/a/x/child/**"] })], /overlap/);
  check(() => {}, [sub("../escape")], /slug/);
  check(() => {}, [sub("a.b")], /slug/);
  check(() => {}, [sub("x"), sub("x")], /already exists/);
  check(() => {}, [sub("x", { depends_on: ["other"] })], /siblings/);
  check(() => {}, [sub("x", { depends_on: ["x"] })], /siblings/);
  check(() => {}, [sub("x", { depends_on: ["y"] }), sub("y", { depends_on: ["x"] })], /cycle/);
  check(() => {}, [sub("x", { instructions: "a".repeat(4001) })], /4000/);
  check(() => {}, [], /1–8/);
  check(() => {}, Array.from({ length: 9 }, (_, i) => sub(`s${i}`)), /1–8/);
  check(() => {}, [sub("x".repeat(64))], /slug/);
  check((s) => {
    for (let i = 0; i < 16; i++) s.tasks[`a.old${i}`] = { spec: { ...s.tasks.a.spec, id: `a.old${i}`, parent: "a" }, state: "failed", attempt: 1 };
  }, [sub()], /max_subtasks/);
  const into = spawnSpecs(base, "a", "parent", [sub()]);
  await append(store, "task.spawned", { task: "a", by: "parent", into });
  const spawnedState = await store.state();
  assert.throws(() => spawnSpecs(spawnedState, "a", "parent", [sub("y")]), /open subtasks/);
});

test("worker spawn hands off writes, blocks submit, respects authentication and replays", async () => {
  const { store, auth } = await setup();
  assert.equal((await call("spawn_subtasks", auth, { subtasks: [sub(), sub("y", { depends_on: ["x"] })] })).error, false);
  let s = await store.state();
  const spawned = (await store.events()).find((e) => e.type === "task.spawned");
  assert.equal(spawned.payload.by, "parent");
  assert.equal(s.tasks.a.state, "claimed");
  assert.equal(s.tasks["a.x"].state, "ready");
  assert.equal(s.tasks["a.y"].state, "pending");
  assert.deepEqual(s.tasks["a.x"].spec.checks, ["pass"]);
  assert.deepEqual(s.tasks["a.y"].spec.depends_on, ["a.x"]);
  assert.equal(pathCovered("src/a/x/index.ts", leasesFor(s, "a")), false);
  assert.equal(pathCovered("src/a/own.ts", leasesFor(s, "a")), true);
  const file = JSON.parse(readFileSync(join(store.dir, "agents/parent/leases.json"), "utf8"));
  assert.equal(pathCovered("src/a/x/index.ts", file.leases), false);
  assert.deepEqual(file, agentLeasesProjection(s, store.id, "parent"));
  const env = { ...process.env, ROUNDTABLE_EXECUTION_ID: store.id, ROUNDTABLE_AGENT_ID: "parent" };
  const edit = (path) => decidePreToolUse({ tool_name: "Write", tool_input: { file_path: join(taskWorktreePath(store.id, "a"), path) } }, env);
  assert.equal(edit("src/a/x/index.ts").allow, false);
  assert.equal(edit("src/a/own.ts").allow, true);
  assert.match((await call("submit_work", auth, { summary: "done", ready: true })).body.error, /open subtasks/);
  assert.match((await call("spawn_subtasks", auth, { subtasks: [sub("z")] })).body.error, /open subtasks/);
  assert.match((await call("lease", auth, { action: "request", paths: ["src/a/x/**"] })).body.error, /delegated/);
  assert.match((await call("lease", auth, { action: "release", paths: ["**"] })).body.error, /delegated/);
  const wait = await call("await_subtasks", auth, { timeout_s: 0 });
  assert.equal(wait.body.still_running, true);
  assert.equal(wait.body.ready, false);
  const token = await registerWorker(store, "child", "a.x");
  const childAuth = { execution_id: store.id, agent_token: token.token };
  const grant = decideLeaseRequest(await store.state(), { agent: "child", task: "a.x", paths: ["src/a/x/**"] });
  assert.ok(grant.grant, "parent reservation permits delegated child's lease");
  await store.transact(() => ({ events: [leaseDrafts.granted(grant.grant, runner)] }));
  assert.match((await call("spawn_subtasks", childAuth, { subtasks: [sub("z")] })).body.error, /depth/);
  assert.throws(() => decideLeaseRequest(s, { agent: "child", task: "a.x", paths: ["src/a/own.ts"] }), /delegated paths/);
  assert.equal(pathCovered("src/a/x/a.ts", leasesFor(await store.state(), "a.x")), true);
  const other = decideLeaseRequest(await store.state(), { agent: "other", task: "b", paths: ["src/a/y/**"] });
  assert.ok(other.queue, "pending children's paths stay reserved too");
  await append(store, "task.failed", { task: "a.x", why: "child broke" });
  await append(store, "task.cancelled", { task: "a.y", why: "dependency failed" });
  const failed = await call("await_subtasks", auth, { timeout_s: 0.01 });
  assert.equal(failed.body.still_running, false);
  assert.equal(failed.body.children[0].status, "failed");
  assert.equal(failed.body.children[0].summary, "child broke");
  assert.equal(pathCovered("src/a/x/a.ts", leasesFor(await store.state(), "a")), true);
  s = await store.state();
  assert.equal(remainingUsd(s, { task: "a", agent: "parent" }), 10);
  const replay = await openExecutionStore(store.id);
  assert.deepEqual(await replay.state(), s);
});

test("parent failure and cancellation cancel open children and restore projections", async () => {
  for (const type of ["task.cancelled", "task.failed"]) {
    const { store, auth } = await setup();
    await call("spawn_subtasks", auth, { subtasks: [sub(), sub("y")] });
    await append(store, type, { task: "a", why: "stop parent" });
    const s = await store.state();
    assert.equal(s.tasks["a.x"].state, "cancelled");
    assert.equal(s.tasks["a.y"].state, "cancelled");
    assert.equal(s.claims["a.x"], undefined);
    assert.deepEqual(await (await openExecutionStore(store.id)).state(), s);
  }
});

test("worker tools remain token-bound and Task/Agent remain disallowed", async () => {
  for (const name of ["spawn_subtasks", "await_subtasks"]) {
    assert.ok(WORKER_TOOL_NAMES.includes(name));
    const tool = toolsFor("worker").find((t) => t.name === name);
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.agent_token, undefined);
    const result = await handleToolCall(name, name === "spawn_subtasks" ? { subtasks: [sub()] } : {}, "worker");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no identity/);
  }
  assert.match(WORKER_DISALLOWED_TOOLS, /\bTask\b/);
  assert.match(WORKER_DISALLOWED_TOOLS, /\bAgent\b/);
});

test("freeze_contract retains consented swarm caps", async () => {
  const { fileURLToPath } = await import("node:url");
  const { proposeContract, freezeContract } = await import("../../dist/execution/contract-lifecycle.js");
  const { root } = await makeRun({ contract: { tasks: [task("a")] } });
  const persona = fileURLToPath(new URL("../fixtures/ultraplan/cfo.md", import.meta.url));
  const proposed = await proposeContract({
    goal: "Build with bounded swarms", orchestrator: "main", originalPrompt: "Use bounded swarms", repoDir: root, consent: false,
    contract: {
      tasks: [task("a", { persona })], scope: { paths: ["src/**"] }, budget,
      validation: { commands: [], final: [] }, sandbox: { backend: "local", image: "node:22" },
    },
  });
  const frozen = await freezeContract(proposed.contractId, { orchestrator: "main", excuse: [{ agent: persona, reason: "fixture consent" }] });
  assert.equal(frozen.contract.status, "frozen");
  assert.equal(frozen.contract.budget.max_agents, 2);
  assert.equal(frozen.contract.budget.max_subtasks, 16);
});

test("eight full instructions fit one spawn event and replay without reserving budget", async () => {
  const { store, auth } = await setup();
  const children = Array.from({ length: 8 }, (_, i) => sub(`s${i}`, { instructions: "x".repeat(4000) }));
  const before = await store.state();
  const spawned = await call("spawn_subtasks", auth, { subtasks: children });
  assert.equal(spawned.error, false, JSON.stringify(spawned.body));
  assert.equal(spawned.body.children.length, 8);
  const state = await store.state();
  assert.deepEqual(state.budget, before.budget);
  assert.deepEqual(state.agents, before.agents);
  assert.deepEqual(await (await openExecutionStore(store.id)).state(), state);
});
