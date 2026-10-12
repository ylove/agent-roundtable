// ============================================================================
// Prototype-mode glue shared by meetings, local meetings and collaborations
// ============================================================================
// The tracker (src/prototypes) owns parsing, the sandbox, the localhost board and destruction. This
// module only adapts it to the session engines: start-time errors, opening the board and the public
// channel, system-prompt text, turn serialization, recording meeting turns, public screenshot posts,
// public summaries and the trailer on say/say_local output.

import {
  CALLER,
  PrototypeTracker,
  buildPrototypeDirective,
  publicPrototypeAmendment,
  type PrototypeAttachment,
  type TrackerOptions,
} from "../prototypes/index.js";
import { publicLabel } from "../publishers/index.js";
import type { PublicChannel } from "./public.js";

export type { PrototypeTracker };

export const PROTOTYPE_CONVERSATION_ERROR =
  'prototype: true is not supported with mode "conversation" (a conversation has no deliverable to prototype). ' +
  "Use mode collaborate, debate or waffle-house, or start without prototype.";

export const NUDGE_HELD_ERROR =
  "A prototype is under assessment, so nudges are held until the other participants have given their verdicts: " +
  "run continue_collaboration (it also resumes a paused prototype session). " +
  "Do not relay the human's feedback on prototypes into the session until it ends.";

/**
 * Start the tracker (sandbox directory + localhost board). Called before the first LLM call and before
 * the public channel opens, so a bad prototype configuration fails the start with nothing to clean up.
 */
export async function openPrototypeTracker(opts: TrackerOptions): Promise<PrototypeTracker> {
  try {
    return await PrototypeTracker.create(opts);
  } catch (e) {
    throw new Error(
      `Cannot start prototype mode: ${e instanceof Error ? e.message : String(e)} ` +
        `(fix ROUNDTABLE_PROTOTYPE_DIR or start without prototype: true).`
    );
  }
}

/** Close a tracker without ever throwing into a session. */
export async function closePrototypeTracker(
  tracker: PrototypeTracker | undefined,
  reason: "ended" | "completed" | "shutdown"
): Promise<void> {
  if (!tracker) return;
  try {
    await tracker.close(reason);
  } catch (e) {
    console.error(`[Prototype] close failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Open a session's prototype board (when `tracker` options are given), then its public channel (when
 * `openChannel` returns one). The board comes first so a prototype configuration error never leaves a
 * public header behind; a public configuration error closes the board before it propagates.
 */
export async function openSessionSurfaces(
  tracker: TrackerOptions | undefined,
  openChannel: () => PublicChannel | undefined
): Promise<{ prototype?: PrototypeTracker; publicChannel?: PublicChannel }> {
  const prototype = tracker ? await openPrototypeTracker(tracker) : undefined;
  try {
    return { prototype, publicChannel: openChannel() };
  } catch (e) {
    await closePrototypeTracker(prototype, "ended");
    throw e;
  }
}

/**
 * System-prompt text for a prototype session, appended after any public notice: the public amendment
 * first (it narrows that notice's ban on source code), then the prototype directive.
 */
export function prototypeSystemSuffix(opts: { assessorIsCaller: boolean; public: boolean }): string {
  return (opts.public ? "\n\n" + publicPrototypeAmendment() : "") + buildPrototypeDirective(opts);
}

// ----------------------------------------------------------------------------
// Turn serialization
// ----------------------------------------------------------------------------

const turnChains = new WeakMap<object, Promise<unknown>>();

/**
 * Run `fn` once every earlier serialized step of the same session has settled. The tracker keys each
 * turn by the message index it will be recorded at, so "read messages.length, await onTurn, record"
 * must never interleave with another record on that session (a nudge, a concurrent say or continue).
 * Only prototype sessions use this; nothing else ever waits on it.
 */
export function serializeTurn<T>(session: object, fn: () => T | Promise<T>): Promise<T> {
  const previous = turnChains.get(session) ?? Promise.resolve();
  const run = previous.then(fn);
  turnChains.set(session, run.catch(() => undefined));
  return run;
}

// ----------------------------------------------------------------------------
// Meetings and local meetings (the caller assesses the agent's prototypes)
// ----------------------------------------------------------------------------

type MeetingTurn = { role: "user" | "assistant"; content: string };

/** What the meeting recorders need from a meeting or a local meeting. */
export interface PrototypeMeetingSession {
  agent: string;
  messages: MeetingTurn[];
  publicChannel?: PublicChannel;
  prototype?: PrototypeTracker;
}

/** The session's own choke point (recordMeetingMessage or recordLocalMeetingMessage). */
export type RecordMeetingTurn = (message: MeetingTurn, publicText?: string) => void;

/**
 * Record the agent's reply. Prototype meetings run the tracker first (it may materialize a prototype),
 * post the URL-free public form, then any screenshots under the same public turn number.
 */
export async function recordMeetingAgentReply(
  meeting: PrototypeMeetingSession,
  content: string,
  record: RecordMeetingTurn
): Promise<void> {
  const tracker = meeting.prototype;
  if (!tracker) {
    record({ role: "assistant", content });
    return;
  }
  await serializeTurn(meeting, async () => {
    const turnKey = meeting.messages.length;
    const result = await tracker.onTurn(0, content, turnKey);
    const publicText = meeting.publicChannel ? tracker.publicView(content, turnKey) : undefined;
    record({ role: "assistant", content }, publicText);
    postPrototypeAttachments(meeting.publicChannel, meeting.messages.length, meeting.agent, result.attachments);
  });
}

/**
 * Record a caller message. Prototype meetings parse it first (the caller's verdicts can destroy assessed
 * prototypes); only the caller's own words are stored and published (board URLs scrubbed). The agent's
 * prototype status is added to the outgoing request only (withPrototypeStatus), never stored.
 * `opening`: the first message stores the agenda plus private context but publishes, and is parsed as,
 * the agenda only.
 */
export async function recordMeetingCallerMessage(
  meeting: PrototypeMeetingSession,
  content: string,
  record: RecordMeetingTurn,
  opening?: { agenda: string }
): Promise<void> {
  const tracker = meeting.prototype;
  if (!tracker) {
    record({ role: "user", content }, opening?.agenda);
    return;
  }
  await serializeTurn(meeting, async () => {
    const turnKey = meeting.messages.length;
    await tracker.onTurn(CALLER, opening ? opening.agenda : content, turnKey);
    const publicText = !meeting.publicChannel
      ? undefined
      : opening
        ? opening.agenda
        : tracker.publicView(content, turnKey);
    record({ role: "user", content }, publicText);
  });
}

/** The agent's prototype status for this turn ("" outside prototype mode or when nothing applies). */
export function meetingPrototypeStatus(meeting: PrototypeMeetingSession): string {
  return meeting.prototype ? meeting.prototype.statusPromptFor(0) : "";
}

// ----------------------------------------------------------------------------
// Public output
// ----------------------------------------------------------------------------

/** Post a turn's screenshots right after its text (public sessions only). Never throws. */
export function postPrototypeAttachments(
  channel: PublicChannel | undefined,
  turn: number,
  speaker: string,
  attachments: PrototypeAttachment[]
): void {
  if (!channel) return;
  for (const a of attachments) {
    channel.recordAttachment({
      turn,
      speaker: publicLabel(speaker),
      filename: a.filename,
      contentType: a.contentType,
      bytes: a.bytes,
      caption: a.caption,
    });
  }
}

/**
 * The end-of-session summary as published: in prototype sessions it goes through the tracker's public
 * view (no board URL, no raw prototype block). Unchanged otherwise.
 */
export function publicSummary(tracker: PrototypeTracker | undefined, summary: string | undefined): string | undefined {
  return tracker && summary ? tracker.publicView(summary, -1) : summary;
}

/** Trailer appended to say/say_local output in prototype meetings (drains destroyed_this_call). */
export function prototypeTrailer(tracker: PrototypeTracker): string {
  return `\n\n---\nPrototypes: ${JSON.stringify(tracker.takeCallSummary(), null, 2)}`;
}
