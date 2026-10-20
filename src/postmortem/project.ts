// ============================================================================
// Projects: which repository a postmortem belongs to, and whether the mode is on (§2, §3)
// ============================================================================

import { createHash } from "node:crypto";
import { assertNoGitlinksInIndex, assertNoGitlinksInTree, openRepo, SubmodulesUnsupportedError } from "../execution/git.js";
import { resolveRepo } from "../execution/contract-lifecycle.js";
import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { appendLog, projectKeyOf, readProject, withProjectLock, writeProject } from "./store.js";
import { LIMITS, PROJECT_KEY_RE, type ProjectFile } from "./types.js";

export interface ProjectRef {
  key: string;
  /** The repository's real root path. */
  root: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The project a host argument names: an existing project_key, or a directory inside a git work
 * tree (its top level, resolved with git rev-parse --show-toplevel) that holds no submodules.
 */
export async function resolveProject(ref: string): Promise<ProjectRef> {
  const arg = typeof ref === "string" ? ref.trim() : "";
  if (!arg) throw new Error("project is required: a repository directory or a project_key");
  if (PROJECT_KEY_RE.test(arg)) {
    const p = readProject(arg);
    if (p) return { key: p.key, root: p.repo_root };
  }
  let root: string;
  try {
    root = (await resolveRepo(arg)).root;
  } catch (e) {
    throw new Error(`project ${JSON.stringify(arg.slice(0, 200))} is neither a known project_key nor a directory inside a git work tree (${errText(e)})`);
  }
  try {
    const repo = await openRepo(root);
    await assertNoGitlinksInIndex(repo);
    await assertNoGitlinksInTree(repo, "HEAD");
  } catch (e) {
    if (e instanceof SubmodulesUnsupportedError) {
      throw new Error(`project ${root} uses git submodules, which postmortem projects (like heads-down runs) do not support: ${errText(e)}`);
    }
    throw e;
  }
  return { key: projectKeyOf(root), root };
}

export function isEnabled(key: string): boolean {
  try {
    return readProject(key)?.postmortem.enabled === true;
  } catch {
    return false;
  }
}

/** Refuse unless the project has postmortem mode on: no tool turns it on by itself. */
export function requireEnabled(p: ProjectRef): void {
  if (!isEnabled(p.key)) {
    throw new Error(
      `Postmortem mode is off for project ${p.key}. It turns on only when the human asks for postmortem meetings or retrospectives: ` +
        `call postmortem(action: "enable", project, reason) with their words.`
    );
  }
}

/** Turn the mode on or off for a project; `reason` carries the human's words, recorded in the log and the audit log. */
export async function setEnabled(p: ProjectRef, enabled: boolean, reasonRaw: string): Promise<ProjectFile> {
  const reason = scrub(reasonRaw ?? "").trim();
  if (!reason) throw new Error(`reason is required: quote the human's words asking to ${enabled ? "turn postmortem mode on" : "turn it off"}`);
  if (reason.length > LIMITS.reason) throw new Error(`reason is longer than ${LIMITS.reason} characters`);
  const at = new Date().toISOString();
  const digest = createHash("sha256").update(reason).digest("hex");
  const file = await withProjectLock(p.key, () => {
    const cur = readProject(p.key) ?? { v: 1 as const, key: p.key, repo_root: p.root, created: at, postmortem: { enabled: false } };
    const next: ProjectFile = {
      ...cur,
      postmortem: enabled ? { enabled: true, since: at, reason_sha256: digest, by: "orchestrator" } : { ...cur.postmortem, enabled: false },
    };
    writeProject(next);
    appendLog(p.key, { at, action: enabled ? "enable" : "disable", by: "orchestrator", reason, reason_sha256: digest });
    return next;
  });
  await appendAudit({
    actor: "orchestrator",
    action: enabled ? "postmortem.enabled" : "postmortem.disabled",
    target: p.key,
    details: { reason, reason_sha256: digest, repo_root: p.root },
  });
  return file;
}
