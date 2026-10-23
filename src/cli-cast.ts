import { isAbsolute, join } from "node:path";
import { ROUNDTABLE_HOME } from "./config.js";
import { parseFlags } from "./cli.js";
import { runCastingCall, validateCastingOptions, type CastingOptions } from "./casting/casting.js";
import { clean, createNdjsonObserver, createTerminalObserver, type TerminalOutput } from "./table/terminal.js";
import type { TableEvent } from "./table/events.js";
import { scrubAndCap } from "./security/secrets.js";

const HELP = `roundtable cast <brief> [options]
  --agents <a,b,...>            audition 2 to 24 personas (default: every persona)
  --agents-dir <abs-path>       discover personas in this directory
  --seats <n>                  recommended cast size (default: min(5, personas))
  --no-examine                 skip cross-examination
  --dry-run                    static lint and overlap checks; no keys or provider calls
  --json                       NDJSON events, then the report
  --seat <agent=provider-or-runtime:model,...>  --mix auto|cheap
  --turn-timeout <s>            per-call timeout (default 90, up to 3600)
  --max-seconds <s>             whole-run deadline (default 300, up to 3600)
`;
class UsageError extends Error { readonly exitCode = 2; }
export function parseCastArgs(args: string[]): { options: CastingOptions; json: boolean } {
  const brief = args[0] && !args[0].startsWith("--") ? args[0] : "";
  const flags = parseFlags(brief ? args.slice(1) : args, {
    values: ["agents", "agents-dir", "seats", "seat", "mix", "turn-timeout", "max-seconds"], flags: ["no-examine", "dry-run", "json"],
  });
  if (typeof flags === "string") throw new UsageError(flags);
  const agents = typeof flags.agents === "string" ? flags.agents.split(",").map(s => s.trim()) : undefined;
  if (agents?.some(a => !a)) throw new UsageError("Agent lists must be comma-separated non-empty identifiers.");
  if (typeof flags["agents-dir"] === "string" && !isAbsolute(flags["agents-dir"])) throw new UsageError("--agents-dir requires an absolute directory.");
  const positive = (key: string, fallback: number) => {
    const n = flags[key] === undefined ? fallback : Number(flags[key]);
    if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new UsageError(`--${key} must be a positive number up to 3600.`);
    return n;
  };
  const options: CastingOptions = { brief, agents, agentsDir: flags["agents-dir"] as string | undefined,
    ...(flags.seats !== undefined && { seats: Number(flags.seats) }), seat: flags.seat as string | undefined,
    mix: flags.mix as "auto" | "cheap" | undefined, examine: !flags["no-examine"], dryRun: !!flags["dry-run"],
    turnTimeoutMs: positive("turn-timeout", 90) * 1000, maxSeconds: positive("max-seconds", 300) };
  validateCastingOptions(options);
  return { options, json: !!flags.json };
}

export async function runCastCli(args: string[], io: { output?: TerminalOutput; error?: TerminalOutput } = {}): Promise<number> {
  const output = io.output ?? process.stdout, error = io.error ?? process.stderr;
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    if (args.includes("--help") || args.includes("-h")) { output.write(HELP); return 0; }
    const { options, json } = parseCastArgs(args);
    const renderer = json ? createNdjsonObserver(output) : createTerminalObserver({ output, agentsDir: options.agentsDir });
    let aborted = false;
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const report = await runCastingCall(options, { async onEvent(event: TableEvent) {
      if (event.type === "end") aborted = !!event.aborted;
      await renderer.onEvent(event);
    } }, controller.signal);
    if (json) output.write(JSON.stringify(report) + "\n");
    else output.write(`Archive: ${clean(join(ROUNDTABLE_HOME, "casting", `${report.id}.json`))}\n`);
    return aborted || controller.signal.aborted ? 1 : 0;
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode === 2 ? 2 : 1;
    error.write(`roundtable: ${scrubAndCap(e instanceof Error ? e.message : "Casting failed.", 400)}\n`);
    return code;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
