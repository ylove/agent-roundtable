// ============================================================================
// Collaboration Functions (Agent-to-Agent)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS } from "../config.js";
import { agentKey, loadAgent, loadAgentPrompt, renderSkillsSection } from "../agents.js";
import { recordActivity } from "../activity.js";
import { callLLM } from "../providers/index.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel, type FinalizeResult } from "./public.js";
import type { CollaborationMode, CollaborationRole, ConversationAngle } from "./modes.js";
import { buildGrounding, type Grounding } from "./grounding.js";
import {
  assertCollaborationMode,
  buildConversationDirective,
  buildConversationOpeningPrompt,
  buildConversationTurnPrompt,
  buildConversationSummaryPrompt,
  pickOpeningAngle,
  buildAttackerDirective,
  buildAttackerTurnPrompt,
  buildChallengerDirective,
  buildChallengerTurnPrompt,
  buildDebateSummaryPrompt,
  buildDefenderOpeningPrompt,
  buildDefenderTurnPrompt,
  buildProponentDirective,
  buildWaffleHouseSummaryPrompt,
} from "./modes.js";

export interface CollaborationAgent {
  name: string;
  systemPrompt: string;
  /** Set in debate (proponent/challenger) and waffle-house (defender/attacker) modes. */
  role?: CollaborationRole;
}

/** Author name used for messages injected by the caller (nudges). These are not agent turns. */
export const ORCHESTRATOR = "ORCHESTRATOR";

export interface CollaborationMessage {
  /** Index into collaboration.agents of the speaker; absent for nudges. Disambiguates repeated names. */
  agentIndex?: number;
  agent: string;
  content: string;
  timestamp: Date;
}

export interface Collaboration {
  id: string;
  agents: CollaborationAgent[];
  topic: string;
  context?: string;
  messages: CollaborationMessage[];
  currentAgentIndex: number;
  maxRounds: number;
  currentRound: number;
  status: "running" | "paused" | "completed";
  startedAt: Date;
  provider: LLMProvider;
  model: string;
  /** Only with provider "openai_compatible": base URL pinned for the life of the collaboration. */
  baseUrl?: string;
  mode: CollaborationMode;
  debateFocus?: string;
  conversationAngle?: ConversationAngle;
  groundingSources?: Grounding["sources"];
  /** Set when the collaboration was started with public: true. */
  publicChannel?: PublicChannel;
}

export const collaborations = new Map<string, Collaboration>();
let collaborationCounter = 0;

// ----------------------------------------------------------------------------
// Recording: the single choke point for everything pushed into collaboration.messages
// ----------------------------------------------------------------------------

export type CollaborationRecordHook = (
  collaboration: Collaboration,
  message: CollaborationMessage
) => void;

let recordHook: CollaborationRecordHook | undefined;

/** Install (or clear, with undefined) the hook called after every recorded message. No-op by default. */
export function setCollaborationRecordHook(hook: CollaborationRecordHook | undefined): void {
  recordHook = hook;
}

/** Append a message to the transcript. Hook failures are swallowed: recording must never break a session. */
export function recordCollaborationMessage(
  collaboration: Collaboration,
  message: CollaborationMessage
): CollaborationMessage {
  collaboration.messages.push(message);
  // Public mirror. Turn numbers are monotonic over all messages (nudges included) so the public record stays in order.
  collaboration.publicChannel?.record({
    turn: collaboration.messages.length,
    speaker: message.agent,
    content: message.content,
    kind: message.agent === ORCHESTRATOR ? "nudge" : "turn",
  });
  if (recordHook) {
    try {
      const r: unknown = recordHook(collaboration, message);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((e) =>
          console.error(`[Collab] record hook failed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    } catch (e) {
      console.error(`[Collab] record hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return message;
}

// ----------------------------------------------------------------------------
// Round accounting (agent turns only; ORCHESTRATOR nudges never count)
// ----------------------------------------------------------------------------

export function countAgentTurns(collaboration: Collaboration): number {
  return collaboration.messages.filter((m) => m.agent !== ORCHESTRATOR).length;
}

/**
 * Plain/debate: complete when floor(agentTurns / N) >= maxRounds.
 * Waffle-house: opening turn + maxRounds volleys of N turns (each volley ends on the defender),
 * so the session always finishes on a defender turn.
 */
export function isCollaborationComplete(collaboration: Collaboration): boolean {
  const agentTurns = countAgentTurns(collaboration);
  const n = collaboration.agents.length;
  if (collaboration.mode === "waffle-house") {
    return agentTurns >= 1 + collaboration.maxRounds * n;
  }
  return Math.floor(agentTurns / n) >= collaboration.maxRounds;
}

function computeCurrentRound(collaboration: Collaboration): number {
  const agentTurns = countAgentTurns(collaboration);
  const n = collaboration.agents.length;
  if (collaboration.mode === "waffle-house") {
    // Completed volleys; the opening turn is round 0.
    return Math.floor(Math.max(0, agentTurns - 1) / n);
  }
  return Math.floor(agentTurns / n);
}

/** Name shown to the LLM: public sessions must not echo a raw agent argument (it can be a private path). */
function nameFor(name: string, pub: boolean): string {
  return pub ? publicLabel(name) : name;
}

function roleLabel(mode: CollaborationMode, a: CollaborationAgent, pub = false): string {
  const name = nameFor(a.name, pub);
  if (mode === "debate" && a.role === "challenger") return `${name} (challenger)`;
  if (mode === "waffle-house") {
    return a.role === "attacker" ? `${name} (attacker)` : `${name} (defender)`;
  }
  return name;
}

export async function startCollaboration(
  agentNames: string[],
  topic: string | undefined,
  options: {
    context?: string;
    maxRounds?: number;
    autoRun?: boolean;
    runRounds?: number;
    provider?: LLMProvider;
    model?: string;
    baseUrl?: string;
    mode?: CollaborationMode;
    debateFocus?: string;
    public?: boolean;
    grounding?: boolean;
  } = {}
): Promise<{
  collaborationId: string;
  messages: CollaborationMessage[];
  status: string;
  public?: { url: string | null; topic: string };
  /** Set when a public session's auto-run stopped on a provider error (session left paused). */
  error?: string;
}> {
  if (agentNames.length < 2) {
    throw new Error("Collaboration requires at least 2 agents");
  }

  const provider = options.provider || "anthropic";
  const resolvedModel = options.model || DEFAULT_MODELS[provider];
  const baseUrl = options.baseUrl;
  const mode: CollaborationMode = options.mode ?? "collaborate";
  assertCollaborationMode(mode);
  if (mode !== "conversation" && !topic?.trim()) {
    throw new Error('topic is required (only mode "conversation" may omit it)');
  }
  topic = topic?.trim() ? topic : "";
  const debateFocus = options.debateFocus;
  const groundingSources: Grounding["sources"] = [];
  let openingSources: Grounding["sources"] = [];

  // Load all agent prompts (debate: agents[0] proponent, others challengers;
  // waffle-house: agents[0] defender, others attackers)
  const agents: CollaborationAgent[] = [];
  for (const [i, name] of agentNames.entries()) {
    let systemPrompt: string;
    if (mode === "conversation") {
      const loaded = await loadAgent(name);
      systemPrompt = loaded.body + renderSkillsSection(loaded.skills) + buildConversationDirective({ public: !!options.public });
      if (options.grounding !== false && !options.public) {
        const grounding = await buildGrounding(loaded);
        if (grounding.text) systemPrompt += "\n\n" + grounding.text;
        if (i === 0) openingSources = grounding.sources;
        for (const source of grounding.sources) {
          if (!groundingSources.includes(source)) groundingSources.push(source);
        }
      }
    } else {
      systemPrompt = await loadAgentPrompt(name);
    }
    let role: CollaborationRole | undefined;
    if (mode === "debate") {
      role = i === 0 ? "proponent" : "challenger";
      if (i > 0) systemPrompt += buildChallengerDirective(debateFocus);
    } else if (mode === "waffle-house") {
      role = i === 0 ? "defender" : "attacker";
      if (i > 0) systemPrompt += buildAttackerDirective();
    }
    if (options.public) systemPrompt += publicDirectiveSuffix();
    agents.push({ name, systemPrompt, ...(role !== undefined && { role }) });
  }

  const collaborationId = `collab-${++collaborationCounter}`;
  const maxRounds = options.maxRounds || 5;
  const isPublic = !!options.public;
  const roleNames = agents.map((a) => roleLabel(mode, a, isPublic));
  const conversationAngle = mode === "conversation" ? pickOpeningAngle({
    activity: openingSources.includes("activity"),
    memory: openingSources.includes("memory"),
    workspace: openingSources.includes("workspace"),
  }, topic, Math.random, { public: isPublic }) : undefined;
  // Created before the first LLM call so the header is the first post. Only topic (never context) is
  // published. Config errors fail the start.
  const publicChannel = options.public
    ? openPublicChannel(collaborationId, { mode, participants: roleNames, topic: topic || "(open conversation)" })
    : undefined;

  const collaboration: Collaboration = {
    id: collaborationId,
    agents,
    topic,
    context: options.context,
    messages: [],
    currentAgentIndex: 0,
    maxRounds,
    currentRound: 0,
    status: "running",
    startedAt: new Date(),
    provider,
    model: resolvedModel,
    ...(baseUrl !== undefined && { baseUrl }),
    mode,
    ...(conversationAngle !== undefined && { conversationAngle, groundingSources }),
    ...(debateFocus !== undefined && { debateFocus }),
    ...(publicChannel && { publicChannel }),
  };

  collaborations.set(collaborationId, collaboration);

  // Build initial prompt for first agent
  let initialPrompt: string;
  if (mode === "conversation") {
    initialPrompt = buildConversationOpeningPrompt(conversationAngle!, roleNames, topic);
    if (options.context) initialPrompt += `\n\n**Background Context:**\n${options.context}`;
  } else if (mode === "debate") {
    initialPrompt = `You are entering a structured debate. You are the **proponent**.\n\n`;
    initialPrompt += `**Topic:** ${topic}\n\n`;
    initialPrompt += `**Participants:** ${roleNames.join(", ")}\n\n`;
    if (options.context) {
      initialPrompt += `**Context:**\n${options.context}\n\n`;
    }
    initialPrompt += buildProponentDirective(debateFocus);
    initialPrompt += ` State your position and the strongest case for it now; the other participants will challenge it and you will be able to respond.`;
  } else if (mode === "waffle-house") {
    initialPrompt = `You are entering a waffle-house session: an adversarial gauntlet. You are the **defender**.\n\n`;
    initialPrompt += `**Topic (the idea to defend):** ${topic}\n\n`;
    initialPrompt += `**Participants:** ${roleNames.join(", ")}\n\n`;
    if (options.context) {
      initialPrompt += `**Context:**\n${options.context}\n\n`;
    }
    initialPrompt += buildDefenderOpeningPrompt();
  } else {
    initialPrompt = `You are entering a collaborative discussion with other agents.\n\n`;
    initialPrompt += `**Topic:** ${topic}\n\n`;
    initialPrompt += `**Participants:** ${roleNames.join(", ")}\n\n`;
    if (options.context) {
      initialPrompt += `**Context:**\n${options.context}\n\n`;
    }
    initialPrompt += `Please share your initial thoughts on this topic. Be substantive but concise. `;
    initialPrompt += `Other agents will respond, and you'll have opportunities to refine your position.`;
  }

  // Get first agent's response
  const firstAgent = agents[0];
  let firstMessage: string;
  try {
    firstMessage = await callLLM(
      firstAgent.systemPrompt,
      [{ role: "user", content: initialPrompt }],
      { provider, model: resolvedModel, baseUrl }
    );
  } catch (e) {
    // Nothing was said: do not leave an orphan session or an unfinalized public topic behind.
    collaborations.delete(collaborationId);
    if (publicChannel) void publicChannel.finalize();
    throw e;
  }

  recordCollaborationMessage(collaboration, {
    agentIndex: 0,
    agent: firstAgent.name,
    content: firstMessage,
    timestamp: new Date(),
  });
  collaboration.currentAgentIndex = 1;

  // Auto-run additional rounds if requested
  let autoRunError: string | undefined;
  if (options.autoRun && options.runRounds && options.runRounds > 0) {
    const totalTurns = options.runRounds * agents.length;
    try {
      for (let i = 0; i < totalTurns && collaboration.status === "running"; i++) {
        await advanceCollaboration(collaboration);
      }
    } catch (e) {
      if (!publicChannel) throw e;
      // Turns are already on the public topic: keep the id and URL reachable instead of losing them.
      collaboration.status = "paused";
      autoRunError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    collaborationId,
    messages: collaboration.messages,
    status: collaboration.status,
    ...(autoRunError !== undefined && { error: `Auto-run stopped: ${autoRunError}. The session is paused; use nudge_collaboration to resume or end_collaboration to close it.` }),
    ...(publicChannel && { public: { url: publicChannel.url, topic: publicChannel.topic } }),
  };
}

export async function advanceCollaboration(
  collaboration: Collaboration
): Promise<CollaborationMessage | null> {
  if (collaboration.status !== "running") {
    return null;
  }

  // Check if we've completed all rounds (agent turns only; nudges never count)
  collaboration.currentRound = computeCurrentRound(collaboration);

  if (isCollaborationComplete(collaboration)) {
    collaboration.status = "completed";
    return null;
  }

  const currentAgent = collaboration.agents[collaboration.currentAgentIndex];
  const mode = collaboration.mode;
  const pub = !!collaboration.publicChannel;

  // Build conversation history for this agent
  let conversationContext =
    mode === "debate"
      ? `You are in a structured debate. Your role: ${currentAgent.role}.\n\n`
      : mode === "waffle-house"
        ? `You are in a waffle-house session (an adversarial gauntlet). Your role: ${currentAgent.role}.\n\n`
        : mode === "conversation"
          ? `You are in an informal conversation.\n\n`
          : `You are in a collaborative discussion.\n\n`;
  if (mode !== "conversation") conversationContext += `**Topic:** ${collaboration.topic}\n\n`;
  conversationContext += `**Participants:** ${collaboration.agents.map((a) => roleLabel(mode, a, pub)).join(", ")}\n\n`;
  if (mode === "conversation" && collaboration.topic) {
    conversationContext += `Loose theme: ${collaboration.topic}. It's a starting point, not an agenda.\n\n`;
  }
  if (collaboration.context) {
    conversationContext += `**Background Context:**\n${collaboration.context}\n\n`;
  }
  conversationContext += mode === "conversation" ? `Conversation so far:\n\n` : `**Discussion so far:**\n\n`;

  for (const msg of collaboration.messages) {
    // Waffle-house: label by role so a persona that both defends and attacks can tell its own turns apart.
    const speaker =
      mode === "waffle-house" && msg.agentIndex !== undefined && collaboration.agents[msg.agentIndex]
        ? roleLabel(mode, collaboration.agents[msg.agentIndex], pub)
        : nameFor(msg.agent, pub);
    conversationContext += `**${speaker}:** ${msg.content}\n\n`;
  }

  if (mode === "conversation") {
    conversationContext += "---\n\n" + buildConversationTurnPrompt();
  } else if (mode === "debate" && currentAgent.role === "proponent") {
    conversationContext += "---\n\n" + "It's your turn. " + buildProponentDirective(collaboration.debateFocus);
  } else if (mode === "debate") {
    conversationContext += "---\n\n" + buildChallengerTurnPrompt(collaboration.debateFocus);
  } else if (mode === "waffle-house" && currentAgent.role === "defender") {
    const defenderTurns = collaboration.messages.filter((m) => m.agentIndex === collaboration.currentAgentIndex).length;
    conversationContext += "---\n\n" + buildDefenderTurnPrompt(defenderTurns + 1);
  } else if (mode === "waffle-house") {
    conversationContext += "---\n\n" + buildAttackerTurnPrompt();
  } else {
    conversationContext += `---\n\nIt's your turn to respond. Consider what others have said, `;
    conversationContext += `build on good ideas, respectfully challenge points you disagree with, `;
    conversationContext += `and move toward actionable conclusions.`;
  }

  const messageContent = await callLLM(
    currentAgent.systemPrompt,
    [{ role: "user", content: conversationContext }],
    { provider: collaboration.provider, model: collaboration.model, baseUrl: collaboration.baseUrl }
  );

  const newMessage: CollaborationMessage = {
    agentIndex: collaboration.currentAgentIndex,
    agent: currentAgent.name,
    content: messageContent,
    timestamp: new Date(),
  };

  recordCollaborationMessage(collaboration, newMessage);

  // Move to next agent
  collaboration.currentAgentIndex =
    (collaboration.currentAgentIndex + 1) % collaboration.agents.length;

  // Report accurate progress right away (a nudge or a pause in between must not see a stale round),
  // and flip to completed as soon as the last budgeted turn lands.
  collaboration.currentRound = computeCurrentRound(collaboration);
  if (isCollaborationComplete(collaboration)) collaboration.status = "completed";

  return newMessage;
}

export async function continueCollaboration(
  collaborationId: string,
  rounds: number = 1
): Promise<{
  newMessages: CollaborationMessage[];
  status: string;
  currentRound: number;
  maxRounds: number;
}> {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }

  if (collaboration.status !== "running") {
    return {
      newMessages: [],
      status: collaboration.status,
      currentRound: collaboration.currentRound,
      maxRounds: collaboration.maxRounds,
    };
  }

  const newMessages: CollaborationMessage[] = [];
  const totalTurns = rounds * collaboration.agents.length;

  for (let i = 0; i < totalTurns && collaboration.status === "running"; i++) {
    const msg = await advanceCollaboration(collaboration);
    if (msg) {
      newMessages.push(msg);
    }
  }

  return {
    newMessages,
    status: collaboration.status,
    currentRound: collaboration.currentRound,
    maxRounds: collaboration.maxRounds,
  };
}

export async function nudgeCollaboration(
  collaborationId: string,
  message: string
): Promise<CollaborationMessage> {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }

  // Add orchestrator message to the thread
  const orchestratorMessage: CollaborationMessage = {
    agent: ORCHESTRATOR,
    content: message,
    timestamp: new Date(),
  };
  recordCollaborationMessage(collaboration, orchestratorMessage);

  // Resume if paused
  if (collaboration.status === "paused") {
    collaboration.status = "running";
  }

  return orchestratorMessage;
}

export function pauseCollaboration(collaborationId: string): string {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }
  collaboration.status = "paused";
  return `Collaboration ${collaborationId} paused at round ${collaboration.currentRound}/${collaboration.maxRounds}`;
}

export async function endCollaboration(
  collaborationId: string,
  requestSummary: boolean = false
): Promise<{ transcript: CollaborationMessage[]; summary?: string; publicBlock?: string; publicResult?: FinalizeResult }> {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }

  let summary: string | undefined;

  if (requestSummary && collaboration.messages.length > 0) {
    // Ask the first agent to summarize (they initiated; in debate/waffle-house they are the proponent/defender)
    const summarizer = collaboration.agents[0];

    let summaryPrompt: string;
    if (collaboration.mode === "conversation") {
      summaryPrompt = buildConversationSummaryPrompt(collaboration.topic);
    } else if (collaboration.mode === "debate") {
      summaryPrompt = buildDebateSummaryPrompt(collaboration.topic);
    } else if (collaboration.mode === "waffle-house") {
      summaryPrompt = buildWaffleHouseSummaryPrompt(collaboration.topic);
    } else {
      summaryPrompt = `You participated in a collaborative discussion. Please provide a brief summary of:\n`;
      summaryPrompt += `1. Key points of agreement\n`;
      summaryPrompt += `2. Points of disagreement or tension\n`;
      summaryPrompt += `3. Actionable conclusions or next steps\n\n`;
    }
    summaryPrompt += `**Full transcript:**\n\n`;

    for (const msg of collaboration.messages) {
      summaryPrompt += `**${nameFor(msg.agent, !!collaboration.publicChannel)}:** ${msg.content}\n\n`;
    }

    summary = await callLLM(
      summarizer.systemPrompt,
      [{ role: "user", content: summaryPrompt }],
      { provider: collaboration.provider, model: collaboration.model, baseUrl: collaboration.baseUrl }
    );
  }

  recordActivity({
    session: collaborationId,
    kind: "collaboration",
    mode: collaboration.mode,
    agents: collaboration.agents.map((agent) => agentKey(agent.name)),
    topic: collaboration.topic,
    outcome: summary || collaboration.messages.slice().reverse().find((m) => m.agent !== ORCHESTRATOR)?.content,
    public: collaboration.publicChannel !== undefined,
  });
  const transcript = [...collaboration.messages];
  collaborations.delete(collaborationId);

  if (collaboration.publicChannel) {
    const publicResult = await collaboration.publicChannel.finalize({ summary });
    return {
      transcript,
      summary,
      publicResult,
      publicBlock: formatPublicBlock(collaboration.publicChannel, publicResult),
    };
  }
  return { transcript, summary };
}

export function listCollaborations(): Array<{
  id: string;
  agents: string[];
  topic: string;
  messageCount: number;
  currentRound: number;
  maxRounds: number;
  status: string;
  startedAt: string;
  provider: LLMProvider;
  model: string;
  mode: CollaborationMode;
  conversationAngle?: ConversationAngle;
  grounding?: Grounding["sources"];
  public: boolean;
  baseUrl?: string;
}> {
  return Array.from(collaborations.values()).map((c) => ({
    id: c.id,
    agents: c.agents.map((a) => a.name),
    topic: c.topic || (c.mode === "conversation" ? "(open conversation)" : ""),
    messageCount: c.messages.length,
    currentRound: c.currentRound,
    maxRounds: c.maxRounds,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    provider: c.provider,
    model: c.model,
    mode: c.mode,
    ...(c.mode === "conversation" && { conversationAngle: c.conversationAngle, grounding: c.groundingSources }),
    public: c.publicChannel !== undefined,
    ...(c.baseUrl !== undefined && { baseUrl: c.baseUrl }),
  }));
}

export function getCollaborationTranscript(
  collaborationId: string
): CollaborationMessage[] {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }
  return [...collaboration.messages];
}
