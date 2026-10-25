// ============================================================================
// Contract structure sources: a fenced roundtable-tasks block, or a structuring call
//
// propose_contract takes its structure from an explicit contract object first, then from the
// last ```roundtable-tasks block in the plan or in an archived session, and only then from a
// structuring call (prompt → extractJsonObject → validate → one retry quoting the errors, as the
// agent-creation architect does).
// ============================================================================

import { callLLM, type CallLLMOptions } from "../providers/index.js";
import type { ArchivedSession } from "../sessions/archive.js";
import { extractJsonObject, truncate } from "../sessions/workshop.js";

export const TASK_BLOCK_TAG = "roundtable-tasks";

/** The block's shape and rules: shared by the ultraplan prompts and the structuring call. */
export const TASK_BLOCK_FORMAT = `{
  "tasks": [
    {
      "id": "orders-api",
      "title": "Add the /orders API routes",
      "persona": "<participant who builds it>",
      "team": "<team id, optional>",
      "depends_on": [],
      "paths": { "write": ["src/api/orders/**"] },
      "acceptance": ["GET /orders returns only the caller's orders", "errors have unit tests"],
      "checks": ["test"]
    }
  ],
  "commands": [
    { "id": "test", "argv": ["npm", "test"], "timeout_s": 300 }
  ],
  "interfaces": [
    { "name": "OrdersApi", "kind": "api", "owner": "orders-api", "consumers": ["orders-page"], "description": "GET /orders response shape" }
  ]
}
Rules: ids (tasks, commands, teams) use lowercase letters, digits, ".", "_" or "-". persona is the participant who does the task. depends_on lists tasks that must be accepted first, with no cycles. paths.write are repository-relative globs using only **, * and ?; tasks that can run at the same time must not write the same paths. acceptance criteria are concrete and checkable. checks name commands that prove the task works. A web task can also set "verify": [{"page_loads": {"path": "index.html"}}] to check a committed page loads without exceptions in local Chrome (skipped with a note when no browser exists). A command's argv is the program and its arguments as an array, never a shell line such as "sh -c ...", and timeout_s is at most 900. interfaces are what one task produces for others: owner and consumers are task ids. Optional keys: "teams" [{"id", "lead", "members"}], "decisions" [{"id", "text", "rationale"}], "final" (command ids for the final validation; default all), "participants" (agents who must consent; every task persona is added), "budget" {"usd", "per_task_usd", "wall_clock_min", "max_parallel", "max_agents" (optional, 1–32; >=2 enables swarms), "max_subtasks" (optional, default 16, 1–64)} (without it a placeholder budget is used and flagged).`;

/** For planner prompts: end the plan with the block. */
export function buildTaskBlockInstructions(): string {
  return "## Execution-ready plan\n" +
    `This plan will be executed heads-down by worker agents in parallel. End it with a fenced \`\`\`${TASK_BLOCK_TAG} block holding one JSON object: ` +
    "the machine-readable version of the plan that the contract is built from, consistent with the steps above.\n\n" +
    `\`\`\`${TASK_BLOCK_TAG}\n${TASK_BLOCK_FORMAT}\n\`\`\``;
}

/** For sign-off prompts. */
export const TASK_BLOCK_SIGNOFF_CHECK =
  `Tasks block: check the \`\`\`${TASK_BLOCK_TAG} block at the end of the plan. It must match the plan; your tasks must be doable within their write paths and checks; dependencies, interfaces and commands must be right. Object if they are not.`;

/** Appended to the orchestrator's next step when it writes the plan itself. */
export const TASK_BLOCK_NEXT =
  `This ultraplan is execution_ready: end the plan with a fenced \`\`\`${TASK_BLOCK_TAG} JSON block (tasks with id, title, persona, team, depends_on, paths.write, acceptance and checks; commands with id, argv and timeout_s; interfaces with name, kind, owner, consumers and description), so propose_contract can build the contract from it.`;

// ---------------------------------------------------------------------------
// Finding and reading a block
// ---------------------------------------------------------------------------

const BLOCK_RE = new RegExp("```" + TASK_BLOCK_TAG + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");

/** The JSON of the last roundtable-tasks block in `text`, or undefined when there is none. Invalid JSON throws. */
export function findTaskBlock(text: string | undefined): unknown {
  if (typeof text !== "string" || !text.includes(TASK_BLOCK_TAG)) return undefined;
  const blocks = [...text.matchAll(BLOCK_RE)];
  const last = blocks.at(-1);
  if (!last) return undefined;
  try {
    return JSON.parse(last[1]);
  } catch (e) {
    throw new Error(`The ${TASK_BLOCK_TAG} block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const BLOCK_KEYS = ["tasks", "commands", "interfaces", "teams", "decisions", "final", "validation", "budget", "participants"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A block (or a structuring answer) as a partial contract: tasks, interfaces, teams, decisions,
 * budget and participants as given, commands and final under validation. Unknown keys are errors.
 */
export function blockToContract(value: unknown): { contract: Record<string, unknown>; errors: string[] } {
  if (!isObj(value)) return { contract: {}, errors: [`the ${TASK_BLOCK_TAG} JSON must be an object`] };
  const errors = Object.keys(value).filter((k) => !BLOCK_KEYS.includes(k))
    .map((k) => `${JSON.stringify(k)} is not a known key (expected: ${BLOCK_KEYS.join(", ")})`);
  const contract: Record<string, unknown> = {};
  for (const key of ["tasks", "interfaces", "teams", "decisions", "budget", "participants"]) if (value[key] !== undefined) contract[key] = value[key];
  const nested = isObj(value.validation) ? value.validation : {};
  if (value.validation !== undefined && !isObj(value.validation)) errors.push(`"validation" must be an object`);
  const commands = value.commands ?? nested.commands;
  const final = value.final ?? nested.final;
  if (commands !== undefined || final !== undefined) {
    contract.validation = { ...(commands !== undefined && { commands }), ...(final !== undefined && { final }) };
  }
  if (contract.tasks === undefined) errors.push(`"tasks" is required`);
  return { contract, errors };
}

// ---------------------------------------------------------------------------
// Archived sessions
// ---------------------------------------------------------------------------

export interface BlockText {
  /** Where the text came from, for messages ("ultraplan-x plan v2"). */
  from: string;
  text: string;
  /** Set when a block found here deserves a warning (it came from a participant's turn). */
  warn?: string;
}

export interface SessionSource {
  /**
   * Texts that may hold a block, most authoritative first. For an ultraplan these are its plan
   * versions only, latest first: never the document or entries, whose blocks may come from a
   * participant's input or sign-off.
   */
  blockTexts: BlockText[];
  /** The text a structuring call works from: an ultraplan's final plan, else the summary and discussion. */
  planText: string;
  /** What the session was about: an ultraplan's task, a collaboration's topic. */
  topic: string;
  agents: string[];
  kind: string;
  /** Ultraplans only: whether the final plan was signed off. */
  signedOff?: boolean;
}

const PLAN_TEXT_LIMIT = 40_000;

export function sessionSource(archived: ArchivedSession): SessionSource {
  const doc = archived.document;
  if (archived.kind === "ultraplan" && doc) {
    return {
      blockTexts: [...doc.versions].reverse().filter((v) => typeof v.plan === "string" && v.plan.length > 0)
        .map((v) => ({ from: `${archived.id} plan v${v.version}`, text: v.plan })),
      planText: doc.versions.at(-1)?.plan ?? "",
      topic: archived.topic,
      agents: archived.agents,
      kind: archived.kind,
      signedOff: doc.signedOff,
    };
  }
  // Other sessions: the summary and the orchestrator's turns first, then agents' turns (latest first), with a warning.
  const texts: BlockText[] = [];
  if (archived.summary) texts.push({ from: `${archived.id} summary`, text: archived.summary });
  const turns = [...archived.turns].reverse();
  for (const t of turns) if (t.role !== "agent") texts.push({ from: `${archived.id} ${t.role} turn`, text: t.content });
  for (const t of turns) {
    if (t.role === "agent") texts.push({ from: `${archived.id} ${t.speaker} turn`, text: t.content, warn: `the ${TASK_BLOCK_TAG} block came from ${t.speaker}'s turn in ${archived.id}, not from a plan: review it before freezing` });
  }
  const transcript = archived.transcript.length > PLAN_TEXT_LIMIT ? "…[earlier discussion truncated]\n" + archived.transcript.slice(-PLAN_TEXT_LIMIT) : archived.transcript;
  return {
    blockTexts: texts.filter((t) => t.text.length > 0),
    planText: (archived.summary ? `## Summary\n\n${archived.summary}\n\n## Discussion\n\n` : "") + transcript,
    topic: archived.topic,
    agents: archived.agents,
    kind: archived.kind,
  };
}

// ---------------------------------------------------------------------------
// The structuring call
// ---------------------------------------------------------------------------

export interface StructuringRequest {
  goal: string;
  originalPrompt: string;
  plan: string;
  /** Agent refs that may own tasks. */
  participants: string[];
  scopePaths: string[];
}

export function buildStructuringSystemPrompt(): string {
  return "You are a neutral contract architect. You turn an agreed plan into a heads-down contract: tasks that worker agents build in parallel, " +
    "coordinating only through a shared event log. Keep to the work the plan calls for, and split it so tasks that run at the same time never write the same files. " +
    "Output exactly one JSON object and nothing else.";
}

export function buildStructuringPrompt(r: StructuringRequest): string {
  return "Turn this plan into the JSON object described below.\n\n" +
    `**Goal:** ${r.goal}\n\n` +
    `**Original request:**\n${truncate(r.originalPrompt, 4000)}\n\n` +
    `**Participants (task personas):** ${r.participants.length ? r.participants.join(", ") : "(none named: use the roles the plan names)"}\n\n` +
    `**Writable paths:** ${r.scopePaths.join(", ")}\n\n` +
    `**Plan:**\n${truncate(r.plan, PLAN_TEXT_LIMIT)}\n\n` +
    `**JSON object:**\n${TASK_BLOCK_FORMAT}\n\n` +
    "Return only the JSON object.";
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Ask for the structure, parse it with extractJsonObject, and have `check` validate it (it returns
 * the errors, or [] when the structure is usable). One retry gets the errors; a second failure throws.
 */
export async function structureContract(
  request: StructuringRequest,
  llm: CallLLMOptions,
  check: (structure: Record<string, unknown>) => Promise<string[]>
): Promise<{ structure: Record<string, unknown>; attempts: number }> {
  const system = buildStructuringSystemPrompt();
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: buildStructuringPrompt(request) }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await callLLM(system, messages, llm);
    let errors: string[];
    let structure: Record<string, unknown> = {};
    try {
      const parsed = blockToContract(extractJsonObject(output));
      structure = parsed.contract;
      errors = parsed.errors.length ? parsed.errors : await check(structure);
    } catch (e) {
      errors = [errorText(e)];
    }
    if (errors.length === 0) return { structure, attempts: attempt + 1 };
    const listed = errors.slice(0, 25).join("; ") + (errors.length > 25 ? `; and ${errors.length - 25} more` : "");
    if (attempt === 1) throw new Error(`The structuring call did not return a usable contract after one retry: ${listed}`);
    messages.push(
      { role: "assistant", content: output },
      { role: "user", content: `Your output was not usable: ${listed}. Return only the corrected JSON object.` },
    );
  }
  throw new Error("Structuring retry exhausted.");
}
