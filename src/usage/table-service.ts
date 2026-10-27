// ============================================================================
// The table service: what an orchestrator server does for usage visibility (usage-visibility.md §4, §6)
//
//   - every 5 s it rewrites usage/live/<server-id>.json with its live sessions, and removes the file on
//     a clean shutdown (a reader treats a dead pid or an old heartbeat as gone);
//   - every second it looks in usage/stops/<server-id>/ for stop requests. For each one that names a
//     session of this server it aborts the session's turn in flight (the provider call through its
//     AbortSignal, a local meeting's CLI through its process group), ends the session with reason
//     "stopped" (archived, in the activity log), records `stopped` in the table ledger and removes the
//     request. A malformed request is renamed .bad.
//   - the next tool call that names a stopped session answers {status: "stopped", …} (tools.ts).
// ============================================================================

import { liveDuels } from "../table/live-duels.js";
import { setTimeout as sleep } from "node:timers/promises";
import { agentKey } from "../agents.js";
import { ROUNDTABLE_HOME, sessionRetentionDays } from "../config.js";
import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { collaborations, endCollaboration } from "../sessions/collaborations.js";
import { isSessionBusy } from "../sessions/lock.js";
import { endLocalMeeting, localMeetings } from "../sessions/local-meetings.js";
import { endMeeting, meetings } from "../sessions/meetings.js";
import { endUltraplan, ultraplans } from "../sessions/ultraplan.js";
import {
  abortSession,
  busySessions,
  currentServerId,
  setServerId,
  stoppedSessions,
  sweepControllers,
  type StoppedInfo,
} from "./session-scope.js";
import {
  appendTableLine,
  newServerId,
  pruneTableLedgers,
  readStopRequests,
  removeLiveFile,
  removeStopRequest,
  writeLiveFile,
  type LiveSession,
  type StopRequest,
} from "./table.js";

const clean = (s: string, max: number): string => scrub(s).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

interface LiveInfo {
  id: string;
  kind: "meeting" | "local-meeting" | "collaboration" | "ultraplan" | "duel" | "casting";
  agents: string[];
  started: string;
  mark(stopped: StoppedInfo): void;
  end(): Promise<unknown>;
}

/** The sessions this process holds, as the in-memory session maps show them. */
function sessions(): LiveInfo[] {
  const out: LiveInfo[] = [];
  for (const m of meetings.values()) {
    out.push({ id: m.id, kind: "meeting", agents: [agentKey(m.agent)], started: m.startedAt.toISOString(), mark: (s) => void (m.stopped = s), end: () => endMeeting(m.id, false) });
  }
  for (const m of localMeetings.values()) {
    out.push({ id: m.id, kind: "local-meeting", agents: [agentKey(m.agent)], started: m.startedAt.toISOString(), mark: (s) => void (m.stopped = s), end: () => endLocalMeeting(m.id, false) });
  }
  for (const c of collaborations.values()) {
    out.push({ id: c.id, kind: "collaboration", agents: c.agents.map((a) => agentKey(a.name)), started: c.startedAt.toISOString(), mark: (s) => void (c.stopped = s), end: () => endCollaboration(c.id, false) });
  }
  for (const d of liveDuels()) {
    // The duel unwinds itself once its calls are cut, so ending it needs nothing more.
    out.push({ id: d.id, kind: d.kind ?? "duel", agents: d.agents, started: d.started, mark: (s) => void (d.stopped = s), end: async () => undefined });
  }
  for (const u of ultraplans.values()) {
    out.push({
      id: u.id,
      kind: "ultraplan",
      agents: [...new Set([...u.agents.map((a) => agentKey(a.name)), ...(u.planner ? [agentKey(u.planner.name)] : [])])],
      started: u.startedAt.toISOString(),
      mark: (s) => void (u.stopped = s),
      end: () => endUltraplan(u.id),
    });
  }
  return out;
}

export function findSession(id: string): LiveInfo | undefined {
  return sessions().find((s) => s.id === id);
}

/** The live sessions for usage/live/<server-id>.json. */
export function liveSessions(): LiveSession[] {
  const busy = busySessions();
  return sessions().map((s) => ({ id: s.id, kind: s.kind, agents: s.agents.slice(0, 32), started: s.started, ...((busy.has(s.id) || isSessionBusy(s.id)) && { busy: true }) }));
}

export interface SessionStop {
  status: "stopped" | "gone";
  session: string;
  kind?: string;
  agent?: string;
  by?: string;
  at?: string;
}

export interface SessionStopRequest {
  session: string;
  by: string;
  surface: StopRequest["surface"];
  reason?: string;
  agent?: string;
}

/** Stop one session of this process: abort its turn, end it as stopped, remember it. */
export async function stopSession(req: SessionStopRequest, home = ROUNDTABLE_HOME): Promise<SessionStop> {
  const info = findSession(req.session);
  if (!info) return { status: "gone", session: req.session };
  const stopped: StoppedInfo = { by: clean(req.by, 100), at: new Date().toISOString(), ...(req.reason && { reason: clean(req.reason, 500) }) };
  info.mark(stopped);
  abortSession(info.id, `stopped by ${stopped.by}`);
  // The turn in flight unwinds quickly (the provider call or the CLI was cut); then the session can be ended.
  const deadline = Date.now() + 8_000;
  while (isSessionBusy(info.id) && Date.now() < deadline) await sleep(40);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await info.end();
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
      if (!findSession(info.id)) break; // another path ended it meanwhile
      await sleep(100);
    }
  }
  if (lastError && findSession(info.id)) console.error(`[Usage] could not end stopped session ${info.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const agent = clean(req.agent ?? info.agents[0] ?? "", 64);
  stoppedSessions.set(info.id, { session: info.id, kind: info.kind, agent, by: stopped.by, at: stopped.at, ...(stopped.reason && { reason: stopped.reason }) });
  while (stoppedSessions.size > 200) stoppedSessions.delete(stoppedSessions.keys().next().value as string);
  try {
    appendTableLine({ at: stopped.at, server: currentServerId(), session: info.id, kind: info.kind, agent, event: "stopped", by: stopped.by }, home);
  } catch (e) {
    console.error(`[Usage] table ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await appendAudit({ actor: stopped.by, action: "agent.stopped", target: info.id, details: { scope: info.id, kind: info.kind, agent, ...(stopped.reason && { reason: stopped.reason }) } });
  } catch (e) {
    console.error(`[Usage] audit entry failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { status: "stopped", session: info.id, kind: info.kind, agent, by: stopped.by, at: stopped.at };
}

export interface TableService {
  readonly serverId: string;
  /** Stop the timers and remove this server's live file. Idempotent. */
  close(): void;
}

export interface TableServiceOptions {
  home?: string;
  beatMs?: number;
  pollMs?: number;
}

/** Start the live-file heartbeat and the stop-request poll of an orchestrator server. */
export function startTableService(o: TableServiceOptions = {}): TableService {
  const home = o.home ?? ROUNDTABLE_HOME;
  const serverId = newServerId();
  setServerId(serverId);
  const started = new Date().toISOString();
  let closed = false;
  let warned = false;

  const beat = (): void => {
    if (closed) return;
    try {
      const live = liveSessions();
      writeLiveFile(serverId, { pid: process.pid, started, sessions: live }, home);
      sweepControllers(new Set(live.map((s) => s.id)));
      warned = false;
    } catch (e) {
      if (!warned) console.error(`[Usage] live file not written: ${e instanceof Error ? e.message : String(e)}`);
      warned = true;
    }
  };

  let polling = false;
  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      for (const req of readStopRequests(serverId, home)) {
        try {
          await stopSession({ session: req.session, by: req.by, surface: req.surface, agent: req.agent, ...(req.reason && { reason: req.reason }) }, home);
        } catch (e) {
          console.error(`[Usage] stop request ${req.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          removeStopRequest(serverId, req.id, home);
        }
      }
      beat();
    } catch (e) {
      console.error(`[Usage] stop poll failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      polling = false;
    }
  };

  beat();
  const beatTimer = setInterval(beat, o.beatMs ?? 5_000);
  const pollTimer = setInterval(() => void poll(), o.pollMs ?? 1_000);
  beatTimer.unref();
  pollTimer.unref();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(beatTimer);
    clearInterval(pollTimer);
    removeLiveFile(serverId, home);
    process.off("exit", close);
  };
  process.on("exit", close);

  // The ledger follows the same retention as archived sessions.
  const days = sessionRetentionDays();
  if (days !== null) {
    try {
      pruneTableLedgers(days, Date.now(), home);
    } catch (e) {
      console.error(`[Usage] ledger pruning skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { serverId, close };
}
