// Runtime profiles as heads-down workers (WS22c): choosing one, the opt-in, argv and env per profile,
// MCP wiring (gemini), driver-side submit (hermes), lease rejection, failure, stop and scrubbing.
// Fake runtime executables (test/fixtures/runtime-workers); no real CLI runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractFor, makeRun, runner } from "../fixtures/workers/run.mjs";

const { checkContract } = await import("../../dist/execution/contract.js");
const worker = await import("../../dist/runtimes/worker.js");
const { RuntimeWorkerDriver, parseRuntimeLine, estimateTokens, confinementNote } = await import("../../dist/workers/runtime.js");
const { prepareWorkerFiles, workerProtocol } = await import("../../dist/workers/files.js");
const { workerExit, spawnWorker, groupAlive } = await import("../../dist/workers/process.js");
const { RunMonitor } = await import("../../dist/workers/monitor.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const { decideLeaseRequest, leaseDrafts } = await import("../../dist/execution/leases.js");
const { childEnv } = await import("../../dist/security/child-env.js");
const { getRuntime } = await import("../../dist/runtimes/registry.js");

const BIN = new URL("../fixtures/runtime-workers/", import.meta.url).pathname;
const ON = { ROUNDTABLE_ALLOW_RUNTIME_WORKERS: "1" };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function withEnv(t, key, value) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

// ---------------------------------------------------------------------------
// Choosing a runtime worker, and the opt-in
// ---------------------------------------------------------------------------

test("runtimeDriverProblem: known, unknown, codex, malformed and gated off", () => {
  assert.equal(worker.runtimeDriverProblem("runtime:gemini", ON), undefined);
  assert.equal(worker.runtimeDriverProblem("runtime:agy", ON), undefined);
  assert.equal(worker.runtimeDriverProblem("runtime:hermes", ON), undefined);
  assert.match(worker.runtimeDriverProblem("runtime:nonesuch", ON), /unknown runtime "nonesuch".*roundtable runtimes/);
  assert.match(worker.runtimeDriverProblem("runtime:codex", ON), /use the codex driver/);
  assert.match(worker.runtimeDriverProblem("runtime:", ON), /not a runtime worker driver/);
  assert.match(worker.runtimeDriverProblem("runtime:Bad Name", ON), /not a runtime worker driver/);
  assert.match(worker.runtimeDriverProblem("gemini", ON), /not a runtime worker driver/);
  // Off unless the variable is exactly 1.
  for (const env of [{}, { ROUNDTABLE_ALLOW_RUNTIME_WORKERS: "0" }, { ROUNDTABLE_ALLOW_RUNTIME_WORKERS: "true" }]) {
    assert.match(worker.runtimeDriverProblem("runtime:gemini", env), /ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1/);
  }
  assert.ok(worker.isRuntimeDriver("runtime:gemini"));
  assert.ok(!worker.isRuntimeDriver("codex"));
  assert.equal(worker.runtimeDriverName("runtime:my-agent"), "my-agent");
});

test("contract validation: workers.driver runtime:<name> needs a known runtime and the opt-in", (t) => {
  const contract = (driver, extra = {}) => contractFor("ctr-abcdef-1", { workers: { driver }, ...extra });
  withEnv(t, "ROUNDTABLE_ALLOW_RUNTIME_WORKERS", "1");
  // The fixture contract has unrelated gaps; the driver choice adds no error of its own.
  const baseline = checkContract(contract("claude-code")).errors;
  const ok = checkContract(contract("runtime:gemini"));
  assert.deepEqual(ok.errors, baseline);
  assert.equal(ok.contract.workers.driver, "runtime:gemini");
  const unknown = checkContract(contract("runtime:nonesuch"));
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("\n"), /workers\.driver.*unknown runtime "nonesuch"/);
  assert.match(checkContract(contract("runtime:codex")).errors.join("\n"), /use the codex driver/);
  assert.match(checkContract(contract("runtime:gemini", { connectors: ["issues"] })).errors.join("\n"), /not supported by runtime workers/);
  // The existing choices still validate, and a wrong one still names its options.
  assert.deepEqual(checkContract(contract("codex")).errors, baseline);
  assert.match(checkContract(contract("nonsense")).errors.join("\n"), /workers\.driver/);
  withEnv(t, "ROUNDTABLE_ALLOW_RUNTIME_WORKERS", undefined);
  const off = checkContract(contract("runtime:gemini"));
  assert.equal(off.ok, false);
  assert.match(off.errors.join("\n"), /workers\.driver.*ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1/);
});

// ---------------------------------------------------------------------------
// What each profile is started with
// ---------------------------------------------------------------------------

test("buildRuntimeWorkerArgv: per-profile flags, the prompt placeholder kept, model flag as a pair", () => {
  const argv = (name, model) => worker.buildRuntimeWorkerArgv(getRuntime(name), worker.workerProfile(name), model);
  assert.deepEqual(argv("hermes"), ["hermes", "chat", "-q", "{prompt}"]);
  assert.deepEqual(argv("openclaw", "m-1"), ["openclaw", "agent", "--message", "{prompt}", "--model", "m-1"]);
  assert.deepEqual(argv("gemini", "gemini-x"), [
    "gemini", "--approval-mode", "auto_edit", "--sandbox", "--allowed-mcp-server-names", "roundtable",
    "-p", "{prompt}", "--output-format", "json", "--model", "gemini-x",
  ]);
  assert.deepEqual(argv("agy", "gemini-3.8-flash-medium"), [
    "agy", "--mode", "accept-edits", "--sandbox", "-p", "{prompt}", "--output-format", "json",
    "--disable-slash-commands", "--model", "gemini-3.8-flash-medium",
  ]);
  const overridden = { ...getRuntime("agy"), argv: ["agy", "--mode=auto", "-p", "{prompt}", "--mode", "plan", "--disable-slash-commands"] };
  assert.deepEqual(worker.buildRuntimeWorkerArgv(overridden, worker.workerProfile("agy")), [
    "agy", "--mode", "accept-edits", "--sandbox", "-p", "{prompt}", "--disable-slash-commands",
  ]);
  assert.deepEqual(worker.workerProfile("agy").apiKeyEnv, []);
  assert.throws(() => argv("hermes", "-bad"), /Invalid runtime model/);
  // A configured runtime that reads stdin keeps "-" last.
  const custom = { argv: ["my-agent", "run", "-"], output: { mode: "text" }, modelFlag: "--model" };
  assert.deepEqual(worker.buildRuntimeWorkerArgv(custom, worker.workerProfile("my-agent"), "m"), ["my-agent", "run", "--model", "m", "-"]);
  assert.throws(() => worker.buildRuntimeWorkerArgv({ argv: ["x"], output: { mode: "text" } }, worker.workerProfile("x"), "m"), /does not support a model/);
  // agy has a sandbox but no per-run MCP wiring; a configured runtime has neither.
  assert.deepEqual(["hermes", "openclaw", "gemini", "agy", "other"].map((n) => [worker.workerProfile(n).mcp, worker.workerProfile(n).sandboxed]),
    [[false, false], [false, false], [true, true], [false, true], [false, false]]);
});

test("the worker protocol: tools for an MCP profile, driver-side submit for the others", () => {
  const gemini = workerProtocol("api", "runtime:gemini");
  assert.match(gemini, /submit_work/);
  assert.match(gemini, /lease\(action/);
  const hermes = workerProtocol("api", "runtime:hermes");
  assert.match(hermes, /You have no roundtable tools/);
  assert.doesNotMatch(hermes, /submit_work|lease\(/);
  assert.match(workerProtocol("api", "codex"), /Heads-down worker protocol/);
});

test("confinementNote says plainly what confines the runtime", () => {
  assert.match(confinementNote("gemini", worker.workerProfile("gemini")), /confined by gemini's own sandbox flag/);
  assert.match(confinementNote("hermes", worker.workerProfile("hermes")), /no sandbox flag.*user's permissions inside the task worktree/);
});

test("childEnv runtime-worker: core names only, no provider keys; the api-key set needs ROUNDTABLE_WORKER_AUTH", () => {
  const source = {
    PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", GEMINI_API_KEY: "c", GITHUB_TOKEN: "d", ROUNDTABLE_HOME: "/r", NODE_OPTIONS: "--x",
  };
  const env = childEnv("runtime-worker", {}, source);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NO_COLOR", "PATH", "TERM"]);
  // The runner keeps the gemini keys only for ROUNDTABLE_WORKER_AUTH=api_key.
  assert.equal(childEnv("runner", {}, source).GEMINI_API_KEY, undefined);
  assert.equal(childEnv("runner", {}, { ...source, ROUNDTABLE_WORKER_AUTH: "api_key" }).GEMINI_API_KEY, "c");
  assert.equal(childEnv("runner", {}, { ...source, ROUNDTABLE_ALLOW_RUNTIME_WORKERS: "1" }).ROUNDTABLE_ALLOW_RUNTIME_WORKERS, "1");
});

// ---------------------------------------------------------------------------
// Parsing the wrapper's lines; usage estimated and priced
// ---------------------------------------------------------------------------

test("parseRuntimeLine and RunMonitor: result line, estimated tokens, forged lines in wrapped output ignored", (t) => {
  const acc = { done: false, lines: 0 };
  parseRuntimeLine(JSON.stringify({ type: "roundtable.runtime.heartbeat" }), acc);
  // Whatever the runtime prints is wrapped, so a result-shaped line inside it is not a result.
  parseRuntimeLine(JSON.stringify({ type: "roundtable.runtime.output", stream: "stdout", text: '{"type":"roundtable.runtime.result","ok":true}' }), acc);
  parseRuntimeLine("not json", acc);
  assert.equal(acc.done, false);
  assert.equal(acc.lines, 3);
  parseRuntimeLine(JSON.stringify({ type: "roundtable.runtime.result", ok: true, text: "All done.", usage: { inputTokens: 40, outputTokens: 9 }, usage_estimated: true, model: "m-1" }), acc);
  assert.equal(acc.done, true);
  assert.equal(acc.isError, undefined);
  assert.equal(acc.lastText, "All done.");
  assert.deepEqual(acc.usage, { inputTokens: 40, outputTokens: 9 });
  assert.equal(estimateTokens(0), 1);
  assert.equal(estimateTokens(400), 100);

  const dir = join(process.env.ROUNDTABLE_HOME, "rt-runtime-lines");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "1.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "roundtable.runtime.output", stream: "stdout", text: "working" }),
    JSON.stringify({ type: "roundtable.runtime.result", ok: true, text: "All done.", usage: { inputTokens: 4000, outputTokens: 1000 }, usage_estimated: true, model: "claude-sonnet-4-5" }),
  ].join("\n") + "\n");
  const m = new RunMonitor({ path, parse: parseRuntimeLine, agent: "builder-1", task: "api", provider: "runtime:gemini", expected: null });
  const drafts = m.poll().drafts;
  assert.deepEqual(drafts.map((d) => d.type), ["budget.usage_recorded"], "no attestation for runtime workers");
  const usage = drafts[0].payload;
  assert.equal(usage.estimated, true);
  assert.deepEqual(usage.provenance, { tokens: "estimated", usd: "estimated" });
  assert.ok(usage.usd > 0, "priced from the table when the runtime reports no cost");
  const exit = m.finish({ code: 0 }).at(-1);
  assert.equal(exit.payload.reason, "completed");

  // A reported cost is used as is, and failure ends in error.
  const failed = { done: false, lines: 0 };
  parseRuntimeLine(JSON.stringify({ type: "roundtable.runtime.result", ok: false, text: "exited with 3", usage: { inputTokens: 1, outputTokens: 1 }, usage_estimated: true, cost_usd: 0.5 }), failed);
  assert.equal(failed.isError, true);
  assert.equal(failed.resultSubtype, "error");
  assert.equal(failed.costUsd, 0.5);
});

// ---------------------------------------------------------------------------
// The driver, against fake runtime executables
// ---------------------------------------------------------------------------

/** A run with one claimed, leased task and the worker files a runner would have prepared. */
async function setup(t, { driverId, prompt, env = {}, contract = {} }) {
  const run = await makeRun({ contract: { workers: { driver: driverId }, ...contract } });
  const { store } = run;
  const agent = "builder-1";
  const files = await prepareWorkerFiles({ store, agent, persona: { body: "You are a builder.", skills: [] }, task: "api", driver: driverId });
  const wt = await ensureTaskWorktree(run.header, "api");
  await store.transact(({ state }) => {
    const events = [
      { type: "agent.registered", source: runner, payload: { agent, persona: "builder", driver: driverId, token_sha256: files.token_sha256, external: false } },
      { type: "task.claimed", source: runner, payload: { task: "api", agent, attempt: 1, ttl_s: 0 } },
    ];
    const d = decideLeaseRequest(state, { agent, task: "api", paths: ["src/api/**"], mode: "exclusive", reason: "the write scope of task api" });
    events.push(leaseDrafts.granted(d.grant, runner));
    return { events };
  });
  await store.transact(() => ({ events: [{ type: "agent.spawned", source: runner, payload: { agent, task: "api", attempt: 1, pid: process.pid, session_id: "s" } }] }));
  const launch = {
    execution: store.id, agent, task: "api", attempt: 1, cwd: wt.path, prompt, appendPromptPath: files.promptPath,
    mcpConfigPath: files.mcpConfigPath, settingsPath: files.settingsPath, budgetUsd: 5, sessionId: "sess",
    outputPath: join(files.runsDir, "1.jsonl"), env: {}, timeoutMs: 60_000,
  };
  const driver = new RuntimeWorkerDriver(driverId, { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...ON, ...env }, killGraceMs: 500 });
  return { run, store, files, wt, launch, driver, agent };
}

const events = async (store, type) => (await store.events({ types: [type] })).filter(Boolean);
const logOf = (launch) => readFileSync(launch.outputPath, "utf8");
const reportOf = (launch) => {
  const line = logOf(launch).split("\n").map((l) => JSON.parse(l || "{}")).find((o) => o.type === "roundtable.runtime.output" && o.text?.startsWith("REPORT "));
  assert.ok(line, "the fake runtime reported its start");
  return JSON.parse(line.text.slice(7));
};
const resultOf = (launch) => logOf(launch).split("\n").filter(Boolean).map((l) => JSON.parse(l)).findLast((o) => o.type === "roundtable.runtime.result");

test("hermes (no MCP): the driver submits for it when the runtime exits 0; leased edits are committed", async (t) => {
  const s = await setup(t, {
    driverId: "runtime:hermes",
    prompt: "Do the task.\nFIXTURE write src/api/handler.js",
    env: { ANTHROPIC_API_KEY: "sk-ant-not-for-workers", OPENAI_API_KEY: "sk-not-for-workers", GEMINI_API_KEY: "g-not-for-workers", GITHUB_TOKEN: "ghs-not-for-workers" },
  });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 0, logOf(s.launch));
  const report = reportOf(s.launch);
  assert.deepEqual(report.argv, ["chat", "-q", "<prompt>"]);
  assert.equal(report.promptOnArgv, true);
  assert.ok(report.promptBytes > 100, "the prompt carries prompt.md and the card");
  assert.equal(realpathSync(report.cwd), realpathSync(s.wt.path), "runs in the task worktree");
  assert.equal(report.term, "dumb");
  assert.equal(report.noColor, "1");
  // No provider keys, no roundtable settings, no token path.
  for (const name of report.envNames) assert.doesNotMatch(name, /API_KEY|TOKEN|^ROUNDTABLE_/, name);
  assert.deepEqual(report.envNames.filter((n) => !["PATH", "HOME", "TERM", "NO_COLOR", "USER", "LANG", "LC_ALL", "TMPDIR", "LOGNAME", "TZ", "LC_CTYPE", "LC_MESSAGES", "__CF_USER_TEXT_ENCODING"].includes(n)), []);
  // The wrapper consumed the token before the runtime started.
  assert.equal(existsSync(join(s.files.dir, "token")), false);

  const submitted = await events(s.store, "task.submitted");
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].payload.summary, /Finished the task \(hermes\)/);
  assert.deepEqual(submitted[0].payload.files, ["src/api/handler.js"]);
  assert.equal((await events(s.store, "task.checks_passed")).length, 1);
  const result = resultOf(s.launch);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.usage_estimated, true);
  assert.ok(result.usage.inputTokens > 0 && result.usage.outputTokens > 0);

  // Through the monitor: usage priced from the table is estimated, and the run completed.
  const m = new RunMonitor({ path: s.launch.outputPath, parse: (l, a) => s.driver.parse(l, a), agent: s.agent, task: "api", provider: s.driver.id, expected: null });
  const drafts = [...m.poll().drafts, ...m.finish({ code: 0 })];
  assert.equal(drafts.find((d) => d.type === "agent.exited").payload.reason, "completed");
  assert.equal(drafts.find((d) => d.type === "budget.usage_recorded").payload.provenance.tokens, "estimated");
});

test("hermes: an edit outside the leases is rejected at submit and nothing outside is committed", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "FIXTURE write src/api/ok.js\nFIXTURE write docs/elsewhere.md" });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 1);
  assert.equal((await events(s.store, "task.submitted")).length, 0);
  const rejected = await events(s.store, "task.rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].payload.reasons.join(" "), /outside the leases: docs\/elsewhere\.md/);
  assert.equal((await events(s.store, "lease.violation")).length, 1);
  const result = resultOf(s.launch);
  assert.equal(result.ok, false);
  assert.equal(result.submitted, false);
  assert.match(result.text, /Submission rejected/);
  const acc = { done: false, lines: 0 };
  for (const line of logOf(s.launch).split("\n").filter(Boolean)) s.driver.parse(line, acc);
  assert.equal(acc.isError, true);
});

test("agy: sandboxed driver-side submit, reported tokens, sign-in auth and no injected MCP settings", async (t) => {
  const s = await setup(t, {
    driverId: "runtime:agy", prompt: "FIXTURE write src/api/agy.js",
    env: { ROUNDTABLE_WORKER_AUTH: "api_key", GEMINI_API_KEY: "gem-key", GOOGLE_API_KEY: "goog-key" },
  });
  const h = await s.driver.launch({ ...s.launch, model: "gemini-3.8-flash-medium" });
  assert.equal((await workerExit(h.pid)).code, 0, logOf(s.launch));
  const report = reportOf(s.launch);
  assert.deepEqual(report.argv, [
    "--mode", "accept-edits", "--sandbox", "-p", "<prompt>", "--output-format", "json",
    "--disable-slash-commands", "--model", "gemini-3.8-flash-medium",
  ]);
  assert.equal(realpathSync(report.cwd), realpathSync(s.wt.path));
  assert.equal(report.settings, undefined);
  assert.ok(!report.envNames.some(n => /API_KEY|TOKEN|^ROUNDTABLE_/.test(n)));
  assert.equal(existsSync(join(s.files.dir, "token")), false);
  assert.equal(existsSync(join(s.files.dir, "runtime-settings.json")), false);
  const submitted = await events(s.store, "task.submitted");
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].payload.files, ["src/api/agy.js"]);
  const result = resultOf(s.launch);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.usage_estimated, false);
  assert.deepEqual(result.usage, { inputTokens: 7709, outputTokens: 1 });
  assert.equal(result.cost_usd, undefined);
  assert.match(workerProtocol("api", "runtime:agy"), /You have no roundtable tools/);
  assert.match(confinementNote("agy", worker.workerProfile("agy")), /agy's own sandbox flag/);
});

test("agy exit-0 ERROR and empty SUCCESS fail the worker without submitting edits", async (t) => {
  for (const marker of ["FAIL_ME", "DENY_ME", "DENY_TEXT"]) {
    const s = await setup(t, { driverId: "runtime:agy", prompt: `FIXTURE write src/api/partial.js\n${marker}` });
    const h = await s.driver.launch(s.launch);
    assert.equal((await workerExit(h.pid)).code, 1, logOf(s.launch));
    assert.equal((await events(s.store, "task.submitted")).length, 0);
    const result = resultOf(s.launch);
    assert.equal(result.ok, false);
    assert.match(result.text, marker === "FAIL_ME" ? /failure status: ERROR: boom/ : marker === "DENY_TEXT" ? /denied actions/ : /denied actions|no final text/);
  }
});

test("a non-zero exit fails the attempt: nothing is submitted, the failure is relayed", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "FIXTURE write src/api/partial.js\nFIXTURE fail" });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 3);
  assert.equal((await events(s.store, "task.submitted")).length, 0);
  assert.equal((await events(s.store, "task.rejected")).length, 0);
  const result = resultOf(s.launch);
  assert.equal(result.ok, false);
  assert.match(result.text, /hermes exited with 3/);
  assert.match(result.text, /the runtime failed on purpose/);
  const m = new RunMonitor({ path: s.launch.outputPath, parse: (l, a) => s.driver.parse(l, a), agent: s.agent, task: "api", provider: s.driver.id, expected: null });
  const exited = m.finish({ code: 3 }).find((d) => d.type === "agent.exited");
  assert.equal(exited.payload.reason, "error");
});

test("a stop request ends the runtime and its group; nothing is submitted", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "FIXTURE hang" });
  const h = await s.driver.launch(s.launch);
  for (let i = 0; i < 100 && !logOf(s.launch).includes("REPORT"); i++) await delay(50);
  assert.ok(groupAlive(h.pgid));
  await s.driver.stop(h, "test stop");
  const exit = await workerExit(h.pid);
  assert.ok(exit.signal !== null || exit.code !== 0, JSON.stringify(exit));
  assert.equal(groupAlive(h.pgid), false);
  assert.equal((await events(s.store, "task.submitted")).length, 0);
  // The wrapper does not submit after a stop: no result claims success.
  assert.notEqual(resultOf(s.launch)?.ok, true);
});

test("relayed output and the summary are scrubbed", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "FIXTURE write src/api/a.js\nFIXTURE secret" });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 0, logOf(s.launch));
  const log = logOf(s.launch);
  assert.ok(!log.includes("ghp_ZZZ"), "the log holds no token");
  const submitted = await events(s.store, "task.submitted");
  assert.ok(!JSON.stringify(submitted).includes("ghp_ZZZ"));
});

test("gemini (MCP): the worker server is wired through its settings, flags include its sandbox, the token is left for the server", async (t) => {
  const s = await setup(t, {
    driverId: "runtime:gemini",
    prompt: "FIXTURE write src/api/g.js",
    env: { GEMINI_API_KEY: "gem-key", GOOGLE_API_KEY: "goog-key", ANTHROPIC_API_KEY: "sk-ant-x" },
  });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 0, logOf(s.launch));
  const report = reportOf(s.launch);
  assert.deepEqual(report.argv, [
    "--approval-mode", "auto_edit", "--sandbox", "--allowed-mcp-server-names", "roundtable", "-p", "<prompt>", "--output-format", "json",
  ]);
  const server = report.settings.mcpServers.roundtable;
  assert.equal(server.trust, true);
  assert.deepEqual(Object.keys(report.settings.mcpServers), ["roundtable"]);
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(1, 3), ["mcp", "--worker"]);
  assert.ok(server.args.includes(s.agent));
  assert.equal(server.env.ROUNDTABLE_DOTENV, "off");
  assert.equal(report.settingsPath, join(s.files.dir, "runtime-settings.json"));
  // No provider keys without ROUNDTABLE_WORKER_AUTH=api_key.
  for (const name of report.envNames) assert.doesNotMatch(name, /^(ANTHROPIC|OPENAI|GEMINI_API|GOOGLE)_|^ROUNDTABLE_/, name);
  // The runtime's server consumes the token, not the wrapper; the wrapper does not submit.
  assert.equal(existsSync(join(s.files.dir, "token")), true);
  assert.equal((await events(s.store, "task.submitted")).length, 0);
  const result = resultOf(s.launch);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, undefined);
  assert.equal(result.usage_estimated, false, "gemini reports its tokens");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
  assert.equal(result.cost_usd, 0.004);
  assert.equal(result.text, "Finished the task (gemini).");
  // The settings file (it holds the server's environment) is removed with the run.
  for (let i = 0; i < 40 && existsSync(report.settingsPath); i++) await delay(25);
  assert.equal(existsSync(report.settingsPath), false);
});

test("ROUNDTABLE_WORKER_AUTH=api_key passes only the profile's key variables", async (t) => {
  const s = await setup(t, {
    driverId: "runtime:gemini",
    prompt: "go",
    env: { ROUNDTABLE_WORKER_AUTH: "api_key", GEMINI_API_KEY: "gem-key", GOOGLE_API_KEY: "goog-key", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x" },
  });
  const h = await s.driver.launch(s.launch);
  assert.equal((await workerExit(h.pid)).code, 0, logOf(s.launch));
  const names = reportOf(s.launch).envNames;
  assert.ok(names.includes("GEMINI_API_KEY") && names.includes("GOOGLE_API_KEY"));
  assert.ok(!names.includes("ANTHROPIC_API_KEY") && !names.includes("OPENAI_API_KEY"));
});

test("driver preflight and detect: opt-in, binary on PATH, connectors, outstanding peer tokens", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "go" });
  const off = new RuntimeWorkerDriver("runtime:hermes", { env: { PATH: `${BIN}:${process.env.PATH}` } });
  const d = await off.detect();
  assert.equal(d.ok, false);
  assert.match(d.missing.join(" "), /ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1/);
  await assert.rejects(off.launch(s.launch), /ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1/);
  assert.deepEqual(await s.driver.detect(), { ok: true, missing: [] });
  const noBin = new RuntimeWorkerDriver("runtime:openclaw", { env: { PATH: "/nonexistent", ...ON } });
  assert.match((await noBin.detect()).missing.join(" "), /openclaw CLI on PATH/);
  const unknown = new RuntimeWorkerDriver("runtime:nonesuch", { env: { ...process.env, ...ON } });
  assert.match((await unknown.detect()).missing.join(" "), /unknown runtime/);
  await assert.rejects(s.driver.launch({ ...s.launch, connectors: ["issues"] }), /Connectors are not supported by runtime workers/);
  // Another worker's unconsumed token file blocks the launch (the runtime may be unsandboxed).
  mkdirSync(join(s.files.dir, "..", "peer"), { recursive: true });
  writeFileSync(join(s.files.dir, "..", "peer", "token"), "t\n", { mode: 0o600 });
  await assert.rejects(s.driver.launch(s.launch), /unconsumed token file/);
});

test("spawnWorker is unchanged for other drivers: a plain node worker still relays", async (t) => {
  const s = await setup(t, { driverId: "runtime:hermes", prompt: "x" });
  const { pid } = await spawnWorker({ file: process.execPath, args: ["-e", "console.log('hi')"], cwd: s.wt.path, env: {}, prompt: "", outputPath: join(s.files.runsDir, "2.jsonl") });
  assert.equal((await workerExit(pid)).code, 0);
});
