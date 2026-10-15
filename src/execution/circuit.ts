// ============================================================================
// Circuit breaker per driver or provider
//
// closed ──(5 failures in 10 min with no success between, or any rate limit / auth / credit
//           failure)──▶ open until now + backoff
// open ──(now ≥ until)──▶ half-open: the runner may start one trial on the driver
// half-open ──(first outcome at or after until: success)──▶ closed
//           ──(failure)──▶ open again, the backoff doubled: 1, 2, 4, 8, 16, then 30 minutes
//
// The blackboard keeps only {open, until, reason} per circuit, so the rules also take the
// outcomes (failures and successes with their times) and the open/close history, which
// outcomesFromEvents derives from the log; the runner adds the failures it sees in worker output.
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

// Status codes count only with an HTTP context ("HTTP 401", "status: 429", "Error code: 402",
// "403 Forbidden"), so a line number or an assertion in ordinary error output is not mistaken for one.
const STATUS = String.raw`\b(?:http(?:\/\d(?:\.\d)?)?|status|code)[ :=]*`;
const CREDIT_RE = new RegExp(
  String.raw`credit balance|insufficient[_ ]quota|exceeded your current quota|plan and billing details|payment required|out of credits|${STATUS}402\b`,
  "i"
);
const AUTH_RE = new RegExp(
  String.raw`not logged in|please run \/login|invalid (?:api|x-api)[ _-]?key|authentication[_ ]error|permission[_ ]error|oauth token (?:has )?expired|` +
    String.raw`${STATUS}40[13]\b|\b401 unauthori[sz]ed|\b403 forbidden`,
  "i"
);
const RATE_RE = new RegExp(
  String.raw`${STATUS}(?:429|529)\b|too many requests|rate[_ ]limit(?:_error|ed| exceeded| reached)|overloaded_error|usage limit reached`,
  "i"
);

/** credit before auth before rate_limit; anything else is a plain error. */
export function classifyFailure(message: string): FailureKind {
  if (CREDIT_RE.test(message)) return "credit";
  if (AUTH_RE.test(message)) return "auth";
  if (RATE_RE.test(message)) return "rate_limit";
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
    out.push(emitAction("circuit", key, d, [draft("watchdog.circuit_opened", { driver: d, reason, until }, key)]));
  };

  for (const d of drivers) {
    const list = outcomes.filter((o) => o.driver === d);
    const h = own(input.history, d);
    const lastSuccess = list.reduce((t, o) => (o.kind === "success" ? Math.max(t, o.at) : t), -Infinity);
    // The current incident: failures since the last success (or the last close).
    const since = Math.max(h?.closedAt ?? -Infinity, lastSuccess);
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
        open(d, `reopened:${trial.at}`, `half-open trial failed: ${describe(trial)}`, Math.max(1, h?.opens ?? 1) + 1);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// From the log
// ---------------------------------------------------------------------------

/**
 * Outcomes and history from events: agent.exited with reason "error" is a failure (classified
 * from result_subtype) and "completed" a success, attributed to the agent's driver; circuit
 * opened/closed events give the history. Pass the log since the run started for exact backoff.
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
        outcomes.push({ driver: d, at, kind: classifyFailure(message), message });
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
