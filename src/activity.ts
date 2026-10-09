// ============================================================================
// Best-effort local activity history (never published)
// ============================================================================

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentKey } from "./agents.js";
import { ACTIVITY_LOG_PATH, ACTIVITY_LOG_MAX_ENTRIES } from "./config.js";

export type ActivityKind = "meeting" | "local-meeting" | "collaboration" | "ultraplan" | "agent-creation" | "agent-refinement";

export interface ActivityEntry {
  at: string;
  session: string;
  kind: ActivityKind;
  mode?: string;
  agents: string[];
  topic: string;
  outcome?: string;
  public: boolean;
}

function excerpt(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Synchronous local writes only: no provider, publisher, retry, or async dependency on session end. */
export function recordActivity(entry: Omit<ActivityEntry, "at"> & { at?: string }, path: string | null = ACTIVITY_LOG_PATH): void {
  if (path === null) return;
  try {
    const normalized: ActivityEntry = {
      at: entry.at ?? new Date().toISOString(),
      session: entry.session,
      kind: entry.kind,
      ...(entry.mode !== undefined && { mode: entry.mode }),
      // Callers supply canonical keys. Only path arguments need conversion; a key may
      // itself start with "subagent-" when its source had that prefix twice.
      agents: entry.agents.map((key) => /[\\/]/.test(key) ? agentKey(key) : key.toLowerCase()),
      topic: excerpt(entry.topic, 300),
      ...(entry.outcome !== undefined && { outcome: excerpt(entry.outcome, 600) }),
      public: entry.public,
    };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(normalized) + "\n", { mode: 0o600 });
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 1.2 * ACTIVITY_LOG_MAX_ENTRIES) {
      writeFileSync(path, lines.slice(-ACTIVITY_LOG_MAX_ENTRIES).join("\n") + "\n");
    }
  } catch (e) {
    console.error(`[Activity] Could not record activity: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isActivityEntry(value: unknown): value is ActivityEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.at === "string" && typeof e.session === "string"
    && ["meeting", "local-meeting", "collaboration", "ultraplan", "agent-creation", "agent-refinement"].includes(String(e.kind))
    && Array.isArray(e.agents) && e.agents.every((key) => typeof key === "string" && !/[\\/]/.test(key) && key.toLowerCase() === key)
    && typeof e.topic === "string" && typeof e.public === "boolean"
    && (e.mode === undefined || typeof e.mode === "string")
    && (e.outcome === undefined || typeof e.outcome === "string");
}

export function readActivity(path: string | null = ACTIVITY_LOG_PATH): ActivityEntry[] {
  if (path === null) return [];
  try {
    const entries: ActivityEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      try {
        const entry: unknown = JSON.parse(line);
        if (isActivityEntry(entry)) entries.push(entry);
      } catch {
        // A partial or corrupt line must not hide the rest of the history.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Normalize a raw agent reference exactly once before looking up activity. */
export function recentActivityFor(ref: string, limit: number = 5, path: string | null = ACTIVITY_LOG_PATH): ActivityEntry[] {
  return recentActivityForKey(agentKey(ref), limit, path);
}

/** Look up an already-canonical key, preserving any remaining filename prefix. */
export function recentActivityForKey(key: string, limit: number = 5, path: string | null = ACTIVITY_LOG_PATH): ActivityEntry[] {
  return readActivity(path).filter((entry) => entry.agents.includes(key.toLowerCase())).reverse().slice(0, Math.max(0, limit));
}
