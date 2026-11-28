import { validateSessionCap, setSessionCap, stopCappedSession, clearSessionCap, sessionCapView } from "../usage/session-caps.js";
import { prepareSeats } from "../table/seats.js";
import { callSeat } from "../table/dispatch.js";
import type { Seat } from "../table/events.js";
// ============================================================================
// Meeting Functions (API-based, one agent per meeting)
// ============================================================================

import type { LLMProvider } from "../config.js";
import { DEFAULT_MODELS, MAX_TOKENS } from "../config.js";
import { agentKey, loadAgentPrompt } from "../agents.js";
import { recordActivity } from "../activity.js";
import { newId } from "../ids.js";
import { lockSession, sessionBusyMessage, withSessionLock } from "./lock.js";
import { archiveMeeting } from "./archive.js";
import { withoutDissentBlocks } from "./dissent-summary.js";
import { callLLM } from "../providers/index.js";
import { checkSeatConnectorArgs, startSeatConnectors, withSeatConnectors, type SeatConnectorMap, type SeatConnectorSession } from "../table/seat-connectors.js";
import { metered, stoppedOutcome, type StoppedInfo } from "../usage/session-scope.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";
import type { MeetingMode } from "./modes.js";
import { assertMeetingMode, buildChallengerDirective, buildDissentSummaryPrompt, DEBATE_MEETING_USER_SUFFIX } from "./modes.js";
import {
  closePrototypeTracker,
  meetingPrototypeStatus,
  openSessionSurfaces,
  prototypeSystemSuffix,
  publicSummary,
  recordMeetingAgentReply,
  recordMeetingCallerMessage,
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
  /** Output ceiling pinned by automatic provider judgment for every call in this meeting. */
  maxOutputTokens?: number;
  /** Only with provider "openai_compatible": base URL pinned for the life of the meeting. */
  baseUrl?: string;
  mode: MeetingMode;
  debateFocus?: string;
  /** Set when the meeting was started with public: true. */
  publicChannel?: PublicChannel;
  /** Set when the meeting was started with prototype: true (the caller assesses the agent's prototypes). */
  prototype?: PrototypeTracker;
  /** Set when a person stopped the meeting (usage visibility): it then ends without a summary. */
  stopped?: StoppedInfo;
  /** MCP connectors the agent may call as tools; started once for the meeting and closed when it ends. */
  connectors?: SeatConnectorSession;
  /** One line per connector call or notice. */
  toolNotes?: string[];
}

/** One agent turn: through the seat dispatcher (tool loop) when the meeting has connectors, plain otherwise. */
function callMeetingAgent(meeting: Pick<Meeting, "agent" | "connectors" | "provider" | "model" | "baseUrl" | "maxOutputTokens">, system: string, messages: Message[]): Promise<string> {
  const options = meetingCallOptions(meeting);
  if (!meeting.connectors) return callLLM(system, messages, options);
  return withSeatConnectors(meeting.connectors, () => callSeat(system, messages, options, { agent: meeting.agent }));
}

function meetingCallOptions(meeting: Pick<Meeting, "provider" | "model" | "baseUrl" | "maxOutputTokens">) {
  return { provider: meeting.provider, model: meeting.model, baseUrl: meeting.baseUrl,
    ...(meeting.maxOutputTokens !== undefined && { maxTokens: Math.min(MAX_TOKENS, meeting.maxOutputTokens) }) };
}

export const meetings = new Map<string, Meeting>();

function meetingBusy(id: string): string {
  return sessionBusyMessage("Meeting", id);
}

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
  provider?: LLMProvider | "auto",
  model?: string,
  baseUrl?: string,
  mode: MeetingMode = "standard",
  debateFocus?: string,
  isPublic: boolean = false,
  isPrototype: boolean = false,
  pageCheck: boolean = true,
  connectorOptions: { maxUsd?: number; connectors?: string[]; seatConnectors?: SeatConnectorMap; signal?: AbortSignal } = {}
): Promise<{
  meetingId: string;
  response: string;
  routing?: Seat[];
  public?: { url: string | null; topic: string };
  /** Prototype meetings only. */
  prototypes?: ReturnType<PrototypeTracker["takeCallSummary"]>;
}> {
  validateSessionCap(connectorOptions.maxUsd);
  const meetingId = newId("meeting");
  try {
    setSessionCap(meetingId, connectorOptions.maxUsd);
    if ((provider === undefined || provider === "auto") && baseUrl !== undefined) throw new Error("base_url requires explicit provider openai_compatible.");
    assertMeetingMode(mode);
    // An unknown connector fails here, before a session exists or any provider is called.
    const checked = checkSeatConnectorArgs(connectorOptions.connectors, connectorOptions.seatConnectors, [agent]);
    const routed = provider === undefined || provider === "auto";
    const seats = routed ? await prepareSeats({ agents: [agent], model }) : undefined;
    const chosen = seats?.get(agent);
    provider = chosen?.provider as LLMProvider | undefined ?? provider as LLMProvider;
    model = chosen?.model ?? model;
    let systemPrompt = await loadAgentPrompt(agent);
    if (mode === "debate") {
      systemPrompt += buildChallengerDirective(debateFocus);
    }
    if (isPublic) systemPrompt += publicDirectiveSuffix();
    if (isPrototype) systemPrompt += prototypeSystemSuffix({ assessorIsCaller: true, public: isPublic });
    // Board, then public channel, both before the first LLM call so the header is the first post. Config
    // errors fail the start (a public config error closes the blackboard first).
    const { prototype, publicChannel } = await openSessionSurfaces(
      isPrototype
        ? {
            sessionId: meetingId,
            mode,
            participants: [isPublic ? publicLabel(agent) : agent],
            assessorIsCaller: true,
            public: isPublic,
            pageCheck,
            topic: agenda,
          }
        : undefined,
      () => (isPublic ? openPublicChannel(meetingId, { mode, participants: [publicLabel(agent)], topic: agenda }) : undefined)
    );
    let resolvedModel = model || DEFAULT_MODELS[provider];

    let userMessage = agenda;
    if (context) {
      userMessage = `${agenda}\n\n---\n\n${context}`;
    }
    if (mode === "debate") {
      userMessage += "\n\n" + DEBATE_MEETING_USER_SUFFIX;
    }

    let assistantMessage: string;
    let connectors: SeatConnectorSession | undefined;
    const toolNotes: string[] = [];
    try {
      connectors = checked.names.length ? await startSeatConnectors(checked.names, { signal: connectorOptions.signal, seatConnectors: checked.seatConnectors, onNote: use => toolNotes.push(use.note) }) : undefined;
      assistantMessage = await metered({ session: meetingId, kind: "meeting", agent }, () => {
        const messages = [{ role: "user" as const, content: userMessage }];
        const options = meetingCallOptions({ provider: provider as LLMProvider, model: resolvedModel, baseUrl, maxOutputTokens: chosen?.maxOutputTokens });
        if (connectors) return withSeatConnectors(connectors, () => callSeat(systemPrompt, messages, options, { agent, onModelFallback: replacement => { resolvedModel = replacement; if (chosen) chosen.model = replacement; } }));
        return routed ? callSeat(systemPrompt, messages, options, { agent, onModelFallback: replacement => { resolvedModel = replacement; if (chosen) chosen.model = replacement; } })
          : callLLM(systemPrompt, messages, options);
      });
    } catch (e) {
      // The meeting never started; close the channel (and the prototype blackboard) so nothing dangles.
      await connectors?.close();
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
      ...(chosen?.maxOutputTokens !== undefined && { maxOutputTokens: chosen.maxOutputTokens }),
      ...(baseUrl !== undefined && { baseUrl }),
      mode,
      ...(debateFocus !== undefined && { debateFocus }),
      ...(publicChannel && { publicChannel }),
      ...(prototype && { prototype }),
      ...(connectors && { connectors, toolNotes }),
    };
    meetings.set(meetingId, meeting);
    // Listed from here on: hold the lock until the opening exchange is recorded.
    const release = lockSession(meetingId, meetingBusy(meetingId));
    try {
      const record = recorderFor(meeting);
      // Publish the agenda only: userMessage also carries the private context and the debate suffix.
      await recordMeetingCallerMessage(meeting, userMessage, record, { agenda });
      await recordMeetingAgentReply(meeting, assistantMessage, record);
    } finally {
      release();
    }

    await stopCappedSession(meetingId);
    return {
      meetingId,
      response: assistantMessage,
      ...(seats && { routing: [...seats.values()] }),
      ...(publicChannel && { public: { url: publicChannel.url, topic: publicChannel.topic } }),
      ...(prototype && { prototypes: prototype.takeCallSummary() }),
    };
  } finally {
    if (!meetings.has(meetingId) && !sessionCapView(meetingId)?.reached) clearSessionCap(meetingId);
  }
}

/** The meeting's own choke point, as the shared prototype recorders take it. */
function recorderFor(meeting: Meeting): (message: Message, publicText?: string) => void {
  return (message, publicText) => recordMeetingMessage(meeting, message, publicText);
}

/**
 * The meeting history as agents see it: resolved prototypes in earlier turns are stubs. Used for every
 * LLM call, the end summary and from_session, so destroyed prototype source never re-enters a prompt.
 */
export function meetingHistoryView(meeting: Meeting): Message[] {
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
  return withSessionLock(meetingId, meetingBusy(meetingId), () => runMeetingTurn(meetingId, message));
}

async function runMeetingTurn(meetingId: string, message: string): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  const record = recorderFor(meeting);
  await recordMeetingCallerMessage(meeting, message, record);

  // Prototype meetings: the agent's prototype status rides on this request's last (caller) message only.
  const request = meetingHistoryView(meeting);
  const status = meetingPrototypeStatus(meeting);
  if (status && request.length > 0) request[request.length - 1].content += status;

  const assistantMessage = await metered({ session: meeting.id, kind: "meeting", agent: meeting.agent }, () => callMeetingAgent(meeting, meeting.systemPrompt, request));

  await recordMeetingAgentReply(meeting, assistantMessage, record);

  return assistantMessage;
}

export async function endMeeting(
  meetingId: string,
  requestSummary: boolean = false
): Promise<string> {
  return withSessionLock(meetingId, meetingBusy(meetingId), () => closeMeeting(meetingId, requestSummary));
}

async function closeMeeting(meetingId: string, requestSummary: boolean): Promise<string> {
  const meeting = meetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // Prototype mode: destroy whatever is still live first; the summary and activity see the stubbed history.
  const tracker = meeting.prototype;
  if (tracker) await closePrototypeTracker(tracker, "ended");
  const history = meetingHistoryView(meeting);

  let summary = "";
  const dissentSummaries: Array<{ agent: string; content: string }> = [];
  if (requestSummary) {
    const summaryMessages = [
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      {
        role: "user" as const,
        content:
          "Please provide a brief summary of what we discussed and any action items or conclusions. Do not include DISSENT tags or extraction blocks.",
      },
    ];
    summary = withoutDissentBlocks(await metered({ session: meeting.id, kind: "meeting", agent: meeting.agent }, () => callMeetingAgent(meeting, meeting.systemPrompt, summaryMessages)));
    if (meeting.mode === "debate") {
      const messages = [...summaryMessages.slice(0, -1), { role: "user" as const, content: buildDissentSummaryPrompt("challenger", meeting.agenda ?? "") }];
      const content = await metered({ session: meeting.id, kind: "meeting", agent: meeting.agent }, () => callMeetingAgent(meeting, meeting.systemPrompt, messages));
      dissentSummaries.push({ agent: meeting.agent, content });
    }
  }

  recordActivity({
    session: meetingId,
    kind: "meeting",
    mode: meeting.mode,
    agents: [agentKey(meeting.agent)],
    topic: meeting.agenda ?? "",
    outcome: meeting.stopped ? stoppedOutcome(meeting.stopped) : summary || history.slice().reverse().find((m) => m.role === "assistant")?.content,
    public: meeting.publicChannel !== undefined,
  });
  archiveMeeting("meeting", meeting, summary, dissentSummaries);
  meetings.delete(meetingId);
  await meeting.connectors?.close();

  let text = summary || `Meeting ${meetingId} with ${meeting.agent} ended.`;
  if (meeting.toolNotes?.length) text += `\n\nConnector use:\n${meeting.toolNotes.map(n => `- ${n}`).join("\n")}`;
  if (tracker) text += `\n\n${tracker.outcomesMarkdown()}`;
  if (meeting.publicChannel) {
    const r = await meeting.publicChannel.finalize({ summary: publicSummary(tracker, summary || undefined) });
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
  /** Prototype meetings, while the blackboard is up. */
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
