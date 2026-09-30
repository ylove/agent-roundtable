// ============================================================================
// Public-session helpers shared by meetings, local meetings and collaborations
// ============================================================================

import { createPublicChannel, publicSessionDirective } from "../publishers/index.js";
import type { FinalizeResult, PublicChannel } from "../publishers/index.js";

export type { PublicChannel, FinalizeResult };

/**
 * Create the public channel for a session (posts the header entry). Throws a clear config error if
 * the publisher is unknown or misconfigured: that is a start-time failure, not a publish failure.
 * `topic` must be the agenda/topic only, never the caller's `context`.
 */
export function openPublicChannel(
  sessionId: string,
  meta: { mode: string; participants: string[]; topic: string }
): PublicChannel {
  try {
    return createPublicChannel(sessionId, meta);
  } catch (e) {
    throw new Error(
      `Cannot start a public session: ${e instanceof Error ? e.message : String(e)} ` +
        `(fix the publisher configuration or start without public: true).`
    );
  }
}

/** System-prompt text appended for public sessions, with a leading blank line for concatenation. */
export function publicDirectiveSuffix(): string {
  return "\n\n" + publicSessionDirective();
}

/** The `public` field of a start result and of list_* rows. */
export function publicInfo(channel: PublicChannel): { url: string | null; topic: string } {
  return { url: channel.url, topic: channel.topic };
}

/** Block appended to end_* results. */
export function formatPublicBlock(channel: PublicChannel, r: FinalizeResult): string {
  const live = channel.kind === "ntfy" ? " (live ~12h on the public server)" : "";
  let out =
    `Public transcript: ${r.url ?? "(no public URL)"}${live} · Saved: ${r.savedPath ?? "(not saved)"} · ` +
    `Published ${r.published}/${r.total}`;
  for (const w of r.warnings) out += `\nWarning: ${w}`;
  return out;
}
