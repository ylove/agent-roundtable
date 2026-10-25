import { checkPage, pageCheckRecord, pageCheckSummary, type PageCheck } from "../prototypes/page-check.js";
import { ChromeProcesses, findChrome } from "../prototypes/browser.js";
import { startRoom } from "./room.js";
import { prepareSeats, resolveSeats } from "./seats.js";
import { PROVIDER_MAX_TOKENS } from "../providers/limits.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { agentKey, listAgents, loadAgent, readFrontmatter } from "../agents.js";
import { PARALLEL_TURNS, ROUNDTABLE_HOME } from "../config.js";
import { callSeat } from "./dispatch.js";
import { activeUsageSink, withAbortSignal, withUsageSink } from "../providers/usage.js";
import { parsePrototypeBlock, type PrototypeFile } from "../prototypes/parse.js";
import { createSessionDir, ensurePrototypeRoot, materializeFiles, releaseSessionDir, removeDirSync, sweepStaleSessionDirs } from "../prototypes/sandbox.js";
import { scrub, scrubAndCap, scrubArtifact } from "../security/secrets.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { parseDissentBlocks } from "../sessions/dissents.js";
import { mapLimit } from "../sessions/workshop.js";
import { registerDuel, unregisterDuel } from "./live-duels.js";
import { abortSession, lineFor, metered, sessionSignal } from "../usage/session-scope.js";
import type { DuelKind, DuelOptions, DuelResult, RunDuel, Seat, TableEvent, TableObserver } from "./events.js";
import { validateDuelOptions } from "./duel-options.js";
import { buildPrompt, closingPrompt, conceptPrompt, critiquePrompt, DEFAULT_CRITERIA, DUEL_MAX_BYTES, duelSystem, judgePrompt, normalizeCriteria } from "./prompts.js";
import { attachPrototypeFiles, getPrototypeFiles, attachPrototypeScreenshot, getPrototypeScreenshot, type DuelArchive } from "./replay.js";

export interface ResolvedDuelSeat extends Seat { prompt?: string }
export interface DuelDependencies {
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

function validatedFiles(text: string, kind: DuelKind = "web"): { title: string; files: PrototypeFile[] } {
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

type DuelRunner = (opts: DuelOptions, obs: TableObserver, signal: AbortSignal, deps?: DuelDependencies) => Promise<DuelResult>;
export const runDuel: RunDuel & DuelRunner = async (opts: DuelOptions, obs: TableObserver, signal: AbortSignal, deps: DuelDependencies = {}) => {
  validateDuelOptions(opts);
  const kind: DuelKind = opts.kind ?? "web";
  // Every extra critique turn needs time, so the default deadline grows with the larger team.
  const limitSeconds = opts.maxSeconds ?? Math.min(3600, 600 + 120 * Math.max(0, Math.max(opts.teamA.length, opts.teamB.length) - 2));
  const nonce = randomBytes(6).toString("hex");
  const criteria = normalizeCriteria(opts.criteria);
  if ((opts.rounds !== undefined && opts.rounds !== 1 && opts.rounds !== 2) ||
      !Number.isFinite(limitSeconds) || limitSeconds < 0 || limitSeconds > 3600 ||
      !Number.isFinite(opts.turnTimeoutMs ?? 90_000) || (opts.turnTimeoutMs ?? 90_000) <= 0 || (opts.turnTimeoutMs ?? 90_000) > 3_600_000) throw new Error("Invalid duel limits.");
  const resolved = deps.resolveSeats ? await deps.resolveSeats(opts) : await resolveSeatsLocal(opts, await prepareSeats(opts));
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
  const stop = () => abortSession(id, "Duel stopped.");
  const sessionStop = sessionSignal(id);
  registerDuel({ id, agents: [...new Set(seats.map(s => agentKey(s.id.replace(/^(?:A|B|judge):/, ""))))], started: new Date().toISOString() });
  const cancelled = () => signal.aborted || sessionStop.aborted;
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const phase = new AbortController();
  const deadline = setTimeout(() => phase.abort(new Error("Duel deadline reached.")), limitSeconds * 1000);
  if (opts.maxSeconds === 0) phase.abort();
  const ended = Date.now() + limitSeconds * 1000;
  const expired = () => phase.signal.aborted || Date.now() >= ended;
  const submissions: Partial<Record<"A" | "B", { title: string; files: PrototypeFile[] }>> = {};
  const concepts = { A: "", B: "" };
  const critiques = { A: "", B: "" };
  const assessments: Extract<TableEvent, { type: "assessment" }>[] = [];
  const preferences = { A: 0, B: 0 };
  let sandbox: string | undefined;
  let version = 0;
  const teamVersions = { A: 0, B: 0 };
  const checks: Partial<Record<"A" | "B", PageCheck>> = {};
  const chrome = new ChromeProcesses();
  const killBrowsers = () => chrome.killAll();
  for (const stop of [signal, sessionStop, phase.signal]) stop.addEventListener("abort", killBrowsers, { once: true });
  let internalFailure = false;
  const publicSeat = (seat: Seat): Seat => seats.find(s => s.id === seat.id)!;

  async function turn(seat: ResolvedDuelSeat, round: string, prompt: string, closing = false, show: (text: string) => string = text => text): Promise<string | undefined> {
    if (cancelled() || (!closing && expired())) return;
    // The ledger attributes spend to the persona, not the team-prefixed seat id.
    const scope = { session: id, kind: "duel", agent: seat.id.replace(/^(?:A|B|judge):/, "") };
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
        }, () => withAbortSignal(callStop, () => callSeat(
          `${duelSystem(kind)}\n\n${seat.prompt ?? `Your role is ${seat.role ?? seat.name}.`}`,
          [{ role: "user", content: prompt }],
          { provider: seat.provider, model: seat.model, maxTokens: Math.min(tokens, seat.maxOutputTokens ?? Infinity), estimateUsageOnFailure: true },
          { agent: seat.id.replace(/^(?:A|B|judge):/, ""), onModelFallback: model => {
            seat.model = model;
            const shown = seats.find(s => s.id === seat.id);
            if (shown) shown.model = model;
          } },
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
    let feedback = revision ? `R3 REVISION. Previous source:\n${submissions[team] ? listing(submissions[team].files, nonce) : "No valid artifact."}\nJudges' feedback:\n${assessments.filter(a => a.team === team).map(a => `${a.verdict}: ${a.reason}`).join("\n")}` : "";
    let error = "No valid artifact. None was submitted before the deadline.";
    for (let attempt = 0; attempt < 2 && !cancelled() && !expired(); attempt++) {
      const text = await turn(seat, revision ? "R3" : "R1b", buildPrompt(opts.topic, team, concepts[team] + critiques[team], feedback, kind), false, source => {
        // Source code belongs in prototype files, not in the transcript.
        try {
          const { files } = validatedFiles(source, kind);
          return `Built ${files.length === 1 ? files[0].path : `${files.length} files`} (${(files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) / 1024).toFixed(1)} KB).`;
        }
        catch (e) { return `Build failed: ${scrubAndCap(e instanceof Error ? e.message : "invalid prototype", 100)}`; }
      });
      if (text === undefined && (cancelled() || expired())) break;
      try {
        const prototype = validatedFiles(text ?? "", kind);
        if (!sandbox) throw new Error("Prototype sandbox unavailable.");
        const dir = join(sandbox, `submission-${++version}`);
        await mkdir(dir, { mode: 0o700 });
        prototype.files = await materializeFiles(dir, prototype.files.map(f => ({ ...f, content: scrubArtifact(f.content) })), { redactContent: false });
        submissions[team] = prototype;
        const event: TableEvent = { type: "prototype", team, version: ++teamVersions[team], seat: publicSeat(seat), title: prototype.title, kind, ok: true,
          files: prototype.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content) })) };
        attachPrototypeFiles(event, prototype.files);
        if (kind === "web") {
          let check: import("../prototypes/page-check.js").PageCheckResult | undefined;
          if (opts.pageCheck === false) event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "disabled" };
          else if (deps.checkPage || findChrome()) {
            let room: Awaited<ReturnType<typeof startRoom>> | undefined;
            try {
              room = await (deps.startRoom ?? startRoom)({ hold: false });
              await room.observer.onEvent(event);
              check = await (deps.checkPage ?? checkPage)(`${room.url}p/${team}/index.html`, { processes: chrome });
              event.check = pageCheckRecord(check);
              attachPrototypeScreenshot(event, check.screenshot);
            } catch { event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "page check unavailable" }; }
            finally { await room?.close(); }
          } else event.check = { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "no browser" };
          checks[team] = event.check;
        }
        archive.prototypes.push({ eventIndex: archive.events.length, team, files: prototype.files });
        await emit(event);
        const check = event.check;
        if (check && check.reason !== "no browser" && check.reason !== "disabled" && check.reason !== "page check unavailable" && (!check.loaded || check.exceptions.length)) {
          error = pageCheckSummary(check);
          feedback = `The previous attempt failed validation: ${error}\nReturn a complete corrected prototype.`;
          continue;
        }
        return;
      } catch (e) {
        error = e instanceof ValidationError ? e.message : "No valid artifact. It could not be saved.";
        feedback = `The previous attempt failed validation: ${error}\nReturn a complete corrected prototype.`;
      }
    }
    // A failed revision keeps the previous valid submission available.
    if (!submissions[team]) await emit({ type: "prototype", team, seat: publicSeat(seat), kind, ok: false, files: [], error });
  }

  await emit({ type: "start", id, topic: opts.topic, mode: "duel", seats, startedAt: new Date().toISOString(), kind,
    criteria: criteria.length ? criteria : [...DEFAULT_CRITERIA], teams: { A: teams.A.map(s => s.id), B: teams.B.map(s => s.id) } });
  try {
    if (!cancelled() && !expired()) {
      const root = await ensurePrototypeRoot();
      await sweepStaleSessionDirs(root);
      sandbox = await createSessionDir(root, id);
      keepSandboxUntilExit(sandbox);
      await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, async team => {
        concepts[team] = (await turn(teams[team][0], "R1", conceptPrompt(opts.topic, team, kind)))?.split(/\s+/).slice(0, 150).join(" ") ?? "";
        // Members between the first and the last critique the concept; the builder receives every critique.
        const critics = teams[team].slice(1, -1);
        if (concepts[team] && critics.length) {
          const notes = await mapLimit(critics, PARALLEL_TURNS, async critic => {
            const note = (await turn(critic, "R1c", critiquePrompt(opts.topic, team, concepts[team], kind)))?.split(/\s+/).slice(0, 100).join(" ");
            return note ? `- ${critic.name}: ${note}` : "";
          });
          const kept = notes.filter(Boolean);
          if (kept.length) critiques[team] = `\nCritiques of the concept from teammates:\n${kept.join("\n")}\n`;
        }
      });
      await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, team => build(team));
    }
    // Every failed team gets a placeholder, even if the deadline arrived before construction.
    for (const team of ["A", "B"] as const) if (!submissions[team] && !archive.events.some(e => e.type === "prototype" && e.team === team)) {
      await emit({ type: "prototype", team, seat: publicSeat(teams[team].at(-1)!), ok: false, files: [], kind, error: cancelled() ? "Duel stopped." : "No valid artifact before the deadline." });
    }
    await mapLimit(judges, PARALLEL_TURNS, async judge => {
      const source = (team: "A" | "B") => submissions[team] ? `Version v${teamVersions[team]}\n${kind === "web" ? pageCheckSummary(checks[team]) + "\n" : ""}${listing(submissions[team].files, nonce)}` : "No valid submission. Automatic REJECT.";
      const judging = { kind, criteria, nonce };
      let text = await turn(judge, "R2", judgePrompt(opts.topic, { A: source("A"), B: source("B") }, judging));
      let verdicts = text === undefined ? undefined : parseDuelVerdicts(text);
      if (text !== undefined && verdicts!.A.verdict === "UNCLEAR" && verdicts!.B.verdict === "UNCLEAR") {
        // One retry when the reply was readable text but no verdict line could be recognized.
        text = await turn(judge, "R2", judgePrompt(opts.topic, { A: source("A"), B: source("B") }, judging) + "\nYour previous reply had no recognizable VERDICT lines. Follow the format exactly.") ?? text;
        verdicts = parseDuelVerdicts(text);
      }
      const preference = text === undefined ? undefined : parsePreference(text);
      if (preference) preferences[preference]++;
      for (const team of ["A", "B"] as const) {
        if (!verdicts && submissions[team]) continue; // A failed judge casts no verdict.
        const assessment: Extract<TableEvent, { type: "assessment" }> = { type: "assessment", judge: publicSeat(judge), team, ...(teamVersions[team] && { version: teamVersions[team] }),
          ...(submissions[team] ? verdicts![team] : { verdict: "REJECT", reason: "No valid artifact." }) };
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
    // With nothing built there is nothing to close on.
    if (!cancelled() && (submissions.A || submissions.B)) await mapLimit(["A", "B"] as ("A" | "B")[], PARALLEL_TURNS, async team => {
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
    chrome.killAll();
    for (const stop of [signal, sessionStop, phase.signal]) stop.removeEventListener("abort", killBrowsers);
    signal.removeEventListener("abort", stop);
    unregisterDuel(id);
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
