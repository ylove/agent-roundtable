// ============================================================================
// The hold_postmortem tool (docs/design/postmortem.md §5, §9)
//
// Seats the agents that did the work, runs the postmortem meeting, and (action: "conclude") closes
// it with the orchestrator's decisions. Orchestrator server only; the logic lives in
// src/postmortem/meeting.ts.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "../config.js";
import { scopeOf } from "../postmortem/draft.js";
import { concludePostmortem, holdPostmortem } from "../postmortem/meeting.js";
import { resolveProject } from "../postmortem/project.js";
import { LIMITS } from "../postmortem/types.js";
import { HOLD_POSTMORTEM } from "./names.js";
import { checkScope, EXECUTION_ID, missing, PM_PATTERN, PROJECT, render, WORK } from "./postmortem.js";
import { ORCHESTRATOR_ONLY, PROVIDER_PROPS, validateProviderOptions, type ToolArgs, type ToolDefinition } from "./shared.js";

export const HOLD_ACTIONS = ["hold", "conclude"] as const;

function checkHoldArgs(a: Record<string, unknown>): void {
  validateProviderOptions(a.provider as LLMProvider | undefined, a.base_url as string | undefined);
  const need = (field: string, why: string) => a[field] === undefined || a[field] === null || (typeof a[field] === "string" && !(a[field] as string).trim()) ? missing(HOLD_POSTMORTEM, field, why) : undefined;
  if (a.action === "conclude") {
    need("pm", "for conclude");
    need("closing", "for conclude: your closing statement, the last turn of the record");
    return;
  }
  need("project", "for hold");
  checkScope(HOLD_POSTMORTEM, a);
  need("opening", "for hold: your account of what happened, including your own part (turn 0 of the meeting)");
}

export const holdPostmortemTools: ToolDefinition[] = [
  {
    name: HOLD_POSTMORTEM,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkHoldArgs,
    annotations: { title: "Hold postmortem", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      "Hold the postmortem meeting for a draft, then conclude it. Refused while any finding's fix is pending or a task with a finding is still running (the error names what); a draft with no findings closes with no meeting. " +
      "action hold (default): every agent named in a finding, every agent that did the original work in the run (or the participants you pass), and you sit at the table. opening is your account of what happened, including your own part: turn 0. " +
      "The format is waffle-house when exactly one agent is responsible for every finding (it defends, the others challenge, your opening is the charge), otherwise collaborate for rounds (default 2, 1-4); format forces either. " +
      "The meeting is private and takes no outside input: the human has no seat, nothing they type reaches it, and its context never carries their chat, confirmation or original request. " +
      "It ends with an artifact block, one line each: Artifact: <kind> | <target> | <finding ids> | <text>. Kinds: fix (follow-up), rule and contract rule (project lessons, read before the next plan and contract), persona addendum (appended to an agent's persona file under ## Postmortem addenda, with a backup), agent rule (shown in that agent's task card), memory (the agent's memory file; memory_target: \"claude\" also writes the repository's .claude/agent-memory). " +
      "The result has the transcript, the proposed artifacts and any lines that could not be used. " +
      "action conclude: pm, your closing statement, and accept[] (artifact ids) / reject[{id, why}]. Only accepted artifacts take effect, each audited. The result has a summary and the record path to relay to the human, who can read every turn (postmortem read).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...HOLD_ACTIONS], description: "hold (default) or conclude." },
        project: PROJECT,
        execution_id: EXECUTION_ID,
        work: WORK,
        opening: { type: "string", maxLength: LIMITS.opening, description: "hold: your account of what happened, including your own part. Do not paste the human's words." },
        participants: { type: "array", maxItems: LIMITS.seats, items: { type: "string" }, description: "hold: agents to seat in addition to those named in findings (for at-the-table work: everyone who did it)." },
        format: { type: "string", enum: ["collaborate", "waffle-house"], description: "hold: force a format (default: waffle-house for a single responsible agent, else collaborate)." },
        rounds: { type: "integer", minimum: LIMITS.rounds.min, maximum: LIMITS.rounds.max, description: "hold: rounds (default 2)." },
        memory_target: { type: "string", enum: ["claude"], description: "hold: with \"claude\", accepted memory artifacts are also appended to <repo>/.claude/agent-memory/<agent>/MEMORY.md (refused through symlinks)." },
        pm: { type: "string", pattern: PM_PATTERN, description: "conclude: the postmortem (pm-…) hold returned." },
        closing: { type: "string", maxLength: LIMITS.closing, description: "conclude: your closing statement, the last turn of the record." },
        accept: { type: "array", maxItems: LIMITS.artifacts, items: { type: "string" }, description: "conclude: ids of the artifacts to apply (a1, a2, …)." },
        reject: {
          type: "array",
          maxItems: LIMITS.artifacts,
          description: "conclude: artifacts you turn down, each with why.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", maxLength: 16, description: "The artifact id.", "x-nonblank": true },
              why: { type: "string", maxLength: 400, description: "Why not.", "x-nonblank": true },
            },
            required: ["id", "why"],
          },
        },
        ...PROVIDER_PROPS,
      },
    },
  },
];

/** Dispatch hold_postmortem. Errors are thrown to handleToolCall, which formats them. */
export async function handleHoldPostmortemTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  if (name !== HOLD_POSTMORTEM) throw new Error(`Unknown tool: ${name}`);
  // null means "not given", as in validation.
  const a = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined)) as Record<string, unknown>;
  if (a.action === "conclude") {
    return render(await concludePostmortem({
      pm: a.pm as string, closing: a.closing as string, accept: a.accept as string[] | undefined, reject: a.reject as Array<{ id: string; why: string }> | undefined,
    }));
  }
  const project = await resolveProject(a.project as string);
  return render(await holdPostmortem({
    project, scope: scopeOf(a), opening: a.opening as string,
    llm: { provider: a.provider as LLMProvider | undefined, model: a.model as string | undefined, baseUrl: a.base_url as string | undefined },
    ...(a.participants !== undefined && { participants: a.participants as string[] }),
    ...(a.format !== undefined && { format: a.format as "collaborate" | "waffle-house" }),
    ...(a.rounds !== undefined && { rounds: a.rounds as number }),
    ...(a.memory_target === "claude" && { memoryTarget: "claude" as const }),
  }));
}
