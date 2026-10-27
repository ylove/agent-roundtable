// ============================================================================
// start_duel: the duel mode as an MCP tool. Runs a whole duel and returns a compact result.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runDuel, validateDuelOptions, withChosenSeats } from "../table/duel.js";
import type { DuelKind, DuelOptions, DuelResult, SeatSpec, TableEvent } from "../table/events.js";
import { DUEL_KINDS, MAX_CRITERIA } from "../table/prompts.js";
import { prepareSeats } from "../table/seats.js";
import { CONNECTORS_PROP, SEAT_CONNECTORS_PROP, type ToolCallContext } from "./shared.js";
import type { JsonSchema } from "../validate.js";
import { MAX_JUDGES, MAX_TEAM_SIZE } from "../table/duel-options.js";
import { checkSeatConnectorArgs } from "../table/seat-connectors.js";

const personaList = (what: string, max: number): JsonSchema => ({
  type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: max,
  description: what,
});

export const START_DUEL_SCHEMA: JsonSchema & { type: "object" } = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["auto", "anthropic", "openai", "together", "replicate", "ollama", "openai_compatible"], description: "Omit or use auto for provider judgment (the router picks a healthy provider per seat and reports why in a routing block); otherwise the chosen provider is used as given. Options: auto; anthropic; openai; together (Together AI — any Together model id, e.g. zai-org/GLM-5.3 or Qwen/...); replicate (owner/name, owner/name:version, or https://replicate.com/owner/name); ollama (local, only when reachable); openai_compatible (any /v1/chat/completions server — set OPENAI_COMPATIBLE_BASE_URL or pass base_url)." },
    model: { type: "string", minLength: 1 },
    topic: { type: "string", minLength: 1, maxLength: 4000, description: "The brief both teams answer, for example a landing page for a product, a module with a given interface, or a written policy." },
    team_a: personaList(`Team A personas, 1 to ${MAX_TEAM_SIZE}. The first writes the concept, the last builds, anyone between critiques the concept. A one-person team does both.`, MAX_TEAM_SIZE),
    team_b: personaList(`Team B personas, 1 to ${MAX_TEAM_SIZE}. Same roles as team_a. No persona may appear twice across both teams and the judges.`, MAX_TEAM_SIZE),
    judges: personaList(`Judge personas, 1 to ${MAX_JUDGES}.`, MAX_JUDGES),
    kind: { type: "string", enum: [...DUEL_KINDS], description: "What the teams build: web (a self-contained index.html, inline CSS, optional inline JS; default), code (source files, shown as read-only text and never executed), diagram (Mermaid source) or text (markdown or plain text)." },
    criteria: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: MAX_CRITERIA, description: "Judging rubric. Default: fit to the brief, quality, usability and accessibility, risk or safety within the judge's own remit, and process efficiency (tokens, time, rewrites and errors)." },
    connectors: CONNECTORS_PROP,
    seat_connectors: SEAT_CONNECTORS_PROP,
    page_check: { type: "boolean", description: "Check web pages in local headless Chrome when available (default true). Set false to skip." },
    stages: { type: "integer", minimum: 1, maximum: 4, description: "Build stages per team: web defaults to 4, other kinds to 1." },
    rounds: { type: "number", minimum: 1, maximum: 2, description: "1 (default) judges once; 2 lets a team the judges did not approve revise once and keeps the original tally." },
    seats: {
      type: "object",
      description: 'Optional assignments keyed by exact persona identifier: {"designer":{"provider":"anthropic","model":"sonnet"}}. Each entry accepts agent, provider (a provider or explicit runtime name) and model.',
      additionalProperties: true,
      patternProperties: { "^.+$": { type: "object", properties: { agent: { type: "string" }, provider: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$", description: "Provider or explicit configured runtime name." }, model: { type: "string", minLength: 1 } }, additionalProperties: false } },
    },
    turn_timeout_s: { type: "number", minimum: 1, maximum: 3600, description: "Seconds allowed for each turn. Default 90 (builds get at least 240)." },
    max_seconds: { type: "number", minimum: 1, maximum: 3600, description: "Time limit for the whole duel before it moves to closings. Default 600, plus 150 per stage beyond the first and 120 per member beyond two on the larger team, capped at 3600. Hosts need a request timeout longer than this, or one that resets on progress notifications." },
  },
  required: ["topic", "team_a", "team_b", "judges"],
};

export const START_DUEL_DESCRIPTION =
  "Run a duel and return its result: two teams each build an artifact for the same brief (a web page, code, a Mermaid diagram or a text document), judges assess both against a rubric, and the losing side files dissents. " +
  "The call runs the whole duel, which can take several minutes and sends a progress notification on every turn, artifact and verdict; the host's request timeout must be long enough or reset on progress. No room is opened. The result has the duel id, winner, tally, each team's artifact title, kind and ok flag, the judges' verdicts, the dissents, a usage summary and the archive id " +
  "(duels/<id>.json, replayable with roundtable duel --replay). It includes process metrics and the chosen artifact directory and file names relative to ROUNDTABLE_HOME, never artifact source. Human judging and resume are available through the CLI, not this tool.";

const personaKey = (id: string): string => id.replace(/^(?:A|B|judge):/, "");
const one = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

/** The compact result, including process metrics and a relative path to the chosen artifact. */
export function summarizeDuel(events: TableEvent[], result: DuelResult): Record<string, unknown> {
  const start = events.find((e): e is Extract<TableEvent, { type: "start" }> => e.type === "start");
  const teams: Record<string, unknown> = {};
  for (const event of events) if (event.type === "prototype") {
    teams[event.team] = { title: event.title ? one(event.title, 120) : undefined, kind: event.kind ?? "web", ok: event.ok, ...(event.check && { check: event.check }), ...(event.error && { error: one(event.error, 200) }), files: event.files.length };
  }
  const usage = [...events].reverse().find((e): e is Extract<TableEvent, { type: "usage" }> => e.type === "usage");
  return {
    duel_id: result.id,
    winner: result.winner,
    tally: result.tally,
    metrics: result.metrics,
    chosen: result.chosen,
    decidedBy: result.decidedBy,
    ...(result.aborted && { aborted: true }),
    kind: start?.kind ?? "web",
    criteria: start?.criteria,
    teams,
    routing: start?.seats.map(({ id, provider, model, reason }) => ({ id, provider, model, reason })),
    verdicts: events.flatMap(e => e.type === "assessment" ? [{ judge: e.judge.name, judge_key: personaKey(e.judge.id), team: e.team, version: e.version, verdict: e.verdict, reason: one(e.reason, 300) }] : []),
    dissents: events.flatMap(e => e.type === "dissent" ? [{ team: e.team, persona: e.seat.name, persona_key: personaKey(e.seat.id), text: e.text.slice(0, 600) }] : []),
    usage: usage && {
      total_cost_usd: Number(usage.totalCostUsd.toFixed(6)),
      ...(usage.totalUnpricedTokens ? { unpriced_tokens: usage.totalUnpricedTokens } : {}),
      per_persona: usage.perSeat.map(s => ({ persona: personaKey(s.seatId), input_tokens: s.inputTokens, output_tokens: s.outputTokens, cost_usd: Number(s.costUsd.toFixed(6)), ...(s.unpricedTokens ? { unpriced_tokens: s.unpricedTokens } : {}) })),
    },
    ...(result.archivePath && { archive_id: result.id, archive: `duels/${result.id}.json` }),
  };
}

export async function startDuelTool(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<CallToolResult> {
  const a = args as { topic: string; team_a: string[]; team_b: string[]; judges: string[]; kind?: DuelKind; stages?: number; criteria?: string[]; rounds?: number; page_check?: boolean; connectors?: string[]; seat_connectors?: Record<string, string[]>; seats?: Record<string, SeatSpec>; provider?: import("../config.js").LLMProvider | "auto"; model?: string; turn_timeout_s?: number; max_seconds?: number };
  if (args.human_judge !== undefined || args.resume !== undefined) throw new Error("Human judging and resume are CLI-only; start_duel runs a whole duel at once.");
  const opts: DuelOptions = {
    topic: a.topic, teamA: a.team_a, teamB: a.team_b, judges: a.judges,
    ...(a.kind && { kind: a.kind }), ...(a.criteria && { criteria: a.criteria }),
    ...(a.page_check !== undefined && { pageCheck: a.page_check }),
    ...(a.stages !== undefined && { stages: a.stages }),
    rounds: (a.rounds ?? 1) as 1 | 2,
    ...(a.turn_timeout_s !== undefined && { turnTimeoutMs: a.turn_timeout_s * 1000 }),
    ...(a.max_seconds !== undefined && { maxSeconds: a.max_seconds }),
    ...(a.connectors?.length && { connectors: a.connectors }),
    ...(a.seat_connectors !== undefined && { seatConnectors: a.seat_connectors }),
  };
  if (a.rounds !== undefined && a.rounds !== 1 && a.rounds !== 2) throw new Error("rounds must be 1 or 2.");
  validateDuelOptions(opts);
  // An unknown connector fails before seats are prepared or any provider is called.
  checkSeatConnectorArgs(opts.connectors, opts.seatConnectors, [...opts.teamA, ...opts.teamB, ...opts.judges]);
  const seats = await prepareSeats({ teamA: opts.teamA, teamB: opts.teamB, judges: opts.judges, seats: a.seats, provider: a.provider, model: a.model }, { signal: ctx?.signal, preflight: a.provider && a.provider !== "auto" ? false : undefined });
  const events: TableEvent[] = [];
  let step = 0;
  const observer = { onEvent(event: TableEvent) {
    events.push(event);
    // A host's request timeout resets on progress, so every visible step reports.
    if (event.type === "turn" || event.type === "prototype" || event.type === "assessment" || event.type === "stage") {
      const team = event.type === "turn" ? event.seat.team ?? "" : event.type === "assessment" ? event.team : event.team;
      ctx?.progress?.(++step, undefined, `${event.type} ${event.type === "turn" ? event.round : ""} ${team}`.replace(/\s+/g, " ").trim());
    }
  } };
  const result = await runDuel(opts, observer, ctx?.signal ?? new AbortController().signal, withChosenSeats(seats));
  return { content: [{ type: "text", text: JSON.stringify(summarizeDuel(events, result), null, 2) }] };
}
