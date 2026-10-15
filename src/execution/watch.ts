// ============================================================================
// The orchestrator's watcher: `agent-roundtable watch <exe> --as <orchestrator> [--timeout-min 50]`
//
// The main chat runs it as a background command. It tails the event log from its cursor in
// watch/<orchestrator>.json, rewrites its liveness there every 10 s ({pid, lastSeenAt}), and exits
// with one JSON line on stdout, {reason, execution, seq, escalation?, message}, when the
// orchestrator is needed:
//   escalation      an escalation.routed to this orchestrator with wake: true (still unresolved)
//   awaiting_human  an escalation.awaiting_human (still awaiting)
//   budget          a budget.threshold_crossed at 80% or more (of the current budget)
//   completed / failed / aborted   the run ended
//   timeout         nothing happened before --timeout-min
// The orchestrator handles the wake and re-arms the watcher, which resumes after the waking event.
// The watchdog's lead fallback reads watcher liveness through watcherObservations.
// ============================================================================

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { openExecutionStore, executionDir } from "./store.js";
import type { AnyEvent, BlackboardState, Escalation } from "./types.js";
import type { WatcherObservation } from "./watchdog.js";

export const WATCH_LIVENESS_MS = 10_000;
export const WATCH_DEFAULT_TIMEOUT_MIN = 50;
/** Orchestrator names are file names here. */
export const ORCHESTRATOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WatchFile {
  v: 1;
  orchestrator: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  /** The last seq handled: the next watcher starts after it. */
  cursor: number;
  /** Set when the watcher exited (with its reason). */
  exitedAt?: string;
  reason?: WatchReason;
}

export type WatchReason = "escalation" | "awaiting_human" | "budget" | "completed" | "failed" | "aborted" | "timeout";

/** The one line `watch` prints. */
export interface WatchResult {
  reason: WatchReason;
  execution: string;
  /** The waking event's seq (on timeout, the last seq seen). */
  seq: number;
  escalation?: { id: string; kind: string; with: string; task?: string; summary: string; question?: string; options?: string[]; class?: string };
  message: string;
}

export function watchDir(exe: string): string {
  return join(executionDir(exe), "watch");
}

export function watchFilePath(exe: string, orchestrator: string): string {
  if (!ORCHESTRATOR_NAME_RE.test(orchestrator)) throw new Error(`Not an orchestrator name: ${JSON.stringify(String(orchestrator).slice(0, 64))}`);
  return join(watchDir(exe), `${orchestrator}.json`);
}

export function readWatchFile(exe: string, orchestrator: string): WatchFile | null {
  try {
    const w = JSON.parse(readFileSync(watchFilePath(exe, orchestrator), "utf8")) as WatchFile;
    return w && w.v === 1 && Number.isSafeInteger(w.cursor) ? w : null;
  } catch {
    return null;
  }
}

/**
 * Liveness of every watcher of the execution, by orchestrator, for the watchdog's observations: a
 * watcher is alive while its pid lives and it has not exited. lastSeenAt lets the watchdog judge a
 * silent one stale.
 */
export function watcherObservations(exe: string): Record<string, WatcherObservation> {
  const out: Record<string, WatcherObservation> = {};
  let names: string[];
  try {
    names = readdirSync(watchDir(exe));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const orchestrator = name.slice(0, -5);
    if (!ORCHESTRATOR_NAME_RE.test(orchestrator)) continue;
    const w = readWatchFile(exe, orchestrator);
    if (!w) continue;
    const seen = Date.parse(w.lastSeenAt);
    Object.defineProperty(out, orchestrator, {
      value: { alive: !w.exitedAt && pidAlive(w.pid), ...(Number.isFinite(seen) && { lastSeenAt: seen }) },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// ============================================================================
// Wake conditions (pure)
// ============================================================================

const cap = (s: string | undefined, n: number) => {
  const t = scrub((s ?? "").trim());
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function brief(esc: Escalation | undefined, id: string): WatchResult["escalation"] {
  if (!esc) return { id, kind: "unknown", with: "unknown", summary: "" };
  return {
    id,
    kind: esc.kind,
    with: esc.with,
    ...(esc.task && { task: esc.task }),
    summary: cap(esc.summary, 1000),
    ...(esc.question && { question: cap(esc.question, 500) }),
    ...(esc.options?.length && { options: esc.options.slice(0, 10).map((o) => cap(o, 200)) }),
    ...(esc.emergency && { class: esc.emergency }),
  };
}

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * Whether `e` wakes `orchestrator`, judged against the current state: an escalation that was
 * resolved meanwhile, or a budget warning of a total since extended, no longer wakes anyone.
 */
export function wakeFor(state: Readonly<BlackboardState>, e: AnyEvent, orchestrator: string): WatchResult | null {
  const base = { execution: state.execution, seq: e.seq };
  switch (e.type) {
    case "escalation.routed": {
      const esc = own(state.escalations, e.payload.id);
      if (e.payload.to !== orchestrator || !e.payload.wake) return null;
      if (esc && (esc.status === "resolved" || esc.status === "withdrawn" || esc.routed_to !== orchestrator)) return null;
      return { ...base, reason: "escalation", escalation: brief(esc, e.payload.id), message: `Escalation ${e.payload.id} needs ${orchestrator}: resolve it with resolve_escalation, then re-arm the watcher.` };
    }
    case "escalation.awaiting_human": {
      const esc = own(state.escalations, e.payload.id);
      if (esc && esc.status !== "awaiting_human") return null;
      return { ...base, reason: "awaiting_human", escalation: brief(esc, e.payload.id), message: `The human is needed (${e.payload.class}): ${cap(e.payload.message, 600)}` };
    }
    case "budget.threshold_crossed": {
      if (e.payload.pct < 80) return null;
      if (state.budget.thresholds_budget_usd !== undefined && state.budget.thresholds_budget_usd !== e.payload.budget_usd) return null;
      return { ...base, reason: "budget", message: `The run has spent $${e.payload.spent_usd.toFixed(2)} of its $${e.payload.budget_usd.toFixed(2)} budget (${e.payload.pct}%).` };
    }
    case "execution.completed":
      return { ...base, reason: "completed", message: `The run completed at ${e.payload.integration_sha.slice(0, 12)}${e.payload.pr_url ? `; pull request ${e.payload.pr_url}` : ""}.` };
    case "execution.failed":
      return { ...base, reason: "failed", message: `The run failed: ${cap(e.payload.reason, 600)}` };
    case "execution.aborted":
      return { ...base, reason: "aborted", message: `The run was aborted: ${cap(e.payload.reason, 600)}` };
    default:
      return null;
  }
}

// ============================================================================
// The watcher
// ============================================================================

export interface WatchOptions {
  as: string;
  timeoutMin?: number;
  /** How often the log is read (default 1 s). */
  pollMs?: number;
  /** How often liveness is written (default 10 s). */
  livenessMs?: number;
  signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/** Watch until a wake condition or the timeout; returns the line to print. Throws on a bad execution or name. */
export async function watchExecution(exe: string, opts: WatchOptions): Promise<WatchResult> {
  const orchestrator = opts.as;
  const path = watchFilePath(exe, orchestrator);
  const store = await openExecutionStore(exe);
  const timeoutMs = Math.max(0, (opts.timeoutMin ?? WATCH_DEFAULT_TIMEOUT_MIN) * 60_000);
  const pollMs = opts.pollMs ?? 1000;
  const livenessMs = opts.livenessMs ?? WATCH_LIVENESS_MS;
  const started = Date.now();
  const prev = readWatchFile(exe, orchestrator);
  let cursor = prev?.cursor ?? 0;
  mkdirPrivate(watchDir(exe));
  const file = (extra: Partial<WatchFile> = {}): WatchFile => ({
    v: 1,
    orchestrator,
    pid: process.pid,
    startedAt: new Date(started).toISOString(),
    lastSeenAt: new Date().toISOString(),
    cursor,
    ...extra,
  });
  writeFileAtomic(path, JSON.stringify(file()) + "\n");
  let lastBeat = Date.now();
  try {
    // A run that already ended answers at once, whatever the cursor says.
    if (TERMINAL.has((await store.state()).status)) {
      const end = (await store.events({ types: ["execution.completed", "execution.failed", "execution.aborted"] })).pop();
      const wake = end && wakeFor(await store.state(), end, orchestrator);
      if (wake) {
        cursor = Math.max(cursor, wake.seq);
        writeFileAtomic(path, JSON.stringify(file({ exitedAt: new Date().toISOString(), reason: wake.reason })) + "\n");
        return wake;
      }
    }
    for (;;) {
      const events = await store.events({ sinceSeq: cursor });
      if (events.length) {
        const state = await store.state();
        for (const e of events) {
          const wake = wakeFor(state, e, orchestrator);
          cursor = e.seq;
          if (wake) {
            writeFileAtomic(path, JSON.stringify(file({ exitedAt: new Date().toISOString(), reason: wake.reason })) + "\n");
            return wake;
          }
        }
      }
      const now = Date.now();
      if (now - started >= timeoutMs || opts.signal?.aborted) {
        writeFileAtomic(path, JSON.stringify(file({ exitedAt: new Date().toISOString(), reason: "timeout" })) + "\n");
        return { reason: "timeout", execution: exe, seq: cursor, message: `Nothing needed ${orchestrator} for ${Math.round((now - started) / 60_000)} min; re-arm the watcher.` };
      }
      if (now - lastBeat >= livenessMs) {
        writeFileAtomic(path, JSON.stringify(file()) + "\n");
        lastBeat = now;
      }
      await sleep(Math.min(pollMs, Math.max(1, started + timeoutMs - now)), opts.signal);
    }
  } catch (e) {
    try {
      writeFileAtomic(path, JSON.stringify(file({ exitedAt: new Date().toISOString() })) + "\n");
    } catch {
      /* the execution may have been purged */
    }
    throw e;
  }
}
