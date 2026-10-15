// ============================================================================
// Shared tool-layer pieces: definition types, prop blocks, provider checks and result formatters
// ============================================================================

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "../config.js";
import { PROVIDER_IDS, MODEL_PARAM_DESCRIPTION } from "../config.js";
import { MEETING_MODES } from "../sessions/modes.js";
import type { UltraplanStepResult, UltraplanFinalResult } from "../sessions/ultraplan.js";
import type { AgentWorkshopResult } from "../sessions/agent-creation.js";
import type { JsonSchema } from "../validate.js";

// ----------------------------------------------------------------------------
// Definitions
// ----------------------------------------------------------------------------

/** Which server offers a tool: the orchestrator's stdio server or a heads-down worker's. */
export type ToolMode = "orchestrator" | "worker";

export const ORCHESTRATOR_ONLY: readonly ToolMode[] = ["orchestrator"];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  /** Servers that list and accept this tool. Never sent to clients. */
  modes: readonly ToolMode[];
}

export type ToolArgs = Record<string, unknown> | undefined;

/** One group of tools (deliberation, and later contract, execution, worker) with its own dispatcher. */
export interface ToolGroup {
  definitions: readonly ToolDefinition[];
  handle(name: string, args: ToolArgs): Promise<CallToolResult>;
}

// Annotation presets. Hints are advisory for clients; they never gate a call.
export const READ_ONLY_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Starts or advances a session: calls a provider and, in public sessions, posts to the public channel. */
export const SESSION_TURN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Closes a session: destroys its live state (and prototypes), may call a provider for a summary. */
export const SESSION_END = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

// ----------------------------------------------------------------------------
// Prop blocks
// ----------------------------------------------------------------------------

export const PROVIDER_PROPS = {
  provider: {
    type: "string",
    enum: PROVIDER_IDS,
    description:
      "LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url).",
  },
  model: { type: "string", description: MODEL_PARAM_DESCRIPTION },
  base_url: {
    type: "string",
    description:
      'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent to whichever base URL is used.',
  },
} as const;

export const MEETING_MODE_PROPS = {
  mode: {
    type: "string",
    enum: [...MEETING_MODES],
    description:
      "debate: the agent acts as a challenger and stress-tests your agenda instead of helping execute it. Default: standard.",
  },
  debate_focus: {
    type: "string",
    description: "Optional: what the challenge should concentrate on (only used with mode debate).",
  },
} as const;

export const PUBLIC_PROP = {
  type: "boolean",
  description:
    "Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: " +
    "the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. " +
    "The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. " +
    "Never include personal information, credentials, or private code anywhere in a public session. " +
    "The result includes public.url so the human can watch live.",
} as const;

export const PROTOTYPE_PROP = {
  type: "boolean",
  description:
    "Default false. Prototype mode: agents show proposals as ephemeral artifacts — a scaled-down page shown in a sandboxed frame on a localhost board, " +
    "the code/IaC that would produce the proposal (never executed), a Mermaid diagram, or a text draft — and the other participants " +
    "(in meetings: you) give verdicts; the proposer then revises, scraps or shortlists. Results include a prototypes block with the board URL: show it to the human. " +
    "Prototypes are destroyed as soon as assessment completes. Do not relay the human's feedback on prototypes into the session until it ends; " +
    "end_* lists outcomes and the shortlist for the human. Combinable with public (public posts get code, diagram links and screenshots of web prototypes, never the localhost board). " +
    "Not supported with mode conversation.",
} as const;

// ----------------------------------------------------------------------------
// Checks and formatters
// ----------------------------------------------------------------------------

/** Reject routing mistakes before a workshop loads personas or opens a public channel. */
export function validateProviderOptions(provider: LLMProvider = "anthropic", baseUrl?: string): void {
  if (!PROVIDER_IDS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Valid providers: ${PROVIDER_IDS.join(", ")}`);
  }
  if (baseUrl && provider !== "openai_compatible") {
    throw new Error(`base_url is only supported with provider "openai_compatible" (got "${provider}")`);
  }
}

export function formatUltraplanResult(result: UltraplanStepResult | UltraplanFinalResult): string {
  return result.status === "finalized"
    ? result.finalPlan + (result.publicBlock ? `\n\n${result.publicBlock}` : "")
    : JSON.stringify(result, null, 2);
}

export function formatAgentWorkshopResult(result: AgentWorkshopResult): string {
  const action = result.mode === "create" ? "Created" : "Improved";
  let output = result.proposedPath
    ? `## Proposed changes for agent: ${result.agent.name}\n\nAgent: not updated (the file changed during the run)\nProposed: ${result.proposedPath}\n`
    : `## ${action} agent: ${result.agent.name}\n\nAgent: ${result.agent.path || "(preview, not written)"}\n`;
  if (result.backupPath) output += `Backup: ${result.backupPath}\n`;
  if (result.agent.skills.length) {
    output += `Skills: ${result.agent.skills.map((s) => `${s.name} (${s.status})`).join(", ")}\n`;
  }
  if (result.warnings.length) {
    output += `\nWarnings:\n\n${result.warnings.map((w) => `- ${w}`).join("\n")}\n`;
  }
  output += `\n${result.next}\n\n${JSON.stringify(result, null, 2)}`;
  if (result.publicBlock) output += `\n\n${result.publicBlock}`;
  return output;
}
