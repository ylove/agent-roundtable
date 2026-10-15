// ============================================================================
// Goal review (#86): the lead checks the integrated result against the goal before completion
//
// Once every task is accepted and the final validation has run, the lead (contract.authority.lead)
// reviews the result against goal.ultimate and the verbatim original prompt, from the task
// summaries, the integration diff stat and the validation results, and answers
// `Verdict: COMPLETE | INCOMPLETE` with its gaps and, optionally, a fenced roundtable-tasks block of
// tasks that would close them. INCOMPLETE with tasks inside the lead's authority (add_task) amends
// the contract; a run gets GOAL_REVIEW_CYCLES reviews, counted from their note.posted events.
// Otherwise, or beyond the cap, the gaps go to the
// orchestrator as an escalation. Each review is recorded as a note (topic goal-review) with its
// usage (source lead); the provider call runs outside transact.
// ============================================================================

import { createHash } from "node:crypto";
import { join } from "node:path";
import { blockToContract, findTaskBlock, TASK_BLOCK_TAG } from "./contract-parse.js";
import {
  UsageMeter,
  actorSource,
  askPersona,
  cap,
  errText,
  ev,
  oneLine,
  own,
  recordDrafts,
  verdictOf,
  type HookCtx,
} from "./escalation.js";
import { AuthorityError, amendContract } from "./contract-lifecycle.js";
import { acquireLock } from "./lock.js";
import { integrationWorktreePath, taskDiffSummary } from "./worktrees.js";
import type { AnyEventDraft, BlackboardState, Contract, Escalation, TaskSpec } from "./types.js";

export const GOAL_REVIEW_CYCLES = 2;
/** The reason prefix of amendments produced by goal review. */
export const GOAL_REVIEW_REASON = "Goal review";
export const GOAL_REVIEW_TOPIC = "goal-review";

export interface GoalReviewResult {
  verdict: "COMPLETE" | "INCOMPLETE";
  gaps: string[];
  /** Task ids the review added to the contract. */
  added: string[];
  /** The contract version the added tasks are in. */
  amended?: number;
  /** The escalation raised to the orchestrator (beyond the cap, outside authority, or nothing to add). */
  escalation?: string;
}

const LEAD_DIRECTIVE =
  "\n\n## Goal review\n" +
  "You are the lead of this heads-down run. Every task is merged. Judge the integrated result against the goal and the human's original request, strictly: " +
  "COMPLETE only when nothing the request asks for is missing.";

const VERDICTS = ["COMPLETE", "INCOMPLETE"] as const;

/** The bulleted lines under `Gaps:` (a value on the label line counts too); "None" means no gaps. */
export function parseGaps(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*(?:#+\s*)?[*_]*gaps[*_]*\s*:/i.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  const first = lines[at].replace(/^[^:]*:\s*/, "").replace(/^[*_\s]+/, "").trim();
  if (first) out.push(first);
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) break;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (m) out.push(m[1].trim());
    else if (l.trim()) break;
  }
  return out.filter((g) => g && !/^none\.?$/i.test(g)).slice(0, 20).map((g) => oneLine(g, 500));
}

async function integrationStat(ctx: HookCtx): Promise<string | undefined> {
  try {
    return (await taskDiffSummary(integrationWorktreePath(ctx.store.id), ctx.header.base_sha)).stat || undefined;
  } catch {
    return undefined;
  }
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return `${"`".repeat(longest + 1)}\n${text}\n${"`".repeat(longest + 1)}`;
}

export function buildGoalReviewPrompt(state: Readonly<BlackboardState>, c: Contract, stat: string | undefined, cycle: number): string {
  const goal = state.goal ?? c.goal;
  const tasks = Object.entries(state.tasks).slice(0, 60).map(([id, rt]) => {
    const parts = [`- \`${id}\` (${rt.state}): ${oneLine(rt.spec.title, 200)}`];
    if (rt.last_note) parts.push(`  Summary: ${oneLine(rt.last_note, 400)}`);
    const diff = own(state.diffs, id);
    if (diff?.stat) parts.push(`  Changes: ${oneLine(diff.stat, 200)}`);
    return parts.join("\n");
  });
  const checks = Object.entries(state.checks.integration).map(([id, ck]) => `- ${id}: ${ck.status}${ck.signature ? ` (${ck.signature.slice(0, 12)})` : ""}`);
  const final = c.validation.final.length ? c.validation.final : c.validation.commands.map((x) => x.id);
  return [
    `## Ultimate goal\n\n${cap(goal.ultimate, 2000)}`,
    `## The original request (verbatim)\n\n${fence(cap(goal.original_prompt, 6000))}`,
    `## Tasks\n\n${tasks.join("\n") || "(none)"}`,
    `## Integration\n\n${stat ? `Diff against the base: ${oneLine(stat, 300)}` : "(no diff stat available)"}`,
    `## Validation\n\nFinal commands: ${final.join(", ") || "(none)"}\n${checks.join("\n") || "(no integration results recorded)"}`,
    `## Your answer (review ${cycle + 1}; at most ${GOAL_REVIEW_CYCLES} reviews per run)\n\n` +
      "Reply with exactly:\nVerdict: COMPLETE | INCOMPLETE\nGaps:\n- <what is missing or wrong, one per line; \"None\" when complete>\n\n" +
      `When INCOMPLETE and new tasks would close the gaps, end with a fenced \`\`\`${TASK_BLOCK_TAG} block holding only "tasks": the new tasks, with new ids, ` +
      `each with title, persona (one of: ${[...new Set(c.tasks.map((t) => t.persona))].slice(0, 12).join(", ")}), depends_on, paths.write, acceptance and checks ` +
      `(command ids: ${c.validation.commands.map((x) => x.id).join(", ") || "none"}).`,
  ].join("\n\n");
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Every completed review counts, including a review that could not add tasks. */
async function priorReviews(ctx: HookCtx): Promise<string[]> {
  return (await ctx.store.events({ types: ["note.posted"] }))
    .filter((e) => e.type === "note.posted" && e.payload.topic === GOAL_REVIEW_TOPIC && e.correlation?.startsWith("goal-review:"))
    .map((e) => e.type === "note.posted" ? e.payload.text : "");
}

/**
 * The lead's goal review. COMPLETE returns at once; INCOMPLETE adds the proposed tasks within the
 * lead's authority (at most GOAL_REVIEW_CYCLES reviews per run), or escalates the gaps to the
 * orchestrator. Throws only when there is no frozen contract or the lead's call fails.
 */
export async function goalReview(ctx: HookCtx): Promise<GoalReviewResult> {
  const release = await acquireLock(join(ctx.store.dir, "goal-review.lock"), { staleMs: 10_000, timeoutMs: 30_000 });
  try {
    return await review(ctx);
  } finally {
    await release();
  }
}

async function review(ctx: HookCtx): Promise<GoalReviewResult> {
  const state = await ctx.store.state();
  const c = state.contract;
  if (!c) throw new Error(`Execution ${ctx.store.id} has no frozen contract`);
  const lead = c.authority.lead;
  const actor = { kind: "lead" as const, id: lead };
  const source = actorSource(actor);
  const reviews = await priorReviews(ctx);
  const cycles = reviews.length;
  if (cycles >= GOAL_REVIEW_CYCLES) {
    const gaps = parseGaps(reviews.at(-1) ?? "");
    const escalation = await escalateGaps(ctx, c, gaps, `${GOAL_REVIEW_CYCLES} review cycles have already run`, "cap", []);
    return { verdict: "INCOMPLETE", gaps, added: [], escalation };
  }
  const meter = new UsageMeter("lead");
  const correlation = `goal-review:${c.version}:${cycles}`;

  let answer: string;
  try {
    answer = await askPersona(meter, ctx.llm, lead, LEAD_DIRECTIVE, buildGoalReviewPrompt(state, c, await integrationStat(ctx), cycles) + (ctx.integrationSha ? `\n\nIntegration commit: ${ctx.integrationSha}` : ""));
  } finally {
    await recordDrafts(ctx.store, meter.take(source, correlation));
  }
  const parsed = verdictOf(answer, "Verdict", VERDICTS);
  const verdict = parsed === "COMPLETE" ? "COMPLETE" : "INCOMPLETE";
  const gaps = parsed === "UNCLEAR" ? ["the goal review gave no Verdict line"] : parseGaps(answer);
  const note = ev("note.posted", { topic: GOAL_REVIEW_TOPIC, text: cap(`Verdict: ${verdict}${gaps.length ? `\nGaps:\n${gaps.map((g) => `- ${g}`).join("\n")}` : ""}`, 6000), refs: [] }, source, correlation);
  await recordDrafts(ctx.store, [note]);
  if (verdict === "COMPLETE") {
    return { verdict, gaps, added: [] };
  }

  let proposed: TaskSpec[] = [];
  let why: string | undefined;
  try {
    const block = findTaskBlock(answer);
    if (block !== undefined) {
      const parsedBlock = blockToContract(block);
      const tasks = Array.isArray(parsedBlock.contract.tasks) ? (parsedBlock.contract.tasks as TaskSpec[]) : [];
      proposed = tasks.filter((t) => t && typeof t === "object" && typeof t.id === "string" && !c.tasks.some((x) => x.id === t.id));
    }
  } catch (e) {
    why = `its ${TASK_BLOCK_TAG} block is not usable: ${errText(e)}`;
  }
  if (!why && !proposed.length) why = "the review proposed no tasks to close the gaps";
  else if (!why && !c.authority.may.includes("add_task")) why = 'the lead\'s authority does not include "add_task"';

  if (!why) {
    try {
      const r = await amendContract(ctx.store, { tasks: [...c.tasks, ...proposed] }, {
        by: lead, authority: [...c.authority.may], source,
        reason: `${GOAL_REVIEW_REASON} ${cycles + 1}: ${oneLine(gaps.join("; ") || "gaps found", 400)}`,
      });
      return { verdict, gaps, added: proposed.map((t) => t.id), amended: r.version };
    } catch (e) {
      why = `${e instanceof AuthorityError ? "the added tasks are outside the lead's authority" : "the added tasks could not be applied"}: ${errText(e).split("\n").slice(0, 4).join(" ")}`;
    }
  }
  const escalation = await escalateGaps(ctx, c, gaps, why, `${c.version}:${cycles}`, []);
  return { verdict, gaps, added: [], escalation };
}

/** One escalation per review situation (its id derives from the contract version and cycle), routed to the orchestrator. */
async function escalateGaps(ctx: HookCtx, c: Contract, gaps: string[], why: string, key: string, before: AnyEventDraft[]): Promise<string> {
  const id = `esc-gr${shortHash(`${ctx.store.id}:${key}`)}`;
  const lead = c.authority.lead;
  const source = actorSource({ kind: "lead", id: lead });
  const to = c.scope.orchestrator;
  await ctx.store.transact(({ state: s }) => {
    if (own(s.escalations, id)) return { events: [] };
    const esc: Escalation = {
      id, agent: lead, kind: "blocker", with: "orchestrator", target: to, blocking: false, status: "open", raised_seq: 0,
      summary: cap(`Goal review: the integrated result does not meet the goal yet, and ${why}. Gaps: ${gaps.join("; ") || "(none listed)"}`, 2000),
      question: "Add tasks with amend_contract, accept the result as it is, or ask the human?",
      options: ["Amend the contract with tasks for the gaps", "Accept the result and complete the run", "Ask the human"],
    };
    return { events: [...before, ev("escalation.raised", { escalation: esc }, source, id), ev("escalation.routed", { id, to, wake: true }, source, id)] };
  });
  return id;
}
