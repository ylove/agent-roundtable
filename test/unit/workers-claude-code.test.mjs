// The claude-code driver: argv (snapshot), --help detection, stream parsing, attestation, and a
// fake claude on PATH for launch, resume, stop (process-group kill) and answer (fork, no tools).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBin } from "../fixtures/workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HELP = resolve(here, "../fixtures/workers/claude-help-2.1.300.txt");
const cc = await import("../../dist/workers/claude-code.js");
const { workerExit, groupAlive } = await import("../../dist/workers/process.js");

const SESSION = "11111111-2222-4333-8444-555555555555";
const launch = (over = {}) => ({
  execution: "exe-0000000000abcdef",
  agent: "builder-1",
  task: "build-nav-bar",
  attempt: 1,
  cwd: "/work/tree",
  prompt: "THE TASK CARD (secret-free, but never on argv)",
  appendPromptPath: "/state/agents/builder-1/prompt.md",
  mcpConfigPath: "/state/agents/builder-1/mcp.json",
  settingsPath: "/state/agents/builder-1/settings.json",
  budgetUsd: 2.5,
  sessionId: SESSION,
  outputPath: "/state/agents/builder-1/runs/1.jsonl",
  env: {},
  timeoutMs: 600_000,
  ...over,
});

test("buildWorkerArgs: the exact argv (snapshot)", () => {
  assert.deepEqual(cc.buildWorkerArgs(launch({ model: "sonnet", fallbackModel: "haiku", effort: "high" })), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", SESSION,
    "--model", "sonnet", "--fallback-model", "haiku", "--effort", "high",
    "--append-system-prompt-file", "/state/agents/builder-1/prompt.md",
    "--mcp-config", "/state/agents/builder-1/mcp.json", "--strict-mcp-config",
    "--settings", "/state/agents/builder-1/settings.json",
    "--restricted", "--tools", "Read,Edit,Write,Glob,Grep",
    "--allowedTools", "Read Edit Write Glob Grep mcp__roundtable",
    "--disallowedTools", "Bash WebFetch WebSearch Task",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-budget-usd", "2.5",
    "--disable-slash-commands", "--no-chrome",
  ]);
});

test("buildWorkerArgs: no prompt and no positional argument, never --bare, resume and optional flags", () => {
  const args = cc.buildWorkerArgs(launch());
  assert.ok(!args.some((a) => a.includes("TASK CARD")), "the prompt never reaches argv");
  assert.ok(!args.includes("--bare"), "--bare skips hooks");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--restricted"));
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash WebFetch WebSearch Task");
  // Every value follows a flag: nothing positional.
  const flagsWithValue = new Set(["--output-format", "--session-id", "--resume", "--append-system-prompt-file", "--mcp-config", "--settings", "--tools", "--allowedTools", "--disallowedTools", "--permission-mode", "--permission-prompts", "--max-budget-usd", "--model", "--fallback-model", "--effort"]);
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.has(args[i])) i++;
    else assert.ok(args[i].startsWith("-"), `positional argument ${args[i]}`);
  }
  const resumed = cc.buildWorkerArgs(launch(), cc.FULL_CAPS, { resume: true });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], SESSION);
  assert.ok(!resumed.includes("--session-id"));
  const noEffort = cc.buildWorkerArgs(launch({ effort: "high" }), { model: true, fallbackModel: true, effort: false });
  assert.ok(!noEffort.includes("--effort"));
  assert.throws(() => cc.buildWorkerArgs(launch({ sessionId: "nope" })), /UUID/);
  assert.throws(() => cc.buildWorkerArgs(launch({ budgetUsd: 0 })), /at least \$0.01/);
  assert.throws(() => cc.buildWorkerArgs(launch({ model: "--dangerously-skip-permissions" })), /invalid --model/);
  assert.throws(() => cc.buildWorkerArgs(launch({ effort: "turbo" })), /invalid --effort/);
  assert.throws(() => cc.buildWorkerArgs(launch({ settingsPath: "relative.json" })), /absolute/);
  assert.equal(cc.formatUsd(0.123456), "0.1235");
});

test("buildAnswerArgs: a fork with no tools at all, no MCP and a cap", () => {
  const args = cc.buildAnswerArgs(SESSION, 0.5);
  assert.deepEqual(args.slice(0, 4), ["-p", "--resume", SESSION, "--fork-session"]);
  assert.equal(args[args.indexOf("--tools") + 1], "", '--tools ""');
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.5");
  assert.ok(args.includes("--strict-mcp-config") && !args.includes("--mcp-config"));
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "mcp__*");
});

test("parseClaudeHelp: the 2.1.300 help has every required flag (append-system-prompt-file as [-file])", () => {
  const help = readFileSync(HELP, "utf8");
  const r = cc.parseClaudeHelp(help);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.caps, { model: true, fallbackModel: true, effort: true });
  assert.ok(!help.includes("--append-system-prompt-file"), "the fixture lists it only as [-file]");
  const old = help.replace(/--restricted/g, "--unrelated").replace(/--permission-prompts/g, "--x-prompts").replace(/--effort/g, "--x-effort");
  const r2 = cc.parseClaudeHelp(old);
  assert.deepEqual(r2.missing, ["--restricted", "--permission-prompts"]);
  assert.equal(r2.caps.effort, false);
  assert.ok(cc.parseClaudeHelp("  --tools-extra <x>").missing.includes("--tools"), "a longer flag is not the flag");
});

// Lines shaped like a real 2.1.300 stream-json run (paths and ids replaced).
const INIT = (over = {}) => JSON.stringify({
  type: "system", subtype: "init", cwd: "/work/tree", session_id: SESSION,
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "mcp__roundtable__read_blackboard", "mcp__roundtable__submit_work"],
  mcp_servers: [{ name: "roundtable", status: "connected" }], model: "claude-sonnet-5", permissionMode: "dontAsk", ...over,
});
const ASSISTANT = (id, text, usage) => JSON.stringify({
  type: "assistant", session_id: SESSION, parent_tool_use_id: null,
  message: { model: "claude-sonnet-5", id, type: "message", role: "assistant", content: [{ type: "text", text }], usage },
});
const RESULT = (over = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Submitted; checks passed.", session_id: SESSION, num_turns: 7,
  total_cost_usd: 0.4321, permission_denials: [{ tool_name: "Edit" }],
  usage: { input_tokens: 12, cache_creation_input_tokens: 3039, cache_read_input_tokens: 649, output_tokens: 400 },
  modelUsage: { "claude-haiku-5-5": { costUSD: 0.01 }, "claude-sonnet-5": { costUSD: 0.42 } }, ...over,
});

test("parseClaudeLine: init, assistant text and usage, result; noise and hook lines are skipped", () => {
  const acc = cc.newAccumulator();
  for (const line of [
    JSON.stringify({ type: "system", subtype: "hook_started", hook_event: "SessionStart" }),
    "not json at all",
    INIT(),
    ASSISTANT("msg_1", "Reading the blackboard", { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 100 }),
    ASSISTANT("msg_1", "", { input_tokens: 5, output_tokens: 12, cache_read_input_tokens: 100 }),
    ASSISTANT("msg_2", "Done", { input_tokens: 1, output_tokens: 3 }),
  ]) cc.parseClaudeLine(line, acc);
  assert.equal(acc.lines, 6);
  assert.equal(acc.sessionId, SESSION);
  assert.deepEqual(acc.mcpServers, ["roundtable"]);
  assert.equal(acc.tools.length, 7);
  assert.equal(acc.lastText, "Done");
  assert.equal(acc.done, false);
  assert.deepEqual(cc.messageUsageTotal(acc), { inputTokens: 6, outputTokens: 15, cacheReadTokens: 100, cacheWriteTokens: 0 });
  cc.parseClaudeLine(RESULT(), acc);
  assert.equal(acc.done, true);
  assert.equal(acc.resultSubtype, "success");
  assert.equal(acc.isError, false);
  assert.equal(acc.costUsd, 0.4321);
  assert.deepEqual(acc.usage, { inputTokens: 12, outputTokens: 400, cacheReadTokens: 649, cacheWriteTokens: 3039 });
  assert.equal(acc.lastText, "Submitted; checks passed.");
  assert.equal(acc.model, "claude-sonnet-5", "the model that cost the most");
  assert.equal(acc.permissionDenials, 1);
});

test("attest: the expected set passes; any extra tool or server, or a failed server, fails", () => {
  const ok = cc.newAccumulator();
  cc.parseClaudeLine(INIT(), ok);
  assert.deepEqual(cc.attest(ok), { ok: true, tools: ok.tools, mcp_servers: ["roundtable"], unexpected: [], reasons: [] });

  const bad = cc.newAccumulator();
  cc.parseClaudeLine(INIT({ tools: ["Read", "Bash", "mcp__other__x", "mcp__roundtable__lease"], mcp_servers: [{ name: "roundtable", status: "connected" }, { name: "other", status: "connected" }] }), bad);
  const r = cc.attest(bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unexpected, ["Bash", "mcp__other__x", "mcp server other"]);

  const failed = cc.newAccumulator();
  cc.parseClaudeLine(INIT({ mcp_servers: [{ name: "roundtable", status: "failed" }] }), failed);
  assert.match(cc.attest(failed).reasons.join(";"), /roundtable is failed/);

  const none = cc.newAccumulator();
  cc.parseClaudeLine(INIT({ mcp_servers: [] }), none);
  assert.match(cc.attest(none).reasons.join(";"), /missing MCP servers: roundtable/);
  assert.equal(cc.attest(cc.newAccumulator()).ok, false, "no init line is no attestation");
});

test("workerEnvExtras: identity, home and dotenv-off; secret-named entries are dropped", () => {
  const e = cc.workerEnvExtras({ execution: "exe-0000000000abcdef", agent: "builder-1", env: { ROUNDTABLE_HOME: "/h", ANTHROPIC_API_KEY: "sk-x", FOO: "1" } });
  assert.deepEqual(e, { FOO: "1", ROUNDTABLE_HOME: "/h", ROUNDTABLE_EXECUTION_ID: "exe-0000000000abcdef", ROUNDTABLE_AGENT_ID: "builder-1", ROUNDTABLE_DOTENV: "off" });
});

// ---------------------------------------------------------------------------
// A fake claude: answers --help/--version, records every other call, prints a stream or a result.
// ---------------------------------------------------------------------------

function fakeClaude(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-fake-claude-")));
  const log = join(dir, "calls.jsonl");
  const script = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
if (argv.includes("--help")) { process.stdout.write(fs.readFileSync(${JSON.stringify(HELP)}, "utf8")); process.exit(0); }
if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\\n"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env: process.env, input, pid: process.pid, pgid: process.pid }) + "\\n");
  if (argv.includes("--fork-session")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "the fork's answer", session_id: "99999999-2222-4333-8444-555555555555",
      total_cost_usd: 0.012, usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50 }, modelUsage: { "claude-sonnet-5": { costUSD: 0.012 } } }) + "\\n");
    return;
  }
  if (input.includes("HANG")) {
    // A child in the same process group, and a leader that ignores SIGTERM: only a group SIGKILL ends both.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ child: child.pid }) + "\\n");
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  const sid = argv[argv.indexOf(argv.includes("--resume") ? "--resume" : "--session-id") + 1];
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid, tools: ["Read"], mcp_servers: [{ name: "roundtable", status: "connected" }] }) + "\\n");
  process.stderr.write("some stderr noise\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid, total_cost_usd: 0.05, usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");
});
`;
  fakeBin(t, "claude", script);
  cc.resetClaudeDetection();
  t.after(() => cc.resetClaudeDetection());
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, calls };
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("detect: parses the fake CLI's --help and --version once", { skip: process.platform === "win32" }, async (t) => {
  fakeClaude(t);
  const d = await new cc.ClaudeCodeDriver().detect();
  assert.equal(d.ok, true);
  assert.equal(d.version, "2.1.300");
  assert.deepEqual(d.missing, []);
});

test("launch and resume: detached, cwd the worktree, output appended to the file, card on stdin, allowlisted env", { skip: process.platform === "win32" }, async (t) => {
  const { dir, calls } = fakeClaude(t);
  const wt = join(dir, "wt");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(wt);
  process.env.ANTHROPIC_API_KEY = "sk-ant-planted-never-passed-0001";
  t.after(() => delete process.env.ANTHROPIC_API_KEY);
  const driver = new cc.ClaudeCodeDriver();
  const out = join(dir, "runs", "1.jsonl");
  const h = await driver.launch(launch({ cwd: wt, outputPath: out, appendPromptPath: join(dir, "p.md"), mcpConfigPath: join(dir, "m.json"), settingsPath: join(dir, "s.json") }));
  assert.equal(h.pgid, h.pid);
  assert.equal(h.sessionId, SESSION);
  const exit = await workerExit(h.pid);
  assert.deepEqual(exit, { code: 0, signal: null });
  const call = calls()[0];
  assert.equal(call.cwd, wt);
  assert.equal(call.input, launch().prompt);
  assert.ok(!call.argv.some((a) => a.includes("TASK CARD")));
  assert.equal(call.env.ROUNDTABLE_EXECUTION_ID, "exe-0000000000abcdef");
  assert.equal(call.env.ROUNDTABLE_AGENT_ID, "builder-1");
  assert.equal(call.env.ROUNDTABLE_DOTENV, "off");
  assert.ok(call.env.ROUNDTABLE_HOME);
  assert.equal(call.env.MCP_TOOL_TIMEOUT, "1200000");
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined, "no provider key without ROUNDTABLE_WORKER_AUTH=api_key");
  const written = readFileSync(out, "utf8");
  assert.match(written, /"subtype":"init"/);
  assert.match(written, /some stderr noise/, "stderr goes to the same file");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(out).mode & 0o777, 0o600);

  const h2 = await driver.resume({ ...h, driver: "claude-code", cwd: wt }, launch({ cwd: wt, outputPath: out, sessionId: "00000000-0000-4000-8000-000000000000", prompt: "resume card", appendPromptPath: join(dir, "p.md"), mcpConfigPath: join(dir, "m.json"), settingsPath: join(dir, "s.json") }));
  await workerExit(h2.pid);
  const r = calls()[1];
  assert.equal(r.argv[r.argv.indexOf("--resume") + 1], SESSION, "resume continues the record's session");
  assert.equal(r.input, "resume card");
  assert.equal(readFileSync(out, "utf8").split("\n").filter((l) => l.includes('"subtype":"init"')).length, 2, "appended, not truncated");
});

test("stop: SIGTERM to the group, then SIGKILL after the grace period kills the leader and its children", { skip: process.platform === "win32" }, async (t) => {
  const { dir, calls } = fakeClaude(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "wt"));
  const driver = new cc.ClaudeCodeDriver({ killGraceMs: 300 });
  const h = await driver.launch(launch({ cwd: join(dir, "wt"), prompt: "HANG", outputPath: join(dir, "runs", "hang.jsonl") }));
  const childPid = (await waitFor(() => calls().find((c) => c.child))).child;
  assert.ok(groupAlive(h.pgid));
  const started = Date.now();
  await driver.stop(h, "test");
  assert.ok(Date.now() - started >= 250, "waited for the grace period: the leader ignores SIGTERM");
  assert.equal(groupAlive(h.pgid), false);
  const exit = await workerExit(h.pid);
  assert.equal(exit?.signal, "SIGKILL");
  // The child in the group is gone too (once reaped: an orphaned zombie lingers until init collects it).
  await waitFor(() => {
    try {
      process.kill(childPid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  }, 5000);
});

test("answer: a forked session with --tools \"\" in the worker's worktree; text and huddle usage", { skip: process.platform === "win32" }, async (t) => {
  const { dir, calls } = fakeClaude(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "wt"));
  const rec = { agent: "builder-1", task: "build-nav-bar", attempt: 1, pid: 1, sessionId: SESSION, outputPath: "/x", startedAt: "now", driver: "claude-code", cwd: join(dir, "wt") };
  const r = await new cc.ClaudeCodeDriver().answer(rec, "Will you keep the nav props stable?", 0.5);
  assert.equal(r.text, "the fork's answer");
  assert.deepEqual(r.usage, { source: "huddle", agent: "builder-1", task: "build-nav-bar", provider: "claude-code", model: "claude-sonnet-5", tokens: { inputTokens: 3, outputTokens: 7, cacheReadTokens: 50 }, usd: 0.012, estimated: false });
  const call = calls()[0];
  assert.equal(call.cwd, join(dir, "wt"));
  assert.equal(call.input, "Will you keep the nav props stable?");
  assert.ok(call.argv.includes("--fork-session"));
  assert.equal(call.argv[call.argv.indexOf("--tools") + 1], "");
  assert.equal(call.argv[call.argv.indexOf("--resume") + 1], SESSION);
  assert.ok(!call.argv.includes("--mcp-config"));
});
