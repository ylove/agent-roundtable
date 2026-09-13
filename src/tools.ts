// ============================================================================
// MCP tool schemas and dispatch
// ============================================================================

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "./config.js";
import {
  VERSION,
  DEFAULT_MODELS,
  MAX_TOKENS,
  LLM_TIMEOUT_MS,
  OLLAMA_URL,
  PROVIDER_IDS,
  MODEL_PARAM_DESCRIPTION,
} from "./config.js";
import type { LLMMessage } from "./providers/index.js";
import { chatCompletion, isOllamaAvailable } from "./providers/index.js";
import {
  meetings,
  startMeeting,
  continueMeeting,
  endMeeting,
  listMeetings,
} from "./sessions/meetings.js";
import {
  localMeetings,
  startLocalMeeting,
  continueLocalMeeting,
  endLocalMeeting,
  listLocalMeetings,
} from "./sessions/local-meetings.js";
import {
  collaborations,
  startCollaboration,
  continueCollaboration,
  nudgeCollaboration,
  pauseCollaboration,
  endCollaboration,
  getCollaborationTranscript,
  listCollaborations,
} from "./sessions/collaborations.js";

export const tools: Tool[] = [
  // === Meeting Tools ===
  {
    name: "start_meeting",
    description:
      "Start a meeting with an agent. Returns a meeting ID for follow-up messages. Use this to begin a synchronous conversation with another agent (CFO, FP&A, Product, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            'Agent identifier or path to prompt file. Examples: "cfo", "fpa", "product"',
        },
        agenda: {
          type: "string",
          description: "The topic, question, or task to discuss with the agent.",
        },
        context: {
          type: "string",
          description:
            "Optional additional context, document content, or data to share.",
        },
        provider: {
          type: "string",
          enum: PROVIDER_IDS,
          description:
            "LLM provider to use. Default: anthropic. Options: anthropic; openai; together (Together AI — any Together model id, e.g. zai-org/GLM-5.3 or Qwen/...); replicate (owner/name, owner/name:version, or https://replicate.com/owner/name); ollama (local, only when reachable); openai_compatible (any /v1/chat/completions server — set OPENAI_COMPATIBLE_BASE_URL or pass base_url).",
        },
        model: {
          type: "string",
          description: MODEL_PARAM_DESCRIPTION,
        },
        base_url: {
          type: "string",
          description:
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent as the bearer token to whichever base URL is used.',
        },
      },
      required: ["agent", "agenda"],
    },
  },
  {
    name: "say",
    description: "Continue a conversation in an active meeting.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: {
          type: "string",
          description: "The meeting ID from start_meeting.",
        },
        message: {
          type: "string",
          description: "Your message to the agent.",
        },
      },
      required: ["meeting_id", "message"],
    },
  },
  {
    name: "end_meeting",
    description: "End a meeting and optionally get a summary.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: {
          type: "string",
          description: "The meeting ID to close.",
        },
        request_summary: {
          type: "boolean",
          description: "If true, ask the agent for a summary before ending.",
        },
      },
      required: ["meeting_id"],
    },
  },
  {
    name: "list_meetings",
    description: "List all active meetings.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // === Local Meeting Tools (CLI-based, uses local Claude installation) ===
  {
    name: "start_local_meeting",
    description:
      "Start a LOCAL meeting with an agent using the installed Claude CLI. This uses your Claude Pro/Max subscription instead of API credits. Returns a meeting ID for follow-up messages. Ideal for cost-conscious lengthy conversations.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            'Agent identifier or path to prompt file. Examples: "cfo", "fpa", "product"',
        },
        agenda: {
          type: "string",
          description: "The topic, question, or task to discuss with the agent.",
        },
        context: {
          type: "string",
          description:
            "Optional additional context, document content, or data to share.",
        },
      },
      required: ["agent", "agenda"],
    },
  },
  {
    name: "say_local",
    description: "Continue a conversation in an active LOCAL meeting (CLI-based).",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: {
          type: "string",
          description: "The local meeting ID from start_local_meeting.",
        },
        message: {
          type: "string",
          description: "Your message to the agent.",
        },
      },
      required: ["meeting_id", "message"],
    },
  },
  {
    name: "end_local_meeting",
    description: "End a LOCAL meeting and optionally get a summary.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: {
          type: "string",
          description: "The local meeting ID to close.",
        },
        request_summary: {
          type: "boolean",
          description: "If true, ask the agent for a summary before ending.",
        },
      },
      required: ["meeting_id"],
    },
  },
  {
    name: "list_local_meetings",
    description: "List all active LOCAL meetings (CLI-based).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // === LLM Completion Tools ===
  {
    name: "chat_completion",
    description:
      "Call an LLM for text completion. Providers: anthropic (claude-opus-5 / claude-sonnet-5), openai (gpt-5.6-luna), together (Together AI), replicate (any Replicate text model), ollama (local, optional), openai_compatible (any /v1/chat/completions server).",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                enum: ["system", "user", "assistant"],
              },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Array of messages in the conversation.",
        },
        provider: {
          type: "string",
          enum: PROVIDER_IDS,
          description:
            "LLM provider to use. Default: openai. Options: anthropic; openai; together (Together AI — any Together model id, e.g. zai-org/GLM-5.3 or Qwen/...); replicate (owner/name, owner/name:version, or https://replicate.com/owner/name); ollama (local, only when reachable); openai_compatible (any /v1/chat/completions server — set OPENAI_COMPATIBLE_BASE_URL or pass base_url).",
        },
        model: {
          type: "string",
          description: MODEL_PARAM_DESCRIPTION,
        },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in the response. Default: ROUNDTABLE_MAX_TOKENS (8192). Thinking/reasoning tokens count against this.",
        },
        temperature: {
          type: "number",
          description: "Sampling temperature (0-2). Ignored for anthropic (current Claude models reject it); some OpenAI reasoning models reject it too. Replicate: sent only when the model's schema declares it.",
        },
        base_url: {
          type: "string",
          description:
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent as the bearer token to whichever base URL is used.',
        },
      },
      required: ["messages"],
    },
  },

  // === Collaboration Tools (Agent-to-Agent) ===
  {
    name: "start_collaboration",
    description:
      "Start a collaboration session where multiple agents discuss a topic with each other. Returns a collaboration ID. Agents take turns responding, building on each other's ideas.",
    inputSchema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description:
            'Array of agent identifiers. Examples: ["cfo", "fpa"], ["product", "engineering", "design"]',
        },
        topic: {
          type: "string",
          description: "The topic or question for agents to discuss.",
        },
        context: {
          type: "string",
          description: "Optional background context or data to share with all agents.",
        },
        max_rounds: {
          type: "number",
          description:
            "Maximum rounds of discussion (each round = each agent speaks once). Default: 5",
        },
        auto_run_rounds: {
          type: "number",
          description:
            "If set, automatically run this many rounds before returning. Otherwise returns after first agent speaks.",
        },
        provider: {
          type: "string",
          enum: PROVIDER_IDS,
          description:
            "LLM provider to use. Default: anthropic. Options: anthropic; openai; together (Together AI — any Together model id, e.g. zai-org/GLM-5.3 or Qwen/...); replicate (owner/name, owner/name:version, or https://replicate.com/owner/name); ollama (local, only when reachable); openai_compatible (any /v1/chat/completions server — set OPENAI_COMPATIBLE_BASE_URL or pass base_url).",
        },
        model: {
          type: "string",
          description: MODEL_PARAM_DESCRIPTION,
        },
        base_url: {
          type: "string",
          description:
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent as the bearer token to whichever base URL is used.',
        },
      },
      required: ["agents", "topic"],
    },
  },
  {
    name: "continue_collaboration",
    description:
      "Continue an active collaboration for additional rounds. Agents take turns responding.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID from start_collaboration.",
        },
        rounds: {
          type: "number",
          description: "Number of additional rounds to run. Default: 1",
        },
      },
      required: ["collaboration_id"],
    },
  },
  {
    name: "nudge_collaboration",
    description:
      "Inject a message from the orchestrator into the collaboration. Use to redirect discussion, ask clarifying questions, or provide additional context.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID.",
        },
        message: {
          type: "string",
          description:
            "Your message to inject into the discussion. Will appear as from ORCHESTRATOR.",
        },
      },
      required: ["collaboration_id", "message"],
    },
  },
  {
    name: "pause_collaboration",
    description: "Pause a running collaboration. Can be resumed with continue_collaboration.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID to pause.",
        },
      },
      required: ["collaboration_id"],
    },
  },
  {
    name: "end_collaboration",
    description: "End a collaboration and optionally get a summary of the discussion.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID to end.",
        },
        request_summary: {
          type: "boolean",
          description:
            "If true, ask an agent to summarize key agreements, disagreements, and action items.",
        },
      },
      required: ["collaboration_id"],
    },
  },
  {
    name: "get_collaboration_transcript",
    description: "Get the full transcript of a collaboration without ending it.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID.",
        },
      },
      required: ["collaboration_id"],
    },
  },
  {
    name: "list_collaborations",
    description: "List all active collaborations.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "debug_env",
    description: "Debug tool to check server environment and API key status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  try {
    switch (name) {
      // === Meeting Tools ===
      case "start_meeting": {
        const { agent, agenda, context, provider, model, base_url } = args as {
          agent: string;
          agenda: string;
          context?: string;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
        };
        const result = await startMeeting(agent, agenda, context, provider, model, base_url);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "say": {
        const { meeting_id, message } = args as {
          meeting_id: string;
          message: string;
        };
        const response = await continueMeeting(meeting_id, message);
        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "end_meeting": {
        const { meeting_id, request_summary } = args as {
          meeting_id: string;
          request_summary?: boolean;
        };
        const result = await endMeeting(meeting_id, request_summary ?? false);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "list_meetings": {
        const activeMeetings = listMeetings();
        return {
          content: [
            {
              type: "text",
              text:
                activeMeetings.length > 0
                  ? JSON.stringify(activeMeetings, null, 2)
                  : "No active meetings.",
            },
          ],
        };
      }

      // === Local Meeting Tools (CLI-based) ===
      case "start_local_meeting": {
        const { agent, agenda, context } = args as {
          agent: string;
          agenda: string;
          context?: string;
        };
        const result = await startLocalMeeting(agent, agenda, context);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "say_local": {
        const { meeting_id, message } = args as {
          meeting_id: string;
          message: string;
        };
        const response = await continueLocalMeeting(meeting_id, message);
        return {
          content: [{ type: "text", text: response }],
        };
      }

      case "end_local_meeting": {
        const { meeting_id, request_summary } = args as {
          meeting_id: string;
          request_summary?: boolean;
        };
        const result = await endLocalMeeting(meeting_id, request_summary ?? false);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "list_local_meetings": {
        const activeMeetings = listLocalMeetings();
        return {
          content: [
            {
              type: "text",
              text:
                activeMeetings.length > 0
                  ? JSON.stringify(activeMeetings, null, 2)
                  : "No active local meetings.",
            },
          ],
        };
      }

      // === LLM Completion Tools ===
      case "chat_completion": {
        const { messages, provider, model, max_tokens, temperature, base_url } = args as {
          messages: LLMMessage[];
          provider?: LLMProvider;
          model?: string;
          max_tokens?: number;
          temperature?: number;
          base_url?: string;
        };

        const result = await chatCompletion(messages, {
          provider,
          model,
          maxTokens: max_tokens,
          temperature,
          baseUrl: base_url,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // === Collaboration Tools ===
      case "start_collaboration": {
        const { agents, topic, context, max_rounds, auto_run_rounds, provider, model, base_url } = args as {
          agents: string[];
          topic: string;
          context?: string;
          max_rounds?: number;
          auto_run_rounds?: number;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
        };

        const result = await startCollaboration(agents, topic, {
          context,
          maxRounds: max_rounds,
          autoRun: auto_run_rounds !== undefined,
          runRounds: auto_run_rounds,
          provider,
          model,
          baseUrl: base_url,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "continue_collaboration": {
        const { collaboration_id, rounds } = args as {
          collaboration_id: string;
          rounds?: number;
        };

        const result = await continueCollaboration(collaboration_id, rounds ?? 1);

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "nudge_collaboration": {
        const { collaboration_id, message } = args as {
          collaboration_id: string;
          message: string;
        };

        const result = await nudgeCollaboration(collaboration_id, message);

        return {
          content: [
            {
              type: "text",
              text: `Injected orchestrator message into ${collaboration_id}:\n\n${result.content}`,
            },
          ],
        };
      }

      case "pause_collaboration": {
        const { collaboration_id } = args as { collaboration_id: string };
        const result = pauseCollaboration(collaboration_id);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "end_collaboration": {
        const { collaboration_id, request_summary } = args as {
          collaboration_id: string;
          request_summary?: boolean;
        };

        const result = await endCollaboration(
          collaboration_id,
          request_summary ?? false
        );

        let output = "## Collaboration Transcript\n\n";
        for (const msg of result.transcript) {
          output += `**${msg.agent}:** ${msg.content}\n\n---\n\n`;
        }
        if (result.summary) {
          output += `## Summary\n\n${result.summary}`;
        }

        return {
          content: [{ type: "text", text: output }],
        };
      }

      case "get_collaboration_transcript": {
        const { collaboration_id } = args as { collaboration_id: string };
        const transcript = getCollaborationTranscript(collaboration_id);

        let output = "";
        for (const msg of transcript) {
          output += `**${msg.agent}:** ${msg.content}\n\n---\n\n`;
        }

        return {
          content: [{ type: "text", text: output || "No messages yet." }],
        };
      }

      case "list_collaborations": {
        const activeCollabs = listCollaborations();
        return {
          content: [
            {
              type: "text",
              text:
                activeCollabs.length > 0
                  ? JSON.stringify(activeCollabs, null, 2)
                  : "No active collaborations.",
            },
          ],
        };
      }

      case "debug_env": {
        // Presence only: no prefix, no length — nothing derived from the secret leaves the process.
        const keyStatus = (name: string) => (process.env[name] ? "configured" : "NOT SET");
        const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;

        // Check if claude CLI is available for local meetings
        let claudeCliAvailable = false;
        try {
          const { execSync } = await import("child_process");
          execSync("which claude", { stdio: "pipe" });
          claudeCliAvailable = true;
        } catch {
          claudeCliAvailable = false;
        }

        const debugInfo = {
          version: VERSION,
          anthropic_api_key: keyStatus("ANTHROPIC_API_KEY"),
          openai_api_key: keyStatus("OPENAI_API_KEY"),
          together_api_key: keyStatus("TOGETHER_API_KEY"),
          replicate_api_token: keyStatus("REPLICATE_API_TOKEN"),
          openai_compatible: {
            base_url: process.env.OPENAI_COMPATIBLE_BASE_URL || "NOT SET",
            api_key: keyStatus("OPENAI_COMPATIBLE_API_KEY"),
          },
          ollama: { url: OLLAMA_URL, reachable: await isOllamaAvailable() },
          default_models: DEFAULT_MODELS,
          max_tokens: MAX_TOKENS,
          llm_timeout_ms: LLM_TIMEOUT_MS,
          agents_dir: agentsDir || "NOT SET (defaulting to .claude/agents)",
          local_meetings: claudeCliAvailable
            ? "available (claude CLI found)"
            : "NOT available (claude CLI not in PATH)",
          active_local_meetings: localMeetings.size,
          active_api_meetings: meetings.size,
          active_collaborations: collaborations.size,
          env_keys: Object.keys(process.env).filter(k =>
            k.includes('ANTHROPIC') || k.includes('OPENAI') || k.includes('TOGETHER') || k.includes('REPLICATE') || k.includes('OLLAMA') || k.includes('ROUNDTABLE')
          ),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(debugInfo, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
