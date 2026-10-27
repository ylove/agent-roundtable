import { constants, existsSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { isDuelId } from "../sessions/duel-import.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { MAX_FILES, validatePath, type PrototypeFile } from "../prototypes/parse.js";
import { pageCheckFailed } from "../prototypes/page-check.js";
import type { DuelOptions, Seat, TableEvent } from "./events.js";
import type { TeamProgress } from "./duel.js";
import { validateArchive, validCheck, validMetrics, validSeat, type DuelArchive } from "./replay.js";
import { validateDuelOptions } from "./duel-options.js";
import { DUEL_MAX_BYTES } from "./prompts.js";

export interface DuelProgress {
  phase: "build" | "judge" | "revise" | "decide" | "close";
  teams: Record<"A" | "B", TeamProgress>;
  assessments: Extract<TableEvent, { type: "assessment" }>[];
  preferences: { A: number; B: number };
  completedJudges: string[];
  judgeReplies: Record<string, { text: string; attempts: number }>;
  completedRevisions: ("A" | "B")[];
  completedClosings: ("A" | "B")[];
  decision?: "A" | "B";
}
export interface DuelUsage { seatId: string; inputTokens: number; outputTokens: number; costUsd: number; unpricedTokens: number; estimated: boolean }
export interface DuelCheckpoint {
  version: 1;
  id: string;
  nonce: string;
  options: DuelOptions;
  seats: Seat[];
  archive: DuelArchive;
  progress: DuelProgress;
  usage: DuelUsage[];
  activeMs: number;
}
export const MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;
export const checkpointPath = (id: string): string => {
  if (!isDuelId(id)) throw new Error("Invalid duel id; resume takes a duel id, never a path.");
  return join(ROUNDTABLE_HOME, "duels", `${id}.checkpoint.json`);
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const string = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;
const strings = (v: unknown, max = 16, length = 200): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => string(s, length));
const keys = (v: unknown, allowed: string[]): boolean => object(v) && Object.keys(v).every(k => allowed.includes(k));
function files(value: PrototypeFile[]): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_FILES &&
    new Set(value.map(f => f?.path)).size === value.length && value.every(f => keys(f, ["path", "content"]) &&
      string(f.path, 200) && !validatePath(f.path) && string(f.content, DUEL_MAX_BYTES)) &&
    value.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <= DUEL_MAX_BYTES;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const fail = (): never => { throw new Error("Malformed or tampered duel checkpoint."); };

/** Validate the complete persisted shape before loading personas or starting providers. */
export function validateCheckpoint(value: unknown, id: string): DuelCheckpoint {
  const x = value as DuelCheckpoint;
  if (!keys(x, ["version", "id", "nonce", "options", "seats", "archive", "progress", "usage", "activeMs"]) ||
      x.version !== 1 || x.id !== id || !isDuelId(x.id) || !string(x.nonce, 12) || !/^[a-f0-9]{12}$/.test(x.nonce) || !number(x.activeMs)) fail();
  const o = x.options;
  if (!keys(o, ["topic", "teamA", "teamB", "judges", "kind", "criteria", "stages", "rounds", "humanJudge", "pageCheck", "connectors", "seatConnectors", "maxSeconds", "turnTimeoutMs", "agentsDir"]) ||
      !string(o.topic, 16_000) || !strings(o.teamA, 4) || !strings(o.teamB, 4) || !strings(o.judges, 5) ||
      !integer(o.stages) || o.stages < 1 || o.stages > 4 || ![1, 2].includes(o.rounds!) ||
      !number(o.maxSeconds) || o.maxSeconds > 3600 || !number(o.turnTimeoutMs) || o.turnTimeoutMs <= 0 || o.turnTimeoutMs > 3_600_000 ||
      (o.criteria !== undefined && !strings(o.criteria, 8, 120)) ||
      (o.agentsDir !== undefined && !string(o.agentsDir, 4096)) ||
      (o.humanJudge !== undefined && typeof o.humanJudge !== "boolean") || (o.pageCheck !== undefined && typeof o.pageCheck !== "boolean") ||
      (o.connectors !== undefined && !strings(o.connectors, 8, 32)) ||
      (o.seatConnectors !== undefined && (!object(o.seatConnectors) || Object.keys(o.seatConnectors).length > 13 ||
        Object.entries(o.seatConnectors).some(([seat, names]) => !string(seat, 200) || !strings(names, 8, 32) || names.some(n => !o.connectors?.includes(n)))))) fail();
  try { validateDuelOptions(o); } catch { fail(); }
  if (!Array.isArray(x.seats) || x.seats.length !== o.teamA.length + o.teamB.length + o.judges.length ||
      x.seats.some(s => !keys(s, ["id", "name", "role", "reason", "maxOutputTokens", "team", "provider", "model"]) || !validSeat(s) ||
        !string(s.id, 300) || !string(s.name, 200) || !string(s.provider, 64) || !string(s.model, 300) ||
        (s.reason !== undefined && !string(s.reason, 2000)) || (s.role !== undefined && !string(s.role, 200)) ||
        (s.maxOutputTokens !== undefined && (!integer(s.maxOutputTokens) || !s.maxOutputTokens || s.maxOutputTokens > 1_000_000))) ||
      new Set(x.seats.map(s => s.id)).size !== x.seats.length ||
      (["A", "B", "judge"] as const).some(team => x.seats.filter(s => s.team === team).length !== (team === "A" ? o.teamA : team === "B" ? o.teamB : o.judges).length)) fail();
  try { validateArchive(x.archive, true); } catch { fail(); }
  if (x.archive.version !== 2 || x.archive.events[0].type !== "start" || x.archive.events[0].id !== id ||
      !same(x.archive.events[0].seats.map(s => s.id), x.seats.map(s => s.id)) ||
      x.archive.events.some(e => e.type === "start" && e.id !== id)) fail();
  const p = x.progress;
  if (!keys(p, ["phase", "teams", "assessments", "preferences", "completedJudges", "judgeReplies", "completedRevisions", "completedClosings", "decision"]) ||
      !["build", "judge", "revise", "decide", "close"].includes(p.phase) || !keys(p.teams, ["A", "B"]) ||
      !validMetrics({ A: p.teams?.A?.metrics, B: p.teams?.B?.metrics } as Parameters<typeof validMetrics>[0]) ||
      !keys(p.preferences, ["A", "B"]) || !integer(p.preferences.A) || !integer(p.preferences.B) || p.preferences.A + p.preferences.B > o.judges.length ||
      !strings(p.completedJudges, 5, 300) || p.completedJudges.some(id => !x.seats.some(s => s.id === id && s.team === "judge")) ||
      new Set(p.completedJudges).size !== p.completedJudges.length || !object(p.judgeReplies) ||
      Object.entries(p.judgeReplies).some(([id, r]) => !x.seats.some(s => s.id === id && s.team === "judge") ||
        !keys(r, ["text", "attempts"]) || !string(r.text) || ![1, 2].includes(r.attempts)) ||
      !strings(p.completedRevisions, 2) || !strings(p.completedClosings, 2) || [...p.completedRevisions, ...p.completedClosings].some(t => t !== "A" && t !== "B") ||
      new Set(p.completedRevisions).size !== p.completedRevisions.length || new Set(p.completedClosings).size !== p.completedClosings.length ||
      (p.decision !== undefined && (p.decision !== "A" && p.decision !== "B" || !o.humanJudge))) fail();
  if (!Array.isArray(p.assessments) || p.assessments.length > 10 || !same(p.assessments, x.archive.events.filter(e => e.type === "assessment")) ||
      p.assessments.some(a => !x.seats.some(s => s.id === a.judge.id && s.team === "judge"))) fail();
  for (const team of ["A", "B"] as const) {
    const t = p.teams[team];
    if (!keys(t, ["concept", "conceptDone", "critiques", "completedCritics", "criticNotes", "stages", "stageReached", "submission", "version", "judgedVersion", "check", "feedback", "startedAt", "metrics"]) ||
        !string(t.concept) || typeof t.conceptDone !== "boolean" || !string(t.critiques) || !string(t.feedback, 500_000) ||
        !strings(t.completedCritics, 2, 300) || new Set(t.completedCritics).size !== t.completedCritics.length || !object(t.criticNotes) ||
        !same(Object.keys(t.criticNotes).sort(), [...t.completedCritics].sort()) ||
        t.completedCritics.some(id => !x.seats.filter(s => s.team === team).slice(1, -1).some(s => s.id === id) || !string(t.criticNotes[id])) ||
        !integer(t.stageReached) || t.stageReached > o.stages! || !integer(t.version) || !integer(t.judgedVersion) || t.judgedVersion > t.version ||
        !validCheck(t.check) || (t.startedAt !== undefined && !number(t.startedAt)) ||
        t.metrics.stagesTotal !== o.stages || !Array.isArray(t.stages) || t.stages.length > o.stages! ||
        t.stages.some((s, i) => !keys(s, ["index", "status"]) || s.index !== i + 1 || !["started", "done", "failed", "skipped"].includes(s.status) || (s.status === "started" && i !== t.stages.length - 1)) ||
        t.metrics.stagesDone !== t.stages.filter(s => s.status === "done").length) fail();
    const versions = x.archive.events.filter((e): e is Extract<TableEvent, { type: "prototype" }> => e.type === "prototype" && e.team === team && e.ok);
    if (t.version !== Math.max(0, ...versions.map(e => e.version ?? 0)) || t.metrics.versions !== versions.filter(e => !pageCheckFailed(e.check)).length) fail();
    if (t.submission) {
      if (!keys(t.submission, ["title", "files"]) || !string(t.submission.title, 2000) || !files(t.submission.files)) fail();
      const event = versions.find(e => e.version === t.judgedVersion);
      const archived = x.archive.prototypes.find(a => a.eventIndex === x.archive.events.indexOf(event!));
      if (!event || pageCheckFailed(event.check) || !same(event.check, t.check) || !same(archived?.files, t.submission.files)) fail();
    } else if (t.judgedVersion !== 0 || t.check !== undefined || t.metrics.versions !== 0) fail();
  }
  if (p.decision && !p.teams[p.decision].submission) fail();
  if (!Array.isArray(x.usage) || x.usage.length !== x.seats.length || new Set(x.usage.map(u => u?.seatId)).size !== x.usage.length ||
      x.usage.some(u => !keys(u, ["seatId", "inputTokens", "outputTokens", "costUsd", "unpricedTokens", "estimated"]) || !x.seats.some(s => s.id === u.seatId) ||
        ![u.inputTokens, u.outputTokens, u.unpricedTokens].every(integer) || !number(u.costUsd) || typeof u.estimated !== "boolean")) fail();
  for (const team of ["A", "B"] as const) {
    const totals = x.usage.filter(u => x.seats.some(s => s.id === u.seatId && s.team === team));
    for (const key of ["inputTokens", "outputTokens", "unpricedTokens", "costUsd"] as const) if (Math.abs(p.teams[team].metrics[key] - totals.reduce((n, u) => n + u[key], 0)) > 1e-9) fail();
  }
  return x;
}

export function readCheckpoint(id: string): DuelCheckpoint {
  const path = checkpointPath(id);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) throw new Error("Duel checkpoint must be a regular file of at most 10 MB.");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0, bytes: number;
    while (length < buffer.length && (bytes = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
    if (length > stat.size) throw new Error("Duel checkpoint changed while being read.");
    return validateCheckpoint(JSON.parse(buffer.subarray(0, length).toString("utf8")), id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(existsSync(join(ROUNDTABLE_HOME, "duels", `${id}.json`)) ? `Duel ${id} is finished; it cannot be resumed.` : `No checkpoint found for duel ${id}.`);
    if (error instanceof SyntaxError) throw new Error("Malformed duel checkpoint.");
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function writeCheckpoint(checkpoint: DuelCheckpoint): void {
  const body = JSON.stringify(checkpoint);
  if (Buffer.byteLength(body) > MAX_CHECKPOINT_BYTES) throw new Error("Duel checkpoint exceeds 10 MB.");
  validateCheckpoint(checkpoint, checkpoint.id);
  mkdirPrivate(join(ROUNDTABLE_HOME, "duels"));
  writeFileAtomic(checkpointPath(checkpoint.id), body, 0o600);
}
