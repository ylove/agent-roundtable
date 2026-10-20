import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { agentKey, listAgents, loadAgent, readFrontmatter } from "../agents.js";
import { DEFAULT_MODELS, PARALLEL_TURNS, ROUNDTABLE_HOME } from "../config.js";
import { callLLM } from "../providers/index.js";
import { activeUsageSink, withAbortSignal, withUsageSink } from "../providers/usage.js";
import { parsePrototypeBlock, type PrototypeFile } from "../prototypes/parse.js";
import { createSessionDir, ensurePrototypeRoot, materializeFiles, releaseSessionDir, removeDirSync, sweepStaleSessionDirs } from "../prototypes/sandbox.js";
import { scrub, scrubAndCap } from "../security/secrets.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { parseDissentBlocks } from "../sessions/dissents.js";
import { mapLimit } from "../sessions/workshop.js";
import { abortSession, lineFor, metered, sessionSignal } from "../usage/session-scope.js";
import type { DuelOptions, DuelResult, RunDuel, Seat, TableEvent, TableObserver } from "./events.js";
import { buildPrompt, closingPrompt, conceptPrompt, DUEL_SYSTEM, judgePrompt } from "./prompts.js";
import { attachPrototypeFiles, type DuelArchive } from "./replay.js";

export interface ResolvedDuelSeat extends Seat { prompt?: string }
export interface DuelDependencies {
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
export async function resolveSeatsLocal(opts: DuelOptions): Promise<ResolvedDuelSeat[]> {
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
      const override = opts.seats?.[ref] ?? opts.seats?.[agentKey(ref)];
      const provider = override?.provider ?? "anthropic";
      seats.push({ id: `${team}:${agentKey(ref)}`, name, team,
        role: team === "judge" ? "judge" : index === 0 ? "designer" : "builder",
        provider, model: override?.model ?? DEFAULT_MODELS[provider], prompt: body });
    }
  }
  return seats;
}

class ValidationError extends Error {}
function validatedFiles(text: string): { title: string; files: PrototypeFile[] } {
  const parsed = parsePrototypeBlock(text);
  if (!parsed.found) throw new ValidationError("Missing prototype block.");
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const { prototype } = parsed;
  if (prototype.kind !== "web" || prototype.files.length !== 1 || prototype.files[0].path !== "index.html" ||
      (prototype.entry !== undefined && prototype.entry !== "index.html")) throw new ValidationError("Return only one web file named index.html.");
  const html = prototype.files[0].content;
  if (Buffer.byteLength(html) > 40 * 1024) throw new ValidationError("index.html exceeds 40 KB.");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
  if (!scripts.some(m => m[2].trim())) throw new ValidationError("index.html needs inline playable JavaScript in a script element.");
  // Namespace identifiers are not network references.
  const markup = html.replace(/https?:\/\/www\.w3\.org\/(?:2000\/svg|1998\/Math\/MathML|1999\/xhtml|1999\/xlink)/gi, "");
  const external = /\b(?:src|href|action|poster|formaction)\s*=\s*["']?\s*(?:https?:|\/\/)|\burl\s*\(\s*["']?\s*(?:https?:|\/\/)|@import\b|<\s*(?:iframe|object|embed|link|base)\b|<script\b[^>]*\bsrc\s*=/i;
  const calls = /\b(?:fetch|importScripts|WebSocket|EventSource|Worker|SharedWorker|XMLHttpRequest|sendBeacon)\s*\(|\bnew\s+(?:WebSocket|EventSource|Worker|SharedWorker|XMLHttpRequest)\b|\bimport\s*(?:\(|["'{*])/;
  if (external.test(markup) || scripts.some(m => calls.test(m[2]))) {
    throw new ValidationError("Use inline code only, without external URLs, imports, or embedded pages.");
  }
  return { title: prototype.title, files: prototype.files };
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
const PROVIDER_MAX_TOKENS: Partial<Record<Seat["provider"], number>> = {
  anthropic: 32_000, openai: 32_768, replicate: 16_384, together: 16_384, openai_compatible: 16_384, ollama: 8192,
};
const clampTokens = (provider: Seat["provider"], tokens: number): number => Math.min(tokens, PROVIDER_MAX_TOKENS[provider] ?? Infinity);
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

type DuelRunner = (opts: DuelOptions, obs: TableObserver, signal: AbortSignal, deps?: DuelDependencies) => Promise<DuelResult>;
export const runDuel: RunDuel & DuelRunner = async (opts: DuelOptions, obs: TableObserver, signal: AbortSignal, deps: DuelDependencies = {}) => {
  if (!opts.topic?.trim() || !opts.teamA.length || !opts.teamB.length || !opts.judges.length) throw new Error("A duel needs a topic, two teams, and judges.");
  if ((opts.rounds !== undefined && opts.rounds !== 1 && opts.rounds !== 2) ||
      !Number.isFinite(opts.maxSeconds ?? 600) || (opts.maxSeconds ?? 600) < 0 || (opts.maxSeconds ?? 600) > 3600 ||
      !Number.isFinite(opts.turnTimeoutMs ?? 90_000) || (opts.turnTimeoutMs ?? 90_000) <= 0 || (opts.turnTimeoutMs ?? 90_000) > 3_600_000) throw new Error("Invalid duel limits.");
  const resolved = await (deps.resolveSeats ?? resolveSeatsLocal)(opts);
  const seats: Seat[] = resolved.map(({ prompt: _prompt, ...seat }) => seat);
  const teams = { A: resolved.filter(s => s.team === "A"), B: resolved.filter(s => s.team === "B") };
  const judges = resolved.filter(s => s.team === "judge");
  if (!teams.A.length || !teams.B.length || !judges.length || new Set(seats.map(s => s.id)).size !== seats.length) throw new Error("Resolved seats must include distinct seats for both teams and judges.");
  const id = `duel-${randomUUID()}`;
  const archive: DuelArchive = { version: 1, events: [], prototypes: [] };
  const archivePath = join(ROUNDTABLE_HOME, "duels", `${id}.json`);
  const usage = new Map(seats.map(s => [s.id, { seatId: s.id, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedTokens: 0, estimated: false }]));
  const emit = async (raw: TableEvent) => {
    // Persisted and displayed content is scrubbed at the source.
    const event: TableEvent = raw.type === "turn" || raw.type === "dissent" ? { ...raw, text: scrub(raw.text) }
      : raw.type === "assessment" ? { ...raw, reason: scrub(raw.reason) }
      : raw.type === "prototype" && raw.error ? { ...raw, error: scrub(raw.error) }
      : raw.type === "end" && raw.archivePath ? { ...raw, archivePath: `duels/${id}.json` } : raw;
    archive.events.push(event);
    try { await obs.onEvent(event); } catch { /* An observer cannot interrupt archival. */ }
  };
  const emitUsage = () => {
    const perSeat = [...usage.values()].map(total => ({ ...total }));
    return emit({ type: "usage", perSeat, totalCostUsd: perSeat.reduce((n, seat) => n + seat.costUsd, 0),
      totalUnpricedTokens: perSeat.reduce((n, seat) => n + seat.unpricedTokens, 0) });
  };
  const stop = () => abortSession(id, "Duel stopped.");
  const sessionStop = sessionSignal(id);
  const cancelled = () => signal.aborted || sessionStop.aborted;
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const phase = new AbortController();
  const deadline = setTimeout(() => phase.abort(new Error("Duel deadline reached.")), (opts.maxSeconds ?? 600) * 1000);
  if (opts.maxSeconds === 0) phase.abort();
  const ended = Date.now() + (opts.maxSeconds ?? 600) * 1000;
  const expired = () => phase.signal.aborted || Date.now() >= ended;
  const submissions: Partial<Record<"A" | "B", { title: string; files: PrototypeFile[] }>> = {};
  const concepts = { A: "", B: "" };
  const assessments: Extract<TableEvent, { type: "assessment" }>[] = [];
  const preferences = { A: 0, B: 0 };
  let sandbox: string | undefined;
  let version = 0;
  let internalFailure = false;
  const publicSeat = (seat: Seat): Seat => seats.find(s => s.id === seat.id)!;

  async function turn(seat: ResolvedDuelSeat, round: string, prompt: string, closing = false, show: (text: string) => string = text => text): Promise<string | undefined> {
    if (cancelled() || (!closing && expired())) return;
    const scope = { session: id, kind: "duel", agent: seat.id };
    const callStop = AbortSignal.any([signal, sessionStop, AbortSignal.timeout(round === "R1b" || round === "R3" ? Math.max(opts.turnTimeoutMs ?? 90_000, 240_000) : opts.turnTimeoutMs ?? 90_000), ...(!closing ? [phase.signal] : [])]);
    try {
      const build = round === "R1b" || round === "R3";
      const call = (tokens: number) => metered(scope, () => {
        const ledger = activeUsageSink();
        return withUsageSink(report => {
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
        }, () => withAbortSignal(callStop, () => callLLM(
          `${DUEL_SYSTEM}\n\n${seat.prompt ?? `Your role is ${seat.role ?? seat.name}.`}`,
          [{ role: "user", content: prompt }],
          { provider: seat.provider, model: seat.model, maxTokens: tokens, estimateUsageOnFailure: true },
        )));
      });
      // A deadline also settles a misbehaving provider stub that ignores its AbortSignal.
      const text = await cancellable(call(turnTokens(seat.provider, round)), callStop).catch(async e => {
        // Reasoning models can spend the whole ceiling thinking: retry a non-build turn once at double.
        if (build || !NO_TEXT_LENGTH.test(e instanceof Error ? e.message : "")) throw e;
        const larger = clampTokens(seat.provider, turnTokens(seat.provider, round) * 2);
        if (larger <= turnTokens(seat.provider, round)) throw e;
        return cancellable(call(larger), callStop);
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
    }
  }

  async function build(team: "A" | "B", revision = false): Promise<void> {
    const seat = teams[team].at(-1)!;
    let feedback = revision ? `R3 REVISION. Previous source:\n${submissions[team]?.files[0].content ?? "No valid game."}\nJudges' feedback:\n${assessments.filter(a => a.team === team).map(a => `${a.verdict}: ${a.reason}`).join("\n")}` : "";
    let error = "No prototype was submitted before the deadline.";
    for (let attempt = 0; attempt < 2 && !cancelled() && !expired(); attempt++) {
      const text = await turn(seat, revision ? "R3" : "R1b", buildPrompt(opts.topic, team, concepts[team], feedback), false, source => {
        // Source code belongs in prototype files, not in the transcript.
        try { return `Built index.html (${(Buffer.byteLength(validatedFiles(source).files[0].content) / 1024).toFixed(1)} KB).`; }
        catch (e) { return `Build failed: ${scrubAndCap(e instanceof Error ? e.message : "invalid prototype", 100)}`; }
      });
      if (text === undefined && (cancelled() || expired())) break;
      try {
        const prototype = validatedFiles(text ?? "");
        if (!sandbox) throw new Error("Prototype sandbox unavailable.");
        const dir = join(sandbox, `submission-${++version}`);
        await mkdir(dir, { mode: 0o700 });
        prototype.files = await materializeFiles(dir, prototype.files.map(f => ({ ...f, content: scrub(f.content) })), { redactContent: false });
        submissions[team] = prototype;
        const event: TableEvent = { type: "prototype", team, seat: publicSeat(seat), title: prototype.title, ok: true,
          files: prototype.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) })) };
        attachPrototypeFiles(event, prototype.files);
        archive.prototypes.push({ eventIndex: archive.events.length, team, files: prototype.files });
        await emit(event);
        return;
      } catch (e) {
        error = e instanceof ValidationError ? e.message : "The prototype could not be saved.";
        feedback = `The previous attempt failed validation: ${error}\nReturn a complete corrected prototype.`;
      }
    }
    // A failed revision keeps the previous playable submission available.
    if (!submissions[team]) await emit({ type: "prototype", team, seat: publicSeat(seat), ok: false, files: [], error });
  }

  await emit({ type: "start", id, topic: opts.topic, mode: "duel", seats, startedAt: new Date().toISOString() });
  try {
    if (!cancelled() && !expired()) {
      const root = await ensurePrototypeRoot();
      await sweepStaleSessionDirs(root);
      sandbox = await createSessionDir(root, id);
      keepSandboxUntilExit(sandbox);
      await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, async team => {
        concepts[team] = (await turn(teams[team][0], "R1", conceptPrompt(opts.topic, team)))?.split(/\s+/).slice(0, 150).join(" ") ?? "";
      });
      await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, team => build(team));
    }
    // Every failed team gets a placeholder, even if the deadline arrived before construction.
    for (const team of ["A", "B"] as const) if (!submissions[team] && !archive.events.some(e => e.type === "prototype" && e.team === team)) {
      await emit({ type: "prototype", team, seat: publicSeat(teams[team].at(-1)!), ok: false, files: [], error: cancelled() ? "Duel stopped." : "No prototype before the deadline." });
    }
    await mapLimit(judges, PARALLEL_TURNS, async judge => {
      const source = (team: "A" | "B") => submissions[team]?.files[0].content ?? "No valid submission. Automatic REJECT.";
      let text = await turn(judge, "R2", judgePrompt(opts.topic, { A: source("A"), B: source("B") }));
      let verdicts = text === undefined ? undefined : parseDuelVerdicts(text);
      if (text !== undefined && verdicts!.A.verdict === "UNCLEAR" && verdicts!.B.verdict === "UNCLEAR") {
        // One retry when the reply was readable text but no verdict line could be recognized.
        text = await turn(judge, "R2", judgePrompt(opts.topic, { A: source("A"), B: source("B") }) + "\nYour previous reply had no recognizable VERDICT lines. Follow the format exactly.") ?? text;
        verdicts = parseDuelVerdicts(text);
      }
      const preference = text === undefined ? undefined : parsePreference(text);
      if (preference) preferences[preference]++;
      for (const team of ["A", "B"] as const) {
        if (!verdicts && submissions[team]) continue; // A failed judge casts no verdict.
        const assessment: Extract<TableEvent, { type: "assessment" }> = { type: "assessment", judge: publicSeat(judge), team,
          ...(submissions[team] ? verdicts![team] : { verdict: "REJECT", reason: "No valid playable prototype." }) };
        assessments.push(assessment);
        await emit(assessment);
      }
    });
    if (opts.rounds === 2 && !cancelled() && !expired()) {
      await mapLimit((["A", "B"] as const).filter(team => assessments.some(a => a.team === team && (a.verdict === "REVISE" || a.verdict === "REJECT"))), PARALLEL_TURNS, team => build(team, true));
    }
  } catch {
    internalFailure = true;
  }
  clearTimeout(deadline);
  const tally = { A: 0, B: 0 };
  const count = (team: "A" | "B", verdict: string) => assessments.filter(a => a.team === team && a.verdict === verdict).length;
  for (const a of assessments) tally[a.team] += a.verdict === "APPROVE" ? 1 : a.verdict === "REJECT" ? -1 : 0;
  const aborted = cancelled() || internalFailure;
  const decided = assessments.some(a => a.verdict !== "UNCLEAR");
  // Ties fall through: fewer REJECTs, fewer REVISEs, then the judges' stated preference.
  const order = (): number => tally.A !== tally.B ? tally.A - tally.B
    : count("B", "REJECT") !== count("A", "REJECT") ? count("B", "REJECT") - count("A", "REJECT")
    : count("B", "REVISE") !== count("A", "REVISE") ? count("B", "REVISE") - count("A", "REVISE")
    : preferences.A - preferences.B;
  const winner: DuelResult["winner"] = aborted || (!submissions.A && !submissions.B) || !decided ? "none" : order() === 0 ? "tie" : order() > 0 ? "A" : "B";
  try {
    if (!cancelled()) await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, async team => {
      const seat = teams[team][0];
      const text = await turn(seat, "R4", closingPrompt(opts.topic, team, `${winner}; A ${tally.A}, B ${tally.B}${expired() ? "; time limit reached" : ""}`, winner !== "tie" && winner !== "none" && winner !== team), true);
      for (const dissent of parseDissentBlocks(text ?? "")) await emit({ type: "dissent", seat: publicSeat(seat), team, text: `${dissent.claim}\nPredicted failure: ${dissent.predicted_failure}` });
    });
    await emitUsage();
    const result: DuelResult = { id, winner: cancelled() ? "none" as const : winner, tally, aborted: aborted || cancelled(), archivePath };
    await emit({ type: "end", winner: result.winner, tally, aborted: result.aborted, archivePath });
    try { mkdirPrivate(join(ROUNDTABLE_HOME, "duels")); writeFileAtomic(archivePath, JSON.stringify(archive)); }
    catch { result.archivePath = undefined; }
    return result;
  } finally {
    signal.removeEventListener("abort", stop);
    if (sandbox) { removeDirSync(sandbox); releaseSessionDir(sandbox); ownedSandboxes.delete(sandbox); }
  }
};

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
