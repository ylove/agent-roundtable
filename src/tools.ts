// ============================================================================
// MCP tool schemas and dispatch: the public entry of the tool layer (groups live in src/tools/)
// ============================================================================

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertValid, publicSchema } from "./validate.js";
import { deliberationTools, handleDeliberationTool } from "./tools/deliberation.js";
import { contractTools, handleContractTool } from "./tools/contract.js";
import { executionTools, handleExecutionTool } from "./tools/execution.js";
import { handleHoldPostmortemTool, holdPostmortemTools } from "./tools/hold-postmortem.js";
import { handlePostmortemTool, postmortemTools } from "./tools/postmortem.js";
import { handleWorkerTool, workerTools } from "./tools/worker.js";
import { handlePreviewTool, previewTools } from "./tools/previews.js";
import { handleUsageTool, usageTools } from "./tools/usage.js";
import { schemaFor, type ToolArgs, type ToolCallContext, type ToolDefinition, type ToolGroup, type ToolMode } from "./tools/shared.js";
import { scrub } from "./security/secrets.js";
import { stoppedResult, stoppedSessionNamed } from "./usage/session-scope.js";
import { USAGE } from "./tools/names.js";

export { formatUltraplanResult, formatAgentWorkshopResult } from "./tools/shared.js";
export type { ToolCallContext, ToolMode } from "./tools/shared.js";

const groups: ToolGroup[] = [
  { definitions: deliberationTools, handle: handleDeliberationTool },
  { definitions: contractTools, handle: handleContractTool },
  { definitions: executionTools, handle: handleExecutionTool },
  { definitions: postmortemTools, handle: handlePostmortemTool },
  { definitions: holdPostmortemTools, handle: handleHoldPostmortemTool },
  { definitions: workerTools, handle: handleWorkerTool },
  { definitions: previewTools, handle: handlePreviewTool },
  { definitions: usageTools, handle: handleUsageTool },
];

const routes = new Map<string, { definition: ToolDefinition; group: ToolGroup }>();
for (const group of groups) {
  for (const definition of group.definitions) {
    if (routes.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
    routes.set(definition.name, { definition, group });
  }
}

/** A definition as clients of one mode see it: no `modes`, no schema extensions. */
function listed(definition: ToolDefinition, mode: ToolMode): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: publicSchema(schemaFor(definition, mode)) as Tool["inputSchema"],
    annotations: definition.annotations,
  };
}

/** The tools one server lists: "orchestrator" for the stdio server, "worker" for a heads-down worker's. */
export function toolsFor(mode: ToolMode): Tool[] {
  return [...routes.values()].filter(({ definition }) => definition.modes.includes(mode)).map(({ definition }) => listed(definition, mode));
}

/** The orchestrator server's tool list. */
export const tools: Tool[] = toolsFor("orchestrator");

/**
 * Check every given argument against the tool's schema (types, enums, constraints, nested fields) and
 * throw `<tool>: "<field>" ...` on the first problem. Missing required fields are not reported here:
 * handleToolCall checks them after the tool's cross-field checks. Unknown tools pass.
 */
export function checkArgs(tool: string, args: Record<string, unknown> | undefined, mode: ToolMode = "orchestrator"): void {
  const definition = routes.get(tool)?.definition;
  if (definition) assertValid(tool, schemaFor(definition, mode), args, ["values"]);
}

/** Values, then cross-field checks, then required fields: the order every error message relies on. */
function validateToolArgs(definition: ToolDefinition, args: Record<string, unknown> | undefined, mode: ToolMode): void {
  checkArgs(definition.name, args, mode);
  definition.precheck?.(args ?? {});
  assertValid(definition.name, schemaFor(definition, mode), args, ["required"]);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  mode: ToolMode = "orchestrator",
  ctx: Omit<ToolCallContext, "mode"> = {}
): Promise<CallToolResult> {
  try {
    const route = routes.get(name);
    if (!route || !route.definition.modes.includes(mode)) throw new Error(`Unknown tool: ${name}`);
    validateToolArgs(route.definition, args, mode);
    // A session a person stopped has ended: say so, and what to do next (usage-visibility.md §6).
    const stopped = mode === "orchestrator" && name !== USAGE ? stoppedSessionNamed(args) : undefined;
    if (stopped) return { content: [{ type: "text", text: JSON.stringify(stoppedResult(stopped), null, 2) }] };
    return await route.group.handle(name, args as ToolArgs, { ...ctx, mode });
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
