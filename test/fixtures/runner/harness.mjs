// The runner tests' harness: a run built from direct contract events (fixtures/workers/run.mjs),
// a fake claude on PATH that drives the real worker MCP server, and the runner as a process.
//
// The fake claude answers --help (the 2.1.300 fixture) and --version. Launched with the task card
// on stdin, it prints system/init, starts the worker server from its generated mcp.json (through
// test/mcp-client.mjs), calls read_blackboard, writes src/<task>/<task>.txt in its worktree,
// calls submit_work(ready: true), prints a result line with total_cost_usd and exits. What it does
// is set per agent in <control>/behavior.json:
//   die: n          exit 1 right after system/init on its first n launches
//   waitFor: name   stay alive (after init) until <control>/<name> exists
//   cost: usd       the reported total_cost_usd (default 0.05)
//   content: text   what it writes
//   sessionGone     a --resume launch fails as if the session were gone
//   escalate: args  on its first launch, call escalate(args) instead of working, and end its turn
// Every launch is logged to <control>/calls.jsonl.
//
// Runner processes run WS10's real hooks. Their persona calls (the goal review, the lead) go to
// `provider`, an OpenAI-compatible stub on loopback (default answer: Verdict COMPLETE), as the
// contract's lead persona "lead" from ROUNDTABLE_AGENTS_DIR.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBin } from "../workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(here, "../../../dist/index.js");
const preferredHelp = resolve(here, "../claude-help-2.1.300.txt");
const HELP = existsSync(preferredHelp) ? preferredHelp : resolve(here, "../workers/claude-help-2.1.300.txt");
const MCP_CLIENT = resolve(here, "../../mcp-client.mjs");

export const TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "mcp__roundtable__read_blackboard", "mcp__roundtable__lease", "mcp__roundtable__post_update",
  "mcp__roundtable__run_command", "mcp__roundtable__submit_work", "mcp__roundtable__escalate",
];

/** The fake claude on PATH; returns its control directory and helpers. */
export function fakeClaude(t, behaviors = {}) {
  const control = realpathSync(mkdtempSync(join(tmpdir(), "rt-runner-fake-")));
  writeFileSync(join(control, "behavior.json"), JSON.stringify(behaviors));
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const argv = process.argv.slice(2);
if (argv.includes("--help")) { process.stdout.write(fs.readFileSync(${JSON.stringify(HELP)}, "utf8")); process.exit(0); }
if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\\n"); process.exit(0); }
const CONTROL = ${JSON.stringify(control)};
const TOOLS = ${JSON.stringify(TOOLS)};
const agent = process.env.ROUNDTABLE_AGENT_ID;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const log = (o) => fs.appendFileSync(path.join(CONTROL, "calls.jsonl"), JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => { try { return fs.readFileSync(path.join(CONTROL, "calls.jsonl"), "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.agent === agent && c.launch); } catch { return []; } };
const behavior = () => { try { const b = JSON.parse(fs.readFileSync(path.join(CONTROL, "behavior.json"), "utf8")); return b[agent] ?? b["*"] ?? {}; } catch { return {}; } };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + "\\n"); process.exit(1); }));
async function main() {
  const b = behavior();
  const resume = argv.includes("--resume");
  const sid = argv[argv.indexOf(resume ? "--resume" : "--session-id") + 1];
  const n = calls().length;
  log({ agent, launch: true, n, pid: process.pid, resume, sid, budget: argv[argv.indexOf("--max-budget-usd") + 1], input });
  if (b.sessionGone && resume) { process.stderr.write("No conversation found with session ID: " + sid + "\\n"); process.exit(1); }
  out({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-5", tools: TOOLS, mcp_servers: [{ name: "roundtable", status: "connected" }] });
  if (b.die && n < b.die) { process.stderr.write("simulated crash\\n"); process.exit(1); }
  if (b.waitFor) { while (!fs.existsSync(path.join(CONTROL, b.waitFor))) await sleep(100); }
  const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.roundtable;
  const { startServer } = await import(pathToFileURL(${JSON.stringify(MCP_CLIENT)}).href);
  const server = startServer({ args: cfg.args.slice(1), env: cfg.env, timeoutMs: 60000 });
  try {
    await server.init();
    const bb = await server.callTool("read_blackboard", {});
    if (b.escalate && n === 0) {
      const esc = await server.callTool("escalate", b.escalate);
      log({ agent, escalate: esc.text.slice(0, 3000), isError: esc.isError });
    } else {
      const task = JSON.parse(bb.text).you.task;
      const file = path.join("src", task, task + ".txt");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, b.content ?? (task + " by " + agent + "\\n"));
      const sub = await server.callTool("submit_work", { summary: task + " done", ready: true });
      log({ agent, submit: sub.text.slice(0, 3000), isError: sub.isError });
    }
  } finally {
    server.stop();
    await server.exited();
  }
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sid, total_cost_usd: b.cost ?? 0.05, usage: { input_tokens: 10, output_tokens: 20 } });
}
`;
  fakeBin(t, "claude", script);
  return {
    control,
    release: (name) => writeFileSync(join(control, name), "go"),
    setBehavior: (b) => writeFileSync(join(control, "behavior.json"), JSON.stringify(b)),
    calls: () => (existsSync(join(control, "calls.jsonl")) ? readFileSync(join(control, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    launches: (agent) =>
      (existsSync(join(control, "calls.jsonl")) ? readFileSync(join(control, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter(
        (c) => c.launch && (agent === undefined || c.agent === agent)
      ),
  };
}

/** The stub provider runner processes call: `calls` are the request bodies, `reply(body)` the answer's text. */
export const provider = await (async () => {
  const stub = { calls: [], reply: () => "Verdict: COMPLETE\nGaps: None" };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* answered all the same */
      }
      stub.calls.push(body);
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ model: body.model ?? "stub", choices: [{ message: { content: stub.reply(body) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  stub.env = { ROUNDTABLE_EXECUTION_PROVIDER: "openai_compatible", ROUNDTABLE_EXECUTION_MODEL: "stub-model", ROUNDTABLE_EXECUTION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
  return stub;
})();

// The contract fixture's lead (authority.lead "lead") must resolve for the goal review.
if (process.env.ROUNDTABLE_AGENTS_DIR) {
  mkdirSync(process.env.ROUNDTABLE_AGENTS_DIR, { recursive: true });
  const lead = join(process.env.ROUNDTABLE_AGENTS_DIR, "lead.md");
  if (!existsSync(lead)) writeFileSync(lead, "---\nname: lead\ndescription: The test run's lead\n---\nYou are the lead of a test run.\n");
}

export const RUNNER_ENV = { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "1", ROUNDTABLE_DOTENV: "off", ROUNDTABLE_RUNNER_TICK_MS: "200", ...provider.env };

/** `agent-roundtable run <exe>` as a child process; stderr is collected. */
export function startRunner(exe, env = {}) {
  const child = spawn(process.execPath, [CLI, "run", exe], { env: { ...process.env, ...RUNNER_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const err = [];
  const out = [];
  child.stderr.on("data", (d) => err.push(String(d)));
  child.stdout.on("data", (d) => out.push(String(d)));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, pid: child.pid, exited, stderr: () => err.join(""), stdout: () => out.join("") };
}

/** Run a CLI subcommand to completion: { code, stdout, stderr }. */
export function cli(args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ROUNDTABLE_DOTENV: "off", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} timed out; stderr: ${stderr}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export async function waitFor(fn, ms = 60_000, what = "a condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const ofType = (events, type) => events.filter((e) => e.type === type);

/** Kill whatever fake workers are still alive (by the pids the fake logged). */
export function killFakes(fake) {
  for (const c of fake.launches()) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

/** Probe the isolation primitive before running tests that need the local backend. */
export function localSandboxSkip() {
  if (process.platform === "win32") return "heads-down runs require macOS or Linux";
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8", timeout: 5000 });
  if (probe.status === 0) return false;
  if (/sandbox_apply: Operation not permitted|Operation not permitted/.test(probe.stderr ?? "")) return "sandbox-exec cannot nest in this sandbox (sandbox_apply: Operation not permitted)";
  throw new Error(`sandbox-exec probe failed: ${probe.stderr || probe.error || probe.status}`);
}
