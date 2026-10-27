import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const G = await import("../../dist/execution/git.js");
const W = await import("../../dist/execution/worktrees.js");
const { mergeTask, prepareConflictResolution } = await import("../../dist/execution/merge.js");
const { WORKTREES_DIR } = await import("../../dist/config.js");
const { executable, git, gitTry, makeExecution, makeRepo, write } = await import("../fixtures/execution/git-fixture.mjs");
const { findExecutable } = await import("../../dist/executables.js");

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

// ============================================================================
// Submodules: a nested repository's own config must never run on the host
// ============================================================================

const isSubmoduleRefusal = (e) => e.name === "SubmodulesUnsupportedError" && /not supported in heads-down runs in 1\.0/.test(e.message) && /vendor\/lib/.test(e.message);

/** Commit a gitlink at vendor/lib (plain git: the roundtable never does this itself). */
function commitGitlink(dir, sha) {
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`);
  git(dir, "commit", "-q", "-m", "add vendor/lib");
}

/**
 * What a sandboxed command could leave in a worktree: vendor/lib made into a repository (at the
 * gitlink's commit) whose own config and .gitattributes run a filter on every file, a same-size
 * edit there so only hashing through the filter can tell, and a .gitmodules asking for
 * submodules to be inspected (ignore = none) despite diff.ignoreSubmodules.
 */
function armNested(dir, sub, evil) {
  const nested = join(dir, "vendor", "lib");
  git(dir, "clone", "-q", sub.root, nested);
  git(nested, "config", "filter.x.clean", evil);
  git(nested, "config", "filter.x.smudge", evil);
  write(nested, ".gitattributes", "* filter=x\n");
  write(nested, "f.txt", "g\n");
  write(dir, ".gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ./nowhere\n\tignore = none\n');
}

function evilFilter() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-subcanary-")));
  const canary = join(dir, "filter.ran");
  const evil = join(dir, "evil.sh");
  executable(evil, `#!/bin/sh\necho ran >> "${canary}"\ncat\n`);
  return { evil, canary, ran: () => existsSync(canary), reset: () => rmSync(canary, { force: true }) };
}

test("submodules: a base_sha with a gitlink is refused before any worktree exists", async () => {
  const sub = makeRepo({ "f.txt": "f\n" });
  const ex = await makeExecution({ "a.txt": "a\n" });
  commitGitlink(ex.root, sub.sha);
  const { createExecutionStore } = await import("../../dist/execution/store.js");
  const store = await createExecutionStore({ repoRoot: ex.root, baseSha: git(ex.root, "rev-parse", "HEAD"), agentsDir: ex.root });
  const header = store.header();
  await assert.rejects(W.ensureIntegrationWorktree(header), isSubmoduleRefusal);
  await assert.rejects(W.ensureTaskWorktree(header, "t"), isSubmoduleRefusal);
  assert.equal(existsSync(W.integrationWorktreePath(header.id)), false, "nothing was created");
  assert.equal(existsSync(W.taskWorktreePath(header.id, "t")), false);
});

test("submodules: a nested repository's filter never runs through any operation", async () => {
  const sub = makeRepo({ "f.txt": "f\n" });
  const filter = evilFilter();
  const ex = await makeExecution({ "a.txt": "a\n" });
  const t = await W.ensureTaskWorktree(ex.header, "sneaky");
  const integ = realpathSync(W.integrationWorktreePath(ex.header.id));
  for (const dir of [t.path, integ]) {
    commitGitlink(dir, sub.sha);
    armNested(dir, sub, filter.evil);
    write(dir, "a.txt", "b\n");
  }
  // Control: plain git status in the worktree does run the nested filter.
  gitTry(t.path, "status");
  assert.equal(filter.ran(), true, "control: the canary works");
  filter.reset();

  const base = G.integrationBranch(ex.header.id);
  await assert.rejects(W.worktreeStatus(t.path), isSubmoduleRefusal);
  await assert.rejects(W.commitLeasedPaths(t.path, all, { message: "x", trailers: { execution: ex.header.id, task: "sneaky", agent: "w" } }), isSubmoduleRefusal);
  await assert.rejects(W.snapshotWip(t.path), isSubmoduleRefusal);
  await assert.rejects(W.diffForTask(t.path, base), isSubmoduleRefusal);
  await assert.rejects(W.checkLeaseCoverage(t.path, base, all), isSubmoduleRefusal);
  await assert.rejects(W.changedPaths(t.path, base), isSubmoduleRefusal);
  await assert.rejects(W.ensureTaskWorktree(ex.header, "sneaky"), isSubmoduleRefusal);
  await assert.rejects(mergeTask(ex.header, "sneaky"), isSubmoduleRefusal);
  await assert.rejects(prepareConflictResolution(ex.header, "sneaky"), isSubmoduleRefusal);

  // Defense in depth, with the refusal bypassed: worktree status and diffs never enter the
  // submodule, even though .gitmodules says ignore = none.
  const repo = await G.openRepo(ex.root);
  for (const dir of [t.path, integ]) {
    const raw = G.openLinkedWorktree(repo, dir);
    await G.runGit(raw, ["status", "--porcelain=v1"]);
    await G.runGit(raw, ["diff", "--name-only", "HEAD"]);
    await G.runGit(raw, ["diff", "--name-only"]);
    await W.unmergedPaths(raw);
  }
  assert.equal(filter.ran(), false, "the nested filter never ran");
});

test("submodules: a task branch carrying a gitlink is never merged", async () => {
  const sub = makeRepo({ "f.txt": "f\n" });
  const ex = await makeExecution({ "a.txt": "a\n" });
  const t = await W.ensureTaskWorktree(ex.header, "linker");
  commitGitlink(t.path, sub.sha);
  const integ = W.integrationWorktreePath(ex.header.id);
  const before = git(integ, "rev-parse", "HEAD");
  const commit = git(t.path, "rev-parse", "HEAD");
  await assert.rejects(mergeTask(ex.header, "linker", { commit }), (e) => e.name === "SubmodulesUnsupportedError" && e.message.includes(commit));
  assert.equal(git(integ, "rev-parse", "HEAD"), before);
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
  // Hashing 64 MiB from stdin takes far longer than 10 ms, on any machine.
  await assert.rejects(G.runGit(repo, ["hash-object", "--stdin"], { timeoutMs: 10, input: "x".repeat(64 * 1024 * 1024) }), /timed out after 10 ms/);
});

test("unattached filters allow operations while diff and merge drivers remain overridden", async (t) => {
  const ex = makeRepo({ "f.txt": "one\ntwo\nthree\n" });
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const marker = join(ex.root, "driver.ran");
  const script = join(ex.root, "driver.sh");
  executable(script, `#!/bin/sh\necho ran >> "${marker}"\nsed 's/^/stored: /'\n`);
  write(ex.root, ".gitattributes", "*.txt diff=fixture merge=fixture\n*.filtered filter=fixture\n");
  // Include files and worktree config are read alongside the repository config.
  const included = write(ex.root, "drivers.config", `[filter "fixture"]\nclean = ${script}\nsmudge = ${script}\nrequired = true\n[diff "fixture"]\ntextconv = ${script}\ncommand = ${script}\n`);
  git(ex.root, "config", "include.path", included);
  git(ex.root, "config", "extensions.worktreeConfig", "true");
  git(ex.root, "config", "--worktree", "merge.fixture.driver", script);
  const repo = await G.openRepo(ex.root);
  await G.runGit(repo, ["add", ".gitattributes"]);
  await G.runGit(repo, ["commit", "-qm", "attributes"]);
  await G.runGit(repo, ["checkout", "-qb", "other"]);
  write(ex.root, "f.txt", "ONE\ntwo\nthree\n");
  await G.runGit(repo, ["status", "--porcelain"]);
  assert.match((await G.runGit(repo, ["diff", "HEAD"])).stdout, /^\+ONE$/m);
  await G.runGit(repo, ["add", "f.txt"]);
  await G.runGit(repo, ["commit", "-qm", "other"]);
  await G.runGit(repo, ["checkout", "-q", "main"]);
  write(ex.root, "f.txt", "one\ntwo\nTHREE\n");
  await G.runGit(repo, ["add", "f.txt"]);
  await G.runGit(repo, ["commit", "-qm", "main"]);
  await G.runGit(repo, ["merge", "--no-edit", "other"]);
  assert.equal((await import("node:fs")).readFileSync(join(ex.root, "f.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
  assert.equal(existsSync(marker), false);
  // A process filter added after the first call is discovered too.
  git(ex.root, "config", "filter.fixture.process", script);
  write(ex.root, "f.txt", "ONE\nTWO\nTHREE\n");
  await G.runGit(repo, ["status", "--porcelain"]);
  await G.runGit(repo, ["add", "f.txt"]);
  await G.runGit(repo, ["commit", "-qm", "process filter configured"]);
  assert.equal(existsSync(marker), false);
});

test("a required clean filter attached to a tracked or untracked path refuses content changes", async (t) => {
  for (const tracked of [true, false]) {
    await t.test(tracked ? "tracked path" : "untracked path", async (t) => {
      const ex = makeRepo({ "base.md": "base\n", ...(tracked ? { "f.txt": "stored: base\n" } : {}) });
      t.after(() => rmSync(ex.root, { recursive: true, force: true }));
      git(ex.root, "branch", "other");
      const marker = join(ex.root, "filter.ran");
      const script = join(ex.root, "filter.sh");
      executable(script, `#!/bin/sh\necho ran >> "${marker}"\nsed 's/^/stored: /'\n`);
      // Included and worktree settings participate in the same filter check.
      const included = write(ex.root, "filter.config", `[filter "fixture"]\nclean = ${script}\n`);
      git(ex.root, "config", "include.path", included);
      git(ex.root, "config", "extensions.worktreeConfig", "true");
      git(ex.root, "config", "--worktree", "filter.fixture.required", "true");
      write(ex.root, ".gitattributes", "*.txt filter=fixture\n");
      const path = tracked ? "f.txt" : "new folder/new\nfile.txt";
      write(ex.root, path, "raw working content\n");
      const repo = await G.openRepo(ex.root);
      const index = git(ex.root, "ls-files", "--stage", "-z");
      const worktree = join(ex.root, "new-worktree");
      const commands = [
        ["add", "-A"], ["commit", "-qam", "filtered change"], ["merge", "--no-edit", "other"],
        ["checkout", "other"], ["rebase", "other"], ["reset", "--hard", "HEAD"],
        ["stash", "push"], ["apply", "--stat"], ["cherry-pick", "other"], ["revert", "HEAD"],
        ["restore", path], ["switch", "other"], ["read-tree", "-mu", "HEAD"],
        ["worktree", "add", "--detach", worktree, "HEAD"],
      ];
      for (const args of commands) {
        await assert.rejects(G.runGit(repo, args), (e) => {
          assert.ok(e instanceof G.GitSafetyError);
          assert.match(e.message, /Filtered paths are not supported in heads-down runs/);
          assert.ok(e.message.includes('filter "fixture"'));
          assert.ok(e.message.includes(JSON.stringify(path)));
          return true;
        }, args.join(" "));
        assert.equal(git(ex.root, "ls-files", "--stage", "-z"), index, "index is unchanged");
        assert.equal(git(ex.root, "diff", "--cached", "--name-only"), "", "nothing was staged");
        assert.equal(git(ex.root, "rev-parse", "HEAD"), ex.sha, "no commit was created");
        assert.equal(readFileSync(join(ex.root, path), "utf8"), "raw working content\n", "working content is unchanged");
        assert.equal(existsSync(marker), false, "the filter program never ran");
      }
      assert.equal(existsSync(worktree), false, "no worktree was created");
      assert.equal(git(ex.root, "branch", "--show-current"), "main");
      assert.equal(git(ex.root, "show", "HEAD:base.md"), "base");
      if (tracked) assert.equal(git(ex.root, "show", "HEAD:f.txt"), "stored: base", "raw content was not committed");
      else assert.equal(git(ex.root, "ls-tree", "-r", "--name-only", "HEAD", "--", path), "", "raw content was not committed");
      for (const args of [["status", "--porcelain"], ["diff"], ["log", "-1", "-p"], ["rev-parse", "HEAD"], ["read-tree", "HEAD"]]) {
        await G.runGit(repo, args);
      }
      assert.equal(existsSync(marker), false, "inspection never ran the filter program");
    });
  }
});

test("worktree creation checks destination branch includes and destination tree attributes before checkout", async (t) => {
  for (const existing of [false, true]) {
    await t.test(existing ? "existing branch" : "new branch", async (t) => {
      const ex = await makeExecution({ "base.md": "base\n" });
      t.after(async () => {
        await W.pruneWorktrees(ex.header, { remove: true, branches: true });
        rmSync(ex.root, { recursive: true, force: true });
      });
      // Neither the paths nor their attributes exist in the source checkout or its index.
      git(ex.root, "checkout", "-qb", "destination-content");
      write(ex.root, "nested/.gitattributes", "*.txt filter=branch-only\n");
      write(ex.root, "nested/asset.txt", "destination content\n");
      git(ex.root, "add", "nested");
      git(ex.root, "commit", "-qm", "destination attributes");
      const destination = git(ex.root, "rev-parse", "HEAD");
      git(ex.root, "checkout", "-q", "main");
      const branch = G.taskBranch(ex.header.id, "t1");
      const marker = join(ex.root, "smudge.ran");
      const script = join(ex.root, "smudge.sh");
      executable(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
      const included = write(ex.root, "destination.config", `[filter "branch-only"]\nsmudge = ${script}\nrequired = true\n`);
      git(ex.root, "config", `includeIf.onbranch:${branch}.path`, included);

      // Plain Git activates this include during the initial worktree checkout.
      const control = join(ex.root, "control");
      git(ex.root, "worktree", "add", "-q", "-b", branch, control, destination);
      assert.equal(existsSync(marker), true, "control: destination-only smudge runs in plain Git");
      git(ex.root, "worktree", "remove", "--force", control);
      if (!existing) git(ex.root, "branch", "-D", branch);
      rmSync(marker);

      await assert.rejects(W.ensureTaskWorktree(ex.header, "t1", destination),
        (e) => e instanceof G.GitSafetyError && /filter "branch-only" applies to "nested\/asset.txt"/.test(e.message));
      assert.equal(existsSync(marker), false, "destination-only smudge never ran");
      assert.equal(existsSync(W.taskWorktreePath(ex.header.id, "t1")), false, "refused worktree is cleaned up");
    });
  }
});

test("smudge-only and process-only filters added after opening the repository are checked", async (t) => {
  const ex = makeRepo({ "f.txt": "base\n", ".gitattributes": "*.txt filter=fixture\n" });
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const marker = join(ex.root, "filter.ran");
  const script = join(ex.root, "filter.sh");
  executable(script, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  const repo = await G.openRepo(ex.root);
  await G.runGit(repo, ["status", "--porcelain"]);
  write(ex.root, "f.txt", "changed\n");
  for (const field of ["smudge", "process"]) {
    git(ex.root, "config", `filter.fixture.${field}`, script);
    await assert.rejects(G.runGit(repo, ["add", "f.txt"]), (e) => e instanceof G.GitSafetyError && /filter "fixture" applies to "f.txt"/.test(e.message));
    assert.equal(git(ex.root, "diff", "--cached", "--name-only"), "");
    assert.equal(existsSync(marker), false);
    git(ex.root, "config", "--unset", `filter.fixture.${field}`);
  }
});

function lfsStub(t, bin) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-lfs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  bin ??= join(dir, "bin");
  const marker = join(dir, "lfs.ran");
  const skipMarker = join(dir, "lfs-skip");
  executable(join(bin, "git-lfs"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${marker}"\nprintf '%s\\n' "$GIT_LFS_SKIP_SMUDGE" >> "${skipMarker}"\ncat\n`);
  // Hosts with git-lfs installed add a global filter.lfs.process, which the stub does not speak:
  // read neither global nor system git configuration while the stub is on PATH.
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.PATH = `${bin}${delimiter}${previous.PATH ?? ""}`;
  process.env.HOME = dir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_CONFIG_GLOBAL;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { bin, marker, skipMarker };
}

function configureLfs(root) {
  git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  git(root, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  git(root, "config", "filter.lfs.required", "true");
}

test("standard LFS clean and smudge filters stage, commit and restore content", async (t) => {
  const ex = makeRepo();
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const stub = lfsStub(t);
  configureLfs(ex.root);
  // Horizontal whitespace is normalized, and included/worktree config participates.
  const included = write(ex.root, "lfs.config", '[filter "lfs"]\nclean = git-lfs clean -- %f\n');
  git(ex.root, "config", "include.path", included);
  git(ex.root, "config", "extensions.worktreeConfig", "true");
  git(ex.root, "config", "--worktree", "filter.lfs.clean", " \tgit-lfs\t clean  --   %f\t ");
  write(ex.root, ".gitattributes", "*.bin filter=lfs\n");
  write(ex.root, "asset.bin", "binary fixture\n");
  const repo = await G.openRepo(ex.root);
  await G.runGit(repo, ["add", ".gitattributes", "asset.bin"]);
  await G.runGit(repo, ["commit", "-qm", "LFS content"]);
  assert.equal(git(ex.root, "show", "HEAD:asset.bin"), "binary fixture");
  rmSync(join(ex.root, "asset.bin"));
  await G.runGit(repo, ["checkout", "--", "asset.bin"]);
  assert.equal(readFileSync(join(ex.root, "asset.bin"), "utf8"), "binary fixture\n");
  const invocations = readFileSync(stub.marker, "utf8").trim().split("\n");
  assert.ok(invocations.includes("clean"));
  assert.ok(invocations.includes("smudge"));
  assert.ok(readFileSync(stub.skipMarker, "utf8").trim().split("\n").every(value => value === "1"));

  // Inspect the pinned process command without making the identity stub speak its protocol.
  git(ex.root, "config", "filter.lfs.process", "git-lfs filter-process");
  assert.equal((await G.runGit(repo, ["config", "--get", "filter.lfs.process"])).stdout.trim(), `'${join(stub.bin, "git-lfs")}' filter-process`);
  assert.equal((await G.runGit(repo, ["config", "--get", "filter.lfs.required"])).stdout.trim(), "true");
  // Naming a diff or merge driver lfs gives it no exemption.
  git(ex.root, "config", "diff.lfs.textconv", join(stub.bin, "git-lfs"));
  git(ex.root, "config", "merge.lfs.driver", join(stub.bin, "git-lfs"));
  assert.equal((await G.runGit(repo, ["config", "--get", "diff.lfs.textconv"])).stdout, "\n");
  assert.match((await G.runGit(repo, ["config", "--get", "merge.lfs.driver"])).stdout, /merge-file -- %A %O %B/);
});

test("LFS commands keep the approved executable when an earlier PATH directory gains git-lfs", async (t) => {
  for (const operation of ["clean", "smudge"]) {
    await t.test(operation, async (t) => {
      const ex = makeRepo({ ".gitattributes": "*.bin filter=lfs\n", "asset.bin": "binary fixture\n" });
      t.after(() => rmSync(ex.root, { recursive: true, force: true }));
      const realGit = findExecutable("git");
      assert.ok(realGit);
      // Spaces and a quote also exercise shell quoting of the pinned executable.
      const approvedDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-approved-")));
      t.after(() => rmSync(approvedDir, { recursive: true, force: true }));
      const stub = lfsStub(t, join(approvedDir, "lfs' bin"));
      configureLfs(ex.root);
      const earlier = join(ex.root, "bin");
      mkdirSync(earlier);
      const marker = join(ex.root, "unapproved-lfs.ran");
      const injected = join(earlier, "git-lfs");
      const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
      const payload = `#!/bin/sh\ntouch ${quote(marker)}\ncat\n`;
      const command = operation === "clean" ? "add" : "checkout";
      // The wrapper inserts the hostile executable only when the actual content command starts,
      // after the helper has resolved and validated the external LFS stub.
      executable(join(stub.bin, "git"), `#!/bin/sh\nfor arg do\n  if [ "$arg" = ${quote(command)} ]; then\n    printf '%s' ${quote(payload)} > ${quote(injected)}\n    chmod 755 ${quote(injected)}\n    break\n  fi\ndone\nexec ${quote(realGit)} "$@"\n`);
      process.env.PATH = `${earlier}${delimiter}${process.env.PATH}`;
      const repo = await G.openRepo(ex.root);
      assert.equal(existsSync(injected), false, "earlier PATH entry is empty at validation time");
      if (operation === "clean") {
        write(ex.root, "asset.bin", "updated fixture\n");
        await G.runGit(repo, ["add", "asset.bin"]);
        assert.equal(git(ex.root, "show", ":asset.bin"), "updated fixture");
      } else {
        rmSync(join(ex.root, "asset.bin"));
        await G.runGit(repo, ["checkout", "--", "asset.bin"]);
        assert.equal(readFileSync(join(ex.root, "asset.bin"), "utf8"), "binary fixture\n");
      }
      assert.equal(existsSync(injected), true, "race fixture installed the earlier executable");
      assert.equal(existsSync(marker), false, "the unapproved LFS executable never ran");
      assert.ok(readFileSync(stub.marker, "utf8").trim().split("\n").includes(operation), "the approved external stub ran");
    });
  }
});

test("non-standard LFS values are disabled and refused, including shadowed values", async (t) => {
  const cases = [
    ["clean", "git-lfs clean -- %f --extra"],
    ["clean", "sh -c 'git-lfs clean -- %f'"],
    ["clean", "./git-lfs clean -- %f"],
    ["clean", "ENV=value git-lfs clean -- %f"],
    ["clean", "git-lfs clean -- %f; true"],
    ["clean", "git-lfs\nclean -- %f"],
    ["clean", "git-lfs smudge -- %f"],
    ["smudge", "git-lfs smudge --skip -- %f"],
    ["process", "git-lfs filter-process --skip"],
    ["required", "false"],
    ["other", "git-lfs clean -- %f"],
    ["shadowed", "./git-lfs clean -- %f"],
  ];
  for (const [field, value] of cases) {
    await t.test(`${field}: ${JSON.stringify(value)}`, async (t) => {
      const ex = makeRepo();
      t.after(() => rmSync(ex.root, { recursive: true, force: true }));
      const stub = lfsStub(t);
      configureLfs(ex.root);
      if (field === "shadowed") {
        const included = write(ex.root, "lfs.config", `[filter "lfs"]\nclean = ${value}\n`);
        git(ex.root, "config", "include.path", included);
        git(ex.root, "config", "--add", "filter.lfs.clean", "git-lfs clean -- %f");
      } else {
        git(ex.root, "config", `filter.lfs.${field}`, value);
      }
      write(ex.root, ".gitattributes", "*.bin filter=lfs\n");
      write(ex.root, "asset.bin", "content\n");
      const repo = await G.openRepo(ex.root);
      assert.equal((await G.runGit(repo, ["config", "--get", "filter.lfs.clean"])).stdout, "\n", "clean is disabled");
      await G.runGit(repo, ["status", "--porcelain"]);
      await assert.rejects(G.runGit(repo, ["add", "asset.bin"]), (e) => e instanceof G.GitSafetyError && /filter "lfs"/.test(e.message));
      assert.equal(git(ex.root, "diff", "--cached", "--name-only"), "");
      assert.equal(existsSync(stub.marker), false);
    });
  }
});

test("LFS executables inside the repository, git dir or another worker root are refused", async (t) => {
  for (const location of ["work tree", "git dir", "other worker", "symlink into work tree"]) {
    await t.test(location, async (t) => {
      const ex = makeRepo();
      t.after(() => rmSync(ex.root, { recursive: true, force: true }));
      let bin = join(ex.root, "bin");
      if (location === "git dir") {
        const admin = realpathSync(mkdtempSync(join(tmpdir(), "rt-lfs-gitdir-")));
        t.after(() => rmSync(admin, { recursive: true, force: true }));
        git(ex.root, "init", "-q", "--separate-git-dir", admin);
        bin = join(admin, "bin");
      } else if (location === "other worker") {
        bin = join(WORKTREES_DIR, "other-execution", "other-task", "bin");
        t.after(() => rmSync(join(WORKTREES_DIR, "other-execution"), { recursive: true, force: true }));
      }
      const stub = lfsStub(t, bin);
      if (location === "symlink into work tree") {
        const external = realpathSync(mkdtempSync(join(tmpdir(), "rt-lfs-link-")));
        t.after(() => rmSync(external, { recursive: true, force: true }));
        symlinkSync(join(bin, "git-lfs"), join(external, "git-lfs"));
        process.env.PATH = `${external}${delimiter}${process.env.PATH}`;
      }
      configureLfs(ex.root);
      write(ex.root, ".gitattributes", "*.bin filter=lfs\n");
      write(ex.root, "asset.bin", "content\n");
      const repo = await G.openRepo(ex.root);
      assert.equal((await G.runGit(repo, ["config", "--get", "filter.lfs.clean"])).stdout, "\n");
      await G.runGit(repo, ["status", "--porcelain"]);
      await assert.rejects(G.runGit(repo, ["add", "asset.bin"]), (e) => e instanceof G.GitSafetyError && /filter "lfs"/.test(e.message));
      assert.equal(existsSync(stub.marker), false);
    });
  }
});

test("standard LFS config is disabled and refused when git-lfs is missing", async (t) => {
  const ex = makeRepo();
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const { findExecutable } = await import("../../dist/executables.js");
  const gitExecutable = findExecutable("git");
  assert.ok(gitExecutable);
  const stub = lfsStub(t);
  rmSync(join(stub.bin, "git-lfs"));
  symlinkSync(gitExecutable, join(stub.bin, "git"));
  process.env.PATH = stub.bin; // Deterministic even on hosts with real git-lfs installed.
  configureLfs(ex.root);
  write(ex.root, ".gitattributes", "*.bin filter=lfs\n");
  write(ex.root, "asset.bin", "content\n");
  const repo = await G.openRepo(ex.root);
  assert.equal((await G.runGit(repo, ["config", "--get", "filter.lfs.clean"])).stdout, "\n");
  await assert.rejects(G.runGit(repo, ["add", "asset.bin"]), (e) => e instanceof G.GitSafetyError && /filter "lfs"/.test(e.message));
  assert.equal(existsSync(stub.marker), false);
});

test("ignored paths and filters without clean, smudge or process settings do not block commits", async (t) => {
  const ex = makeRepo({ ".gitignore": "ignored.txt\n", ".gitattributes": "*.txt filter=fixture\n", "base.md": "base\n" });
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const repo = await G.openRepo(ex.root);
  git(ex.root, "config", "filter.fixture.clean", "cat");
  write(ex.root, "ignored.txt", "ignored\n");
  write(ex.root, "base.md", "updated\n");
  await G.runGit(repo, ["add", "base.md"]);
  await G.runGit(repo, ["commit", "-qm", "unfiltered change"]);
  assert.equal(git(ex.root, "show", "HEAD:base.md"), "updated");
  git(ex.root, "config", "--unset", "filter.fixture.clean");
  git(ex.root, "config", "filter.fixture.required", "true");
  write(ex.root, "new.txt", "content\n");
  await G.runGit(repo, ["add", "new.txt"]);
  await G.runGit(repo, ["commit", "-qm", "filter has no program settings"]);
  assert.equal(git(ex.root, "show", "HEAD:new.txt"), "content");
});

test("a repository without drivers keeps normal status, add, diff and commit behavior", async (t) => {
  const ex = makeRepo({ "f.txt": "before\n" });
  t.after(() => rmSync(ex.root, { recursive: true, force: true }));
  const repo = await G.openRepo(ex.root);
  assert.equal((await G.runGit(repo, ["status", "--porcelain"])).stdout, "");
  write(ex.root, "f.txt", "after\n");
  assert.match((await G.runGit(repo, ["diff"])).stdout, /^\+after$/m);
  await G.runGit(repo, ["add", "f.txt"]);
  await G.runGit(repo, ["commit", "-qm", "ordinary change"]);
  assert.equal((await G.runGit(repo, ["status", "--porcelain"])).stdout, "");
});

test("host git resolves absolute PATH entries from a task worktree", async t => {
  const ex = makeRepo();
  const originalPath = process.env.PATH;
  const originalCwd = process.cwd();
  t.after(() => {
    process.env.PATH = originalPath;
    process.chdir(originalCwd);
    rmSync(ex.root, { recursive: true, force: true });
  });
  const marker = join(ex.root, "selected-git");
  const script = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(77);\n`;
  executable(join(ex.root, "git"), script);
  executable(join(ex.root, "bin", "git"), script);
  process.chdir(ex.root);
  for (const entry of ["", ".", "bin", "./bin"]) {
    process.env.PATH = [entry, originalPath].join(delimiter);
    const repo = await G.openRepo(ex.root);
    const result = await G.runGit(repo, ["status", "--porcelain"]);
    assert.equal(result.exit, 0);
    assert.equal(existsSync(marker), false);
  }
});
