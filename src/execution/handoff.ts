// ============================================================================
// Process operations an orchestrator tool hands to the runner
//
//   executions/<exe>/handoff/<key>.json   {v: 1, from, at, ops}   (0600, written atomically)
//
// resolve_escalation runs in the orchestrator server, but only the runner starts, resumes and stops
// workers. A resolution's process operations (WS10's resume_worker with its card, spawn_retry and
// kill_worker) are written here; the runner takes them on its next tick, deletes the file and
// applies each operation once by its deterministic key, stops before starts. A file that does not
// parse is moved aside as <name>.bad. Only the runner deletes files here.
// ============================================================================

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import type { ProcessOp } from "./escalation.js";
import { executionDir } from "./store.js";

export const handoffDir = (exe: string): string => join(executionDir(exe), "handoff");

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CARD_MAX = 64 * 1024;
const TEXT_MAX = 2000;
const FILE_MAX = 512 * 1024;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** The operation when it is well formed (a handoff file is data from another process), else null. */
function checkOp(v: unknown): ProcessOp | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!str(o.key, 300) || !str(o.target, 300) || !["escalation", "huddle", "lead"].includes(String(o.rule))) return null;
  switch (o.type) {
    case "resume_worker":
      return str(o.agent, 64) && ID_RE.test(o.agent) && str(o.task, 64) && ID_RE.test(o.task) && str(o.why, TEXT_MAX) && str(o.card, CARD_MAX) ? (o as unknown as ProcessOp) : null;
    case "spawn_retry":
      return str(o.task, 64) && ID_RE.test(o.task) && Number.isSafeInteger(o.attempt) && (o.attempt as number) > 0 ? (o as unknown as ProcessOp) : null;
    case "kill_worker":
      return str(o.agent, 64) && ID_RE.test(o.agent) && str(o.reason, TEXT_MAX) ? (o as unknown as ProcessOp) : null;
    default:
      return null;
  }
}

/** Hand operations to the runner of `exe`. Returns the file written, or null when there was nothing to hand over. */
export function writeHandoff(exe: string, ops: readonly ProcessOp[], from: string): string | null {
  const valid = ops.filter((op) => checkOp(op) !== null);
  if (!valid.length) return null;
  const dir = handoffDir(exe);
  mkdirPrivate(dir);
  const key = createHash("sha256").update(valid.map((op) => `${op.type}\0${op.key}`).join("\n")).digest("hex").slice(0, 24);
  const path = join(dir, `${key}.json`);
  writeFileAtomic(path, JSON.stringify({ v: 1, from, at: new Date().toISOString(), ops: valid }) + "\n");
  return path;
}

/**
 * Take every handed-over operation (oldest file first) and delete the files: kills first, then
 * resumes and retries. For the runner only.
 */
export function takeHandoffs(exe: string): ProcessOp[] {
  const dir = handoffDir(exe);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^[0-9a-f]{24}\.json$/.test(n));
  } catch {
    return [];
  }
  const files: Array<{ at: string; ops: ProcessOp[] }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const text = readFileSync(path, "utf8");
      if (text.length > FILE_MAX) throw new Error("too large");
      const body = JSON.parse(text) as { v?: unknown; at?: unknown; ops?: unknown };
      if (body.v !== 1 || !Array.isArray(body.ops)) throw new Error("not a handoff");
      files.push({ at: typeof body.at === "string" ? body.at : "", ops: body.ops.map(checkOp).filter((op): op is ProcessOp => op !== null) });
      rmSync(path, { force: true });
    } catch {
      try {
        renameSync(path, `${path}.bad`);
      } catch {
        /* gone meanwhile */
      }
    }
  }
  const ops = files.sort((a, b) => a.at.localeCompare(b.at)).flatMap((f) => f.ops);
  return [...ops.filter((op) => op.type === "kill_worker"), ...ops.filter((op) => op.type !== "kill_worker")];
}
