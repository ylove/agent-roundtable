// ============================================================================
// Local Meeting Functions (CLI-based, uses local Claude installation)
// ============================================================================

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import type { Message } from "./meetings.js";
import { agentKey, loadAgent, renderSkillsSection } from "../agents.js";
import { recordActivity } from "../activity.js";
import { ROUNDTABLE_HOME, WORKSPACE_DIR, localTimeoutMs } from "../config.js";
import { findExecutable } from "../executables.js";
import { hasFlag } from "../workers/claude-code.js";
import { newId } from "../ids.js";
import { childEnv } from "../security/child-env.js";
import { mkdirPrivate } from "../security/fs-safe.js";
import { scrubAndCap } from "../security/secrets.js";
import { StoppedError } from "../providers/usage.js";
import { recordCliCall, sessionSignal, stoppedOutcome, type SessionScope, type StoppedInfo } from "../usage/session-scope.js";
import { lockSession, sessionBusyMessage, withSessionLock } from "./lock.js";
import { archiveMeeting } from "./archive.js";
import { withoutDissentBlocks } from "./dissent-summary.js";
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
  /** Set when a person stopped the meeting (usage visibility): it then ends without a summary. */
  stopped?: StoppedInfo;
}

export const localMeetings = new Map<string, LocalMeeting>();

function localMeetingBusy(id: string): string {
  return sessionBusyMessage("Local meeting", id);
}

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

// ----------------------------------------------------------------------------
// The claude CLI: flags, working directory, live processes
// ----------------------------------------------------------------------------

/** The agent's built-in tools in a local meeting: read-only, so it can look at the project but never change it. */
export const LOCAL_MEETING_TOOLS = "Read,Glob,Grep";

export interface ClaudeCliFeatures {
  /** --permission-prompts none (newer CLIs). Without it, dontAsk still denies whatever is not allowed. */
  permissionPrompts: boolean;
}

/**
 * Build the argv for the `claude` CLI. Exported so the flag layout can be unit tested without spawning.
 * There is no positional argument: the prompt goes in on stdin, so prompt text is never parsed as flags,
 * never shows up in `ps` and never hits ARG_MAX. Nothing may ask for permission, and no MCP server loads.
 */
export function buildClaudeCliArgs(
  systemPromptPath: string,
  appendSystemPrompt?: string,
  features: ClaudeCliFeatures = { permissionPrompts: true }
): string[] {
  const args = ["--system-prompt-file", systemPromptPath];
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  args.push("-p", "--tools", LOCAL_MEETING_TOOLS, "--permission-mode", "dontAsk");
  if (features.permissionPrompts) args.push("--permission-prompts", "none");
  args.push("--strict-mcp-config", "--restricted", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--no-chrome");
  return args;
}

const featureChecks = new Map<string, Promise<ClaudeCliFeatures>>();

/** What this claude binary supports, from one `claude --help` per binary path (cached for the process). */
function claudeCliFeatures(cli: string, cwd: string): Promise<ClaudeCliFeatures> {
  let check = featureChecks.get(cli);
  if (!check) {
    check = new Promise((resolveFeatures, rejectFeatures) => {
      execFile(
        cli,
        ["--help"],
        { env: childEnv("local-meeting"), cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          const required = ["--restricted", "--settings", "--strict-mcp-config", "--tools", "--permission-mode", "--disable-slash-commands", "--no-chrome"];
          const missing = required.filter(flag => err || !hasFlag(String(stdout), flag));
          if (missing.length) {
            rejectFeatures(new Error(`Local meetings require claude CLI flags: ${missing.join(", ")}${err ? " (--help failed)" : ""}. Upgrade the installed CLI.`));
            return;
          }
          const permissionPrompts = hasFlag(String(stdout), "--permission-prompts");
          if (!permissionPrompts) {
            console.error(
              `[LocalMeeting] this claude CLI ${err ? "did not answer --help" : "has no --permission-prompts"}; ` +
                "omitting that flag (--permission-mode dontAsk still denies anything not allowed)"
            );
          }
          resolveFeatures({ permissionPrompts });
        }
      );
    });
    featureChecks.set(cli, check);
  }
  return check;
}

/** Forget cached `claude --help` results (tests swap fake CLIs). */
export function resetClaudeCliFeatures(): void {
  featureChecks.clear();
}

let broadWorkspaceWarned = false;

/**
 * The CLI's working directory, which bounds what Read/Glob/Grep can reach: anything outside it would
 * need a permission prompt, and dontAsk denies every prompt. That is the workspace, unless it is the
 * filesystem root or the home directory (an MCP host may start the server in /): then an empty
 * private directory, so the agent sees no files rather than all of them.
 */
export function localMeetingCwd(): string {
  const ws = resolve(WORKSPACE_DIR);
  let real: string;
  try {
    real = realpathSync.native(ws);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Local meetings run the claude CLI in ROUNDTABLE_WORKSPACE_DIR, which is not a directory: ${ws}`);
  }
  let home: string | undefined;
  try {
    home = realpathSync.native(homedir());
  } catch {
    home = undefined;
  }
  if (real !== parsePath(real).root && real !== home) return real;
  if (!broadWorkspaceWarned) {
    broadWorkspaceWarned = true;
    console.error(
      `[LocalMeeting] the workspace is ${real}, which would expose every file under it to the agent; ` +
        "running the claude CLI in an empty directory instead. Set ROUNDTABLE_WORKSPACE_DIR to the project."
    );
  }
  const empty = join(ROUNDTABLE_HOME, "local-meeting-workspace");
  mkdirPrivate(empty);
  return empty;
}

const posix = process.platform !== "win32";
const STDOUT_LIMIT = 8 * 1024 * 1024;
/** Enough output for a useful error; the message shows at most 500 characters of it. */
const OUTPUT_KEEP = 64 * 1024;
const KILL_GRACE_MS = 2000;

/** Signal the CLI and, on POSIX, its whole process group (anything it started). Never throws. */
function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(posix ? -pid : pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** CLI processes still running, by pid. Each leads its own process group on POSIX. */
const liveCli = new Map<number, ChildProcess>();
let exitHookInstalled = false;

function trackCli(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  liveCli.set(pid, proc);
  proc.once("exit", () => liveCli.delete(pid));
  if (!exitHookInstalled) {
    // Detached CLIs do not get the server's signals: whatever is left when the process exits is killed.
    exitHookInstalled = true;
    process.on("exit", killLocalMeetingProcessesSync);
  }
}

/** Pids of the local-meeting CLIs still running. */
export function liveLocalMeetingPids(): number[] {
  return [...liveCli.keys()];
}

/** SIGKILL every live CLI's process group. Synchronous, so it works from a process 'exit' hook. */
export function killLocalMeetingProcessesSync(): void {
  for (const pid of liveCli.keys()) signalTree(pid, "SIGKILL");
  liveCli.clear();
}

/** Stop every live CLI: SIGTERM to each process group, then SIGKILL after the grace period. */
export async function stopLocalMeetingProcesses(graceMs: number = KILL_GRACE_MS): Promise<void> {
  const procs = [...liveCli.values()];
  if (!procs.length) return;
  const running = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
  for (const p of procs) signalTree(p.pid, "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(procs.map((p) => (running(p) ? new Promise((r) => p.once("exit", r)) : undefined))),
    new Promise((r) => {
      timer = setTimeout(r, graceMs);
    }),
  ]);
  clearTimeout(timer);
  // The groups too: a CLI that exited on SIGTERM may leave tool processes behind.
  for (const p of procs) signalTree(p.pid, "SIGKILL");
  for (const p of procs) if (p.pid) liveCli.delete(p.pid);
}

/**
 * Execute the local `claude` CLI in print mode with a system prompt file; the prompt goes in on stdin.
 * The CLI is found by a PATH scan (no shell), runs in localMeetingCwd() with the local-meeting
 * allowlist environment, and is tracked until it exits (shutdown stops it). On timeout
 * (ROUNDTABLE_LOCAL_TIMEOUT_MS, default 5 min) its process group gets SIGTERM, then SIGKILL.
 */
export async function executeClaudeCLI(
  systemPromptPath: string,
  prompt: string,
  timeoutMs: number = localTimeoutMs(),
  appendSystemPrompt?: string,  // Skills and session directives (the CLI is stateless, so pass them on every call)
  meter?: SessionScope  // The session this call belongs to: its usage is recorded and a stop ends the call
): Promise<string> {
  const cli = findExecutable("claude");
  if (!cli) {
    console.error("[LocalMeeting] claude CLI not found on PATH");
    throw new Error("Failed to spawn claude CLI: not found on PATH. Is claude installed and in PATH?");
  }
  const stop = meter ? sessionSignal(meter.session) : undefined;
  if (stop?.aborted) throw new StoppedError();
  const cwd = localMeetingCwd();
  const features = await claudeCliFeatures(cli, cwd);
  const args = buildClaudeCliArgs(systemPromptPath, appendSystemPrompt, features);

  console.error(
    `[LocalMeeting] Executing: claude --system-prompt-file ${systemPromptPath}` +
      `${appendSystemPrompt ? " --append-system-prompt <directive>" : ""} -p --tools ${LOCAL_MEETING_TOOLS} ` +
      `--permission-mode dontAsk${features.permissionPrompts ? " --permission-prompts none" : ""} --strict-mcp-config --restricted --settings <hooks-disabled> --disable-slash-commands --no-chrome ` +
      `(prompt on stdin, cwd ${cwd})`
  );
  console.error(`[LocalMeeting] Prompt length: ${prompt.length} chars`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.removeEventListener("abort", onStop);
      fn();
    };
    // A stop ends the call at once: the CLI's process group gets SIGTERM, then SIGKILL after the grace period.
    const onStop = () => {
      signalTree(proc?.pid, "SIGTERM");
      setTimeout(() => signalTree(proc?.pid, "SIGKILL"), KILL_GRACE_MS).unref();
      settle(() => reject(new StoppedError()));
    };

    let proc: ChildProcess;
    try {
      // Own process group on POSIX, so a timeout or shutdown also stops whatever the CLI started.
      proc = spawn(cli, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv("local-meeting"),
        detached: posix,
        windowsHide: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[LocalMeeting] CLI spawn error: ${message}`);
      reject(new Error(`Failed to spawn claude CLI: ${message}. Is claude installed and in PATH?`));
      return;
    }
    trackCli(proc);
    stop?.addEventListener("abort", onStop, { once: true });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    // Decoded as a stream, so a multi-byte character split across chunks stays intact.
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (data: string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(data, "utf8");
      if (stdoutBytes > STDOUT_LIMIT) {
        stdout = "";
        signalTree(proc.pid, "SIGTERM");
        setTimeout(() => signalTree(proc.pid, "SIGKILL"), KILL_GRACE_MS).unref();
        settle(() => reject(new Error(`CLI stdout exceeds ${STDOUT_LIMIT} byte limit`)));
        return;
      }
      stdout += data;
    });
    proc.stderr!.on("data", (data: string) => {
      if (stderr.length < OUTPUT_KEEP) stderr += data;
    });

    // EPIPE when the CLI exits before reading all of stdin: its exit code and output tell the story.
    proc.stdin!.on("error", () => {});
    proc.stdin!.end(prompt);

    timer = setTimeout(() => {
      console.error(`[LocalMeeting] CLI timed out after ${timeoutMs}ms; stopping its process group`);
      signalTree(proc.pid, "SIGTERM");
      setTimeout(() => signalTree(proc.pid, "SIGKILL"), KILL_GRACE_MS).unref();
      settle(() => reject(new Error(`Claude CLI timed out after ${timeoutMs}ms (ROUNDTABLE_LOCAL_TIMEOUT_MS)`)));
    }, timeoutMs);

    proc.on("close", (code, signal) => {
      settle(() => {
        if (code === 0) {
          console.error(`[LocalMeeting] CLI completed successfully, output length: ${stdout.length} chars`);
          if (meter) recordCliCall(meter, { input: prompt.length + (appendSystemPrompt?.length ?? 0), output: stdout.length });
          resolve(stdout.trim());
          return;
        }
        // The CLI reports some failures on stdout (e.g. "Not logged in · Please run /login").
        const detail = scrubAndCap(stderr.trim() || stdout.slice(0, OUTPUT_KEEP).trim(), 500);
        const status = code === null ? `signal ${signal}` : `code ${code}`;
        console.error(`[LocalMeeting] CLI failed with ${status}: ${detail}`);
        reject(new Error(`Claude CLI exited with ${status}: ${detail || "No error output"}`));
      });
    });

    proc.on("error", (err) => {
      settle(() => {
        console.error(`[LocalMeeting] CLI spawn error: ${err.message}`);
        reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is claude installed and in PATH?`));
      });
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
  const meetingId = newId("local");
  const challengerDirective = mode === "debate" ? buildChallengerDirective(debateFocus) : undefined;
  const skillsSection = renderSkillsSection(agentInfo.skills);
  const appendSystemPrompt = [
    skillsSection.trim(),
    challengerDirective?.trim(),
    isPublic ? publicDirectiveSuffix().trim() : undefined,
    isPrototype ? prototypeSystemSuffix({ assessorIsCaller: true, public: isPublic }).trim() : undefined,
  ].filter(Boolean).join("\n\n") || undefined;
  // Board, then public channel, both before the first CLI call so the header is the first post. Config
  // errors fail the start (a public config error closes the blackboard first).
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
    assistantMessage = await executeClaudeCLI(agentInfo.path, userMessage, undefined, appendSystemPrompt, { session: meetingId, kind: "local-meeting", agent });
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
  // Listed from here on: hold the lock until the opening exchange is recorded.
  const release = lockSession(meetingId, localMeetingBusy(meetingId));
  try {
    const record = recorderFor(meeting);
    // Publish the agenda only: userMessage also carries the private context and the debate suffix.
    await recordMeetingCallerMessage(meeting, userMessage, record, { agenda });
    await recordMeetingAgentReply(meeting, assistantMessage, record);
  } finally {
    release();
  }

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
  return withSessionLock(meetingId, localMeetingBusy(meetingId), () => runLocalMeetingTurn(meetingId, message));
}

async function runLocalMeetingTurn(meetingId: string, message: string): Promise<string> {
  const meeting = localMeetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Local meeting not found: ${meetingId}`);
  }

  // Build full context including history (prototype meetings: the agent's prototype status rides on the
  // caller's latest message in this prompt only, never in the stored history)
  const record = recorderFor(meeting);
  await recordMeetingCallerMessage(meeting, message, record);
  const fullPrompt = buildLocalMeetingContext(meeting, undefined, meetingPrototypeStatus(meeting));

  const assistantMessage = await executeClaudeCLI(meeting.agentPromptPath, fullPrompt, undefined, meeting.appendSystemPrompt, { session: meeting.id, kind: "local-meeting", agent: meeting.agent });

  await recordMeetingAgentReply(meeting, assistantMessage, record);

  return assistantMessage;
}

export async function endLocalMeeting(
  meetingId: string,
  requestSummary: boolean = false
): Promise<string> {
  return withSessionLock(meetingId, localMeetingBusy(meetingId), () => closeLocalMeeting(meetingId, requestSummary));
}

async function closeLocalMeeting(meetingId: string, requestSummary: boolean): Promise<string> {
  const meeting = localMeetings.get(meetingId);
  if (!meeting) {
    throw new Error(`Local meeting not found: ${meetingId}`);
  }

  // Prototype mode: destroy whatever is still live first; the summary and activity see the stubbed history.
  const tracker = meeting.prototype;
  if (tracker) await closePrototypeTracker(tracker, "ended");

  let summary = "";
  const dissentSummaries: Array<{ agent: string; content: string }> = [];
  if (requestSummary && meeting.messages.length > 0) {
    const summaryPrompt = buildLocalMeetingContext(meeting) +
      "\n\n---\n\n## Request\n\nPlease provide a brief summary of what we discussed and any action items or conclusions. Do not include DISSENT tags or extraction blocks.";
    summary = withoutDissentBlocks(await executeClaudeCLI(meeting.agentPromptPath, summaryPrompt, undefined, meeting.appendSystemPrompt, { session: meeting.id, kind: "local-meeting", agent: meeting.agent }));
    if (meeting.mode === "debate") {
      const prompt = buildLocalMeetingContext(meeting) + "\n\n## Request\n\n" + buildDissentSummaryPrompt("challenger", meeting.agenda ?? "");
      const content = await executeClaudeCLI(meeting.agentPromptPath, prompt, undefined, meeting.appendSystemPrompt, { session: meeting.id, kind: "local-meeting", agent: meeting.agent });
      dissentSummaries.push({ agent: meeting.agent, content });
    }
  }

  recordActivity({
    session: meetingId,
    kind: "local-meeting",
    mode: meeting.mode,
    agents: [agentKey(meeting.agent)],
    topic: meeting.agenda ?? "",
    outcome: meeting.stopped ? stoppedOutcome(meeting.stopped) : summary || lastAgentReply(meeting),
    public: meeting.publicChannel !== undefined,
  });
  archiveMeeting("local-meeting", meeting, summary, dissentSummaries);
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
  /** Prototype meetings, while the blackboard is up. */
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
