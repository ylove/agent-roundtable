import { checkPage, pageCheckFailed, pageCheckRecord, pageCheckSummary, pageChecksOff, type PageCheck } from "../prototypes/page-check.js";
import { ChromeProcesses, findChrome } from "../prototypes/browser.js";
import { startRoom } from "./room.js";
import { prepareSeats, resolveSeats } from "./seats.js";
import { PROVIDER_MAX_TOKENS } from "../providers/limits.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { agentKey, listAgents, loadAgent, readFrontmatter } from "../agents.js";
import { PARALLEL_TURNS, ROUNDTABLE_HOME } from "../config.js";
import { callSeat } from "./dispatch.js";
import { activeUsageSink, withAbortSignal, withUsageSink, type UsageSink } from "../providers/usage.js";
import { parsePrototypeBlock, type PrototypeFile } from "../prototypes/parse.js";
import { createSessionDir, ensurePrototypeRoot, materializeFiles, releaseSessionDir, removeDirSync, sweepStaleSessionDirs } from "../prototypes/sandbox.js";
import { scrub, scrubAndCap, scrubArtifact } from "../security/secrets.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { parseDissentBlocks } from "../sessions/dissents.js";
import { mapLimit } from "../sessions/workshop.js";
import { registerDuel, unregisterDuel } from "./live-duels.js";
import { abortSession, lineFor, metered, sessionSignal, resetSessionSignal } from "../usage/session-scope.js";
import type { DuelKind, DuelOptions, DuelResult, RunDuel, Seat, TableEvent, TableObserver, TeamMetrics, DuelControls, DuelCommandSource } from "./events.js";
import { validateDuelOptions } from "./duel-options.js";
import { activeSeatConnectors, checkSeatConnectorArgs, startSeatConnectors, withSeatConnectors } from "./seat-connectors.js";
import { stageBuildPrompt, stagePlan, type BuildStage, closingPrompt, conceptPrompt, critiquePrompt, DEFAULT_CRITERIA, DUEL_MAX_BYTES, duelSystem, judgePrompt, normalizeCriteria } from "./prompts.js";
import { createDuelControls, duelControlRunner } from "./controls.js";
import { readCheckpoint, writeCheckpoint, checkpointPath, type DuelCheckpoint, type DuelProgress, type DuelUsage } from "./checkpoint.js";
import { saveChosenArtifact } from "./artifacts.js";
import { attachPrototypeFiles, getPrototypeFiles, attachPrototypeScreenshot, getPrototypeScreenshot, type DuelArchive } from "./replay.js";

export interface ResolvedDuelSeat extends Seat { prompt?: string }
export interface DuelDependencies {
  controls?: DuelControls;
  replayHistory?: boolean;
  resumeBy?: DuelCommandSource;
  checkPage?: typeof checkPage;
  startRoom?: typeof startRoom;
  resolveSeats?: (opts: DuelOptions) => Promise<ResolvedDuelSeat[]> | ResolvedDuelSeat[];
}

const ownedSandboxes = new Set<string>();
let cleanupRegistered = false;
function keepSandboxUntilExit(dir: string): void {
  ownedSandboxes.add(dir);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const owned of ownedSandboxes) { removeDirSync(owned); releaseSessionDir(owned); }
  });
}

/** Merge seam: the CLI's full resolver can replace this local default without changing RunDuel. */
export async function resolveSeatsLocal(opts: DuelOptions, selected?: Map<string, Seat>): Promise<ResolvedDuelSeat[]> {
  const assignments = selected ?? await resolveSeats({ teamA: opts.teamA, teamB: opts.teamB, judges: opts.judges, seats: opts.seats, mix: opts.mix, agentsDir: opts.agentsDir });
  const chosen = new Map([...assignments].map(([id, seat]) => [agentKey(id), seat]));
  const groups = [["A", opts.teamA], ["B", opts.teamB], ["judge", opts.judges]] as const;
  const found = opts.agentsDir ? listAgents(opts.agentsDir) : undefined;
  const seats: ResolvedDuelSeat[] = [];
  for (const [team, refs] of groups) {
    for (const [index, ref] of refs.entries()) {
      let body: string;
      let name = agentKey(ref);
      if (found) {
        const file = found.find(a => a.key === agentKey(ref));
        if (!file) throw new Error(`Agent prompt not found for "${name}".`);
        const root = await realpath(resolve(opts.agentsDir!));
        const target = await realpath(file.path);
        const rel = relative(root, target);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Agent is outside the agents directory.");
        const loaded = readFrontmatter(await readFile(target, "utf8"));
        body = loaded.body;
        if (typeof loaded.data.name === "string") name = loaded.data.name;
      } else {
        const loaded = await loadAgent(ref);
        body = loaded.body;
        if (typeof loaded.frontmatter.name === "string") name = loaded.frontmatter.name;
      }
      const pick = chosen.get(agentKey(ref))!;
      seats.push({ id: `${team}:${agentKey(ref)}`, name, team,
        role: team === "judge" ? "judge" : refs.length === 1 ? "designer and builder" : index === 0 ? "designer" : index === refs.length - 1 ? "builder" : "critic",
        provider: pick.provider, model: pick.model, reason: pick.reason, maxOutputTokens: pick.maxOutputTokens, prompt: body });
    }
  }
  return seats;
}

class ValidationError extends Error {}
export { MAX_JUDGES, MAX_TEAM_SIZE, validateDuelOptions } from "./duel-options.js";
const WEB_EXTERNAL = /\b(?:src|href|action|poster|formaction)\s*=\s*["']?\s*(?:https?:|\/\/)|\burl\s*\(\s*["']?\s*(?:https?:|\/\/)|@import\b|<\s*(?:iframe|object|embed|link|base)\b|<script\b[^>]*\bsrc\s*=/i;
const WEB_CALLS = /\b(?:fetch|importScripts|WebSocket|EventSource|Worker|SharedWorker|XMLHttpRequest|sendBeacon)\s*\(|\bnew\s+(?:WebSocket|EventSource|Worker|SharedWorker|XMLHttpRequest)\b|\bimport\s*(?:\(|["'{*])/;

export function validatedFiles(text: string, kind: DuelKind = "web"): { title: string; files: PrototypeFile[] } {
  const parsed = parsePrototypeBlock(text);
  if (!parsed.found) throw new ValidationError("Missing prototype block.");
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const { prototype } = parsed;
  if (prototype.kind !== kind) throw new ValidationError(`Return a prototype of kind="${kind}".`);
  const total = prototype.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (kind === "web") {
    if (prototype.files.length !== 1 || prototype.files[0].path !== "index.html" ||
        (prototype.entry !== undefined && prototype.entry !== "index.html")) throw new ValidationError("Return only one web file named index.html.");
  }
  if (total > DUEL_MAX_BYTES) throw new ValidationError(`The artifact exceeds ${DUEL_MAX_BYTES / 1024} KB; make it smaller.`);
  if (kind === "web") {
    const html = prototype.files[0].content;
    // JavaScript is optional; whatever script is present must stay inline and offline.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
    // Namespace identifiers are not network references.
    const markup = html.replace(/https?:\/\/www\.w3\.org\/(?:2000\/svg|1998\/Math\/MathML|1999\/xhtml|1999\/xlink)/gi, "");
    if (WEB_EXTERNAL.test(markup) || scripts.some(m => WEB_CALLS.test(m[2]))) {
      throw new ValidationError("Use inline code only, without external URLs, imports, or embedded pages.");
    }
  }
  return { title: prototype.title, files: prototype.files };
}

/** Judges read every file, labelled by path. */
const listing = (files: PrototypeFile[], nonce: string): string => files.map(f => `<<<FILE ${nonce} ${f.path}>>>\n${f.content}\n<<<END FILE ${nonce}>>>`).join("\n");

/** Map the CLI's or a tool's resolved seats onto the persona-loading resolver. */
export function withChosenSeats(seats: Map<string, Seat>): DuelDependencies {
  return { resolveSeats: async o => {
    const loaded = await resolveSeatsLocal(o, seats);
    const chosen = new Map([...seats].map(([id, seat]) => [agentKey(id), seat]));
    return loaded.map(seat => {
      const pick = chosen.get(seat.id.slice(seat.id.indexOf(":") + 1));
      return pick ? { ...seat, provider: pick.provider, model: pick.model, reason: pick.reason, maxOutputTokens: pick.maxOutputTokens } : seat;
    });
  } };
}

type Verdicts = Record<"A" | "B", { verdict: "APPROVE" | "REVISE" | "REJECT" | "UNCLEAR"; reason: string }>;

/** Only unambiguous, complete, unquoted verdict lines count. */
export function parseDuelVerdicts(text: string): Verdicts {
  const result: Verdicts = { A: { verdict: "UNCLEAR", reason: "No clear verdict." }, B: { verdict: "UNCLEAR", reason: "No clear verdict." } };
  let fenced = false;
  const matches: Record<"A" | "B", RegExpMatchArray[]> = { A: [], B: [] };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = raw.replace(/[*_]/g, "").replace(/^[\s>-]+/, "");
    const m = /^VERDICT\s+([AB])\s*[:\-—–]?\s*(APPROVE|REVISE|REJECT)\b[\s:—–-]*(.*)$/i.exec(line);
    if (m) matches[m[1].toUpperCase() as "A" | "B"].push(m);
  }
  for (const team of ["A", "B"] as const) if (matches[team].length === 1) {
    const m = matches[team][0];
    result[team] = { verdict: m[2].toUpperCase() as "APPROVE" | "REVISE" | "REJECT", reason: m[3].trim() || "No reason given." };
  }
  return result;
}

/** A judge's optional tie-break preference: the last unquoted PREFER line. */
export function parsePreference(text: string): "A" | "B" | undefined {
  let fenced = false, found: "A" | "B" | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^PREFER\s*:?\s*([AB])\b/i.exec(raw.replace(/[*_]/g, "").replace(/^[\s>-]+/, ""));
    if (m) found = m[1].toUpperCase() as "A" | "B";
  }
  return found;
}

const NO_TEXT_LENGTH = /returned no text \(finish reason: (length|max_tokens)\)/;
/** Reasoning tokens count against max_tokens, so the ceilings are generous; prompts still ask for short answers. */
const TURN_TOKENS = 8192;
const BUILD_TOKENS = 32_768;
/** Providers whose models cap output below the shared ceiling (Replicate rejects larger max_tokens with a 422). */
const clampTokens = (provider: Seat["provider"], tokens: number): number => Math.min(tokens, Object.hasOwn(PROVIDER_MAX_TOKENS, provider) ? PROVIDER_MAX_TOKENS[provider] ?? Infinity : Infinity);
export const turnTokens = (provider: Seat["provider"], round: string): number => clampTokens(provider, round === "R1b" || round === "R3" ? BUILD_TOKENS : TURN_TOKENS);

/** A short, secret-free cause for a failed provider call. */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || /timed? ?out|timeout/i.test(message)) return "timed out";
  if (/credit|quota|billing|\b402\b/i.test(message)) return "out of credit";
  if (/\b429\b|rate.?limit/i.test(message)) return "rate limited";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api key|authentication/i.test(message)) return "provider auth failed";
  if (/\b404\b|not found|no such model|unknown model/i.test(message)) return "model not found";
  return `provider error: ${scrubAndCap(message.replace(/\s+/g, " "), 100)}`;
}

/** All team progress lives here so an interrupted pipeline can later be checkpointed. */
export interface TeamProgress {
  concept: string;
  conceptDone: boolean;
  critiques: string;
  completedCritics: string[];
  criticNotes: Record<string, string>;
  stages: { index: number; status: "started" | "done" | "failed" | "skipped" }[];
  stageReached: number;
  submission?: { title: string; files: PrototypeFile[] };
  version: number;
  judgedVersion: number;
  check?: PageCheck;
  feedback: string;
  startedAt?: number;
  metrics: TeamMetrics;
}

function teamProgress(stagesTotal: number): TeamProgress {
  return { concept: "", conceptDone: false, critiques: "", completedCritics: [], criticNotes: Object.create(null), stages: [], stageReached: 0,
    version: 0, judgedVersion: 0, feedback: "", metrics: {
      elapsedMs: 0, stagesDone: 0, stagesTotal, inputTokens: 0, outputTokens: 0, costUsd: 0,
      unpricedTokens: 0, turns: 0, failedTurns: 0, versions: 0, rewrites: 0,
      validationFailures: 0, pageErrors: 0, toolCalls: 0,
    } };
}

/** Include every reported problem, not just the first exception in the short UI summary. */
function checkFeedback(check?: PageCheck): string {
  return check ? [pageCheckSummary(check), ...check.consoleErrors, ...check.exceptions].join("\n") : "";
}

export type DuelInput = (Omit<DuelOptions, "judges"> & { judges?: string[] }) | { resume: string };
type DuelRunner = (opts: DuelInput, obs: TableObserver, signal: AbortSignal, deps?: DuelDependencies) => Promise<DuelResult>;
/** Start the requested seat connectors (an unknown one fails here, before any provider call) and close them when the duel ends. */
export const runDuel: RunDuel & DuelRunner = async (input: DuelInput, obs: TableObserver, signal: AbortSignal, deps: DuelDependencies = {}) => {
  let restored: DuelCheckpoint | undefined;
  if (input.resume !== undefined) {
    if (Object.keys(input).some(k => k !== "resume")) throw new Error("Resume takes only a duel id; options come from the checkpoint.");
    restored = readCheckpoint(input.resume);
  }
  const opts: DuelOptions = restored?.options ?? { ...input, judges: ("judges" in input ? input.judges : undefined) ?? [] } as DuelOptions;
  validateDuelOptions(opts);
  if (opts.humanJudge && !deps.controls) throw new Error("humanJudge requires duel controls from createDuelControls().");
  if (!opts.connectors?.length) return runDuelBody(opts, obs, signal, deps, restored);
  const checked = checkSeatConnectorArgs(opts.connectors, opts.seatConnectors, [...opts.teamA, ...opts.teamB, ...opts.judges]);
  const connectors = await startSeatConnectors(checked.names, { signal, seatConnectors: checked.seatConnectors });
  try { return await withSeatConnectors(connectors, () => runDuelBody(opts, obs, signal, deps, restored)); }
  finally { await connectors.close(); }
};

async function runDuelBody(opts: DuelOptions, obs: TableObserver, signal: AbortSignal, deps: DuelDependencies, restored?: DuelCheckpoint): Promise<DuelResult> {
  validateDuelOptions(opts);
  const kind: DuelKind = opts.kind ?? "web";
  const plan = stagePlan(kind, opts.stages ?? (kind === "web" ? 4 : 1));
  // Every extra critique turn needs time, so the default deadline grows with the larger team.
  const limitSeconds = opts.maxSeconds ?? Math.min(3600, 600 + 150 * (plan.length - 1) + 120 * Math.max(0, Math.max(opts.teamA.length, opts.teamB.length) - 2));
  const nonce = restored?.nonce ?? randomBytes(6).toString("hex");
  const criteria = normalizeCriteria(opts.criteria);
  if ((opts.rounds !== undefined && opts.rounds !== 1 && opts.rounds !== 2) ||
      !Number.isFinite(limitSeconds) || limitSeconds < 0 || limitSeconds > 3600 ||
      !Number.isFinite(opts.turnTimeoutMs ?? 90_000) || (opts.turnTimeoutMs ?? 90_000) <= 0 || (opts.turnTimeoutMs ?? 90_000) > 3_600_000) throw new Error("Invalid duel limits.");
  const loaded = deps.resolveSeats ? await deps.resolveSeats(opts) : await resolveSeatsLocal(opts, restored ?
    new Map(restored.seats.map(s => [s.id.replace(/^(?:A|B|judge):/, ""), s])) : await prepareSeats(opts));
  const resolved = restored ? restored.seats.map(saved => {
    const persona = loaded.find(s => s.id === saved.id);
    if (!persona) throw new Error("Checkpoint seats no longer match the loaded personas.");
    return { ...saved, prompt: persona.prompt };
  }) : loaded;
  const seats: Seat[] = resolved.map(({ prompt: _prompt, ...seat }) => seat);
  const teams = { A: resolved.filter(s => s.team === "A"), B: resolved.filter(s => s.team === "B") };
  const judges = resolved.filter(s => s.team === "judge");
  if (!teams.A.length || !teams.B.length || (!opts.humanJudge && !judges.length) || new Set(seats.map(s => s.id)).size !== seats.length) throw new Error("Resolved seats must include distinct seats for both teams and judges.");
  const id = restored?.id ?? `duel-${randomUUID()}`;
  const archive: DuelArchive = restored?.archive ?? { version: 2, events: [], prototypes: [] };
  const archivePath = join(ROUNDTABLE_HOME, "duels", `${id}.json`);
  const usage = new Map<string, DuelUsage>(seats.map(s => [s.id, { seatId: s.id, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedTokens: 0, estimated: false }]));
  for (const total of restored?.usage ?? []) usage.set(total.seatId, { ...total });
  const control = duelControlRunner(deps.controls ?? createDuelControls());
  let stopBy: DuelCommandSource = "tool";
  let acceptingUsage = true;
  const abandoners = new Set<() => void>();
  const localStop = new AbortController();
  const stopped = AbortSignal.any([signal, localStop.signal]);
  const emit = async (raw: TableEvent) => {
    // Persisted and displayed content is scrubbed at the source.
    const event: TableEvent = raw.type === "turn" || raw.type === "dissent" ? { ...raw, text: scrub(raw.text) }
      : raw.type === "start" ? { ...raw, topic: scrub(raw.topic), ...(raw.criteria && { criteria: raw.criteria.map(c => scrub(c)) }) }
      : raw.type === "prototype" && raw.title ? { ...raw, title: scrub(raw.title), ...(raw.error && { error: scrub(raw.error) }) }
      : raw.type === "assessment" ? { ...raw, reason: scrub(raw.reason) }
      : raw.type === "prototype" && raw.error ? { ...raw, error: scrub(raw.error) }
      : raw.type === "end" && raw.archivePath ? { ...raw, archivePath: `duels/${id}.json` } : raw;
    // Scrubbing builds a new object, which must keep the attached file bytes.
    if (event !== raw && raw.type === "prototype") {
      attachPrototypeFiles(event, getPrototypeFiles(raw));
      attachPrototypeScreenshot(event, getPrototypeScreenshot(raw));
    }
    archive.events.push(event);
    try { await obs.onEvent(event); } catch { /* An observer cannot interrupt archival. */ }
  };
  const emitUsage = () => {
    const perSeat = [...usage.values()].map(total => ({ ...total }));
    return emit({ type: "usage", perSeat, totalCostUsd: perSeat.reduce((n, seat) => n + seat.costUsd, 0),
      totalUnpricedTokens: perSeat.reduce((n, seat) => n + seat.unpricedTokens, 0) });
  };
  if (restored) resetSessionSignal(id);
  const sessionStop = sessionSignal(id);
  const stop = () => { abortSession(id, "Duel stopped."); };
  control.clear();
  control.onStop(by => { stopBy = by; localStop.abort(new Error("Duel stopped.")); stop(); });
  control.setAvailable({ stop: true });
  registerDuel({ id, agents: [...new Set(seats.map(s => agentKey(s.id.replace(/^(?:A|B|judge):/, ""))))], started: new Date().toISOString() });
  const cancelled = () => stopped.aborted || sessionStop.aborted;
  stopped.addEventListener("abort", stop, { once: true });
  if (stopped.aborted) stop();
  const phase = new AbortController();
  const remainingMs = restored ? Math.max(60_000, limitSeconds * 1000 - restored.activeMs) : limitSeconds * 1000;
  const deadline = setTimeout(() => phase.abort(new Error("Duel deadline reached.")), remainingMs);
  if (!restored && opts.maxSeconds === 0) phase.abort();
  const ended = Date.now() + remainingMs;
  const runStarted = Date.now();
  let activeMs = restored?.activeMs ?? 0;
  let clockRunning = true;
  let deadlineReached = false;
  const freezeClock = () => { if (clockRunning) { deadlineReached = phase.signal.aborted || Date.now() >= ended; activeMs += Math.max(0, Date.now() - runStarted); clockRunning = false; } };
  const expired = () => phase.signal.aborted || (clockRunning ? Date.now() >= ended : deadlineReached);
  const state: DuelProgress = restored?.progress ?? { phase: "build", teams: { A: teamProgress(plan.length), B: teamProgress(plan.length) },
    assessments: [], preferences: { A: 0, B: 0 }, completedJudges: [], judgeReplies: Object.create(null), completedRevisions: [], completedClosings: [] };
  const progress = state.teams, assessments = state.assessments, preferences = state.preferences;
  if (restored) for (const team of ["A", "B"] as const) {
    const t = progress[team];
    if (t.startedAt !== undefined) t.startedAt = Date.now() - t.metrics.elapsedMs;
  }
  if (state.phase === "decide" || state.phase === "close") { clearTimeout(deadline); freezeClock(); }
  let sandbox: string | undefined;
  let version = archive.prototypes.length + 10;
  const metricsSnapshot = (): Record<"A" | "B", TeamMetrics> => {
    for (const team of ["A", "B"] as const) {
      const state = progress[team], m = state.metrics;
      if (state.startedAt !== undefined && !m.finishedAt) m.elapsedMs = Math.max(0, Date.now() - state.startedAt);
      const totals = teams[team].map(seat => usage.get(seat.id)!);
      for (const key of ["inputTokens", "outputTokens", "costUsd", "unpricedTokens"] as const) m[key] = totals.reduce((n, total) => n + total[key], 0);
      if (totals.some(total => total.estimated)) m.estimated = true;
    }
    return { A: { ...progress.A.metrics }, B: { ...progress.B.metrics } };
  };
  const emitMetrics = () => emit({ type: "metrics", teams: metricsSnapshot(), ts: new Date().toISOString() });
  const finishTeam = async (team: "A" | "B") => {
    const state = progress[team];
    if (state.startedAt !== undefined) state.metrics.elapsedMs = Math.max(0, Date.now() - state.startedAt);
    state.metrics.finishedAt = new Date().toISOString();
    await emitMetrics();
  };
  const chrome = new ChromeProcesses();
  const killBrowsers = () => chrome.killAll();
  for (const stop of [stopped, sessionStop, phase.signal]) stop.addEventListener("abort", killBrowsers, { once: true });
  let internalFailure = false;
  const publicSeat = (seat: Seat): Seat => seats.find(s => s.id === seat.id)!;
  // Each connector call and notice appears in the transcript as a short note, never as the tool's payload.
  activeSeatConnectors()?.onNote(use => {
    if (!acceptingUsage) return;
    const seat = resolved.find(s => s.id.replace(/^(?:A|B|judge):/, "") === use.seat) ?? resolved[0];
    if (use.tool && (seat.team === "A" || seat.team === "B")) progress[seat.team].metrics.toolCalls++;
    void emit({ type: "turn", seat: publicSeat(seat), round: "tool", text: use.note, ts: new Date().toISOString() });
    if (use.tool) void emitMetrics();
  });

  async function turn(seat: ResolvedDuelSeat, round: string, prompt: string, closing = false, show: (text: string) => string = text => text): Promise<string | undefined> {
    if (cancelled() || (!closing && expired())) return;
    const state = seat.team === "A" || seat.team === "B" ? progress[seat.team] : undefined;
    if (state && state.startedAt === undefined) state.startedAt = Date.now();
    // The ledger attributes spend to the persona, not the team-prefixed seat id.
    const scope = { session: id, kind: "duel", agent: seat.id.replace(/^(?:A|B|judge):/, "") };
    const callStop = AbortSignal.any([stopped, sessionStop, AbortSignal.timeout(round === "R1b" || round === "R3" ? Math.max(opts.turnTimeoutMs ?? 90_000, 240_000) : opts.turnTimeoutMs ?? 90_000), ...(!closing ? [phase.signal] : [])]);
    try {
      const build = round === "R1b" || round === "R3";
      const call = (tokens: number) => metered(scope, () => {
        const ledger = activeUsageSink();
        let reports = 0, finalized = false;
        const record: UsageSink = report => {
          if (finalized) return;
          reports++;
          if (!acceptingUsage) { ledger?.(report); return; }
          const line = lineFor(scope, report, "duel");
          const total = usage.get(seat.id)!;
          const input = (line.tokens?.input ?? 0) + (line.tokens?.cache_read ?? 0) + (line.tokens?.cache_write ?? 0);
          const output = line.tokens?.output ?? 0;
          const usd = report.usd ?? line.usd;
          total.inputTokens += input;
          total.outputTokens += output;
          total.costUsd += usd ?? 0;
          // A model with no known price keeps its tokens visible rather than counting as $0.00.
          if (usd === undefined) total.unpricedTokens += input + output;
          if (line.tokens_prov === "estimated") total.estimated = true;
          ledger?.(report);
        };
        const abandon = () => {
          if (!reports) record({ provider: seat.provider, model: seat.model, chars: { input: duelSystem(kind).length + (seat.prompt?.length ?? 0) + prompt.length, output: 0 } });
          finalized = true;
        };
        abandoners.add(abandon);
        return withUsageSink(record, () => withAbortSignal(callStop, () => callSeat(
          `${duelSystem(kind)}\n\n${seat.prompt ?? `Your role is ${seat.role ?? seat.name}.`}`,
          [{ role: "user", content: prompt }],
          { provider: seat.provider, model: seat.model, maxTokens: Math.min(tokens, seat.maxOutputTokens ?? Infinity), estimateUsageOnFailure: true },
          { agent: seat.id.replace(/^(?:A|B|judge):/, ""), onModelFallback: model => {
            seat.model = model;
            const shown = seats.find(s => s.id === seat.id);
            if (shown) shown.model = model;
          } },
        ))).finally(() => abandoners.delete(abandon));
      });
      // A deadline also settles a misbehaving provider stub that ignores its AbortSignal.
      const attempt = async (tokens: number): Promise<string> => {
        if (state) state.metrics.turns++;
        try { return await cancellable(call(tokens), callStop); }
        catch (error) { if (state) state.metrics.failedTurns++; throw error; }
      };
      const text = await attempt(turnTokens(seat.provider, round)).catch(async e => {
        // Reasoning models can spend the whole ceiling thinking: retry a non-build turn once at double.
        if (build || !NO_TEXT_LENGTH.test(e instanceof Error ? e.message : "")) throw e;
        const larger = clampTokens(seat.provider, turnTokens(seat.provider, round) * 2);
        if (larger <= turnTokens(seat.provider, round)) throw e;
        return attempt(larger);
      });
      await emit({ type: "turn", seat: publicSeat(seat), round, text: show(text), ts: new Date().toISOString() });
      await emitUsage();
      return text;
    } catch (e) {
      if (!cancelled() && (closing || !expired())) {
        await emit({ type: "turn", seat: publicSeat(seat), round, text: `This turn did not complete (${failureReason(e)}).`, ts: new Date().toISOString() });
        await emitUsage();
      }
      return undefined;
    } finally { if (state) await emitMetrics(); }
  }

  async function build(team: "A" | "B", stage: BuildStage, revision = false): Promise<boolean> {
    const state = progress[team];
    const seat = teams[team].at(-1)!;
    if (revision) {
      state.metrics.rewrites++;
      delete state.metrics.finishedAt;
    }
    let feedback = [state.feedback, checkFeedback(state.check), revision ? `R3 REVISION. Previous source:\n${state.submission ? listing(state.submission.files, nonce) : "No valid artifact."}\nJudges' feedback:\n${assessments.filter(a => a.team === team).map(a => `${a.verdict}: ${a.reason}`).join("\n")}` : ""].filter(Boolean).join("\n");
    let error = "No valid artifact. None was submitted before the deadline.";
    for (let attempt = 0; attempt < 2 && !cancelled() && !expired(); attempt++) {
      if (attempt > 0) { state.metrics.rewrites++; await emitMetrics(); }
      const prompt = stageBuildPrompt(opts.topic, team, state.concept + state.critiques, feedback, kind, stage, plan.length,
        state.submission ? listing(state.submission.files, nonce) : "", nonce);
      const text = await turn(seat, revision ? "R3" : "R1b", prompt, false, source => {
        // Source code belongs in prototype files, not in the transcript.
        try {
          const { files } = validatedFiles(source, kind);
          return `Built ${files.length === 1 ? files[0].path : `${files.length} files`} (${(files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) / 1024).toFixed(1)} KB).`;
        }
        catch (e) { return `Build failed: ${scrubAndCap(e instanceof Error ? e.message : "invalid prototype", 100)}`; }
      });
      if (text === undefined && (cancelled() || expired())) break;
      try {
        // A failed provider turn is counted separately from artifact validation failures.
        if (text === undefined) { error = "The build turn did not complete."; throw new Error(error); }
        const prototype = validatedFiles(text, kind);
        if (!sandbox) throw new Error("Prototype sandbox unavailable.");
        const dir = join(sandbox, `submission-${++version}`);
        await mkdir(dir, { mode: 0o700 });
        prototype.files = await materializeFiles(dir, prototype.files.map(f => ({ ...f, content: scrubArtifact(f.content) })), { redactContent: false });
        const event: Extract<TableEvent, { type: "prototype" }> = { type: "prototype", team, version: state.version + 1, seat: publicSeat(seat), title: prototype.title, kind, ok: true,
          ...(!revision && { stage: stage.index }), files: prototype.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) })) };
        attachPrototypeFiles(event, prototype.files);
        if (kind === "web") {
          if (opts.pageCheck === false || (!deps.checkPage && pageChecksOff())) event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "disabled" };
          else if (deps.checkPage || findChrome()) {
            let room: Awaited<ReturnType<typeof startRoom>> | undefined;
            try {
              room = await (deps.startRoom ?? startRoom)({ hold: false });
              await room.observer.onEvent(event);
              const check = await cancellable((deps.checkPage ?? checkPage)(`${room.url}p/${team}/index.html`, { processes: chrome }), AbortSignal.any([stopped, sessionStop, phase.signal]));
              event.check = pageCheckRecord(check);
              attachPrototypeScreenshot(event, check.screenshot);
            } catch { event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "page check unavailable" }; }
            finally { await room?.close(); }
          } else event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "no browser" };
          state.metrics.pageErrors += (event.check?.consoleErrors.length ?? 0) + (event.check?.exceptions.length ?? 0);
        }
        if (cancelled() || expired()) { await emitMetrics(); break; }
        const failed = pageCheckFailed(event.check);
        // Preserve single-build archives' checked attempts; staged rooms receive only valid versions.
        if (!failed || plan.length === 1) {
          event.version = ++state.version;
          archive.prototypes.push({ eventIndex: archive.events.length, team, files: prototype.files });
          if (!failed) {
            state.submission = prototype;
            state.check = event.check;
            state.judgedVersion = state.version;
            state.metrics.versions++;
          }
          await emit(event);
          await emitMetrics();
        }
        if (failed) {
          error = checkFeedback(event.check);
          feedback = [feedback, `The previous attempt failed its page check: ${error}\nFix these; return a complete corrected prototype.`].filter(Boolean).join("\n");
          await emitMetrics();
          continue;
        }
        state.feedback = "";
        return true;
      } catch (e) {
        if (e instanceof ValidationError) state.metrics.validationFailures++;
        error = e instanceof ValidationError ? e.message : text === undefined ? "The build turn did not complete." : "No valid artifact. It could not be saved.";
        feedback = [feedback, `The previous attempt failed validation: ${error}\nReturn a complete corrected prototype.`].filter(Boolean).join("\n");
        await emitMetrics();
      }
    }
    state.feedback = scrub(feedback || error);
    if (plan.length === 1 && !state.submission) await emit({ type: "prototype", team, seat: publicSeat(seat), kind, ok: false, files: [], error });
    return false;
  }

  async function runStages(team: "A" | "B"): Promise<void> {
    const state = progress[team];
    for (const stage of plan) {
      const prior = state.stages.find(s => s.index === stage.index);
      if (prior && prior.status !== "started") continue;
      if (cancelled()) break;
      if (prior) state.stages.splice(state.stages.indexOf(prior), 1);
      if (expired()) {
        state.stages.push({ index: stage.index, status: "skipped" });
        await emit({ type: "stage", team, stage: stage.index, of: plan.length, name: stage.name, status: "skipped", ts: new Date().toISOString() });
        await emitMetrics();
        continue;
      }
      state.stageReached = stage.index;
      const step: TeamProgress["stages"][number] = { index: stage.index, status: "started" };
      state.stages.push(step);
      await emit({ type: "stage", team, stage: stage.index, of: plan.length, name: stage.name, status: "started", ts: new Date().toISOString() });
      await emitMetrics();
      const ok = await build(team, stage);
      if (cancelled() && !ok) break;
      step.status = ok ? "done" : "failed";
      if (ok) state.metrics.stagesDone++;
      await emit({ type: "stage", team, stage: stage.index, of: plan.length, name: stage.name, status: step.status,
        ...(ok && { version: state.judgedVersion }), ts: new Date().toISOString() });
      await emitMetrics();
    }
    if (!cancelled()) await finishTeam(team);
  }

  const processRecord = () => {
    const metrics = metricsSnapshot();
    return (["A", "B"] as const).map(team => {
      const m = metrics[team];
      return `Team ${team}: stages done ${m.stagesDone} of ${m.stagesTotal}${expired() ? `; stopped at stage ${progress[team].stageReached} of ${m.stagesTotal}` : ""}; elapsed ${m.elapsedMs} ms; tokens ${m.inputTokens} input + ${m.outputTokens} output; cost $${m.costUsd.toFixed(6)}; unpriced tokens ${m.unpricedTokens}${m.estimated ? " (estimated)" : ""}; versions ${m.versions}; rewrites ${m.rewrites}; validation failures ${m.validationFailures}; page errors ${m.pageErrors}; tool calls ${m.toolCalls}; turns ${m.turns}; failed turns ${m.failedTurns}.`;
    }).join("\n");
  };

  const startEvent = (): Extract<TableEvent, { type: "start" }> => ({ type: "start", id, topic: opts.topic, mode: "duel", seats,
    startedAt: new Date().toISOString(), kind, criteria: criteria.length ? criteria : [...DEFAULT_CRITERIA],
    teams: { A: teams.A.map(s => s.id), B: teams.B.map(s => s.id) }, stages: plan.map(({ index, name }) => ({ index, name })),
    ...(opts.humanJudge && { humanJudge: true }), ...(restored && { resumed: true }) });
  const tally = (): { A: number; B: number } => {
    const tally = { A: 0, B: 0 };
    for (const a of assessments) tally[a.team] += a.verdict === "APPROVE" ? 1 : a.verdict === "REJECT" ? -1 : 0;
    return tally;
  };
  const judgeWinner = (): DuelResult["winner"] => {
    const t = tally();
    const count = (team: "A" | "B", verdict: string) => assessments.filter(a => a.team === team && a.verdict === verdict).length;
    const order = t.A - t.B || count("B", "REJECT") - count("A", "REJECT") || count("B", "REVISE") - count("A", "REVISE") || preferences.A - preferences.B;
    return (!progress.A.submission && !progress.B.submission) || !assessments.some(a => a.verdict !== "UNCLEAR") ? "none" : order === 0 ? "tie" : order > 0 ? "A" : "B";
  };
  async function checkpoint(): Promise<DuelResult> {
    clearTimeout(deadline);
    freezeClock();
    // Providers normally report failure usage on abort. A non-cooperating call is abandoned and estimated.
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const abandon of abandoners) abandon();
    await emitMetrics();
    await emitUsage();
    // Freeze the picture before observers can react to the stopped event.
    acceptingUsage = false;
    await emit({ type: "control", action: "stopped", by: stopBy, ts: new Date().toISOString() });
    const options: DuelOptions = { topic: scrub(opts.topic), teamA: opts.teamA, teamB: opts.teamB, judges: opts.judges,
      kind, criteria: criteria.map(c => scrub(c)), stages: plan.length, rounds: opts.rounds ?? 1,
      maxSeconds: limitSeconds, turnTimeoutMs: opts.turnTimeoutMs ?? 90_000,
      ...(opts.humanJudge !== undefined && { humanJudge: opts.humanJudge }), ...(opts.pageCheck !== undefined && { pageCheck: opts.pageCheck }),
      ...(opts.agentsDir && { agentsDir: opts.agentsDir }), ...(opts.connectors && { connectors: opts.connectors }),
      ...(opts.seatConnectors && { seatConnectors: opts.seatConnectors }) };
    writeCheckpoint({ version: 1, id, nonce, options, seats, archive, progress: state, usage: [...usage.values()], activeMs });
    control.clear();
    control.setAvailable({ resume: true });
    return { id, winner: "none", tally: tally(), aborted: true, resumable: true, metrics: metricsSnapshot() };
  }
  try {
    if (restored) {
      for (const p of archive.prototypes) {
        // Revalidate source using the same offline artifact rules as a new build.
        const e = archive.events[p.eventIndex] as Extract<TableEvent, { type: "prototype" }>;
        validatedFiles(`<prototype kind="${e.kind ?? "web"}" title="saved">${p.files.map(f => `<file path="${f.path}">${f.content}</file>`).join("\n")}</prototype>`, e.kind ?? "web");
        attachPrototypeFiles(e, p.files);
      }
      if (deps.replayHistory !== false) for (const e of archive.events) { try { await obs.onEvent(e); } catch { /* observer */ } }
    }
    await emit(startEvent());
    if (restored) await emit({ type: "control", action: "resumed", by: deps.resumeBy ?? "tool", ts: new Date().toISOString() });
    try {
      if (state.phase === "build") {
        if (!cancelled() && !expired()) {
          const root = await ensurePrototypeRoot();
          await sweepStaleSessionDirs(root);
          sandbox = await createSessionDir(root, id);
          keepSandboxUntilExit(sandbox);
        }
        await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, async team => {
          const t = progress[team];
          if (!t.conceptDone) {
            const text = await turn(teams[team][0], "R1", conceptPrompt(opts.topic, team, kind));
            if (text !== undefined || !cancelled()) { t.concept = scrub(text?.split(/\s+/).slice(0, 150).join(" ") ?? ""); t.conceptDone = true; }
          }
          const critics = teams[team].slice(1, -1);
          if (t.concept) await mapLimit(critics.filter(c => !t.completedCritics.includes(c.id)), PARALLEL_TURNS, async critic => {
            const text = await turn(critic, "R1c", critiquePrompt(opts.topic, team, t.concept, kind));
            if (text !== undefined || !cancelled()) {
              t.completedCritics.push(critic.id);
              t.criticNotes[critic.id] = scrub(text?.split(/\s+/).slice(0, 100).join(" ") ?? "");
            }
          });
          const notes = critics.flatMap(c => t.criticNotes[c.id] ? [`- ${c.name}: ${t.criticNotes[c.id]}`] : []);
          t.critiques = notes.length ? `\nCritiques of the concept from teammates:\n${notes.join("\n")}\n` : "";
          await runStages(team);
        });
        if (!cancelled()) {
          for (const team of ["A", "B"] as const) if (!progress[team].submission && !archive.events.some(e => e.type === "prototype" && e.team === team)) {
            await emit({ type: "prototype", team, seat: publicSeat(teams[team].at(-1)!), ok: false, files: [], kind, error: "No valid artifact before the deadline." });
          }
          state.phase = "judge";
        }
      }
      if (state.phase === "judge" && !cancelled()) {
        await mapLimit(judges.filter(j => !state.completedJudges.includes(j.id)), PARALLEL_TURNS, async judge => {
          const source = (team: "A" | "B") => progress[team].submission ? `Version v${progress[team].judgedVersion}\n${kind === "web" ? pageCheckSummary(progress[team].check) + "\n" : ""}${listing(progress[team].submission.files, nonce)}` : "No valid submission. Automatic REJECT.";
          const prompt = judgePrompt(opts.topic, { A: source("A"), B: source("B") }, { kind, criteria, nonce, processRecord: processRecord() });
          let reply = state.judgeReplies[judge.id];
          if (!reply && (progress.A.submission || progress.B.submission)) {
            const text = await turn(judge, "R2", prompt, true);
            if (text !== undefined) reply = state.judgeReplies[judge.id] = { text: scrub(text), attempts: 1 };
            else if (cancelled()) return;
          }
          let verdicts = reply ? parseDuelVerdicts(reply.text) : undefined;
          if (reply && reply.attempts < 2 && verdicts!.A.verdict === "UNCLEAR" && verdicts!.B.verdict === "UNCLEAR") {
            if (cancelled()) return;
            const text = await turn(judge, "R2", prompt + "\nYour previous reply had no recognizable VERDICT lines. Follow the format exactly.", true);
            if (text === undefined && cancelled()) return;
            reply = state.judgeReplies[judge.id] = { text: scrub(text ?? reply.text), attempts: 2 };
            verdicts = parseDuelVerdicts(reply.text);
          }
          const preference = reply && parsePreference(reply.text);
          if (preference) preferences[preference]++;
          for (const team of ["A", "B"] as const) {
            if (!verdicts && progress[team].submission) continue;
            const assessment: Extract<TableEvent, { type: "assessment" }> = { type: "assessment", judge: publicSeat(judge), team,
              ...(progress[team].judgedVersion && { version: progress[team].judgedVersion }),
              ...(progress[team].submission ? { ...verdicts![team], reason: scrub(verdicts![team].reason) } : { verdict: "REJECT", reason: "No valid artifact." }) };
            assessments.push(assessment); await emit(assessment);
          }
          state.completedJudges.push(judge.id);
        });
        if (!cancelled()) state.phase = "revise";
      }
      if (state.phase === "revise" && !cancelled()) {
        if (opts.rounds === 2 && !expired()) {
          if (!sandbox) { const root = await ensurePrototypeRoot(); sandbox = await createSessionDir(root, id); keepSandboxUntilExit(sandbox); }
          await mapLimit((["A", "B"] as const).filter(team => !state.completedRevisions.includes(team) && assessments.some(a => a.team === team && (a.verdict === "REVISE" || a.verdict === "REJECT"))), PARALLEL_TURNS, async team => {
            const ok = await build(team, plan.at(-1)!, true);
            if (ok || !cancelled()) { state.completedRevisions.push(team); await finishTeam(team); }
          });
        }
        if (!cancelled()) state.phase = opts.humanJudge ? "decide" : "close";
      }
      if (state.phase === "decide" && !cancelled()) {
        clearTimeout(deadline); freezeClock();
        if (!state.decision) {
          control.setAvailable({ stop: true, choose: (["A", "B"] as const).filter(t => !!progress[t].submission) });
          await emit({ type: "decision", status: "awaiting", ts: new Date().toISOString() });
          const message = await control.wait(AbortSignal.any([stopped, sessionStop]));
          if (message.command.action === "choose") {
            state.decision = message.command.team;
            await emit({ type: "decision", status: "made", by: "human", winner: state.decision, version: progress[state.decision].judgedVersion, ts: new Date().toISOString() });
          }
        }
        if (!cancelled()) state.phase = "close";
      }
    } catch (error) {
      if (!cancelled()) internalFailure = true;
    }
    if (cancelled()) return await checkpoint();
    clearTimeout(deadline); freezeClock();
    const winner = internalFailure ? "none" : state.decision ?? judgeWinner();
    const decidedBy = opts.humanJudge ? "human" as const : "judges" as const;
    if (progress.A.submission || progress.B.submission) await mapLimit((["A", "B"] as const).filter(t => !state.completedClosings.includes(t)), PARALLEL_TURNS, async team => {
      const seat = teams[team][0];
      const text = await turn(seat, "R4", closingPrompt(opts.topic, team, `${winner}; A ${tally().A}, B ${tally().B}${expired() ? "; time limit reached" : ""}`, winner !== "tie" && winner !== "none" && winner !== team), true);
      if (text !== undefined || !cancelled()) {
        for (const dissent of parseDissentBlocks(text ?? "")) await emit({ type: "dissent", seat: publicSeat(seat), team, text: `${dissent.claim}\nPredicted failure: ${dissent.predicted_failure}` });
        state.completedClosings.push(team);
      }
    });
    if (cancelled()) return await checkpoint();
    const chosen = (winner === "A" || winner === "B") && progress[winner].submission
      ? saveChosenArtifact(id, winner, progress[winner].judgedVersion, progress[winner].submission!.files) : undefined;
    await emitMetrics(); await emitUsage();
    const result: DuelResult = { id, winner, tally: tally(), aborted: internalFailure, archivePath, decidedBy, metrics: metricsSnapshot(), ...(chosen && { chosen }) };
    await emit({ type: "end", winner, tally: result.tally, aborted: result.aborted, archivePath, decidedBy, metrics: result.metrics, ...(chosen && { chosen }) });
    mkdirPrivate(join(ROUNDTABLE_HOME, "duels")); writeFileAtomic(archivePath, JSON.stringify(archive));
    await rm(checkpointPath(id), { force: true });
    control.clear(); control.setAvailable({});
    return result;
  } finally {
    clearTimeout(deadline);
    acceptingUsage = false;
    control.onStop(undefined);
    chrome.killAll();
    activeSeatConnectors()?.onNote(undefined);
    for (const stop of [stopped, sessionStop, phase.signal]) stop.removeEventListener("abort", killBrowsers);
    stopped.removeEventListener("abort", stop);
    unregisterDuel(id);
    if (sandbox) { removeDirSync(sandbox); releaseSessionDir(sandbox); ownedSandboxes.delete(sandbox); }
  }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
