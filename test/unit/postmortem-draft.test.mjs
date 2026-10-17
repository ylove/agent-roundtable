// Postmortem mode (WS14): projects, the opt-in, the running draft, the reducer's fix transitions and the
// runner's automatic findings. Everything runs against temp repositories and the test ROUNDTABLE_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepo } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, runner, task } from "../fixtures/workers/run.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { projectKeyOf, readProject, projectDir, loadDraft } = await import("../../dist/postmortem/store.js");
const { autoFindings } = await import("../../dist/postmortem/auto.js");
const { AUDIT_DIR } = await import("../../dist/config.js");
const { REDUCER_VERSION } = await import("../../dist/execution/blackboard.js");

const call = async (name, args) => handleToolCall(name, args);
const ok = async (name, args) => {
  const r = await call(name, args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const fails = async (name, args) => {
  const r = await call(name, args);
  assert.equal(r.isError, true, r.content[0].text);
  return r.content[0].text;
};
const pm = (args) => ok("postmortem", args);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const FINDING = { summary: "The nav bar ignored the mobile breakpoint", detected_by: "check unit", responsible: ["builder"], category: "implementation" };

async function enabled(repo = makeRepo(), reason = "Yes, please hold postmortem meetings for this project") {
  await pm({ action: "enable", project: repo.root, reason });
  return repo;
}

test("the reducer version is bumped by one from the 1.1.0 base", () => {
  assert.equal(REDUCER_VERSION, 6);
});

test("a project is keyed by the first 16 hex characters of sha256 of the real repository root", async () => {
  const repo = makeRepo({ "README.md": "readme\n", "src/index.js": "x\n" });
  const out = await pm({ action: "enable", project: join(repo.root, "."), reason: "retrospectives, please" });
  assert.equal(out.project, sha(realpathSync(repo.root)).slice(0, 16));
  assert.equal(out.project, projectKeyOf(realpathSync(repo.root)));
  // A subdirectory resolves to the same top level; a project_key names it too.
  assert.equal((await pm({ action: "list", project: join(repo.root, "src") })).project, out.project);
  assert.equal((await pm({ action: "list", project: out.project })).project, out.project);
});

test("a directory outside a git work tree, an unknown key and a repository with submodules are refused", async () => {
  const plain = mkdtempSync(join(tmpdir(), "rt-pm-plain-"));
  assert.match(await fails("postmortem", { action: "enable", project: plain, reason: "yes" }), /neither a known project_key nor a directory inside a git work tree/);
  assert.match(await fails("postmortem", { action: "list", project: "0123456789abcdef" }), /neither a known project_key/);
  const repo = makeRepo();
  git(repo.root, "update-index", "--add", "--cacheinfo", `160000,${repo.sha},vendor/lib`);
  git(repo.root, "commit", "-q", "-m", "add a submodule");
  assert.match(await fails("postmortem", { action: "enable", project: repo.root, reason: "yes" }), /submodules/);
});

test("enable stores the project privately, keeps only a hash of the human's words in project.json and audits them", async () => {
  const repo = makeRepo();
  const words = "Let's have a retrospective after the work. My key is tk_Abcdefghij0123456789";
  const out = await pm({ action: "enable", project: repo.root, reason: words });
  assert.equal(out.postmortem_mode, "on");
  const dir = projectDir(out.project);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "project.json")).mode & 0o777, 0o600);
  const file = readProject(out.project);
  assert.equal(file.repo_root, realpathSync(repo.root));
  assert.equal(file.postmortem.enabled, true);
  assert.match(file.postmortem.reason_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!readFileSync(join(dir, "project.json"), "utf8").includes("retrospective"), "the words are not in project.json");
  const log = readFileSync(join(dir, "log.jsonl"), "utf8");
  assert.match(log, /retrospective after the work/);
  assert.ok(!log.includes("tk_Abcdefghij"), "the log is scrubbed");
  const audit = readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), "utf8")).join("\n");
  assert.match(audit, /"action":"postmortem.enabled"/);
  assert.ok(!audit.includes("tk_Abcdefghij"));
  assert.match(await fails("postmortem", { action: "enable", project: repo.root }), /"reason" is required/);
  const off = await pm({ action: "disable", project: repo.root, reason: "no more postmortems" });
  assert.equal(off.postmortem_mode, "off");
  assert.match(await fails("postmortem", { action: "record", project: repo.root, work: "w", finding: FINDING }), /Postmortem mode is off/);
});

test("record keeps one draft per scope, scrubs every field and takes refs as evidence only", async () => {
  const repo = await enabled();
  const out = await pm({
    action: "record", project: repo.root, work: "checkout redesign",
    finding: { ...FINDING, summary: "The cart lost items; token tk_Abcdefghij0123456789 leaked in the log", evidence: ["src/cart.js", "abc1234", `sha256:${"a".repeat(64)}`] },
  });
  assert.match(out.recorded, /^pmf-/);
  assert.ok(!JSON.stringify(out).includes("tk_Abcdefghij"));
  assert.equal(out.ready, false);
  assert.deepEqual(out.pending_fixes, [out.recorded]);
  const second = await pm({ action: "record", project: repo.root, work: "Checkout Redesign", finding: { ...FINDING, summary: "A second thing", responsible: ["Builder", "orchestrator"], category: "test_gap" } });
  assert.equal(second.pm, out.pm, "the same scope shares one open draft");
  assert.deepEqual(second.findings[1].responsible, ["builder", "orchestrator"]);
  assert.equal((await pm({ action: "record", project: repo.root, work: "login", finding: FINDING })).pm !== out.pm, true);
  assert.match(await fails("postmortem", { action: "record", project: repo.root, work: "w", finding: { ...FINDING, evidence: ["FAIL src/a.test.js\nexpected 1 got 2"] } }), /refs only/);
  assert.match(await fails("postmortem", { action: "record", project: repo.root, work: "w", finding: { ...FINDING, summary: "x".repeat(601) } }), /summary/);
  assert.match(await fails("postmortem", { action: "record", project: repo.root, finding: FINDING }), /exactly one of execution_id/);
  assert.match(await fails("postmortem", { action: "record", project: repo.root, work: "w", execution_id: "exe-0123456789abcdef", finding: FINDING }), /exactly one of execution_id|execution_id/);
  const draftFile = loadDraft(second.project, out.pm);
  assert.equal(draftFile.findings.length, 2);
  assert.ok(!JSON.stringify(draftFile).includes("tk_Abcdefghij"));
});

test("fix updates a finding's fix; the draft is ready once nothing is pending", async () => {
  const repo = await enabled();
  const a = await pm({ action: "record", project: repo.root, work: "w1", finding: FINDING });
  const b = await pm({ action: "record", project: repo.root, work: "w1", finding: { ...FINDING, summary: "another" } });
  assert.equal(b.ready, false);
  await pm({ action: "fix", project: repo.root, work: "w1", finding_id: a.recorded, fix: { status: "fixed", by: "builder", ref: "abc1234" } });
  const done = await pm({ action: "fix", project: repo.root, work: "w1", finding_id: b.recorded, fix: { status: "abandoned" } });
  assert.equal(done.ready, true);
  assert.deepEqual(done.findings.map((f) => f.fix.status), ["fixed", "abandoned"]);
  assert.equal(done.findings[0].fix.by, "builder");
  assert.match(await fails("postmortem", { action: "fix", project: repo.root, work: "w1", finding_id: "pmf-nope", fix: { status: "fixed" } }), /not a finding/);
  assert.match(await fails("postmortem", { action: "fix", project: repo.root, work: "w1", finding_id: a.recorded, fix: { status: "fixed", ref: "FAIL: output text" } }), /ref only/);
  const listed = await pm({ action: "list", project: repo.root });
  assert.equal(listed.drafts.length >= 1, true);
});

test("an execution's findings live in its event log and the draft is rebuilt from them", async () => {
  const run = await makeRun({ contract: { postmortem: { enabled: true } } });
  await enabled(run);
  const out = await pm({ action: "record", project: run.root, execution_id: run.store.id, finding: { ...FINDING, task: "api", evidence: ["evt-0123abcd"] } });
  const events = await run.store.events({ types: ["postmortem.finding_recorded"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.id, out.recorded);
  assert.equal(events[0].payload.task, "api");
  // A fresh store (replay from the log) holds the same draft.
  const again = await openExecutionStore(run.store.id);
  const state = await again.state();
  assert.deepEqual(Object.keys(state.postmortem.findings), [out.recorded]);
  const draft = await pm({ action: "draft", project: run.root, execution_id: run.store.id });
  assert.equal(draft.findings[0].id, out.recorded);
  assert.deepEqual(draft.tasks_in_flight, ["api"], "the task with a finding has not finished");
  assert.equal(draft.ready, false);
  assert.match(await fails("postmortem", { action: "record", project: run.root, execution_id: run.store.id, finding: { ...FINDING, task: "nope" } }), /not a task of/);
  const other = makeRepo();
  await enabled(other);
  assert.match(await fails("postmortem", { action: "record", project: other.root, execution_id: run.store.id, finding: FINDING }), /belongs to another repository/);
});

test("retries, merges, failures and passing integration checks settle fixes in the reducer; ready_seq marks the moment", async () => {
  const run = await makeRun({
    contract: { postmortem: { enabled: true }, tasks: [task("api"), task("ui"), task("docs")] },
  });
  await enabled(run);
  const rec = async (taskId, extra = {}) => (await pm({ action: "record", project: run.root, execution_id: run.store.id, finding: { ...FINDING, task: taskId, ...extra } })).recorded;
  const fApi = await rec("api");
  const fUi = await rec("ui");
  const fDocs = await rec("docs");
  const fInt = await rec(undefined, { task: undefined, detected_by: "integration check build" });
  let state = await run.store.state();
  assert.equal(state.postmortem.ready_seq, undefined);
  await run.store.transact(() => ({
    events: [
      { type: "task.retried", source: runner, payload: { task: "api", attempt: 2, why: "checks failed" } },
      { type: "task.reassigned", source: runner, payload: { task: "ui", from: "a1", to: "agent-2" } },
    ],
  }));
  state = await run.store.state();
  assert.deepEqual(state.postmortem.findings[fApi].fix, { by: "builder", status: "pending" });
  assert.deepEqual(state.postmortem.findings[fUi].fix, { by: "agent-2", status: "pending" });
  await run.store.transact(() => ({
    events: [
      { type: "task.merged", source: runner, payload: { task: "api", integration_sha: "a".repeat(40) } },
      { type: "task.failed", source: runner, payload: { task: "docs", why: "gave up" } },
    ],
  }));
  state = await run.store.state();
  assert.deepEqual(state.postmortem.findings[fApi].fix, { by: "builder", status: "fixed", ref: "a".repeat(40) });
  assert.equal(state.postmortem.findings[fDocs].fix.status, "abandoned");
  assert.equal(state.postmortem.ready_seq, undefined, "ui and the integration finding are still pending");
  await run.store.transact(() => ({ events: [{ type: "task.merged", source: runner, payload: { task: "ui", integration_sha: "b".repeat(40) } }] }));
  assert.equal((await run.store.state()).postmortem.ready_seq, undefined, "the integration finding is pending");
  const [passed] = (await run.store.transact(() => ({ events: [{ type: "check.passed", source: runner, payload: { command_id: "build", scope: "integration", duration_ms: 5 } }] }))).events;
  state = await run.store.state();
  assert.equal(state.postmortem.findings[fInt].fix.status, "fixed");
  assert.equal(state.postmortem.ready_seq, passed.seq, "the event that settled the last fix");
  // A new finding takes the draft out of ready again.
  await rec("api", { summary: "again" });
  assert.equal((await run.store.state()).postmortem.ready_seq, undefined);
});

test("a task that is not accepted, failed or cancelled keeps the draft from its meeting even when its fix is settled by hand", async () => {
  const run = await makeRun({ contract: { postmortem: { enabled: true } } });
  await enabled(run);
  const id = (await pm({ action: "record", project: run.root, execution_id: run.store.id, finding: { ...FINDING, task: "api" } })).recorded;
  const out = await pm({ action: "fix", project: run.root, execution_id: run.store.id, finding_id: id, fix: { status: "fixed", by: "main" } });
  assert.equal(out.ready, false);
  assert.deepEqual(out.tasks_in_flight, ["api"]);
});

// ---------------------------------------------------------------------------
// Automatic findings
// ---------------------------------------------------------------------------

async function submitted(run, taskId, { diff = taskId } = {}) {
  const blob = await run.store.putBlob(`diff for ${diff}`);
  return { type: "task.submitted", source: runner, payload: { task: taskId, commit: "c".repeat(40), diff_blob: blob, stat: "1 file changed", files: [`src/${taskId}/index.js`], rewrites: [] } };
}

test("the runner's pass records one finding per submission sent back, from the event and never from command output", async () => {
  const run = await makeRun({ contract: { postmortem: { enabled: true }, tasks: [task("api")] } });
  const out = await run.store.putBlob("FAIL src/api.test.js: expected 1 got 2 (SECRET-OUTPUT-MARKER)");
  const claim = { type: "task.claimed", source: runner, payload: { task: "api", agent: "w1", attempt: 1, ttl_s: 0 } };
  const failed = (sig) => ({ type: "check.failed", source: runner, payload: { command_id: "unit", scope: "task", task: "api", exit: 1, signature: sig, output_blob: out } });
  await run.store.transact(async () => ({ events: [claim, await submitted(run, "api"), failed("1".repeat(16)), { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["check unit failed: SECRET-OUTPUT-MARKER"] } }] }));
  const log = await run.store.events();
  const state = await run.store.state();
  const drafts = autoFindings(log, state, 0, runner);
  assert.equal(drafts.length, 1);
  const p = drafts[0].payload;
  assert.match(p.id, /^pmf-[0-9a-f]{12}$/);
  assert.equal(p.task, "api");
  assert.deepEqual(p.responsible, ["builder"]);
  assert.equal(p.category, "implementation");
  assert.equal(p.detected_by, "check unit");
  assert.match(p.summary, /Task api was sent back after testing: check unit failed/);
  assert.ok(!JSON.stringify(drafts).includes("SECRET-OUTPUT-MARKER"), "no command output in the finding");
  assert.equal(p.evidence.length, 2);
  assert.match(p.evidence[0], /^evt-/);
  assert.equal(p.evidence[1], out);
  assert.equal(drafts[0].causation, p.evidence[0]);
  // Committed, a second scan over the same log adds nothing (idempotent after a restart).
  await run.store.transact(() => ({ events: drafts }));
  assert.deepEqual(autoFindings(await run.store.events(), await run.store.state(), 0, runner), []);
  // The same failure again for the same task is a repeat of the same finding, not a new one.
  await run.store.transact(async () => ({ events: [await submitted(run, "api", { diff: "2" }), failed("1".repeat(16)), { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["again"] } }] }));
  const repeat = autoFindings(await run.store.events(), await run.store.state(), 0, runner);
  assert.equal(repeat.length, 1);
  assert.equal(repeat[0].payload.id, p.id);
  assert.equal(repeat[0].payload.repeats, 1);
  await run.store.transact(() => ({ events: repeat }));
  const after = await run.store.state();
  assert.equal(Object.keys(after.postmortem.findings).length, 1);
  assert.equal(after.postmortem.findings[p.id].repeats, 1);
  // A different signature is a different finding.
  await run.store.transact(async () => ({ events: [await submitted(run, "api", { diff: "3" }), failed("2".repeat(16)), { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["other"] } }] }));
  assert.equal(autoFindings(await run.store.events(), await run.store.state(), 0, runner).length, 1);
});

test("lease violations, conflicts and integration failures after a merge", async () => {
  const run = await makeRun({ contract: { postmortem: { enabled: true }, tasks: [task("api"), task("ui")] } });
  await run.store.transact(async () => ({
    events: [
      { type: "task.claimed", source: runner, payload: { task: "api", agent: "w1", attempt: 1, ttl_s: 0 } },
      await submitted(run, "api"),
      // A rejection that only asks the worker to resolve a merge conflict is not a test failure.
      { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["Merge conflicts to resolve: a.js"] } },
      await submitted(run, "api", { diff: "2" }),
      { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["Changes outside the task's leases cannot be merged: x"], violations: ["x/y.js", "z.js"] } },
    ],
  }));
  let drafts = autoFindings(await run.store.events(), await run.store.state(), 0, runner);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].payload.category, "process");
  assert.equal(drafts[0].payload.detected_by, "lease check");
  assert.match(drafts[0].payload.summary, /2 paths changed outside its leases/);
  assert.ok(!drafts[0].payload.summary.includes("x/y.js"));
  await run.store.transact(() => ({ events: drafts }));
  await run.store.transact(() => ({
    events: [
      { type: "task.merged", source: runner, payload: { task: "api", integration_sha: "d".repeat(40) } },
      { type: "check.failed", source: runner, payload: { command_id: "build", scope: "integration", exit: 1, signature: "9".repeat(16) } },
    ],
  }));
  drafts = autoFindings(await run.store.events(), await run.store.state(), 0, runner);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].payload.detected_by, "integration check build");
  assert.equal(drafts[0].payload.category, "test_gap");
  assert.deepEqual(drafts[0].payload.responsible, ["builder"]);
  assert.equal(drafts[0].payload.task, undefined);
});

test("automatic findings need the contract's postmortem flag", async () => {
  const run = await makeRun({ contract: { tasks: [task("api")] } });
  await run.store.transact(async () => ({
    events: [
      { type: "task.claimed", source: runner, payload: { task: "api", agent: "w1", attempt: 1, ttl_s: 0 } },
      await submitted(run, "api"),
      { type: "check.failed", source: runner, payload: { command_id: "unit", scope: "task", task: "api", exit: 1, signature: "1".repeat(16) } },
      { type: "task.rejected", source: runner, payload: { task: "api", reasons: ["failed"] } },
    ],
  }));
  assert.deepEqual(autoFindings(await run.store.events(), await run.store.state(), 0, runner), []);
});

test("the new events reject unknown fields and scrub free text", async () => {
  const run = await makeRun({});
  const bad = await run.store.transact(() => ({ events: [{ type: "postmortem.fix_updated", source: runner, payload: { id: "pmf-x", status: "done" } }] })).catch((e) => e);
  assert.match(String(bad.message), /status/);
  const extra = await run.store.transact(() => ({ events: [{ type: "postmortem.started", source: runner, payload: { id: "pm-x", format: "collaborate", seats: ["a"], extra: 1 } }] })).catch((e) => e);
  assert.match(String(extra.message), /not a known field/);
  const [e] = (await run.store.transact(() => ({
    events: [{ type: "postmortem.finding_recorded", source: runner, payload: { id: "pmf-1", summary: "key tk_Abcdefghij0123456789", detected_by: "t", responsible: ["a"], category: "process" } }],
  }))).events;
  assert.ok(!e.payload.summary.includes("tk_Abcdefghij"));
});

test("files are private and the draft survives as JSON a reader can parse", async () => {
  const repo = await enabled();
  const out = await pm({ action: "record", project: repo.root, work: "perms", finding: FINDING });
  const key = out.project;
  const draftPath = join(projectDir(key), "postmortems", "drafts", `${out.pm}.json`);
  assert.equal(statSync(draftPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(projectDir(key), "postmortems", "drafts")).mode & 0o777, 0o700);
  assert.ok(existsSync(draftPath));
  writeFileSync(join(repo.root, "touch"), "x");
});

test("the runner's tick records the finding for a submission testing sent back, once, and the fix settles when the task merges", async (t) => {
  const { Runner } = await import("../../dist/execution/runner.js");
  const { waitFor } = await import("../fixtures/runner/harness.mjs");
  const { scriptedDriver, sandbox } = await import("../fixtures/runner/driver.mjs");
  const run = await makeRun({ contract: { postmortem: { enabled: true }, tasks: [task("a")] } });
  const r = new Runner(run.store.id, { drivers: { "claude-code": scriptedDriver(t) }, sandbox: sandbox(), lockTimeoutMs: 10, tickMs: 10 });
  await r.start();
  t.after(async () => { r.stop("test cleanup"); await r.run(); });
  await r.tick();
  const blob = await run.store.putBlob("diff");
  await run.store.transact(() => ({
    events: [
      { type: "task.submitted", source: runner, payload: { task: "a", commit: "c".repeat(40), diff_blob: blob, stat: "1 file changed", files: ["src/a/a.txt"], rewrites: [] } },
      { type: "check.failed", source: runner, payload: { command_id: "unit", scope: "task", task: "a", exit: 1, signature: "7".repeat(16) } },
      { type: "task.rejected", source: runner, payload: { task: "a", reasons: ["check unit failed"] } },
    ],
  }));
  await waitFor(async () => { await r.tick(); return Object.keys((await run.store.state()).postmortem.findings).length === 1; }, 10000, "the runner's finding");
  await r.tick();
  await r.tick();
  const state = await run.store.state();
  const [f] = Object.values(state.postmortem.findings);
  assert.equal(f.task, "a");
  assert.equal(f.fix.status, "pending");
  assert.equal((await run.store.events({ types: ["postmortem.finding_recorded"] })).length, 1, "recorded once");
  await run.store.transact(() => ({ events: [{ type: "task.merged", source: runner, payload: { task: "a", integration_sha: "e".repeat(40) } }] }));
  const after = await run.store.state();
  assert.equal(after.postmortem.findings[f.id].fix.status, "fixed");
  assert.equal(typeof after.postmortem.ready_seq, "number");
});
