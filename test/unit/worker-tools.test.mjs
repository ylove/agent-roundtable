// The worker tools against a temp execution store and repository: join_execution and the
// agent_token flow on the orchestrator server, the token-bound worker mode, inbox piggyback,
// leases, updates, the sandbox (local backend) and submissions.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, nodeCommand, registerWorker, runner, task } from "../fixtures/workers/run.mjs";

process.env.ROUNDTABLE_ALLOW_LOCAL_SANDBOX = "1";
const { handleToolCall, toolsFor } = await import("../../dist/tools.js");
const W = await import("../../dist/tools/worker.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { ROUNDTABLE_HOME } = await import("../../dist/config.js");

afterEach(() => W.resetWorkerTools());

const COMMANDS = [
  nodeCommand("pass", "console.log('all good')"),
  nodeCommand("fail", "console.error('boom: assertion failed at test.js:3'); process.exit(3)"),
  nodeCommand("needs-ok", "require('fs').readFileSync('src/api/ok.txt'); console.log('ok present')"),
];

const runWith = (over = {}) =>
  makeRun({
    contract: {
      tasks: [task("api", { checks: ["needs-ok"] }), task("build-nav-bar", { team: "web", paths: { write: ["src/components/nav/**"] }, checks: ["pass"] }), task("later", { depends_on: ["api"] })],
      interfaces: [{ name: "ApiClient", kind: "api", owner: "api", description: "HTTP client", consumers: ["build-nav-bar"] }],
      validation: { commands: COMMANDS, final: [] },
      ...over,
    },
  });

function parse(text) {
  const body = text.startsWith("Error: ") ? text.slice(7) : text;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function call(name, args, mode = "orchestrator") {
  const r = await handleToolCall(name, args, mode);
  const text = r.content[0].text;
  return { isError: r.isError === true, text, json: parse(text) };
}

async function ok(name, args, mode) {
  const r = await call(name, args, mode);
  assert.equal(r.isError, false, `${name}: ${r.text}`);
  return r.json;
}

async function join_(run, agent, extra = {}) {
  const j = await ok("join_execution", { execution_id: run.store.id, agent, ...extra });
  return { execution_id: run.store.id, agent_token: j.agent_token, j };
}

const eventsSince = async (store, seq, types) => (await store.events({ sinceSeq: seq })).filter((e) => !types || types.includes(e.type));

test("the worker server lists exactly the seven worker tools; the orchestrator also has join_execution", () => {
  assert.deepEqual(toolsFor("worker").map((t) => t.name), ["read_blackboard", "claim_task", "lease", "post_update", "run_command", "submit_work", "escalate"]);
  const orch = Object.fromEntries(toolsFor("orchestrator").map((t) => [t.name, t]));
  assert.ok(orch.join_execution);
  for (const t of toolsFor("worker")) {
    assert.ok(!("agent_token" in t.inputSchema.properties), `${t.name} is token-bound on the worker server`);
    assert.equal(t.inputSchema.additionalProperties, false);
    const o = orch[t.name].inputSchema;
    assert.deepEqual(o.required.slice(0, 2), ["execution_id", "agent_token"], t.name);
    assert.equal(o.properties.agent_token.pattern, "^[0-9a-f]{64}$");
  }
  assert.equal(toolsFor("worker").some((t) => t.name === "join_execution"), false);
});

test("join_execution: the token once, the worktree and card; runner ids refused; a re-join voids the old token", async () => {
  const run = await runWith();
  const { j, ...auth } = await join_(run, "ext-1", { task_id: "api" });
  assert.match(j.agent_token, /^[0-9a-f]{64}$/);
  assert.equal(realpathSync(j.worktree), realpathSync(join(ROUNDTABLE_HOME, "worktrees", run.store.id, "api")));
  assert.ok(existsSync(join(j.worktree, "README.md")));
  assert.match(j.task_card, /# Task api/);
  assert.match(j.task_card, /agent_token/);
  const state = await run.store.state();
  assert.deepEqual({ ...state.agents["ext-1"], token_sha256: "x" }, { id: "ext-1", persona: "ext-1", driver: "external", external: true, token_sha256: "x", status: "registered" });
  const all = await run.store.events();
  assert.ok(!JSON.stringify(all).includes(j.agent_token), "the token itself is never logged");

  await registerWorker(run.store, "builder-1", "build-nav-bar");
  const r = await call("join_execution", { execution_id: run.store.id, agent: "builder-1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /runner manages/);
  assert.match((await call("join_execution", { execution_id: run.store.id, agent: "ext-2", team: "nope" })).text, /Unknown team/);
  const noTask = await ok("join_execution", { execution_id: run.store.id, agent: "ext-2", team: "web" });
  assert.deepEqual(noTask.ready_tasks.map((t) => t.id), ["api"], "build-nav-bar is claimed, later waits on api");

  await ok("read_blackboard", auth);
  await join_(run, "ext-1");
  const stale = await call("read_blackboard", auth);
  assert.equal(stale.isError, true);
  assert.match(stale.text, /does not belong/);
});

test("the orchestrator copies require execution_id and agent_token and reject a wrong one", async () => {
  const run = await runWith();
  assert.match((await call("read_blackboard", {})).text, /"execution_id" is required/);
  assert.match((await call("read_blackboard", { execution_id: run.store.id })).text, /"agent_token" is required/);
  assert.match((await call("read_blackboard", { execution_id: run.store.id, agent_token: "nope" })).text, /must match the pattern/);
  assert.match((await call("read_blackboard", { execution_id: run.store.id, agent_token: "a".repeat(64) })).text, /does not belong to any agent/);
  assert.match((await call("read_blackboard", { section: "summary" }, "worker")).text, /no identity/);
  assert.match((await call("lease", { execution_id: run.store.id, agent_token: "a".repeat(64), action: "request" })).text, /"paths" is required/);
  assert.match((await call("run_command", { execution_id: run.store.id, agent_token: "a".repeat(64) })).text, /exactly one of "command_id" and "argv"/);
});

test("claim_task: a ready task with its card and worktree; unready, taken and second claims refused; release", async () => {
  const run = await runWith();
  await registerWorker(run.store, "builder-1", "build-nav-bar");
  const { j, ...auth } = await join_(run, "ext-1");
  assert.match((await call("claim_task", { ...auth, task_id: "later" })).text, /pending, not ready/);
  assert.match((await call("claim_task", { ...auth, task_id: "build-nav-bar" })).text, /already claimed by builder-1/);
  const c = await ok("claim_task", auth);
  assert.equal(c.claimed, "api", "without task_id the first ready task");
  assert.ok(existsSync(join(c.worktree, ".git")));
  assert.match(c.task_card, /# Task api/);
  let s = await run.store.state();
  assert.deepEqual(s.claims.api, { task: "api", agent: "ext-1", attempt: 1, ttl_s: 900, granted_seq: s.claims.api.granted_seq });
  assert.equal(s.tasks.api.state, "claimed");
  assert.match((await call("claim_task", { ...auth, task_id: "api" })).text, /already hold api/);
  const leasesFile = JSON.parse(readFileSync(join(run.store.dir, "agents", "ext-1", "leases.json"), "utf8"));
  assert.equal(leasesFile.task, "api");
  assert.ok(existsSync(join(run.store.dir, "agents", "ext-1", "heartbeat")), "every call renews the heartbeat");

  await ok("lease", { ...auth, action: "request", paths: ["src/api/**"] });
  const rel = await ok("claim_task", { ...auth, release: true, note: "handing over" });
  assert.equal(rel.released, "api");
  s = await run.store.state();
  assert.equal(s.tasks.api.state, "ready");
  assert.equal(Object.values(s.leases).length, 0, "its leases went with it");
  assert.equal(s.tasks.api.last_note, "handing over");
});

test("lease: grants write leases.json; a conflict queues and names the holders; release grants the waiting request", async () => {
  const run = await runWith({ tasks: [task("api"), task("docs", { paths: { write: ["docs/**"] } })] });
  const a = await join_(run, "ext-a", { task_id: "api" });
  const b = await join_(run, "ext-b", { task_id: "docs" });
  delete a.j;
  delete b.j;
  await ok("claim_task", { ...a, task_id: "api" });
  await ok("claim_task", { ...b, task_id: "docs" });

  const g = await ok("lease", { ...a, action: "request", paths: ["src/api/**", "docs/shared.md"], reason: "client and its doc" });
  assert.equal(g.granted, true);
  assert.match(g.warning, /docs\/shared\.md is outside your task's write scope/);
  const fileA = () => JSON.parse(readFileSync(join(run.store.dir, "agents", "ext-a", "leases.json"), "utf8"));
  assert.deepEqual(fileA().leases.map((l) => l.paths), [["src/api/**", "docs/shared.md"]]);
  assert.equal((await ok("lease", { ...a, action: "request", paths: ["src/api/**"] })).existing, true);

  const q = await ok("lease", { ...b, action: "request", paths: ["docs/**"] });
  assert.equal(q.queued, true);
  assert.equal(q.holders[0].agent, "ext-a");
  assert.equal(q.holders[0].task, "api");
  assert.match(q.suggestion, /escalate\(kind: "conflict", with: "path_owner", target: "ext-a"/);

  assert.match((await call("lease", { ...a, action: "request", paths: ["package.json"] })).text, /outside the contract's scope/);
  assert.match((await call("lease", { ...a, action: "request", paths: ["src/.git/config"] })).text, /never writable/);
  assert.match((await call("lease", { ...a, action: "request", paths: ["src/vendor/.gitmodules"] })).text, /never writable by a worker/);
  assert.match((await call("lease", { ...a, action: "request", paths: ["../x"] })).text, /Not a valid lease path/);

  const leaseId = fileA().leases[0].id;
  const r = await ok("lease", { ...a, action: "release", paths: [leaseId] });
  assert.deepEqual(r.released, [leaseId]);
  assert.equal(r.granted_to_waiting.length, 1);
  const fileB = JSON.parse(readFileSync(join(run.store.dir, "agents", "ext-b", "leases.json"), "utf8"));
  assert.deepEqual(fileB.leases.map((l) => l.paths), [["docs/**"]], "the waiting agent's leases.json was rewritten");
  assert.deepEqual(fileA().leases, []);
  assert.deepEqual((await ok("lease", { ...a, action: "release", paths: ["**"] })).released, []);
});

test("post_update: progress, note, ack; need blocks the task; interface publishes and satisfies it", async () => {
  const run = await runWith();
  const tokenB = await registerWorker(run.store, "builder-1", "build-nav-bar", { team: "web" });
  const ext = await join_(run, "ext-1", { task_id: "api" });
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  const seq0 = (await run.store.state()).seq;

  assert.match((await call("post_update", { ...ext, kind: "progress", text: "x", percent: 140 })).text, /"percent" must be at most 100/);
  await ok("post_update", { ...ext, kind: "progress", text: "halfway", percent: 55.6 });
  await ok("post_update", { ...ext, kind: "note", text: "FYI the client retries", topic: "api", refs: ["src/api/client.js"] });
  let s = await run.store.state();
  assert.equal(s.tasks.api.percent, 56, "rounded");
  assert.equal(s.tasks.api.state, "in_progress");
  assert.deepEqual(s.notes.at(-1), { seq: s.notes.at(-1).seq, agent: "ext-1", topic: "api", text: "FYI the client retries", refs: ["src/api/client.js"] });

  W.bindWorkerIdentity({ store: await openExecutionStore(run.store.id), execution: run.store.id, agent: "builder-1", tokenSha256: tokenB.sha256 });
  const need = await ok("post_update", { kind: "need", name: "ApiClient", text: "need the client to call the menu endpoint" }, "worker");
  assert.equal(need.kind, "interface");
  assert.equal(need.blocked, "build-nav-bar");
  s = await run.store.state();
  assert.equal(s.tasks["build-nav-bar"].state, "blocked");

  assert.match((await call("post_update", { kind: "interface", name: "ApiClient", text: "x" }, "worker")).text, /owned by task api/);
  const pub = await ok("post_update", { ...ext, kind: "interface", name: "ApiClient", text: "export function get(path) {}", path: "src/api/client.js" });
  assert.equal(pub.version, 1);
  assert.deepEqual(pub.satisfied, ["build-nav-bar"]);
  const evs = await eventsSince(run.store, seq0, ["artifact.published", "dependency.requested", "dependency.satisfied", "task.blocked"]);
  const published = evs.find((e) => e.type === "artifact.published");
  assert.deepEqual(published.payload, { name: "ApiClient", kind: "interface", task: "api", blob: pub.blob, path: "src/api/client.js" });
  assert.deepEqual(evs.find((e) => e.type === "dependency.satisfied").payload, { task: "build-nav-bar", need: { kind: "interface", ref: "ApiClient" }, by_event: published.id });
  assert.equal((await ok("post_update", { kind: "need", name: "ApiClient", text: "again" }, "worker")).available, true);

  assert.match((await call("post_update", { ...ext, kind: "ack", text: "ok", directive_id: "dir-x" })).text, /No directive/);
  assert.match((await call("post_update", { ...ext, kind: "interface", text: "x" })).text, /needs "name"/);
});

test("inbox piggyback: new directives and decisions arrive once; unacknowledged directives are listed until acked", async () => {
  const run = await runWith();
  const ext = await join_(run, "ext-1", { task_id: "api" });
  delete ext.j;
  assert.equal((await ok("read_blackboard", ext)).inbox, undefined);
  await run.store.transact(() => ({
    events: [
      { type: "directive.issued", source: runner, payload: { id: "dir-1", to: ["ext-1"], text: "Re-read the contract", requires_ack: true } },
      { type: "decision.recorded", source: runner, payload: { decision: { id: "d-9", scope: "contract", text: "REST, not GraphQL", by: "main" } } },
    ],
  }));
  const first = await ok("claim_task", { ...ext, task_id: "api" });
  assert.deepEqual(first.inbox.new.map((i) => [i.kind, i.id, i.text]), [["directive", "dir-1", "Re-read the contract"], ["decision", "d-9", "REST, not GraphQL"]]);
  assert.equal(first.inbox.new[0].requires_ack, true);
  assert.deepEqual(first.inbox.awaiting_ack, [{ id: "dir-1", text: "Re-read the contract" }]);
  const second = await ok("read_blackboard", { ...ext, section: "goal" });
  assert.equal(second.inbox.new, undefined, "delivered once");
  assert.deepEqual(second.inbox.awaiting_ack, [{ id: "dir-1", text: "Re-read the contract" }]);
  const ack = await ok("post_update", { ...ext, kind: "ack", text: "done", directive_id: "dir-1" });
  assert.equal(ack.acknowledged, "dir-1");
  assert.equal((await ok("read_blackboard", ext)).inbox, undefined);
  const cursor = Number(readFileSync(join(run.store.dir, "agents", "ext-1", "inbox.cursor"), "utf8"));
  assert.ok(cursor > 0);
  // Errors carry the inbox too.
  await run.store.transact(() => ({ events: [{ type: "directive.issued", source: runner, payload: { id: "dir-2", to: ["ext-1"], text: "Stop", requires_ack: false } }] }));
  const err = await call("lease", { ...ext, action: "request", paths: ["../bad"] });
  assert.equal(err.isError, true);
  assert.deepEqual(err.json.inbox.new.map((i) => i.id), ["dir-2"]);
});

test("run_command: a named command is a task check; ad-hoc argv is command.completed with an output blob", async () => {
  const run = await runWith();
  const ext = await join_(run, "ext-1", { task_id: "api" });
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  const seq0 = (await run.store.state()).seq;

  const pass = await ok("run_command", { ...ext, command_id: "pass" });
  assert.equal(pass.status, "passed");
  assert.match(pass.output_tail, /all good/);
  const fail = await ok("run_command", { ...ext, command_id: "fail" });
  assert.equal(fail.status, "failed");
  assert.equal(fail.exit, 3);
  assert.match(fail.signature, /^[0-9a-f]{64}$/);
  assert.match(fail.output_tail, /boom/);
  assert.match((await call("run_command", { ...ext, command_id: "nope" })).text, /Unknown command_id nope; the contract defines: pass, fail, needs-ok/);

  const adhoc = await ok("run_command", { ...ext, argv: [process.execPath, "-e", "console.log('hello from ' + process.cwd()); process.exit(2)"] });
  assert.equal(adhoc.exit, 2);
  assert.equal(adhoc.backend, "local");
  assert.match(adhoc.output_tail, /hello from .*\/api/);
  const blob = await ok("read_blackboard", { ...ext, section: "blob", ref: adhoc.output_blob });
  assert.match(blob.text, /hello from/);

  const evs = await eventsSince(run.store, seq0);
  const types = evs.map((e) => e.type).filter((t) => t !== "sandbox.degraded");
  assert.deepEqual(types, ["check.started", "check.passed", "check.started", "check.failed", "command.completed"], "an unknown command_id records nothing");
  const failed = evs.find((e) => e.type === "check.failed");
  assert.deepEqual({ ...failed.payload, output_blob: "b" }, { command_id: "fail", scope: "task", task: "api", exit: 3, signature: fail.signature, output_blob: "b" });
  const completed = evs.find((e) => e.type === "command.completed");
  assert.equal(completed.payload.exit, 2);
  assert.equal(completed.payload.output_blob, adhoc.output_blob);
  for (const e of evs) assert.deepEqual([e.source.kind, e.source.id], ["agent", "ext-1"], e.type);
  assert.match((await call("run_command", { ...ext, argv: ["sh", "-c", "echo hi"] })).text, /shell -c commands are refused/);
});

test("submit_work: a checkpoint; an unleased change is a violation; failing checks reject; passing checks merge next", async () => {
  const run = await runWith();
  const ext = await join_(run, "ext-1", { task_id: "api" });
  const wt = ext.j.worktree;
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  await ok("lease", { ...ext, action: "request", paths: ["src/api/**"] });

  writeFileSync(join(wt, "src/api/client.js"), "export const get = () => 1;\n");
  writeFileSync(join(wt, "README.md"), "changed outside the lease\n");
  const cp = await ok("submit_work", { ...ext, summary: "WIP client", ready: false });
  assert.equal(cp.committed, true);
  assert.deepEqual(cp.not_committed, ["README.md"]);
  let s = await run.store.state();
  assert.equal(s.tasks.api.last_note, "Checkpoint: WIP client");
  assert.match(git(wt, "log", "-1", "--format=%B"), /Roundtable-Agent: ext-1/);

  const seq1 = s.seq;
  const v = await call("submit_work", { ...ext, summary: "client", ready: true });
  assert.equal(v.isError, true);
  assert.match(v.text, /Submission rejected: Changed paths outside the leases: README\.md/);
  const ve = await eventsSince(run.store, seq1, ["lease.violation", "task.rejected", "task.submitted"]);
  assert.deepEqual(ve.map((e) => e.type), ["lease.violation", "task.rejected"]);
  assert.deepEqual(ve[0].payload, { task: "api", agent: "ext-1", paths: ["README.md"] });
  git(wt, "checkout", "--", "README.md");

  const seq2 = (await run.store.state()).seq;
  const failing = await ok("submit_work", { ...ext, summary: "client, no ok file", ready: true });
  assert.equal(failing.checks_passed, false);
  assert.equal(failing.checks[0].command_id, "needs-ok");
  assert.match(failing.checks[0].output_tail, /ENOENT/);
  s = await run.store.state();
  assert.equal(s.tasks.api.state, "in_progress", "a failed check sends the task back to in_progress");
  assert.deepEqual((await eventsSince(run.store, seq2)).map((e) => e.type).filter((t) => t !== "sandbox.degraded"), ["task.submitted", "check.started", "check.failed", "task.rejected"]);

  writeFileSync(join(wt, "src/api/ok.txt"), "ok\n");
  const seq3 = (await run.store.state()).seq;
  const good = await ok("submit_work", { ...ext, summary: "client and ok file", ready: true });
  assert.equal(good.submitted, "api");
  assert.match(good.next, /runner will merge/);
  s = await run.store.state();
  assert.equal(s.tasks.api.state, "merging");
  const ge = await eventsSince(run.store, seq3);
  assert.deepEqual(ge.map((e) => e.type), ["task.submitted", "check.started", "check.passed", "task.checks_passed"]);
  const sub = ge[0].payload;
  assert.deepEqual(sub.files.sort(), ["src/api/client.js", "src/api/ok.txt"]);
  assert.match(sub.stat, /2 files changed/);
  const diff = await ok("read_blackboard", { ...ext, section: "blob", ref: sub.diff_blob });
  assert.match(diff.text, /\+export const get/);
  const bound = { commit: good.commit, submitted_seq: ge[0].seq };
  assert.deepEqual(ge[3].payload, { task: "api", commands: ["needs-ok"], ...bound }, "the runner merges exactly this commit");
  assert.equal(good.commit, ge[0].payload.commit);
  assert.deepEqual(ge.slice(1, 3).map((e) => ({ commit: e.payload.commit, submitted_seq: e.payload.submitted_seq })), [bound, bound]);
  assert.equal(good.checks[0].commit, good.commit);
  assert.deepEqual(readdirSync(join(ROUNDTABLE_HOME, "executions", run.store.id, "checks")), [], "the check checkout is removed");
  assert.match((await call("submit_work", { ...ext, summary: "again", ready: true })).text, /being merged/);
});

test("submit_work: a commit outside the leases on the branch fails coverage", async () => {
  const run = await runWith();
  const ext = await join_(run, "ext-1", { task_id: "api" });
  const wt = ext.j.worktree;
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  await ok("lease", { ...ext, action: "request", paths: ["src/api/**"] });
  writeFileSync(join(wt, "docs.md"), "sneaked in by hand\n");
  git(wt, "add", "docs.md");
  git(wt, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qm", "outside");
  const r = await call("submit_work", { ...ext, summary: "x", ready: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /docs\.md: not leased/);
  const s = await run.store.state();
  assert.match(s.tasks.api.last_note, /docs\.md: not leased/);
});

test("escalate: a blocking escalation blocks the task and says to end the turn; diagnostics go to a blob", async () => {
  const run = await runWith();
  const ext = await join_(run, "ext-1", { task_id: "api" });
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  const e = await ok("escalate", { ...ext, kind: "ambiguity", with: "orchestrator", summary: "Which auth?", question: "OAuth or keys?", options: ["OAuth", "keys"], diagnostics: { notes: "token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", files: ["src/api/auth.js"] }, blocking: true });
  assert.match(e.escalation_id, /^esc-/);
  assert.equal(e.instruction, "end your turn now with a one-line summary; you will be resumed with the resolution");
  const s = await run.store.state();
  const esc = s.escalations[e.escalation_id];
  assert.deepEqual({ ...esc, raised_seq: 0, diagnostics_blob: "b" }, {
    id: e.escalation_id, agent: "ext-1", task: "api", kind: "ambiguity", with: "orchestrator", summary: "Which auth?", question: "OAuth or keys?",
    options: ["OAuth", "keys"], diagnostics_blob: "b", blocking: true, status: "open", raised_seq: 0,
  });
  assert.equal(s.tasks.api.state, "blocked");
  assert.deepEqual(s.tasks.api.blocked_by, { escalation: e.escalation_id });
  const diag = (await run.store.getBlob(esc.diagnostics_blob)).toString("utf8");
  assert.match(diag, /src\/api\/auth\.js/);
  assert.doesNotMatch(diag, /sk-ant-api03-abcdefghijklmnop/, "diagnostics are scrubbed");
  const nb = await ok("escalate", { ...ext, kind: "assistance", with: "path_owner", target: "src/web/**", summary: "Who owns web?" });
  assert.equal(nb.blocking, false);
});

test("worker mode: tools are bound to the token's agent and stamp every event; a re-registration stops the old server", async () => {
  const run = await runWith();
  const tok = await registerWorker(run.store, "builder-1", "build-nav-bar", { team: "web" });
  await ensureTaskWorktree(run.header, "build-nav-bar");
  W.bindWorkerIdentity({ store: await openExecutionStore(run.store.id), execution: run.store.id, agent: "builder-1", tokenSha256: tok.sha256 });
  const seq0 = (await run.store.state()).seq;
  const sum = await ok("read_blackboard", {}, "worker");
  assert.equal(sum.you.agent, "builder-1");
  assert.equal(sum.you.task, "build-nav-bar");
  await ok("lease", { action: "request", paths: ["src/components/nav/**"] }, "worker");
  await ok("post_update", { kind: "progress", text: "nav skeleton", percent: 20 }, "worker");
  const wt = join(ROUNDTABLE_HOME, "worktrees", run.store.id, "build-nav-bar");
  mkdirSync(join(wt, "src/components/nav"), { recursive: true });
  writeFileSync(join(wt, "src/components/nav/bar.js"), "export const Bar = 1;\n");
  const sub = await ok("submit_work", { summary: "nav bar", ready: true }, "worker");
  assert.equal(sub.submitted, "build-nav-bar");
  const evs = await eventsSince(run.store, seq0);
  assert.ok(evs.length >= 6);
  for (const e of evs) {
    assert.equal(e.source.kind, "agent", e.type);
    assert.equal(e.source.id, "builder-1", e.type);
    assert.equal(e.source.task, "build-nav-bar", e.type);
    assert.equal(e.source.team, "web", e.type);
    assert.equal(e.source.pid, process.pid);
  }
  await registerWorker(run.store, "builder-1", "build-nav-bar", { claim: false });
  assert.match((await call("read_blackboard", {}, "worker")).text, /registered again since this worker started/);
});

test("read_blackboard: summary, task, query (\"is the nav done?\"), events filters, blob cap and redaction", async () => {
  const run = await runWith();
  await registerWorker(run.store, "builder-1", "build-nav-bar", { team: "web" });
  const ext = await join_(run, "ext-1", { task_id: "api" });
  delete ext.j;
  await run.store.transact(() => ({ events: [{ type: "task.progress", source: runner, payload: { task: "build-nav-bar", percent: 60, note: "links left" } }] }));

  const q = await ok("read_blackboard", { ...ext, query: "is the nav done?" });
  assert.equal(q.section, "query");
  assert.deepEqual(q.tokens, ["nav"]);
  assert.equal(q.matches[0].id, "build-nav-bar");
  assert.equal(q.answer, "Task build-nav-bar is in_progress (60%).");
  const team = await ok("read_blackboard", { ...ext, section: "query", query: "web team status" });
  assert.equal(team.matches.find((m) => m.kind === "team").id, "web");
  const iface = await ok("read_blackboard", { ...ext, query: "api client" });
  assert.ok(iface.matches.some((m) => m.kind === "interface" && m.name === "ApiClient" && m.published === false));

  const t = await ok("read_blackboard", { ...ext, section: "task", task_id: "build-nav-bar" });
  assert.equal(t.task.agent, "builder-1");
  assert.deepEqual(t.task.spec.paths.write, ["src/components/nav/**"]);
  const agents = await ok("read_blackboard", { ...ext, section: "agents" });
  assert.ok(agents.agents.every((a) => !("token_sha256" in a)), "token hashes are not listed");

  const all = await ok("read_blackboard", { ...ext, section: "events", limit: 200 });
  assert.ok(all.events.filter((e) => e.type === "agent.registered").every((e) => !("token_sha256" in e.payload)));
  const filtered = await ok("read_blackboard", { ...ext, section: "events", query: "task.", task_id: "build-nav-bar" });
  assert.ok(filtered.events.length >= 2 && filtered.events.length < all.events.length);
  assert.ok(filtered.events.every((e) => e.type.startsWith("task.") && e.task === "build-nav-bar"));
  const page = await ok("read_blackboard", { ...ext, section: "events", since_seq: 1, limit: 2 });
  assert.deepEqual(page.events.map((e) => e.seq), [2, 3]);
  assert.equal(page.next_since_seq, 3);

  const ref = await run.store.putBlob(`key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n${"y".repeat(40_000)}`, { redact: false });
  const blob = await ok("read_blackboard", { ...ext, section: "blob", ref });
  assert.equal(blob.truncated, true);
  assert.equal(blob.text.length, 16 * 1024);
  assert.doesNotMatch(blob.text, /sk-ant-api03-abcdefghijklmnop/);
  assert.match((await call("read_blackboard", { ...ext, section: "blob", ref: "sha256:" + "0".repeat(64) })).text, /not found/);
});

test("globWithin: lease globs inside the contract scope", () => {
  assert.equal(W.globWithin("src/api/**", "src/**"), true);
  assert.equal(W.globWithin("src/*.ts", "src/**"), true);
  assert.equal(W.globWithin("src", "src/**"), false);
  assert.equal(W.globWithin("srcx/a", "src/**"), false);
  assert.equal(W.globWithin(".gitattributes", ".gitattributes"), true);
  assert.equal(W.globWithin("docs/a.md", "docs/*.md"), true);
  assert.equal(W.globWithin("docs/*.md", "docs/a*.md"), false);
  assert.equal(W.globWithin("anything/**", "**"), true);
});


test("claim_task refuses runner assignment changes and preserves leases.json", async () => {
  const run = await runWith();
  const token = await registerWorker(run.store, "builder-1", "build-nav-bar");
  await run.store.transact(() => ({ events: [{ type: "agent.spawned", source: runner, payload: { agent: "builder-1", task: "build-nav-bar", attempt: 1, pid: process.pid, session_id: "s" } }] }));
  await ensureTaskWorktree(run.header, "build-nav-bar");
  W.bindWorkerIdentity({ store: run.store, execution: run.store.id, agent: "builder-1", tokenSha256: token.sha256 });
  await ok("lease", { action: "request", paths: ["src/components/nav/**"] }, "worker");
  const path = join(run.store.dir, "agents", "builder-1", "leases.json");
  const before = readFileSync(path, "utf8");
  for (const args of [{ release: true }, { task_id: "api" }, {}]) {
    assert.match((await call("claim_task", args, "worker")).text, /runner manages your assignment/);
  }
  const state = await run.store.state();
  assert.equal(state.claims["build-nav-bar"].agent, "builder-1");
  assert.equal(state.claims.api, undefined);
  assert.equal(state.agents["builder-1"].task, "build-nav-bar");
  assert.equal(readFileSync(path, "utf8"), before);
});

test("external claim checks include the agent-record fallback and serialize competing claims", async () => {
  const run = await runWith();
  const { j, ...auth } = await join_(run, "ext-1");
  await run.store.transact(() => ({ events: [{ type: "agent.spawned", source: runner, payload: { agent: "ext-1", task: "api", attempt: 1, pid: process.pid, session_id: "s" } }] }));
  assert.match((await call("claim_task", { ...auth, task_id: "build-nav-bar" })).text, /already hold api/);
  const second = await join_(run, "ext-2");
  delete second.j;
  const results = await Promise.all([call("claim_task", { ...second, task_id: "api" }), call("claim_task", { ...second, task_id: "build-nav-bar" })]);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.equal(Object.values((await run.store.state()).claims).filter((c) => c.agent === "ext-2").length, 1);
});

test("large notes responses preserve the decision inbox and valid JSON", async () => {
  const run = await runWith();
  const { j, ...auth } = await join_(run, "ext-1");
  await run.store.transact(() => ({ events: [
    ...Array.from({ length: 150 }, (_, i) => ({ type: "note.posted", source: runner, payload: { topic: "bulk", text: `${i}:` + "n".repeat(3500), refs: [] } })),
    { type: "decision.recorded", source: runner, payload: { decision: { id: "bulk-decision", scope: "contract", text: "Preserve this decision", by: "main" } } },
  ] }));
  const result = await call("read_blackboard", { ...auth, section: "notes", limit: 200 });
  assert.equal(result.isError, false);
  assert.ok(result.json, "the capped response remains JSON");
  assert.equal(Object.keys(result.json)[0], "inbox");
  assert.equal(result.json.inbox.new.at(-1).id, "bulk-decision");
  assert.ok(Buffer.byteLength(result.text) <= 96 * 1024);
  const cursor = Number(readFileSync(join(run.store.dir, "agents", "ext-1", "inbox.cursor"), "utf8"));
  assert.equal(cursor, result.json.inbox.new.at(-1).seq);
  assert.equal((await ok("read_blackboard", auth)).inbox, undefined);
});

test("oversized inboxes page oldest first and retain directive text awaiting ack", async () => {
  const run = await runWith();
  const { j, ...auth } = await join_(run, "ext-1");
  await run.store.transact(() => ({ events: Array.from({ length: 50 }, (_, i) => ({ type: "directive.issued", source: runner, payload: { id: `large-${i}`, to: ["ext-1"], text: `${i}:` + "d".repeat(4000), requires_ack: true } })) }));
  const delivered = [];
  for (let i = 0; i < 10; i++) {
    const result = await call("read_blackboard", auth);
    assert.ok(result.json);
    assert.ok(Buffer.byteLength(result.text) <= 96 * 1024);
    assert.ok(result.json.inbox.awaiting_ack.every((d) => typeof d.text === "string"));
    delivered.push(...(result.json.inbox.new ?? []).map((d) => d.id));
    if (!result.json.inbox.more) break;
  }
  assert.deepEqual(delivered, Array.from({ length: 50 }, (_, i) => `large-${i}`));
});

test("undeclared publications belong to the first publisher; needs validate actual and expected owner", async () => {
  const run = await runWith();
  const { j, ...a } = await join_(run, "ext-a");
  const { j: jb, ...b } = await join_(run, "ext-b");
  await ok("claim_task", { ...a, task_id: "api" });
  await ok("claim_task", { ...b, task_id: "build-nav-bar" });
  for (const topic of ["interface", "artifact"]) {
    const name = `Undeclared-${topic}`;
    await ok("post_update", { ...b, kind: "need", topic, name, owner: "build-nav-bar", text: "wait" });
    const pub = await ok("post_update", { ...a, kind: "interface", name, text: "first" });
    assert.deepEqual(pub.satisfied, [], "a different expected owner is not satisfied");
    assert.match((await call("post_update", { ...b, kind: "interface", name, text: "overwrite" })).text, /owned by task api/);
    assert.equal((await ok("post_update", { ...a, kind: "interface", name, text: "v2" })).version, 2);
    assert.equal((await ok("post_update", { ...b, kind: "need", topic, name, owner: "api", text: "use it" })).available, true);
  }
  await ok("post_update", { ...b, kind: "need", topic: "artifact", name: "NewDoc", text: "wait" });
  assert.deepEqual((await ok("post_update", { ...a, kind: "interface", name: "NewDoc", text: "doc" })).satisfied, ["build-nav-bar"]);
  await run.store.transact(() => ({ events: [{ type: "artifact.published", source: runner, payload: { name: "ExistingDoc", kind: "doc", task: "api" } }] }));
  assert.match((await call("post_update", { ...b, kind: "interface", name: "ExistingDoc", text: "replace doc" })).text, /owned by task api/);
  const race = await Promise.all([a, b].map((auth) => call("post_update", { ...auth, kind: "interface", name: "Race", text: "first" })));
  assert.equal(race.filter((r) => !r.isError).length, 1, "the transaction reserves the first publication");
  // A legacy publication by a different task cannot satisfy a declared interface.
  await run.store.transact(() => ({ events: [{ type: "artifact.published", source: runner, payload: { name: "ApiClient", kind: "interface", task: "build-nav-bar" } }] }));
  const need = await ok("post_update", { ...b, kind: "need", name: "ApiClient", text: "wait for owner" });
  assert.equal(need.available, undefined);
  assert.equal((await ok("post_update", { ...a, kind: "interface", name: "ApiClient", text: "correct publisher" })).satisfied.includes("build-nav-bar"), true);
});

test("post_update refuses paused and terminal progress, notes and publications", async () => {
  const run = await runWith();
  const { j, ...auth } = await join_(run, "ext-1");
  await ok("claim_task", { ...auth, task_id: "api" });
  for (const scope of [["api"], "all"]) {
    await run.store.transact(() => ({ events: [{ type: "execution.paused", source: runner, payload: { scope, reason: "hold" } }] }));
    for (const kind of ["progress", "note", "interface", "need"]) assert.match((await call("post_update", { ...auth, kind, name: "ApiClient", text: "paused" })).text, /paused/);
    await run.store.transact(() => ({ events: [{ type: "execution.resumed", source: runner, payload: { scope, reason: "go" } }] }));
  }
  for (const status of ["completed", "failed", "aborted"]) {
    const terminal = await runWith();
    const { j: jt, ...at } = await join_(terminal, "ext-1");
    await ok("claim_task", { ...at, task_id: "api" });
    await terminal.store.transact(() => ({ events: [{ type: `execution.${status}`, source: runner, payload: status === "completed" ? { integration_sha: terminal.header.base_sha } : { reason: "done" } }] }));
    for (const kind of ["progress", "note", "interface"]) assert.match((await call("post_update", { ...at, kind, name: "ApiClient", text: "late" })).text, new RegExp(status));
  }
});

// A check that reads src/api/flag.txt a second after it starts and passes only on "good".
const SLOW_FLAG = nodeCommand(
  "slow-flag",
  "setTimeout(() => { const s = require('fs').readFileSync('src/api/flag.txt', 'utf8').trim(); console.log('flag=' + s + ' cwd=' + process.cwd()); process.exit(s === 'good' ? 0 : 1); }, 1000)"
);

async function slowClaim() {
  const run = await makeRun({ contract: { tasks: [task("api", { checks: ["slow-flag"] })], validation: { commands: [SLOW_FLAG], final: [] } } });
  const ext = await join_(run, "ext-1", { task_id: "api" });
  const wt = ext.j.worktree;
  delete ext.j;
  await ok("claim_task", { ...ext, task_id: "api" });
  await ok("lease", { ...ext, action: "request", paths: ["src/api/**"] });
  return { run, ext, wt };
}

/** Start a ready submission, run `meanwhile` once its check has started, and return the submission's result. */
async function submitWhileChecking(run, ext, meanwhile) {
  const seq = (await run.store.state()).seq;
  const pending = call("submit_work", { ...ext, summary: "flag", ready: true });
  while (!(await eventsSince(run.store, seq, ["check.started"])).length) await new Promise((r) => setTimeout(r, 25));
  await meanwhile();
  return { r: await pending, seq };
}

test("submit_work checks the submitted commit in a private checkout, whatever the worker does to its worktree meanwhile", async () => {
  const { run, ext, wt } = await slowClaim();
  writeFileSync(join(wt, "src/api/flag.txt"), "bad\n");
  const { r, seq } = await submitWhileChecking(run, ext, async () => writeFileSync(join(wt, "src/api/flag.txt"), "good\n"));
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.checks_passed, false, "the committed bytes fail; the swapped ones are never checked");
  const [check] = r.json.checks;
  assert.match(check.output_tail, /flag=bad/);
  assert.equal(check.commit, r.json.commit);
  const checks = realpathSync(join(ROUNDTABLE_HOME, "executions", run.store.id, "checks"));
  const cwd = /cwd=(\S+)/.exec(check.output_tail)[1];
  assert.ok(cwd.startsWith(`${checks}/api-`), `checked in ${cwd}, not the worktree`);
  assert.deepEqual(readdirSync(checks), [], "the checkout is removed");
  assert.doesNotMatch(git(wt, "worktree", "list", "--porcelain"), /\/checks\//, "and so is its record");
  const evs = await eventsSince(run.store, seq, ["task.submitted", "check.started", "check.failed", "task.rejected"]);
  assert.deepEqual(evs.map((e) => e.type), ["task.submitted", "check.started", "check.failed", "task.rejected"]);
  for (const e of evs.slice(1, 3)) assert.deepEqual([e.payload.commit, e.payload.submitted_seq], [r.json.commit, evs[0].seq], e.type);

  const again = await ok("submit_work", { ...ext, summary: "flag good", ready: true });
  assert.notEqual(again.commit, r.json.commit);
  assert.equal(again.checks[0].status, "passed", "the swap passes once it is committed");
});

test("submit_work: one submission per task at a time; a newer submission, reassignment, new attempt or re-registration voids the outcome", async () => {
  const interfere = {
    "a newer failed submission": () => [
      { type: "task.submitted", source: runner, payload: { task: "api", commit: "f".repeat(40), diff_blob: "x", stat: "", files: [], rewrites: [] } },
      { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["check slow-flag failed"] } },
    ],
    "a reassignment": () => [{ type: "task.reassigned", source: runner, payload: { task: "api", from: "ext-1", to: "ext-2" } }],
    "a new attempt": () => [
      { type: "task.released", source: runner, payload: { task: "api", agent: "ext-1" } },
      { type: "task.claimed", source: runner, payload: { task: "api", agent: "ext-1", attempt: 2, ttl_s: 900 } },
    ],
    "a re-registration": () => [
      { type: "agent.registered", source: runner, payload: { agent: "ext-1", persona: "ext-1", driver: "external", external: true, token_sha256: "e".repeat(64) } },
    ],
  };
  for (const [what, events] of Object.entries(interfere)) {
    const { run, ext, wt } = await slowClaim();
    writeFileSync(join(wt, "src/api/flag.txt"), "good\n");
    const { r, seq } = await submitWhileChecking(run, ext, async () => {
      if (what === "a newer failed submission") {
        const twice = await call("submit_work", { ...ext, summary: "again", ready: true });
        assert.equal(twice.isError, true);
        assert.match(twice.text, /A submission of api is already in progress/);
      }
      await run.store.transact(() => ({ events: events() }));
    });
    assert.equal(r.isError, true, `${what}: ${r.text}`);
    assert.match(r.text, /is out of date: .*Nothing was recorded for it/, what);
    const after = await eventsSince(run.store, seq, ["check.passed", "task.checks_passed", "task.rejected"]);
    assert.equal(after.some((e) => e.type === "task.checks_passed"), false, what);
    assert.notEqual((await run.store.state()).tasks.api.state, "merging", what);
  }
});

test("post_update: publishing a task's last open need unblocks it; other needs and a blocking escalation keep it blocked", async () => {
  const run = await makeRun({
    contract: {
      tasks: [task("api"), task("ui"), task("build-nav-bar", { team: "web", paths: { write: ["src/components/nav/**"] } })],
      interfaces: [
        { name: "ApiClient", kind: "api", owner: "api", description: "HTTP client", consumers: ["build-nav-bar"] },
        { name: "Theme", kind: "type", owner: "ui", description: "colours", consumers: ["build-nav-bar"] },
        { name: "Icons", kind: "type", owner: "ui", description: "icon set", consumers: ["build-nav-bar"] },
      ],
    },
  });
  const tokenB = await registerWorker(run.store, "builder-1", "build-nav-bar", { team: "web" });
  const api = await join_(run, "ext-api", { task_id: "api" });
  const ui = await join_(run, "ext-ui", { task_id: "ui" });
  delete api.j;
  delete ui.j;
  await ok("claim_task", { ...api, task_id: "api" });
  await ok("claim_task", { ...ui, task_id: "ui" });
  W.bindWorkerIdentity({ store: await openExecutionStore(run.store.id), execution: run.store.id, agent: "builder-1", tokenSha256: tokenB.sha256 });
  const nav = async () => (await run.store.state()).tasks["build-nav-bar"];

  await ok("post_update", { kind: "need", name: "ApiClient", text: "need the client" }, "worker");
  await ok("post_update", { kind: "need", name: "Theme", text: "need the theme" }, "worker");
  assert.deepEqual((await nav()).blocked_by, { needs: [{ kind: "interface", ref: "ApiClient" }, { kind: "interface", ref: "Theme" }] });

  const first = await ok("post_update", { ...api, kind: "interface", name: "ApiClient", text: "export function get() {}" });
  assert.deepEqual([first.satisfied, first.unblocked], [["build-nav-bar"], undefined]);
  assert.deepEqual([(await nav()).state, (await nav()).blocked_by], ["blocked", { needs: [{ kind: "interface", ref: "Theme" }] }]);

  const seq = (await run.store.state()).seq;
  const last = await ok("post_update", { ...ui, kind: "interface", name: "Theme", text: "export const theme = {}" });
  assert.deepEqual([last.satisfied, last.unblocked], [["build-nav-bar"], ["build-nav-bar"]]);
  const evs = await eventsSince(run.store, seq, ["dependency.satisfied", "task.unblocked"]);
  assert.deepEqual(evs.map((e) => e.type), ["dependency.satisfied", "task.unblocked"]);
  assert.equal(evs[1].seq, evs[0].seq + 1, "in the same transaction");
  assert.equal((await nav()).state, "in_progress");
  assert.equal("blocked_by" in (await nav()), false);

  await ok("escalate", { kind: "blocker", with: "orchestrator", summary: "Which icon set?", blocking: true }, "worker");
  await ok("post_update", { kind: "need", name: "Icons", text: "need the icons" }, "worker");
  const escalation = (await nav()).blocked_by.escalation;
  assert.match(escalation, /^esc-/);
  const icons = await ok("post_update", { ...ui, kind: "interface", name: "Icons", text: "export const icons = []" });
  assert.deepEqual([icons.satisfied, icons.unblocked], [["build-nav-bar"], undefined]);
  assert.deepEqual([(await nav()).state, (await nav()).blocked_by], ["blocked", { escalation }], "the escalation still blocks it");
});
