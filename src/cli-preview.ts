// ============================================================================
// roundtable preview start <exe> <task> | --prototype <dir> | list | stop <id>
// ============================================================================

import { parseFlags } from "./cli.js";
import { EXECUTION_ID_RE } from "./ids.js";
import { PREVIEW_ID_RE } from "./previews/args.js";
import { previewCliStarter, refreshPreviews, startPreview, stopPreview, type StartInput } from "./previews/manager.js";
import { previewLabel } from "./previews/embed.js";
import { isPreviewDisplay, type PreviewRecord } from "./previews/store.js";
import { scrubAndCap } from "./security/secrets.js";

export const PREVIEW_HELP = [
  "  roundtable preview start <exe> <task> [--script dev|start|preview] [--port <n>] [--display live|click|screenshot]",
  "  roundtable preview start --prototype <dir> [--script dev|start|preview] [--port <n>] [--display live|click|screenshot]",
  "  roundtable preview list [--json] | preview stop <id>",
].join("\n");

class UsageError extends Error {}

export type PreviewCommand =
  | { kind: "start"; input: StartInput }
  | { kind: "list"; json: boolean }
  | { kind: "stop"; id: string };

/** The command in `args`, or a UsageError. Pure. */
export function parsePreviewArgs(args: string[]): PreviewCommand {
  const [verb, ...rest] = args;
  if (verb === "list") {
    const flags = parseFlags(rest, { values: [], flags: ["json"] });
    if (typeof flags === "string") throw new UsageError(flags);
    return { kind: "list", json: flags.json === true };
  }
  if (verb === "stop") {
    if (rest.length !== 1 || !PREVIEW_ID_RE.test(rest[0])) throw new UsageError("preview stop needs a preview id (prv-…)");
    return { kind: "stop", id: rest[0] };
  }
  if (verb !== "start") throw new UsageError("preview takes start, list or stop");
  const positional: string[] = [];
  while (rest.length && !rest[0].startsWith("--")) positional.push(rest.shift()!);
  const flags = parseFlags(rest, { values: ["prototype", "script", "port", "display"], flags: [] });
  if (typeof flags === "string") throw new UsageError(flags);
  const input: StartInput = {};
  if (flags.display !== undefined) {
    if (!isPreviewDisplay(flags.display)) throw new UsageError("--display must be live, click or screenshot");
    input.display = flags.display;
  }
  if (typeof flags.prototype === "string") {
    if (positional.length) throw new UsageError("give either <exe> <task> or --prototype, not both");
    input.prototype = flags.prototype;
  } else {
    if (positional.length !== 2) throw new UsageError("preview start needs <exe> <task> or --prototype <dir>");
    if (!EXECUTION_ID_RE.test(positional[0])) throw new UsageError("not an execution id (exe-…)");
    [input.execution, input.task] = positional;
  }
  if (typeof flags.script === "string") input.script = flags.script;
  if (typeof flags.port === "string") {
    if (!/^\d{1,5}$/.test(flags.port)) throw new UsageError("--port must be a number");
    input.port = Number(flags.port);
  }
  return { kind: "start", input };
}

export function formatPreview(r: PreviewRecord): string {
  const page = r.check ? (r.check.reason === "disabled" || r.check.reason === "no browser" ? "page check skipped" : r.check.loaded && !r.check.exceptions.length ? "page loaded" : "page check failed") : "";
  return `${r.id}  ${r.origin}/  ${previewLabel(r)}  npm run ${r.script}  display: ${r.display}${page ? `  ${page}` : ""}`;
}

export async function runPreviewCli(args: string[]): Promise<number> {
  let cmd: PreviewCommand;
  try { cmd = parsePreviewArgs(args); } catch (e) {
    console.error(`roundtable preview: ${(e as Error).message}\n\n${PREVIEW_HELP}`);
    return 2;
  }
  try {
    if (cmd.kind === "list") {
      const records = await refreshPreviews();
      console.log(cmd.json ? JSON.stringify(records) : records.length ? records.map(formatPreview).join("\n") : "No previews are running.");
    } else if (cmd.kind === "stop") {
      if (!(await stopPreview(cmd.id))) { console.error("No such preview."); return 1; }
      console.log(`Stopped ${cmd.id}.`);
    } else {
      const r = await startPreview({ ...cmd.input, starter: previewCliStarter() });
      console.log(`${formatPreview(r)}\nOpen ${r.origin}/ in a browser. It is reachable from this machine only and stops after ${Math.round(r.ttl_ms / 60_000)} idle minutes.`);
    }
    return 0;
  } catch (e) {
    console.error(`roundtable preview: ${scrubAndCap(e instanceof Error ? e.message : String(e), 1200)}`);
    return 1;
  }
}
