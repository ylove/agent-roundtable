// ============================================================================
// Subcommands of the agent-roundtable binary (index.ts runs this when argv[2] is a word)
//
//   mcp [--worker --execution <exe> --agent <id> --token-file <path>]   an MCP stdio server
//   hook pre-tool-use                                                   the PreToolUse lease hook
//
// Modules load lazily, so the hook (which Claude Code runs before every edit) never loads the
// server. WS08 adds run, watch, status, verify and purge.
// ============================================================================

export const USAGE = [
  "Usage:",
  "  agent-roundtable                                MCP stdio server (orchestrator)",
  "  agent-roundtable mcp                            the same",
  "  agent-roundtable mcp --worker --execution <exe> --agent <id> --token-file <path>",
  "                                                  a heads-down worker's MCP server",
  "  agent-roundtable hook pre-tool-use              PreToolUse lease hook (hook JSON on stdin)",
].join("\n");

function usage(problem: string): void {
  console.error(`agent-roundtable: ${problem}\n\n${USAGE}`);
  process.exitCode = 2;
}

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
    console.error(`agent-roundtable: the worker server refused to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

async function hook(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "pre-tool-use") return usage("hook takes one argument: pre-tool-use");
  // A crash must refuse the edit: exit 1 would let it through.
  try {
    const { runPreToolUseHook } = await import("./workers/hook.js");
    process.exitCode = await runPreToolUseHook();
  } catch (e) {
    process.stderr.write(`Refused: the lease hook failed (${e instanceof Error ? e.message : String(e)})\n`);
    process.exitCode = 2;
  }
}

/** Run one subcommand. Exit codes: 0 ok, 1 a refused start, 2 usage (and a denied hook). */
export async function runCli(argv: string[]): Promise<void> {
  process.umask(0o077);
  const [command, ...rest] = argv;
  switch (command) {
    case "mcp":
      return mcp(rest);
    case "hook":
      return hook(rest);
    default:
      return usage(`unknown command ${JSON.stringify(String(command).slice(0, 80))}`);
  }
}
