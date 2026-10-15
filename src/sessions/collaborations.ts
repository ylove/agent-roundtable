// ============================================================================
// Collaboration Functions (Agent-to-Agent)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS } from "../config.js";
import { agentKey, loadAgent, loadAgentPrompt, renderSkillsSection } from "../agents.js";
import { recordActivity } from "../activity.js";
import { newId } from "../ids.js";
import { sessionBusyMessage, withSessionLock } from "./lock.js";
import { callLLM } from "../providers/index.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel, type FinalizeResult } from "./public.js";
import type { CollaborationMode, CollaborationRole, ConversationAngle } from "./modes.js";
import { buildGrounding, type Grounding } from "./grounding.js";
import {
  NUDGE_HELD_ERROR,
  PROTOTYPE_CONVERSATION_ERROR,
  closePrototypeTracker,
  openSessionSurfaces,
  postPrototypeAttachments,
  prototypeSystemSuffix,
  publicSummary,
  serializeTurn,
  type PrototypeTracker,
} from "./prototype-mode.js";
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
  /** Set when the collaboration was started with prototype: true. */
  prototype?: PrototypeTracker;
}

export const collaborations = new Map<string, Collaboration>();

/** Hard cap on max_rounds and on rounds per continue (the tool schemas declare the same maximum). */
export const MAX_COLLABORATION_ROUNDS = 20;

function collaborationBusy(id: string): string {
  return sessionBusyMessage("Collaboration", id);
}

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

/**
 * Append a message to the transcript. Hook failures are swallowed: recording must never break a session.
 * publicText overrides what is posted (prototype sessions post a URL-free reference instead of the raw block).
 */
export function recordCollaborationMessage(
  collaboration: Collaboration,
  message: CollaborationMessage,
  publicText?: string
): CollaborationMessage {
  collaboration.messages.push(message);
  // Public mirror. Turn numbers are monotonic over all messages (nudges included) so the public record stays in order.
  collaboration.publicChannel?.record({
    turn: collaboration.messages.length,
    speaker: message.agent,
    content: publicText ?? message.content,
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

/** Total agent turns the session runs (the threshold isCollaborationComplete checks). */
function agentTurnBudget(collaboration: Collaboration): number {
  const n = collaboration.agents.length;
  return collaboration.mode === "waffle-house" ? 1 + collaboration.maxRounds * n : collaboration.maxRounds * n;
}

/** Added to every non-empty prototype status: decisions are the proposer's alone. */
const DECISION_OWNERSHIP_LINE =
  "Only a prototype's proposer decides on it (SHORTLIST, SCRAP or REVISE): decide only on your own prototypes, " +
  "and on another participant's prototype give a verdict only.";

/**
 * Prototype status for the agent about to speak ("" outside prototype mode), without its leading blank
 * lines. A prototype proposed now needs a turn from each of the other n-1 agents to be assessed, then
 * one more from its proposer to decide: when fewer than n agent turns remain after this one, the agent
 * is told not to start one (it could never be shortlisted).
 */
function prototypeStatusFor(collaboration: Collaboration, agentIndex: number): string {
  const tracker = collaboration.prototype;
  if (!tracker) return "";
  let status = tracker.statusPromptFor(agentIndex).replace(/^\n+/, "");
  if (status) status += `\n${DECISION_OWNERSHIP_LINE}`;
  const remainingAfter = agentTurnBudget(collaboration) - countAgentTurns(collaboration) - 1;
  if (remainingAfter < collaboration.agents.length) {
    const line =
      "This is the final round: do not start a new prototype or a revision (there are not enough turns left to assess it and decide on it). " +
      "Give any verdicts you still owe, and decide SHORTLIST or SCRAP on your own assessed prototypes.";
    status = status ? `${status}\n${line}` : `## Prototype status\n${line}`;
  }
  return status;
}

/** Agent-facing text of a recorded message: resolved prototypes appear as stubs. */
function historyContent(collaboration: Collaboration, message: CollaborationMessage, index: number): string {
  return collaboration.prototype ? collaboration.prototype.historyView(message.content, index) : message.content;
}

/**
 * Run the tracker on an agent turn BEFORE it is recorded, record it (with the URL-free public form in
 * public sessions), then post any screenshots under the same public turn number. Serialized with nudges
 * so the turn is recorded at exactly the index the tracker keyed it by.
 */
async function recordAgentTurn(collaboration: Collaboration, message: CollaborationMessage): Promise<void> {
  const tracker = collaboration.prototype;
  if (!tracker) {
    recordCollaborationMessage(collaboration, message);
    return;
  }
  await serializeTurn(collaboration, async () => {
    const turnKey = collaboration.messages.length;
    const result = await tracker.onTurn(message.agentIndex ?? 0, message.content, turnKey);
    const publicText = collaboration.publicChannel ? tracker.publicView(message.content, turnKey) : undefined;
    recordCollaborationMessage(collaboration, message, publicText);
    postPrototypeAttachments(collaboration.publicChannel, collaboration.messages.length, message.agent, result.attachments);
  });
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
    prototype?: boolean;
  } = {}
): Promise<{
  collaborationId: string;
  messages: CollaborationMessage[];
  status: string;
  public?: { url: string | null; topic: string };
  /** Set when a public session's auto-run stopped on a provider error (session left paused). */
  error?: string;
  /** Prototype sessions only. */
  prototypes?: ReturnType<PrototypeTracker["takeCallSummary"]>;
}> {
  const collaborationId = newId("collab");
  return withSessionLock(collaborationId, collaborationBusy(collaborationId), () =>
    openCollaboration(collaborationId, agentNames, topic, options)
  );
}

/** The opening turn and any auto-run, holding the session lock (the session is listed before the first call). */
async function openCollaboration(
  collaborationId: string,
  agentNames: string[],
  topic: string | undefined,
  options: NonNullable<Parameters<typeof startCollaboration>[2]>
): ReturnType<typeof startCollaboration> {
  if (agentNames.length < 2) {
    throw new Error("Collaboration requires at least 2 agents");
  }
  if (options.maxRounds !== undefined && options.maxRounds > MAX_COLLABORATION_ROUNDS) {
    throw new Error(`max_rounds must be at most ${MAX_COLLABORATION_ROUNDS} (got ${options.maxRounds})`);
  }

  const provider = options.provider || "anthropic";
  const resolvedModel = options.model || DEFAULT_MODELS[provider];
  const baseUrl = options.baseUrl;
  const mode: CollaborationMode = options.mode ?? "collaborate";
  assertCollaborationMode(mode);
  if (mode !== "conversation" && !topic?.trim()) {
    throw new Error('topic is required (only mode "conversation" may omit it)');
  }
  const isPrototype = options.prototype === true;
  if (isPrototype && mode === "conversation") {
    throw new Error(PROTOTYPE_CONVERSATION_ERROR);
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
    if (isPrototype) systemPrompt += prototypeSystemSuffix({ assessorIsCaller: false, public: !!options.public });
    agents.push({ name, systemPrompt, ...(role !== undefined && { role }) });
  }

  const maxRounds = options.maxRounds || 5;
  const isPublic = !!options.public;
  const roleNames = agents.map((a) => roleLabel(mode, a, isPublic));
  const conversationAngle = mode === "conversation" ? pickOpeningAngle({
    activity: openingSources.includes("activity"),
    memory: openingSources.includes("memory"),
    workspace: openingSources.includes("workspace"),
  }, topic, Math.random, { public: isPublic }) : undefined;
  // Prototype board, then public channel, both before the first LLM call so the header is the first post.
  // Only topic (never context) is published. Config errors fail the start (a public config error closes
  // the board first).
  const { prototype, publicChannel } = await openSessionSurfaces(
    isPrototype
      ? { sessionId: collaborationId, mode, participants: roleNames, assessorIsCaller: false, public: isPublic, topic }
      : undefined,
    () =>
      options.public
        ? openPublicChannel(collaborationId, { mode, participants: roleNames, topic: topic || "(open conversation)" })
        : undefined
  );

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
    ...(prototype && { prototype }),
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
  const openingStatus = prototypeStatusFor(collaboration, 0);
  if (openingStatus) initialPrompt += `\n\n${openingStatus}`;

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
    // Nothing was said: do not leave an orphan session, an unfinalized public topic or a board behind.
    collaborations.delete(collaborationId);
    if (publicChannel) void publicChannel.finalize();
    await closePrototypeTracker(prototype, "ended");
    throw e;
  }

  await recordAgentTurn(collaboration, {
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
      if (!publicChannel) {
        // The caller never receives this id. A private prototype session is removed with its board and
        // sandbox (it cannot prototype without them); a plain session is left as before.
        if (prototype) {
          collaborations.delete(collaborationId);
          await closePrototypeTracker(prototype, "ended");
        }
        throw e;
      }
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
    ...(prototype && { prototypes: prototype.takeCallSummary() }),
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
    if (collaboration.prototype) await closePrototypeTracker(collaboration.prototype, "completed");
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

  for (const [i, msg] of collaboration.messages.entries()) {
    // Waffle-house: label by role so a persona that both defends and attacks can tell its own turns apart.
    const speaker =
      mode === "waffle-house" && msg.agentIndex !== undefined && collaboration.agents[msg.agentIndex]
        ? roleLabel(mode, collaboration.agents[msg.agentIndex], pub)
        : nameFor(msg.agent, pub);
    conversationContext += `**${speaker}:** ${historyContent(collaboration, msg, i)}\n\n`;
  }
  // Prototype mode: verdicts owed, decisions due and validation errors, before the closing instruction.
  const protoStatus = prototypeStatusFor(collaboration, collaboration.currentAgentIndex);
  if (protoStatus) conversationContext += `${protoStatus}\n\n`;

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

  await recordAgentTurn(collaboration, newMessage);

  // Move to next agent
  collaboration.currentAgentIndex =
    (collaboration.currentAgentIndex + 1) % collaboration.agents.length;

  // Report accurate progress right away (a nudge or a pause in between must not see a stale round),
  // and flip to completed as soon as the last budgeted turn lands.
  collaboration.currentRound = computeCurrentRound(collaboration);
  if (isCollaborationComplete(collaboration)) collaboration.status = "completed";
  // Completion destroys every remaining artifact and stops the board (end_collaboration still lists outcomes).
  if (collaboration.prototype && collaboration.status === "completed") {
    await closePrototypeTracker(collaboration.prototype, "completed");
  }

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
  /** Prototype sessions only. */
  prototypes?: ReturnType<PrototypeTracker["takeCallSummary"]>;
}> {
  return withSessionLock(collaborationId, collaborationBusy(collaborationId), () => runRounds(collaborationId, rounds));
}

async function runRounds(collaborationId: string, rounds: number): ReturnType<typeof continueCollaboration> {
  if (rounds > MAX_COLLABORATION_ROUNDS) {
    throw new Error(`rounds must be at most ${MAX_COLLABORATION_ROUNDS} (got ${rounds})`);
  }
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }
  const tracker = collaboration.prototype;

  // Nudges (the usual way to resume) are held while a prototype is under assessment, so continuing
  // resumes a paused prototype session in that state instead of leaving it stuck until the TTL.
  if (tracker && collaboration.status === "paused" && tracker.hasLiveUnderAssessment()) {
    collaboration.status = "running";
  }

  if (collaboration.status !== "running") {
    return {
      newMessages: [],
      status: collaboration.status,
      currentRound: collaboration.currentRound,
      maxRounds: collaboration.maxRounds,
      ...(tracker && { prototypes: tracker.takeCallSummary() }),
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
    ...(tracker && { prototypes: tracker.takeCallSummary() }),
  };
}

export async function nudgeCollaboration(
  collaborationId: string,
  message: string
): Promise<CollaborationMessage> {
  return withSessionLock(collaborationId, collaborationBusy(collaborationId), () => {
    const collaboration = collaborations.get(collaborationId);
    if (!collaboration) {
      throw new Error(`Collaboration not found: ${collaborationId}`);
    }
    // Prototype sessions: wait for an agent turn the tracker is still processing, so the nudge neither
    // takes that turn's message index nor slips past a prototype the turn has just proposed.
    if (collaboration.prototype) return serializeTurn(collaboration, () => injectNudge(collaboration, message));
    return injectNudge(collaboration, message);
  });
}

function injectNudge(collaboration: Collaboration, message: string): CollaborationMessage {
  // Prototype mode: the human's feedback must not reach the session while an artifact is being assessed.
  const tracker = collaboration.prototype;
  if (tracker?.hasLiveUnderAssessment()) {
    throw new Error(NUDGE_HELD_ERROR);
  }

  // Add orchestrator message to the thread
  const orchestratorMessage: CollaborationMessage = {
    agent: ORCHESTRATOR,
    content: message,
    timestamp: new Date(),
  };
  // Public prototype sessions: a pasted board URL never reaches the public mirror.
  const turnKey = collaboration.messages.length;
  recordCollaborationMessage(
    collaboration,
    orchestratorMessage,
    tracker && collaboration.publicChannel ? tracker.publicView(message, turnKey) : undefined
  );

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
): Promise<{
  transcript: CollaborationMessage[];
  summary?: string;
  publicBlock?: string;
  publicResult?: FinalizeResult;
  /** Prototype sessions only: "## Prototype outcomes" and "## Shortlist for the human" (full shortlisted source). */
  prototypeOutcomes?: string;
}> {
  return withSessionLock(collaborationId, collaborationBusy(collaborationId), () => closeCollaboration(collaborationId, requestSummary));
}

async function closeCollaboration(collaborationId: string, requestSummary: boolean): ReturnType<typeof endCollaboration> {
  const collaboration = collaborations.get(collaborationId);
  if (!collaboration) {
    throw new Error(`Collaboration not found: ${collaborationId}`);
  }

  // Prototype mode: destroy whatever is still live first; every message from here on is the stubbed view.
  const tracker = collaboration.prototype;
  if (tracker) await closePrototypeTracker(tracker, "ended");
  const messages = tracker ? stubbedTranscript(collaboration) : collaboration.messages;

  let summary: string | undefined;

  if (requestSummary && messages.length > 0) {
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

    for (const msg of messages) {
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
    outcome: summary || messages.slice().reverse().find((m) => m.agent !== ORCHESTRATOR)?.content,
    public: collaboration.publicChannel !== undefined,
  });
  const transcript = [...messages];
  collaborations.delete(collaborationId);
  const outcomes = tracker ? { prototypeOutcomes: tracker.outcomesMarkdown() } : undefined;

  if (collaboration.publicChannel) {
    const publicResult = await collaboration.publicChannel.finalize({ summary: publicSummary(tracker, summary) });
    return {
      transcript,
      summary,
      publicResult,
      publicBlock: formatPublicBlock(collaboration.publicChannel, publicResult),
      ...outcomes,
    };
  }
  return { transcript, summary, ...outcomes };
}

/** The transcript as agents see it: resolved prototypes are stubs (shortlisted source is in the outcomes). */
function stubbedTranscript(collaboration: Collaboration): CollaborationMessage[] {
  return collaboration.messages.map((m, i) => ({ ...m, content: historyContent(collaboration, m, i) }));
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
  prototype: boolean;
  /** Prototype sessions, while the board is up. */
  board_url?: string;
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
    prototype: c.prototype !== undefined,
    ...(c.prototype && !c.prototype.closed && { board_url: c.prototype.boardUrl }),
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
  return collaborationHistoryView(collaboration);
}

/**
 * A copy of the messages as agents see them: in prototype sessions resolved prototypes are stubs, so
 * destroyed source never re-enters a prompt (transcripts, from_session).
 */
export function collaborationHistoryView(collaboration: Collaboration): CollaborationMessage[] {
  return collaboration.prototype ? stubbedTranscript(collaboration) : [...collaboration.messages];
}
