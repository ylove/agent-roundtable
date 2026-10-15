import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const G = await import("../../dist/execution/git.js");
const W = await import("../../dist/execution/worktrees.js");
const { mergeTask } = await import("../../dist/execution/merge.js");
const { WORKTREES_DIR } = await import("../../dist/config.js");
const { executable, git, gitTry, makeExecution, write } = await import("../fixtures/execution/git-fixture.mjs");

const all = [{ paths: ["**"] }];

/**
 * A repository whose own config and hooks try to run commands: an fsmonitor hook, an external
 * diff, a textconv driver and every hook git might call. Each touches a canary file.
 */
async function hostileExecution() {
  const ex = await makeExecution({ "a.txt": "a\n", ".gitattributes": "*.txt diff=evil\n" });
  const canaries = realpathSync(mkdtempSync(join(tmpdir(), "rt-canary-")));
  const script = (name) => {
    const p = join(canaries, `${name}.sh`);
    executable(p, `#!/bin/sh\ntouch "${join(canaries, `${name}.ran`)}"\ncat >/dev/null 2>&1 || true\n`);
    return p;
  };
  git(ex.root, "config", "core.fsmonitor", script("fsmonitor"));
  git(ex.root, "config", "diff.external", script("extdiff"));
  git(ex.root, "config", "diff.evil.textconv", script("textconv"));
  git(ex.root, "config", "core.pager", script("pager"));
  for (const hook of ["pre-commit", "commit-msg", "post-commit", "pre-merge-commit", "post-merge", "post-checkout", "prepare-commit-msg", "reference-transaction"]) {
    executable(join(ex.root, ".git", "hooks", hook), `#!/bin/sh\ntouch "${join(canaries, `hook-${hook}.ran`)}"\n`);
  }
  const ran = () => ["fsmonitor", "extdiff", "textconv", "pager", "hook-pre-commit", "hook-commit-msg", "hook-post-commit", "hook-pre-merge-commit", "hook-post-merge", "hook-post-checkout", "hook-prepare-commit-msg", "hook-reference-transaction"].filter((n) => existsSync(join(canaries, `${n}.ran`)));
  return { ...ex, canaries, ran };
}

test("hardening canary: status, diff, commit and merge never run fsmonitor, hooks, external diff or textconv", async () => {
  const ex = await hostileExecution();

  // Control: plain git does run them, so the canaries work.
  gitTry(ex.root, "status");
  write(ex.root, "a.txt", "control\n");
  gitTry(ex.root, "diff");
  gitTry(ex.root, "commit", "-qam", "control");
  const control = ex.ran();
  for (const n of ["fsmonitor", "extdiff", "hook-pre-commit", "hook-commit-msg"]) assert.ok(control.includes(n), `control: plain git ran ${n}`);
  git(ex.root, "reset", "-q", "--hard", ex.sha);
  rmSync(ex.canaries, { recursive: true, force: true });
  mkdirSync(ex.canaries);

  // Everything below goes through the hardened helper.
  const repo = await G.openRepo(ex.root);
  await G.runGit(repo, ["status", "--porcelain"]);
  const t1 = await W.ensureTaskWorktree(ex.header, "t1");
  write(t1.path, "a.txt", "changed by t1\n");
  write(t1.path, "b.txt", "new\n");
  const st = await W.worktreeStatus(t1.path);
  assert.deepEqual(st.dirty.sort(), ["a.txt", "b.txt"]);
  const commit = await W.commitLeasedPaths(t1.path, all, { message: "t1 work", trailers: { execution: ex.header.id, task: "t1", agent: "w1" } });
  assert.equal(commit.created, true);
  const diff = await W.diffForTask(t1.path, G.integrationBranch(ex.header.id));
  assert.match(diff, /^\+changed by t1$/m, "a real diff, not the textconv output");
  await W.checkLeaseCoverage(t1.path, G.integrationBranch(ex.header.id), all);
  await W.changedPaths(t1.path, ex.sha);
  const merged = await mergeTask(ex.header, "t1");
  assert.equal(merged.ok, true);
  await G.runGit(repo, ["diff", "HEAD"]);
  await G.runGit(repo, ["log", "-1", "-p"]);

  assert.deepEqual(ex.ran(), [], "no repository-chosen command ran");
});

test("a worktree whose .git file was rewritten, or replaced by a symlink, is refused before git runs", async () => {
  const ex = await hostileExecution();
  rmSync(ex.canaries, { recursive: true, force: true });
  mkdirSync(ex.canaries);
  const t = await W.ensureTaskWorktree(ex.header, "t2");
  const dotgit = join(t.path, ".git");
  const original = (await import("node:fs")).readFileSync(dotgit, "utf8");

  // An agent-written git dir with a config that would run a command on status.
  const fake = join(t.path, "fake-gitdir");
  git(ex.root, "init", "-q", "--bare", fake);
  git(fake, "config", "core.fsmonitor", join(ex.canaries, "fsmonitor.sh"));
  executable(join(ex.canaries, "fsmonitor.sh"), `#!/bin/sh\ntouch "${join(ex.canaries, "fsmonitor.ran")}"\n`);
  writeFileSync(dotgit, `gitdir: ${fake}\n`);
  await assert.rejects(W.worktreeStatus(t.path), (e) => e.name === "GitSafetyError" && /\.git file was changed/.test(e.message));
  await assert.rejects(W.commitLeasedPaths(t.path, all, { message: "x", trailers: { execution: ex.header.id, task: "t2", agent: "w" } }), /GitSafetyError|\.git file was changed/);

  rmSync(dotgit);
  symlinkSync(join(ex.root, ".git"), dotgit);
  await assert.rejects(W.worktreeStatus(t.path), (e) => e.name === "GitSafetyError" && /symlink/.test(e.message));
  rmSync(dotgit);
  writeFileSync(dotgit, original);
  await W.worktreeStatus(t.path); // restored: accepted again

  assert.deepEqual(ex.ran(), []);
});

test("only roundtable worktrees are opened, and only through their execution's repository", async () => {
  const ex = await makeExecution();
  await assert.rejects(W.worktreeStatus(ex.root), /not a roundtable worktree/);
  await assert.rejects(W.worktreeStatus("relative/path"), /Not a worktree path/);
  const stray = join(WORKTREES_DIR, ex.header.id, "stray");
  mkdirSync(stray, { recursive: true });
  await assert.rejects(W.worktreeStatus(stray), /not a linked worktree|not a registered worktree/);
  const linkPath = join(WORKTREES_DIR, ex.header.id, "linked");
  const real = await W.ensureTaskWorktree(ex.header, "real");
  symlinkSync(real.path, linkPath);
  await assert.rejects(W.worktreeStatus(linkPath), /not a roundtable worktree|symlink/);
});

test("openRepo refuses non-repositories, subdirectories and a symlinked .git", async () => {
  const ex = await makeExecution({ "sub/a.txt": "a\n" });
  await assert.rejects(G.openRepo(join(ex.root, "sub")), /not the top level|no \.git/);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "rt-plain-")));
  await assert.rejects(G.openRepo(plain), /no \.git/);
  const linked = realpathSync(mkdtempSync(join(tmpdir(), "rt-linked-")));
  symlinkSync(join(ex.root, ".git"), join(linked, ".git"));
  await assert.rejects(G.openRepo(linked), /symlink/);
  const repo = await G.openRepo(ex.root);
  assert.equal(repo.workTree, ex.root);
  assert.equal(repo.linked, false);
  assert.equal(repo.commonDir, join(ex.root, ".git"));
});

test("identity comes from the main repository and is passed explicitly; refs are checked before argv", async () => {
  const ex = await makeExecution();
  const repo = await G.openRepo(ex.root);
  assert.deepEqual(await G.gitIdentity(repo), { name: "Repo Owner", email: "owner@example.test" });
  const t = await W.ensureTaskWorktree(ex.header, "who");
  // A worktree cannot change the identity: worktree config is the shared repository config, and
  // the cached value is what commits use.
  write(t.path, "x.txt", "x\n");
  const c = await W.commitLeasedPaths(t.path, all, { message: "x", trailers: { execution: ex.header.id, task: "who", agent: "w" } });
  assert.equal(git(t.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>", c.commit), "Repo Owner <owner@example.test>|Repo Owner <owner@example.test>");

  for (const bad of ["-x", "--output=/tmp/x", "a..b", "HEAD@{1}", "a b", "x:y", "x^", "x~1", "", "a//b"]) {
    assert.throws(() => G.assertSafeRef(bad), /Not a safe git ref/, bad);
  }
  assert.equal(G.assertSafeRef("refs/heads/rt/abc123/t1"), "refs/heads/rt/abc123/t1");
  await assert.rejects(G.resolveCommit(repo, "no-such-branch"), /does not name a commit/);
  assert.equal(await G.resolveCommit(repo, "HEAD"), ex.sha);
  await assert.rejects(G.runGit(repo, ["no-such-subcommand"]), (e) => e.name === "GitError");
  assert.ok(G.GIT_HARDENING.includes("core.hooksPath=/dev/null"));
  assert.ok(G.GIT_HARDENING.includes("core.fsmonitor=false"));
  assert.ok(G.GIT_HARDENING.includes("protocol.allow=never"));
});

test("runGit caps output and times out", async () => {
  const ex = await makeExecution({ "big.txt": "x".repeat(200_000) + "\n" });
  const repo = await G.openRepo(ex.root);
  await assert.rejects(G.runGit(repo, ["show", "HEAD:big.txt"], { maxOutputBytes: 1000 }), /more than 1000 bytes/);
  const capped = await G.runGit(repo, ["show", "HEAD:big.txt"], { maxOutputBytes: 1000, truncate: true });
  assert.equal(capped.truncated, true);
  assert.equal(capped.stdout.length, 1000);
  // A 1 ms budget is spent before git has even started.
  await assert.rejects(G.runGit(repo, ["log", "--all"], { timeoutMs: 1 }), /timed out after 1 ms/);
});
