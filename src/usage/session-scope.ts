// ============================================================================
// Session scope: meters and stops the provider calls of at-the-table sessions
//
// metered({session, kind, agent}, fn) runs a session's turn (or one agent's part of it) with
//   - a usage sink that appends one line per provider call to the table ledger (table.ts), tokens
//     measured when the provider reported them and estimated from the request and reply lengths
//     when it did not, cost estimated from the price table (nothing when the model has no price);
//   - the session's AbortSignal, which providers/index.ts combines with its own timeout, so
//     abortSession() cuts the call in flight (usage-visibility.md §6).
// When an outer sink is already collecting (a heads-down huddle's UsageMeter runs its formats at the
// table), the call is left to it: the heads-down ledger owns that spend, so it is never counted twice.
// ============================================================================

import { estimateUsd } from "../execution/pricing.js";
import { activeUsageSink, withAbortSignal, withUsageSink, type UsageReport, type UsageSink } from "../providers/usage.js";
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

/** Cut the session's provider calls in flight. A later turn of the same session starts aborted too. */
export function abortSession(session: string, reason: string): void {
  sessionSignal(session);
  controllers.get(session)!.abort(new Error(reason));
}

/** Forget the controllers of sessions that are no longer live and have no turn in flight. */
export function sweepControllers(live: ReadonlySet<string>): void {
  for (const id of [...controllers.keys()]) if (!live.has(id) && !turns.get(id)) controllers.delete(id);
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
    prov = "measured";
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
    agent: scope.agent,
    provider: r.provider,
    model: r.model,
    tokens,
    tokens_prov: prov,
  };
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
  return line;
}

function ledgerSink(scope: SessionScope): UsageSink {
  return (r) => {
    try {
      appendTableLine(lineFor(scope, r, currentServerId()), ledgerHome);
    } catch (e) {
      console.error(`[Usage] table ledger write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/**
 * Record one call of the local `claude` CLI (a local meeting's turn). It runs in text mode, so there are
 * no token counts to read: they are estimated from the lengths, and the CLI has no per-token price.
 */
export function recordCliCall(scope: SessionScope, chars: { input: number; output: number }): void {
  if (activeUsageSink()) return;
  ledgerSink(scope)({ provider: "claude-cli", model: "claude-cli", chars });
}

/** Run one turn (or one agent's part of it) of a session, metered and stoppable. */
export async function metered<T>(scope: SessionScope, fn: () => Promise<T>): Promise<T> {
  const signal = sessionSignal(scope.session);
  const run = () => withAbortSignal(signal, fn);
  turns.set(scope.session, (turns.get(scope.session) ?? 0) + 1);
  try {
    return await (activeUsageSink() ? run() : withUsageSink(ledgerSink(scope), run));
  } finally {
    turns.set(scope.session, (turns.get(scope.session) ?? 1) - 1);
  }
}
