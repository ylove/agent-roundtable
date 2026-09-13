// ============================================================================
// Meeting Functions (API-based, one agent per meeting)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS } from "../config.js";
import { loadAgentPrompt } from "../agents.js";
import { callLLM } from "../providers/index.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Meeting {
  id: string;
  agent: string;
  systemPrompt: string;
  messages: Message[];
  startedAt: Date;
  provider: LLMProvider;
  model: string;
  /** Only with provider "openai_compatible": base URL pinned for the life of the meeting. */
  baseUrl?: string;
}

export const meetings = new Map<string, Meeting>();
let meetingCounter = 0;

export async function startMeeting(
  agent: string,
  agenda: string,
  context?: string,
  provider: LLMProvider = "anthropic",
  model?: string,
  baseUrl?: string
): Promise<{ meetingId: string; response: string }> {
  const systemPrompt = await loadAgentPrompt(agent);
  const meetingId = `meeting-${++meetingCounter}`;
  const resolvedModel = model || DEFAULT_MODELS[provider];

  let userMessage = agenda;
  if (context) {
    userMessage = `${agenda}\n\n---\n\n${context}`;
  }

  const assistantMessage = await callLLM(
    systemPrompt,
    [{ role: "user", content: userMessage }],
    { provider, model: resolvedModel, baseUrl }
  );

  const meeting: Meeting = {
    id: meetingId,
    agent,
    systemPrompt,
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ],
    startedAt: new Date(),
    provider,
    model: resolvedModel,
    ...(baseUrl !== undefined && { baseUrl }),
  };
  meetings.set(meetingId, meeting);

  return { meetingId, response: assistantMessage };
}

export async function continueMeeting(
  meetingId: string,
  message: string
): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  meeting.messages.push({ role: "user", content: message });

  const assistantMessage = await callLLM(
    meeting.systemPrompt,
    meeting.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { provider: meeting.provider, model: meeting.model, baseUrl: meeting.baseUrl }
  );

  meeting.messages.push({ role: "assistant", content: assistantMessage });

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

  meetings.delete(meetingId);

  return summary || `Meeting ${meetingId} with ${meeting.agent} ended.`;
}

export function listMeetings(): Array<{
  id: string;
  agent: string;
  messageCount: number;
  startedAt: string;
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
}> {
  return Array.from(meetings.values()).map((m) => ({
    id: m.id,
    agent: m.agent,
    messageCount: m.messages.length,
    startedAt: m.startedAt.toISOString(),
    provider: m.provider,
    model: m.model,
    ...(m.baseUrl !== undefined && { baseUrl: m.baseUrl }),
  }));
}
