import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { ID_RE } from "../execution/events.js";
import { redact } from "../publishers/redact.js";
import { secretKeyName } from "../security/redaction-rules.js";
import { readRegularFile } from "../security/fs-safe.js";
import { MAX_FILES, MAX_TOTAL_BYTES, validatePath } from "../prototypes/parse.js";

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const str = (v: unknown, fallback = ""): string => typeof v === "string" ? v : fallback;
export const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
export const count = (v: unknown): number => Math.max(0, num(v) ?? 0);
export const strings = (v: unknown): string[] => arr(v).filter((s): s is string => typeof s === "string");

/** Redact strings individually so metering numbers can never be mistaken for credentials or PII. */
export function redactedData(value: unknown, depth = 0): unknown {
  if (depth > 60) return "[nested data omitted]";
  if (typeof value === "string") return redact(value).text;
  if (Array.isArray(value)) return value.map(v => redactedData(v, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [redact(key).text, secretKeyName(key) && typeof v === "string" ? "[redacted:secret]" : redactedData(v, depth + 1)]));
  return value;
}

export function readPageData(path: string): unknown {
  return redactedData(JSON.parse(readRegularFile(path, { maxBytes: 10 * 1024 * 1024 }).data.toString("utf8")));
}
export interface DuelSeat { id: string; name: string; role: string; team: string; provider: string; model: string }
export interface DuelTurn { index: number; seat: DuelSeat; round: string; text: string; ts: string; stage?: Obj; order: number; label: string }
export interface DuelFile { path: string; content?: string; bytes: number }
export interface DuelPrototype { index: number; team: string; title: string; kind: string; ok: boolean; version: number; stage?: number; error: string; files: DuelFile[] }
export interface DuelPageData {
  id: string; raw: unknown; start: Obj; end: Obj; events: Obj[]; seats: DuelSeat[]; turns: DuelTurn[];
  prototypes: DuelPrototype[]; assessments: Obj[]; dissents: Obj[]; usage: Obj; metrics: Obj; partial: boolean;
}

export function turnKind(round: string): { order: number; label: string } {
  if (/tool|interact/i.test(round)) return { order: 35, label: "Tool interaction" };
  if (/revision|^R3\b/i.test(round)) return { order: 300, label: "Revision" };
  if (/closing|^R4\b/i.test(round)) return { order: 400, label: "Closing statement" };
  if (/critique|^R1c\b/i.test(round)) return { order: 20, label: "Critique" };
  if (/build|^R1b\b/i.test(round)) return { order: 30, label: "Build" };
  if (/judg|^R2\b/i.test(round)) return { order: 200, label: "Judging" };
  if (/^R1\b|concept/i.test(round)) return { order: 10, label: "Concept" };
  const n = /^R(\d+)/i.exec(round);
  return { order: n ? Number(n[1]) * 100 : 500, label: "Contribution" };
}

/** Tolerant view model, deliberately independent of the strict replay validator. */
export function duelData(id: string, input: unknown): DuelPageData {
  const raw = redactedData(input);
  const root = obj(raw), events = arr(root.events).map(obj), start = events.find(e => e.type === "start") ?? {};
  const recent = [...events].reverse(), end = recent.find(e => e.type === "end") ?? {};
  const seats: DuelSeat[] = [];
  const teams = obj(start.teams);
  const seatFor = (value: unknown): DuelSeat => {
    const s = obj(value), key = str(s.id, str(value, str(s.name, str(s.persona, "unknown"))));
    const existing = seats.find(x => x.id === key);
    if (existing) return existing;
    const team = str(s.team) || Object.keys(teams).find(t => strings(teams[t]).includes(key)) || (/^(A|B|C|D|judge):/.exec(key)?.[1] ?? "");
    const role = str(s.role, team === "judge" ? "judge" : "participant");
    const seat = { id: key, name: str(s.name, str(s.persona, key === "unknown" ? "Unknown agent" : key)), role,
      team: /judge/i.test(role) ? "judge" : team, provider: str(s.provider, "Provider not recorded"), model: str(s.model, "Default model") };
    seats.push(seat); return seat;
  };
  arr(start.seats).forEach(seatFor);
  const stages = new Map<string, Obj>();
  const turns: DuelTurn[] = [];
  events.forEach((e, index) => {
    if (e.type === "stage") stages.set(str(e.team), e);
    if (e.type === "turn") {
      const seat = seatFor(e.seat), round = str(e.round, "Turn"), kind = turnKind(round), stage = stages.get(seat.team);
      turns.push({ index, seat, round, text: str(e.text, "Turn text was not recorded."), ts: str(e.ts),
        ...kind, ...(kind.label === "Build" && stage && { stage: { ...stage }, order: kind.order + count(stage.stage) / 10 }) });
    }
    if (e.type === "assessment") seatFor(e.judge);
    if (e.type === "dissent") seatFor(e.seat);
  });
  // Tool notes arrive during a call, before its completed turn. Keep them beside that
  // contribution rather than inventing a global round between building and judging.
  turns.forEach((turn, i) => {
    if (turn.label !== "Tool interaction") return;
    const following = turns.slice(i + 1).filter(t => t.label !== "Tool interaction");
    const next = following.find(t => t.seat.id === turn.seat.id) ?? following[0];
    const previous = turns.slice(0, i).reverse().find(t => t.label !== "Tool interaction");
    turn.order = next ? next.order - 0.01 : previous ? previous.order + 0.01 : 0;
  });
  turns.sort((a, b) => a.order - b.order || a.index - b.index);
  const versions = new Map<string, number>();
  const prototypes = events.flatMap((e, index): DuelPrototype[] => {
    if (e.type !== "prototype") return [];
    const team = str(e.team, "Unknown"), version = num(e.version) ?? (versions.get(team) ?? 0) + 1;
    versions.set(team, version);
    const stored = arr(root.prototypes).map(obj).find(p => p.eventIndex === index && p.team === e.team);
    // File names are data, never disk paths. Unusable entries remain visible in raw JSON only.
    const contents = arr(stored?.files).map(obj);
    let total = 0;
    const files = arr(e.files).slice(0, MAX_FILES).flatMap((f): DuelFile[] => {
      const file = obj(f), path = str(file.path);
      if (!path || validatePath(path)) return [];
      const content = str(contents.find(c => c.path === path)?.content, str(file.content));
      total += Buffer.byteLength(content);
      return [{ path, bytes: content ? Buffer.byteLength(content) : count(file.bytes),
        ...((contents.some(c => c.path === path && typeof c.content === "string") || typeof file.content === "string") && total <= MAX_TOTAL_BYTES && { content }) }];
    });
    return [{ index, team, version, title: str(e.title, `Team ${team} prototype`), kind: str(e.kind, str(start.kind, "web")),
      ok: e.ok === true, stage: num(e.stage), error: str(e.error), files }];
  });
  return { id, raw, start, end, events, seats, turns, prototypes,
    assessments: events.filter(e => e.type === "assessment"), dissents: events.filter(e => e.type === "dissent"),
    usage: recent.find(e => e.type === "usage") ?? {}, metrics: obj(end.metrics ?? recent.find(e => e.type === "metrics")?.teams),
    partial: !start.type || !end.type || !Array.isArray(root.events) };
}

export function loadDuel(id: string): DuelPageData | undefined {
  if (!ID_RE.test(id)) return;
  try { return duelData(id, readPageData(join(ROUNDTABLE_HOME, "duels", `${id}.json`))); } catch { return; }
}
export function listDuelPages(): DuelPageData[] {
  let names: string[];
  try { names = readdirSync(join(ROUNDTABLE_HOME, "duels")); } catch { return []; }
  return names.filter(n => n.endsWith(".json") && ID_RE.test(n.slice(0, -5))).map(n =>
    loadDuel(n.slice(0, -5)) ?? duelData(n.slice(0, -5), {})).sort((a, b) =>
    (Date.parse(str(b.start.startedAt)) || 0) - (Date.parse(str(a.start.startedAt)) || 0) || a.id.localeCompare(b.id));
}
