// Read-only snapshots of WS16's projection. Tripwire observations never imply an assessment.
import { scrubDeep } from "../execution/blobs.js";
import type { BlackboardState, DissentRuntime } from "../execution/types.js";
import { scrub } from "../security/secrets.js";

export function reviewedDissents(state?: Readonly<BlackboardState>): Record<string, DissentRuntime> {
  return scrubDeep(state?.dissents ?? {});
}

const cell = (s: string) => scrub(s).replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

/** Full snapshot for records; a bounded excerpt of each field for the meeting's input. */
export function dissentsSection(dissents: Readonly<Record<string, DissentRuntime>>, bounded = false): string {
  const entries = Object.entries(dissents);
  const excerpt = (s: string) => {
    const max = bounded ? Math.max(24, Math.floor(2400 / Math.max(1, entries.length) / 4)) : Infinity;
    return cell(s.length > max ? `${s.slice(0, max)}… [excerpt]` : s);
  };
  const lines = ["## Dissents", "", "Advisory and display-only. A firing is not vindication; absence of a firing is not refutation. No assessment means not assessed.", ""];
  if (!entries.length) return [...lines, "None in this scope."].join("\n");
  lines.push("| Id / dissenter | Claim / prediction | Tripwire | Fired (current generation) | Evidence of firings (all generations) | Score at review |", "| --- | --- | --- | --- | --- | --- |");
  for (const [id, d] of entries) {
    const fires = Object.values(d.fires);
    const fired = fires.some((f) => f.generation === d.generation);
    lines.push(`| ${cell(id)} / ${excerpt(d.spec?.by ?? "unknown")} | ${excerpt(d.spec?.claim ?? "")} / ${excerpt(d.spec?.predicted_failure ?? "")} | ${excerpt(JSON.stringify(d.spec?.tripwire) ?? "none")} | ${fired ? "yes" : "no"} | ${excerpt(fires.map((f) => `seq ${f.seq}${f.task ? ` task ${f.task}` : ""}${f.generation !== undefined ? ` generation ${f.generation}` : ""}: ${f.evidence}`).join("; ") || "none")} | ${cell(d.score ?? "not assessed")} |`);
  }
  if (bounded) lines.push("", "Long fields are excerpts; the stored postmortem record retains the full snapshot.");
  return lines.join("\n");
}
