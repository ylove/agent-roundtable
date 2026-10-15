// ============================================================================
// Subcommands of the agent-roundtable binary (index.ts runs this when argv[2] is a word)
//
//   mcp [--worker --execution <exe> --agent <id> --token-file <path>]   an MCP stdio server
//   hook pre-tool-use                                                   the PreToolUse lease hook
//   run <exe>                                                           the runner of a heads-down run
//   watch <exe> --as <orchestrator> [--timeout-min 50]                  wait until the orchestrator is needed
//   status <exe> [--json]                                               the run at a glance
//   verify <exe>                                                        the event chain and the audit chain
//   purge <exe> --confirm                                               remove a finished run
//   help                                                                this text
//
// Modules load lazily, so the hook (which Claude Code runs before every edit) never loads the
// server. In mcp mode stdout is the protocol; `watch` prints exactly one JSON line and nothing else.
// Exit codes: 0 ok, 1 a refusal or a failed check, 2 usage (and a denied hook).
// ============================================================================

import { EXECUTION_ID_RE } from "./ids.js";

export const USAGE = [
  "Usage:",
  "  agent-roundtable                                MCP stdio server (orchestrator)",
  "  agent-roundtable mcp                            the same",
  "  agent-roundtable mcp --worker --execution <exe> --agent <id> --token-file <path>",
  "                                                  a heads-down worker's MCP server",
  "  agent-roundtable hook pre-tool-use              PreToolUse lease hook (hook JSON on stdin)",
  "  agent-roundtable run <exe>                      the runner of a heads-down run (execute starts it)",
  "  agent-roundtable watch <exe> --as <orchestrator> [--timeout-min 50]",
  "                                                  wait until the orchestrator is needed; prints one JSON line",
  "  agent-roundtable status <exe> [--json]          tasks, budget, escalations, runner and watchers",
  "  agent-roundtable verify <exe>                   verify the event chain and the audit chain",
  "  agent-roundtable purge <exe> --confirm          remove a finished run's worktrees, branches and log",
  "  agent-roundtable help                           this text",
].join("\n");

function usage(problem: string): void {
  console.error(`agent-roundtable: ${problem}\n\n${USAGE}`);
  process.exitCode = 2;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** --name value pairs and bare flags, or the problem with them (an unknown, repeated or valueless argument). */
function parseFlags(args: string[], known: { values: string[]; flags: string[] }): Record<string, string | true> | string {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.slice(2) : "";
    if (!known.flags.includes(name) && !known.values.includes(name)) return `unknown argument ${JSON.stringify(a.slice(0, 80))}`;
    if (Object.hasOwn(out, name)) return `--${name} is repeated`;
    if (known.flags.includes(name)) {
      out[name] = true;
      continue;
    }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return `--${name} needs a value`;
    out[name] = v;
    i++;
  }
  return out;
}

/** `<command> <exe> [flags]`: the execution id and the parsed flags, or the problem. */
function withExecution(command: string, args: string[], known: { values: string[]; flags: string[] }): { exe: string; flags: Record<string, string | true> } | string {
  const [exe, ...rest] = args;
  if (exe === undefined || exe.startsWith("--")) return `${command} needs an execution id (exe-…)`;
  if (!EXECUTION_ID_RE.test(exe)) return `not an execution id: ${JSON.stringify(exe.slice(0, 80))}`;
  const flags = parseFlags(rest, known);
  return typeof flags === "string" ? flags : { exe, flags };
}

async function mcp(args: string[]): Promise<void> {
  const parsed = parseFlags(args, { values: ["execution", "agent", "token-file"], flags: ["worker"] });
  if (typeof parsed === "string") return usage(parsed);
  const { startStdio } = await import("./server.js");
  if (!parsed.worker) {
    if (Object.keys(parsed).length) return usage("--execution, --agent and --token-file go with --worker");
    return startStdio("orchestrator");
  }
  const { execution, agent } = parsed;
  const tokenFile = parsed["token-file"];
  if (typeof execution !== "string" || typeof agent !== "string" || typeof tokenFile !== "string") {
    return usage("mcp --worker needs --execution, --agent and --token-file");
  }
  try {
    await startStdio("worker", { execution, agent, tokenFile });
  } catch (e) {
    console.error(`agent-roundtable: the worker server refused to start: ${errText(e)}`);
    process.exitCode = 1;
  }
}

async function hook(args: string[]): Promise<void> {
  process.umask(0o077);
  if (args.length !== 1 || args[0] !== "pre-tool-use") return usage("hook takes one argument: pre-tool-use");
  // A crash must refuse the edit: exit 1 would let it through.
  try {
    const { runPreToolUseHook } = await import("./workers/hook.js");
    process.exitCode = await runPreToolUseHook();
  } catch (e) {
    process.stderr.write(`Refused: the lease hook failed (${errText(e)})\n`);
    process.exitCode = 2;
  }
}

/** The runner. Its workers are detached children, so the process exits explicitly once the runner stops. */
async function run(args: string[]): Promise<void> {
  process.umask(0o077);
  const p = withExecution("run", args, { values: [], flags: [] });
  if (typeof p === "string") return usage(p);
  const { runRunner } = await import("./execution/runner.js");
  // ROUNDTABLE_RUNNER_TICK_MS (50–10000) shortens the tick, for tests and demos.
  const tick = Number(process.env.ROUNDTABLE_RUNNER_TICK_MS);
  const code = await runRunner(p.exe, { signals: true, ...(Number.isFinite(tick) && tick >= 50 && tick <= 10_000 && { tickMs: tick }) });
  process.exit(code);
}

/** One JSON line on stdout when the orchestrator is needed (or the timeout passes); errors go to stderr only. */
async function watch(args: string[]): Promise<void> {
  process.umask(0o077);
  const p = withExecution("watch", args, { values: ["as", "timeout-min"], flags: [] });
  if (typeof p === "string") return usage(p);
  const as = p.flags.as;
  if (typeof as !== "string") return usage("watch needs --as <orchestrator>");
  const raw = p.flags["timeout-min"];
  const timeoutMin = raw === undefined ? undefined : Number(raw);
  if (timeoutMin !== undefined && !(Number.isFinite(timeoutMin) && timeoutMin > 0 && timeoutMin <= 24 * 60)) {
    return usage("--timeout-min must be a number of minutes between 0 and 1440");
  }
  const { watchExecution, ORCHESTRATOR_NAME_RE } = await import("./execution/watch.js");
  if (!ORCHESTRATOR_NAME_RE.test(as)) return usage(`not an orchestrator name: ${JSON.stringify(as.slice(0, 80))}`);
  try {
    const result = await watchExecution(p.exe, { as, ...(timeoutMin !== undefined && { timeoutMin }) });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    console.error(`agent-roundtable watch: ${errText(e)}`);
    process.exitCode = 1;
  }
}

async function status(args: string[]): Promise<void> {
  process.umask(0o077);
  const p = withExecution("status", args, { values: [], flags: ["json"] });
  if (typeof p === "string") return usage(p);
  const { executionStatus, formatStatus } = await import("./execution/run-admin.js");
  try {
    const r = await executionStatus(p.exe);
    process.stdout.write((p.flags.json ? JSON.stringify(r) : formatStatus(r)) + "\n");
  } catch (e) {
    console.error(`agent-roundtable status: ${errText(e)}`);
    process.exitCode = 1;
  }
}

async function verify(args: string[]): Promise<void> {
  process.umask(0o077);
  const p = withExecution("verify", args, { values: [], flags: ["json"] });
  if (typeof p === "string") return usage(p);
  const { verifyRun, formatVerify } = await import("./execution/run-admin.js");
  try {
    const r = await verifyRun(p.exe);
    process.stdout.write((p.flags.json ? JSON.stringify(r) : formatVerify(r)) + "\n");
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`agent-roundtable verify: ${errText(e)}`);
    process.exitCode = 1;
  }
}

async function purge(args: string[]): Promise<void> {
  process.umask(0o077);
  const p = withExecution("purge", args, { values: [], flags: ["confirm"] });
  if (typeof p === "string") return usage(p);
  if (!p.flags.confirm) return usage("purge deletes the run's worktrees, branches and log: pass --confirm");
  const { purgeExecution } = await import("./execution/run-admin.js");
  try {
    const r = await purgeExecution(p.exe, { confirm: true, actor: "cli" });
    process.stdout.write(`Purged ${r.execution} (${r.status}): ${r.worktrees.length} worktrees and ${r.branches.length} branches removed, ${r.removedDir} deleted.\n`);
  } catch (e) {
    console.error(`agent-roundtable purge: ${errText(e)}`);
    process.exitCode = 1;
  }
}

/** Run one subcommand. Exit codes: 0 ok, 1 a refusal or failed check, 2 usage (and a denied hook). */
export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      return mcp([]);
    case "mcp":
      return mcp(rest);
    case "hook":
      return hook(rest);
    case "run":
      return run(rest);
    case "watch":
      return watch(rest);
    case "status":
      return status(rest);
    case "verify":
      return verify(rest);
    case "purge":
      return purge(rest);
    case "help":
      if (rest.length) return usage("help takes no arguments");
      process.stdout.write(USAGE + "\n");
      return;
    default:
      return usage(`unknown command ${JSON.stringify(String(command).slice(0, 80))}`);
  }
}
