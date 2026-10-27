// ============================================================================
// Task worktrees, lease enforcement and leased commits
//
//   WORKTREES_DIR/<exe>/_integration   branch rt/<tag>/integration, started at base_sha
//   WORKTREES_DIR/<exe>/<task>         branch rt/<tag>/<task>, started at base_sha, or at the
//                                      integration head once the task has accepted dependencies
//
// The task owns its branch and worktree; agents come and go, so every ensure* call is idempotent
// and a resumed run finds the same worktree on the same branch. Operations that change the
// repository's shared state (creating, removing and pruning worktrees and branches, merging into
// the integration branch) hold the execution's git.lock; within one async call chain the lock is
// reentrant, so a locked operation can call another one.
//
// A worktree is only ever opened through its location: it must sit at WORKTREES_DIR/<exe>/<name>,
// and the execution's header names the main repository whose records must confirm it (git.ts). Every
// git call here goes through runGit's hardening.
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { WORKTREES_DIR } from "../config.js";
import { EXECUTION_ID_RE } from "../ids.js";
import { mkdirPrivate, readRegularFile } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { ID_RE, preview } from "./events.js";
import {
  assertNoGitlinksInIndex,
  assertNoGitlinksInTree,
  branchExists,
  findWorktreeAdmin,
  gitIdentity,
  GitSafetyError,
  integrationBranch,
  openLinkedWorktree,
  openRepo,
  populateWorktree,
  resolveCommit,
  runGit,
  splitZ,
  taskBranch,
  validTaskRefName,
  type GitIdentity,
  type GitTarget,
} from "./git.js";
import { hasDotGitSegment, isGitMetadataPath, matchGlob, pathCovered, type LeaseLike } from "./leases.js";
import { withLock, type LockOptions } from "./lock.js";
import { executionDir } from "./store.js";
import type { BlackboardState, ExecutionHeader } from "./types.js";

// ============================================================================
// Names and locations
// ============================================================================

/** The integration worktree's directory name (task ids start with [a-z0-9], so it never collides). */
export const INTEGRATION_WORKTREE = "_integration";

export function executionWorktreesDir(executionId: string): string {
  if (typeof executionId !== "string" || !EXECUTION_ID_RE.test(executionId)) throw new Error(`Not an execution id: ${preview(executionId)}`);
  return join(WORKTREES_DIR, executionId);
}

export function taskWorktreePath(executionId: string, task: string): string {
  taskBranch(executionId, task); // validates the id
  return join(executionWorktreesDir(executionId), task);
}

export function integrationWorktreePath(executionId: string): string {
  return join(executionWorktreesDir(executionId), INTEGRATION_WORKTREE);
}

/** Where submission checks check out the commit under test: executions/<exe>/checks, out of every worker's reach. */
export function executionChecksDir(executionId: string): string {
  return join(executionDir(executionId), "checks");
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function checkHeader(h: ExecutionHeader): void {
  if (!h || typeof h !== "object" || typeof h.id !== "string" || !EXECUTION_ID_RE.test(h.id)) throw new Error("Not an execution header");
  if (typeof h.repo_root !== "string" || !isAbsolute(h.repo_root)) throw new Error(`Execution ${h.id}: repo_root must be an absolute path`);
  if (typeof h.base_sha !== "string" || !SHA_RE.test(h.base_sha)) throw new Error(`Execution ${h.id}: base_sha must be a full commit id`);
}

function readHeader(executionId: string): ExecutionHeader {
  let h: ExecutionHeader;
  try {
    h = JSON.parse(readFileSync(join(executionDir(executionId), "execution.json"), "utf8")) as ExecutionHeader;
  } catch {
    throw new GitSafetyError(`Execution ${executionId} not found`);
  }
  if (!h || h.schema !== 1 || h.id !== executionId) throw new GitSafetyError(`Execution ${executionId}: execution.json is not a schema 1 header for this id`);
  checkHeader(h);
  return h;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Where a path sits under WORKTREES_DIR: [execution id, worktree name], or a GitSafetyError. */
function locate(path: string): { exe: string; name: string; path: string } {
  if (typeof path !== "string" || !isAbsolute(path)) throw new GitSafetyError(`Not a worktree path: ${preview(path)}`);
  const root = real(WORKTREES_DIR);
  // The parents are resolved, the worktree itself never: a symlink in its place is refused later
  // (canonicalWorkdir), not followed to whatever it names.
  const resolved = join(real(dirname(path)), basename(path));
  const parts = relative(root, resolved).split(sep);
  const [exe, name] = parts;
  if (parts.length !== 2 || !EXECUTION_ID_RE.test(exe ?? "") || !(name === INTEGRATION_WORKTREE || validTaskRefName(name ?? ""))) {
    throw new GitSafetyError(`${path} is not a roundtable worktree (expected ${join(WORKTREES_DIR, "<execution>", "<task>")})`);
  }
  return { exe, name, path: resolved };
}

function branchFor(exe: string, name: string): string {
  return name === INTEGRATION_WORKTREE ? integrationBranch(exe) : taskBranch(exe, name);
}

export interface OpenWorktree {
  header: ExecutionHeader;
  /** The main repository. */
  repo: GitTarget;
  /** The worktree itself. */
  target: GitTarget;
  /** The task id, or INTEGRATION_WORKTREE. */
  name: string;
  /** The branch this worktree must be on. */
  branch: string;
}

/** Refuse a worktree whose index or HEAD holds a gitlink, before anything inspects its files. */
async function assertNoSubmodules(t: GitTarget): Promise<void> {
  await assertNoGitlinksInIndex(t);
  await assertNoGitlinksInTree(t, "HEAD");
}

/**
 * Open a roundtable worktree by path, confirmed by its execution's main repository's records.
 * A worktree with a submodule is refused (SubmodulesUnsupportedError).
 */
export async function openWorktree(path: string): Promise<OpenWorktree> {
  const loc = locate(path);
  const header = readHeader(loc.exe);
  const repo = await openRepo(header.repo_root);
  const target = openLinkedWorktree(repo, loc.path);
  await assertNoSubmodules(target);
  return { header, repo, target, name: loc.name, branch: branchFor(loc.exe, loc.name) };
}

async function currentBranch(t: GitTarget): Promise<string | null> {
  const r = await runGit(t, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] });
  const ref = r.stdout.trim();
  return r.exit === 0 && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

async function expectBranch(w: OpenWorktree): Promise<void> {
  const b = await currentBranch(w.target);
  if (b !== w.branch) throw new Error(`${w.target.workTree} is on ${b ?? "a detached HEAD"}, not ${w.branch}`);
}

// ============================================================================
// git.lock (reentrant within one async call chain)
// ============================================================================

const GIT_LOCK: LockOptions = { staleMs: 10_000, timeoutMs: 15 * 60_000 };
const heldGitLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run fn holding executions/<exe>/git.lock. Nested calls in the same async chain do not re-take it. */
export async function withGitLock<T>(executionId: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const held = heldGitLocks.getStore();
  if (held?.has(executionId)) return fn();
  const lockOpts = opts.timeoutMs ? { ...GIT_LOCK, timeoutMs: opts.timeoutMs } : GIT_LOCK;
  return withLock(join(executionDir(executionId), "git.lock"), lockOpts, () =>
    heldGitLocks.run(new Set([...(held ?? []), executionId]), fn)
  );
}

// ============================================================================
// Creating and reusing worktrees
// ============================================================================

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  /** False when an existing worktree on the right branch was reused. */
  created: boolean;
}

const ADD_TIMEOUT_MS = 10 * 60_000;

async function ensureWorktree(header: ExecutionHeader, name: string, startPoint: () => Promise<string>): Promise<WorktreeInfo> {
  checkHeader(header);
  const branch = branchFor(header.id, name);
  return withGitLock(header.id, async () => {
    const repo = await openRepo(header.repo_root);
    mkdirPrivate(WORKTREES_DIR);
    const exeDir = executionWorktreesDir(header.id);
    mkdirPrivate(exeDir);
    const path = join(realpathSync(exeDir), name);
    const admin = findWorktreeAdmin(repo, path);
    if (existsSync(path)) {
      if (admin) {
        const target = openLinkedWorktree(repo, path);
        await assertNoSubmodules(target);
        const on = await currentBranch(target);
        if (on !== branch) throw new Error(`${path} is checked out on ${on ?? "a detached HEAD"}, not ${branch}`);
        return { path: target.workTree, branch, head: await resolveCommit(target, "HEAD"), created: false };
      }
      // An unregistered directory is reused only when empty (an interrupted create).
      if (lstatSync(path).isSymbolicLink() || readdirSync(path).length) {
        throw new Error(`${path} exists and is not a worktree of ${header.repo_root}`);
      }
    } else if (admin) {
      rmSync(admin, { recursive: true, force: true }); // a stale record: its directory is gone
    }
    // Refused before anything is created or checked out: submodules are not supported (git.ts).
    let args: string[];
    if (await branchExists(repo, branch)) {
      await assertNoGitlinksInTree(repo, `refs/heads/${branch}`);
      args = ["worktree", "add", "--no-checkout", "-q", path, branch];
    } else {
      const start = await startPoint();
      await assertNoGitlinksInTree(repo, start);
      args = ["worktree", "add", "--no-checkout", "-q", "-b", branch, path, start];
    }
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    mkdirPrivate(path);
    try {
      await runGit(repo, args, { timeoutMs: ADD_TIMEOUT_MS });
      await populateWorktree(openLinkedWorktree(repo, path), { timeoutMs: ADD_TIMEOUT_MS });
    } catch (e) {
      const left = findWorktreeAdmin(repo, path);
      if (left) rmSync(left, { recursive: true, force: true });
      rmSync(path, { recursive: true, force: true });
      throw e;
    }
    const target = openLinkedWorktree(repo, path);
    return { path: target.workTree, branch, head: await resolveCommit(target, "HEAD"), created: true };
  });
}

/** WORKTREES_DIR/<exe>/_integration on rt/<tag>/integration, created at base_sha the first time. */
export function ensureIntegrationWorktree(header: ExecutionHeader): Promise<WorktreeInfo> {
  return ensureWorktree(header, INTEGRATION_WORKTREE, async () => resolveCommit(await openRepo(header.repo_root), header.base_sha));
}

/**
 * Where a new task branch starts: "integration" when the task depends on an accepted task (so it
 * builds on merged work), else "base".
 */
export function taskStartPoint(state: Readonly<BlackboardState>, taskId: string): "base" | "integration" {
  const rt = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
  const accepted = (rt?.spec.depends_on ?? []).some((d) => Object.hasOwn(state.tasks, d) && state.tasks[d].state === "accepted");
  return accepted || rt?.spec.parent ? "integration" : "base";
}

/**
 * WORKTREES_DIR/<exe>/<task> on rt/<tag>/<task>. A new branch starts at `startPoint`: "base"
 * (base_sha, the default), "integration" (the integration head) or a commit id. An existing
 * worktree on the right branch is reused as it is, and an existing branch is checked out where
 * it stands, so resumes keep their work. The integration worktree is ensured first, so the
 * integration branch always exists to measure the task against.
 */
export async function ensureTaskWorktree(header: ExecutionHeader, taskId: string, startPoint: string = "base"): Promise<WorktreeInfo> {
  checkHeader(header);
  if (typeof taskId !== "string" || !ID_RE.test(taskId)) throw new Error(`Not a task id: ${preview(taskId)}`);
  taskBranch(header.id, taskId);
  if (startPoint !== "base" && startPoint !== "integration" && !SHA_RE.test(startPoint)) {
    throw new Error(`startPoint must be "base", "integration" or a full commit id, not ${preview(startPoint)}`);
  }
  return withGitLock(header.id, async () => {
    await ensureIntegrationWorktree(header);
    return ensureWorktree(header, taskId, async () => {
      const repo = await openRepo(header.repo_root);
      if (startPoint === "base") return resolveCommit(repo, header.base_sha);
      if (startPoint === "integration") return resolveCommit(repo, `refs/heads/${integrationBranch(header.id)}`);
      return resolveCommit(repo, startPoint);
    });
  });
}

// ============================================================================
// Check checkouts
// ============================================================================

/** Remove a check checkout: through git when its record still matches, else by hand. Never throws. */
async function dropCheckout(repo: GitTarget, path: string): Promise<void> {
  const admin = findWorktreeAdmin(repo, path);
  try {
    if (admin && existsSync(path)) {
      openLinkedWorktree(repo, path);
      await runGit(repo, ["worktree", "remove", "--force", path]);
    }
  } catch {
    /* tampered or half-made: removed by hand below */
  }
  rmSync(path, { recursive: true, force: true });
  const left = findWorktreeAdmin(repo, path) ?? admin;
  if (left) rmSync(left, { recursive: true, force: true });
}

/**
 * Run fn in a fresh detached checkout of `commit` (a full commit id), made for one submission's
 * checks under executions/<exe>/checks/<label>-<random> and removed afterwards. Worker tools never
 * reach that directory, so a check sees exactly the committed bytes, whatever the worker does to its
 * worktree meanwhile. The checkout's .git is a gitfile, which the docker backend mounts read-only.
 */
export async function withCommitCheckout<T>(header: ExecutionHeader, label: string, commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
  checkHeader(header);
  if (typeof label !== "string" || !ID_RE.test(label)) throw new Error(`Not a checkout label: ${preview(label)}`);
  if (typeof commit !== "string" || !SHA_RE.test(commit)) throw new Error(`commit must be a full commit id, not ${preview(commit)}`);
  const repo = await openRepo(header.repo_root);
  const dir = await withGitLock(header.id, async () => {
    if (await resolveCommit(repo, commit) !== commit) throw new GitSafetyError(`${commit} is not a commit of ${header.repo_root}`);
    await assertNoGitlinksInTree(repo, commit);
    const base = executionChecksDir(header.id);
    mkdirPrivate(base);
    const path = join(realpathSync(base), `${label}-${randomBytes(6).toString("hex")}`);
    mkdirSync(path, { mode: 0o700 });
    try {
      await runGit(repo, ["worktree", "add", "--no-checkout", "-q", "--detach", path, commit], { timeoutMs: ADD_TIMEOUT_MS });
      await populateWorktree(openLinkedWorktree(repo, path), { timeoutMs: ADD_TIMEOUT_MS });
      return openLinkedWorktree(repo, path).workTree;
    } catch (e) {
      await dropCheckout(repo, path);
      throw e;
    }
  });
  try {
    return await fn(dir);
  } finally {
    await withGitLock(header.id, () => dropCheckout(repo, dir));
  }
}

// ============================================================================
// Removing and pruning
// ============================================================================

/** Remove a worktree (its files and its record). The branch stays unless deleteBranch is set. */
export async function removeWorktree(path: string, opts: { deleteBranch?: boolean } = {}): Promise<{ removed: boolean; branch: string }> {
  const loc = locate(path);
  const header = readHeader(loc.exe);
  const repo = await openRepo(header.repo_root);
  const branch = branchFor(loc.exe, loc.name);
  return withGitLock(loc.exe, async () => {
    const admin = findWorktreeAdmin(repo, loc.path);
    let removed = false;
    if (existsSync(loc.path)) {
      let viaGit = false;
      if (admin) {
        try {
          openLinkedWorktree(repo, loc.path);
          await runGit(repo, ["worktree", "remove", "--force", loc.path]);
          viaGit = true;
        } catch {
          /* tampered or half-made: removed by hand below */
        }
      }
      if (!viaGit) {
        rmSync(loc.path, { recursive: true, force: true });
        if (admin) rmSync(admin, { recursive: true, force: true });
      }
      removed = true;
    } else if (admin) {
      rmSync(admin, { recursive: true, force: true });
      removed = true;
    }
    if (opts.deleteBranch && (await branchExists(repo, branch))) await runGit(repo, ["branch", "-q", "-D", branch]);
    return { removed, branch };
  });
}

export interface PruneResult {
  /** Records dropped because their directories were gone. */
  pruned: string[];
  /** Worktrees removed (with remove: true). */
  removed: string[];
  /** Branches deleted (with branches: true). */
  branches: string[];
}

/**
 * Drop the execution's stale worktree records (directories that are gone; other worktrees of the
 * repository are never touched). With remove, also remove all of its worktrees, any check
 * checkouts a crash left behind, and their directories; with branches, also delete its
 * rt/<tag>/* branches.
 */
export async function pruneWorktrees(
  execution: string | ExecutionHeader,
  opts: { remove?: boolean; branches?: boolean } = {}
): Promise<PruneResult> {
  const header = typeof execution === "string" ? readHeader(execution) : execution;
  checkHeader(header);
  const repo = await openRepo(header.repo_root);
  const exeDir = executionWorktreesDir(header.id);
  return withGitLock(header.id, async () => {
    const out: PruneResult = { pruned: [], removed: [], branches: [] };
    const realExe = real(exeDir);
    const checksDir = executionChecksDir(header.id);
    const realChecks = real(checksDir);
    const base = join(repo.commonDir, "worktrees");
    for (const name of existsSync(base) ? readdirSync(base) : []) {
      const admin = join(base, name);
      let wt: string;
      try {
        wt = dirname(posix.resolve(admin, readFileSync(join(admin, "gitdir"), "utf8").trim()));
      } catch {
        continue;
      }
      const isCheck = dirname(wt) === realChecks || dirname(wt) === checksDir;
      if (!isCheck && dirname(wt) !== realExe && dirname(wt) !== exeDir) continue;
      if (isCheck && existsSync(wt)) {
        // A check checkout left by a crash: nothing in it is worth keeping.
        if (opts.remove) {
          await dropCheckout(repo, wt);
          out.removed.push(wt);
        }
        continue;
      }
      if (!existsSync(wt)) {
        rmSync(admin, { recursive: true, force: true });
        out.pruned.push(wt);
      } else if (opts.remove) {
        await removeWorktree(wt);
        out.removed.push(wt);
      }
    }
    if (opts.remove && existsSync(exeDir)) {
      for (const leftover of readdirSync(exeDir)) {
        rmSync(join(exeDir, leftover), { recursive: true, force: true });
        out.removed.push(join(realExe, leftover));
      }
      rmSync(exeDir, { recursive: true, force: true });
    }
    if (opts.remove) rmSync(checksDir, { recursive: true, force: true });
    if (opts.branches) {
      const prefix = `refs/heads/${dirname(integrationBranch(header.id))}/`;
      const r = await runGit(repo, ["for-each-ref", "--format=%(refname)", prefix]);
      for (const ref of r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(prefix))) {
        const b = ref.slice("refs/heads/".length);
        await runGit(repo, ["branch", "-q", "-D", b]);
        out.branches.push(b);
      }
    }
    return out;
  });
}

// ============================================================================
// Status
// ============================================================================

interface StatusEntry {
  /** Two-letter porcelain v1 code: index then work tree. */
  xy: string;
  path: string;
}

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Anything that reads the working tree (status, a diff against the index or HEAD) passes this:
 * git must never start a child in a submodule's directory, whose .git agents can write (git.ts).
 */
const WORKTREE_SUBMODULES = "--ignore-submodules=all";
/**
 * Diffs between two commits, or between the index and a commit, never read a working directory,
 * so they keep gitlink changes visible (enforcement refuses them) with this.
 */
const TREE_SUBMODULES = "--ignore-submodules=none";

/** Porcelain v1 status, every untracked file listed, renames off, submodules never entered. */
async function statusEntries(t: GitTarget): Promise<StatusEntry[]> {
  const r = await runGit(t, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", WORKTREE_SUBMODULES]);
  return splitZ(r.stdout)
    .filter((rec) => rec.length > 3)
    .map((rec) => ({ xy: rec.slice(0, 2), path: rec.slice(3) }));
}

/** True while a merge is in progress in the target (MERGE_HEAD exists). */
export async function hasMergeHead(t: GitTarget): Promise<boolean> {
  const r = await runGit(t, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowExit: [1] });
  return r.exit === 0;
}

/** Paths with unmerged index entries (a merge stopped on conflicts). */
export async function unmergedPaths(t: GitTarget): Promise<string[]> {
  const r = await runGit(t, ["diff", "--name-only", "-z", "--diff-filter=U", WORKTREE_SUBMODULES]);
  return [...new Set(splitZ(r.stdout))];
}

export interface WorktreeStatus {
  path: string;
  branch: string | null;
  head: string;
  /** Every changed, deleted or untracked path (a nested repository is listed as "dir/"). */
  dirty: string[];
  /** A merge is in progress (prepareConflictResolution left it for the worker). */
  merging: boolean;
  conflicts: string[];
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const w = await openWorktree(path);
  const t = w.target;
  const entries = await statusEntries(t);
  return {
    path: t.workTree,
    branch: await currentBranch(t),
    head: await resolveCommit(t, "HEAD"),
    dirty: entries.map((e) => e.path),
    merging: await hasMergeHead(t),
    conflicts: entries.filter((e) => UNMERGED.has(e.xy)).map((e) => e.path),
  };
}

// ============================================================================
// Enforcement: what a branch changed, and whether its leases cover it
// ============================================================================

export interface ChangedPath {
  /** A, M, D, T, R, C, U or X (similarity scores dropped). */
  status: string;
  path: string;
  /** The source path of a rename or copy. */
  from?: string;
  /** Destination mode ("000000" when deleted; "160000" a gitlink, "120000" a symlink). */
  mode: string;
  /** Destination object id. */
  sha: string;
}

/** `git diff --raw -z -M` between two commits (both sides of renames kept), or the index against `from` when `to` is null. */
async function rawChanges(t: GitTarget, from: string, to: string | null): Promise<ChangedPath[]> {
  const args =
    to === null
      ? ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", TREE_SUBMODULES, from]
      : ["diff", "--raw", "-z", "--no-abbrev", "-M", TREE_SUBMODULES, from, to];
  const parts = splitZ((await runGit(t, args)).stdout);
  const out: ChangedPath[] = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
    if (!meta) throw new Error(`Unexpected git diff --raw output near ${preview(parts[i])}`);
    const status = meta[5];
    if (status === "R" || status === "C") {
      out.push({ status, from: parts[i + 1], path: parts[i + 2], mode: meta[2], sha: meta[4] });
      i += 2;
    } else {
      out.push({ status, path: parts[i + 1], mode: meta[2], sha: meta[4] });
      i += 1;
    }
  }
  return out;
}

async function mergeBaseOf(t: GitTarget, a: string, b: string): Promise<string> {
  const ca = await resolveCommit(t, a);
  const cb = await resolveCommit(t, b);
  const r = await runGit(t, ["merge-base", ca, cb], { allowExit: [1] });
  const sha = r.stdout.trim();
  if (r.exit !== 0 || !SHA_RE.test(sha)) throw new Error(`${preview(a)} and ${preview(b)} have no common ancestor`);
  return sha;
}

/** The merge base of the worktree's HEAD and `ref`. */
export async function mergeBase(worktree: string, ref: string): Promise<string> {
  const w = await openWorktree(worktree);
  return mergeBaseOf(w.target, "HEAD", ref);
}

/**
 * What HEAD changed since its merge base with `base` (like `git diff base...HEAD`). Pass the
 * integration branch: for a fresh task that is base_sha, and after prepareConflictResolution it
 * is the integration head, so other tasks' merged work never counts as this task's.
 */
export async function changedPaths(worktree: string, base: string): Promise<ChangedPath[]> {
  const w = await openWorktree(worktree);
  return rawChanges(w.target, await mergeBaseOf(w.target, "HEAD", base), "HEAD");
}

/** Both sides of every rename and copy: a rename out of a leased directory touches both paths. */
export function touchedPaths(changes: readonly ChangedPath[]): string[] {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.from !== undefined) out.add(c.from);
    out.add(c.path);
  }
  return [...out];
}

export interface Violation {
  path: string;
  reason: "not leased" | "git metadata needs an explicit lease" | "inside .git" | "nested repository" | "symlink leaves the worktree";
}

export interface CoverageResult {
  ok: boolean;
  /** The merge base the changes were measured from. */
  base: string;
  /** Violating paths, without duplicates. */
  violations: string[];
  details: Violation[];
  changes: ChangedPath[];
}

type LinkEntry = { kind: "directory" | "file" } | { kind: "symlink"; target: string };
type LinkLookup = (path: string) => Promise<LinkEntry | undefined>;

/**
 * True for unsafe or uncertain resolution, including dangling links and >40 symlink hops.
 * lookup reads entries without following their final component, from one proposed tree.
 * Expand links BEFORE processing subsequent `..` segments; lexical normalization is unsafe.
 */
export async function symlinkEscapes(linkPath: string, lookup: LinkLookup): Promise<boolean> {
  const pending = linkPath.split("/");
  const resolved: string[] = [];
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) return true;
      resolved.pop();
      continue;
    }
    // Git metadata is not part of the proposed source tree.
    if (part.toLowerCase() === ".git") return true;
    let entry: LinkEntry | undefined;
    try {
      entry = await lookup([...resolved, part].join("/"));
    } catch {
      return true;
    }
    if (!entry) return true; // Dangling links are refused, even when lexically in-root.
    if (entry.kind === "symlink") {
      const target = entry.target;
      if (++hops > 40 || !target || /[\0\\\uFFFD]/.test(target) || posix.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith("~")) return true;
      pending.unshift(...target.split("/"));
    } else {
      resolved.push(part);
      if (entry.kind !== "directory" && pending.length) return true;
    }
  }
  return false;
}

/** Resolve ALL links in an immutable Git tree, including unchanged links affected by edits. */
async function unsafeTreeSymlinks(t: GitTarget, tree: string): Promise<Violation[]> {
  const entries = new Map<string, { mode: string; sha: string }>();
  const listing = await runGit(t, ["ls-tree", "-r", "-t", "-z", "--full-tree", tree]);
  for (const rec of splitZ(listing.stdout)) {
    const match = /^(\d{6}) (?:blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
    if (!match || match[3].includes("\uFFFD")) throw new GitSafetyError("Cannot safely read proposed tree paths");
    entries.set(match[3], { mode: match[1], sha: match[2] });
  }
  const targets = new Map<string, string>();
  const lookup: LinkLookup = async (path) => {
    const entry = entries.get(path);
    if (!entry) return undefined;
    if (entry.mode === "040000") return { kind: "directory" };
    if (entry.mode === "100644" || entry.mode === "100755") return { kind: "file" };
    if (entry.mode !== "120000") return undefined;
    let target = targets.get(entry.sha);
    if (target === undefined) {
      // Oversized/unreadable targets fail closed; never validate truncated blob contents.
      target = (await runGit(t, ["cat-file", "blob", entry.sha], { maxOutputBytes: 4096 })).stdout;
      targets.set(entry.sha, target);
    }
    return { kind: "symlink", target };
  };
  const out: Violation[] = [];
  for (const [path, entry] of entries) {
    if (entry.mode === "120000" && await symlinkEscapes(path, lookup)) out.push({ path, reason: "symlink leaves the worktree" });
  }
  return out;
}

async function judge(changes: readonly ChangedPath[], leases: readonly LeaseLike[] | null): Promise<Violation[]> {
  const out: Violation[] = [];
  const add = (path: string, reason: Violation["reason"]) => {
    if (!out.some((v) => v.path === path && v.reason === reason)) out.push({ path, reason });
  };
  for (const c of changes) {
    for (const p of c.from !== undefined ? [c.from, c.path] : [c.path]) {
      if (hasDotGitSegment(p)) add(p, "inside .git");
      else if (leases && !pathCovered(p, leases)) {
        add(p, isGitMetadataPath(p) && globMatched(p, leases) ? "git metadata needs an explicit lease" : "not leased");
      }
    }
    if (c.status === "D") continue;
    if (c.mode === "160000") add(c.path, "nested repository");
  }
  return out;
}

/** Some lease glob matches the path, ignoring the metadata rule ("needs an explicit lease" vs "not leased"). */
function globMatched(path: string, leases: readonly LeaseLike[]): boolean {
  return leases.some((l) => l.paths.some((g) => matchGlob(g, path)));
}

/**
 * Lease enforcement for submit and merge: every path HEAD changed since its merge base with
 * `base` (both sides of renames) must be covered by `leases`; .git* metadata needs an explicit
 * lease; gitlinks and unsafe symlink chains (including dangling links) are refused outright.
 */
export async function checkLeaseCoverage(worktree: string, base: string, leases: readonly LeaseLike[], tip = "HEAD"): Promise<CoverageResult> {
  const w = await openWorktree(worktree);
  return checkRangeCoverage(w.target, base, tip, leases);
}

/** checkLeaseCoverage for an arbitrary tip in an open target (the merge queue checks a branch). */
export async function checkRangeCoverage(t: GitTarget, base: string, tip: string, leases: readonly LeaseLike[]): Promise<CoverageResult> {
  const commit = await resolveCommit(t, tip);
  const mb = await mergeBaseOf(t, commit, base);
  const changes = await rawChanges(t, mb, commit);
  const details = [...await judge(changes, leases), ...await unsafeTreeSymlinks(t, commit)];
  return { ok: details.length === 0, base: mb, violations: [...new Set(details.map((d) => d.path))], details, changes };
}

// ============================================================================
// Commits
// ============================================================================

/** A commit was refused: staged paths outside the leases, unresolved conflicts or conflict markers. */
export class CommitRefusedError extends Error {
  constructor(message: string, readonly paths: string[]) {
    super(message);
    this.name = "CommitRefusedError";
  }
}

export interface CommitTrailers {
  execution: string;
  task: string;
  agent?: string;
}

export interface CommitOptions {
  message: string;
  trailers: Required<CommitTrailers>;
  /**
   * Measure stat, files and rewrites from the merge base with this ref (pass the integration
   * branch to describe the whole task, as task.submitted wants). Default: this commit alone.
   */
  summaryBase?: string;
  /** Default: gitIdentity of the main repository. */
  identity?: GitIdentity;
}

export interface DiffSummary {
  /** `git diff --shortstat`, e.g. "2 files changed, 10 insertions(+), 1 deletion(-)". */
  stat: string;
  /** Every path touched (renames as both paths). */
  files: string[];
  /** Paths git reports as complete rewrites (-B). */
  rewrites: string[];
}

export interface CommitResult extends DiffSummary {
  /** The new commit, or HEAD when there was nothing to commit. */
  commit: string;
  created: boolean;
  /** Changed paths outside the leases, left uncommitted in the worktree. */
  uncovered: string[];
  /** Paths never committed whatever the leases: nested repositories, .git paths, escaping symlinks. */
  rejected: Violation[];
}

const MESSAGE_MAX = 16 * 1024;
const MARKER_RE = /^(?:<{7}|>{7})(?: |$)/m;

function trailerValue(name: string, v: string | undefined, re?: RegExp): string {
  if (typeof v !== "string" || !v.trim() || v.length > 128 || /[\0-\x1f\x7f]/.test(v) || (re && !re.test(v))) {
    throw new Error(`Invalid ${name} trailer value ${preview(v)}`);
  }
  return v.trim();
}

/** Scrubbed message without forged Roundtable-* trailers, then our trailers. */
export function buildCommitMessage(message: string, trailers: CommitTrailers): string {
  let text = scrub(typeof message === "string" ? message : "").replace(/\0/g, "").replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .filter((l) => !/^\s*roundtable-[a-z-]*\s*:/i.test(l))
    .join("\n")
    .trim();
  if (text.length > MESSAGE_MAX) text = text.slice(0, MESSAGE_MAX).trimEnd() + "\n\n[message truncated]";
  const lines = [
    `Roundtable-Execution: ${trailerValue("Roundtable-Execution", trailers.execution, EXECUTION_ID_RE)}`,
    `Roundtable-Task: ${trailerValue("Roundtable-Task", trailers.task, ID_RE)}`,
  ];
  if (trailers.agent !== undefined) lines.push(`Roundtable-Agent: ${trailerValue("Roundtable-Agent", trailers.agent)}`);
  return `${text || "rt: update"}\n\n${lines.join("\n")}\n`;
}

async function summarize(t: GitTarget, from: string, to: string): Promise<DiffSummary> {
  if (from === to) return { stat: "", files: [], rewrites: [] };
  // Commit to commit: no working directory is read (TREE_SUBMODULES).
  const files = splitZ((await runGit(t, ["diff", "--name-only", "-z", "--no-renames", TREE_SUBMODULES, from, to])).stdout);
  const stat = (await runGit(t, ["diff", "--shortstat", TREE_SUBMODULES, from, to])).stdout.trim();
  const summary = (await runGit(t, ["diff", "-B", "-M", "--summary", TREE_SUBMODULES, from, to])).stdout;
  const rewrites = summary
    .split("\n")
    .map((l) => /^ rewrite (.+) \(\d+%\)$/.exec(l)?.[1])
    .filter((p): p is string => !!p);
  return { stat, files: [...new Set(files)], rewrites };
}

/** stat, files and rewrites for what HEAD changed since its merge base with `base`. */
export async function taskDiffSummary(worktree: string, base: string, tip = "HEAD"): Promise<DiffSummary & { base: string; head: string }> {
  const w = await openWorktree(worktree);
  const head = await resolveCommit(w.target, tip);
  const mb = await mergeBaseOf(w.target, head, base);
  return { ...(await summarize(w.target, mb, head)), base: mb, head };
}

/**
 * Stage what `leases` cover (all changes when null) and commit it. Nested repositories, paths
 * inside .git and symlinks that leave the repository are never staged. When a merge is in
 * progress (prepareConflictResolution), the commit concludes it: conflicted paths must be
 * leased and free of conflict markers, and staged changes that only bring in the integration
 * branch's own versions are allowed.
 */
async function commitCore(
  w: OpenWorktree,
  leases: readonly LeaseLike[] | null,
  message: string,
  opts: { summaryBase?: string; identity?: GitIdentity }
): Promise<CommitResult> {
  const t = w.target;
  await expectBranch(w);
  const merging = await hasMergeHead(t);
  // Outside a merge the index is rebuilt from HEAD, so nothing staged earlier rides along.
  if (!merging) await runGit(t, ["reset", "-q"]);
  const toStage: string[] = [];
  const uncovered: string[] = [];
  const rejected: Violation[] = [];
  const conflicted: string[] = [];
  for (const e of await statusEntries(t)) {
    if (e.path.endsWith("/")) rejected.push({ path: e.path, reason: "nested repository" });
    else if (hasDotGitSegment(e.path)) rejected.push({ path: e.path, reason: "inside .git" });
    else if (leases && !pathCovered(e.path, leases)) {
      // During a merge, a change the merge staged and nobody touched since is the integration
      // branch's: it is committed with the merge, and is not the worker's uncovered edit.
      if (!(merging && e.xy[1] === " " && !UNMERGED.has(e.xy))) uncovered.push(e.path);
    } else if (await escapingSymlink(t, e.path)) rejected.push({ path: e.path, reason: "symlink leaves the worktree" });
    else {
      toStage.push(e.path);
      if (UNMERGED.has(e.xy)) conflicted.push(e.path);
    }
  }
  const marked = conflicted.filter((p) => hasConflictMarkers(join(t.workTree, p)));
  if (marked.length) throw new CommitRefusedError(`Conflict markers remain in ${marked.join(", ")}`, marked);
  if (toStage.length) {
    await runGit(t, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: toStage.join("\0") + "\0" });
  }

  const stillUnmerged = await unmergedPaths(t);
  if (stillUnmerged.length) {
    throw new CommitRefusedError(`Unresolved conflicts outside the leases: ${stillUnmerged.join(", ")}`, stillUnmerged);
  }
  let staged = await rawChanges(t, "HEAD", null);
  if (merging) {
    const fromIntegration = new Set(
      splitZ((await runGit(t, ["diff", "--cached", "--name-only", "-z", "--no-renames", TREE_SUBMODULES, "MERGE_HEAD"])).stdout)
    );
    staged = staged.filter((c) => fromIntegration.has(c.path));
  }
  const bad = staged
    .filter((c) => (c.status !== "D" && c.mode === "160000") || hasDotGitSegment(c.path) || (leases !== null && !pathCovered(c.path, leases)))
    .map((c) => c.path);
  if (bad.length) {
    if (!merging) await runGit(t, ["reset", "-q"]);
    throw new CommitRefusedError(`Staged changes outside the leases: ${bad.join(", ")}`, bad);
  }

  // Leases can leave target edits unstaged. Check the actual proposed tree as well as the
  // working files, and include unchanged links whose resolution another edit may affect.
  const tree = (await runGit(t, ["write-tree"])).stdout.trim();
  const unsafe = await unsafeTreeSymlinks(t, tree);
  if (unsafe.length) {
    if (!merging) await runGit(t, ["reset", "-q"]);
    throw new CommitRefusedError(`Unsafe symlinks in proposed tree: ${unsafe.map((v) => v.path).join(", ")}`, unsafe.map((v) => v.path));
  }

  const before = await resolveCommit(t, "HEAD");
  if (!staged.length && !merging) {
    return { commit: before, created: false, stat: "", files: [], rewrites: [], uncovered, rejected };
  }
  const identity = opts.identity ?? (await gitIdentity(w.repo));
  await runGit(t, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-F", "-"], { input: message, identity });
  const commit = await resolveCommit(t, "HEAD");
  const from = opts.summaryBase ? await mergeBaseOf(t, commit, opts.summaryBase) : before;
  return { commit, created: true, ...(await summarize(t, from, commit)), uncovered, rejected };
}

async function escapingSymlink(t: GitTarget, rel: string): Promise<boolean> {
  try {
    const p = join(t.workTree, rel);
    if (!lstatSync(p).isSymbolicLink()) return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT"; // A deletion is safe; other errors are uncertain.
  }
  return symlinkEscapes(rel, async (path) => {
    const p = join(t.workTree, path);
    const entry = lstatSync(p);
    if (entry.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(p, "utf8") };
    if (entry.isDirectory()) return { kind: "directory" };
    if (entry.isFile()) return { kind: "file" };
    return undefined;
  });
}

function hasConflictMarkers(file: string): boolean {
  try {
    return MARKER_RE.test(readRegularFile(file, { noFollow: true, maxBytes: 32 * 1024 * 1024 }).data.toString("utf8"));
  } catch {
    return false;
  }
}

/**
 * Commit the worktree's changes that `leases` cover, with Roundtable-Execution, -Task and -Agent
 * trailers (which must name this worktree's execution and task) and a scrubbed message. Changed
 * paths outside the leases stay uncommitted and are listed in `uncovered`. Repository hooks never
 * run. Throws CommitRefusedError when the staged set would not be a subset of the leases.
 */
export async function commitLeasedPaths(worktree: string, leases: readonly LeaseLike[], opts: CommitOptions): Promise<CommitResult> {
  if (!Array.isArray(leases)) throw new Error("commitLeasedPaths: leases must be an array");
  const w = await openWorktree(worktree);
  const tr = opts.trailers;
  if (!tr || tr.execution !== w.header.id || tr.task !== w.name) {
    throw new Error(`Commit trailers must name this worktree's execution ${w.header.id} and task ${w.name}`);
  }
  return commitCore(w, leases, buildCommitMessage(opts.message, tr), opts);
}

/**
 * Runner recovery for a dead worker: commit all of the worktree's WIP ("rt: wip snapshot"), or
 * only what `leases` cover when given, so a resumed or fresh worker starts from it. Nested
 * repositories, .git paths and escaping symlinks are still never committed. A worktree in the
 * middle of a conflict resolution is left alone (skipped).
 */
export async function snapshotWip(
  path: string,
  message = "rt: wip snapshot",
  leases?: readonly LeaseLike[]
): Promise<CommitResult & { skipped?: string }> {
  const w = await openWorktree(path);
  if (await hasMergeHead(w.target)) {
    const head = await resolveCommit(w.target, "HEAD");
    return { commit: head, created: false, stat: "", files: [], rewrites: [], uncovered: [], rejected: [], skipped: "a merge is in progress" };
  }
  const task = w.name === INTEGRATION_WORKTREE ? undefined : w.name;
  if (!task) throw new Error("snapshotWip is for task worktrees");
  return commitCore(w, leases ?? null, buildCommitMessage(message, { execution: w.header.id, task }), {});
}

const DIFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The unified diff of what HEAD changed since its merge base with `base`, capped at maxBytes (at a
 * line boundary, with a note), for the blob store (putBlob scrubs it).
 */
export async function diffForTask(worktree: string, base: string, maxBytes = DIFF_MAX_BYTES, tip = "HEAD"): Promise<string> {
  const w = await openWorktree(worktree);
  const head = await resolveCommit(w.target, tip);
  const mb = await mergeBaseOf(w.target, head, base);
  // Commit to commit: no working directory is read (TREE_SUBMODULES).
  const r = await runGit(w.target, ["diff", "-M", "--no-color", TREE_SUBMODULES, mb, head], { maxOutputBytes: maxBytes, truncate: true });
  if (!r.truncated) return r.stdout;
  const cut = r.stdout.lastIndexOf("\n");
  return `${cut > 0 ? r.stdout.slice(0, cut + 1) : r.stdout}[diff truncated at ${maxBytes} bytes]\n`;
}
