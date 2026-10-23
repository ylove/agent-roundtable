import type { LintIssue } from "./lint.js";
import type { Redundancy } from "./similarity.js";
import { clean } from "../table/text.js";

export interface CastingReport {
  id: string; createdAt: string; brief: string; dryRun?: boolean; note?: string;
  agents: Array<{ key: string; name?: string; verdict: "cast" | "bench" | "redundant" | "unclear"; role?: string;
    strengths: string[]; risks: string[]; overlapsWith: string[]; lint: LintIssue[] }>;
  redundancy: Redundancy[]; gaps: string[];
  recommended: { seats: string[]; teamA?: string[]; teamB?: string[]; judges?: string[] };
  usage?: { totalCostUsd: number; estimated?: boolean; unpricedTokens?: number };
}

const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
export function duelLine(report: CastingReport, agentsDir?: string): string | undefined {
  const { teamA, teamB, judges } = report.recommended;
  if (!teamA?.length || !teamB?.length || !judges?.length) return;
  return `roundtable duel ${quote(report.brief)} --team-a ${quote(teamA.join(","))} --team-b ${quote(teamB.join(","))} --judges ${quote(judges.join(","))}${agentsDir ? ` --agents-dir ${quote(agentsDir)}` : ""}`;
}

export function renderRoster(report: CastingReport, agentsDir?: string): string {
  const lines = ["Casting Call" + (report.dryRun ? " (dry run)" : ""), ...(report.note ? [`Note: ${report.note}`, ""] : []), ...report.agents.map(agent =>
    `${agent.key} [${agent.verdict.toUpperCase()}]${agent.role ? ` · ${agent.role}` : ""}${agent.overlapsWith.length ? ` · overlaps: ${agent.overlapsWith.join(", ")}` : ""}`)];
  lines.push("", "Redundancy: " + (report.redundancy.map(cluster => `${cluster.keys.join(", ")} (${cluster.reason})`).join("; ") || "none"),
    "Gaps: " + (report.note && !report.dryRun ? "not assessed" : report.gaps.join("; ") || "none"), "Recommended cast: " + (report.recommended.seats.join(", ") || "none"));
  const command = duelLine(report, agentsDir);
  if (command) lines.push("", command);
  if (report.usage) lines.push("", usageLine(report));
  return clean(lines.join("\n")) + "\n";
}

const md = (text: string): string => clean(text).replace(/[\\`*_{}\[\]<>|]/g, "\\$&").replace(/\s+/g, " ");
const usageLine = (report: CastingReport): string => `Usage: $${(report.usage?.totalCostUsd ?? 0).toFixed(4)}${report.usage?.unpricedTokens ? ` (+${report.usage.unpricedTokens} tokens unpriced)` : ""}${report.usage?.estimated ? " (estimated)" : ""}`;
export function renderCastingMarkdown(report: CastingReport, agentsDir?: string): string {
  const lines = [`## Casting Call${report.dryRun ? " (dry run)" : ""}`, "", ...(report.note ? [`**Note: ${md(report.note)}**`, ""] : []), md(report.brief), "", "| Persona | Verdict | Role | Overlaps |", "| --- | --- | --- | --- |",
    ...report.agents.map(a => `| ${md(a.key)} | ${a.verdict} | ${md(a.role ?? "")} | ${a.overlapsWith.map(md).join(", ")} |`)];
  for (const agent of report.agents) {
    const notes = [...agent.strengths.map(s => `Strength: ${s}`), ...agent.risks.map(s => `Risk: ${s}`), ...agent.lint.map(l => `${l.level}: ${l.message}`)];
    if (notes.length) lines.push("", `**${md(agent.key)}**`, "", ...notes.map(note => `- ${md(note)}`));
  }
  lines.push("", `Redundancy: ${report.redundancy.map(r => `${r.keys.map(md).join(", ")} (${md(r.reason)})`).join("; ") || "none"}`,
    "", `Gaps: ${report.note && !report.dryRun ? "not assessed" : report.gaps.map(md).join("; ") || "none"}`, "", `Recommended cast: ${report.recommended.seats.map(md).join(", ") || "none"}`);
  const command = duelLine(report, agentsDir);
  if (command) {
    const fence = "`".repeat(Math.max(3, ...[...command.matchAll(/`+/g)].map(m => m[0].length + 1)));
    lines.push("", `${fence}sh`, command, fence);
  }
  lines.push("", `Archive: casting/${report.id}.json`, "", usageLine(report));
  return lines.join("\n");
}
