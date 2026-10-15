import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRun, runner, task } from "../fixtures/workers/run.mjs";
import { git } from "../fixtures/execution/git-fixture.mjs";
import { cli, CLI, startRunner, waitFor } from "../fixtures/runner/harness.mjs";

const { ensureRunner, launchRunner, readRunnerInfo, runnerLiveness } = await import("../../dist/execution/runner-launch.js");
const { ensureIntegrationWorktree, ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { integrationBranch, taskBranch } = await import("../../dist/execution/git.js");
const { verifyAudit } = await import("../../dist/security/audit.js");
const { runRunner } = await import("../../dist/execution/runner.js");

const append = (store, type, payload) => store.transact(() => ({ events: [{ type, source: runner, payload }] }));

test("CLI dispatch: help, unknown commands, malformed and repeated flags", async () => {
  const help = await cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage:\n/);
  for (const args of [["unknown"], ["help", "extra"], ["run"], ["status", "bad"], ["watch"], ["hook", "bad"]]) {
    const r = await cli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /Usage:/);
  }
  const { store } = await makeRun();
  for (const args of [["status", store.id, "--json", "--json"], ["run", store.id, "--wat"], ["watch", store.id, "--as"], ["watch", store.id, "--as", "main", "--timeout-min", "NaN"], ["watch", store.id, "--as", "../bad"], ["purge", store.id]]) {
    assert.equal((await cli(args)).code, 2, args.join(" "));
  }
});

test("orchestrator entry points preserve umask; heads-down commands set 077", () => {
  const cliUrl = new URL("../../dist/cli.js", import.meta.url).href;
  for (const args of [[], ["mcp"], ["help"], ["status", "bad"], ["hook", "bad"]]) {
    const source = `process.umask(0o022); const {runCli} = await import(${JSON.stringify(cliUrl)}); await runCli(${JSON.stringify(args)}); console.error('MASK=' + process.umask().toString(8)); process.exit(0);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`MASK=${["status", "hook"].includes(args[0]) ? "77" : "22"}`));
  }
  // The actual binary without arguments still connects its stdio transport.
  const r = spawnSync(process.execPath, [CLI], { env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, input: "", encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown command/);
});

test("status --json and verify report good and tampered chains; corrupt startup emits nothing", async () => {
  const { store } = await makeRun();
  const s = await cli(["status", store.id, "--json"]);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(s.stdout);
  assert.equal(report.execution, store.id);
  assert.equal(report.status, "running");
  assert.equal(report.tasks.total, 2);
  assert.equal(report.budget.spent_usd, 0);
  assert.match((await cli(["status", store.id])).stdout, /Completion 0%/);
  assert.equal((await cli(["verify", store.id])).code, 0);
  const path = join(store.dir, "events.jsonl");
  writeFileSync(path, readFileSync(path, "utf8").replace('"confirmation":"go"', '"confirmation":"tampered"'));
  const before = readFileSync(path, "utf8");
  const bad = await cli(["verify", store.id]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /FAILED/);
  assert.equal(await runRunner(store.id), 1);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(join(store.dir, "runner.json")), false);
});

test("purge refuses active runs and missing confirmation, removes terminal worktrees and branches, and audits", async () => {
  const run = await makeRun({ contract: { tasks: [task("a")] } });
  assert.equal((await cli(["purge", run.store.id])).code, 2);
  assert.equal((await cli(["purge", run.store.id, "--confirm"])).code, 1);
  const integ = await ensureIntegrationWorktree(run.header);
  const wt = await ensureTaskWorktree(run.header, "a");
  await append(run.store, "execution.aborted", { reason: "test" });
  const result = await cli(["purge", run.store.id, "--confirm"]);
  assert.equal(result.code, 0, result.stderr);
  for (const path of [run.store.dir, integ.path, wt.path]) assert.equal(existsSync(path), false);
  for (const branch of [integrationBranch(run.store.id), taskBranch(run.store.id, "a")]) assert.equal(git(run.root, "branch", "--list", branch), "");
  assert.equal(git(run.root, "rev-parse", "main"), run.sha);
  assert.equal((await verifyAudit()).ok, true);
  const { readdirSync } = await import("node:fs");
  const auditDir = join(process.env.ROUNDTABLE_HOME, "audit");
  const entries = readdirSync(auditDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) => readFileSync(join(auditDir, n), "utf8").trim().split("\n").map(JSON.parse));
  assert.ok(entries.some((e) => e.action === "execution.purged" && e.target === run.store.id));
});

test("runner ownership: live holder refuses a second runner and purge, dead holder is taken over", { timeout: 30000 }, async (t) => {
  const { store } = await makeRun();
  await append(store, "execution.paused", { scope: "all", reason: "hold" });
  const first = startRunner(store.id);
  t.after(() => first.child.kill("SIGKILL"));
  await waitFor(async () => (await store.events()).some((e) => e.type === "runner.started"), 10000);
  assert.equal(runnerLiveness(store.id).state, "running");
  assert.equal((await ensureRunner(store.id)).pid, first.pid);
  const refused = await cli(["run", store.id]);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /Another runner/);
  await append(store, "execution.aborted", { reason: "terminal with live owner" });
  const purge = await cli(["purge", store.id, "--confirm"]);
  // The runner may already have stopped after observing the terminal event.
  if (existsSync(store.dir)) assert.equal(purge.code, 1, purge.stderr);
  first.child.kill("SIGKILL");
  await first.exited;
});

test("ensureRunner relaunches a dead owner and SIGTERM snapshots and releases ownership", { timeout: 20000 }, async (t) => {
  const { store } = await makeRun();
  await append(store, "execution.paused", { scope: "all", reason: "hold" });
  const first = startRunner(store.id);
  t.after(() => first.child.kill("SIGKILL"));
  await waitFor(async () => (await store.events()).some((e) => e.type === "runner.started"), 10000);
  first.child.kill("SIGKILL");
  await first.exited;
  assert.equal(runnerLiveness(store.id).state, "dead");
  const next = await ensureRunner(store.id, { env: { ROUNDTABLE_RUNNER_TICK_MS: "100" } });
  assert.equal(next.status, "launched");
  t.after(() => { try { process.kill(next.pid, "SIGKILL"); } catch {} });
  await waitFor(async () => (await store.events()).some((e) => e.type === "runner.takeover"), 10000);
  assert.equal(readRunnerInfo(store.id).pid, next.pid);
  process.kill(next.pid, "SIGTERM");
  await waitFor(() => readRunnerInfo(store.id)?.stoppedAt, 10000);
  assert.equal(existsSync(join(store.dir, "runner.lock")), false);
  const snap = JSON.parse(readFileSync(join(store.dir, "snapshot.json"), "utf8"));
  assert.equal(snap.seq, (await store.state()).seq);
  assert.equal((statSync(join(store.dir, "runner.log")).mode & 0o777), 0o600);
  await append(store, "execution.aborted", { reason: "done" });
  assert.equal((await ensureRunner(store.id)).status, "terminal");
});

test("launchRunner uses the repo cwd, detached argv, private log and runner environment", async () => {
  const { root, store } = await makeRun();
  const script = join(root, "runner-probe.mjs");
  const report = join(root, "probe.json");
  writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.WS08_PROBE}));`);
  const launched = launchRunner(store.id, { cliPath: script, env: { WS08_PROBE: "yes" } });
  assert.ok(launched.pid > 1);
  await waitFor(() => existsSync(report), 10000);
  assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { args: ["run", store.id], cwd: root, env: "yes" });
  assert.equal(statSync(launched.log).mode & 0o777, 0o600);
});
