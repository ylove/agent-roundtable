// ============================================================================
// Per-session locks: at most one turn in flight per session
// ============================================================================
// A second caller is refused at once with a busy error, never queued: a queued turn would run against
// state the caller has not seen. This is separate from serializeTurn (prototype-mode.ts), which orders
// the recording steps *within* one turn of a prototype session.
// Session ids are unique across kinds (each kind has its own prefix), so one registry serves them all.

const held = new Set<string>();

/** Thrown when a session already has a turn in flight. */
export class SessionBusyError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message: string) {
    super(message);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
}

/** `<Label> <id> is busy: <activity> is still running. Wait for it to finish, then retry.` */
export function sessionBusyMessage(label: string, id: string, activity = "a turn"): string {
  return `${label} ${id} is busy: ${activity} is still running. Wait for it to finish, then retry.`;
}

/** True while a turn holds the session's lock (contract freezing and the read-only tools may ask). */
export function isSessionBusy(id: string): boolean {
  return held.has(id);
}

/** Take the session's lock or throw SessionBusyError(message) at once. Returns an idempotent release. */
export function lockSession(id: string, message: string): () => void {
  if (held.has(id)) throw new SessionBusyError(id, message);
  held.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(id);
  };
}

/** Run `fn` holding the session's lock; refuse at once when it is already held. */
export async function withSessionLock<T>(id: string, message: string, fn: () => T | Promise<T>): Promise<T> {
  const release = lockSession(id, message);
  try {
    return await fn();
  } finally {
    release();
  }
}
