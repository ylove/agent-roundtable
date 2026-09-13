// ============================================================================
// Collaboration Functions (Agent-to-Agent)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS } from "../config.js";
import { loadAgentPrompt } from "../agents.js";
import { callLLM } from "../providers/index.js";

export interface CollaborationAgent {
  name: string;
  systemPrompt: string;
}

export interface CollaborationMessage {
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
}

export const collaborations = new Map<string, Collaboration>();
let collaborationCounter = 0;

export async function startCollaboration(
  agentNames: string[],
  topic: string,
  options: {
    context?: string;
    maxRounds?: number;
    autoRun?: boolean;
    runRounds?: number;
    provider?: LLMProvider;
    model?: string;
    baseUrl?: string;
  } = {}
): Promise<{
  collaborationId: string;
  messages: CollaborationMessage[];
  status: string;
}> {
  if (agentNames.length < 2) {
    throw new Error("Collaboration requires at least 2 agents");
  }

  const provider = options.provider || "anthropic";
  const resolvedModel = options.model || DEFAULT_MODELS[provider];
  const baseUrl = options.baseUrl;

  // Load all agent prompts
  const agents: CollaborationAgent[] = [];
  for (const name of agentNames) {
    const systemPrompt = await loadAgentPrompt(name);
    agents.push({ name, systemPrompt });
  }

  const collaborationId = `collab-${++collaborationCounter}`;
  const maxRounds = options.maxRounds || 5;

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
  };

  collaborations.set(collaborationId, collaboration);

  // Build initial prompt for first agent
  let initialPrompt = `You are entering a collaborative discussion with other agents.\n\n`;
  initialPrompt += `**Topic:** ${topic}\n\n`;
  initialPrompt += `**Participants:** ${agents.map((a) => a.name).join(", ")}\n\n`;
  if (options.context) {
    initialPrompt += `**Context:**\n${options.context}\n\n`;
  }
  initialPrompt += `Please share your initial thoughts on this topic. Be substantive but concise. `;
  initialPrompt += `Other agents will respond, and you'll have opportunities to refine your position.`;

  // Get first agent's response
  const firstAgent = agents[0];
  const firstMessage = await callLLM(
    firstAgent.systemPrompt,
    [{ role: "user", content: initialPrompt }],
    { provider, model: resolvedModel, baseUrl }
  );

  collaboration.messages.push({
    agent: firstAgent.name,
    content: firstMessage,
    timestamp: new Date(),
  });
  collaboration.currentAgentIndex = 1;

  // Auto-run additional rounds if requested
  if (options.autoRun && options.runRounds && options.runRounds > 0) {
    const totalTurns = options.runRounds * agents.length;
    for (let i = 0; i < totalTurns && collaboration.status === "running"; i++) {
      await advanceCollaboration(collaboration);
    }
  }

  return {
    collaborationId,
    messages: collaboration.messages,
    status: collaboration.status,
  };
}

export async function advanceCollaboration(
  collaboration: Collaboration
): Promise<CollaborationMessage | null> {
  if (collaboration.status !== "running") {
    return null;
  }

  // Check if we've completed all rounds
  const turnsPerRound = collaboration.agents.length;
  const totalTurns = collaboration.messages.length;
  collaboration.currentRound = Math.floor(totalTurns / turnsPerRound);

  if (collaboration.currentRound >= collaboration.maxRounds) {
    collaboration.status = "completed";
    return null;
  }

  const currentAgent = collaboration.agents[collaboration.currentAgentIndex];

  // Build conversation history for this agent
  let conversationContext = `You are in a collaborative discussion.\n\n`;
  conversationContext += `**Topic:** ${collaboration.topic}\n\n`;
  conversationContext += `**Participants:** ${collaboration.agents.map((a) => a.name).join(", ")}\n\n`;
  if (collaboration.context) {
    conversationContext += `**Background Context:**\n${collaboration.context}\n\n`;
  }
  conversationContext += `**Discussion so far:**\n\n`;

  for (const msg of collaboration.messages) {
    conversationContext += `**${msg.agent}:** ${msg.content}\n\n`;
  }

  conversationContext += `---\n\nIt's your turn to respond. Consider what others have said, `;
  conversationContext += `build on good ideas, respectfully challenge points you disagree with, `;
  conversationContext += `and move toward actionable conclusions.`;

  const messageContent = await callLLM(
    currentAgent.systemPrompt,
    [{ role: "user", content: conversationContext }],
    { provider: collaboration.provider, model: collaboration.model, baseUrl: collaboration.baseUrl }
  );

  const newMessage: CollaborationMessage = {
    agent: currentAgent.name,
    content: messageContent,
    timestamp: new Date(),
  };

  collaboration.messages.push(newMessage);

  // Move to next agent
  collaboration.currentAgentIndex =
    (collaboration.currentAgentIndex + 1) % collaboration.agents.length;

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
    agent: "ORCHESTRATOR",
    content: message,
    timestamp: new Date(),
  };
  collaboration.messages.push(orchestratorMessage);

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
): Promise<{ transcript: CollaborationMessage[]; summary?: string }> {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }

  let summary: string | undefined;

  if (requestSummary && collaboration.messages.length > 0) {
    // Ask the first agent to summarize (they initiated)
    const summarizer = collaboration.agents[0];

    let summaryPrompt = `You participated in a collaborative discussion. Please provide a brief summary of:\n`;
    summaryPrompt += `1. Key points of agreement\n`;
    summaryPrompt += `2. Points of disagreement or tension\n`;
    summaryPrompt += `3. Actionable conclusions or next steps\n\n`;
    summaryPrompt += `**Full transcript:**\n\n`;

    for (const msg of collaboration.messages) {
      summaryPrompt += `**${msg.agent}:** ${msg.content}\n\n`;
    }

    summary = await callLLM(
      summarizer.systemPrompt,
      [{ role: "user", content: summaryPrompt }],
      { provider: collaboration.provider, model: collaboration.model, baseUrl: collaboration.baseUrl }
    );
  }

  const transcript = [...collaboration.messages];
  collaborations.delete(collaborationId);

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
  baseUrl?: string;
}> {
  return Array.from(collaborations.values()).map((c) => ({
    id: c.id,
    agents: c.agents.map((a) => a.name),
    topic: c.topic,
    messageCount: c.messages.length,
    currentRound: c.currentRound,
    maxRounds: c.maxRounds,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    provider: c.provider,
    model: c.model,
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
