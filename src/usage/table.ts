// ============================================================================
// The table ledger: what the at-the-table sessions of the orchestrator servers have used
// (usage-visibility.md §4, §6)
//
//   usage/table-YYYY-MM-DD.jsonl                 one line per provider call (and per stop)
//   usage/live/<server-id>.json                  the server's live sessions, rewritten every 5 s
//   usage/stops/<server-id>/<request-id>.json    stop requests for that server's sessions
//
// Lines hold ids, names, numbers and provenance only: never message text. Files are 0600 in 0700
// directories under the roundtable home; every name is scrubbed on the way in, and everything read
// back is validated (a stop request that does not parse is renamed .bad). A reader treats a live file
// whose pid is dead on this host, or whose heartbeat is older than 30 s, as gone.
// ============================================================================

import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import type { Provenance } from "./types.js";
import { num } from "./types.js";

export const LIVE_STALE_MS = 30_000;
export const LIVE_BEAT_MS = 5_000;
/** A table ledger file is read up to this many bytes from its end (a day of heavy use is far below it). */
const LEDGER_READ_MAX = 16 * 1024 * 1024;
const REQUEST_MAX = 4096;

export const SERVER_ID_RE = /^srv-[0-9a-hjkmnp-tv-z]{8}$/;
export const REQUEST_ID_RE = /^stop-[0-9a-hjkmnp-tv-z]{12}$/;
/** Session ids are `<prefix>-<8 base32>` (see ids.ts newId), 2 to 64 characters in all. */
export const SESSION_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

export const usageDir = (home = ROUNDTABLE_HOME): string => join(home, "usage");

export function day(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const clean = (s: unknown, max: number): string => scrub(String(s ?? "")).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------
// Ledger lines
// ---------------------------------------------------------------------------

export interface TableLine {
  at: string;
  server: string;
  session: string;
  kind: string;
  agent: string;
  provider?: string;
  model?: string;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  tokens_prov?: Provenance;
  usd?: number;
  usd_prov?: Provenance;
  /** "stopped": the session was stopped; `by` says who. */
  event?: "stopped";
  by?: string;
}

const isProv = (v: unknown): v is Provenance => v === "measured" || v === "reported" || v === "estimated";

/** A line read back from disk, or null when it is not one (a ledger file is data from another process). */
export function parseLine(raw: unknown): TableLine | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return null;
  if (typeof o.session !== "string" || !SESSION_ID_RE.test(o.session)) return null;
  if (typeof o.server !== "string" || !SERVER_ID_RE.test(o.server)) return null;
  if (typeof o.kind !== "string" || typeof o.agent !== "string") return null;
  const line: TableLine = { at: o.at, server: o.server, session: o.session, kind: clean(o.kind, 40), agent: clean(o.agent, 64) };
  if (o.event === "stopped") {
    line.event = "stopped";
    line.by = clean(o.by, 64);
    return line;
  }
  if (typeof o.provider === "string") line.provider = clean(o.provider, 64);
  if (typeof o.model === "string") line.model = clean(o.model, 200);
  const t = o.tokens as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    line.tokens = { input: num(t.input), output: num(t.output), cache_read: num(t.cache_read), cache_write: num(t.cache_write) };
    line.tokens_prov = isProv(o.tokens_prov) ? o.tokens_prov : "measured";
  }
  if (typeof o.usd === "number" && Number.isFinite(o.usd) && o.usd >= 0) {
    line.usd = o.usd;
    line.usd_prov = isProv(o.usd_prov) ? o.usd_prov : "estimated";
  }
  return line;
}

/** Append one line to today's ledger (0600, one write). Names are scrubbed; there is no free text. */
export function appendTableLine(line: TableLine, home = ROUNDTABLE_HOME): void {
  const safe: TableLine = { ...line, kind: clean(line.kind, 40), agent: clean(line.agent, 64) };
  if (safe.provider !== undefined) safe.provider = clean(safe.provider, 64);
  if (safe.model !== undefined) safe.model = clean(safe.model, 200);
  if (safe.by !== undefined) safe.by = clean(safe.by, 64);
  mkdirPrivate(usageDir(home));
  appendFileSync(join(usageDir(home), `table-${day(Date.parse(line.at) || Date.now())}.jsonl`), JSON.stringify(safe) + "\n", { mode: 0o600 });
}

/** The ledger lines of the given days (YYYY-MM-DD), oldest first. Unreadable lines are skipped. */
export function readTableLines(days: readonly string[], home = ROUNDTABLE_HOME): TableLine[] {
  const out: TableLine[] = [];
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    let text: string;
    try {
      text = readTail(join(usageDir(home), `table-${d}.jsonl`), LEDGER_READ_MAX);
    } catch {
      continue;
    }
    for (const row of text.split("\n")) {
      if (!row.trim()) continue;
      try {
        const line = parseLine(JSON.parse(row));
        if (line) out.push(line);
      } catch {
        /* a partial or foreign line */
      }
    }
  }
  return out;
}

function readTail(path: string, max: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf8");
    // A cut file starts mid-line: drop the partial first line.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Remove ledger files older than `retentionDays` (ROUNDTABLE_SESSION_RETENTION_DAYS). Returns the names removed. */
export function pruneTableLedgers(retentionDays: number, now = Date.now(), home = ROUNDTABLE_HOME): string[] {
  const cutoff = day(now - retentionDays * 86_400_000);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(usageDir(home));
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = /^table-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m || m[1] >= cutoff) continue;
    try {
      rmSync(join(usageDir(home), name), { force: true });
      removed.push(name);
    } catch {
      /* in use or gone */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Live servers
// ---------------------------------------------------------------------------

export interface LiveSession {
  id: string;
  kind: string;
  agents: string[];
  started: string;
  /** A turn is in flight. */
  busy?: boolean;
}

export interface LiveFile {
  pid: number;
  host: string;
  started: string;
  heartbeat_at: string;
  sessions: LiveSession[];
}

export interface LiveServer extends LiveFile {
  server: string;
}

const liveDir = (home: string): string => join(usageDir(home), "live");
export const stopsDir = (server: string, home = ROUNDTABLE_HOME): string => join(usageDir(home), "stops", server);

export function newServerId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(8);
  let id = "srv-";
  for (const b of bytes) id += alphabet[b & 31];
  return id;
}

export function writeLiveFile(server: string, file: Omit<LiveFile, "host" | "heartbeat_at">, home = ROUNDTABLE_HOME): void {
  mkdirPrivate(liveDir(home));
  const body: LiveFile = {
    pid: file.pid,
    host: hostname(),
    started: file.started,
    heartbeat_at: new Date().toISOString(),
    sessions: file.sessions.map((s) => ({ ...s, kind: clean(s.kind, 40), agents: s.agents.map((a) => clean(a, 64)) })),
  };
  writeFileAtomic(join(liveDir(home), `${server}.json`), JSON.stringify(body) + "\n");
}

export function removeLiveFile(server: string, home = ROUNDTABLE_HOME): void {
  try {
    rmSync(join(liveDir(home), `${server}.json`), { force: true });
  } catch {
    /* gone */
  }
}

/** Orchestrator servers that are still there: their pid lives on this host (or, from another host, their heartbeat is fresh). */
export function readLiveServers(now = Date.now(), home = ROUNDTABLE_HOME): LiveServer[] {
  let names: string[];
  try {
    names = readdirSync(liveDir(home));
  } catch {
    return [];
  }
  const out: LiveServer[] = [];
  for (const name of names.sort()) {
    const m = /^(srv-[0-9a-hjkmnp-tv-z]{8})\.json$/.exec(name);
    if (!m) continue;
    try {
      const raw = JSON.parse(readFileSync(join(liveDir(home), name), "utf8")) as Record<string, unknown>;
      const beat = typeof raw.heartbeat_at === "string" ? Date.parse(raw.heartbeat_at) : NaN;
      const pid = raw.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isFinite(beat) || typeof raw.host !== "string") continue;
      if (now - beat > LIVE_STALE_MS) continue;
      if (raw.host === hostname() && !pidAlive(pid as number)) continue;
      const sessions: LiveSession[] = [];
      for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
        const o = s as Record<string, unknown>;
        if (typeof o?.id !== "string" || !SESSION_ID_RE.test(o.id)) continue;
        sessions.push({
          id: o.id,
          kind: clean(o.kind, 40),
          agents: (Array.isArray(o.agents) ? o.agents : []).filter((a): a is string => typeof a === "string").slice(0, 32).map((a) => clean(a, 64)),
          started: typeof o.started === "string" ? o.started : "",
          ...(o.busy === true && { busy: true }),
        });
      }
      out.push({ server: m[1], pid: pid as number, host: raw.host, started: String(raw.started ?? ""), heartbeat_at: new Date(beat).toISOString(), sessions });
    } catch {
      /* torn or foreign */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stop requests
// ---------------------------------------------------------------------------

export interface StopRequest {
  id: string;
  session: string;
  agent: string;
  by: string;
  surface: "dashboard" | "cli" | "tool";
  at: string;
  reason?: string;
}

export function newRequestId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(12);
  let id = "stop-";
  for (const b of bytes) id += alphabet[b & 31];
  return id;
}

/** Ask the orchestrator server `server` to stop a session. Written atomically; the server removes it when done. */
export function writeStopRequest(server: string, r: Omit<StopRequest, "id" | "at">, home = ROUNDTABLE_HOME): StopRequest {
  if (!SERVER_ID_RE.test(server)) throw new Error("Not a server id");
  const req: StopRequest = {
    id: newRequestId(),
    session: r.session,
    agent: clean(r.agent, 64),
    by: clean(r.by, 64) || "a person",
    surface: r.surface,
    at: new Date().toISOString(),
    ...(r.reason ? { reason: clean(r.reason, 500) } : {}),
  };
  if (!SESSION_ID_RE.test(req.session)) throw new Error("Not a session id");
  mkdirPrivate(stopsDir(server, home));
  writeFileAtomic(join(stopsDir(server, home), `${req.id}.json`), JSON.stringify(req) + "\n");
  return req;
}

/** Stop requests waiting for `server`, validated; one that is not valid is renamed `.bad` (unless a reader asks not to touch files). */
export function readStopRequests(server: string, home = ROUNDTABLE_HOME, opts: { quarantine?: boolean } = {}): StopRequest[] {
  const dir = stopsDir(server, home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StopRequest[] = [];
  for (const name of names.sort()) {
    const m = /^(stop-[0-9a-hjkmnp-tv-z]{12})\.json$/.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      const text = readFileSync(path, "utf8");
      if (text.length > REQUEST_MAX) throw new Error("too large");
      const o = JSON.parse(text) as Record<string, unknown>;
      const surface = o.surface;
      if (o.id !== m[1] || typeof o.session !== "string" || !SESSION_ID_RE.test(o.session) || typeof o.agent !== "string" || !NAME_RE.test(o.agent) ||
          typeof o.by !== "string" || !o.by.trim() || (surface !== "dashboard" && surface !== "cli" && surface !== "tool") ||
          typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) {
        throw new Error("not a stop request");
      }
      out.push({
        id: m[1], session: o.session, agent: o.agent, by: clean(o.by, 64), surface, at: o.at,
        ...(typeof o.reason === "string" && o.reason.trim() && { reason: clean(o.reason, 500) }),
      });
    } catch {
      if (opts.quarantine === false) continue;
      try {
        renameSync(path, `${path}.bad`);
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return out;
}

export function removeStopRequest(server: string, id: string, home = ROUNDTABLE_HOME): void {
  if (!REQUEST_ID_RE.test(id)) return;
  try {
    rmSync(join(stopsDir(server, home), `${id}.json`), { force: true });
  } catch {
    /* gone */
  }
}
