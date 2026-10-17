// ============================================================================
// Usage tool (orchestrator server only): who is using what, on which platform (usage-visibility.md §8)
//
// The same view the status line, the usage CLI and the dashboard show, for the host model itself: it
// needs it to answer "what has cfo cost so far?". The logic lives in src/usage/.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { collectUsage, filterView, redactedView } from "../usage/model.js";
import { readHostFigures } from "../usage/statusline.js";
import { USAGE } from "./names.js";
import { ORCHESTRATOR_ONLY, type ToolArgs, type ToolDefinition } from "./shared.js";

export const USAGE_ACTIONS = ["report"] as const;

export const usageTools: ToolDefinition[] = [
  {
    name: USAGE,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Usage", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Who is using what, on which platform, for the heads-down runs and the sessions at the table. action report (default) returns the usage view: totals, platforms (provider and models), " +
      "and one entry per agent with its tokens and money, where it works (heads-down, at-the-table or the host), its state and whether it can be stopped, plus recent stops. " +
      "Every figure says whether it is measured (counted by whoever did the work), reported (told to us by an agent or the host) or estimated (worked out by us); a total that mixes them shows the split. " +
      "Money for a model with no price is absent: you get its tokens instead. Narrow it with execution_id, session_id or agent (\"what has cfo cost so far?\"). " +
      "Nothing in it is message text, a prompt, a diff or command output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: [...USAGE_ACTIONS], description: "report (default)." },
        execution_id: { type: "string", pattern: "^exe-[0-9a-hjkmnp-tv-z]{16}$", description: "Only this heads-down run (exe-…)." },
        session_id: { type: "string", maxLength: 100, description: "Only this at-the-table session." },
        agent: { type: "string", maxLength: 100, description: "Only this agent (persona or worker id)." },
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
  if (action !== "report") throw new Error(`Unknown action ${JSON.stringify(action)}`);
  const host = readHostFigures();
  const view = await collectUsage({ ...(a.execution_id && { executions: [a.execution_id] }), ...(host && { host }) });
  const narrowed = a.session_id || a.agent || a.execution_id ? filterView(view, { execution: a.execution_id, session: a.session_id, agent: a.agent }) : view;
  return render(redactedView(narrowed));
}
