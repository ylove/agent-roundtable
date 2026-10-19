// ============================================================================
// The integration merge queue
//
// The runner merges finished task branches into rt/<tag>/integration one at a time, under the
// execution's git.lock, with `git merge --no-ff` in WORKTREES_DIR/<exe>/_integration. A conflicted
// merge is aborted at once, so the integration branch and worktree are never left half-merged.
//
// What happens next depends on where the conflict is (classifyConflict):
//  - inside the task's leases: prepareConflictResolution merges the integration branch into the
//    task worktree and leaves the conflict markers, and the worker is resumed to fix them; its
//    next commitLeasedPaths concludes that merge and the task is queued again;
//  - outside them: the runner escalates as `conflict`.
// Nothing here pushes. The runner never pushes to the base branch.
// ============================================================================

import { ID_RE, preview } from "./events.js";
import {
  assertNoGitlinksInIndex,
  assertNoGitlinksInTree,
  branchExists,
  gitIdentity,
  integrationBranch,
  openLinkedWorktree,
  openRepo,
  resolveCommit,
  runGit,
  taskBranch,
  type GitIdentity,
  type GitTarget,
} from "./git.js";
import { capPathList, pathCovered, type LeaseLike } from "./leases.js";
import type { EventDraft, EventSource, ExecutionHeader } from "./types.js";
import {
  checkRangeCoverage,
  ensureIntegrationWorktree,
  hasMergeHead,
  openWorktree,
  taskWorktreePath,
  unmergedPaths,
  withGitLock,
  worktreeStatus,
} from "./worktrees.js";

const MERGE_TIMEOUT_MS = 10 * 60_000;

export type MergeResult =
  | { ok: true; sha: string; /** The branch was already merged (a retry after a crash): no new commit. */ already: boolean }
  | { ok: false; reason: "conflict" | "violation" | "held"; conflicts: string[]; violations: string[] };

export interface MergeTaskOptions {
  /** Rechecked under git.lock immediately before changing the integration branch. */
  canMerge?: () => Promise<boolean>;
  /** Commit the acceptance under git.lock; false rolls the merge back if a hold won the race. */
  onMerged?: (sha: string) => Promise<boolean>;
  /** Immutable checked commit. Resolved before coverage and merge, never a moving ref. */
  commit?: string;
  /**
   * When given, the branch's changes since its merge base with the integration branch must be
   * covered by these leases (enforcement point 3); otherwise nothing is merged.
   */
  leases?: readonly LeaseLike[];
  /** How long to wait for git.lock (default 15 minutes). */
  lockTimeoutMs?: number;
  /** Default: gitIdentity of the main repository. */
  identity?: GitIdentity;
}

function checkTask(header: ExecutionHeader, taskId: string): string {
  if (typeof taskId !== "string" || !ID_RE.test(taskId)) throw new Error(`Not a task id: ${preview(taskId)}`);
  return taskBranch(header.id, taskId);
}

function trailers(header: ExecutionHeader, taskId: string): string {
  return `Roundtable-Execution: ${header.id}\nRoundtable-Task: ${taskId}`;
}

/** Leave the integration worktree exactly at its HEAD: no merge state, no changes, no untracked files. */
async function resetIntegration(t: GitTarget, to = "HEAD"): Promise<void> {
  if (await hasMergeHead(t)) await runGit(t, ["merge", "--abort"]);
  await runGit(t, ["reset", "-q", "--hard", to]);
  // Integration checks run here; their untracked output (not ignored output) could block a merge.
  await runGit(t, ["clean", "-ffdq"]);
}

/**
 * Merge rt/<tag>/<task> into the integration branch with --no-ff, serialized by git.lock. On a
 * conflict the merge is aborted and the conflicted files are returned; the integration branch
 * and worktree are left as they were. Merging a branch that is already merged returns its sha.
 */
export async function mergeTask(header: ExecutionHeader, taskId: string, opts: MergeTaskOptions = {}): Promise<MergeResult> {
  const branch = checkTask(header, taskId);
  return withGitLock(
    header.id,
    async () => {
      const integ = await ensureIntegrationWorktree(header);
      const repo = await openRepo(header.repo_root);
      const t = openLinkedWorktree(repo, integ.path);
      // Before anything touches the integration worktree: no submodule on either side (git.ts).
      await assertNoGitlinksInIndex(t);
      await assertNoGitlinksInTree(t, "HEAD");
      if (!(await branchExists(t, branch))) throw new Error(`Task ${taskId} has no branch ${branch}`);
      const commit = await resolveCommit(t, opts.commit ?? `refs/heads/${branch}`);
      await assertNoGitlinksInTree(t, commit);
      await resetIntegration(t);
      if (opts.leases) {
        const cov = await checkRangeCoverage(t, "HEAD", commit, opts.leases);
        if (!cov.ok) return { ok: false, reason: "violation", conflicts: [], violations: cov.violations };
      }
      const before = await resolveCommit(t, "HEAD");
      const identity = opts.identity ?? (await gitIdentity(repo));
      if (opts.canMerge && !await opts.canMerge()) return { ok: false, reason: "held", conflicts: [], violations: [] };
      const r = await runGit(
        t,
        ["merge", "--no-ff", "--no-edit", "--no-verify", "--no-stat", "-q", "-m", `rt: merge task ${taskId}`, "-m", trailers(header, taskId), commit],
        { identity, allowExit: [1], timeoutMs: MERGE_TIMEOUT_MS }
      );
      if (r.exit === 0) {
        if (opts.canMerge && !await opts.canMerge()) {
          await resetIntegration(t, before);
          return { ok: false, reason: "held", conflicts: [], violations: [] };
        }
        const sha = await resolveCommit(t, "HEAD");
        if (opts.onMerged && !await opts.onMerged(sha)) {
          await resetIntegration(t, before);
          return { ok: false, reason: "held", conflicts: [], violations: [] };
        }
        return { ok: true, sha, already: sha === before };
      }
      const conflicts = await unmergedPaths(t);
      await resetIntegration(t, before);
      if (!conflicts.length) throw new Error(`git merge of ${branch} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exit}`}`);
      return { ok: false, reason: "conflict", conflicts, violations: [] };
    },
    { timeoutMs: opts.lockTimeoutMs }
  );
}

export interface ConflictPreparation {
  /** Conflicted files, markers left in place for the worker. Empty when the merge was clean. */
  conflicts: string[];
  /** True when the integration branch merged cleanly and was committed on the task branch. */
  merged: boolean;
  /** The task worktree's HEAD. */
  head: string;
}

/**
 * Merge the integration branch into the task worktree and leave the conflict markers in place,
 * so the worker can be resumed to resolve them (its next commitLeasedPaths concludes the merge).
 * Idempotent: a worktree already mid-merge reports its remaining conflicts. The worktree must
 * have no uncommitted changes to tracked files (snapshot them first).
 */
export async function prepareConflictResolution(
  header: ExecutionHeader,
  taskId: string,
  opts: { identity?: GitIdentity } = {}
): Promise<ConflictPreparation> {
  checkTask(header, taskId);
  const path = taskWorktreePath(header.id, taskId);
  const w = await openWorktree(path);
  if (w.header.id !== header.id) throw new Error(`${path} belongs to execution ${w.header.id}`);
  const t = w.target;
  const status = await worktreeStatus(path);
  if (status.branch !== w.branch) throw new Error(`${path} is on ${status.branch ?? "a detached HEAD"}, not ${w.branch}`);
  if (status.merging) return { conflicts: status.conflicts, merged: false, head: status.head };
  const tracked = (await runGit(t, ["diff", "--name-only", "-z", "--ignore-submodules=all", "HEAD"])).stdout.split("\0").filter(Boolean);
  if (tracked.length) {
    throw new Error(`${path} has uncommitted changes (${tracked.slice(0, 10).join(", ")}); commit or snapshot them first`);
  }
  const integration = integrationBranch(header.id);
  if (!(await branchExists(t, integration))) throw new Error(`Execution ${header.id} has no integration branch yet`);
  await assertNoGitlinksInTree(t, `refs/heads/${integration}`);
  const identity = opts.identity ?? (await gitIdentity(w.repo));
  const r = await runGit(
    t,
    ["merge", "--no-ff", "--no-edit", "--no-verify", "--no-stat", "-q", "-m", `rt: sync ${integration} into ${taskId}`, "-m", trailers(header, taskId), `refs/heads/${integration}`],
    { identity, allowExit: [1], timeoutMs: MERGE_TIMEOUT_MS }
  );
  const head = await resolveCommit(t, "HEAD");
  if (r.exit === 0) return { conflicts: [], merged: true, head };
  const conflicts = await unmergedPaths(t);
  if (!conflicts.length) {
    if (await hasMergeHead(t)) await runGit(t, ["merge", "--abort"]);
    throw new Error(`git merge of ${integration} into ${taskId} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exit}`}`);
  }
  return { conflicts, merged: false, head };
}

/**
 * "inside" when every conflicted file is covered by the task's leases (the worker resolves it),
 * else "outside" (escalate as conflict). Pass the leases the task held when it submitted.
 */
export function classifyConflict(conflicts: readonly string[], taskLeases: readonly LeaseLike[]): "inside" | "outside" {
  return conflicts.every((p) => pathCovered(p, taskLeases)) ? "inside" : "outside";
}

/** Builders for the merge events; the caller supplies the source and appends them in transact. */
export const mergeDrafts = {
  succeeded: (task: string, sha: string, source: EventSource): EventDraft<"merge.succeeded"> => ({
    type: "merge.succeeded",
    source,
    payload: { task, sha },
  }),
  /** `files` is capped to fit the payload limit. */
  conflicted: (task: string, files: readonly string[], source: EventSource): EventDraft<"merge.conflicted"> => ({
    type: "merge.conflicted",
    source,
    payload: { task, files: capPathList(files) },
  }),
  taskMerged: (task: string, integrationSha: string, source: EventSource): EventDraft<"task.merged"> => ({
    type: "task.merged",
    source,
    payload: { task, integration_sha: integrationSha },
  }),
};
