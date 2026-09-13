// ============================================================================
// Local Meeting Functions (CLI-based, uses local Claude installation)
// ============================================================================

import { spawn } from "node:child_process";
import type { Message } from "./meetings.js";
import { loadAgentPromptWithPath } from "../agents.js";

export interface LocalMeeting {
  id: string;
  agent: string;
  agentPromptPath: string;  // Path to the agent prompt file for --system-prompt-file
  systemPrompt: string;     // Cached content for building context
  messages: Message[];
  startedAt: Date;
}

export const localMeetings = new Map<string, LocalMeeting>();
let localMeetingCounter = 0;

/**
 * Execute the local `claude` CLI with a system prompt file and user prompt.
 * Uses -p flag for print mode (non-interactive single prompt/response).
 */
export async function executeClaudeCLI(
  systemPromptPath: string,
  prompt: string,
  timeoutMs: number = 300000  // 5 minute default timeout for long responses
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--system-prompt-file", systemPromptPath,
      "-p", prompt,
    ];

    console.error(`[LocalMeeting] Executing: claude ${args.slice(0, 2).join(" ")} -p "<prompt>"`);
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
 */
export function buildLocalMeetingContext(meeting: LocalMeeting, newMessage?: string): string {
  let context = "";

  // Add conversation history
  if (meeting.messages.length > 0) {
    context += "## Previous Conversation\n\n";
    for (const msg of meeting.messages) {
      const role = msg.role === "user" ? "User" : "Assistant";
      context += `**${role}:** ${msg.content}\n\n`;
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
  context?: string
): Promise<{ meetingId: string; response: string }> {
  const agentInfo = await loadAgentPromptWithPath(agent);
  const meetingId = `local-${++localMeetingCounter}`;

  let userMessage = agenda;
  if (context) {
    userMessage = `${agenda}\n\n---\n\n${context}`;
  }

  // For initial message, just pass the agenda directly
  const assistantMessage = await executeClaudeCLI(agentInfo.path, userMessage);

  const meeting: LocalMeeting = {
    id: meetingId,
    agent,
    agentPromptPath: agentInfo.path,
    systemPrompt: agentInfo.content,
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ],
    startedAt: new Date(),
  };
  localMeetings.set(meetingId, meeting);

  return { meetingId, response: assistantMessage };
}

export async function continueLocalMeeting(
  meetingId: string,
  message: string
): Promise<string> {
  const meeting = localMeetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Local meeting not found: ${meetingId}`);
  }

  // Build full context including history
  meeting.messages.push({ role: "user", content: message });
  const fullPrompt = buildLocalMeetingContext(meeting);

  const assistantMessage = await executeClaudeCLI(meeting.agentPromptPath, fullPrompt);

  meeting.messages.push({ role: "assistant", content: assistantMessage });

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

  let summary = "";
  if (requestSummary && meeting.messages.length > 0) {
    const summaryPrompt = buildLocalMeetingContext(meeting) +
      "\n\n---\n\n## Request\n\nPlease provide a brief summary of what we discussed and any action items or conclusions.";
    summary = await executeClaudeCLI(meeting.agentPromptPath, summaryPrompt);
  }

  localMeetings.delete(meetingId);

  return summary || `Local meeting ${meetingId} with ${meeting.agent} ended.`;
}

export function listLocalMeetings(): Array<{
  id: string;
  agent: string;
  messageCount: number;
  startedAt: string;
  type: "local";
}> {
  return Array.from(localMeetings.values()).map((m) => ({
    id: m.id,
    agent: m.agent,
    messageCount: m.messages.length,
    startedAt: m.startedAt.toISOString(),
    type: "local" as const,
  }));
}
