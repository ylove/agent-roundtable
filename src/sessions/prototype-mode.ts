// ============================================================================
// Prototype-mode glue shared by meetings, local meetings and collaborations
// ============================================================================
// The tracker (src/prototypes) owns parsing, the sandbox, the localhost board and destruction. This
// module only adapts it to the session engines: start-time errors, system-prompt text, public
// screenshot posts and the trailer on say/say_local output.

import {
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
 * System-prompt text for a prototype session, appended after any public notice: the public amendment
 * first (it narrows that notice's ban on source code), then the prototype directive.
 */
export function prototypeSystemSuffix(opts: { assessorIsCaller: boolean; public: boolean }): string {
  return (opts.public ? "\n\n" + publicPrototypeAmendment() : "") + buildPrototypeDirective(opts);
}

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

/** Trailer appended to say/say_local output in prototype meetings (drains destroyed_this_call). */
export function prototypeTrailer(tracker: PrototypeTracker): string {
  return `\n\n---\nPrototypes: ${JSON.stringify(tracker.takeCallSummary(), null, 2)}`;
}
