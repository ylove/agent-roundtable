// ============================================================================
// Deliberation tools (at the table): meetings, local meetings, completions, collaborations,
// ultraplan, agent workshops and diagnostics
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "../config.js";
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
  SESSIONS_DIR,
  PARALLEL_TURNS,
} from "../config.js";
import type { LLMMessage } from "../providers/index.js";
import { chatCompletion, isOllamaAvailable } from "../providers/index.js";
import { findExecutable } from "../executables.js";
import { describeUrl } from "../security/url-guard.js";
import {
  meetings,
  startMeeting,
  continueMeeting,
  endMeeting,
  listMeetings,
} from "../sessions/meetings.js";
import {
  localMeetings,
  startLocalMeeting,
  continueLocalMeeting,
  endLocalMeeting,
  listLocalMeetings,
} from "../sessions/local-meetings.js";
import {
  MAX_COLLABORATION_ROUNDS,
  collaborations,
  startCollaboration,
  continueCollaboration,
  nudgeCollaboration,
  pauseCollaboration,
  endCollaboration,
  getCollaborationTranscript,
  listCollaborations,
} from "../sessions/collaborations.js";
import type { MeetingMode, CollaborationMode } from "../sessions/modes.js";
import { COLLABORATION_MODES } from "../sessions/modes.js";
import { startUltraplan, submitPlan, endUltraplan, ultraplans } from "../sessions/ultraplan.js";
import { createAgent, improveAgent } from "../sessions/agent-creation.js";
import { prototypeTrailer } from "../sessions/prototype-mode.js";
import { assertAcceptsInput } from "../postmortem/sessions.js";
import { ultraplanSection } from "../postmortem/lessons.js";
import { resolveRepo } from "../execution/contract-lifecycle.js";
import { prototypeDiagnostics } from "../prototypes/index.js";
import {
  START_MEETING,
  SAY,
  END_MEETING,
  LIST_MEETINGS,
  START_LOCAL_MEETING,
  SAY_LOCAL,
  END_LOCAL_MEETING,
  LIST_LOCAL_MEETINGS,
  CHAT_COMPLETION,
  START_COLLABORATION,
  CONTINUE_COLLABORATION,
  NUDGE_COLLABORATION,
  PAUSE_COLLABORATION,
  END_COLLABORATION,
  GET_COLLABORATION_TRANSCRIPT,
  LIST_COLLABORATIONS,
  START_ULTRAPLAN,
  SUBMIT_PLAN,
  END_ULTRAPLAN,
  CREATE_AGENT,
  IMPROVE_AGENT,
  DEBUG_ENV,
} from "./names.js";
import {
  ORCHESTRATOR_ONLY,
  READ_ONLY_LOCAL,
  SESSION_END,
  SESSION_TURN,
  PROVIDER_PROPS,
  MEETING_MODE_PROPS,
  PUBLIC_PROP,
  PROTOTYPE_PROP,
  validateProviderOptions,
  formatUltraplanResult,
  formatAgentWorkshopResult,
  type ToolArgs,
  type ToolDefinition,
} from "./shared.js";

/** Cross-field check for the workshop and ultraplan starters (runs after value checks, before required). */
function checkProviderArgs(args: Record<string, unknown>): void {
  validateProviderOptions(args.provider as LLMProvider | undefined, args.base_url as string | undefined);
}

const SKILL_LOOKUP_DESCRIPTION =
  "Creation includes the destination project's .claude/skills in lookup even when the configured skills directory differs. Skill lookup follows Claude Code precedence: personal ~/.claude/skills, then .claude/skills beside the agent file when it is in .claude/agents, then ROUNDTABLE_SKILLS_DIR. Any skill found is reused, never overwritten or shadowed. ";
const WORKSHOP_TOOLS_DESCRIPTION =
  "Tools fail closed: a list with no allowlisted matches or a value of the wrong type is rejected and the architect retries once. ";
const CREATE_TOOLS_DEFAULT_DESCRIPTION = "Omitting tools gives the new agent tools: Read, Grep, Glob. ";
const IMPROVE_TOOLS_DEFAULT_DESCRIPTION =
  "Omitting tools keeps the target's own tools line; a target without one keeps inheriting every tool, and the result warns: " +
  "tools omitted: the target has no tools line, so it still inherits every tool; list tools to restrict it. ";
const PUBLIC_WORKSHOP_DESCRIPTION =
  "Public workshops post contributions, reviews and a redacted summary of the final definition (name, description, model, tools, skill names and status, contribution credits, changes and open questions), without its system prompt, skill instructions or descriptions derived from instructions; copied private passages in summary fields are withheld. They never post context, personas, fleet listings or source-session transcripts. ";

export const deliberationTools: ToolDefinition[] = [
  // === Meeting Tools ===
  {
    name: START_MEETING,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Start meeting", ...SESSION_TURN },
    description:
      "Start a meeting with an agent. Returns a meeting ID for follow-up messages. Use this to begin a synchronous conversation with another agent (CFO, FP&A, Product, etc.). Pass mode: \"debate\" to have the agent stress-test your agenda as a challenger instead. Pass prototype: true to have the agent show its proposals as ephemeral prototypes that you assess.",
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
        prototype: PROTOTYPE_PROP,
        provider: {
          type: "string",
          enum: PROVIDER_IDS,
          "x-advisory-enum": true,
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
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address.',
        },
      },
      required: ["agent", "agenda"],
    },
  },
  {
    name: SAY,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Say in meeting", ...SESSION_TURN },
    description:
      "Continue a conversation in an active meeting. In a prototype meeting you assess the agent's prototypes: give `Verdict on Pn: APPROVE|REVISE|REJECT — reason` " +
      "on its own line, grounded in the artifact and its demo; the reply ends with a Prototypes block (the board URL, live prototypes and those destroyed this call).",
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
    name: END_MEETING,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "End meeting", ...SESSION_END },
    description: "End a meeting and optionally get a summary. Prototype meetings also return the prototype outcomes and the shortlist for the human.",
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
    name: LIST_MEETINGS,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "List meetings", ...READ_ONLY_LOCAL },
    description: "List all active meetings.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // === Local Meeting Tools (CLI-based, uses local Claude installation) ===
  {
    name: START_LOCAL_MEETING,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Start local meeting", ...SESSION_TURN },
    description:
      "Start a LOCAL meeting with an agent using the installed Claude CLI. This uses your Claude Pro/Max subscription instead of API credits. Returns a meeting ID for follow-up messages. Ideal for cost-conscious lengthy conversations. Pass mode: \"debate\" to have the agent stress-test your agenda as a challenger instead. Pass prototype: true to have the agent show its proposals as ephemeral prototypes that you assess.",
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
        prototype: PROTOTYPE_PROP,
      },
      required: ["agent", "agenda"],
    },
  },
  {
    name: SAY_LOCAL,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Say in local meeting", ...SESSION_TURN },
    description:
      "Continue a conversation in an active LOCAL meeting (CLI-based). In a prototype meeting give `Verdict on Pn: APPROVE|REVISE|REJECT — reason` " +
      "for the agent's prototypes; the reply ends with a Prototypes block.",
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
    name: END_LOCAL_MEETING,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "End local meeting", ...SESSION_END },
    description: "End a LOCAL meeting and optionally get a summary. Prototype meetings also return the prototype outcomes and the shortlist for the human.",
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
    name: LIST_LOCAL_MEETINGS,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "List local meetings", ...READ_ONLY_LOCAL },
    description: "List all active LOCAL meetings (CLI-based).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // === LLM Completion Tools ===
  {
    name: CHAT_COMPLETION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Chat completion", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
          "x-advisory-enum": true,
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
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address.',
        },
      },
      required: ["messages"],
    },
  },

  // === Collaboration Tools (Agent-to-Agent) ===
  {
    name: START_COLLABORATION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Start collaboration", ...SESSION_TURN },
    description:
      "Start a collaboration where agents take turns responding; returns a collaboration ID. Default collaborate builds on ideas. Debate has agents[0] defend a position against challengers; waffle-house distills an idea through repeated attacks and rebuttals. Conversation is an informal chat from each agent's own situation, with short turns and no agenda or deliverable; topic is optional only in conversation mode. In conversation mode, put what you know about the agents' current situation in context (what was just built, what each agent last did). Private conversations default to grounding from workspace, memory and local activity; public conversations never get grounding, never open on the founder angle, and their directive does not ask agents to talk about the founder or whoever they report to. Pass prototype: true (not with conversation) to have agents show proposals as ephemeral prototypes that the other agents assess. Continue, nudge, inspect or end with the collaboration tools.",
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
          maximum: MAX_COLLABORATION_ROUNDS,
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
          "x-advisory-enum": true,
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
        prototype: PROTOTYPE_PROP,
        provider: {
          type: "string",
          enum: PROVIDER_IDS,
          "x-advisory-enum": true,
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
            'Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address.',
        },
      },
      required: ["agents"],
    },
  },
  {
    name: CONTINUE_COLLABORATION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Continue collaboration", ...SESSION_TURN },
    description:
      "Continue an active collaboration for additional rounds. Agents take turns responding. In a prototype session it also resumes a paused session while a prototype is under assessment.",
    inputSchema: {
      type: "object",
      properties: {
        collaboration_id: {
          type: "string",
          description: "The collaboration ID from start_collaboration.",
        },
        rounds: {
          type: "number",
          maximum: MAX_COLLABORATION_ROUNDS,
          description: "Number of additional rounds to run. Default: 1",
        },
      },
      required: ["collaboration_id"],
    },
  },
  {
    name: NUDGE_COLLABORATION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Nudge collaboration", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Inject a message from the orchestrator into the collaboration. Use to redirect discussion, ask clarifying questions, or provide additional context. In a prototype session nudges are refused while a prototype is under assessment; never use a nudge to relay the human's feedback on prototypes before the session ends.",
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
    name: PAUSE_COLLABORATION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Pause collaboration", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    name: END_COLLABORATION,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "End collaboration", ...SESSION_END },
    description: "End a collaboration and optionally get a summary of the discussion. Prototype sessions also return the prototype outcomes and the shortlist for the human (resolved prototypes appear as stubs in the transcript).",
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
    name: GET_COLLABORATION_TRANSCRIPT,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Get collaboration transcript", ...READ_ONLY_LOCAL },
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
    name: LIST_COLLABORATIONS,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "List collaborations", ...READ_ONLY_LOCAL },
    description: "List all active collaborations.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // === Ultraplan Tools ===
  {
    name: START_ULTRAPLAN,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkProviderArgs,
    annotations: { title: "Start ultraplan", ...SESSION_TURN },
    description:
      "Plan with specialist agents: you (the orchestrator) own and write the plan; agents give input before the draft, review each version, then sign off. With no draft_plan, returns input and awaiting_plan: write v1 with contributor tags such as [cfo], then call submit_plan. With draft_plan, reviews it as v1 and returns awaiting_revision. Revise in response to amendments, explaining rejected advice; call submit_plan with final: true to collect sign-offs and close. Alternatively set planner to a persona to draft/revise/sign off server-side in one call. If that run returns a step with error, the session remains open. A step with phase: \"plan\" returns the unreviewed latest version and previousReviews when an earlier version was reviewed. Continue with submit_plan: omit plan to review or sign off that version as-is, or pass a full revised plan; or close with end_ultraplan. Show the final document to the user verbatim, including every agent's input and sign-off. The final result ends with a JSON trailer {ultraplan_id, archived, tally}; signed off means no OBJECT and no UNCLEAR sign-off. With execution_ready: true, plans end with a roundtable-tasks block and sign-offs check it, so propose_contract { from_session: ultraplan_id } can build a contract from it. Public runs post the task and phase outputs, never context.",
    inputSchema: {
      type: "object",
      properties: {
        agents: { type: "array", items: { type: "string" }, minItems: 1, description: "Specialists contributing input, independent reviews and sign-offs. A planner may also be a participant." },
        task: { type: "string", description: "What the plan must accomplish; required and non-empty.", "x-nonblank": true, "x-hint": "describe what the plan is for" },
        context: { type: "string", description: "Optional background shared with the agents; never posted publicly." },
        draft_plan: { type: "string", description: "Optional full draft: becomes v1 by orchestrator and skips the input phase. Whitespace-only counts as absent." },
        planner: { type: "string", description: "Optional persona that owns drafting and revision server-side; runs the whole loop in one call." },
        revision_rounds: { type: "number", description: "Planner only: review/revise cycles before sign-off, default 1, clamped to 1..3." },
        execution_ready: { type: "boolean", description: "Default false. True when the plan will be executed heads-down: planner drafts and revisions (and your next steps) must end with a fenced roundtable-tasks JSON block of tasks, commands and interfaces, and sign-offs check it." },
        repo_dir: { type: "string", description: "A directory inside the repository the plan is for. When earlier postmortems of that project left lessons, a bounded \"Lessons from past postmortems\" section (misreadings first) is added to the context the agents plan with. Never posted publicly." },
        public: PUBLIC_PROP,
        ...PROVIDER_PROPS,
      },
      required: ["agents", "task"],
    },
  },
  {
    name: SUBMIT_PLAN,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Submit plan", ...SESSION_TURN },
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
    name: END_ULTRAPLAN,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "End ultraplan", ...SESSION_END },
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
    name: CREATE_AGENT,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkProviderArgs,
    annotations: { title: "Create agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Have specialists design a new Claude Code subagent in one call: sequential contributions, architect draft, independent reviews, then revision if needed. Pass agents and task, or from_session (the id of a live collaboration or meeting, e.g. collab-4k9q2mzt, or of any ended session in the archive) to inherit participants, topic and discussion; explicit agents are combined with inherited ones. Each contributes expertise, guardrails and skills. Default write: true saves the agent to ROUNDTABLE_AGENTS_DIR and new skills to ROUNDTABLE_SKILLS_DIR; existing agents are never overwritten. write: false previews files without writes. " +
      SKILL_LOOKUP_DESCRIPTION + WORKSHOP_TOOLS_DESCRIPTION + CREATE_TOOLS_DEFAULT_DESCRIPTION +
      "The result reports actual paths, warnings and next delegation instructions: use Claude Code's Agent tool with the returned agent.name as subagent_type when saved in .claude/agents, or start_meeting. perform_task: true with writes starts a private meeting on the task; follow its next instructions with say and end_meeting. " +
      PUBLIC_WORKSHOP_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        agents: { type: "array", items: { type: "string" }, description: "Contributing personas; combined with from_session participants and deduplicated. At least one participant is required." },
        task: { type: "string", description: "What the new agent should do; required unless from_session supplies a topic." },
        context: { type: "string", description: "Optional background for the design; never posted publicly." },
        from_session: { type: "string", description: "Id of a live collaboration or meeting (collab-…, meeting-…) or of any ended session in the archive, whose participants and discussion should shape the agent." },
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
    name: IMPROVE_AGENT,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkProviderArgs,
    annotations: { title: "Improve agent", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      "Refine an existing Claude Code agent in one call, preserving its identity and useful instructions. By default the target reviews itself candidly; add specialists with with or inherit participants/discussion via from_session (the id of a live collaboration or meeting, or of any ended session in the archive). They suggest gaps, replacements, skills and cuts; an architect drafts the definition, participants review independently, and the architect revises if needed. The target is an agent name or a .md path inside the agents directory, <workspace>/.claude/agents, ~/.claude/agents or a directory listed in ROUNDTABLE_AGENT_PATHS. write: false previews without writes. " +
      "Frontmatter is read the way Claude Code reads it, including one quoting and leading-tab recovery pass. Exactly the keys Claude Code sees are preserved; improve refuses files Claude Code cannot parse or whose frontmatter contains '---' inside a value, with an error asking you to fix the file first. Identity collision checks use the same metadata view. Model output only supplies name/description/model/tools/skills. " +
      "Only one improve run per target is allowed; a second fails fast: improve_agent is already running for <key>; wait for it to finish. Default write: true saves <target>.bak-<timestamp>, then atomically replaces via a temp file and rename, keeping the original mode. If the target changed, was renamed or was deleted during the run it is not overwritten: changes go to <target>.proposed-<timestamp>, which is not an agent file and keeps the original mode; next explains recovery. " +
      SKILL_LOOKUP_DESCRIPTION +
      "New skills go beside a target in .claude/agents to its project's .claude/skills only if neither .claude nor .claude/skills is a symlink and the skills realpath stays inside the project. Otherwise they fall back to ROUNDTABLE_SKILLS_DIR with a warning. Results report file realpaths, warnings and next instructions. " +
      WORKSHOP_TOOLS_DESCRIPTION + IMPROVE_TOOLS_DEFAULT_DESCRIPTION + PUBLIC_WORKSHOP_DESCRIPTION +
      "Public improve runs never include the target's recent activity in any prompt; contributors, reviewers and the architect point to passages rather than reproduce them. Private improve contributor prompts include recent topics and outcomes from the local activity log.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Existing agent name, or a .md file path inside an allowed agents directory (ROUNDTABLE_AGENTS_DIR, <workspace>/.claude/agents, ~/.claude/agents or ROUNDTABLE_AGENT_PATHS). Written targets are backed up first.",
          "x-nonblank": true,
          "x-hint": "pass the agent name or .md path to improve",
        },
        with: { type: "array", items: { type: "string" }, description: "Additional specialists; combined with target (when include_self) and from_session participants." },
        include_self: { type: "boolean", description: "Default true: the target contributes to its own refinement. If false, supply at least one participant via with or from_session." },
        focus: { type: "string", description: "Optional aspect to improve, such as escalation rules, output quality or missing skills." },
        context: { type: "string", description: "Optional background for refinement; never posted publicly." },
        from_session: { type: "string", description: "Id of a live collaboration or meeting (collab-…, meeting-…) or of any ended session in the archive, supplying participants and discussion." },
        rounds: { type: "number", description: "Contribution rounds, default 1, clamped to 1..3." },
        write: { type: "boolean", description: "Default true: back up and update the target. False: preview files and write nothing." },
        public: PUBLIC_PROP,
        ...PROVIDER_PROPS,
      },
      required: ["agent"],
    },
  },
  {
    name: DEBUG_ENV,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Debug environment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Debug tool to check server environment and API key status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/** Dispatch one deliberation tool. Errors are thrown to handleToolCall, which formats them. */
export async function handleDeliberationTool(name: string, args: ToolArgs): Promise<CallToolResult> {
  switch (name) {
    // === Meeting Tools ===
    case START_MEETING: {
      const { agent, agenda, context, provider, model, base_url, mode, debate_focus, public: isPublic, prototype } = args as {
        agent: string;
        agenda: string;
        context?: string;
        provider?: LLMProvider;
        model?: string;
        base_url?: string;
        mode?: MeetingMode;
        debate_focus?: string;
        public?: boolean;
        prototype?: boolean;
      };
      const result = await startMeeting(agent, agenda, context, provider, model, base_url, mode, debate_focus, isPublic === true, prototype === true);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case SAY: {
      const { meeting_id, message } = args as {
        meeting_id: string;
        message: string;
      };
      assertAcceptsInput(meeting_id, collaborations.get(meeting_id)?.origin);
      const response = await continueMeeting(meeting_id, message);
      const tracker = meetings.get(meeting_id)?.prototype;
      return {
        content: [{ type: "text", text: tracker ? response + prototypeTrailer(tracker) : response }],
      };
    }

    case END_MEETING: {
      const { meeting_id, request_summary } = args as {
        meeting_id: string;
        request_summary?: boolean;
      };
      const result = await endMeeting(meeting_id, request_summary ?? false);
      return {
        content: [{ type: "text", text: result }],
      };
    }

    case LIST_MEETINGS: {
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
    case START_LOCAL_MEETING: {
      const { agent, agenda, context, mode, debate_focus, public: isPublic, prototype } = args as {
        agent: string;
        agenda: string;
        context?: string;
        mode?: MeetingMode;
        debate_focus?: string;
        public?: boolean;
        prototype?: boolean;
      };
      const result = await startLocalMeeting(agent, agenda, context, mode, debate_focus, isPublic === true, prototype === true);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case SAY_LOCAL: {
      const { meeting_id, message } = args as {
        meeting_id: string;
        message: string;
      };
      assertAcceptsInput(meeting_id, collaborations.get(meeting_id)?.origin);
      const response = await continueLocalMeeting(meeting_id, message);
      const tracker = localMeetings.get(meeting_id)?.prototype;
      return {
        content: [{ type: "text", text: tracker ? response + prototypeTrailer(tracker) : response }],
      };
    }

    case END_LOCAL_MEETING: {
      const { meeting_id, request_summary } = args as {
        meeting_id: string;
        request_summary?: boolean;
      };
      const result = await endLocalMeeting(meeting_id, request_summary ?? false);
      return {
        content: [{ type: "text", text: result }],
      };
    }

    case LIST_LOCAL_MEETINGS: {
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
    case CHAT_COMPLETION: {
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
    case START_COLLABORATION: {
      const { agents, topic, context, max_rounds, auto_run_rounds, provider, model, base_url, mode, debate_focus, grounding, public: isPublic, prototype } = args as {
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
        prototype?: boolean;
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
        ...(prototype === true && { prototype: true }),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case CONTINUE_COLLABORATION: {
      const { collaboration_id, rounds } = args as {
        collaboration_id: string;
        rounds?: number;
      };

      assertAcceptsInput(collaboration_id, collaborations.get(collaboration_id)?.origin);
      const result = await continueCollaboration(collaboration_id, rounds ?? 1);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case NUDGE_COLLABORATION: {
      const { collaboration_id, message } = args as {
        collaboration_id: string;
        message: string;
      };

      assertAcceptsInput(collaboration_id, collaborations.get(collaboration_id)?.origin);
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

    case PAUSE_COLLABORATION: {
      const { collaboration_id } = args as { collaboration_id: string };
      const result = pauseCollaboration(collaboration_id);
      return {
        content: [{ type: "text", text: result }],
      };
    }

    case END_COLLABORATION: {
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
      if (result.prototypeOutcomes) {
        output += `${result.summary ? "\n\n" : ""}${result.prototypeOutcomes}`;
      }
      if (result.publicBlock) {
        output += `\n\n${result.publicBlock}`;
      }

      return {
        content: [{ type: "text", text: output }],
      };
    }

    case GET_COLLABORATION_TRANSCRIPT: {
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

    case LIST_COLLABORATIONS: {
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
    case START_ULTRAPLAN: {
      const { agents, task, context: given, draft_plan, planner, revision_rounds, execution_ready, repo_dir, public: isPublic, provider, model, base_url } = (args ?? {}) as {
        agents: string[];
        task: string;
        context?: string;
        repo_dir?: string;
        draft_plan?: string;
        planner?: string;
        revision_rounds?: number;
        execution_ready?: boolean;
        public?: boolean;
        provider?: LLMProvider;
        model?: string;
        base_url?: string;
      };
      // What earlier postmortems of the project taught is read whether or not postmortem mode is on now.
      const lessons = repo_dir ? ultraplanSection((await resolveRepo(repo_dir)).root) : "";
      const context = [given, lessons].filter((x) => x?.trim()).join("\n\n") || undefined;
      const result = await startUltraplan(agents, task, {
        context,
        draftPlan: draft_plan,
        planner,
        revisionRounds: revision_rounds,
        executionReady: execution_ready === true,
        public: isPublic === true,
        provider,
        model,
        baseUrl: base_url,
      });
      return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
    }

    case SUBMIT_PLAN: {
      const { ultraplan_id, plan, final } = (args ?? {}) as { ultraplan_id: string; plan?: string; final?: boolean };
      const result = await submitPlan(ultraplan_id, plan, final === true);
      return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
    }

    case END_ULTRAPLAN: {
      const { ultraplan_id } = (args ?? {}) as { ultraplan_id: string };
      const result = await endUltraplan(ultraplan_id);
      return { content: [{ type: "text", text: formatUltraplanResult(result) }] };
    }

    // === Agent Creation and Refinement Tools ===
    case CREATE_AGENT: {
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
      const result = await createAgent({
        agents, task, context, fromSession: from_session, name: agentName, rounds, write,
        performTask: perform_task, public: isPublic === true, provider, model, baseUrl: base_url,
      });
      return { content: [{ type: "text", text: formatAgentWorkshopResult(result) }] };
    }

    case IMPROVE_AGENT: {
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
      const result = await improveAgent({
        agent, with: specialists, includeSelf: include_self, focus, context, fromSession: from_session,
        rounds, write, public: isPublic === true, provider, model, baseUrl: base_url,
      });
      return { content: [{ type: "text", text: formatAgentWorkshopResult(result) }] };
    }

    case DEBUG_ENV: {
      // Presence only: no prefix, no length — nothing derived from the secret leaves the process.
      const keyStatus = (name: string) => (process.env[name] ? "configured" : "NOT SET");
      const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;

      // Check if claude CLI is available for local meetings (PATH scan, no shell)
      const claudeCliAvailable = findExecutable("claude") !== null;

      const debugInfo = {
        version: VERSION,
        anthropic_api_key: keyStatus("ANTHROPIC_API_KEY"),
        openai_api_key: keyStatus("OPENAI_API_KEY"),
        together_api_key: keyStatus("TOGETHER_API_KEY"),
        replicate_api_token: keyStatus("REPLICATE_API_TOKEN"),
        openai_compatible: {
          base_url: process.env.OPENAI_COMPATIBLE_BASE_URL ? describeUrl(process.env.OPENAI_COMPATIBLE_BASE_URL) : "NOT SET",
          api_key: keyStatus("OPENAI_COMPATIBLE_API_KEY"),
        },
        // Every URL as scheme://host[:port] only: userinfo may hold a password, a path or query a token.
        ollama: { url: describeUrl(OLLAMA_URL), reachable: await isOllamaAvailable() },
        default_models: DEFAULT_MODELS,
        max_tokens: MAX_TOKENS,
        llm_timeout_ms: LLM_TIMEOUT_MS,
        agents_dir: agentsDir || "NOT SET (defaulting to .claude/agents)",
        skills_dir: SKILLS_DIR,
        workspace_dir: WORKSPACE_DIR,
        activity_log: ACTIVITY_LOG_PATH ?? "off",
        sessions_dir: SESSIONS_DIR,
        parallel_turns: PARALLEL_TURNS,
        public_sessions: {
          publisher: PUBLISHER_KIND,
          ...(PUBLISHER_KIND === "webhook"
            ? {
                webhook_url: WEBHOOK_URL ? `configured (${describeUrl(WEBHOOK_URL)}, path/query hidden)` : "NOT SET",
                webhook_view_url: WEBHOOK_VIEW_URL ? `configured (${describeUrl(WEBHOOK_VIEW_URL)}, path/query hidden)` : "NOT SET",
                webhook_auth_header: WEBHOOK_AUTH_HEADER ? "configured" : "not set",
              }
            : {
                server_url: describeUrl(NTFY_URL),
                token: NTFY_TOKEN ? "configured" : "not set",
                user: NTFY_USER ? "configured" : "not set",
                password: NTFY_PASSWORD ? "configured" : "not set",
              }),
          topic_prefix: PUBLIC_TOPIC_PREFIX,
          transcripts_dir: TRANSCRIPTS_DIR,
        },
        prototypes: prototypeDiagnostics(),
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
}
