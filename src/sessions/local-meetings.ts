// ============================================================================
// Local Meeting Functions (CLI-based, uses local Claude installation)
// ============================================================================

import { spawn } from "node:child_process";
import type { Message } from "./meetings.js";
import { agentKey, loadAgent, renderSkillsSection } from "../agents.js";
import { recordActivity } from "../activity.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";
import type { MeetingMode } from "./modes.js";
import { assertMeetingMode, buildChallengerDirective, DEBATE_MEETING_USER_SUFFIX } from "./modes.js";
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

export interface LocalMeeting {
  id: string;
  agent: string;
  /** Agenda without private context or session directives. */
  agenda?: string;
  agentPromptPath: string;  // Path to the agent prompt file for --system-prompt-file
  systemPrompt: string;     // Cached content for building context
  messages: Message[];
  startedAt: Date;
  mode: MeetingMode;
  debateFocus?: string;
  /** Debate mode: passed to the CLI via --append-system-prompt on every call (the CLI is stateless). */
  challengerDirective?: string;
  /** Everything passed via --append-system-prompt on every call: skills and session directives. */
  appendSystemPrompt?: string;
  /** Set when the meeting was started with public: true. */
  publicChannel?: PublicChannel;
  /** Set when the meeting was started with prototype: true (the caller assesses the agent's prototypes). */
  prototype?: PrototypeTracker;
}

export const localMeetings = new Map<string, LocalMeeting>();
let localMeetingCounter = 0;

export type LocalMeetingRecordHook = (meeting: LocalMeeting, message: Message) => void;

let recordHook: LocalMeetingRecordHook | undefined;

/** Install (or clear, with undefined) the hook called after every recorded message. No-op by default. */
export function setLocalMeetingRecordHook(hook: LocalMeetingRecordHook | undefined): void {
  recordHook = hook;
}

/** Single choke point for everything pushed into local meeting messages. Hook failures never break a session. */
export function recordLocalMeetingMessage(meeting: LocalMeeting, message: Message, publicText?: string): Message {
  meeting.messages.push(message);
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
          console.error(`[LocalMeeting] record hook failed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    } catch (e) {
      console.error(`[LocalMeeting] record hook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return message;
}

/** Build the argv for the `claude` CLI. Exported so the flag layout can be unit tested without spawning. */
export function buildClaudeCliArgs(
  systemPromptPath: string,
  prompt: string,
  appendSystemPrompt?: string
): string[] {
  const args = ["--system-prompt-file", systemPromptPath];
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  args.push("-p", prompt);
  return args;
}

/**
 * Execute the local `claude` CLI with a system prompt file and user prompt.
 * Uses -p flag for print mode (non-interactive single prompt/response).
 */
export async function executeClaudeCLI(
  systemPromptPath: string,
  prompt: string,
  timeoutMs: number = 300000,  // 5 minute default timeout for long responses
  appendSystemPrompt?: string  // Debate mode: challenger directive (the CLI is stateless, so pass it on every call)
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeCliArgs(systemPromptPath, prompt, appendSystemPrompt);

    console.error(`[LocalMeeting] Executing: claude ${args.slice(0, 2).join(" ")}${appendSystemPrompt ? " --append-system-prompt <directive>" : ""} -p "<prompt>"`);
    console.error(`[LocalMeeting] Prompt length: ${prompt.length} chars`);

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.error(`[LocalMeeting] CLI completed successfully, output length: ${stdout.length} chars`);
        resolve(stdout.trim());
      } else {
        console.error(`[LocalMeeting] CLI failed with code ${code}: ${stderr}`);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || "No error output"}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.error(`[LocalMeeting] CLI spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is claude installed and in PATH?`));
    });
  });
}

/**
 * Build conversation context for multi-turn local meetings.
 * Since CLI doesn't maintain state, we include full conversation history in the prompt.
 * `lastMessageSuffix` is added to the last history entry in this prompt only (prototype meetings: the
 * agent's prototype status after the caller's latest message); it is never stored.
 */
export function buildLocalMeetingContext(meeting: LocalMeeting, newMessage?: string, lastMessageSuffix?: string): string {
  let context = "";

  // Add conversation history (prototype meetings: resolved prototypes appear as stubs)
  if (meeting.messages.length > 0) {
    context += "## Previous Conversation\n\n";
    const last = meeting.messages.length - 1;
    for (const [i, msg] of meeting.messages.entries()) {
      const role = msg.role === "user" ? "User" : "Assistant";
      const content = meeting.prototype ? meeting.prototype.historyView(msg.content, i) : msg.content;
      context += `**${role}:** ${content}${i === last && lastMessageSuffix ? lastMessageSuffix : ""}\n\n`;
    }
    context += "---\n\n";
  }

  // Add new message if provided
  if (newMessage) {
    context += `## Current Message\n\n${newMessage}`;
  }

  return context;
}

export async function startLocalMeeting(
  agent: string,
  agenda: string,
  context?: string,
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
  const agentInfo = await loadAgent(agent);
  const meetingId = `local-${++localMeetingCounter}`;
  const challengerDirective = mode === "debate" ? buildChallengerDirective(debateFocus) : undefined;
  const skillsSection = renderSkillsSection(agentInfo.skills);
  const appendSystemPrompt = [
    skillsSection.trim(),
    challengerDirective?.trim(),
    isPublic ? publicDirectiveSuffix().trim() : undefined,
    isPrototype ? prototypeSystemSuffix({ assessorIsCaller: true, public: isPublic }).trim() : undefined,
  ].filter(Boolean).join("\n\n") || undefined;
  // Board, then public channel, both before the first CLI call so the header is the first post. Config
  // errors fail the start (a public config error closes the board first).
  const { prototype, publicChannel } = await openSessionSurfaces(
    isPrototype
      ? {
          sessionId: meetingId,
          mode,
          participants: [isPublic ? publicLabel(agent) : agent],
          assessorIsCaller: true,
          public: isPublic,
          topic: agenda,
        }
      : undefined,
    () => (isPublic ? openPublicChannel(meetingId, { mode, participants: [publicLabel(agent)], topic: agenda }) : undefined)
  );

  let userMessage = agenda;
  if (context) {
    userMessage = `${agenda}\n\n---\n\n${context}`;
  }
  if (mode === "debate") {
    userMessage += "\n\n" + DEBATE_MEETING_USER_SUFFIX;
  }

  // For initial message, just pass the agenda directly
  let assistantMessage: string;
  try {
    assistantMessage = await executeClaudeCLI(agentInfo.path, userMessage, undefined, appendSystemPrompt);
  } catch (e) {
    if (publicChannel) void publicChannel.finalize();
    await closePrototypeTracker(prototype, "ended");
    throw e;
  }

  const meeting: LocalMeeting = {
    id: meetingId,
    agent,
    agenda,
    agentPromptPath: agentInfo.path,
    systemPrompt: agentInfo.body + skillsSection,
    messages: [],
    startedAt: new Date(),
    mode,
    ...(debateFocus !== undefined && { debateFocus }),
    ...(challengerDirective !== undefined && { challengerDirective }),
    ...(appendSystemPrompt !== undefined && { appendSystemPrompt }),
    ...(publicChannel && { publicChannel }),
    ...(prototype && { prototype }),
  };
  localMeetings.set(meetingId, meeting);
  const record = recorderFor(meeting);
  // Publish the agenda only: userMessage also carries the private context and the debate suffix.
  await recordMeetingCallerMessage(meeting, userMessage, record, { agenda });
  await recordMeetingAgentReply(meeting, assistantMessage, record);

  return {
    meetingId,
    response: assistantMessage,
    ...(publicChannel && { public: { url: publicChannel.url, topic: publicChannel.topic } }),
    ...(prototype && { prototypes: prototype.takeCallSummary() }),
  };
}

/** The local meeting's own choke point, as the shared prototype recorders take it. */
function recorderFor(meeting: LocalMeeting): (message: Message, publicText?: string) => void {
  return (message, publicText) => recordLocalMeetingMessage(meeting, message, publicText);
}

export async function continueLocalMeeting(
  meetingId: string,
  message: string
): Promise<string> {
  const meeting = localMeetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Local meeting not found: ${meetingId}`);
  }

  // Build full context including history (prototype meetings: the agent's prototype status rides on the
  // caller's latest message in this prompt only, never in the stored history)
  const record = recorderFor(meeting);
  await recordMeetingCallerMessage(meeting, message, record);
  const fullPrompt = buildLocalMeetingContext(meeting, undefined, meetingPrototypeStatus(meeting));

  const assistantMessage = await executeClaudeCLI(meeting.agentPromptPath, fullPrompt, undefined, meeting.appendSystemPrompt);

  await recordMeetingAgentReply(meeting, assistantMessage, record);

  return assistantMessage;
}

export async function endLocalMeeting(
  meetingId: string,
  requestSummary: boolean = false
): Promise<string> {
  const meeting = localMeetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Local meeting not found: ${meetingId}`);
  }

  // Prototype mode: destroy whatever is still live first; the summary and activity see the stubbed history.
  const tracker = meeting.prototype;
  if (tracker) await closePrototypeTracker(tracker, "ended");

  let summary = "";
  if (requestSummary && meeting.messages.length > 0) {
    const summaryPrompt = buildLocalMeetingContext(meeting) +
      "\n\n---\n\n## Request\n\nPlease provide a brief summary of what we discussed and any action items or conclusions.";
    summary = await executeClaudeCLI(meeting.agentPromptPath, summaryPrompt, undefined, meeting.appendSystemPrompt);
  }

  recordActivity({
    session: meetingId,
    kind: "local-meeting",
    mode: meeting.mode,
    agents: [agentKey(meeting.agent)],
    topic: meeting.agenda ?? "",
    outcome: summary || lastAgentReply(meeting),
    public: meeting.publicChannel !== undefined,
  });
  localMeetings.delete(meetingId);

  let text = summary || `Local meeting ${meetingId} with ${meeting.agent} ended.`;
  if (tracker) text += `\n\n${tracker.outcomesMarkdown()}`;
  if (meeting.publicChannel) {
    const r = await meeting.publicChannel.finalize({ summary: publicSummary(tracker, summary || undefined) });
    return `${text}\n\n${formatPublicBlock(meeting.publicChannel, r)}`;
  }
  return text;
}

/** The agent's last reply as agents see it (resolved prototypes stubbed). */
function lastAgentReply(meeting: LocalMeeting): string | undefined {
  for (let i = meeting.messages.length - 1; i >= 0; i--) {
    const m = meeting.messages[i];
    if (m.role === "assistant") return meeting.prototype ? meeting.prototype.historyView(m.content, i) : m.content;
  }
  return undefined;
}

export function listLocalMeetings(): Array<{
  id: string;
  agent: string;
  messageCount: number;
  startedAt: string;
  mode: MeetingMode;
  public: boolean;
  prototype: boolean;
  /** Prototype meetings, while the board is up. */
  board_url?: string;
  type: "local";
}> {
  return Array.from(localMeetings.values()).map((m) => ({
    id: m.id,
    agent: m.agent,
    messageCount: m.messages.length,
    startedAt: m.startedAt.toISOString(),
    mode: m.mode,
    public: m.publicChannel !== undefined,
    prototype: m.prototype !== undefined,
    ...(m.prototype && !m.prototype.closed && { board_url: m.prototype.boardUrl }),
    type: "local" as const,
  }));
}
