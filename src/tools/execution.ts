// ============================================================================
// Run tools (heads-down): execute, execution_status, control_execution, resolve_escalation
// (heads-down.md §13, §15). Orchestrator server only; the logic lives in src/execution/.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "../config.js";
import { MAX_PARALLEL_LIMIT } from "../execution/contract.js";
import {
  controlExecution,
  execute,
  resolveFromOrchestrator,
  type ControlInput,
  type ExecuteInput,
  type ResolveInput,
} from "../execution/orchestrator.js";
import { executionStatusReport, STATUS_VIEWS, type StatusInput } from "../execution/status-report.js";
import { CONTROL_EXECUTION, EXECUTE, EXECUTION_STATUS, RESOLVE_ESCALATION } from "./names.js";
import { ORCHESTRATOR_ONLY, PROVIDER_PROPS, validateProviderOptions, type ToolArgs, type ToolDefinition } from "./shared.js";

const EXECUTION_PATTERN = "^exe-[0-9a-hjkmnp-tv-z]{16}$";
const EXECUTION_ID = { type: "string", pattern: EXECUTION_PATTERN, description: "The heads-down run (exe-…), as execute or execution_status returned it." } as const;

export const CONTROL_ACTIONS = ["pause", "resume", "steer", "abort", "purge"] as const;
export const RESOLUTION_ACTIONS = ["decide", "huddle", "retry", "reassign", "amend", "dismiss", "await_human"] as const;
export const HUDDLE_FORMATS = ["micro", "meeting", "collaborate", "debate", "waffle-house", "conversation", "replan", "ultraplan"] as const;

export const executionTools: ToolDefinition[] = [
  {
    name: EXECUTE,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Execute contract", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "Start a heads-down run of a frozen contract, ONLY when the human has asked for it in this chat: confirmation is their words, verbatim (recorded in the event log and the audit log). " +
      "A preflight runs first. When something is missing it returns {status: \"needs_input\", questions[]} and starts nothing: ask the human each question in plain words and call again with the answers. " +
      "It asks when no visibility is chosen (dashboard, GitHub, or chat_only; ROUNDTABLE_DEFAULT_VISIBILITY sets a default), when no budget is set (here, in the contract, or ROUNDTABLE_DEFAULT_BUDGET_USD), " +
      "when no sandbox is available (Docker down and the local sandbox not allowed with sandbox: \"local\"), when the worker CLI is missing or lacks flags (codex needs worker_driver: \"codex\"), " +
      "when GitHub was asked for but gh lacks scopes or access, and when the repository has submodules. A dirty main worktree only warns. " +
      "Settings given here that differ from the contract (budget_usd, max_parallel, lead, sandbox, worker_driver, worker_model) are applied to it first as one audited amendment. " +
      "Then the runner starts in the background, and the result has the execution_id, the runner's pid, the dashboard URL (when there is one) and watch {argv, command, instructions}: start watch.command as a background shell command right away, " +
      "re-arm it after handling each wake, and answer progress questions with execution_status. Calling it again for a started run returns the run's current info.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contract_id: { type: "string", description: "The frozen contract (ctr-<6 characters>-<n>).", "x-nonblank": true, "x-hint": "the contract id from propose_contract" },
        confirmation: {
          type: "string",
          maxLength: 2000,
          description: "The human's own words asking you to execute, quoted verbatim (e.g. \"yes, go ahead and build it\"). Never invent it.",
          "x-nonblank": true,
          "x-hint": "quote the human's words asking you to execute",
        },
        visibility: {
          type: "object",
          additionalProperties: false,
          description: "How the human follows the run: dashboard (a local web page), github (issues and a project board), or chat_only (neither). Ask the human; dashboard and github may be combined.",
          properties: {
            dashboard: { type: "boolean", description: "A read-only dashboard on 127.0.0.1, served by the runner; its URL is a private capability." },
            chat_only: { type: "boolean", description: "No dashboard and no GitHub: you keep the human posted here." },
            github: {
              type: "object",
              additionalProperties: false,
              description: "Mirror the run to GitHub through the gh CLI: a parent issue, one issue per task, a project board, needs-human labels and comments.",
              properties: {
                repo: { type: "string", description: "owner/name of a repository the gh account can write to.", "x-nonblank": true },
                project_owner: { type: "string", description: "The project's owner (default: the repository owner)." },
                project_number: { type: "integer", minimum: 1, description: "An existing GitHub project to add the task issues to." },
                create_project: { type: "boolean", description: "Create a project when no project_number is given." },
                pr: { type: "boolean", description: "Open a pull request for the integration branch at the end." },
              },
              required: ["repo"],
            },
          },
        },
        budget_usd: { type: "number", minimum: 0.01, maximum: 100000, description: "The run's total budget in US dollars, as the human set it (applied to the contract)." },
        max_parallel: { type: "integer", minimum: 1, maximum: MAX_PARALLEL_LIMIT, description: `Workers at once (1–${MAX_PARALLEL_LIMIT}; applied to the contract).` },
        lead: { type: "string", description: "The persona that decides escalations when you are away (the contract's authority.lead)." },
        sandbox: { type: "string", enum: ["docker", "local"], description: "docker (default) or local. local is weaker than a container and counts as the human's opt-in to it." },
        worker_driver: { type: "string", enum: ["claude-code", "codex"], description: "Worker CLI: claude-code (default) or codex (an explicit opt-in)." },
        worker_model: { type: "string", description: "Model for the workers (the CLI's model name)." },
      },
      required: ["contract_id", "confirmation"],
    },
  },
  {
    name: EXECUTION_STATUS,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Execution status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "How a heads-down run is doing. Without execution_id: every run with its status. With one, view summary (default) gives weighted completion (accepted 1, submitted 0.8, otherwise the worker's percent or 0.4), " +
      "blockers, the latest checks, a rough ETA, the budget, runner health, the dashboard URL and GitHub sync health; tasks, escalations, events (since_seq, limit), budget and context are the other views. " +
      "focus answers questions such as \"how close is the nav?\": fuzzy words and prefixes matched against task ids, titles, teams, paths and interface names (\"nav\" finds build-nav-bar and src/components/nav/**); " +
      "an escalation id as focus picks that escalation for view context. view context returns a redacted bundle (no chat, no secrets) to pass to a format at the table. " +
      "Restarts the runner of a live run that lost it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        execution_id: EXECUTION_ID,
        focus: { type: "string", maxLength: 200, description: "What the human asked about, in their words (\"the nav\", \"api client\", a task id, or an escalation id)." },
        view: { type: "string", enum: [...STATUS_VIEWS], description: "summary (default), tasks, escalations, events, budget or context." },
        since_seq: { type: "integer", minimum: 0, description: "view events: start after this sequence number (default: the latest limit events)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many runs, tasks, escalations or events (default 20 runs, 50 otherwise)." },
      },
    },
  },
  {
    name: CONTROL_EXECUTION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Control execution", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Steer a heads-down run when the human asks. pause / resume: the whole run, or only task_ids (paused work starts nothing new; running workers finish their turn). " +
      "steer: a directive (message) to targets (agents, teams or tasks; default every agent), which workers must acknowledge. abort: stop the run and its workers, keeping the worktrees, branches and log. " +
      "purge: delete a finished (completed, failed or aborted) run's worktrees, branches and log; needs confirm: true, which only the human's agreement justifies, and is audited. " +
      "Back to the table: pause with to_table: true (recorded in the log as a mode change), run the format with execution_status(view: \"context\"), amend_contract(from_session), then resume with to_table: true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        execution_id: EXECUTION_ID,
        action: { type: "string", enum: [...CONTROL_ACTIONS], description: "pause, resume, steer, abort or purge." },
        reason: { type: "string", maxLength: 1000, description: "Why (recorded on the event)." },
        message: { type: "string", maxLength: 4000, description: "steer: the directive, in plain words." },
        task_ids: { type: "array", maxItems: 100, items: { type: "string" }, description: "pause / resume: only these tasks (default the whole run)." },
        targets: { type: "array", maxItems: 50, items: { type: "string" }, description: "steer: agent, team or task ids (default every agent of the run)." },
        confirm: { type: "boolean", description: "purge: true once the human agreed to delete the run's worktrees, branches and log." },
        to_table: { type: "boolean", description: "pause: going back to the table; resume: coming back. Records the mode change in the log." },
        session: { type: "string", maxLength: 200, description: "With to_table: the at-the-table session id, recorded with the mode change." },
      },
      required: ["execution_id", "action"],
    },
  },
  {
    name: RESOLVE_ESCALATION,
    modes: ORCHESTRATOR_ONLY,
    precheck: (args) => validateProviderOptions(args.provider as LLMProvider | undefined, args.base_url as string | undefined),
    annotations: { title: "Resolve escalation", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "Answer an escalation the watcher woke you for (execution_status(view: \"escalations\") lists them). action: decide (decision is the answer, delivered to the requester, who resumes), " +
      "huddle (a format with participants: micro by default, or meeting, collaborate, debate, waffle-house, conversation, replan, ultraplan; calls the provider), retry, reassign (participants[0] takes the task over), " +
      "amend (amendment is a merge patch of the contract), dismiss, or await_human (only when the human must act). resolved_by defaults to the contract's orchestrator. " +
      "An escalation already resolved is returned unchanged. The runner applies any resume, retry or stop on its next tick.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        execution_id: EXECUTION_ID,
        escalation_id: { type: "string", maxLength: 128, description: "The escalation (esc-…).", "x-nonblank": true },
        action: { type: "string", enum: [...RESOLUTION_ACTIONS], description: "decide, huddle, retry, reassign, amend, dismiss or await_human." },
        decision: { type: "string", maxLength: 2000, description: "decide: the answer; otherwise the resolution text the requester sees." },
        format: { type: "string", enum: [...HUDDLE_FORMATS], description: "huddle: the format (default micro)." },
        participants: { type: "array", maxItems: 12, items: { type: "string" }, description: "huddle: the personas taking part; reassign: [the persona taking the task over]." },
        amendment: { type: "object", description: "amend: an RFC 7396 merge patch of the contract (as for amend_contract)." },
        resolved_by: { type: "string", description: "Who resolves: the contract's orchestrator (default) or its lead." },
        ...PROVIDER_PROPS,
      },
      required: ["execution_id", "escalation_id", "action"],
    },
  },
];

function render(body: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Dispatch one run tool. Errors are thrown to handleToolCall, which formats them. */
export async function handleExecutionTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  // null means "not given", as in validation.
  const a = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined));
  switch (name) {
    case EXECUTE:
      return render(await execute(a as unknown as ExecuteInput));
    case EXECUTION_STATUS:
      return render(await executionStatusReport(a as StatusInput));
    case CONTROL_EXECUTION:
      return render(await controlExecution(a as unknown as ControlInput));
    case RESOLVE_ESCALATION:
      return render(await resolveFromOrchestrator(a as unknown as ResolveInput));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
