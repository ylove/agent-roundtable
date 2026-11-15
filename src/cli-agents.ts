import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./cli.js";
import { listLibrary } from "./library/catalog.js";
import { importAgentPath, type PathImportResult } from "./library/import.js";

export const AGENTS_HELP = `Usage: roundtable agents [--json]
       roundtable agents import <absolute file|dir>
       roundtable agents starter
       roundtable agents --open [--no-hold]

List configured and imported personas, import .md or .json files, install the
eight-persona starter pack, or open the local library and drop zone.
Existing files are skipped. Exit codes: 0 ok, 1 failure, 2 usage error.
`;
class UsageError extends Error { readonly exitCode = 2; }
const terminalText = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const truncate = (value: string, max: number): string => value.length > max ? value.slice(0, max - 1) + "…" : value;

function printResults(results: PathImportResult[]): number {
  for (const result of results) {
    const status = result.status === "exists" ? "exists (skipped)" : result.status;
    process.stdout.write(`${terminalText(result.filename)}: ${status}${result.key ? ` (${result.key})` : ""}${result.error ? `: ${result.error}` : ""}\n`);
    for (const warning of result.warnings) process.stdout.write(`  warning: ${terminalText(warning)}\n`);
  }
  return results.some(result => result.status === "refused") ? 1 : 0;
}

export async function runAgentsCli(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(AGENTS_HELP); return 0; }
  try {
    if (args[0] === "import") {
      if (args.length !== 2 || !isAbsolute(args[1])) throw new UsageError("agents import requires an absolute file or directory.");
      return printResults(importAgentPath(args[1]));
    }
    if (args[0] === "starter") {
      if (args.length !== 1) throw new UsageError("agents starter takes no arguments.");
      return printResults(importAgentPath(fileURLToPath(new URL("../examples/starter-pack/", import.meta.url))));
    }
    const flags = parseFlags(args, { values: [], flags: ["json", "open", "no-hold"] });
    if (typeof flags === "string") throw new UsageError(flags);
    if (flags.json && flags.open) throw new UsageError("Use either --json or --open.");
    if (flags["no-hold"] && !flags.open) throw new UsageError("--no-hold requires --open.");
    if (flags.open) {
      const { startLibrary } = await import("./library/server.js");
      const { openInBrowser } = await import("./prototypes/board.js");
      const server = await startLibrary();
      try {
        process.stdout.write(server.url + "\n");
        openInBrowser(server.url);
        if (!flags["no-hold"]) {
          process.stderr.write("Library open; press Ctrl-C to close.\n");
          await new Promise<void>(resolve => {
            const keeper = setInterval(() => {}, 60_000);
            const stop = () => { clearInterval(keeper); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
        }
      } finally { await server.close(); }
      return 0;
    }
    const agents = listLibrary();
    if (flags.json) process.stdout.write(JSON.stringify(agents) + "\n");
    else {
      process.stdout.write(`${"KEY".padEnd(24)} ${"SOURCE".padEnd(10)} ${"DESCRIPTION".padEnd(56)} WARNINGS\n`);
      for (const agent of agents) {
        const warnings = [...agent.warnings, ...(agent.shadowed ? ["shadowed by agents-dir"] : [])].join("; ");
        process.stdout.write(`${truncate(terminalText(agent.key), 24).padEnd(24)} ${agent.source.padEnd(10)} ${truncate(terminalText(agent.description ?? ""), 56).padEnd(56)} ${terminalText(warnings)}\n`);
      }
    }
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError;
    process.stderr.write(`roundtable: ${usage ? error.message : "The agents command failed."}\n${usage ? AGENTS_HELP : ""}`);
    return usage ? 2 : 1;
  }
}
