import { open } from "node:fs/promises";
import type { PrototypeFile } from "../prototypes/parse.js";
import { MAX_FILES, MAX_TOTAL_BYTES, PROTOTYPE_KINDS, validatePath } from "../prototypes/parse.js";
import type { DuelResult, Seat, TableEvent, TableObserver, TeamMetrics } from "./events.js";

export interface DuelArchive {
  version: 1 | 2;
  events: TableEvent[];
  /** Contents indexed by submission event, preserving revisions during replay. */
  prototypes: { eventIndex: number; team: "A" | "B"; files: PrototypeFile[] }[];
}

// The shared event contract describes files by name and size. A weak attachment carries
// their bytes to local observers, including through fanout, without dumping source in NDJSON.
const contents = new WeakMap<TableEvent, PrototypeFile[]>();
export function attachPrototypeFiles(event: TableEvent, files: PrototypeFile[]): void {
  contents.set(event, files.map(file => ({ ...file })));
}
export function getPrototypeFiles(event: TableEvent): PrototypeFile[] {
  return (contents.get(event) ?? []).map(file => ({ ...file }));
}

const screenshots = new WeakMap<TableEvent, Buffer>();
export function attachPrototypeScreenshot(event: TableEvent, screenshot?: Buffer): void {
  if (screenshot) screenshots.set(event, screenshot);
}
export function getPrototypeScreenshot(event: TableEvent): Buffer | undefined {
  return screenshots.get(event);
}

const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
/** Archives from before the general duel carry no kind: they were all web. */
const isWeb = (kind: unknown): boolean => kind === undefined || kind === "web";
/** Web, text and diagram artifacts are exactly one file. */
const isSingle = (kind: unknown): boolean => isWeb(kind) || kind === "text" || kind === "diagram";
const team = (value: unknown): boolean => value === "A" || value === "B";
function seat(value: Seat): boolean {
  return !!value && text(value.id) && text(value.name) && text(value.provider) && text(value.model) &&
    (value.role === undefined || text(value.role)) && (value.team === undefined || team(value.team) || value.team === "judge");
}
function validCheck(check: import("../prototypes/page-check.js").PageCheck | undefined): boolean {
  return check === undefined || (!!check && typeof check.loaded === "boolean" && count(check.failedRequests) &&
    [check.consoleErrors, check.exceptions].every(xs => Array.isArray(xs) && xs.length <= 10 && xs.every(x => text(x) && x.length <= 300)) &&
    (check.reason === undefined || (text(check.reason) && check.reason.length <= 300)));
}
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const stageIndex = (value: unknown): value is number => positive(value) && value <= 4;
function validMetrics(value: Record<"A" | "B", TeamMetrics> | undefined): boolean {
  return value === undefined || (!!value && [value.A, value.B].every(m => m &&
    [m.elapsedMs, m.costUsd].every(count) && stageIndex(m.stagesTotal) &&
    [m.stagesDone, m.inputTokens, m.outputTokens, m.unpricedTokens, m.turns, m.failedTurns, m.versions,
      m.rewrites, m.validationFailures, m.pageErrors, m.toolCalls].every(n => count(n) && Number.isInteger(n)) &&
    m.stagesDone <= m.stagesTotal && m.failedTurns <= m.turns &&
    (m.finishedAt === undefined || date(m.finishedAt)) && (m.estimated === undefined || typeof m.estimated === "boolean")));
}
function validChosen(chosen: Extract<TableEvent, { type: "end" }>["chosen"]): boolean {
  return chosen === undefined || (!!chosen && team(chosen.team) && positive(chosen.version) &&
    text(chosen.dir) && !validatePath(chosen.dir) && Array.isArray(chosen.files) && chosen.files.length > 0 &&
    chosen.files.length <= MAX_FILES && chosen.files.every(path => text(path) && !validatePath(path)));
}
function validEvent(event: TableEvent): boolean {
  if (!event) return false;
  switch (event.type) {
    case "stage": return team(event.team) && stageIndex(event.stage) && stageIndex(event.of) && event.stage <= event.of &&
      text(event.name) && ["started", "done", "failed", "skipped"].includes(event.status) && date(event.ts) &&
      (event.version === undefined || positive(event.version));
    case "metrics": return !!event.teams && validMetrics(event.teams) && date(event.ts);
    case "control": return ["stopped", "resumed"].includes(event.action) && ["room", "terminal", "tool", "deadline"].includes(event.by) && date(event.ts);
    case "decision": return date(event.ts) && (event.status === "awaiting" || (event.status === "made" && event.by === "human" && team(event.winner) && (event.version === undefined || positive(event.version))));
    case "start": return (event.stages === undefined || (Array.isArray(event.stages) && event.stages.length >= 1 && event.stages.length <= 4 && event.stages.every((stage, i) => stage && stage.index === i + 1 && text(stage.name)))) &&
      (event.humanJudge === undefined || typeof event.humanJudge === "boolean") && (event.resumed === undefined || typeof event.resumed === "boolean") && (event.kind === undefined || PROTOTYPE_KINDS.includes(event.kind)) &&
      (event.criteria === undefined || (Array.isArray(event.criteria) && event.criteria.every(text))) &&
      (event.teams === undefined || (!!event.teams && Array.isArray(event.teams.A) && Array.isArray(event.teams.B) && [...event.teams.A, ...event.teams.B].every(text))) &&
      text(event.id) && text(event.topic) && event.mode === "duel" && date(event.startedAt) &&
      Array.isArray(event.seats) && event.seats.every(seat);
    case "turn": return seat(event.seat) && text(event.round) && text(event.text) && date(event.ts);
    case "prototype": return (event.stage === undefined || stageIndex(event.stage)) && validCheck(event.check) && (event.version === undefined || (Number.isInteger(event.version) && event.version > 0)) && team(event.team) && seat(event.seat) && typeof event.ok === "boolean" &&
      (event.title === undefined || text(event.title)) && (event.error === undefined || text(event.error)) &&
      (event.kind === undefined || PROTOTYPE_KINDS.includes(event.kind)) &&
      Array.isArray(event.files) && (event.ok ? isSingle(event.kind) ? event.files.length === 1 : event.files.length >= 1 && event.files.length <= MAX_FILES : event.files.length === 0) &&
      event.files.every(file => file && (isWeb(event.kind) ? file.path === "index.html" : !validatePath(file.path)) && count(file.bytes) && file.bytes <= MAX_TOTAL_BYTES);
    case "assessment": return (event.version === undefined || (Number.isInteger(event.version) && event.version > 0)) && seat(event.judge) && team(event.team) &&
      ["APPROVE", "REVISE", "REJECT", "UNCLEAR"].includes(event.verdict) && text(event.reason);
    case "dissent": return seat(event.seat) && text(event.text) && (event.team === undefined || team(event.team));
    case "usage": return count(event.totalCostUsd) && Array.isArray(event.perSeat) && event.perSeat.every(item =>
      item && text(item.seatId) && count(item.inputTokens) && count(item.outputTokens) && count(item.costUsd) &&
      (item.unpricedTokens === undefined || count(item.unpricedTokens)) && (item.estimated === undefined || typeof item.estimated === "boolean"));
    case "end": return validMetrics(event.metrics) && validChosen(event.chosen) &&
      (event.decidedBy === undefined || ["judges", "human"].includes(event.decidedBy)) &&
      (event.resumable === undefined || typeof event.resumable === "boolean") && ["A", "B", "tie", "none"].includes(event.winner) && !!event.tally &&
      Number.isInteger(event.tally.A) && Number.isInteger(event.tally.B) &&
      (event.aborted === undefined || typeof event.aborted === "boolean") && (event.archivePath === undefined || text(event.archivePath));
    default: return false;
  }
}

function validateArchive(value: unknown): DuelArchive {
  const archive = value as DuelArchive;
  if (!archive || (archive.version !== 1 && archive.version !== 2) || !Array.isArray(archive.events) || !Array.isArray(archive.prototypes)) {
    throw new Error("Unsupported duel archive.");
  }
  if (archive.events[0]?.type !== "start" || archive.events.at(-1)?.type !== "end" ||
      archive.events.some(e => !validEvent(e)) ||
      archive.events.slice(1, -1).some(e => e.type === "end" || (e.type === "start" &&
        (archive.version === 1 || e.resumed !== true || e.id !== (archive.events[0] as Extract<TableEvent, { type: "start" }>).id)))) throw new Error("Invalid duel event sequence.");
  const seen = new Set<number>();
  for (const submission of archive.prototypes) {
    if (!submission) throw new Error("Invalid archived prototype.");
    const event = archive.events[submission.eventIndex];
    if (!Number.isInteger(submission.eventIndex) || seen.has(submission.eventIndex) || event?.type !== "prototype" ||
        !event.ok || event.team !== submission.team || !Array.isArray(submission.files) ||
        (isSingle(event.kind) ? submission.files.length !== 1 : submission.files.length < 1 || submission.files.length > MAX_FILES)) {
      throw new Error("Invalid archived prototype.");
    }
    seen.add(submission.eventIndex);
    let total = 0;
    if (new Set(submission.files.map(f => f?.path)).size !== submission.files.length) throw new Error("Invalid archived prototype file.");
    for (const file of submission.files) {
      total += typeof file?.content === "string" ? Buffer.byteLength(file.content) : 0;
      if (!file || typeof file.path !== "string" || validatePath(file.path) || (isWeb(event.kind) && file.path !== "index.html") ||
          typeof file.content !== "string" || total > MAX_TOTAL_BYTES || (isWeb(event.kind) && total > 40 * 1024) ||
          !Array.isArray(event.files) || !event.files.some(f => f.path === file.path && f.bytes === Buffer.byteLength(file.content))) {
        throw new Error("Invalid archived prototype file.");
      }
    }
  }
  if (archive.events.some((e, i) => e.type === "prototype" && e.ok && !seen.has(i))) {
    throw new Error("Archive is missing prototype contents.");
  }
  return archive;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
/** A regular file of at most 10 MB, checked on the open handle. */
async function readCapped(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_ARCHIVE_BYTES) throw new Error("Replay archive must be a regular file of at most 10 MB.");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

/** Replays use no provider imports, credentials, sandbox directories, or provider calls. */
export async function replayDuel(
  archivePath: string,
  obs: TableObserver,
  { speed = 1, signal }: { speed?: number; signal?: AbortSignal } = {},
): Promise<DuelResult> {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("Replay speed must be positive.");
  signal?.throwIfAborted();
  const archive = validateArchive(JSON.parse(await readCapped(archivePath)));
  const files = new Map(archive.prototypes.map(p => [p.eventIndex, p.files]));
  let previousTime: number | undefined;
  for (const [index, event] of archive.events.entries()) {
    signal?.throwIfAborted();
    const timestamp = event.type === "start" ? event.startedAt : "ts" in event ? event.ts : undefined;
    const time = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(time)) {
      if (previousTime !== undefined) await delay(Math.max(0, time - previousTime) / speed, signal);
      previousTime = time;
    }
    signal?.throwIfAborted();
    if (files.has(index)) attachPrototypeFiles(event, files.get(index)!);
    try { await obs.onEvent(event); } catch { /* Rendering must not stop replay. */ }
  }
  const start = archive.events[0] as Extract<TableEvent, { type: "start" }>;
  const end = archive.events.at(-1) as Extract<TableEvent, { type: "end" }>;
  return { id: start.id, winner: end.winner, tally: end.tally, aborted: end.aborted ?? false, archivePath,
    ...(end.metrics && { metrics: end.metrics }), ...(end.chosen && { chosen: end.chosen }),
    ...(end.decidedBy && { decidedBy: end.decidedBy }), ...(end.resumable !== undefined && { resumable: end.resumable }) };
}
