// ============================================================================
// Process-wide room for live sessions, including sessions still opening
// ============================================================================

const sources = new Map<string, () => Iterable<string>>();
const opening = new Set<string>();
export function registerLiveSessionSource(kind: string, source: () => Iterable<string>): void { sources.set(kind, source); }
export function liveSessionLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ROUNDTABLE_MAX_LIVE_SESSIONS;
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 4;
}
export function activeLiveSessionIds(): Set<string> {
  const live = new Set(opening);
  for (const source of sources.values()) for (const id of source()) live.add(id);
  return live;
}
export function assertLiveSessionRoom(): void {
  const live = activeLiveSessionIds();
  const limit = liveSessionLimit();
  if (live.size >= limit) throw new Error(`Live session limit ${limit} reached (ROUNDTABLE_MAX_LIVE_SESSIONS). Stop a live session before starting another.`);
}
/** Reserve before asynchronous setup; registered live ids and reservations count only once. */
export function reserveLiveSession(id: string): () => void {
  assertLiveSessionRoom();
  opening.add(id);
  return () => { opening.delete(id); };
}
