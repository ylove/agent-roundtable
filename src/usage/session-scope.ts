// ============================================================================
// Session scope: meters and stops the provider calls of at-the-table sessions
//
// metered({session, kind, agent}, fn) runs a session's turn (or one agent's part of it) with
//   - a usage sink that appends one line per provider call to the table ledger (table.ts), tokens
//     measured when the provider reported them and estimated from the request and reply lengths
//     when it did not, cost estimated from the price table (nothing when the model has no price);
//   - a cumulative spend cap when configured, counting unpriced calls at the routing estimate;
//   - the session's AbortSignal, which providers/index.ts combines with its own timeout, so
//     abortSession() cuts the call in flight (usage-visibility.md §6).
// When an outer sink is already collecting (a heads-down huddle's UsageMeter runs its formats at the
// table), the call is left to it: the heads-down ledger owns that spend, so it is never counted twice.
// ============================================================================

import { recordSessionSpend, stopCappedSession, clearSessionCap, sessionCapView } from "./session-caps.js";
import { scrub } from "../security/secrets.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { agentKey } from "../agents.js";
import { estimateUsd } from "../execution/pricing.js";
import { activeProviderOutcome, withProviderFailureSink, activeUsageSink, withAbortSignal, withUsageSink, type UsageReport, type UsageSink } from "../providers/usage.js";
import { appendTableLine, newServerId, type TableLine } from "./table.js";
import { ROUNDTABLE_HOME } from "../config.js";
import type { Provenance } from "./types.js";

export interface SessionScope {
  session: string;
  /** meeting, local-meeting, collaboration, ultraplan, agent-creation, chat. */
  kind: string;
  /** The persona speaking, or a label such as "planner" or "chat_completion". */
  agent: string;
}

/** Set on a session that was stopped by a person (usage-visibility.md §6): its end records it. */
export interface StoppedInfo {
  by: string;
  at: string;
  reason?: string;
}

/** The activity-log outcome of a stopped session. */
export const stoppedOutcome = (s: StoppedInfo): string => `Stopped by ${s.by} at ${s.at.slice(11, 16)} UTC`;

export interface StoppedSession {
  session: string;
  kind: string;
  agent: string;
  by: string;
  at: string;
  reason?: string;
}

const controllers = new Map<string, AbortController>();
const turns = new Map<string, number>();
/** Sessions this process stopped, so the next tool call that names one can say what happened. */
export const stoppedSessions = new Map<string, StoppedSession>();

/** Tool arguments that name a live session. */
const SESSION_ARGS = ["meeting_id", "collaboration_id", "ultraplan_id"] as const;

/** The stopped session a tool call names, if it names one. */
export function stoppedSessionNamed(args: Record<string, unknown> | undefined): StoppedSession | undefined {
  if (!args || stoppedSessions.size === 0) return undefined;
  for (const key of SESSION_ARGS) {
    const v = args[key];
    if (typeof v === "string" && stoppedSessions.has(v)) return stoppedSessions.get(v);
  }
  return undefined;
}

/** What the next call on a stopped session answers (usage-visibility.md §6). */
export function stoppedResult(s: StoppedSession): Record<string, unknown> {
  return {
    status: "stopped",
    session: s.session,
    kind: s.kind,
    agent: s.agent,
    by: s.by,
    at: s.at,
    ...(s.reason && { reason: s.reason }),
    next:
      `${s.session} was stopped by ${s.by}; it has ended and its transcript is archived. Two ways forward: ` +
      `continue without ${s.agent || "the agent"} (start a new session with the others), or write a handoff with usage(action: "handoff", session_id: "${s.session}"). ` +
      'usage(action: "report") lists recent stops.',
  };
}

let serverId: string | undefined;
let ledgerHome = ROUNDTABLE_HOME;

/** This process's server id (made on first use; startTableService fixes it for the life of the server). */
export function currentServerId(): string {
  return (serverId ??= newServerId());
}

export function setServerId(id: string): void {
  serverId = id;
}

/** Tests: write the ledger under another home. */
export function setLedgerHome(home: string | undefined): void {
  ledgerHome = home ?? ROUNDTABLE_HOME;
}

/** The session's signal. It fires only when abortSession() is called for it. */
export function sessionSignal(session: string): AbortSignal {
  let c = controllers.get(session);
  if (!c) controllers.set(session, (c = new AbortController()));
  return c.signal;
}

/** Resume uses a fresh signal; abandoned calls keep their original, aborted signal. */
export function resetSessionSignal(session: string): void {
  controllers.set(session, new AbortController());
  stoppedSessions.delete(session);
}

/** Cut the session's provider calls in flight. A later turn of the same session starts aborted too. */
export function abortSession(session: string, reason: string): void {
  sessionSignal(session);
  controllers.get(session)!.abort(new Error(reason));
}

/** Forget the controllers of sessions that are no longer live and have no turn in flight. */
export function sweepControllers(live: ReadonlySet<string>): void {
  for (const id of [...controllers.keys()]) if (!live.has(id) && !turns.get(id)) { controllers.delete(id); clearSessionCap(id); }
}

export function busySessions(): Set<string> {
  return new Set([...turns].filter(([, n]) => n > 0).map(([id]) => id));
}

const CHARS_PER_TOKEN = 4;

/** The ledger line for one provider call. Exported for tests. */
export function lineFor(scope: SessionScope, r: UsageReport, server: string, at = new Date()): TableLine {
  let tokens: { input: number; output: number; cache_read: number; cache_write: number };
  let prov: Provenance;
  if (r.usage) {
    tokens = {
      input: r.usage.inputTokens,
      output: r.usage.outputTokens,
      cache_read: r.usage.cacheReadTokens ?? 0,
      cache_write: r.usage.cacheWriteTokens ?? 0,
    };
    prov = r.tokensProvenance ?? "measured";
  } else {
    tokens = {
      input: Math.ceil((r.chars?.input ?? 0) / CHARS_PER_TOKEN),
      output: Math.ceil((r.chars?.output ?? 0) / CHARS_PER_TOKEN),
      cache_read: 0,
      cache_write: 0,
    };
    prov = "estimated";
  }
  const line: TableLine = {
    at: at.toISOString(),
    server,
    session: scope.session,
    kind: scope.kind,
    // A persona given as a path reads as its name ("cfo"), as everywhere else (agentKey).
    agent: agentKey(scope.agent),
    provider: r.provider,
    model: r.model,
    tokens,
    tokens_prov: prov,
  };
  const outcome = activeProviderOutcome();
  if (outcome?.provider === r.provider) { line.outcome = outcome.outcome; line.latency_ms = outcome.latency_ms; if (outcome.endpoint !== undefined) line.endpoint = outcome.endpoint; if (outcome.cred !== undefined) line.cred = outcome.cred; }
  const count = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
  if (count > 0) {
    const est = estimateUsd(
      r.model,
      { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cache_read, cacheWriteTokens: tokens.cache_write },
      { provider: r.provider }
    );
    // An unknown model has no price: leave the cost out rather than record a $0.00 that means nothing.
    if (!(est.estimated && est.usd === 0)) {
      line.usd = est.usd;
      line.usd_prov = "estimated";
    }
  }
  if (r.tokensProvenance === "reported" && r.usd !== undefined && Number.isFinite(r.usd) && r.usd >= 0) {
    line.usd = r.usd;
    line.usd_prov = "reported";
  }
  return line;
}

function checkCap(scope: SessionScope, line: TableLine): void {
  if (!recordSessionSpend(scope.session, line)) return;
  abortSession(scope.session, "Spend cap reached");
  void stopCappedSession(scope.session).catch(() => console.error("[Usage] could not stop capped session"));
}

function ledgerSink(scope: SessionScope): UsageSink {
  return (r) => {
    const line = lineFor(scope, r, currentServerId());
    checkCap(scope, line);
    try {
      appendTableLine(line, ledgerHome);
    } catch (e) {
      console.error(`[Usage] table ledger write failed: ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
  };
}

/**
 * Record one call of the local `claude` CLI (a local meeting's turn). It runs in text mode, so there are
 * no token counts to read: they are estimated from the lengths, and the CLI has no per-token price.
 */
export function recordCliCall(scope: SessionScope, chars: { input: number; output: number }): void {
  if (activeUsageSink()) {
    checkCap(scope, lineFor(scope, { provider: "claude-cli", model: "claude-cli", chars }, currentServerId()));
    return;
  }
  ledgerSink(scope)({ provider: "claude-cli", model: "claude-cli", chars });
}

const meteredSession = new AsyncLocalStorage<string>();

/** Run one turn (or one agent's part of it) of a session, metered and stoppable. */
export async function metered<T>(scope: SessionScope, fn: () => Promise<T>): Promise<T> {
  const signal = sessionSignal(scope.session);
  if (sessionCapView(scope.session)?.reached) signal.throwIfAborted();
  const run = () => withAbortSignal(signal, fn);
  const outer = activeUsageSink();
  const parentSession = meteredSession.getStore();
  turns.set(scope.session, (turns.get(scope.session) ?? 0) + 1);
  try {
    return await meteredSession.run(scope.session, () => withProviderFailureSink(outer ? undefined : outcome => {
      appendTableLine({ at: new Date(Date.now()).toISOString(), server: currentServerId(), session: scope.session,
        kind: scope.kind, agent: agentKey(scope.agent), ...outcome }, ledgerHome);
    }, () => withUsageSink(outer ? (r) => {
      try { outer({ ...r, agent: agentKey(scope.agent) }); }
      finally { if (parentSession !== scope.session) checkCap(scope, lineFor(scope, r, currentServerId())); }
    } : ledgerSink(scope), run)));
  } finally {
    turns.set(scope.session, (turns.get(scope.session) ?? 1) - 1);
  }
}
