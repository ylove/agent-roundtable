// ============================================================================
// MCP tool schemas and dispatch: the public entry of the tool layer (groups live in src/tools/)
// ============================================================================

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertValid, publicSchema } from "./validate.js";
import { deliberationTools, handleDeliberationTool } from "./tools/deliberation.js";
import { contractTools, handleContractTool } from "./tools/contract.js";
import type { ToolArgs, ToolDefinition, ToolGroup, ToolMode } from "./tools/shared.js";
import { scrub } from "./security/secrets.js";

export { formatUltraplanResult, formatAgentWorkshopResult } from "./tools/shared.js";
export type { ToolMode } from "./tools/shared.js";

// Later workstreams add their groups here (execution, worker).
const groups: ToolGroup[] = [
  { definitions: deliberationTools, handle: handleDeliberationTool },
  { definitions: contractTools, handle: handleContractTool },
];

const routes = new Map<string, { definition: ToolDefinition; group: ToolGroup }>();
for (const group of groups) {
  for (const definition of group.definitions) {
    if (routes.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
    routes.set(definition.name, { definition, group });
  }
}

/** A definition as clients see it: no `modes`, no schema extensions. */
function listed(definition: ToolDefinition): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: publicSchema(definition.inputSchema) as Tool["inputSchema"],
    annotations: definition.annotations,
  };
}

/** The tools one server lists: "orchestrator" for the stdio server, "worker" for a heads-down worker's. */
export function toolsFor(mode: ToolMode): Tool[] {
  return [...routes.values()].filter(({ definition }) => definition.modes.includes(mode)).map(({ definition }) => listed(definition));
}

/** The orchestrator server's tool list. */
export const tools: Tool[] = toolsFor("orchestrator");

/**
 * Check every given argument against the tool's schema (types, enums, constraints, nested fields) and
 * throw `<tool>: "<field>" ...` on the first problem. Missing required fields are not reported here:
 * handleToolCall checks them after the tool's cross-field checks. Unknown tools pass.
 */
export function checkArgs(tool: string, args: Record<string, unknown> | undefined): void {
  const definition = routes.get(tool)?.definition;
  if (definition) assertValid(tool, definition.inputSchema, args, ["values"]);
}

/** Values, then cross-field checks, then required fields: the order every error message relies on. */
function validateToolArgs(definition: ToolDefinition, args: Record<string, unknown> | undefined): void {
  checkArgs(definition.name, args);
  definition.precheck?.(args ?? {});
  assertValid(definition.name, definition.inputSchema, args, ["required"]);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  mode: ToolMode = "orchestrator"
): Promise<CallToolResult> {
  try {
    const route = routes.get(name);
    if (!route || !route.definition.modes.includes(mode)) throw new Error(`Unknown tool: ${name}`);
    validateToolArgs(route.definition, args);
    return await route.group.handle(name, args as ToolArgs);
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
