// ============================================================================
// Retention of postmortem drafts (docs/design/postmortem.md §3), run once at orchestrator startup
//
// A draft that was never held is removed after ROUNDTABLE_SESSION_RETENTION_DAYS (default 30; 0 or off
// keeps everything). Held and concluded postmortems and lessons.json are kept until the human
// deletes them, because their purpose is long-lived.
// ============================================================================

import { sessionRetentionDays } from "../config.js";
import { pruneDrafts } from "./store.js";

/** Remove stale drafts; returns their ids. Never throws. */
export function sweepPostmortemDrafts(opts: { days?: number | null; now?: number } = {}): string[] {
  const days = opts.days !== undefined ? opts.days : sessionRetentionDays();
  if (days === null) return [];
  try {
    return pruneDrafts(days, opts.now);
  } catch (e) {
    console.error(`[Retention] postmortem drafts: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
