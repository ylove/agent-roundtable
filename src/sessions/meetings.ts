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
  isPublic: boolean = false
): Promise<{ meetingId: string; response: string; public?: { url: string | null; topic: string } }> {
  assertMeetingMode(mode);
  let systemPrompt = await loadAgentPrompt(agent);
  if (mode === "debate") {
    systemPrompt += buildChallengerDirective(debateFocus);
  }
  if (isPublic) systemPrompt += publicDirectiveSuffix();
  const meetingId = `meeting-${++meetingCounter}`;
  // Created before the first LLM call so the header is the first post. Config errors fail the start.
  const publicChannel = isPublic
    ? openPublicChannel(meetingId, { mode, participants: [publicLabel(agent)], topic: agenda })
    : undefined;
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
    // The meeting never started; close the channel so nothing dangles.
    if (publicChannel) void publicChannel.finalize();
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
  };
  meetings.set(meetingId, meeting);
  // Publish the agenda only: userMessage also carries the private context and the debate suffix.
  recordMeetingMessage(meeting, { role: "user", content: userMessage }, agenda);
  recordMeetingMessage(meeting, { role: "assistant", content: assistantMessage });

  return {
    meetingId,
    response: assistantMessage,
    ...(publicChannel && { public: { url: publicChannel.url, topic: publicChannel.topic } }),
  };
}

export async function continueMeeting(
  meetingId: string,
  message: string
): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  recordMeetingMessage(meeting, { role: "user", content: message });

  const assistantMessage = await callLLM(
    meeting.systemPrompt,
    meeting.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { provider: meeting.provider, model: meeting.model, baseUrl: meeting.baseUrl }
  );

  recordMeetingMessage(meeting, { role: "assistant", content: assistantMessage });

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

  let summary = "";
  if (requestSummary) {
    const summaryMessages = [
      ...meeting.messages.map((m) => ({
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
    outcome: summary || meeting.messages.slice().reverse().find((m) => m.role === "assistant")?.content,
    public: meeting.publicChannel !== undefined,
  });
  meetings.delete(meetingId);

  const text = summary || `Meeting ${meetingId} with ${meeting.agent} ended.`;
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
    ...(m.baseUrl !== undefined && { baseUrl: m.baseUrl }),
  }));
}
