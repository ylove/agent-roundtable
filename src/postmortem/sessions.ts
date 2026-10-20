// ============================================================================
// Postmortem sessions take no outside input (docs/design/postmortem.md §5)
//
// A postmortem meeting runs in the collaboration engine, tagged with origin "postmortem:<pm>". The
// human has no seat: nudge_collaboration, continue_collaboration, say and say_local refuse its session
// id, and list_collaborations does not show it. This module has no imports, so the engine and the
// tool layer can both use it.
// ============================================================================

export const POSTMORTEM_ORIGIN_PREFIX = "postmortem:";
export const NO_OUTSIDE_INPUT = "postmortem meetings take no outside input";

const sessions = new Set<string>();
const MAX_REMEMBERED = 500;

export const isPostmortemOrigin = (origin: string | undefined): boolean => origin?.startsWith(POSTMORTEM_ORIGIN_PREFIX) === true;

/** Remember a postmortem meeting's session id, so it stays refused after the session has ended. */
export function registerPostmortemSession(id: string): void {
  sessions.add(id);
  if (sessions.size > MAX_REMEMBERED) sessions.delete(sessions.values().next().value as string);
}

/** Throws for a postmortem session id; `origin` is the live session's origin, when the caller has it. */
export function assertAcceptsInput(id: string, origin?: string): void {
  if (sessions.has(id) || isPostmortemOrigin(origin)) {
    throw new Error(`${NO_OUTSIDE_INPUT} (${id} is a postmortem meeting; read it with postmortem(action: "read"))`);
  }
}
