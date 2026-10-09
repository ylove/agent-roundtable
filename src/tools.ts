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
  PUBLISHER_KIND,
  NTFY_URL,
  NTFY_TOKEN,
  NTFY_USER,
  NTFY_PASSWORD,
  WEBHOOK_URL,
  WEBHOOK_VIEW_URL,
  WEBHOOK_AUTH_HEADER,
  PUBLIC_TOPIC_PREFIX,
  TRANSCRIPTS_DIR,
  SKILLS_DIR,
  WORKSPACE_DIR,
  ACTIVITY_LOG_PATH,
  PARALLEL_TURNS,
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
import type { MeetingMode, CollaborationMode } from "./sessions/modes.js";
import { MEETING_MODES, COLLABORATION_MODES } from "./sessions/modes.js";
import {
  startUltraplan,
  submitPlan,
  endUltraplan,
  ultraplans,
  type UltraplanStepResult,
  type UltraplanFinalResult,
} from "./sessions/ultraplan.js";
import { createAgent, improveAgent, type AgentWorkshopResult } from "./sessions/agent-creation.js";

const PROVIDER_PROPS = {
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

/** Reject routing mistakes before a workshop loads personas or opens a public channel. */
function validateProviderOptions(provider: LLMProvider = "anthropic", baseUrl?: string): void {
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

const MEETING_MODE_PROPS = {
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

const PUBLIC_PROP = {
  type: "boolean",
  description:
    "Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: " +
    "the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. " +
    "The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. " +
    "Never include personal information, credentials, or private code anywhere in a public session. " +
    "The result includes public.url so the human can watch live.",
} as const;

/** Origin only: webhook URLs often carry the secret in the path or query. */
function webhookOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "unparseable URL";
  }
}

const SKILL_LOOKUP_DESCRIPTION =
  "Skill lookup follows Claude Code precedence: personal ~/.claude/skills, then .claude/skills beside the agent file when it is in .claude/agents, then ROUNDTABLE_SKILLS_DIR. Any skill found is reused, never overwritten or shadowed. ";
const WORKSHOP_TOOLS_DESCRIPTION =
  "Tools fail closed: a list with no allowlisted matches or a value of the wrong type is rejected and the architect retries once. Omitting tools inherits all tools and warns: tools omitted: the agent inherits all tools. ";
const PUBLIC_WORKSHOP_DESCRIPTION =
  "Public workshops post contributions, reviews and a redacted summary of the final definition (name, description, model, tools, skill names and status, contribution credits, changes and open questions), without its system prompt or skill instructions. They never post context, personas, fleet listings or source-session transcripts. ";

export const tools: Tool[] = [
  // === Meeting Tools ===
  {
    name: "start_meeting",
    description:
      "Start a meeting with an agent. Returns a meeting ID for follow-up messages. Use this to begin a synchronous conversation with another agent (CFO, FP&A, Product, etc.). Pass mode: \"debate\" to have the agent stress-test your agenda as a challenger instead.",
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
        mode: MEETING_MODE_PROPS.mode,
        debate_focus: MEETING_MODE_PROPS.debate_focus,
        public: PUBLIC_PROP,
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
      "Start a LOCAL meeting with an agent using the installed Claude CLI. This uses your Claude Pro/Max subscription instead of API credits. Returns a meeting ID for follow-up messages. Ideal for cost-conscious lengthy conversations. Pass mode: \"debate\" to have the agent stress-test your agenda as a challenger instead.",
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
        mode: MEETING_MODE_PROPS.mode,
        debate_focus: MEETING_MODE_PROPS.debate_focus,
        public: PUBLIC_PROP,
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
      "Start a collaboration where agents take turns responding; returns a collaboration ID. Default collaborate builds on ideas. Debate has agents[0] defend a position against challengers; waffle-house distills an idea through repeated attacks and rebuttals. Conversation is an informal chat from each agent's own situation, with short turns and no agenda or deliverable; topic is optional only in conversation mode. In conversation mode, put what you know about the agents' current situation in context (what was just built, what each agent last did). Private conversations default to grounding from workspace, memory and local activity; public conversations never get grounding, never open on the founder angle, and their directive does not ask agents to talk about the founder or whoever they report to. Continue, nudge, inspect or end with the collaboration tools.",
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
          description: "Required except in conversation mode, where it is an optional loose theme, not an agenda.",
        },
        context: {
          type: "string",
          description: "Optional background for all agents. In conversation mode, share what you know about their current situation: what was just built, what each agent last did, and current problems.",
        },
        grounding: {
          type: "boolean",
          description: "Conversation only, default true: send workspace, agent-memory and local activity excerpts to the session's provider as background. Set false to disable. Always disabled in public conversations.",
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
        mode: {
          type: "string",
          enum: [...COLLABORATION_MODES],
          description:
            "debate: agents[0] is the proponent; every other agent is a challenger that stress-tests the proponent. " +
            "waffle-house: agents[0] is the defender of an idea (the topic) and every other agent is an adversarial attacker (needs 2+ agents); " +
            "each round every attacker attacks, then the defender answers the whole volley, and the session always ends on the defender's rebuttal. " +
            "Speaking order is the same as collaborate; a session runs 1 + max_rounds x N agent turns. " +
            "conversation: informal colleague chat grounded in each agent's own context, usually 2-6 sentences, no agenda or deliverable; topic may be omitted. Default: collaborate.",
        },
        debate_focus: {
          type: "string",
          description: "Optional: what the challenge should concentrate on (only used with mode debate).",
        },
        public: PUBLIC_PROP,
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
      required: ["agents"],
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
    description: "Pause a running collaboration. Resume it with nudge_collaboration (continue_collaboration only advances a running collaboration).",
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
  // === Ultraplan Tools ===
  {
    name: "start_ultraplan",
    description:
      "Plan with specialist agents: you (the orchestrator) own and write the plan; agents give input before the draft, review each version, then sign off. With no draft_plan, returns input and awaiting_plan: write v1 with contributor tags such as [cfo], then call submit_plan. With draft_plan, reviews it as v1 and returns awaiting_revision. Revise in response to amendments, explaining rejected advice; call submit_plan with final: true to collect sign-offs and close. Alternatively set planner to a persona to draft/revise/sign off server-side in one call. If that run returns a step with error, the session remains open. A step with phase: \"plan\" returns the unreviewed latest version and previousReviews when an earlier version was reviewed. Continue with submit_plan: omit plan to review or sign off that version as-is, or pass a full revised plan; or close with end_ultraplan. Show the final document to the user verbatim, including every agent's input and sign-off. Public runs post the task and phase outputs, never context.",
    inputSchema: {
      type: "object",
      properties: {
        agents: { type: "array", items: { type: "string" }, minItems: 1, description: "Specialists contributing input, independent reviews and sign-offs. A planner may also be a participant." },
        task: { type: "string", description: "What the plan must accomplish; required and non-empty." },
        context: { type: "string", description: "Optional background shared with the agents; never posted publicly." },
        draft_plan: { type: "string", description: "Optional full draft: becomes v1 by orchestrator and skips the input phase. Whitespace-only counts as absent." },
        planner: { type: "string", description: "Optional persona that owns drafting and revision server-side; runs the whole loop in one call." },
        revision_rounds: { type: "number", description: "Planner only: review/revise cycles before sign-off, default 1, clamped to 1..3." },
        public: PUBLIC_PROP,
        ...PROVIDER_PROPS,
      },
      required: ["agents", "task"],
    },
  },
  {
    name: "submit_plan",
    description:
      "Submit a full next plan version, or omit plan to review or sign off the latest version as-is without creating a version. This also recovers a stopped planner run with phase: \"plan\". If no version exists yet, pass plan. You write revised plans from agent input/reviews; tag contributing agents on steps and explain which amendments you accepted or rejected and why. Default final: false collects independent reviews and leaves the session awaiting_revision. Set final: true to collect sign-offs, close, and return the final markdown document; with a supplied plan this is allowed straight after input without a review. Show that final document to the user verbatim, including input and sign-offs. A failed phase leaves the previous state intact so you can retry.",
    inputSchema: {
      type: "object",
      properties: {
        ultraplan_id: { type: "string", description: "The ultraplanId from start_ultraplan." },
        plan: { type: "string", description: "Optional: omit to have the latest version reviewed as-is (final false) or signed off as-is (final true), without creating a version. Pass the full next version, not a patch. If no version exists yet: No plan version exists yet; pass plan." },
        final: { type: "boolean", description: "Default false: review and leave open. True: collect sign-offs and finalize." },
      },
      required: ["ultraplan_id"],
    },
  },
  {
    name: "end_ultraplan",
    description:
      "Close an ultraplan WITHOUT collecting sign-offs. Returns a markdown document marked not signed off with the latest plan, agent input and revision history (or no plan if none was submitted). Show the document to the user verbatim. Use submit_plan with final: true instead when you want sign-off.",
    inputSchema: {
      type: "object",
      properties: { ultraplan_id: { type: "string", description: "The ultraplanId to close without sign-off." } },
      required: ["ultraplan_id"],
    },
  },

  // === Agent Creation and Refinement Tools ===
  {
    name: "create_agent",
    description:
      "Have specialists design a new Claude Code subagent in one call: sequential contributions, architect draft, independent reviews, then revision if needed. Pass agents and task, or from_session (a live collab-N or meeting-N) to inherit participants, topic and discussion; explicit agents are combined with inherited ones. Each contributes expertise, guardrails and skills. Default write: true saves the agent to ROUNDTABLE_AGENTS_DIR and new skills to ROUNDTABLE_SKILLS_DIR; existing agents are never overwritten. write: false previews files without writes. " +
      SKILL_LOOKUP_DESCRIPTION + WORKSHOP_TOOLS_DESCRIPTION +
      "The result reports actual paths, warnings and next delegation instructions: use Claude Code's Agent tool with the returned agent.name as subagent_type when saved in .claude/agents, or start_meeting. perform_task: true with writes starts a private meeting on the task; follow its next instructions with say and end_meeting. " +
      PUBLIC_WORKSHOP_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        agents: { type: "array", items: { type: "string" }, description: "Contributing personas; combined with from_session participants and deduplicated. At least one participant is required." },
        task: { type: "string", description: "What the new agent should do; required unless from_session supplies a topic." },
        context: { type: "string", description: "Optional background for the design; never posted publicly." },
        from_session: { type: "string", description: "Live collab-N or meeting-N whose participants and discussion should shape the agent." },
        name: { type: "string", description: "Optional agent name hint; normalized to a slug, with a suffix on collision." },
        rounds: { type: "number", description: "Contribution rounds, default 1, clamped to 1..3; reviews follow the architect draft." },
        write: { type: "boolean", description: "Default true: save agent and new skills. False: return preview files and write nothing." },
        perform_task: { type: "boolean", description: "Create + write only: start a private meeting with the new agent on its task. Default false." },
        public: PUBLIC_PROP,
        ...PROVIDER_PROPS,
      },
    },
  },
  {
    name: "improve_agent",
    description:
      "Refine an existing Claude Code agent in one call, preserving its identity and useful instructions. By default the target reviews itself candidly; add specialists with with or inherit participants/discussion from a live collab-N or meeting-N via from_session. They suggest gaps, replacements, skills and cuts; an architect drafts the definition, participants review independently, and the architect revises if needed. The target may be any existing .md path, including outside the agents directory. write: false previews without writes. " +
      "Frontmatter rejected by strict YAML (such as an unquoted description containing colon-space) is read leniently as Claude Code reads it: every recovered key is preserved, with a warning, and rewritten as valid YAML. No recoverable keys means refinement is refused; identity collision checks also see recovered names. Model output only supplies name/description/model/tools/skills. " +
      "Only one improve run per target is allowed; a second fails fast: improve_agent is already running for <key>; wait for it to finish. Default write: true saves <target>.bak-<timestamp>, then atomically replaces via a temp file and rename, keeping the original mode. If the target changed during the run it is not overwritten: changes go to <target>.proposed-<timestamp>, which is not an agent file; next explains recovery. " +
      SKILL_LOOKUP_DESCRIPTION +
      "New skills go beside a target in .claude/agents to its project's .claude/skills, otherwise to ROUNDTABLE_SKILLS_DIR. Results report actual paths, warnings and next instructions. " +
      WORKSHOP_TOOLS_DESCRIPTION + PUBLIC_WORKSHOP_DESCRIPTION +
      "Public improve runs never include the target's recent activity in any prompt; contributors and reviewers point to passages rather than reproduce them. Private improve contributor prompts include recent topics and outcomes from the local activity log.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Existing agent identifier or .md file path to improve, including paths outside ROUNDTABLE_AGENTS_DIR. Written targets are backed up first." },
        with: { type: "array", items: { type: "string" }, description: "Additional specialists; combined with target (when include_self) and from_session participants." },
        include_self: { type: "boolean", description: "Default true: the target contributes to its own refinement. If false, supply at least one participant via with or from_session." },
        focus: { type: "string", description: "Optional aspect to improve, such as escalation rules, output quality or missing skills." },
        context: { type: "string", description: "Optional background for refinement; never posted publicly." },
        from_session: { type: "string", description: "Live collab-N or meeting-N supplying participants and discussion." },
        rounds: { type: "number", description: "Contribution rounds, default 1, clamped to 1..3." },
        write: { type: "boolean", description: "Default true: back up and update the target. False: preview files and write nothing." },
        public: PUBLIC_PROP,
        ...PROVIDER_PROPS,
      },
      required: ["agent"],
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

/** Check declared argument types; engines still handle missing required values. */
export function checkArgs(tool: string, args: Record<string, unknown> | undefined): void {
  const properties = tools.find((entry) => entry.name === tool)?.inputSchema.properties ?? {};
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
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  try {
    switch (name) {
      // === Meeting Tools ===
      case "start_meeting": {
        const { agent, agenda, context, provider, model, base_url, mode, debate_focus, public: isPublic } = args as {
          agent: string;
          agenda: string;
          context?: string;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
          mode?: MeetingMode;
          debate_focus?: string;
          public?: boolean;
        };
        const result = await startMeeting(agent, agenda, context, provider, model, base_url, mode, debate_focus, isPublic === true);
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
        const { agent, agenda, context, mode, debate_focus, public: isPublic } = args as {
          agent: string;
          agenda: string;
          context?: string;
          mode?: MeetingMode;
          debate_focus?: string;
          public?: boolean;
        };
        const result = await startLocalMeeting(agent, agenda, context, mode, debate_focus, isPublic === true);
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
        const { agents, topic, context, max_rounds, auto_run_rounds, provider, model, base_url, mode, debate_focus, grounding, public: isPublic } = args as {
          agents: string[];
          topic?: string;
          context?: string;
          max_rounds?: number;
          auto_run_rounds?: number;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
          mode?: CollaborationMode;
          debate_focus?: string;
          grounding?: boolean;
          public?: boolean;
        };

        const result = await startCollaboration(agents, topic, {
          context,
          maxRounds: max_rounds,
          autoRun: auto_run_rounds !== undefined,
          runRounds: auto_run_rounds,
          provider,
          model,
          baseUrl: base_url,
          mode,
          debateFocus: debate_focus,
          grounding,
          public: isPublic === true,
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
        if (result.publicBlock) {
          output += `\n\n${result.publicBlock}`;
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

      // === Ultraplan Tools ===
      case "start_ultraplan": {
        checkArgs(name, args);
        const { agents, task, context, draft_plan, planner, revision_rounds, public: isPublic, provider, model, base_url } = (args ?? {}) as {
          agents: string[];
          task: string;
          context?: string;
          draft_plan?: string;
          planner?: string;
          revision_rounds?: number;
          public?: boolean;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
        };
        validateProviderOptions(provider, base_url);
        const result = await startUltraplan(agents, task, {
          context,
          draftPlan: draft_plan,
          planner,
          revisionRounds: revision_rounds,
          public: isPublic === true,
          provider,
          model,
          baseUrl: base_url,
        });
        return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
      }

      case "submit_plan": {
        checkArgs(name, args);
        const { ultraplan_id, plan, final } = (args ?? {}) as { ultraplan_id: string; plan?: string; final?: boolean };
        const result = await submitPlan(ultraplan_id, plan, final === true);
        return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
      }

      case "end_ultraplan": {
        checkArgs(name, args);
        const { ultraplan_id } = (args ?? {}) as { ultraplan_id: string };
        const result = await endUltraplan(ultraplan_id);
        return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
      }

      // === Agent Creation and Refinement Tools ===
      case "create_agent": {
        checkArgs(name, args);
        const { agents, task, context, from_session, name: agentName, rounds, write, perform_task, public: isPublic, provider, model, base_url } = (args ?? {}) as {
          agents?: string[];
          task?: string;
          context?: string;
          from_session?: string;
          name?: string;
          rounds?: number;
          write?: boolean;
          perform_task?: boolean;
          public?: boolean;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
        };
        validateProviderOptions(provider, base_url);
        const result = await createAgent({
          agents, task, context, fromSession: from_session, name: agentName, rounds, write,
          performTask: perform_task, public: isPublic === true, provider, model, baseUrl: base_url,
        });
        return { content: [{ type: "text", text: formatAgentWorkshopResult(result) }] };
      }

      case "improve_agent": {
        checkArgs(name, args);
        const { agent, with: specialists, include_self, focus, context, from_session, rounds, write, public: isPublic, provider, model, base_url } = (args ?? {}) as {
          agent: string;
          with?: string[];
          include_self?: boolean;
          focus?: string;
          context?: string;
          from_session?: string;
          rounds?: number;
          write?: boolean;
          public?: boolean;
          provider?: LLMProvider;
          model?: string;
          base_url?: string;
        };
        validateProviderOptions(provider, base_url);
        if (typeof agent !== "string" || !agent.trim()) {
          throw new Error('improve_agent: "agent" is required: pass the agent name or .md path to improve');
        }
        const result = await improveAgent({
          agent, with: specialists, includeSelf: include_self, focus, context, fromSession: from_session,
          rounds, write, public: isPublic === true, provider, model, baseUrl: base_url,
        });
        return { content: [{ type: "text", text: formatAgentWorkshopResult(result) }] };
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
          skills_dir: SKILLS_DIR,
          workspace_dir: WORKSPACE_DIR,
          activity_log: ACTIVITY_LOG_PATH ?? "off",
          parallel_turns: PARALLEL_TURNS,
          public_sessions: {
            publisher: PUBLISHER_KIND,
            ...(PUBLISHER_KIND === "webhook"
              ? {
                  webhook_url: WEBHOOK_URL ? `configured (${webhookOrigin(WEBHOOK_URL)}, path/query hidden)` : "NOT SET",
                  webhook_view_url: WEBHOOK_VIEW_URL || "NOT SET",
                  webhook_auth_header: WEBHOOK_AUTH_HEADER ? "configured" : "not set",
                }
              : {
                  server_url: NTFY_URL,
                  token: NTFY_TOKEN ? "configured" : "not set",
                  user: NTFY_USER ? "configured" : "not set",
                  password: NTFY_PASSWORD ? "configured" : "not set",
                }),
            topic_prefix: PUBLIC_TOPIC_PREFIX,
            transcripts_dir: TRANSCRIPTS_DIR,
          },
          local_meetings: claudeCliAvailable
            ? "available (claude CLI found)"
            : "NOT available (claude CLI not in PATH)",
          active_local_meetings: localMeetings.size,
          active_api_meetings: meetings.size,
          active_collaborations: collaborations.size,
          active_ultraplans: ultraplans.size,
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
