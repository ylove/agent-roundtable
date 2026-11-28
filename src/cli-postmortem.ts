// Postmortem review: list pending artifacts, then sign off explicit ids with a person's identity.
import { parseFlags } from "./cli.js";
import { signOffPostmortem } from "./postmortem/meeting.js";
import { resolveProject } from "./postmortem/project.js";
import { pendingPostmortems } from "./postmortem/store.js";
import { PM_ID_RE } from "./postmortem/types.js";
import { scrub } from "./security/secrets.js";

export const POSTMORTEM_HELP = `Usage: roundtable postmortem pending [--project <dir>] [--json]
       roundtable postmortem signoff <pm> --by <identity> <artifact-id>... [--json]

Review pending text and hashes before signing off the explicit ids you accept.
Exit codes: 0 ok, 1 refusal, 2 usage error.
`;
class UsageError extends Error {}
const terminalText = (text: string) => scrub(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function runPostmortemCli(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(POSTMORTEM_HELP); return 0; }
  try {
    if (args[0] === "pending") {
      const flags = parseFlags(args.slice(1), { values: ["project"], flags: ["json"] });
      if (typeof flags === "string") throw new UsageError(flags);
      const project = await resolveProject(typeof flags.project === "string" ? flags.project : process.cwd());
      const pending = pendingPostmortems(project.key);
      if (flags.json) process.stdout.write(JSON.stringify({ project: project.key, pending }) + "\n");
      else {
        process.stdout.write(`${pending.length} artifact(s) pending sign-off\n`);
        for (const a of pending) process.stdout.write(`${a.pm} ${a.id} (${a.kind} → ${terminalText(a.target)})\n  ${terminalText(a.text)}\n  hash: ${a.hash}\n`);
      }
      return 0;
    }
    if (args[0] !== "signoff") throw new UsageError("Choose pending or signoff.");
    const pm = args[1];
    if (!pm || !PM_ID_RE.test(pm)) throw new UsageError("signoff requires a postmortem id (pm-…).");
    const ids: string[] = [];
    const options: string[] = [];
    for (let n = 2; n < args.length; n++) {
      if (args[n] === "--by") { options.push(args[n]); if (args[n + 1] !== undefined) options.push(args[++n]); }
      else if (args[n].startsWith("--")) options.push(args[n]);
      else ids.push(args[n]);
    }
    const flags = parseFlags(options, { values: ["by"], flags: ["json"] });
    if (typeof flags === "string") throw new UsageError(flags);
    if (typeof flags.by !== "string" || !flags.by.trim() || !ids.length) throw new UsageError("signoff requires --by <identity> and at least one artifact id.");
    const result = await signOffPostmortem({ pm, orchestrator: flags.by, accept: ids });
    if (flags.json) process.stdout.write(JSON.stringify(result) + "\n");
    else {
      for (const a of result.applied.filter((a) => ids.includes(a.id))) process.stdout.write(`${a.id}: ${terminalText(a.note ?? "applied")}${a.signoff ? `; signed off by ${terminalText(a.signoff.by)} at ${a.signoff.at}` : ""}\n`);
      for (const id of result.already_signed_off) process.stdout.write(`${id}: already signed off\n`);
      for (const warning of result.warnings) process.stdout.write(`Warning: ${terminalText(warning)}\n`);
      process.stdout.write(`${result.pending.length} pending sign-off. Record: ${result.record}\n`);
    }
    return result.pending.some((id) => ids.includes(id)) || result.applied.some((a) => ids.includes(a.id) && a.audit_pending) ? 1 : 0;
  } catch (e) {
    process.stderr.write(`roundtable postmortem: ${terminalText(e instanceof Error ? e.message : String(e))}\n${e instanceof UsageError ? POSTMORTEM_HELP : ""}`);
    return e instanceof UsageError ? 2 : 1;
  }
}
