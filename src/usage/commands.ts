// ============================================================================
// The usage subcommands of the agent-roundtable binary: statusline and usage (cli.ts dispatches here)
//
//   statusline [--agents N] [--plain] [--no-host]   a Claude Code statusLine command; always exits 0
//   usage [--json] [--watch]                        who is using what, on which platform
// ============================================================================

import { setTimeout as sleep } from "node:timers/promises";
import { collectUsage } from "./model.js";
import { renderReport } from "./report.js";
import { defaultCols, readHostFigures, readStdin, statuslineText } from "./statusline.js";

const colorAllowed = (env: NodeJS.ProcessEnv): boolean => !env.NO_COLOR;

/** `statusline`: prints at most three lines and exits 0, whatever went wrong. */
export async function runStatusline(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    let agents = 4;
    let plain = false;
    let host = true;
    // A status line must never show a usage error: unknown or malformed flags are ignored.
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--plain") plain = true;
      else if (args[i] === "--no-host") host = false;
      else if (args[i] === "--agents" && /^\d{1,2}$/.test(args[i + 1] ?? "")) agents = Math.min(10, Number(args[++i]));
    }
    const stdin = await readStdin(process.stdin);
    const text = await statuslineText(stdin, { host, agents, color: !plain && colorAllowed(env), cols: defaultCols(env) });
    if (text) process.stdout.write(text + "\n");
  } catch {
    /* nothing to show */
  }
  process.exitCode = 0;
}

const CLEAR = `${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[H`;

/** `usage`: the friendly report, its JSON, or the report refreshed every 2 s. */
export async function runUsage(flags: Record<string, string | true>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const tty = process.stdout.isTTY === true;
  const cols = Math.min(process.stdout.columns ?? defaultCols(env), 160);
  const once = async (): Promise<string> => {
    const host = readHostFigures();
    const view = await collectUsage({ ...(host && { host }) });
    return flags.json ? JSON.stringify(view) : renderReport(view, { color: tty && colorAllowed(env), cols });
  };
  if (!flags.watch) {
    process.stdout.write((await once()) + "\n");
    return;
  }
  for (;;) {
    const frame = await once();
    process.stdout.write((tty ? CLEAR : "") + frame + "\n" + (flags.json ? "" : "\n  Refreshing every 2 s. Press Ctrl+C to stop watching.\n"));
    await sleep(2000);
  }
}
