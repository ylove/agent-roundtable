import { installProcessIdentity } from "../fixtures/execution/process-identity.mjs";
installProcessIdentity();
// WS11: execute (preflight, start, idempotence), control_execution and resolve_escalation through
// the tool layer, against temp repositories and execution stores. The runner, the sandbox probe, the
// worker CLI detection, gh and process groups are replaced through setOrchestratorDeps.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepo } from "../fixtures/execution/git-fixture.mjs";
import { contractFor, runner, task } from "../fixtures/workers/run.mjs";
import { json, stubFetch } from "./helpers.mjs";

const { processStart } = await import("../../dist/execution/lock.js");
const { handleToolCall } = await import("../../dist/tools.js");
const { setOrchestratorDeps, parseVisibility, contractBudgetSet } = await import("../../dist/execution/orchestrator.js");
const { takeHandoffs, acknowledgeHandoff, handoffDir } = await import("../../dist/execution/handoff.js");
const { createExecutionStore } = await import("../../dist/execution/store.js");
const { scrubbedJSON } = await import("../../dist/execution/blobs.js");
const { SandboxUnavailableError } = await import("../../dist/sandbox/index.js");
const { AUDIT_DIR } = await import("../../dist/config.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let calls;
let restore;
beforeEach(() => {
  delete process.env.ROUNDTABLE_DEFAULT_VISIBILITY;
  delete process.env.ROUNDTABLE_DEFAULT_BUDGET_USD;
  delete process.env.ROUNDTABLE_ALLOW_LOCAL_SANDBOX;
  calls = { launch: [], ensure: [], gh: [], detect: [], sandbox: [], stop: [] };
  restore = setOrchestratorDeps({
    launchRunner: (exe) => (calls.launch.push(exe), { pid: 4242 }),
    ensureRunner: async (exe) => (calls.ensure.push(exe), { status: "running", pid: 4242 }),
    selectSandbox: async (p) => (calls.sandbox.push(p), { backend: p.preferred === "local" && p.allowLocal ? "local" : "docker" }),
    detectDriver: async (id) => (calls.detect.push(id), { ok: true, missing: [] }),
    checkGh: async (o) => (calls.gh.push(o), { ok: true, missing: [] }),
    stopGroup: async (pgid) => {
      calls.stop.push(pgid);
    },
    dashboardWaitMs: 0,
  });
});
afterEach(() => restore());

const parse = (r) => {
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const errorOf = (r) => {
  assert.equal(r.isError, true, r.content[0].text);
  return r.content[0].text;
};

/** A repository (optionally with a submodule gitlink) and an execution whose contract is frozen (or only proposed). */
async function frozenRun(t, { contract: over = {}, frozen = true, start = false, submodule = false } = {}) {
  const repo = makeRepo({ "README.md": "readme\n", "src/api/index.js": "export const api = 1;\n" });
  if (submodule) {
    git(repo.root, "update-index", "--add", "--cacheinfo", `160000,${repo.sha},vendor/lib`);
    git(repo.root, "commit", "-q", "-m", "add a submodule");
    repo.sha = git(repo.root, "rev-parse", "HEAD");
  }
  const store = await createExecutionStore({ repoRoot: repo.root, baseSha: repo.sha, agentsDir: join(repo.root, ".claude", "agents") });
  const id = `ctr-${store.id.slice(-6)}-1`;
  const contract = contractFor(id, {
    status: frozen ? "frozen" : "draft",
    scope: { orchestrator: "main", repo_root: repo.root, base_ref: repo.sha, paths: ["src/**", "docs/**"] },
    tasks: [task("api"), task("build-nav-bar", { team: "web", paths: { write: ["src/components/nav/**"] } }), task("later", { depends_on: ["api"] })],
    sandbox: { backend: "docker", image: "node:22" },
    participants: [{ agent: "builder" }, { agent: "lead" }],
    ...over,
  });
  mkdirSync(join(store.dir, "contracts", id), { recursive: true });
  const blob = await store.putBlob(scrubbedJSON(contract), { redact: false });
  const hash = createHash("sha256").update(scrubbedJSON(contract)).digest("hex");
  const events = [
    { type: "execution.created", source: runner, payload: { repo_root: repo.root, base_sha: repo.sha, contract: id, contract_version: 1 } },
    { type: "contract.proposed", source: runner, payload: { contract: id, version: 1, source: "test", blob } },
  ];
  if (frozen) events.push({ type: "contract.frozen", source: runner, payload: { contract: id, version: 1, by: "main", hash, blob } });
  if (start) {
    events.push({
      type: "execution.started",
      source: runner,
      payload: { confirmation: "go", visibility: { dashboard: false, chat_only: true }, budget: contract.budget, lead: "lead", sandbox: "local", drivers: ["claude-code"] },
    });
  }
  await store.transact(() => ({ events }));
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const emit = (list) => store.transact(() => ({ events: list.map((e) => ({ source: runner, ...e })) }));
  const eventsOf = async (type) => (await store.events()).filter((e) => e.type === type);
  return { ...repo, store, exe: store.id, contractId: id, contract, emit, eventsOf };
}

const auditEntries = () =>
  existsSync(AUDIT_DIR)
    ? readdirSync(AUDIT_DIR).filter((p) => p.endsWith(".jsonl")).flatMap((p) => readFileSync(join(AUDIT_DIR, p), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse))
    : [];

const DEFAULT_BUDGET = { usd: 20, per_task_usd: 5, wall_clock_min: 120, max_parallel: 3, max_attempts: 3 };

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

test("execute: a bare call asks about visibility, the budget, the sandbox, the worker CLI and submodules, and starts nothing", async (t) => {
  const f = await frozenRun(t, { contract: { budget: DEFAULT_BUDGET }, submodule: true });
  restore = ((prev) => {
    const undo = setOrchestratorDeps({
      selectSandbox: async () => {
        throw new SandboxUnavailableError(["docker is not available: Cannot connect to the Docker daemon", "the local sandbox is not allowed (set ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1)"]);
      },
      detectDriver: async () => ({ ok: false, missing: ["--mcp-config", "--strict-mcp-config"] }),
    });
    return () => (undo(), prev());
  })(restore);
  const r = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "yes, build it" }));
  assert.equal(r.status, "needs_input");
  assert.deepEqual(r.questions.map((q) => q.topic), ["visibility", "budget", "sandbox", "workers", "repository"]);
  for (const q of r.questions) assert.ok(q.question.length > 40 && !q.question.includes("undefined"), q.question);
  assert.match(r.questions[0].question, /dashboard/);
  assert.match(r.questions[1].question, /\$20/);
  assert.match(r.questions[2].question, /Docker daemon/);
  assert.match(r.questions[2].answer_with, /sandbox: "local"/);
  assert.match(r.questions[3].question, /--mcp-config/);
  assert.match(r.questions[4].question, /submodules/);
  const state = await f.store.state();
  assert.equal(state.status, "created");
  assert.equal((await f.eventsOf("execution.started")).length, 0);
  assert.deepEqual(calls.launch, []);
});

test("execute: GitHub without the gh scopes, codex without an opt-in, and a contract that is not frozen", async (t) => {
  const f = await frozenRun(t, { contract: { workers: { driver: "codex" } } });
  restore = ((prev) => {
    const undo = setOrchestratorDeps({ checkGh: async (o) => (calls.gh.push(o), { ok: false, missing: ["the gh token scope `project` (run: gh auth refresh --scopes project)"] }) });
    return () => (undo(), prev());
  })(restore);
  const r = parse(await handleToolCall("execute", {
    contract_id: f.contractId, confirmation: "go", budget_usd: 10,
    visibility: { github: { repo: "acme/shop", project_number: 7 } },
  }));
  assert.deepEqual(r.questions.map((q) => q.topic), ["workers", "github"]);
  assert.match(r.questions[0].question, /Codex/);
  assert.match(r.questions[1].question, /acme\/shop.*scope `project`/);
  assert.deepEqual(calls.gh, [{ repo: "acme/shop", project: { number: 7 } }]);
  assert.deepEqual(calls.detect, ["codex"]);
  // An explicit worker_driver: "codex" is the opt-in.
  const opted = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "go", budget_usd: 10, worker_driver: "codex", visibility: { dashboard: true } }));
  assert.equal(opted.status, "started", JSON.stringify(opted));

  const draft = await frozenRun(t, { frozen: false });
  assert.match(errorOf(await handleToolCall("execute", { contract_id: draft.contractId, confirmation: "go", visibility: { chat_only: true } })), /is not frozen: freeze_contract/);
  assert.match(errorOf(await handleToolCall("execute", { contract_id: draft.contractId, confirmation: "go", visibility: { chat_only: true, dashboard: true } })), /chat_only/);
  assert.match(errorOf(await handleToolCall("execute", { contract_id: draft.contractId, confirmation: " " })), /"confirmation" is required/);
});

test("execute: starts the run with the human's settings and words, then answers again without starting twice", async (t) => {
  const f = await frozenRun(t);
  writeFileSync(join(f.root, "notes.txt"), "uncommitted\n");
  const args = {
    contract_id: f.contractId, confirmation: "Yes — go ahead and build the nav bar.",
    visibility: { chat_only: true }, budget_usd: 30, max_parallel: 2, sandbox: "local", worker_model: "sonnet",
  };
  const r = parse(await handleToolCall("execute", args));
  assert.equal(r.status, "started");
  assert.equal(r.execution_id, f.exe);
  assert.equal(r.runner_pid, 4242);
  assert.deepEqual(calls.launch, [f.exe]);
  assert.equal(r.sandbox, "local");
  assert.ok(calls.sandbox[0].allowLocal, "sandbox: local is the opt-in");
  assert.ok(r.warnings.some((w) => /1 uncommitted change \(notes\.txt\)/.test(w)), JSON.stringify(r.warnings));
  assert.deepEqual(r.watch.argv.slice(2), ["watch", f.exe, "--as", "main"]);
  assert.match(r.watch.instructions, /BACKGROUND shell command/);
  assert.match(r.watch.instructions, /start the same command again/);
  assert.match(r.watch.instructions, /execution_status/);
  assert.match(r.watch.command, new RegExp(`watch ${f.exe} --as main$`));

  const state = await f.store.state();
  assert.equal(state.status, "running");
  assert.equal(state.contract.budget.usd, 30);
  assert.equal(state.contract.budget.max_parallel, 2);
  assert.equal(state.contract.workers.model, "sonnet");
  assert.equal(state.contract.sandbox.backend, "local");
  const amended = await f.eventsOf("contract.amended");
  assert.equal(amended.length, 1);
  assert.match(amended[0].payload.reason, /Settings the human confirmed at execute: budget \$30, max_parallel 2, sandbox local, worker model sonnet/);
  const [started] = await f.eventsOf("execution.started");
  assert.equal(started.payload.confirmation, args.confirmation);
  assert.deepEqual(started.payload.visibility, { dashboard: false, chat_only: true });
  assert.equal(started.payload.budget.usd, 30);
  assert.equal(started.payload.sandbox, "local");
  assert.deepEqual(started.payload.drivers, ["claude-code"]);
  const audit = auditEntries().filter((e) => e.action === "execution.started" && e.target === f.exe);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.confirmation, args.confirmation);
  assert.equal(audit[0].actor, "main");

  const again = parse(await handleToolCall("execute", { ...args, budget_usd: 99 }));
  assert.equal(again.status, "already_started");
  assert.equal(again.runner_pid, 4242);
  assert.equal(again.run_status, "running");
  assert.deepEqual(again.watch.argv.slice(2), ["watch", f.exe, "--as", "main"]);
  assert.deepEqual(calls.launch, [f.exe], "no second runner");
  assert.deepEqual(calls.ensure, [f.exe]);
  assert.equal((await f.eventsOf("execution.started")).length, 1);
  assert.equal((await f.store.state()).contract.budget.usd, 30);
});

test("execute: environment defaults for visibility and budget, and the dashboard URL once the runner wrote it", async (t) => {
  const f = await frozenRun(t, { contract: { budget: DEFAULT_BUDGET } });
  process.env.ROUNDTABLE_DEFAULT_VISIBILITY = "dashboard, github:acme/shop";
  process.env.ROUNDTABLE_DEFAULT_BUDGET_USD = "12.5";
  const url = "http://127.0.0.1:43210/abcdefghijklmnopqrstuvwx/";
  restore = ((prev) => {
    const undo = setOrchestratorDeps({
      launchRunner: (exe) => {
        calls.launch.push(exe);
        setTimeout(() => writeFileSync(join(f.store.dir, "dashboard.json"), JSON.stringify({ url, pid: process.pid, host: "h", started_at: "now" })), 150);
        return { pid: 4343 };
      },
      dashboardWaitMs: 3000,
    });
    return () => (undo(), prev());
  })(restore);
  const r = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "ship it" }));
  assert.equal(r.status, "started", JSON.stringify(r));
  assert.deepEqual(r.visibility, { dashboard: true, chat_only: false, github: { repo: "acme/shop" } });
  assert.equal(r.budget_usd, 12.5);
  assert.equal(r.dashboard_url, url);
  assert.deepEqual(calls.gh, [{ repo: "acme/shop" }]);
  const s = parse(await handleToolCall("execution_status", { execution_id: f.exe }));
  assert.equal(s.dashboard.url, url);
  assert.equal(s.github.repo, "acme/shop");
});

test("execute: helpers parse ROUNDTABLE_DEFAULT_VISIBILITY and recognise an unconfirmed default budget", () => {
  assert.deepEqual(parseVisibility("chat"), { value: { dashboard: false, chat_only: true } });
  assert.deepEqual(parseVisibility("Dashboard"), { value: { dashboard: true, chat_only: false } });
  assert.match(parseVisibility("chat_only,dashboard").problem, /cannot be combined/);
  assert.match(parseVisibility("github:not a repo").problem, /unknown entry/);
  assert.deepEqual(parseVisibility(" , "), {});
  const c = contractFor("ctr-abcdef-1");
  assert.equal(contractBudgetSet(c), true);
  assert.equal(contractBudgetSet({ ...c, budget: DEFAULT_BUDGET }), false);
  assert.equal(contractBudgetSet({ ...c, budget: DEFAULT_BUDGET, scope: { ...c.scope, parent: { contract: "ctr-zzzzzz-1", task: "x" } } }), true);
});

// ---------------------------------------------------------------------------
// control_execution
// ---------------------------------------------------------------------------

test("control_execution: pause and resume the run or tasks, and the round trip to the table", async (t) => {
  const f = await frozenRun(t, { start: true });
  const p = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause", reason: "Lunch" }));
  assert.equal(p.paused, "all");
  assert.equal((await f.store.state()).status, "paused");
  assert.match(parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause" })).note, /already paused/);
  const r = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "resume" }));
  assert.equal(r.resumed, "all");
  assert.deepEqual(r.runner, { status: "running", pid: 4242 });
  assert.equal((await f.store.state()).status, "running");

  parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause", task_ids: ["api", "later"] }));
  assert.deepEqual((await f.store.state()).paused_tasks, ["api", "later"]);
  parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "resume", task_ids: ["api"] }));
  assert.deepEqual((await f.store.state()).paused_tasks, ["later"]);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause", task_ids: ["nope"] })), /Unknown task nope/);

  const toTable = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause", to_table: true, session: "collab-abc" }));
  assert.equal(toTable.mode, "deliberation");
  parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "resume", to_table: true, reason: "Plan settled" }));
  const modes = (await f.eventsOf("execution.mode_changed")).map((e) => e.payload);
  assert.deepEqual(modes, [
    { from: "execution", to: "deliberation", reason: "back to the table", session: "collab-abc" },
    { from: "deliberation", to: "execution", reason: "Plan settled" },
  ]);
  const s = await f.store.state();
  assert.equal(s.status, "running");
  assert.deepEqual(s.paused_tasks, []);
});

test("control_execution: steer issues a directive to agents, teams or the agents of tasks", async (t) => {
  const f = await frozenRun(t, { start: true });
  await f.emit([
    { type: "agent.registered", payload: { agent: "w-api", persona: "builder", driver: "claude-code", token_sha256: "a".repeat(64), external: false } },
    { type: "task.claimed", payload: { task: "api", agent: "w-api", attempt: 1, ttl_s: 0 } },
    { type: "agent.registered", payload: { agent: "w-nav", persona: "builder", driver: "claude-code", token_sha256: "b".repeat(64), external: false } },
  ]);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "steer" })), /"message" is required for steer/);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "steer", message: "x", targets: ["ghost"] })), /Unknown target ghost/);
  const all = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "steer", message: "Use plain CSS, no frameworks." }));
  assert.deepEqual(all.to.sort(), ["w-api", "w-nav"]);
  const one = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "steer", message: "Ship the client first.", targets: ["api"] }));
  assert.deepEqual(one.to, ["w-api"]);
  const steered = (await f.eventsOf("execution.steered")).map((e) => e.payload);
  assert.deepEqual(steered, [{ message: "Use plain CSS, no frameworks.", targets: [] }, { message: "Ship the client first.", targets: ["api"] }]);
  const state = await f.store.state();
  assert.deepEqual(state.inbox["w-api"].map((i) => [i.text, i.requires_ack]), [["Use plain CSS, no frameworks.", true], ["Ship the client first.", true]]);
  assert.equal(state.inbox["w-nav"].length, 1);
  assert.deepEqual(calls.ensure, [f.exe, f.exe]);
});

test("control_execution: abort stops the workers' process groups and keeps the worktrees; purge needs confirm and a finished run", async (t) => {
  const f = await frozenRun(t, { start: true });
  await f.emit([
    { type: "agent.registered", payload: { agent: "w-api", persona: "builder", driver: "claude-code", token_sha256: "a".repeat(64), external: false } },
    { type: "task.claimed", payload: { task: "api", agent: "w-api", attempt: 1, ttl_s: 0 } },
    { type: "agent.spawned", payload: { agent: "w-api", task: "api", attempt: 1, pid: process.pid, started: processStart(process.pid), session_id: "11111111-2222-4333-8444-555555555555" } },
    { type: "agent.registered", payload: { agent: "outside", persona: "outside", driver: "external", token_sha256: "c".repeat(64), external: true } },
  ]);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "purge" })), /pass confirm: true/);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "purge", confirm: true })), /Purge refused: .*only completed, failed or aborted runs/);
  const a = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "abort", reason: "Wrong plan" }));
  assert.equal(a.status, "aborted");
  assert.deepEqual(a.stopped, ["w-api"]);
  assert.deepEqual(calls.stop, [process.pid]);
  assert.ok(a.kept.worktrees.endsWith(f.exe) && a.kept.log.endsWith("events.jsonl"));
  assert.ok(existsSync(f.store.dir));
  assert.deepEqual((await f.eventsOf("execution.aborted")).map((e) => e.payload), [{ reason: "Wrong plan" }]);
  assert.ok(auditEntries().some((e) => e.action === "execution.aborted" && e.target === f.exe && e.details.stopped[0] === "w-api"));
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "abort" })), /is aborted: there is nothing to abort/);
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "pause" })), /is aborted/);
  // The worker's pid (this process) still lives, so purge refuses until it is gone.
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: f.exe, action: "purge", confirm: true })), /Workers still run/);

  const g = await frozenRun(t, { start: true });
  parse(await handleToolCall("control_execution", { execution_id: g.exe, action: "abort" }));
  const p = parse(await handleToolCall("control_execution", { execution_id: g.exe, action: "purge", confirm: true }));
  assert.equal(p.status, "aborted");
  assert.ok(!existsSync(g.store.dir));
  assert.ok(auditEntries().some((e) => e.action === "execution.purged" && e.target === g.exe && e.actor === "main"));
  assert.match(errorOf(await handleToolCall("control_execution", { execution_id: g.exe, action: "purge", confirm: true })), /not found/);
});

// ---------------------------------------------------------------------------
// resolve_escalation
// ---------------------------------------------------------------------------

async function escalated(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-ws11-personas-"));
  const old = process.env.ROUNDTABLE_AGENT_PATHS;
  process.env.ROUNDTABLE_AGENT_PATHS = `${old ?? ""}${old ? ":" : ""}${dir}`;
  const personas = {};
  for (const name of ["requester", "counterpart", "lead"]) {
    personas[name] = join(dir, `${name}.md`);
    writeFileSync(personas[name], `---\nname: ${name}\ndescription: Test ${name}\n---\nYou are ${name}.\n`);
  }
  t.after(() => {
    process.env.ROUNDTABLE_AGENT_PATHS = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const f = await frozenRun(t, {
    start: true,
    contract: {
      tasks: [task("a", { persona: personas.requester }), task("b", { persona: personas.counterpart })],
      teams: [], participants: Object.values(personas).map((agent) => ({ agent })),
      authority: { lead: personas.lead, may: ["retry"], budget_extension_pct: 0 },
    },
  });
  for (const [agent, id, persona] of [["wa", "a", personas.requester], ["wb", "b", personas.counterpart]]) {
    await f.emit([
      { type: "agent.registered", payload: { agent, persona, driver: "claude-code", token_sha256: "a".repeat(64), external: false } },
      { type: "task.claimed", payload: { task: id, agent, attempt: 1, ttl_s: 0 } },
      { type: "agent.spawned", payload: { agent, task: id, attempt: 1, pid: process.pid, started: processStart(process.pid), session_id: "11111111-2222-4333-8444-555555555555" } },
    ]);
  }
  const escalation = { id: "esc-test", agent: "wa", task: "a", kind: "ambiguity", with: "orchestrator", summary: "REST or GraphQL for the API?", blocking: true, status: "open", raised_seq: 0, ...over };
  await f.emit([
    { type: "escalation.raised", correlation: escalation.id, payload: { escalation } },
    { type: "task.blocked", payload: { task: "a", escalation: escalation.id } },
  ]);
  return { ...f, personas, escalation };
}

test("resolve_escalation: decide resolves through WS10, unblocks the task and hands the resume to the runner", async (t) => {
  const f = await escalated(t);
  const r = parse(await handleToolCall("resolve_escalation", { execution_id: f.exe, escalation_id: "esc-test", action: "decide", decision: "Use REST." }));
  assert.equal(r.applied, "decide");
  assert.equal(r.escalation.status, "resolved");
  assert.deepEqual(r.escalation.resolution, { action: "decide", decision: "Use REST.", by: "main" });
  assert.deepEqual(r.handed_to_runner, [{ type: "resume_worker", task: "a", agent: "wa" }]);
  assert.deepEqual(calls.ensure, [f.exe]);
  assert.equal((await f.store.state()).tasks.a.state, "in_progress");
  const ops = takeHandoffs(f.exe);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "resume_worker");
  assert.match(ops[0].card, /Use REST\./);
  assert.equal(readdirSync(handoffDir(f.exe)).length, 1, "reading retains the operation until its effect is observed");
  acknowledgeHandoff(f.exe, ops[0]);
  assert.deepEqual(readdirSync(handoffDir(f.exe)), []);
  // Idempotent: a second call changes nothing and hands nothing over.
  const again = parse(await handleToolCall("resolve_escalation", { execution_id: f.exe, escalation_id: "esc-test", action: "decide", decision: "Use GraphQL." }));
  assert.equal(again.noop, true);
  assert.deepEqual(again.handed_to_runner, []);
  assert.match(errorOf(await handleToolCall("resolve_escalation", { execution_id: f.exe, escalation_id: "esc-test", action: "decide", provider: "grok" })), /Unknown provider "grok"/);
  assert.match(errorOf(await handleToolCall("resolve_escalation", { execution_id: f.exe, escalation_id: "esc-nope", action: "dismiss" })), /Unknown escalation esc-nope/);
});

test("resolve_escalation: a micro-huddle calls the chosen provider outside transact and decides", async (t) => {
  const f = await escalated(t, { kind: "assistance", with: "agent", target: "wb" });
  // The tool opens its own store, so a transaction in flight shows as the events.lock directory.
  const lockDir = join(f.store.dir, "events.lock");
  const seen = stubFetch(t, async (url, init, index) => {
    assert.equal(existsSync(lockDir), false, "a provider call inside transact");
    assert.equal(url, "http://localhost:4141/v1/chat/completions");
    const text = ["We can keep the old shape for now.", "Outcome: AGREED\nDecision: Keep the v1 API shape until the nav ships."][index];
    return json(200, { model: "gpt-4o-mini", choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const r = parse(await handleToolCall("resolve_escalation", {
    execution_id: f.exe, escalation_id: "esc-test", action: "huddle", format: "micro",
    provider: "openai_compatible", model: "gpt-4o-mini", base_url: "http://localhost:4141/v1",
  }));
  assert.equal(seen.length, 2);
  assert.equal(r.applied, "huddle");
  assert.equal(r.escalation.status, "resolved");
  assert.match(r.escalation.resolution.decision, /Keep the v1 API shape/);
  assert.equal((await f.eventsOf("huddle.concluded"))[0].payload.outcome, "AGREED");
  assert.ok((await f.eventsOf("budget.usage_recorded")).some((e) => e.payload.source === "huddle"));
});

test("5: abort marks a worker gone and never signals a live pid with a different start identity", async (t) => {
  const f = await frozenRun(t, { start: true });
  await f.emit([
    { type: "agent.registered", payload: { agent: "w-api", persona: "builder", driver: "claude-code", token_sha256: "a".repeat(64), external: false } },
    { type: "task.claimed", payload: { task: "api", agent: "w-api", attempt: 1, ttl_s: 0 } },
    { type: "agent.spawned", payload: { agent: "w-api", task: "api", attempt: 1, pid: process.pid, started: "a previous occupant of this pid" } },
  ]);
  const result = parse(await handleToolCall("control_execution", { execution_id: f.exe, action: "abort", reason: "stop" }));
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(calls.stop, []);
  assert.equal((await f.store.state()).agents["w-api"].status, "exited");
});

test("10: repeated execute preflight needs_input or failure creates no integration worktree or branch", async (t) => {
  const { executionWorktreesDir } = await import("../../dist/execution/worktrees.js");
  const { integrationBranch } = await import("../../dist/execution/git.js");
  const f = await frozenRun(t);
  for (let n = 0; n < 2; n++) {
    const result = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "go" }));
    assert.equal(result.status, "needs_input");
    assert.equal(result.execution_id, f.exe);
    assert.equal(existsSync(executionWorktreesDir(f.exe)), false);
    assert.equal(git(f.root, "branch", "--list", integrationBranch(f.exe)), "");
  }
  const undo = setOrchestratorDeps({ selectSandbox: async () => { throw new Error("probe failed"); } });
  try {
    const failed = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "go", visibility: { chat_only: true }, budget_usd: 20 }));
    assert.equal(failed.status, "needs_input");
    assert.match(failed.questions[0].question, /probe failed/);
  } finally { undo(); }
  assert.equal(existsSync(executionWorktreesDir(f.exe)), false);
  assert.equal((await f.eventsOf("execution.started")).length, 0);
  const result = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "go", visibility: { chat_only: true }, budget_usd: 20 }));
  assert.equal(result.execution_id, f.exe);
  assert.equal(result.status, "started");
  const again = parse(await handleToolCall("execute", { contract_id: f.contractId, confirmation: "go" }));
  assert.equal(again.status, "already_started");
  assert.equal(again.execution_id, f.exe);
  assert.equal((await f.eventsOf("execution.started")).length, 1);
  assert.deepEqual(calls.launch, [f.exe]);
});
