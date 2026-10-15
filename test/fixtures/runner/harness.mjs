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
// Every launch is logged to <control>/calls.jsonl.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBin } from "../workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(here, "../../../dist/index.js");
const HELP = resolve(here, "../workers/claude-help-2.1.300.txt");
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
    const task = JSON.parse(bb.text).you.task;
    const file = path.join("src", task, task + ".txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, b.content ?? (task + " by " + agent + "\\n"));
    const sub = await server.callTool("submit_work", { summary: task + " done", ready: true });
    log({ agent, submit: sub.text.slice(0, 3000), isError: sub.isError });
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

export const RUNNER_ENV = { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "1", ROUNDTABLE_DOTENV: "off", ROUNDTABLE_RUNNER_TICK_MS: "200" };

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
