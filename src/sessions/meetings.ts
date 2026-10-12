// ============================================================================
// Meeting Functions (API-based, one agent per meeting)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS } from "../config.js";
import { agentKey, loadAgentPrompt } from "../agents.js";
import { recordActivity } from "../activity.js";
import { callLLM } from "../providers/index.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";
import type { MeetingMode } from "./modes.js";
import { assertMeetingMode, buildChallengerDirective, DEBATE_MEETING_USER_SUFFIX } from "./modes.js";
import { CALLER } from "../prototypes/index.js";
import {
  closePrototypeTracker,
  openPrototypeTracker,
  postPrototypeAttachments,
  prototypeSystemSuffix,
  type PrototypeTracker,
} from "./prototype-mode.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Meeting {
  id: string;
  agent: string;
  /** Agenda without private context or session directives. */
  agenda?: string;
  systemPrompt: string;
  messages: Message[];
  startedAt: Date;
  provider: LLMProvider;
  model: string;
  /** Only with provider "openai_compatible": base URL pinned for the life of the meeting. */
  baseUrl?: string;
  mode: MeetingMode;
  debateFocus?: string;
  /** Set when the meeting was started with public: true. */
  publicChannel?: PublicChannel;
  /** Set when the meeting was started with prototype: true (the caller assesses the agent's prototypes). */
  prototype?: PrototypeTracker;
}

export const meetings = new Map<string, Meeting>();
let meetingCounter = 0;

export type MeetingRecordHook = (meeting: Meeting, message: Message) => void;

let recordHook: MeetingRecordHook | undefined;

/** Install (or clear, with undefined) the hook called after every recorded message. No-op by default. */
export function setMeetingRecordHook(hook: MeetingRecordHook | undefined): void {
  recordHook = hook;
}

/** Single choke point for everything pushed into meeting.messages. Hook failures never break a session. */
export function recordMeetingMessage(meeting: Meeting, message: Message, publicText?: string): Message {
  meeting.messages.push(message);
  // Public mirror: publicText overrides what is posted (the opening user message is published as the agenda only).
  meeting.publicChannel?.record({
    turn: meeting.messages.length,
    speaker: message.role === "user" ? "caller" : publicLabel(meeting.agent),
    content: publicText ?? message.content,
    kind: message.role === "user" ? "caller" : "turn",
  });
  if (recordHook) {
    try {
      const r: unknown = recordHook(meeting, message);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((e) =>
          console.error(`[Meeting] record hook failed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    } catch (e) {
      console.error(`[Meeting] record hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return message;
}

export async function startMeeting(
  agent: string,
  agenda: string,
  context?: string,
  provider: LLMProvider = "anthropic",
  model?: string,
  baseUrl?: string,
  mode: MeetingMode = "standard",
  debateFocus?: string,
  isPublic: boolean = false,
  isPrototype: boolean = false
): Promise<{
  meetingId: string;
  response: string;
  public?: { url: string | null; topic: string };
  /** Prototype meetings only. */
  prototypes?: ReturnType<PrototypeTracker["takeCallSummary"]>;
}> {
  assertMeetingMode(mode);
  let systemPrompt = await loadAgentPrompt(agent);
  if (mode === "debate") {
    systemPrompt += buildChallengerDirective(debateFocus);
  }
  if (isPublic) systemPrompt += publicDirectiveSuffix();
  if (isPrototype) systemPrompt += prototypeSystemSuffix({ assessorIsCaller: true, public: isPublic });
  const meetingId = `meeting-${++meetingCounter}`;
  // Prototype board before the public channel: a prototype config error must not leave a public header behind.
  const prototype = isPrototype
    ? await openPrototypeTracker({
        sessionId: meetingId,
        mode,
        participants: [isPublic ? publicLabel(agent) : agent],
        assessorIsCaller: true,
        public: isPublic,
        topic: agenda,
      })
    : undefined;
  // Created before the first LLM call so the header is the first post. Config errors fail the start.
  let publicChannel: PublicChannel | undefined;
  try {
    publicChannel = isPublic
      ? openPublicChannel(meetingId, { mode, participants: [publicLabel(agent)], topic: agenda })
      : undefined;
  } catch (e) {
    await closePrototypeTracker(prototype, "ended");
    throw e;
  }
  const resolvedModel = model || DEFAULT_MODELS[provider];

  let userMessage = agenda;
  if (context) {
    userMessage = `${agenda}\n\n---\n\n${context}`;
  }
  if (mode === "debate") {
    userMessage += "\n\n" + DEBATE_MEETING_USER_SUFFIX;
  }

  let assistantMessage: string;
  try {
    assistantMessage = await callLLM(
      systemPrompt,
      [{ role: "user", content: userMessage }],
      { provider, model: resolvedModel, baseUrl }
    );
  } catch (e) {
    // The meeting never started; close the channel (and the prototype board) so nothing dangles.
    if (publicChannel) void publicChannel.finalize();
    await closePrototypeTracker(prototype, "ended");
    throw e;
  }

  const meeting: Meeting = {
    id: meetingId,
    agent,
    agenda,
    systemPrompt,
    messages: [],
    startedAt: new Date(),
    provider,
    model: resolvedModel,
    ...(baseUrl !== undefined && { baseUrl }),
    mode,
    ...(debateFocus !== undefined && { debateFocus }),
    ...(publicChannel && { publicChannel }),
    ...(prototype && { prototype }),
  };
  meetings.set(meetingId, meeting);
  if (prototype) await prototype.onTurn(CALLER, agenda, 0);
  // Publish the agenda only: userMessage also carries the private context and the debate suffix.
  recordMeetingMessage(meeting, { role: "user", content: userMessage }, agenda);
  await recordAgentReply(meeting, assistantMessage);

  return {
    meetingId,
    response: assistantMessage,
    ...(publicChannel && { public: { url: publicChannel.url, topic: publicChannel.topic } }),
    ...(prototype && { prototypes: prototype.takeCallSummary() }),
  };
}

/**
 * Record the agent's reply. Prototype meetings run the tracker first (it may materialize a prototype),
 * post the URL-free public form, then any screenshots under the same public turn number.
 */
async function recordAgentReply(meeting: Meeting, content: string): Promise<void> {
  const tracker = meeting.prototype;
  if (!tracker) {
    recordMeetingMessage(meeting, { role: "assistant", content });
    return;
  }
  const turnKey = meeting.messages.length;
  const result = await tracker.onTurn(0, content, turnKey);
  const publicText = meeting.publicChannel ? tracker.publicView(content, turnKey) : undefined;
  recordMeetingMessage(meeting, { role: "assistant", content }, publicText);
  postPrototypeAttachments(meeting.publicChannel, meeting.messages.length, meeting.agent, result.attachments);
}

/**
 * Record a caller message. Prototype meetings parse it first (the caller's verdicts can destroy assessed
 * prototypes), then give the agent its prototype status after the message; only the caller's own words
 * (board URLs scrubbed) are published.
 */
async function recordCallerMessage(meeting: Meeting, message: string): Promise<void> {
  const tracker = meeting.prototype;
  if (!tracker) {
    recordMeetingMessage(meeting, { role: "user", content: message });
    return;
  }
  const turnKey = meeting.messages.length;
  await tracker.onTurn(CALLER, message, turnKey);
  const publicText = meeting.publicChannel ? tracker.publicView(message, turnKey) : undefined;
  recordMeetingMessage(meeting, { role: "user", content: message + tracker.statusPromptFor(0) }, publicText);
}

/** What the LLM sees: resolved prototypes in earlier turns are stubs. */
function llmHistory(meeting: Meeting): Message[] {
  const tracker = meeting.prototype;
  return meeting.messages.map((m, i) => ({
    role: m.role,
    content: tracker ? tracker.historyView(m.content, i) : m.content,
  }));
}

export async function continueMeeting(
  meetingId: string,
  message: string
): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  await recordCallerMessage(meeting, message);

  const assistantMessage = await callLLM(
    meeting.systemPrompt,
    llmHistory(meeting),
    { provider: meeting.provider, model: meeting.model, baseUrl: meeting.baseUrl }
  );

  await recordAgentReply(meeting, assistantMessage);

  return assistantMessage;
}

export async function endMeeting(
  meetingId: string,
  requestSummary: boolean = false
): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Prototype mode: destroy whatever is still live first; the summary and activity see the stubbed history.
  const tracker = meeting.prototype;
  if (tracker) await closePrototypeTracker(tracker, "ended");
  const history = llmHistory(meeting);

  let summary = "";
  if (requestSummary) {
    const summaryMessages = [
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      {
        role: "user" as const,
        content:
          "Please provide a brief summary of what we discussed and any action items or conclusions.",
      },
    ];
    summary = await callLLM(
      meeting.systemPrompt,
      summaryMessages,
      { provider: meeting.provider, model: meeting.model, baseUrl: meeting.baseUrl }
    );
  }

  recordActivity({
    session: meetingId,
    kind: "meeting",
    mode: meeting.mode,
    agents: [agentKey(meeting.agent)],
    topic: meeting.agenda ?? "",
    outcome: summary || history.slice().reverse().find((m) => m.role === "assistant")?.content,
    public: meeting.publicChannel !== undefined,
  });
  meetings.delete(meetingId);

  let text = summary || `Meeting ${meetingId} with ${meeting.agent} ended.`;
  if (tracker) text += `\n\n${tracker.outcomesMarkdown()}`;
  if (meeting.publicChannel) {
    const r = await meeting.publicChannel.finalize({ summary: summary || undefined });
    return `${text}\n\n${formatPublicBlock(meeting.publicChannel, r)}`;
  }
  return text;
}

export function listMeetings(): Array<{
  id: string;
  agent: string;
  messageCount: number;
  startedAt: string;
  provider: LLMProvider;
  model: string;
  mode: MeetingMode;
  public: boolean;
  prototype: boolean;
  /** Prototype meetings, while the board is up. */
  board_url?: string;
  baseUrl?: string;
}> {
  return Array.from(meetings.values()).map((m) => ({
    id: m.id,
    agent: m.agent,
    messageCount: m.messages.length,
    startedAt: m.startedAt.toISOString(),
    provider: m.provider,
    model: m.model,
    mode: m.mode,
    public: m.publicChannel !== undefined,
    prototype: m.prototype !== undefined,
    ...(m.prototype && !m.prototype.closed && { board_url: m.prototype.boardUrl }),
    ...(m.baseUrl !== undefined && { baseUrl: m.baseUrl }),
  }));
}
