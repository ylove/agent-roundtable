// ============================================================================
// Hardened host-side git
//
// The roundtable runs git on the host in worktrees whose content agents wrote, so no git call may
// run a command that the work tree or a worktree's administrative files choose:
//  - argv only (shell: false), an allowlisted environment (childEnv("git")), its own process
//    group, a timeout and capped output;
//  - every call passes GIT_HARDENING (no fsmonitor, hooks, pager, external diff, signing, auto
//    gc or maintenance, transports, rerere or submodule recursion) plus --no-optional-locks and
//    --literal-pathspecs; diff, log and show also get --no-ext-diff --no-textconv;
//  - git never discovers a repository by itself: each call names --git-dir and --work-tree, taken
//    from the main repository's own records (<common dir>/worktrees/*/gitdir), so a rewritten
//    .git file cannot point git at an agent-written config. A work tree that is a symlink, whose
//    .git is a symlink (canonicalWorkdir), or whose .git file no longer points where the main
//    repository says, is refused before git starts;
//  - commits name their identity explicitly, read from the main repository (gitIdentity).
// No protocol is allowed, not even file: worktree, merge and commit operations never use a
// transport. Filter and merge drivers that the user's own config defines (git-lfs, typically)
// still run when .gitattributes names them; changing .gitattributes needs an explicit lease.
// ============================================================================

import { spawn } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { executionTag, EXECUTION_ID_RE } from "../ids.js";
import { canonicalWorkdir } from "../sandbox/common.js";
import { killTree } from "../sandbox/process.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";
import { ID_RE, preview } from "./events.js";

// ============================================================================
// Hardening
// ============================================================================

/** `-c` settings on every call. Command-line config wins over every config file. */
export const GIT_HARDENING: readonly string[] = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.untrackedCache=false",
  "gc.auto=0",
  "maintenance.auto=false",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "log.showSignature=false",
  "core.pager=cat",
  // Empty means "run nothing": a diff that forgot --no-ext-diff fails instead of running a program.
  "diff.external=",
  "protocol.allow=never",
  "rerere.enabled=false",
  "submodule.recurse=false",
  "core.quotePath=false",
];

/** Subcommands that can produce patches: they always get --no-ext-diff --no-textconv. */
const DIFF_COMMANDS = new Set(["diff", "log", "show"]);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;
const STDERR_MAX = 64 * 1024;

// ============================================================================
// Errors
// ============================================================================

/** A git command failed (non-zero exit, timeout, oversized output or a start failure). */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exit: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** git was not started: the target is not a work tree we can trust. */
export class GitSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSafetyError";
  }
}

// ============================================================================
// Names and refs
// ============================================================================

/** True for a task id that is also a valid branch component (ID_RE allows "..", ".lock" and a trailing dot). */
export function validTaskRefName(task: string): boolean {
  return (
    typeof task === "string" &&
    ID_RE.test(task) &&
    !task.includes("..") &&
    !task.endsWith(".") &&
    !task.endsWith(".lock") &&
    task !== "integration"
  );
}

function tagOf(executionId: string): string {
  if (typeof executionId !== "string" || !EXECUTION_ID_RE.test(executionId)) {
    throw new Error(`Not an execution id: ${preview(executionId)}`);
  }
  return executionTag(executionId);
}

/** `rt/<tag>/<task>`. Throws on an id that cannot name a branch (including the reserved "integration"). */
export function taskBranch(executionId: string, task: string): string {
  const tag = tagOf(executionId);
  if (!validTaskRefName(task)) {
    throw new Error(`Task id ${preview(task)} cannot name a branch (no "..", no trailing "." or ".lock", and "integration" is reserved)`);
  }
  return `rt/${tag}/${task}`;
}

/** `rt/<tag>/integration`. */
export function integrationBranch(executionId: string): string {
  return `rt/${tagOf(executionId)}/integration`;
}

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** A ref or object name safe to place on argv: no option, range, reflog or revision syntax. */
export function assertSafeRef(ref: string): string {
  if (
    typeof ref !== "string" ||
    !SAFE_REF_RE.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new Error(`Not a safe git ref: ${preview(ref)}`);
  }
  return ref;
}

// ============================================================================
// Targets: where a call runs, verified before every call
// ============================================================================

export interface GitTarget {
  /** Canonical work tree root (the call's cwd and --work-tree). */
  readonly workTree: string;
  /** Canonical git dir, passed as --git-dir. */
  readonly gitDir: string;
  /** The repository's common git dir (shared by all of its worktrees). */
  readonly commonDir: string;
  /** True for a linked worktree found through the main repository's records. */
  readonly linked: boolean;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Where a .git file points (resolved and canonical); throws when it is not a plain gitfile. */
function readGitfile(workTree: string): string {
  const p = join(workTree, ".git");
  const st = lstatSync(p);
  if (!st.isFile() || st.size > 4096) throw new GitSafetyError(`${p} is not a gitfile`);
  const m = /^gitdir: (.+?)\r?\n?$/.exec(readFileSync(p, "utf8"));
  if (!m) throw new GitSafetyError(`${p} is not a gitfile`);
  return real(resolve(workTree, m[1]));
}

function safeWorkdir(path: string): ReturnType<typeof canonicalWorkdir> {
  try {
    return canonicalWorkdir(path);
  } catch (e) {
    throw new GitSafetyError(`Refusing to run git in ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Re-check a target just before git runs: nothing may have been swapped since it was opened. */
function verifyTarget(t: GitTarget): void {
  if (t.linked) {
    const wd = safeWorkdir(t.workTree);
    if (wd.path !== t.workTree) throw new GitSafetyError(`Refusing to run git in ${t.workTree}: it now resolves to ${wd.path}`);
    if (wd.git !== "file") throw new GitSafetyError(`Refusing to run git in ${t.workTree}: its .git is not a gitfile`);
    if (readGitfile(wd.path) !== t.gitDir) {
      throw new GitSafetyError(`Refusing to run git in ${t.workTree}: its .git file was changed and no longer points at ${t.gitDir}`);
    }
    return;
  }
  const dotgit = join(t.workTree, ".git");
  let st;
  try {
    st = lstatSync(dotgit);
  } catch {
    throw new GitSafetyError(`Refusing to run git in ${t.workTree}: it has no .git`);
  }
  if (st.isSymbolicLink()) throw new GitSafetyError(`Refusing to run git in ${t.workTree}: its .git is a symlink`);
  const pointed = st.isDirectory() ? real(dotgit) : st.isFile() ? readGitfile(t.workTree) : "";
  if (pointed !== t.gitDir) throw new GitSafetyError(`Refusing to run git in ${t.workTree}: its .git no longer points at ${t.gitDir}`);
}

const repoCache = new Map<string, GitTarget>();

/**
 * The main repository at `repoRoot`, which must be the top level of a non-bare work tree whose
 * .git is not a symlink. Discovery runs once (with GIT_CEILING_DIRECTORIES so git never walks
 * above the root); later calls name the git dir explicitly.
 */
export async function openRepo(repoRoot: string): Promise<GitTarget> {
  if (typeof repoRoot !== "string" || !repoRoot) throw new GitSafetyError("openRepo: repoRoot is required");
  let root: string;
  try {
    root = realpathSync(repoRoot);
  } catch {
    throw new GitSafetyError(`Repository ${repoRoot} does not exist`);
  }
  const cached = repoCache.get(root);
  if (cached) {
    verifyTarget(cached);
    return cached;
  }
  let st;
  try {
    st = lstatSync(join(root, ".git"));
  } catch {
    throw new GitSafetyError(`${repoRoot} is not the top level of a git work tree (no .git)`);
  }
  if (st.isSymbolicLink()) throw new GitSafetyError(`Refusing to run git in ${repoRoot}: its .git is a symlink`);
  if (!st.isDirectory() && !st.isFile()) throw new GitSafetyError(`${repoRoot}/.git is neither a directory nor a gitfile`);
  const r = await spawnGit(
    root,
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
    { env: { GIT_CEILING_DIRECTORIES: dirname(root) } }
  );
  const [gitDir, commonDir, top] = r.stdout.split("\n").map((s) => s.trim());
  if (!gitDir || !commonDir || !top) throw new GitSafetyError(`${repoRoot} is not a git work tree`);
  if (real(top) !== root) throw new GitSafetyError(`${repoRoot} is not the top level of its work tree (that is ${top})`);
  const target: GitTarget = { workTree: root, gitDir: real(gitDir), commonDir: real(commonDir), linked: false };
  verifyTarget(target);
  repoCache.set(root, target);
  return target;
}

/** The administrative dir (<common>/worktrees/<name>) whose gitdir file names `workTree`/.git, if any. */
export function findWorktreeAdmin(repo: GitTarget, workTree: string): string | null {
  const base = join(repo.commonDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  // The parents are resolved, the worktree itself is not: a symlink in its place matches nothing.
  const want = join(real(dirname(workTree)), basename(workTree), ".git");
  for (const name of names) {
    const admin = join(base, name);
    try {
      if (!lstatSync(admin).isDirectory()) continue;
      const recorded = readFileSync(join(admin, "gitdir"), "utf8").trim();
      if (real(resolve(admin, recorded)) === want || resolve(admin, recorded) === want) return real(admin);
    } catch {
      /* not a worktree record */
    }
  }
  return null;
}

/**
 * A linked worktree of `repo` at `path`. The git dir comes from the main repository's records,
 * and the worktree's own .git file must agree with them.
 */
export function openLinkedWorktree(repo: GitTarget, path: string): GitTarget {
  const wd = safeWorkdir(path);
  if (wd.git !== "file") throw new GitSafetyError(`${path} is not a linked worktree (its .git is not a gitfile)`);
  const admin = findWorktreeAdmin(repo, wd.path);
  if (!admin) throw new GitSafetyError(`${path} is not a registered worktree of ${repo.workTree}`);
  const target: GitTarget = { workTree: wd.path, gitDir: admin, commonDir: repo.commonDir, linked: true };
  verifyTarget(target);
  return target;
}

// ============================================================================
// Running git
// ============================================================================

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  timeoutMs?: number;
  /** Cap on stdout (default 16 MiB). More output fails the call unless `truncate` is set. */
  maxOutputBytes?: number;
  /** Keep the first maxOutputBytes of stdout instead of failing. */
  truncate?: boolean;
  /** Written to stdin. */
  input?: string;
  /** Passed as -c user.name / -c user.email. */
  identity?: GitIdentity;
  /** Exit codes that are results rather than failures (0 always is). */
  allowExit?: readonly number[];
}

export interface GitResult {
  exit: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function identityArgs(id: GitIdentity | undefined): string[] {
  if (!id) return [];
  for (const v of [id.name, id.email]) {
    if (typeof v !== "string" || !v.trim() || /[\0-\x1f\x7f<>]/.test(v)) throw new Error(`Invalid git identity value ${preview(v)}`);
  }
  return ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`];
}

interface SpawnOpts extends GitOptions {
  env?: Record<string, string>;
}

/** Spawn git with the hardening options; cwd is the work tree. Throws GitError on failure. */
function spawnGit(cwd: string, args: string[], o: SpawnOpts = {}, pre: string[] = []): Promise<GitResult> {
  const sub = args[0];
  const argv = [
    ...pre,
    "--no-optional-locks",
    "--literal-pathspecs",
    ...GIT_HARDENING.flatMap((c) => ["-c", c]),
    ...identityArgs(o.identity),
    sub,
    ...(DIFF_COMMANDS.has(sub) ? ["--no-ext-diff", "--no-textconv"] : []),
    ...args.slice(1),
  ];
  const env = childEnv("git", { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":", GIT_PAGER: "cat", ...o.env });
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const label = `git ${sub}`;
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", argv, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new GitError(`could not start ${label}: ${e instanceof Error ? e.message : String(e)}`, args, null, ""));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let overflow = false;
    let timedOut = false;
    const err: Buffer[] = [];
    let errBytes = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => {
      if (outBytes >= max) {
        truncated = true;
        if (!o.truncate && !overflow) {
          overflow = true;
          killTree(child.pid);
        }
        return;
      }
      const take = c.subarray(0, max - outBytes);
      out.push(take);
      outBytes += take.length;
      if (take.length < c.length) {
        truncated = true;
        if (!o.truncate && !overflow) {
          overflow = true;
          killTree(child.pid);
        }
      }
    });
    child.stderr!.on("data", (c: Buffer) => {
      if (errBytes < STDERR_MAX) {
        err.push(c.subarray(0, STDERR_MAX - errBytes));
        errBytes += Math.min(c.length, STDERR_MAX - errBytes);
      }
    });
    child.stdin?.on("error", () => {
      /* git exited before reading all of stdin; its exit status says why */
    });
    if (o.input !== undefined) child.stdin!.end(o.input);
    let startError: Error | undefined;
    let settled = false;
    child.on("error", (e) => {
      startError = e;
      if (child.pid === undefined && !settled) {
        // Never started (git missing from PATH): there may be no close event to wait for.
        settled = true;
        clearTimeout(timer);
        reject(new GitError(`${label} could not start (${e.message})`, args, null, ""));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8");
      const fail = (why: string) =>
        reject(new GitError(`${label} ${why}${stderr.trim() ? `: ${scrubAndCap(stderr.trim(), 2000)}` : ""}`, args, code, stderr));
      if (startError) return fail(`could not start (${startError.message})`);
      if (timedOut) return fail(`timed out after ${timeoutMs} ms`);
      if (overflow) return fail(`produced more than ${max} bytes of output`);
      const exit = code ?? -1;
      if (exit !== 0 && !(o.allowExit ?? []).includes(exit)) return fail(`failed (exit ${code ?? "signal"})`);
      resolvePromise({ exit, stdout: Buffer.concat(out).toString("utf8"), stderr, truncated });
    });
  });
}

/**
 * Run `git <args>` in a verified target with the hardening options, an explicit --git-dir and
 * --work-tree, and cwd at the work tree root. Throws GitSafetyError when the target no longer
 * checks out, GitError when git fails.
 */
export async function runGit(target: GitTarget, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string" || a.includes("\0"))) {
    throw new Error("runGit: args must be non-empty strings without NUL");
  }
  verifyTarget(target);
  return spawnGit(target.workTree, args, opts, [`--git-dir=${target.gitDir}`, `--work-tree=${target.workTree}`]);
}

/** Split NUL-terminated output (the -z formats). */
export function splitZ(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** The commit `ref` names, as a full object id; throws when it does not name a commit. */
export async function resolveCommit(target: GitTarget, ref: string): Promise<string> {
  assertSafeRef(ref);
  const r = await runGit(target, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { allowExit: [1] });
  const sha = r.stdout.trim();
  if (r.exit !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`${preview(ref)} does not name a commit`);
  return sha;
}

/** True when refs/heads/<branch> exists. */
export async function branchExists(target: GitTarget, branch: string): Promise<boolean> {
  assertSafeRef(branch);
  const r = await runGit(target, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowExit: [1] });
  return r.exit === 0;
}

// ============================================================================
// Identity
// ============================================================================

const FALLBACK_IDENTITY: GitIdentity = { name: "agent-roundtable", email: "agent-roundtable@localhost" };
const identities = new Map<string, GitIdentity>();

function cleanIdentityValue(v: string): string {
  return v.replace(/[\0-\x1f\x7f<>]/g, "").trim().slice(0, 200);
}

/**
 * user.name and user.email as the main repository sees them (so includeIf rules for the repo
 * apply), read once per process and cached. Workers never influence it: it is read from the main
 * repository, never a worktree, and passed to every commit with -c. Unset values fall back to
 * agent-roundtable <agent-roundtable@localhost>, with a warning.
 */
export async function gitIdentity(repo: GitTarget): Promise<GitIdentity> {
  const cached = identities.get(repo.commonDir);
  if (cached) return cached;
  const get = async (key: string) => {
    const r = await runGit(repo, ["config", "--get", key], { allowExit: [1] });
    return r.exit === 0 ? cleanIdentityValue(r.stdout) : "";
  };
  const name = await get("user.name");
  const email = await get("user.email");
  if (!name || !email) {
    console.error(`[Git] user.name or user.email is not set for ${repo.workTree}; roundtable commits use ${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>`);
  }
  const id = { name: name || FALLBACK_IDENTITY.name, email: email || FALLBACK_IDENTITY.email };
  identities.set(repo.commonDir, id);
  return id;
}
