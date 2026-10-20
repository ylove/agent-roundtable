import { open } from "node:fs/promises";
import type { PrototypeFile } from "../prototypes/parse.js";
import { validatePath } from "../prototypes/parse.js";
import type { DuelResult, Seat, TableEvent, TableObserver } from "./events.js";

export interface DuelArchive {
  version: 1;
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

const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
const team = (value: unknown): boolean => value === "A" || value === "B";
function seat(value: Seat): boolean {
  return !!value && text(value.id) && text(value.name) && text(value.provider) && text(value.model) &&
    (value.role === undefined || text(value.role)) && (value.team === undefined || team(value.team) || value.team === "judge");
}
function validEvent(event: TableEvent): boolean {
  if (!event) return false;
  switch (event.type) {
    case "start": return text(event.id) && text(event.topic) && event.mode === "duel" && date(event.startedAt) &&
      Array.isArray(event.seats) && event.seats.every(seat);
    case "turn": return seat(event.seat) && text(event.round) && text(event.text) && date(event.ts);
    case "prototype": return team(event.team) && seat(event.seat) && typeof event.ok === "boolean" &&
      (event.title === undefined || text(event.title)) && (event.error === undefined || text(event.error)) &&
      Array.isArray(event.files) && event.files.length === (event.ok ? 1 : 0) && event.files.every(file =>
        file && file.path === "index.html" && count(file.bytes) && file.bytes <= 40 * 1024);
    case "assessment": return seat(event.judge) && team(event.team) &&
      ["APPROVE", "REVISE", "REJECT", "UNCLEAR"].includes(event.verdict) && text(event.reason);
    case "dissent": return seat(event.seat) && text(event.text) && (event.team === undefined || team(event.team));
    case "usage": return count(event.totalCostUsd) && Array.isArray(event.perSeat) && event.perSeat.every(item =>
      item && text(item.seatId) && count(item.inputTokens) && count(item.outputTokens) && count(item.costUsd) &&
      (item.unpricedTokens === undefined || count(item.unpricedTokens)) && (item.estimated === undefined || typeof item.estimated === "boolean"));
    case "end": return ["A", "B", "tie", "none"].includes(event.winner) && !!event.tally &&
      Number.isInteger(event.tally.A) && Number.isInteger(event.tally.B) &&
      (event.aborted === undefined || typeof event.aborted === "boolean") && (event.archivePath === undefined || text(event.archivePath));
    default: return false;
  }
}

function validateArchive(value: unknown): DuelArchive {
  const archive = value as DuelArchive;
  if (!archive || archive.version !== 1 || !Array.isArray(archive.events) || !Array.isArray(archive.prototypes)) {
    throw new Error("Unsupported duel archive.");
  }
  if (archive.events[0]?.type !== "start" || archive.events.at(-1)?.type !== "end" ||
      archive.events.some(e => !validEvent(e)) ||
      archive.events.slice(1, -1).some(e => e.type === "start" || e.type === "end")) throw new Error("Invalid duel event sequence.");
  const seen = new Set<number>();
  for (const submission of archive.prototypes) {
    if (!submission) throw new Error("Invalid archived prototype.");
    const event = archive.events[submission.eventIndex];
    if (!Number.isInteger(submission.eventIndex) || seen.has(submission.eventIndex) || event?.type !== "prototype" ||
        !event.ok || event.team !== submission.team || !Array.isArray(submission.files) || submission.files.length !== 1) {
      throw new Error("Invalid archived prototype.");
    }
    seen.add(submission.eventIndex);
    for (const file of submission.files) {
      if (!file || typeof file.path !== "string" || validatePath(file.path) || file.path !== "index.html" ||
          typeof file.content !== "string" || Buffer.byteLength(file.content) > 40 * 1024 ||
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
    const timestamp = event.type === "start" ? event.startedAt : event.type === "turn" ? event.ts : undefined;
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
  return { id: start.id, winner: end.winner, tally: end.tally, aborted: end.aborted ?? false, archivePath };
}
