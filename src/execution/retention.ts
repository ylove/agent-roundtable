// ============================================================================
// Retention sweep (heads-down.md §16), run once at orchestrator startup, best effort
//
//   executions  completed, failed or aborted runs that ended more than
//               ROUNDTABLE_EXECUTION_RETENTION_DAYS ago (default 30): their worktrees, rt/<tag>/*
//               branches and execution directory, through run-admin's purge (audited). A run whose
//               repository is gone uses the same locked purge and worker checks, skipping only git cleanup.
//   sessions    archived at-the-table sessions, duels and casting calls (ROUNDTABLE_SESSION_RETENTION_DAYS, 30)
//   audit       month files of the audit log (pruneAudit, ROUNDTABLE_AUDIT_RETENTION_DAYS, 365)
//
// 0 or off keeps everything of that kind. Live runs are never touched, and every failure is
// collected into the report instead of thrown.
// ============================================================================

import { statSync } from "node:fs";
import { join } from "node:path";
import { pruneDuelArchives } from "../table/retention.js";
import { pruneCastingArchives } from "../casting/retention.js";
import { auditRetentionDays, executionRetentionDays, sessionRetentionDays } from "../config.js";
import { pruneAudit } from "../security/audit.js";
import { pruneArchivedSessions } from "../sessions/archive.js";
import { purgeExecution } from "./run-admin.js";
import { executionDir, listExecutions, openExecutionStore } from "./store.js";
import type { EventType } from "./types.js";

const DAY_MS = 86_400_000;
const TERMINAL_EVENTS: EventType[] = ["execution.completed", "execution.failed", "execution.aborted"];
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface RetentionOptions {
  /** Clock override (ms since the epoch). */
  now?: number;
  /** Day counts; null keeps everything. Defaults: the ROUNDTABLE_*_RETENTION_DAYS settings. */
  executionDays?: number | null;
  sessionDays?: number | null;
  auditDays?: number | null;
}

export interface RetentionReport {
  executions: string[];
  sessions: string[];
  audit: string[];
  errors: string[];
}

/** When a terminal run ended (its terminal event), or undefined for a run that has not ended. */
async function endedAt(exe: string): Promise<number | undefined> {
  const store = await openExecutionStore(exe);
  const state = await store.state();
  if (!["completed", "failed", "aborted"].includes(state.status)) return undefined;
  const ends = await store.events({ types: TERMINAL_EVENTS });
  const last = ends[ends.length - 1];
  return last ? Date.parse(last.ts) : undefined;
}

/** Purge the terminal runs that ended before the cutoff. */
export async function pruneExecutions(retentionDays: number, now = Date.now()): Promise<{ removed: string[]; errors: string[] }> {
  const cutoff = now - retentionDays * DAY_MS;
  const removed: string[] = [];
  const errors: string[] = [];
  for (const h of await listExecutions()) {
    try {
      // A log written after the cutoff cannot hold an older end: skip reading it.
      if (statSync(join(executionDir(h.id), "events.jsonl")).mtimeMs >= cutoff) continue;
      const ended = await endedAt(h.id);
      if (ended === undefined || !(ended < cutoff)) continue;
      await purgeExecution(h.id, { confirm: true, actor: "retention" });
      removed.push(h.id);
    } catch (e) {
      errors.push(`${h.id}: ${errText(e)}`);
    }
  }
  return { removed, errors };
}

/** The whole sweep. Never throws. */
export async function sweepRetention(opts: RetentionOptions = {}): Promise<RetentionReport> {
  const now = opts.now ?? Date.now();
  const report: RetentionReport = { executions: [], sessions: [], audit: [], errors: [] };
  const exeDays = opts.executionDays !== undefined ? opts.executionDays : executionRetentionDays();
  const sessionDays = opts.sessionDays !== undefined ? opts.sessionDays : sessionRetentionDays();
  const auditDays = opts.auditDays !== undefined ? opts.auditDays : auditRetentionDays();
  if (exeDays !== null) {
    try {
      const r = await pruneExecutions(exeDays, now);
      report.executions = r.removed;
      report.errors.push(...r.errors);
    } catch (e) {
      report.errors.push(`executions: ${errText(e)}`);
    }
  }
  if (sessionDays !== null) {
    try {
      report.sessions = [...pruneArchivedSessions(sessionDays, now), ...pruneDuelArchives(sessionDays, now), ...pruneCastingArchives(sessionDays, now)];
    } catch (e) {
      report.errors.push(`sessions: ${errText(e)}`);
    }
  }
  if (auditDays !== null) {
    try {
      report.audit = await pruneAudit(auditDays, { now });
    } catch (e) {
      report.errors.push(`audit: ${errText(e)}`);
    }
  }
  return report;
}

/** One stderr line for the sweep (stdout is the MCP channel). */
export function describeRetention(r: RetentionReport): string {
  const parts = [
    `${r.executions.length} run${r.executions.length === 1 ? "" : "s"}`,
    `${r.sessions.length} archived session${r.sessions.length === 1 ? "" : "s"}`,
    `${r.audit.length} audit month file${r.audit.length === 1 ? "" : "s"}`,
  ];
  return `[Retention] pruned ${parts.join(", ")}${r.errors.length ? `; ${r.errors.length} failed: ${r.errors.slice(0, 3).join("; ")}` : ""}`;
}
