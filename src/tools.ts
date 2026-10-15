// ============================================================================
// MCP tool schemas and dispatch: the public entry of the tool layer (groups live in src/tools/)
// ============================================================================

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { publicSchema } from "./validate.js";
import { deliberationTools, handleDeliberationTool } from "./tools/deliberation.js";
import type { ToolArgs, ToolDefinition, ToolGroup, ToolMode } from "./tools/shared.js";

export { formatUltraplanResult, formatAgentWorkshopResult } from "./tools/shared.js";
export type { ToolMode } from "./tools/shared.js";

// Later workstreams add their groups here (contract, execution, worker).
const groups: ToolGroup[] = [
  { definitions: deliberationTools, handle: handleDeliberationTool },
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

/** Check declared argument types; engines still handle missing required values. */
export function checkArgs(tool: string, args: Record<string, unknown> | undefined): void {
  const properties = routes.get(tool)?.definition.inputSchema.properties ?? {};
  for (const [field, schema] of Object.entries(properties)) {
    const value = args?.[field];
    if (value === undefined || value === null) continue;
    const type = (schema as { type?: string }).type;
    let requirement: string | undefined;
    if (type === "string" && typeof value !== "string") requirement = "a string";
    if (type === "array" && (!Array.isArray(value) || !Array.from(value).every((item) => typeof item === "string" && item.trim().length > 0))) {
      requirement = "an array of non-empty strings";
    }
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) requirement = "a finite number";
    if (type === "boolean" && typeof value !== "boolean") requirement = "a boolean";
    if (requirement) throw new Error(`${tool}: "${field}" must be ${requirement}`);
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  mode: ToolMode = "orchestrator"
): Promise<CallToolResult> {
  try {
    const route = routes.get(name);
    if (!route || !route.definition.modes.includes(mode)) throw new Error(`Unknown tool: ${name}`);
    return await route.group.handle(name, args as ToolArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
