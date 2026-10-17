// ============================================================================
// Usage tool (orchestrator server only): who is using what, on which platform (usage-visibility.md §8)
//
// The same view the status line, the usage CLI and the dashboard show, for the host model itself: it
// needs it to answer "what has cfo cost so far?", to stop an agent when the human asks in chat, and
// to write a handoff for a stopped session. The logic lives in src/usage/.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openExecutionStore, executionDir } from "../execution/store.js";
import { writeRunHandoff, writeSessionHandoff } from "../usage/handoff.js";
import { collectUsage, filterView } from "../usage/model.js";
import { redactedView } from "../usage/redacted.js";
import { readHostFigures } from "../usage/statusline.js";
import { orchestratorDeps } from "../execution/orchestrator.js";
import { resolveStopTarget, performStop, StopRefusal } from "../usage/control.js";
import { USAGE } from "./names.js";
import { ORCHESTRATOR_ONLY, type ToolArgs, type ToolDefinition } from "./shared.js";

export const USAGE_ACTIONS = ["report", "stop", "handoff"] as const;

export const usageTools: ToolDefinition[] = [
  {
    name: USAGE,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Usage", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description:
      "Who is using what, on which platform, for the heads-down runs and the sessions at the table. action report (default) returns the usage view: totals, platforms (provider and models), " +
      "and one entry per agent with its tokens and money, where it works (heads-down, at-the-table or the host), its state and whether it can be stopped, plus recent stops. " +
      "Every figure says whether it is measured (counted by whoever did the work), reported (told to us by an agent or the host) or estimated (worked out by us); a total that mixes them shows the split. " +
      "Money for a model with no price is absent: you get its tokens instead. Narrow it with execution_id, session_id or agent (\"what has cfo cost so far?\"). Nothing in it is message text, a prompt, a diff or command output. " +
      "stop (only when the human asks you to stop an agent): stops agent, a heads-down worker (the runner stops it, keeps its work, and wakes you with two choices) or an at-the-table session (its turn in flight is cut and the session ends; " +
      "name execution_id or session_id when the agent is in more than one place). A stopped session answers {status: \"stopped\", …} to its next tool call. " +
      "handoff: write a handoff document, for a stopped or ended session (session_id: sessions/<id>.handoff.md) or for a heads-down run (execution_id: HANDOFF.md, without pausing it; control_execution(action: \"handoff\") pauses first).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...USAGE_ACTIONS], description: "report (default), stop or handoff." },
        execution_id: { type: "string", pattern: "^exe-[0-9a-hjkmnp-tv-z]{16}$", description: "Only this heads-down run (exe-…)." },
        session_id: { type: "string", maxLength: 100, description: "Only this at-the-table session." },
        agent: { type: "string", maxLength: 100, description: "report: only this agent (persona or worker id). stop: the agent to stop (required)." },
        reason: { type: "string", maxLength: 1000, description: "stop: why (recorded on the stop and shown to the orchestrator)." },
      },
    },
  },
];

function render(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Dispatch the usage tool. Errors are thrown to handleToolCall, which formats them. */
export async function handleUsageTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  if (name !== USAGE) throw new Error(`Unknown tool: ${name}`);
  const a = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined)) as Record<string, string>;
  const action = a.action ?? "report";
  switch (action) {
    case "report": {
      const host = readHostFigures();
      const view = await collectUsage({ ...(a.execution_id && { executions: [a.execution_id] }), ...(host && { host }) });
      const narrowed = a.session_id || a.agent || a.execution_id ? filterView(view, { execution: a.execution_id, session: a.session_id, agent: a.agent }) : view;
      return render(redactedView(narrowed));
    }
    case "stop": {
      if (!a.agent?.trim()) throw new Error('usage: "agent" is required for stop: the agent to stop');
      try {
        const view = await collectUsage({});
        const target = resolveStopTarget(view, a.agent.trim(), { execution: a.execution_id, session: a.session_id });
        return render(await performStop(target, { surface: "tool", ensureRunner: (exe) => orchestratorDeps().ensureRunner(exe), ...(a.reason?.trim() && { reason: a.reason.trim() }) }));
      } catch (e) {
        if (e instanceof StopRefusal) throw new Error(e.message);
        throw e;
      }
    }
    case "handoff": {
      if (a.execution_id) {
        if (!existsSync(join(executionDir(a.execution_id), "execution.json"))) throw new Error(`Execution ${a.execution_id} not found`);
        const w = writeRunHandoff(await (await openExecutionStore(a.execution_id)).state());
        return render({ execution_id: a.execution_id, path: w.path, document: w.document });
      }
      if (!a.session_id) throw new Error('usage: handoff needs "session_id" (an at-the-table session) or "execution_id" (a heads-down run)');
      const w = writeSessionHandoff(a.session_id);
      return render({ session_id: a.session_id, path: w.path, document: w.document });
    }
    default:
      throw new Error(`Unknown action ${JSON.stringify(action)}`);
  }
}
