// ============================================================================
// Lessons: what earlier postmortems taught, read back before the next plan (§7)
//
// lessons.json holds every accepted rule, agent_rule and contract_rule and every flag, newest
// first. A lesson that restates an active one (same kind, target and wording) supersedes it; the old
// one stays with superseded_by. Lessons are always read, whether or not postmortem mode is on now.
// ============================================================================

import { realpathSync } from "node:fs";
import { agentKey } from "../agents.js";
import { newId } from "../ids.js";
import { scrub } from "../security/secrets.js";
import type { BlackboardState, Decision } from "../execution/types.js";
import { loadLessons, projectKeyOf, saveLessons } from "./store.js";
import type { Lesson } from "./types.js";

export type NewLesson = Pick<Lesson, "kind" | "target" | "text" | "pm" | "findings"> & { flag?: true };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Add lessons to a project's lessons.json (newest first), superseding active restatements. Caller holds the project lock. */
export function addLessons(key: string, items: readonly NewLesson[], at = new Date().toISOString()): Lesson[] {
  const all = loadLessons(key);
  const added: Lesson[] = [];
  for (const item of items) {
    const lesson: Lesson = {
      id: newId("les"), kind: item.kind, target: item.target, text: scrub(item.text), pm: item.pm, findings: [...item.findings], at,
      ...(item.flag && { flag: true as const }),
    };
    for (const old of all) {
      if (old.superseded_by === undefined && old.kind === lesson.kind && old.target === lesson.target && norm(old.text) === norm(lesson.text)) old.superseded_by = lesson.id;
    }
    added.push(lesson);
    all.unshift(lesson);
  }
  saveLessons(key, all);
  return added;
}

export const activeLessons = (key: string): Lesson[] => loadLessons(key).filter((l) => l.superseded_by === undefined);

/** The active lessons of the project at a repository root, or none. Never throws: a damaged store is no lessons. */
export function lessonsForRoot(root: string): { key: string; lessons: Lesson[] } | undefined {
  try {
    const key = projectKeyOf(realpathSync(root));
    const lessons = activeLessons(key);
    return lessons.length ? { key, lessons } : undefined;
  } catch {
    return undefined;
  }
}

export interface LessonsView {
  project: string;
  flags: Lesson[];
  rules: Lesson[];
  contract_rules: Lesson[];
  agent_rules: Lesson[];
}

export function viewOf(key: string, lessons: readonly Lesson[]): LessonsView {
  return {
    project: key,
    flags: lessons.filter((l) => l.kind === "flag"),
    rules: lessons.filter((l) => l.kind === "rule"),
    contract_rules: lessons.filter((l) => l.kind === "contract_rule"),
    agent_rules: lessons.filter((l) => l.kind === "agent_rule"),
  };
}

const line = (text: string, max = 500) => {
  const t = scrub(text).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/** Cut a list of bullets to a character budget, saying how many were left out. */
function within(items: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const [i, item] of items.entries()) {
    if (used + item.length + 1 > budget) {
      out.push(`- … and ${items.length - i} more (postmortem(action: "lessons") lists them all)`);
      break;
    }
    out.push(item);
    used += item.length + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// propose_contract
// ---------------------------------------------------------------------------

export interface ContractLessons {
  /** Contract decisions, one per active contract_rule. */
  decisions: Decision[];
  /** One warning per flag: "Earlier work misread X; state it explicitly". */
  warnings: string[];
  /** The postmortem_lessons section of the result. */
  section: { project: string; contract_rules: Array<{ id: string; pm: string; text: string }>; flags: Array<{ id: string; pm: string; text: string }>; rules: number; agent_rules: number };
}

export function contractLessons(root: string): ContractLessons | undefined {
  const found = lessonsForRoot(root);
  if (!found) return undefined;
  const v = viewOf(found.key, found.lessons);
  if (!v.contract_rules.length && !v.flags.length) return undefined;
  return {
    decisions: v.contract_rules.map((l) => ({
      id: `pm-${l.id}`, scope: "contract", text: line(l.text, 600), rationale: `Postmortem ${l.pm} (findings ${l.findings.join(", ") || "none"}); every contract for this project must state it`,
      by: `postmortem:${l.pm}`,
    })),
    warnings: v.flags.map((l) => `Earlier work misread ${line(l.text, 300)}; state it explicitly (postmortem ${l.pm})`),
    section: {
      project: found.key,
      contract_rules: v.contract_rules.map((l) => ({ id: l.id, pm: l.pm, text: line(l.text, 600) })),
      flags: v.flags.map((l) => ({ id: l.id, pm: l.pm, text: line(l.text, 600) })),
      rules: v.rules.length,
      agent_rules: v.agent_rules.length,
    },
  };
}

// ---------------------------------------------------------------------------
// start_ultraplan and task cards
// ---------------------------------------------------------------------------

export const ULTRAPLAN_LESSONS_LIMIT = 3000;
export const CARD_LESSONS_LIMIT = 4096;

/** "Lessons from past postmortems" for a planner's context: flags first, bounded. Empty when there are none. */
export function ultraplanSection(root: string, limit = ULTRAPLAN_LESSONS_LIMIT): string {
  const found = lessonsForRoot(root);
  if (!found) return "";
  const v = viewOf(found.key, found.lessons);
  const body: string[] = [];
  if (v.flags.length) {
    body.push("Earlier work misread these; state them explicitly in the plan:", ...within(v.flags.map((l) => `- ${line(l.text)} (${l.pm})`), limit / 2));
  }
  const rules = [...v.contract_rules, ...v.rules, ...v.agent_rules].map((l) => `- ${l.kind === "agent_rule" ? `[${l.target}] ` : ""}${line(l.text)} (${l.pm})`);
  if (rules.length) body.push(...(body.length ? [""] : []), "Rules the team agreed:", ...within(rules, limit - body.join("\n").length - 120));
  return `## Lessons from past postmortems\n\n${body.join("\n")}`.slice(0, limit);
}

/** The "Lessons from earlier postmortems" section of a task card: project rules and the persona's agent rules, capped at 4 KB. */
export function cardSection(root: string, persona: string, limit = CARD_LESSONS_LIMIT): string {
  const found = lessonsForRoot(root);
  if (!found) return "";
  const mine = agentKey(persona);
  const items = found.lessons
    .filter((l) => l.kind === "rule" || (l.kind === "agent_rule" && agentKey(l.target) === mine))
    .map((l) => `- ${line(l.text)} (${l.kind === "agent_rule" ? "for you" : "this project"}, postmortem ${l.pm})`);
  if (!items.length) return "";
  return `## Lessons from earlier postmortems\n\n${within(items, limit - 60).join("\n")}`;
}

/** The card option for a task: its lessons from the run's project, or nothing. Reads the store; never throws. */
export function cardLessons(state: Readonly<BlackboardState>, taskId: string): { lessons?: string } {
  const root = state.contract?.scope.repo_root;
  const persona = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId].spec.persona : undefined;
  if (!root || persona === undefined) return {};
  const lessons = cardSection(root, persona);
  return lessons ? { lessons } : {};
}
