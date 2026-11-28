// ============================================================================
// The postmortem store: ROUNDTABLE_HOME/projects/<project_key>/ (docs/design/postmortem.md §3)
//
//   project.json                  the project and whether postmortem mode is on for it
//   log.jsonl                     enable and disable, with the human's quoted words (scrubbed)
//   postmortems/drafts/<pm>.json  the running draft of one scope
//   postmortems/<pm>.json|.md     a held or concluded postmortem: the record
//   lessons.json                  the active lessons across all postmortems, newest first
//   memory/<agent>.md             per-agent memory addenda
//
// Directories are 0700 and files 0600, written atomically (fs-safe). Every string is scrubbed
// before it reaches disk. Keys and ids are checked against their patterns before they are joined
// into a path, so nothing a caller passes can leave the store.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECTS_DIR } from "../config.js";
import { scrubDeep } from "../execution/blobs.js";
import { withLock } from "../execution/lock.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { PM_ID_RE, PROJECT_KEY_RE, type DraftFile, type Lesson, type PostmortemRecord, type PostmortemScope, type ProjectFile } from "./types.js";

/** The first 16 hex characters of sha256 of the repository's real root path. */
export function projectKeyOf(realRoot: string): string {
  return createHash("sha256").update(realRoot).digest("hex").slice(0, 16);
}

export function projectDir(key: string): string {
  if (typeof key !== "string" || !PROJECT_KEY_RE.test(key)) throw new Error(`Not a project key: ${JSON.stringify(String(key).slice(0, 40))}`);
  return join(PROJECTS_DIR, key);
}

function pmId(pm: string): string {
  if (typeof pm !== "string" || !PM_ID_RE.test(pm)) throw new Error(`Not a postmortem id (pm-…): ${JSON.stringify(String(pm).slice(0, 40))}`);
  return pm;
}

const draftsDir = (key: string) => join(projectDir(key), "postmortems", "drafts");
export const recordPath = (key: string, pm: string, ext: "json" | "md" = "json") => join(projectDir(key), "postmortems", `${pmId(pm)}.${ext}`);
export const lessonsPath = (key: string) => join(projectDir(key), "lessons.json");
export const memoryPath = (key: string, agent: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) throw new Error(`Not an agent key for a memory file: ${JSON.stringify(agent.slice(0, 40))}`);
  return join(projectDir(key), "memory", `${agent}.md`);
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Parsed JSON, or undefined when the file does not exist. A damaged file throws. */
export function readJson<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not valid JSON; the postmortem store is damaged there`);
  }
}

export function writeText(path: string, text: string): void {
  mkdirPrivate(dirname(path));
  writeFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`);
}

/** Pretty JSON with every string scrubbed. */
export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(scrubDeep(value), null, 2));
}

/** The project's directories exist (0700). */
export function ensureProjectDirs(key: string): void {
  mkdirPrivate(PROJECTS_DIR);
  mkdirPrivate(projectDir(key));
  mkdirPrivate(join(projectDir(key), "postmortems"));
  mkdirPrivate(draftsDir(key));
}

/** One writer at a time per project: lessons, drafts and records are read-modify-write files. */
export function withProjectLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  ensureProjectDirs(key);
  return withLock(join(projectDir(key), ".lock"), { staleMs: 10_000, timeoutMs: 30_000 }, fn);
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export function readProject(key: string): ProjectFile | undefined {
  const p = readJson<ProjectFile>(join(projectDir(key), "project.json"));
  if (p === undefined) return undefined;
  if (p.v !== 1 || p.key !== key || typeof p.repo_root !== "string" || typeof p.postmortem?.enabled !== "boolean") {
    throw new Error(`${join(projectDir(key), "project.json")} is not a project file; the postmortem store is damaged there`);
  }
  return p;
}

/** The project of a repository root, when it is known. Never creates one and never throws. */
export function projectOfRoot(root: string): ProjectFile | undefined {
  try {
    return readProject(projectKeyOf(realpathSync(root)));
  } catch {
    return undefined;
  }
}

export function writeProject(p: ProjectFile): void {
  ensureProjectDirs(p.key);
  writeJson(join(projectDir(p.key), "project.json"), p);
}

/** Append one line to log.jsonl (enable and disable, with the quoted reason). */
export function appendLog(key: string, entry: Record<string, unknown>): void {
  const path = join(projectDir(key), "log.jsonl");
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  ensureProjectDirs(key);
  writeFileAtomic(path, `${old}${JSON.stringify(scrubDeep(entry))}\n`);
}

// ---------------------------------------------------------------------------
// Drafts and records
// ---------------------------------------------------------------------------

export function loadDraft(key: string, pm: string): DraftFile | undefined {
  return readJson<DraftFile>(join(draftsDir(key), `${pmId(pm)}.json`));
}

export function saveDraft(d: DraftFile): void {
  ensureProjectDirs(d.project);
  writeJson(join(draftsDir(d.project), `${pmId(d.pm)}.json`), d);
}

export function removeDraft(key: string, pm: string): void {
  rmSync(join(draftsDir(key), `${pmId(pm)}.json`), { force: true });
}

function listIds(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir).flatMap((n) => (n.endsWith(ext) && PM_ID_RE.test(n.slice(0, -ext.length)) ? [n.slice(0, -ext.length)] : [])).sort();
  } catch {
    return [];
  }
}

export function listDrafts(key: string): DraftFile[] {
  return listIds(draftsDir(key), ".json").flatMap((pm) => {
    const d = loadDraft(key, pm);
    return d ? [d] : [];
  });
}

const sameScope = (a: PostmortemScope, b: PostmortemScope) =>
  a.execution_id !== undefined ? a.execution_id === b.execution_id : a.work !== undefined && a.work.trim().toLowerCase() === b.work?.trim().toLowerCase();

/** The open draft of a scope, if there is one. */
export function findDraft(key: string, scope: PostmortemScope): DraftFile | undefined {
  return listDrafts(key).find((d) => sameScope(d.scope, scope));
}

export function loadRecord(key: string, pm: string): PostmortemRecord | undefined {
  return readJson<PostmortemRecord>(recordPath(key, pm));
}

export function saveRecord(r: PostmortemRecord, markdown: string): void {
  ensureProjectDirs(r.project);
  writeJson(recordPath(r.project, r.pm), r);
  writeText(recordPath(r.project, r.pm, "md"), markdown);
}

export function listRecords(key: string): PostmortemRecord[] {
  return listIds(join(projectDir(key), "postmortems"), ".json").flatMap((pm) => {
    const r = loadRecord(key, pm);
    return r ? [r] : [];
  });
}

/** Pending text is reviewable here, never in lessons.json or prompt sections. */
export function pendingPostmortems(key: string) {
  return listRecords(key).filter((r) => r.status === "concluded").flatMap((r) =>
    r.proposed.filter((a) => r.pending?.includes(a.id)).map(({ id, kind, target, text, hash }) => ({ pm: r.pm, id, kind, target, text, hash })));
}

/** Every project key in the store. */
export function listProjectKeys(): string[] {
  try {
    return readdirSync(PROJECTS_DIR).filter((n) => PROJECT_KEY_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** A postmortem record by id, searching every project. */
export function findRecord(pm: string): PostmortemRecord | undefined {
  pmId(pm);
  for (const key of listProjectKeys()) {
    const r = loadRecord(key, pm);
    if (r) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/** lessons.json, newest first; a missing file is no lessons. */
export function loadLessons(key: string): Lesson[] {
  const l = readJson<{ v?: number; lessons?: Lesson[] }>(lessonsPath(key));
  return Array.isArray(l?.lessons) ? l.lessons : [];
}

export function saveLessons(key: string, lessons: Lesson[]): void {
  ensureProjectDirs(key);
  writeJson(lessonsPath(key), { v: 1, lessons });
}

/** Drafts that were never held and have not been touched for `days` days are removed; returns their ids. */
export function pruneDrafts(days: number, now = Date.now()): string[] {
  const cutoff = now - days * 86_400_000;
  const removed: string[] = [];
  for (const key of listProjectKeys()) {
    for (const pm of listIds(draftsDir(key), ".json")) {
      try {
        const path = join(draftsDir(key), `${pm}.json`);
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true });
          removed.push(pm);
        }
      } catch {
        /* gone already */
      }
    }
  }
  return removed;
}
