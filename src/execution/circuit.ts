// ============================================================================
// Circuit breaker per driver or provider
//
// closed ──(5 failures in 10 min with no success between, or any rate limit / auth / credit
//           failure)──▶ open until now + backoff
// open ──(now ≥ until)──▶ half-open: exactly one trial spawn on the driver (watchdog.ts gates it)
// half-open ──(first outcome at or after until: success)──▶ closed
//           ──(failure)──▶ open again, the backoff doubled: 1, 2, 4, 8, 16, then 30 minutes
//
// The blackboard keeps {open, until, reason, opens} per circuit; the rules also take the
// outcomes (failures and successes with their times), which outcomesFromEvents derives from the
// log and the runner adds to from the driver and provider layers. Only those layers' messages
// are classified: a worker's own command or test output never is (see classifyFailure).
// Auth and credit failures are also an immediate emergency awaiting the human, listing the
// alternatives: the other worker drivers and the contract's fallback model.
// ============================================================================

import type { AnyEvent, BlackboardState, EmergencyClass, WorkerDriverId } from "./types.js";
import { draft, emitAction, escalationAction, own, putOwn, sortedKeys, type WatchdogAction } from "./watchdog-actions.js";

export type FailureKind = "error" | "rate_limit" | "auth" | "credit";

export interface DriverOutcome {
  /** Worker driver id ("claude-code", "codex") or provider name ("anthropic", "openai", …). */
  driver: string;
  /** ms since the epoch. */
  at: number;
  kind: FailureKind | "success";
  message?: string;
}

export interface CircuitHistory {
  /** Opens since the circuit last closed (the current one included). */
  opens: number;
  openedAt?: number;
  closedAt?: number;
}

export interface CircuitConfig {
  windowMs: number;
  failures: number;
  baseMs: number;
  maxMs: number;
}

const MIN = 60_000;
export const CIRCUIT_DEFAULTS: Readonly<CircuitConfig> = Object.freeze({ windowMs: 10 * MIN, failures: 5, baseMs: MIN, maxMs: 30 * MIN });

/** Worker drivers a run can switch to (external workers are not spawned by the runner). */
const SPAWNABLE_DRIVERS: readonly WorkerDriverId[] = ["claude-code", "codex"];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Where a failure message came from. Never a worker's command or test output. */
export type FailureSource = "driver" | "provider";

type Classified = Exclude<FailureKind, "error">;
const ORDER: readonly Classified[] = ["credit", "auth", "rate_limit"];

// A status code counts only inside an API error line: "API Error: 429 {…}" (the claude CLI) or
// "Error code: 401 - {…}" (the Anthropic and OpenAI SDKs).
const API_STATUS = String.raw`(?:api error|error code)\s*:?\s*`;

/** Provider API error bodies: the error type or code fields, or an API error line with its status. */
const PROVIDER: Readonly<Record<Classified, RegExp>> = {
  credit: new RegExp(String.raw`credit balance is too low|\binsufficient_quota\b|${API_STATUS}402\b`, "i"),
  auth: new RegExp(String.raw`\b(?:authentication_error|permission_error|invalid_api_key)\b|${API_STATUS}40[13]\b`, "i"),
  rate_limit: new RegExp(String.raw`\b(?:rate_limit_error|overloaded_error|rate_limit_exceeded)\b|${API_STATUS}(?:429|529)\b`, "i"),
};

/** What the worker CLIs themselves print for those conditions (claude -p result text and stderr). */
const DRIVER: Readonly<Record<Classified, RegExp>> = {
  credit: /credit balance is too low/i,
  auth: /not logged in\s*·|please run \/login|invalid api key\s*·|oauth token has expired/i,
  rate_limit: /claude ai usage limit reached/i,
};

/**
 * Classify a failure reported by the driver layer (a worker CLI's error result or stderr) or the
 * provider layer (an API error body). Only provider-shaped messages count: an error type such as
 * "rate_limit_error", "Credit balance is too low", "Not logged in · Please run /login", or a status
 * inside an API error line. Command and test output must never be passed here: it is full of
 * status codes and words like "credit" that mean nothing about the driver. Credit wins over auth,
 * auth over rate_limit; anything else is a plain error.
 */
export function classifyFailure(message: string, opts: { source: FailureSource }): FailureKind {
  for (const kind of ORDER) {
    if (PROVIDER[kind].test(message)) return kind;
    if (opts.source === "driver" && DRIVER[kind].test(message)) return kind;
  }
  return "error";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Open time for the n-th consecutive open (n ≥ 1): base · 2^(n-1), capped at max. */
export function backoffMs(opens: number, cfg: CircuitConfig = CIRCUIT_DEFAULTS): number {
  return Math.min(cfg.maxMs, cfg.baseMs * 2 ** Math.max(0, opens - 1));
}

export type CircuitStatus = "closed" | "open" | "half_open";

/** An open circuit without a readable `until` stays open until something closes it. */
export function circuitStatus(state: BlackboardState, driver: string, now: number): CircuitStatus {
  const c = own(state.watchdog.circuits, driver);
  if (!c?.open) return "closed";
  const until = c.until !== undefined ? Date.parse(c.until) : NaN;
  return Number.isFinite(until) && now >= until ? "half_open" : "open";
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const clip = (s: string | undefined, n = 300): string => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

function describe(o: DriverOutcome): string {
  const label = { error: "error", rate_limit: "rate limit", auth: "authentication failure", credit: "credit failure", success: "success" }[o.kind];
  return o.message ? `${label}: ${clip(o.message, 200)}` : label;
}

function byTime(a: DriverOutcome, b: DriverOutcome): number {
  return a.at - b.at || a.kind.localeCompare(b.kind) || (a.message ?? "").localeCompare(b.message ?? "");
}

function alternatives(state: BlackboardState, driver: string, cls: EmergencyClass, now: number): string[] {
  const out = SPAWNABLE_DRIVERS.filter((d) => d !== driver && circuitStatus(state, d, now) !== "open").map(
    (d) => `Switch workers to the ${d} driver`
  );
  const w = state.contract?.workers;
  if (w?.fallback_model && w.fallback_model !== w.model) out.push(`Use the fallback model ${w.fallback_model}`);
  out.push(
    cls === "money"
      ? `Add credit to the account ${driver} uses, then resume the run`
      : `Sign ${driver} in again (or fix its API key), then resume the run`
  );
  return out;
}

export interface CircuitInput {
  outcomes?: readonly DriverOutcome[];
  history?: Readonly<Record<string, CircuitHistory>>;
}

export function circuitRules(
  state: BlackboardState,
  now: number,
  input: CircuitInput = {},
  cfg: CircuitConfig = CIRCUIT_DEFAULTS
): WatchdogAction[] {
  const outcomes = (input.outcomes ?? []).filter((o) => o.at <= now).sort(byTime);
  const drivers = [...new Set([...outcomes.map((o) => o.driver), ...sortedKeys(state.watchdog.circuits)])].sort();
  const out: WatchdogAction[] = [];

  const open = (d: string, rule: string, reason: string, opens: number) => {
    const key = `circuit:${d}:${rule}`;
    const until = new Date(now + backoffMs(opens, cfg)).toISOString();
    out.push(emitAction("circuit", key, d, [draft("watchdog.circuit_opened", { driver: d, reason, until, opens }, key)]));
  };

  for (const d of drivers) {
    const list = outcomes.filter((o) => o.driver === d);
    const h = own(input.history, d);
    const lastSuccess = list.reduce((t, o) => (o.kind === "success" ? Math.max(t, o.at) : t), -Infinity);
    // The current incident: failures since the last success, the last close, or (on a closed
    // circuit) the end of its last open period, whose failures that incident already counted.
    const c = own(state.watchdog.circuits, d);
    const lastOpenEnd = c && !c.open && c.until !== undefined ? Date.parse(c.until) : NaN;
    const since = Math.max(h?.closedAt ?? -Infinity, lastSuccess, Number.isFinite(lastOpenEnd) ? lastOpenEnd : -Infinity);
    const incident = list.filter((o) => o.kind !== "success" && o.at > since);

    const hard = incident.find((o) => o.kind === "auth" || o.kind === "credit");
    if (hard) {
      const cls: EmergencyClass = hard.kind === "credit" ? "money" : "credentials";
      const message = `Workers on ${d} cannot run: ${describe(hard)}`;
      const alts = alternatives(state, d, cls, now);
      const esc = escalationAction(state, "circuit_emergency", {
        key: `circuit:${d}:${hard.kind}:${hard.at}`,
        kind: "emergency",
        with: "orchestrator",
        target: state.contract?.scope.orchestrator,
        summary: message,
        options: alts,
        emergency: { class: cls, message, alternatives: alts },
        diagnostics: { error_output: clip(hard.message, 2000), notes: `driver ${d}; ${hard.kind} at ${new Date(hard.at).toISOString()}` },
      });
      if (esc) out.push(esc);
    }

    const status = circuitStatus(state, d, now);
    if (status === "closed") {
      const recent = incident.filter((o) => o.at > now - cfg.windowMs);
      const immediate = recent.find((o) => o.kind !== "error");
      if (immediate) open(d, `opened:${immediate.at}`, describe(immediate), 1);
      else if (recent.length >= cfg.failures) {
        const last = recent[recent.length - 1];
        open(d, `opened:${last.at}`, `${recent.length} failures in ${Math.round(cfg.windowMs / MIN)} min; last ${describe(last)}`, 1);
      }
    } else if (status === "half_open") {
      const until = Date.parse(own(state.watchdog.circuits, d)!.until!);
      const trial = list.find((o) => o.at >= until);
      if (!trial) continue;
      if (trial.kind === "success") {
        const key = `circuit:${d}:closed:${trial.at}`;
        out.push(emitAction("circuit", key, d, [draft("watchdog.circuit_closed", { driver: d }, key)]));
      } else {
        // The open count lives on the blackboard (opens); the log's history covers older states.
        const opens = Math.max(1, own(state.watchdog.circuits, d)?.opens ?? 0, h?.opens ?? 0) + 1;
        open(d, `reopened:${trial.at}`, `half-open trial failed: ${describe(trial)}`, opens);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// From the log
// ---------------------------------------------------------------------------

/**
 * Outcomes and history from events: agent.exited with reason "error" is a failure (its
 * result_subtype classified as a driver message) and "completed" a success, attributed to the
 * agent's driver; circuit opened/closed events give the history.
 */
export function outcomesFromEvents(
  events: readonly AnyEvent[],
  state?: BlackboardState
): { outcomes: DriverOutcome[]; history: Record<string, CircuitHistory> } {
  const driverOf = new Map<string, string>();
  const outcomes: DriverOutcome[] = [];
  const history: Record<string, CircuitHistory> = {};
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (e.type === "agent.registered") driverOf.set(e.payload.agent, e.payload.driver);
    else if (e.type === "agent.exited") {
      const p = e.payload;
      const d = driverOf.get(p.agent) ?? own(state?.agents, p.agent)?.driver;
      if (d === undefined) continue;
      if (p.reason === "error") {
        const message = p.result_subtype ?? `exit code ${p.code ?? "none"}`;
        outcomes.push({ driver: d, at, kind: classifyFailure(message, { source: "driver" }), message });
      } else if (p.reason === "completed") outcomes.push({ driver: d, at, kind: "success" });
    } else if (e.type === "watchdog.circuit_opened") {
      const h = own(history, e.payload.driver) ?? { opens: 0 };
      putOwn(history, e.payload.driver, { ...h, opens: h.opens + 1, openedAt: at });
    } else if (e.type === "watchdog.circuit_closed") {
      putOwn(history, e.payload.driver, { opens: 0, closedAt: at });
    }
  }
  return { outcomes, history };
}
