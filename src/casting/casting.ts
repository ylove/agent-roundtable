import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { agentKey, listAgents, loadAgent, readFrontmatter, type LoadedAgent } from "../agents.js";
import { AGENTS_DIR, LIBRARY_DIR, PARALLEL_TURNS, PROVIDER_IDS, ROUNDTABLE_HOME, type LLMProvider } from "../config.js";
import { activeUsageSink, withAbortSignal, withUsageSink } from "../providers/usage.js";
import { isContained, mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrub, scrubAndCap } from "../security/secrets.js";
import { mapLimit } from "../sessions/workshop.js";
import { callSeat } from "../table/dispatch.js";
import { checkSeatConnectorArgs, startSeatConnectors, withSeatConnectors, type SeatConnectorMap } from "../table/seat-connectors.js";
import { parseSeat, type Seat, type SeatSpec, type TableEvent, type TableObserver } from "../table/events.js";
import { assertSeatCredentials, resolveSeats, SeatUsageError, validateSeatSpecs } from "../table/seats.js";
import { turnTokens } from "../table/duel.js";
import { registerDuel, unregisterDuel } from "../table/live-duels.js";
import { lineFor, metered, sessionSignal } from "../usage/session-scope.js";
import { listLibrary } from "../library/catalog.js";
import { lintAgent } from "./lint.js";
import { findSimilarity } from "./similarity.js";
import { answerPrompt, auditionPrompt, DIRECTOR_SYSTEM, questionsPrompt, verdictPrompt } from "./prompts.js";
import type { CastingReport } from "./report.js";

export interface CastingOptions {
  brief: string; agents?: string[]; agentsDir?: string; seats?: number; examine?: boolean;
  dryRun?: boolean; provider?: LLMProvider | "auto"; model?: string;
  seat?: string | Record<string, SeatSpec>; mix?: "auto" | "cheap";
  turnTimeoutMs?: number; maxSeconds?: number;
  /** Configured MCP connectors every seat may call as tools during its turn. */
  connectors?: string[];
  /** Limits a persona to some of those connectors (persona key to connector names). */
  seatConnectors?: SeatConnectorMap;
}

export function validateCastingOptions(opts: CastingOptions): void {
  if (typeof opts.brief !== "string" || !opts.brief.trim() || opts.brief.length > 4000) throw new SeatUsageError("cast requires a brief of 1 to 4000 characters.");
  if (opts.agents !== undefined && (!Array.isArray(opts.agents) || opts.agents.length < 2 || opts.agents.length > 24 || opts.agents.some(a => typeof a !== "string" || !a.trim()))) throw new SeatUsageError("--agents requires 2 to 24 personas.");
  if (opts.agentsDir !== undefined && !isAbsolute(opts.agentsDir)) throw new SeatUsageError("--agents-dir requires an absolute directory.");
  if (opts.seats !== undefined && (!Number.isInteger(opts.seats) || opts.seats < 1 || opts.seats > 24)) throw new SeatUsageError("--seats must be a whole number from 1 to 24.");
  if (opts.provider !== undefined && opts.provider !== "auto" && !PROVIDER_IDS.includes(opts.provider)) throw new SeatUsageError("Invalid seat provider.");
  if (opts.mix !== undefined && opts.mix !== "auto" && opts.mix !== "cheap") throw new SeatUsageError("--mix must be auto or cheap.");
  if (!Number.isFinite(opts.maxSeconds ?? 300) || (opts.maxSeconds ?? 300) < 0 || (opts.maxSeconds ?? 300) > 3600 ||
      !Number.isFinite(opts.turnTimeoutMs ?? 90_000) || (opts.turnTimeoutMs ?? 90_000) <= 0 || (opts.turnTimeoutMs ?? 90_000) > 3_600_000) throw new SeatUsageError("Invalid casting limits.");
}

async function loadCast(opts: CastingOptions): Promise<LoadedAgent[]> {
  // With no explicit set, cast the agents directory plus the imported library (shadowed entries skipped).
  const library = !opts.agents && !opts.agentsDir;
  const found = library ? [...listAgents(AGENTS_DIR), ...listAgents(LIBRARY_DIR)] : listAgents(opts.agentsDir);
  const refs = opts.agents ?? (library ? listLibrary().filter(agent => !agent.shadowed).map(agent => agent.key) : found.map(agent => agent.key));
  if (refs.length < 2 || refs.length > 24) throw new SeatUsageError("--agents requires 2 to 24 personas; narrow the set with --agents.");
  if (new Set(refs.map(agentKey)).size !== refs.length) throw new SeatUsageError("--agents requires distinct persona keys.");
  if (refs.some(ref => agentKey(ref) === "casting-director")) throw new SeatUsageError("--agents cannot include the reserved casting-director seat.");
  const root = opts.agentsDir ? await realpath(opts.agentsDir) : undefined;
  return Promise.all(refs.map(async ref => {
    if (!root) return loadAgent(opts.agents ? ref : found.find(agent => agent.key === agentKey(ref))!.path);
    const file = found.find(agent => agent.key === agentKey(ref));
    if (!file) throw new SeatUsageError(`Agent prompt not found for "${agentKey(ref)}".`);
    const path = await realpath(file.path);
    if (!isContained(root, path)) throw new SeatUsageError("Agent is outside the agents directory.");
    const raw = await readFile(path, "utf8");
    const { body, data: frontmatter } = readFrontmatter(raw);
    return { ref, key: agentKey(ref), path, raw, body, frontmatter, skills: [] };
  }));
}

function castAssignments(raw: CastingOptions["seat"], keys: string[]): Record<string, SeatSpec> | undefined {
  if (raw === undefined) return;
  const specs: SeatSpec[] = [];
  if (typeof raw === "string") {
    for (const value of raw.split(",")) {
      let spec: SeatSpec;
      try { spec = parseSeat(value); }
      catch { throw new SeatUsageError("Invalid --seat assignment; use agent=provider[:model] or agent=runtime[:model]."); }
      if (!spec.provider) throw new SeatUsageError("--seat requires agent=provider[:model] or agent=runtime[:model].");
      specs.push(spec);
    }
  } else {
    validateSeatSpecs(raw);
    for (const [id, spec] of Object.entries(raw)) specs.push({ ...spec, agent: id });
  }
  const result: Record<string, SeatSpec> = Object.create(null);
  for (const spec of specs) {
    const key = agentKey(spec.agent);
    if (Object.hasOwn(result, key)) throw new SeatUsageError("Repeated seat assignment.");
    if (!keys.includes(key) && key !== "casting-director") throw new SeatUsageError("Seat override names an agent outside the roster.");
    result[key] = { ...spec, agent: key };
  }
  return result;
}

/** Read the first object, including fenced JSON and braces inside quoted strings. */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("Missing JSON object.");
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(s => typeof s === "string");

export function parseQuestions(text: string, keys: string[]): Record<string, string> {
  const value = firstJsonObject(text);
  if (!object(value)) throw new Error("Questions must be an object.");
  const result: Record<string, string> = Object.create(null);
  for (const key of keys) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Missing question for ${key}.`);
    result[key] = scrubAndCap(value[key], 2000);
  }
  return result;
}

/** Unknown persona keys are discarded; incomplete or ill-shaped reports are retried. */
export function parseCastingVerdict(text: string, base: CastingReport, seats: number): CastingReport {
  const value = firstJsonObject(text);
  if (!object(value) || !Array.isArray(value.agents) || !Array.isArray(value.redundancy) || !strings(value.gaps) || !object(value.recommended) || !strings(value.recommended.seats)) throw new Error("Invalid roster report shape.");
  const known = new Set(base.agents.map(a => a.key));
  const keys = (values: string[]) => [...new Set(values.filter(key => known.has(key)))];
  const seen = new Set<string>();
  if (value.agents.some(a => !object(a) || typeof a.key !== "string")) throw new Error("Invalid persona verdict.");
  const agents = value.agents.filter(a => object(a) && typeof a.key === "string" && known.has(a.key)).map(a => {
    if (!object(a) || typeof a.key !== "string" || seen.has(a.key) || !["cast", "bench", "redundant", "unclear"].includes(String(a.verdict)) ||
        !strings(a.strengths) || !strings(a.risks) || !strings(a.overlapsWith) || (a.role !== undefined && typeof a.role !== "string")) throw new Error("Invalid persona verdict.");
    seen.add(a.key);
    const original = base.agents.find(agent => agent.key === a.key)!;
    return { ...original, verdict: a.verdict as CastingReport["agents"][number]["verdict"], ...(a.role !== undefined && { role: scrubAndCap(a.role as string, 1000) }),
      strengths: a.strengths.map(s => scrubAndCap(s, 2000)), risks: a.risks.map(s => scrubAndCap(s, 2000)), overlapsWith: keys(a.overlapsWith).filter(key => key !== a.key) };
  });
  if (seen.size !== known.size) throw new Error("Include every persona in the report.");
  const redundancy = value.redundancy.map(r => {
    if (!object(r) || !strings(r.keys) || typeof r.reason !== "string") throw new Error("Invalid redundancy cluster.");
    return { keys: keys(r.keys), reason: scrubAndCap(r.reason, 2000) };
  }).filter(r => r.keys.length > 1);
  const eligible = new Set(agents.filter(a => a.verdict === "cast").map(a => a.key));
  const recommended: CastingReport["recommended"] = { seats: keys(value.recommended.seats).filter(key => eligible.has(key)).slice(0, seats) };
  const used = new Set<string>();
  for (const field of ["teamA", "teamB", "judges"] as const) {
    const list = value.recommended[field];
    if (list === undefined) continue;
    if (!strings(list)) throw new Error(`Invalid recommended.${field}.`);
    recommended[field] = keys(list).filter(key => {
      if (!recommended.seats.includes(key) || used.has(key)) return false;
      used.add(key); return true;
    }).slice(0, field === "judges" ? 5 : 4);
  }
  return { ...base, agents: base.agents.map(a => agents.find(agent => agent.key === a.key)!), redundancy, gaps: value.gaps.map(s => scrubAndCap(s, 2000)), recommended };
}

function staticReport(agents: LoadedAgent[], opts: CastingOptions, id: string, createdAt: string): CastingReport {
  const redundancy = findSimilarity(agents);
  const roster: CastingReport["agents"] = agents.map(agent => {
    const lint = lintAgent(agent, agents);
    const cluster = redundancy.find(r => r.keys.includes(agent.key));
    const redundant = cluster && cluster.keys[0] !== agent.key;
    return { key: agent.key, ...(typeof agent.frontmatter.name === "string" && { name: scrub(agent.frontmatter.name) }),
      verdict: lint.some(l => l.code === "empty-body") ? "unclear" : redundant ? "redundant" : "cast",
      strengths: [], risks: lint.filter(l => l.level === "warn").map(l => l.message), overlapsWith: cluster?.keys.filter(key => key !== agent.key) ?? [], lint };
  });
  const recommended = roster.filter(a => a.verdict === "cast").slice(0, opts.seats ?? Math.min(5, agents.length)).map(a => a.key);
  for (const agent of roster) if (agent.verdict === "cast" && !recommended.includes(agent.key)) agent.verdict = "bench";
  return { id, createdAt, brief: scrub(opts.brief), ...(opts.dryRun && { dryRun: true, note: "Static checks only, no auditions: the recommended cast is the first eligible personas in listed order, not a judgment of the brief." }),
    agents: roster, redundancy, gaps: [], recommended: { seats: recommended } };
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export async function runCastingCall(opts: CastingOptions, obs: TableObserver, signal: AbortSignal): Promise<CastingReport> {
  validateCastingOptions(opts);
  const agents = await loadCast(opts);
  if (opts.seats !== undefined && opts.seats > agents.length) throw new SeatUsageError("--seats cannot exceed the number of personas in --agents.");
  // An unknown connector fails here, before anything is started or any provider is called.
  const checked = checkSeatConnectorArgs(opts.connectors, opts.seatConnectors, [...agents.map(a => a.key), "casting-director"]);
  if (checked.names.length && opts.dryRun) throw new SeatUsageError("connectors are not available with dry-run, which makes no provider calls.");
  const id = `cast-${randomUUID()}`, createdAt = new Date().toISOString();
  const count = opts.seats ?? Math.min(5, agents.length);
  const overrides = castAssignments(opts.seat, agents.map(a => a.key));
  let report = staticReport(agents, opts, id, createdAt);
  const events: TableEvent[] = [];
  const emit = async (event: TableEvent) => {
    events.push(event);
    try { await obs.onEvent(event); } catch { /* A failed renderer cannot interrupt archival. */ }
  };
  const deadline = new AbortController();
  const ended = Date.now() + (opts.maxSeconds ?? 300) * 1000;
  const timer = setTimeout(() => deadline.abort(new Error("Casting deadline reached.")), (opts.maxSeconds ?? 300) * 1000);
  // Listed with the live duels, so the usage view and stop_session reach it through sessionSignal(id).
  registerDuel({ id, kind: "casting", agents: agents.map(a => a.key), started: createdAt });
  let connectors: Awaited<ReturnType<typeof startSeatConnectors>> | undefined;
  try {
    connectors = checked.names.length ? await startSeatConnectors(checked.names, { signal, seatConnectors: checked.seatConnectors }) : undefined;
    const stop = AbortSignal.any([signal, deadline.signal, sessionSignal(id)]);
    const stopped = () => stop.aborted || Date.now() >= ended;
    const assignments: Map<string, Seat> = opts.dryRun || stopped() ? new Map([...agents.map(a => a.key), "casting-director"].map(key => [key, { id: key, name: key, provider: "static", model: "", reason: "static checks; no provider calls" } satisfies Seat]))
      : await resolveSeats({ agents: [...agents.map(a => a.key), "casting-director"], provider: opts.provider, model: opts.model, seats: overrides, mix: opts.mix,
        load: async key => key === "casting-director" ? { frontmatter: { role: "judge" } } : agents.find(a => a.key === key)! });
    if (!opts.dryRun && !stopped()) assertSeatCredentials(assignments.values());
    const seats = [...assignments.values()].map(s => ({ ...s, name: s.id === "casting-director" ? "casting director" : report.agents.find(a => a.key === s.id)?.name ?? s.id, ...(s.role && { role: scrub(s.role) }), ...(s.reason && { reason: scrub(s.reason) }) }));
    const director = seats.find(s => s.id === "casting-director");
    const usage = new Map(seats.map(s => [s.id, { seatId: s.id, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedTokens: 0, estimated: false }]));
    const emitUsage = async () => {
      const perSeat = [...usage.values()].map(total => ({ ...total }));
      await emit({ type: "usage", perSeat, totalCostUsd: perSeat.reduce((n, s) => n + s.costUsd, 0), totalUnpricedTokens: perSeat.reduce((n, s) => n + s.unpricedTokens, 0) });
    };
    const failures = new Map<string, string>();
    const auditions: Record<string, string> = Object.create(null), answers: Record<string, string> = Object.create(null);
    async function turn(seat: Seat, round: string, system: string, prompt: string): Promise<string | undefined> {
      if (stopped()) return;
      const scope = { session: id, kind: "casting", agent: seat.id };
      const callStop = AbortSignal.any([stop, AbortSignal.timeout(Math.ceil(opts.turnTimeoutMs ?? 90_000))]);
      try {
        const result = await cancellable(metered(scope, () => {
          const ledger = activeUsageSink();
          return withUsageSink(r => {
            const line = lineFor(scope, r, "casting"), total = usage.get(seat.id)!;
            const input = (line.tokens?.input ?? 0) + (line.tokens?.cache_read ?? 0) + (line.tokens?.cache_write ?? 0), output = line.tokens?.output ?? 0;
            const usd = r.usd ?? line.usd;
            total.inputTokens += input; total.outputTokens += output; total.costUsd += usd ?? 0;
            if (usd === undefined) total.unpricedTokens += input + output;
            if (line.tokens_prov === "estimated" || line.usd_prov === "estimated") total.estimated = true;
            ledger?.(r);
          }, () => withAbortSignal(callStop, () => withSeatConnectors(connectors, () => callSeat(system, [{ role: "user", content: prompt }], {
            provider: seat.provider, model: seat.model, maxTokens: Math.min(turnTokens(seat.provider, round), seat.maxOutputTokens ?? Infinity), estimateUsageOnFailure: true,
          }, { agent: seat.id, onModelFallback: model => { seat.model = model; } }))));
        }), callStop);
        const words = round === "audition" ? 120 : round === "answer" ? 80 : undefined;
        const safe = scrub(result);
        const text = scrubAndCap(words ? safe.split(/\s+/).filter(Boolean).slice(0, words).join(" ") : safe, round === "verdict" ? 64_000 : round === "questions" ? 24_000 : 4000);
        await emit({ type: "turn", round, seat: { ...seat }, text, ts: new Date().toISOString() });
        await emitUsage();
        return text;
      } catch (error) {
        const reason = scrubAndCap(error instanceof Error ? error.message : String(error), 300);
        if (seat.id !== "casting-director") failures.set(seat.id, reason || "This turn did not complete.");
        await emit({ type: "turn", round, seat: { ...seat }, text: `This turn did not complete (${reason}).`, ts: new Date().toISOString() });
        await emitUsage();
        return;
      }
    }
    async function direct<T>(round: string, prompt: string, parse: (text: string) => T): Promise<T | undefined> {
      if (!director) return;
      let feedback = "";
      for (let attempt = 0; attempt < 2 && !stopped(); attempt++) {
        const text = await turn(director, round, DIRECTOR_SYSTEM, prompt + feedback);
        try { if (text === undefined) throw new Error("No director response."); return parse(text); }
        catch (error) { feedback = `\nPrevious response failed validation: ${scrubAndCap(error instanceof Error ? error.message : String(error), 300)} Return corrected JSON only.`; }
      }
      return;
    }
    await emit({ type: "start", id, topic: report.brief, mode: "casting", seats, startedAt: createdAt });
    // Each connector call and notice appears as a short note, never as the tool's payload.
    connectors?.onNote(use => {
      const seat = seats.find(s => s.id === use.seat) ?? seats[0];
      void emit({ type: "turn", round: "tool", seat: { ...seat }, text: use.note, ts: new Date().toISOString() });
    });
    if (!opts.dryRun) {
      await mapLimit(agents, PARALLEL_TURNS, async agent => {
        const text = await turn(seats.find(s => s.id === agent.key)!, "audition", agent.body, auditionPrompt(report.brief));
        if (text !== undefined) auditions[agent.key] = text;
      });
      let questionsFailed = false, staticVerdict = true;
      if (opts.examine !== false && !stopped() && Object.keys(auditions).length) {
        const questions = await direct("questions", questionsPrompt(report.brief, auditions), text => parseQuestions(text, Object.keys(auditions)));
        if (!questions) questionsFailed = true;
        else await mapLimit(agents.filter(a => auditions[a.key] !== undefined), PARALLEL_TURNS, async agent => {
          const text = await turn(seats.find(s => s.id === agent.key)!, "answer", agent.body, answerPrompt(report.brief, auditions[agent.key], questions[agent.key]));
          if (text !== undefined) answers[agent.key] = text;
        });
      }
      if (!questionsFailed && !stopped()) {
        const verdict = await direct("verdict", verdictPrompt(report.brief, count, { agents: report.agents, similarity: report.redundancy, auditions, answers, failures: Object.fromEntries(failures) }), text => parseCastingVerdict(text, report, count));
        if (verdict) { report = verdict; staticVerdict = false; }
      }
      for (const agent of report.agents) {
        if (!auditions[agent.key] && !failures.has(agent.key)) failures.set(agent.key, stopped() ? "Casting stopped before this audition completed." : "No audition completed.");
        if (failures.has(agent.key)) { agent.verdict = "unclear"; agent.risks.push(failures.get(agent.key)!); }
      }
      if (staticVerdict) {
        report.note = `Director ${questionsFailed ? "questions" : "verdict"} unavailable; static roster from lint and similarity only; gaps not assessed.`;
        const eligible = report.agents.filter(a => a.verdict === "cast" || a.verdict === "bench");
        report.recommended = { seats: eligible.slice(0, count).map(a => a.key) };
        for (const agent of eligible) agent.verdict = report.recommended.seats.includes(agent.key) ? "cast" : "bench";
      } else for (const field of ["seats", "teamA", "teamB", "judges"] as const) {
        if (report.recommended[field]) report.recommended[field] = report.recommended[field]!.filter(key => !failures.has(key));
      }
    }
    const unpricedTokens = [...usage.values()].reduce((n, s) => n + s.unpricedTokens, 0);
    report.usage = { totalCostUsd: [...usage.values()].reduce((n, s) => n + s.costUsd, 0), ...(unpricedTokens > 0 && { unpricedTokens }),
      ...((unpricedTokens > 0 || [...usage.values()].some(s => s.estimated)) && { estimated: true }) };
    await emitUsage();
    if (!opts.dryRun && stopped()) report.note = "Stopped before completion; roster is partial.";
    await emit({ type: "roster", report });
    const archivePath = join(ROUNDTABLE_HOME, "casting", `${id}.json`);
    await emit({ type: "end", mode: "casting", winner: "none", tally: { A: 0, B: 0 }, aborted: !opts.dryRun && stopped(), archivePath: `casting/${id}.json` });
    mkdirPrivate(join(ROUNDTABLE_HOME, "casting"));
    // Report fields at the top level let the library read latest.json directly.
    const archive = JSON.stringify({ ...report, version: 1, events });
    writeFileAtomic(archivePath, archive);
    writeFileAtomic(join(ROUNDTABLE_HOME, "casting", "latest.json"), archive);
    return report;
  } finally { clearTimeout(timer); unregisterDuel(id); await connectors?.close(); }
}
