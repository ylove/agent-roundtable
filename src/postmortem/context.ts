// ============================================================================
// The meeting's context: a bounded bundle, like a huddle's (§5)
//
// The findings, the contract summary (or the host's work label), the task cards of the affected
// tasks, the failing check signatures, and the rules already in force. It never includes the human's
// chat, `confirmation` or `original_prompt`: task cards are built without the original request, a
// prompt_misread finding quotes the contract's goal instead, and any of the human's protected words
// that the orchestrator's own text repeats verbatim are withheld before they go in.
// ============================================================================

import { agentKey } from "../agents.js";
import { buildTaskCard } from "../execution/task-card.js";
import type { BlackboardState, PostmortemFinding, PostmortemFormat } from "../execution/types.js";
import { scrub } from "../security/secrets.js";
import { dissentsSection, reviewedDissents } from "./dissents.js";
import { scopeLabel } from "./draft.js";
import type { Lesson, PostmortemScope } from "./types.js";
import { LIMITS } from "./types.js";

export const POSTMORTEM_CONTEXT_LIMIT = 12_000;
const CARD_CHARS = 2500;
const MAX_CARDS = 4;
export const WITHHELD = "[the human's words, withheld]";

const oneLine = (s: string | undefined, n: number) => {
  const t = scrub(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};
const cap = (s: string, n: number) => {
  const t = scrub(s).trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}… [truncated]`;
};

/**
 * `text` without any stretch that repeats the human's own words verbatim: a protected text of at
 * least 12 characters, or one of its lines of at least 24.
 */
export function withholdHumanWords(text: string, protectedTexts: readonly string[]): string {
  let out = text;
  for (const p of protectedTexts) {
    const whole = p.trim();
    if (whole.length >= 12) out = out.split(whole).join(WITHHELD);
    for (const l of whole.split(/\r?\n/)) if (l.trim().length >= 24) out = out.split(l.trim()).join(WITHHELD);
  }
  return out;
}

/** The directive every seat is told (the format's own turn rules come from the engine). */
export function directive(format: PostmortemFormat, seats: readonly string[], defender?: string): string {
  const lines = [
    "## How this postmortem runs",
    "",
    "This is a blameless postmortem: blameless about people, strict about mechanisms. The human has no seat here and nothing they type reaches this meeting.",
    "Every finding needs a cause and a prevention. Name the mechanism that failed (a misread requirement, a missing check, an ambiguous contract field), not who is to blame.",
    "Propose artifacts only in the artifact block, one line each, in exactly this form:",
    "",
    "    Artifact: <kind> | <target> | <finding ids> | <text>",
    "",
    "Kinds: fix (target a path or task id: a follow-up, nothing changes by itself), rule (target project: shown to every future plan), persona_addendum (target an agent: a line added to its persona file), " +
      "agent_rule (target an agent: shown in its task card while it works on this project), contract_rule (target project: a rule every future contract must state), memory (target an agent: a note it keeps).",
    `Rule and agent targets are \`project\` or one of these seats: ${seats.join(", ")}. At most ${LIMITS.artifacts} artifacts, ${LIMITS.artifactText} characters each; finding ids are the pmf- ids listed below.`,
    "For a dissent assessment use: Artifact: dissent_score | <dissent id> | <finding ids> | <vindicated/refuted/untested> | <supporting evidence>. Name a dissent in the Dissents section and explain the evidence, not just whether its tripwire fired. Omit an assessment when none is supported; scores are advisory, never voting weights, consent thresholds or routing inputs.",
    "For a prompt_misread, project_misread or contract_ambiguity finding, state in a rule or contract_rule which field, task text or phrase was misread and the clearer wording.",
    "The last turn of the last round must contain the artifact block. Write each Artifact line as plain text (not in a quote or a code fence), or it is ignored.",
  ];
  if (format === "waffle-house" && defender) {
    lines.push(
      "",
      `This is a waffle-house: ${defender} is the defender and the main orchestrator's opening is the charge. The defender must answer every finding with what it misunderstood or skipped and what rule would have stopped it; the others attack the answers.`
    );
  }
  return lines.join("\n");
}

export interface ContextInput {
  scope: PostmortemScope;
  format: PostmortemFormat;
  seats: readonly string[];
  defender?: string;
  /** The orchestrator's opening, already cleaned. */
  opening: string;
  findings: readonly PostmortemFinding[];
  /** Execution scope: the run's blackboard. */
  state?: Readonly<BlackboardState>;
  lessons?: readonly Lesson[];
}

function findingLine(f: PostmortemFinding): string {
  const fix = f.fix ? `fix ${f.fix.status}${f.fix.by ? ` by ${oneLine(f.fix.by, 80)}` : ""}${f.fix.ref ? ` (${oneLine(f.fix.ref, 80)})` : ""}` : "fix unknown";
  const bits = [
    `- \`${f.id}\` [${f.category}] ${oneLine(f.summary, 600)}`,
    `  Caught by ${oneLine(f.detected_by, 200)}; responsible: ${f.responsible.map((r) => oneLine(r, 80)).join(", ")}${f.task ? `; task \`${f.task}\`` : ""}; ${fix}${f.repeats ? `; repeated ${f.repeats} time${f.repeats === 1 ? "" : "s"}` : ""}`,
  ];
  if (f.evidence?.length) bits.push(`  Evidence refs: ${f.evidence.slice(0, 8).map((e) => oneLine(e, 90)).join(", ")}`);
  return bits.join("\n");
}

function workSection(i: ContextInput): string {
  const c = i.state?.contract;
  if (!c) return `## The work\n\n${oneLine(scopeLabel(i.scope), 300)}. The orchestrator's opening above says what it was.`;
  const lines = [
    `- ${oneLine(c.title, 200)} (\`${c.id}\` v${c.version}), run ${i.state!.status}`,
    `- Contract goal: ${oneLine(i.state!.goal?.ultimate ?? c.goal.ultimate, 800)}`,
    `- ${Object.values(i.state!.tasks).filter((t) => t.state === "accepted").length} of ${Object.keys(i.state!.tasks).length} tasks accepted`,
  ];
  const misread = i.findings.filter((f) => f.category === "prompt_misread");
  if (misread.length) lines.push("- The prompt was misread in " + misread.map((f) => `\`${f.id}\``).join(", ") + ": quote the contract's goal above and the task text below, not the original request.");
  return `## The work\n\n${lines.join("\n")}`;
}

function tasksSection(i: ContextInput): string {
  const s = i.state;
  if (!s) return "";
  const ids = [...new Set(i.findings.flatMap((f) => (f.task !== undefined && Object.hasOwn(s.tasks, f.task) ? [f.task] : [])))].slice(0, MAX_CARDS);
  if (!ids.length) return "";
  const cards = ids.map((id) => cap(buildTaskCard(s, id, { omitOriginalPrompt: true }).split("\n## Protocol")[0], CARD_CHARS));
  return `## Task cards of the affected tasks\n\n${cards.join("\n\n---\n\n")}`;
}

function checksSection(i: ContextInput): string {
  const s = i.state;
  if (!s) return "";
  const tasks = new Set(i.findings.flatMap((f) => (f.task !== undefined ? [f.task] : [])));
  const rows = [
    ...Object.entries(s.checks.task).filter(([k, c]) => (c.status === "failed" || c.status === "timed_out") && tasks.has(k.split("/")[0])).map(([k, c]) => `- \`${k}\` ${c.status}${c.streak > 1 ? ` ×${c.streak}` : ""}${c.signature ? ` (signature ${c.signature.slice(0, 16)})` : ""}`),
    ...Object.entries(s.checks.integration).filter(([, c]) => c.status === "failed" || c.status === "timed_out").map(([k, c]) => `- integration \`${k}\` ${c.status}${c.signature ? ` (signature ${c.signature.slice(0, 16)})` : ""}`),
  ];
  return rows.length ? `## Failing check signatures\n\n${rows.slice(0, 12).join("\n")}` : "";
}

function rulesSection(i: ContextInput): string {
  const rows = (i.lessons ?? []).filter((l) => l.kind !== "flag").slice(0, 12).map((l) => `- ${l.kind === "agent_rule" ? `[${oneLine(l.target, 60)}] ` : ""}${oneLine(l.text, 300)} (${l.pm})`);
  const seats = new Set(i.seats.map(agentKey));
  const mine = rows.length && (i.lessons ?? []).some((l) => l.kind === "agent_rule" && seats.has(agentKey(l.target)));
  return rows.length ? `## Rules already agreed for this project${mine ? " (agent rules apply to the seat named)" : ""}\n\n${rows.join("\n")}` : "";
}

/** The context text, under POSTMORTEM_CONTEXT_LIMIT characters; the first section that does not fit is cut and the rest left out. */
export function buildPostmortemContext(i: ContextInput): string {
  const sections = [
    directive(i.format, i.seats, i.defender),
    dissentsSection(reviewedDissents(i.state), true),
    `## The main orchestrator's opening (turn 0)\n\n${cap(i.opening, 3000)}`,
    `## Findings\n\n${i.findings.map(findingLine).join("\n")}`,
    workSection(i),
    tasksSection(i),
    checksSection(i),
    rulesSection(i),
  ].filter(Boolean);
  let out = "";
  for (const s of sections) {
    const next = out ? `${out}\n\n${s}` : s;
    if (next.length <= POSTMORTEM_CONTEXT_LIMIT) {
      out = next;
      continue;
    }
    const room = POSTMORTEM_CONTEXT_LIMIT - out.length - 40;
    if (room > 200) out = `${out}\n\n${s.slice(0, room).trimEnd()}\n… [context truncated]`;
    break;
  }
  return scrub(out).slice(0, POSTMORTEM_CONTEXT_LIMIT);
}
