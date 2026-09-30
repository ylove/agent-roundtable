// Titles, history reassembly, local/public merge, and the saved Markdown transcript.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryKind, HistoryMessage } from "./types.js";

export function formatTitle(turn: number, speaker: string, part = 1, parts = 1): string {
  const base = `#${String(turn).padStart(2, "0")} · ${speaker}`;
  return parts > 1 ? `${base} (${part}/${parts})` : base;
}

export interface ParsedTitle {
  turn: number;
  speaker: string;
  part: number;
  parts: number;
}

const TITLE_RE = /^#(\d+) · (.+?)(?: \((\d+)\/(\d+)\))?$/s;

export function parseTitle(title: string): ParsedTitle | null {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return null;
  const part = m[3] ? parseInt(m[3], 10) : 1;
  const parts = m[4] ? parseInt(m[4], 10) : 1;
  if (part < 1 || parts < 1 || part > parts) return null;
  return { turn: parseInt(m[1], 10), speaker: m[2], part, parts };
}

export interface RemoteEntry {
  turn: number;
  speaker: string;
  content: string;
  /** Every part 1..parts is present. */
  complete: boolean;
  time?: number;
}

/**
 * Rebuild entries from raw history messages: parse turn/part from titles, drop duplicate
 * (turn, speaker, part) repeats (a retried publish can land twice), order by (turn, part).
 * Messages with unparseable titles are ignored.
 */
export function reassemble(messages: HistoryMessage[]): RemoteEntry[] {
  interface Group {
    turn: number;
    speaker: string;
    parts: number;
    firstIdx: number;
    time?: number;
    byPart: Map<number, string>;
  }
  const groups = new Map<string, Group>();
  messages.forEach((m, idx) => {
    const t = parseTitle(m.title);
    if (!t) return;
    const key = `${t.turn}\u0000${t.speaker}`;
    let g = groups.get(key);
    if (!g) {
      g = { turn: t.turn, speaker: t.speaker, parts: t.parts, firstIdx: idx, time: m.time, byPart: new Map() };
      groups.set(key, g);
    }
    g.parts = Math.max(g.parts, t.parts);
    if (!g.byPart.has(t.part)) g.byPart.set(t.part, m.content);
  });
  return [...groups.values()]
    .sort((a, b) => a.turn - b.turn || a.firstIdx - b.firstIdx)
    .map((g) => {
      const nums = [...g.byPart.keys()].sort((a, b) => a - b);
      let complete = true;
      for (let i = 1; i <= g.parts; i++) if (!g.byPart.has(i)) complete = false;
      return {
        turn: g.turn,
        speaker: g.speaker,
        content: nums.map((n) => g.byPart.get(n)!).join(""),
        complete,
        time: g.time,
      };
    });
}

export interface LocalEntry {
  turn: number;
  speaker: string;
  kind: EntryKind;
  content: string;
  timestamp: string;
  /** The queue confirmed every part was delivered. */
  delivered: boolean;
}

export interface MergedEntry {
  turn: number;
  speaker: string;
  kind: EntryKind;
  content: string;
  delivered: boolean;
  timestamp?: string;
  /** The public record holds different text for this entry (e.g. a third party posted first). */
  publicDiffers?: boolean;
}

// Whitespace-normalized: a server that trims each chunk must not make multi-part entries look different.
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) => norm(a) === norm(b);

/**
 * Merge the local copy with the public record (null when the backend has no history).
 * The local copy is AUTHORITATIVE for content: it is exactly what was sent, whereas the public
 * topic is world-writable. The public record only confirms delivery (exact text match) or flags a
 * difference. Public entries with no local twin are never added (see countUnmatchedRemote).
 * `delivered` is true when the queue confirmed it, or when the public copy matches exactly.
 */
export function mergeTranscript(local: LocalEntry[], remote: RemoteEntry[] | null): MergedEntry[] {
  const pool = new Map<string, RemoteEntry>();
  for (const r of remote ?? []) pool.set(`${r.turn}\u0000${r.speaker}`, r);
  return local
    .map((l, i) => {
      const r = pool.get(`${l.turn}\u0000${l.speaker}`);
      const matches = !!r && r.complete && sameText(r.content, l.content);
      const entry: MergedEntry = {
        turn: l.turn,
        speaker: l.speaker,
        kind: l.kind,
        content: l.content,
        delivered: l.delivered || matches,
        timestamp: l.timestamp,
      };
      if (r && r.complete && !matches) entry.publicDiffers = true;
      return { entry, i };
    })
    .sort((a, b) => a.entry.turn - b.entry.turn || a.i - b.i)
    .map((x) => x.entry);
}

/** Public entries that match no local entry (third-party posts, or a stale topic). Not merged. */
export function countUnmatchedRemote(local: LocalEntry[], remote: RemoteEntry[] | null): number {
  const keys = new Set(local.map((l) => `${l.turn}\u0000${l.speaker}`));
  return (remote ?? []).filter((r) => !keys.has(`${r.turn}\u0000${r.speaker}`)).length;
}

export interface TranscriptMeta {
  sessionId: string;
  mode?: string;
  participants: string[];
  topic?: string;
  url: string | null;
  published: number;
  failed: number;
  total: number;
  degraded: boolean;
  startedAt: string;
  endedAt: string;
  publisher: string;
}

const q = (v: unknown) => JSON.stringify(v ?? "");

export function renderTranscript(meta: TranscriptMeta, entries: MergedEntry[]): string {
  const lines: string[] = [
    "---",
    `session: ${q(meta.sessionId)}`,
    `mode: ${q(meta.mode ?? "")}`,
    `participants: [${meta.participants.map(q).join(", ")}]`,
    `topic: ${q(meta.topic ?? "")}`,
    `publisher: ${q(meta.publisher)}`,
    `url: ${q(meta.url ?? "")}`,
    `published: ${meta.published}`,
    `failed: ${meta.failed}`,
    `total: ${meta.total}`,
    `degraded: ${meta.degraded}`,
    `started: ${q(meta.startedAt)}`,
    `ended: ${q(meta.endedAt)}`,
    "---",
    "",
    `# ${meta.topic ? meta.topic.replace(/\s+/g, " ").slice(0, 200) : "Session " + meta.sessionId}`,
    "",
  ];
  for (const e of entries) {
    lines.push(`## ${formatTitle(e.turn, e.speaker)}${e.kind !== "turn" ? ` (${e.kind})` : ""}`, "");
    if (!e.delivered) lines.push("_[not delivered to public channel]_", "");
    if (e.publicDiffers) lines.push("_[the public copy differs from this local record]_", "");
    lines.push(e.content.trimEnd(), "");
  }
  return lines.join("\n");
}

const safeName = (s: string) => s.replace(/[^-_A-Za-z0-9]/g, "-").slice(0, 80) || "session";

export async function writeTranscript(
  dir: string,
  meta: TranscriptMeta,
  suffix: string,
  entries: MergedEntry[]
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const date = meta.startedAt.slice(0, 10);
  const path = join(dir, `${date}-${safeName(meta.sessionId)}-${safeName(suffix)}.md`);
  await writeFile(path, renderTranscript(meta, entries), "utf8");
  return path;
}
