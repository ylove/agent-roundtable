// ============================================================================
// Artifacts: what a postmortem meeting proposes, and what accepting one does (§6)
//
//   Artifact: <kind> | <target> | <finding ids> | <text>
//
// Lines are read from the last turn's own lines only (never inside blockquotes or fences, where a
// turn quotes the charge and other seats). A line that does not parse is reported back, never
// dropped silently. Accepting an artifact applies it on conclude, and only then.
// ============================================================================

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { appendPersonaAddendum, formatBackupTimestamp } from "../agent-files.js";
import { agentKey, loadAgent } from "../agents.js";
import { ownLines } from "../execution/escalation.js";
import type { PostmortemArtifactKind } from "../execution/types.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { memoryPath, writeText } from "./store.js";
import { ARTIFACT_KINDS, FINDING_ID_RE, LIMITS, type AppliedArtifact, type Artifact } from "./types.js";

const LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?Artifact(?:\*\*|__)?\s*:\s*(.*)$/i;
/** Kinds whose target is the whole project. */
const PROJECT_KINDS: readonly PostmortemArtifactKind[] = ["rule", "contract_rule"];
/** Kinds whose target is a seat (an agent name). */
const SEAT_KINDS: readonly PostmortemArtifactKind[] = ["persona_addendum", "agent_rule", "memory"];

export const artifactHash = (kind: string, target: string, text: string): string =>
  createHash("sha256").update(`${kind}\n${target}\n${text}`).digest("hex");

/** A field without the markdown emphasis or code ticks a model puts around it (only at its ends: names keep their underscores). */
const bare = (s: string): string => s.trim().replace(/^[*_`\s]+|[*_`\s]+$/g, "");

const brief = (s: string, n = 160) => {
  const t = scrub(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

export interface ParsedArtifacts {
  artifacts: Artifact[];
  /** Lines that looked like artifacts but could not be used, each with why. */
  rejected: string[];
}

/**
 * The artifacts a turn proposes. `seats` are the agent keys that may be targeted, `findings` the ids
 * that exist.
 */
export function parseArtifactBlock(turn: string, seats: readonly string[], findings: ReadonlySet<string>): ParsedArtifacts {
  const artifacts: Artifact[] = [];
  const rejected: string[] = [];
  const seatKeys = new Map(seats.map((s) => [agentKey(s), agentKey(s)]));
  const seen = new Set<string>();
  for (const raw of ownLines(turn)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const reject = (why: string) => rejected.push(`${brief(raw)} (${why})`);
    const parts = m[1].split("|");
    if (parts.length < 4) {
      reject("expected: Artifact: <kind> | <target> | <finding ids> | <text>");
      continue;
    }
    const kind = bare(parts[0]).toLowerCase() as PostmortemArtifactKind;
    const targetRaw = bare(parts[1]);
    const ids = parts[2].split(/[\s,;]+/).map(bare).filter(Boolean);
    const text = scrub(parts.slice(3).join("|")).replace(/\s+/g, " ").trim();
    if (!ARTIFACT_KINDS.includes(kind)) {
      reject(`unknown kind; one of ${ARTIFACT_KINDS.join(", ")}`);
      continue;
    }
    let target = targetRaw;
    if (PROJECT_KINDS.includes(kind)) {
      if (targetRaw.toLowerCase() !== "project") {
        reject(`${kind} targets "project"`);
        continue;
      }
      target = "project";
    } else if (SEAT_KINDS.includes(kind)) {
      const seat = seatKeys.get(agentKey(targetRaw));
      if (!targetRaw || !seat) {
        reject(`${kind} must target a seat of this meeting (${[...seatKeys.values()].join(", ")})`);
        continue;
      }
      target = seat;
    } else if (!targetRaw || /\s/.test(targetRaw) || targetRaw.length > 200) {
      reject("a fix targets a path or a task id");
      continue;
    }
    const unknown = ids.filter((id) => !FINDING_ID_RE.test(id) || !findings.has(id));
    if (!ids.length || unknown.length) {
      reject(ids.length ? `unknown finding id ${unknown.slice(0, 3).join(", ")}` : "name at least one finding id");
      continue;
    }
    if (!text) {
      reject("no text");
      continue;
    }
    if (text.length > LIMITS.artifactText) {
      reject(`text is ${text.length} characters; the limit is ${LIMITS.artifactText}`);
      continue;
    }
    const hash = artifactHash(kind, target, text);
    if (seen.has(hash)) continue;
    if (artifacts.length >= LIMITS.artifacts) {
      reject(`over the limit of ${LIMITS.artifacts} artifacts`);
      continue;
    }
    seen.add(hash);
    artifacts.push({ id: `a${artifacts.length + 1}`, kind, target, findings: [...new Set(ids)], text, hash });
  }
  return { artifacts, rejected };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export function artifactCounts(list: readonly { kind: PostmortemArtifactKind }[]): Partial<Record<PostmortemArtifactKind, number>> {
  const out: Partial<Record<PostmortemArtifactKind, number>> = {};
  for (const a of list) out[a.kind] = (out[a.kind] ?? 0) + 1;
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Append a persona addendum through the workshop's write path (backup first, contained, frontmatter kept). */
export async function applyPersonaAddendum(a: Artifact, pm: string, now = new Date(), ref?: string): Promise<AppliedArtifact> {
  const agent = await loadAgent(ref ?? a.target);
  const r = appendPersonaAddendum(agent.path, `- ${oneLine(a.text)} (postmortem ${pm})`, { timestamp: formatBackupTimestamp(now) });
  return {
    id: a.id, kind: a.kind, target: a.target, hash: a.hash, path: r.agentPath,
    note: r.changed ? `added to ${r.agentPath}; the copy before the change is ${r.backupPath}` : "already in the persona file; nothing changed",
  };
}

function appendMemoryLine(path: string, agent: string, line: string, mode?: number): void {
  const old = existsSync(path) ? readFileSync(path, "utf8") : `# Memory: ${agent}\n\n`;
  if (old.split("\n").some((l) => l.trim() === line.trim())) return;
  const next = `${old.replace(/\s+$/, "")}\n${line}\n`;
  if (mode === undefined) writeText(path, next);
  else writeFileAtomic(path, next, mode);
}

/** <repo>/.claude/agent-memory/<agent>/MEMORY.md, created without ever following a link out of the repository. */
export function claudeMemoryPath(repoRoot: string, agent: string): string {
  const real = realpathSync(repoRoot);
  let dir = real;
  for (const part of [".claude", "agent-memory", agent]) {
    dir = join(dir, part);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(dir, { mode: 0o755 });
      st = lstatSync(dir);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Refusing to write agent memory: ${part} under ${repoRoot} is a symbolic link or not a directory`);
    const resolved = realpathSync(dir);
    if (resolved !== dir || !(resolved === real || resolved.startsWith(real + sep))) throw new Error(`Refusing to write agent memory: ${part} under ${repoRoot} resolves outside the repository`);
  }
  const file = join(dir, "MEMORY.md");
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Refusing to write agent memory: ${file} is a symbolic link or not a file`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return file;
}

/** Append a memory line to the project's memory for the agent, and (memory_target: "claude") to the repository's agent memory. */
export function applyMemory(a: Artifact, pm: string, project: { key: string; root: string }, claude: boolean): AppliedArtifact {
  const agent = agentKey(a.target);
  const line = `- ${oneLine(a.text)} (postmortem ${pm})`;
  const path = memoryPath(project.key, agent);
  appendMemoryLine(path, agent, line);
  let note = `added to ${path}`;
  if (claude) {
    const file = claudeMemoryPath(project.root, agent);
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
    appendMemoryLine(file, agent, line, mode);
    note += `; also added to ${file}`;
  }
  return { id: a.id, kind: a.kind, target: a.target, hash: a.hash, path, note };
}
