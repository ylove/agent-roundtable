// ============================================================================
// The readable record of a postmortem: findings, the full dialogue, artifacts and their status (§3, §8)
// ============================================================================

import { scrub } from "../security/secrets.js";
import { scopeLabel } from "./draft.js";
import type { PostmortemRecord } from "./types.js";

const text = (s: string | undefined) => scrub(s ?? "").trim();
const cell = (s: string, n = 300) => {
  const t = text(s).replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** A quote block, so a turn's own headings and lines can never pose as the record's structure. */
const quote = (s: string) => text(s).split(/\r?\n/).map((l) => `> ${l}`).join("\n");

function artifactStatus(r: PostmortemRecord, id: string): string {
  if (r.status !== "concluded") return "proposed";
  const applied = r.applied?.find((a) => a.id === id);
  if (applied) return applied.note?.startsWith("failed") ? `accepted, not applied (${cell(applied.note, 200)})` : "accepted";
  const rej = r.rejected?.find((x) => x.id === id);
  return rej ? `rejected: ${cell(rej.why, 200)}` : "not accepted";
}

/** The record as markdown: what `postmortem(action: "read")` returns for the host to show verbatim. */
export function renderRecord(r: PostmortemRecord): string {
  const out: string[] = [
    `# Postmortem ${r.pm}`,
    "",
    `- Scope: ${scopeLabel(r.scope)} (project ${r.project})`,
    `- Status: ${r.status}${r.concluded_at ? `, concluded ${r.concluded_at}` : `, held ${r.held_at}; waiting for the orchestrator's conclusion`}`,
    `- Meeting: ${r.format}, ${r.rounds} round${r.rounds === 1 ? "" : "s"}, seats ${r.seats.join(", ")}; the human has no seat`,
    "",
    "## Findings",
    "",
    ...r.findings.map((f) =>
      `- \`${f.id}\` [${f.category}] ${text(f.summary)}\n  Caught by ${text(f.detected_by)}; responsible: ${f.responsible.map(text).join(", ")}${f.task ? `; task \`${f.task}\`` : ""}` +
      `${f.fix ? `; fix ${f.fix.status}${f.fix.by ? ` by ${text(f.fix.by)}` : ""}` : ""}${f.repeats ? `; repeated ${f.repeats}x` : ""}${f.evidence?.length ? `\n  Evidence: ${f.evidence.map(text).join(", ")}` : ""}`
    ),
    "",
    "## The meeting",
    "",
    "**orchestrator** (opening):",
    "",
    quote(r.opening),
    "",
  ];
  for (const t of r.transcript) out.push(`**${text(t.seat)}:**`, "", quote(t.content), "");
  if (r.closing !== undefined) out.push("**orchestrator** (closing):", "", quote(r.closing), "");
  out.push("## Artifacts", "");
  if (r.proposed.length) {
    out.push("| Id | Kind | Target | Findings | Status | Text |", "| --- | --- | --- | --- | --- | --- |");
    for (const a of r.proposed) out.push(`| ${a.id} | ${a.kind} | ${cell(a.target, 80)} | ${a.findings.join(", ")} | ${artifactStatus(r, a.id)} | ${cell(a.text, 600)} |`);
  } else {
    out.push("None were proposed.");
  }
  if (r.rejected_lines.length) out.push("", "Lines that could not be used:", ...r.rejected_lines.map((l) => `- ${text(l)}`));
  if (r.applied?.length) out.push("", "## Applied", "", ...r.applied.map((a) => `- ${a.id} (${a.kind} → ${cell(a.target, 80)}): ${cell(a.note ?? "recorded", 300)}`));
  if (r.flagged?.length) {
    out.push("", "## Flags", "", ...r.flagged.map((f) => `- \`${f.finding}\` [${f.category}] misread: ${cell(f.misread, 300)}${f.clearer ? `; clearer wording: ${cell(f.clearer, 300)}` : ""}`));
  }
  return `${out.join("\n")}\n`;
}

/** One paragraph for the host to relay to the human. */
export function summaryParagraph(r: PostmortemRecord): string {
  const kinds = new Map<string, number>();
  for (const a of r.applied ?? []) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  const accepted = r.accepted?.length ?? 0;
  const cats = [...new Set(r.findings.map((f) => f.category))].join(", ");
  return (
    `A postmortem meeting (${r.format}, ${r.rounds} round${r.rounds === 1 ? "" : "s"}) took place for ${scopeLabel(r.scope)} with ${r.seats.join(", ")}; you were not at the table and nothing you type reaches it. ` +
    `It looked at ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} (${cats}). ` +
    `${accepted} of ${r.proposed.length} proposed artifact${r.proposed.length === 1 ? "" : "s"} ${accepted === 1 ? "was" : "were"} accepted` +
    `${kinds.size ? ` (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}` +
    `${r.flagged?.length ? `, and ${r.flagged.length} misreading${r.flagged.length === 1 ? " was" : "s were"} flagged so the next plan states it explicitly` : ""}. ` +
    "The full record, every turn included, is available to read."
  );
}
