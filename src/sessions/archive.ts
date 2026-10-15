// ============================================================================
// Session archive: every finished at-the-table session as a private JSON file
// ============================================================================
// SESSIONS_DIR/<id>.json (directory 0700, file 0600, atomic write), secrets scrubbed from every
// content-bearing field first. Written when a session ends, before it leaves its live map, so a session is always either live
// or archived. Best effort: a failed write is logged to stderr and never fails the session.
// Readers: from_session (agent workshops) and, later, contract proposals built from an ultraplan.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { agentKey } from "../agents.js";
import type { ActivityKind } from "../activity.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrubSecrets } from "../security/secrets.js";
import type { PublicChannel } from "./public.js";
import type { Meeting } from "./meetings.js";
import type { LocalMeeting } from "./local-meetings.js";
import type { Collaboration, CollaborationMessage } from "./collaborations.js";
import type { Ultraplan, UltraplanEntry } from "./ultraplan.js";

export const SESSION_ARCHIVE_SCHEMA = "roundtable.session/1";

/** Ids the archive accepts as file names: a lowercase prefix and suffix, no dots or separators. */
export const ARCHIVE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

export interface ArchivedTurn {
  role: "agent" | "caller" | "orchestrator";
  /** Agent turns: the reference the session was given (a name or a path), so a later session can load it. */
  agent?: string;
  /** Ultraplan and workshop turns: "input", "review of v2", "contribution", ... */
  phase?: string;
  /** How the transcript names the speaker, e.g. "cfo" or "cfo · review of v2". */
  speaker: string;
  content: string;
  at?: string;
}

/** A finished ultraplan in structured form, enough to build a contract from. */
export interface ArchivedUltraplanDocument {
  /** The final markdown document exactly as the tool returned it. */
  markdown: string;
  signedOff: boolean;
  /** The last plan version, or null when no plan was submitted. */
  version: number | null;
  /** The planner persona, or "orchestrator". */
  planner: string;
  versions: Array<{ version: number; plan: string; author: string; at: string }>;
  entries: Array<{
    phase: UltraplanEntry["phase"];
    version?: number;
    agentIndex?: number;
    speaker: string;
    content: string;
    verdict?: string;
    at: string;
  }>;
  signoffs: Array<{ agent: string; verdict: string; content: string }>;
  tally: Record<string, number>;
}

export interface ArchivedSession {
  schema: typeof SESSION_ARCHIVE_SCHEMA;
  id: string;
  kind: ActivityKind;
  mode?: string;
  /** Participants as references (names or paths), in session order. */
  agents: string[];
  topic: string;
  started: string;
  ended: string;
  /** The transcript as agents saw it (resolved prototypes are stubs), as markdown. */
  transcript: string;
  turns: ArchivedTurn[];
  summary?: string;
  /** Ultraplans only. */
  document?: ArchivedUltraplanDocument;
  /** Agent workshops only: the tool's structured result (without its public block). */
  result?: unknown;
  /** Public sessions: where the channel was published. */
  public: { url: string | null; topic: string } | null;
}

export type ArchiveInput = Omit<ArchivedSession, "schema" | "ended" | "transcript"> & { ended?: string; transcript?: string };

export type ArchivedSessionSummary = Pick<ArchivedSession, "id" | "kind" | "mode" | "agents" | "topic" | "started" | "ended"> & {
  public: boolean;
};

// ----------------------------------------------------------------------------
// Writing
// ----------------------------------------------------------------------------

function scrub(text: string): string {
  return scrubSecrets(text).text;
}

function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)])) as T;
  }
  return value;
}

/**
 * Scrub the content-bearing fields: topic, transcript, turn content, summary, the ultraplan document's
 * text, the workshop result and the public URL. Ids, agent refs, speakers, roles, phases and times are
 * kept exactly: refs are loaded again by from_session, and a redacted path would load nothing (or
 * something else).
 */
function scrubRecord(r: ArchivedSession): ArchivedSession {
  return {
    ...r,
    topic: scrub(r.topic),
    transcript: scrub(r.transcript),
    turns: r.turns.map((turn) => ({ ...turn, content: scrub(turn.content) })),
    ...(r.summary !== undefined && { summary: scrub(r.summary) }),
    ...(r.document && {
      document: {
        ...r.document,
        markdown: scrub(r.document.markdown),
        versions: r.document.versions.map((v) => ({ ...v, plan: scrub(v.plan) })),
        entries: r.document.entries.map((e) => ({ ...e, content: scrub(e.content) })),
        signoffs: r.document.signoffs.map((s) => ({ ...s, content: scrub(s.content) })),
      },
    }),
    ...(r.result !== undefined && { result: scrubDeep(r.result) }),
    public: r.public && { ...r.public, url: r.public.url === null ? null : scrub(r.public.url) },
  };
}

/** `**speaker:** content` blocks separated by rules, the format end_collaboration already returns. */
export function renderTranscript(turns: ArchivedTurn[]): string {
  return turns.map((turn) => `**${turn.speaker}:** ${turn.content}`).join("\n\n---\n\n");
}

function archivePath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

/** Build and write one record; any failure is logged and reported as null. */
function attempt(id: string, build: () => ArchiveInput): string | null {
  try {
    if (!ARCHIVE_ID_RE.test(id)) throw new Error("not an archivable session id");
    const input = build();
    const record = scrubRecord({
      schema: SESSION_ARCHIVE_SCHEMA,
      ...input,
      ended: input.ended ?? new Date().toISOString(),
      transcript: input.transcript ?? renderTranscript(input.turns),
    });
    mkdirPrivate(SESSIONS_DIR);
    const path = archivePath(id);
    writeFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
    return path;
  } catch (e) {
    console.error(`[Archive] Could not archive session ${id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Write SESSIONS_DIR/<id>.json. Returns the path, or null when the write failed (logged; never throws). */
export function archiveSession(record: ArchiveInput): string | null {
  return attempt(typeof record?.id === "string" ? record.id : "", () => record);
}

function publicOf(channel: PublicChannel | undefined): ArchivedSession["public"] {
  return channel ? { url: channel.url, topic: channel.topic } : null;
}

/** A meeting or local meeting at its end (history as the agent saw it). */
export function archiveMeeting(kind: "meeting" | "local-meeting", meeting: Meeting | LocalMeeting, summary?: string): string | null {
  return attempt(meeting.id, () => ({
    id: meeting.id,
    kind,
    mode: meeting.mode,
    agents: [meeting.agent],
    topic: meeting.agenda ?? "",
    started: meeting.startedAt.toISOString(),
    turns: meeting.messages.map((m, i): ArchivedTurn => {
      const content = meeting.prototype ? meeting.prototype.historyView(m.content, i) : m.content;
      return m.role === "user"
        ? { role: "caller", speaker: "caller", content }
        : { role: "agent", agent: meeting.agent, speaker: agentKey(meeting.agent), content };
    }),
    ...(summary && { summary }),
    public: publicOf(meeting.publicChannel),
  }));
}

/** A collaboration at its end; `transcript` is the stubbed view end_collaboration returns. */
export function archiveCollaboration(c: Collaboration, transcript: CollaborationMessage[], summary?: string): string | null {
  return attempt(c.id, () => ({
    id: c.id,
    kind: "collaboration",
    mode: c.mode,
    agents: c.agents.map((a) => a.name),
    topic: c.topic,
    started: c.startedAt.toISOString(),
    // Nudges are the only messages without an agentIndex.
    turns: transcript.map((m): ArchivedTurn => m.agentIndex === undefined
      ? { role: "orchestrator", speaker: "orchestrator", content: m.content, at: m.timestamp.toISOString() }
      : { role: "agent", agent: m.agent, speaker: agentKey(m.agent), content: m.content, at: m.timestamp.toISOString() }),
    ...(summary && { summary }),
    public: publicOf(c.publicChannel),
  }));
}

function ultraplanPhase(entry: UltraplanEntry): string {
  return entry.phase === "plan" ? `plan v${entry.version}`
    : entry.phase === "review" ? `review of v${entry.version}`
      : entry.phase === "signoff" ? "sign-off" : "input";
}

/** An ultraplan at finalize (signed off or ended), with the document in structured form. */
export function archiveUltraplan(
  u: Ultraplan,
  final: { markdown: string; signedOff: boolean; version: number | null; signoffs: ArchivedUltraplanDocument["signoffs"]; tally: Record<string, number>; outcome: string }
): string | null {
  return attempt(u.id, () => ({
    id: u.id,
    kind: "ultraplan",
    mode: u.planner ? "planner" : "orchestrator",
    agents: [...new Set([...u.agents.map((a) => a.name), ...(u.planner ? [u.planner.name] : [])])],
    topic: u.task,
    started: u.startedAt.toISOString(),
    turns: u.entries.map((e): ArchivedTurn => {
      const phase = ultraplanPhase(e);
      const who = e.speaker === "orchestrator" ? "orchestrator" : agentKey(e.speaker);
      return {
        role: e.speaker === "orchestrator" ? "orchestrator" : "agent",
        ...(e.speaker !== "orchestrator" && { agent: e.speaker }),
        phase,
        speaker: `${who} · ${phase}`,
        content: e.content,
        at: e.timestamp.toISOString(),
      };
    }),
    summary: final.outcome,
    document: {
      markdown: final.markdown,
      signedOff: final.signedOff,
      version: final.version,
      planner: u.planner?.name ?? "orchestrator",
      versions: u.versions.map((v) => ({ version: v.version, plan: v.plan, author: v.author, at: v.timestamp.toISOString() })),
      entries: u.entries.map(({ timestamp, ...e }) => ({ ...e, at: timestamp.toISOString() })),
      signoffs: final.signoffs,
      tally: final.tally,
    },
    public: publicOf(u.publicChannel),
  }));
}

// ----------------------------------------------------------------------------
// Reading
// ----------------------------------------------------------------------------

function isArchivedSession(value: unknown): value is ArchivedSession {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.schema === SESSION_ARCHIVE_SCHEMA && typeof r.id === "string" && typeof r.kind === "string"
    && Array.isArray(r.agents) && r.agents.every((a) => typeof a === "string")
    && typeof r.topic === "string" && typeof r.started === "string" && typeof r.ended === "string"
    && typeof r.transcript === "string" && Array.isArray(r.turns);
}

/** The archived record for `id`, or null when there is none (or it is unreadable, which is logged). */
export function readArchivedSession(id: string): ArchivedSession | null {
  if (typeof id !== "string" || !ARCHIVE_ID_RE.test(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(archivePath(id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[Archive] Could not read session ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
  try {
    const record: unknown = JSON.parse(raw);
    if (isArchivedSession(record) && record.id === id) return record;
  } catch {
    // Reported below.
  }
  console.error(`[Archive] Ignoring malformed archive file for session ${id}`);
  return null;
}

/** Every readable archived session, most recently ended first. */
export function listArchivedSessions(): ArchivedSessionSummary[] {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: ArchivedSessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readArchivedSession(name.slice(0, -".json".length));
    if (!record) continue;
    out.push({
      id: record.id,
      kind: record.kind,
      ...(record.mode !== undefined && { mode: record.mode }),
      agents: record.agents,
      topic: record.topic,
      started: record.started,
      ended: record.ended,
      public: record.public !== null && record.public !== undefined,
    });
  }
  return out.sort((a, b) => b.ended.localeCompare(a.ended) || a.id.localeCompare(b.id));
}
