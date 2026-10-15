// Temporary git repositories and executions for the worktree, lease and merge tests.
// Plain git here is the test's own tool (setting up repos and inspecting results); the code
// under test always goes through src/execution/git.ts.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { createExecutionStore } = await import("../../../dist/execution/store.js");

/** Run plain git (no hardening) and return trimmed stdout; throws on a non-zero exit. */
export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/** git that may fail: { status, stdout, stderr }. */
export function gitTry(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function executable(path, script) {
  write(dirname(path), path.slice(dirname(path).length + 1), script);
  chmodSync(path, 0o755);
}

/** A fresh repository on main with `files` committed; returns { root, sha }. */
export function makeRepo(files = { "README.md": "readme\n" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-repo-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Repo Owner");
  git(root, "config", "user.email", "owner@example.test");
  git(root, "config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

/** A repository plus an execution whose header points at it. */
export async function makeExecution(files) {
  const repo = makeRepo(files);
  const store = await createExecutionStore({ repoRoot: repo.root, baseSha: repo.sha, agentsDir: join(repo.root, ".claude", "agents") });
  return { ...repo, store, header: store.header() };
}

export const src = { kind: "runner", id: "runner", pid: process.pid };

/** Lines 1..n, as file content. */
export const lines = (n, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
