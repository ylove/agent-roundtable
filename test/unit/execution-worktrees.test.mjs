import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const W = await import("../../dist/execution/worktrees.js");
const { integrationBranch } = await import("../../dist/execution/git.js");
const { mergeTask } = await import("../../dist/execution/merge.js");
const { initialState } = await import("../../dist/execution/blackboard.js");
const { WORKTREES_DIR } = await import("../../dist/config.js");
const { executionTag } = await import("../../dist/ids.js");
const { git, gitTry, lines, makeExecution, write } = await import("../fixtures/execution/git-fixture.mjs");

const trailers = (ex, task, agent = "w1") => ({ execution: ex.header.id, task, agent });
const mode = (p) => statSync(p).mode & 0o777;

// ============================================================================
// Worktrees
// ============================================================================

test("integration and task worktrees: locations, branches, 0700 directories, reuse", async () => {
  const ex = await makeExecution();
  const tag = executionTag(ex.header.id);
  const integ = await W.ensureIntegrationWorktree(ex.header);
  assert.equal(integ.path, realpathSync(W.integrationWorktreePath(ex.header.id)));
  assert.ok(integ.path.endsWith(`/${ex.header.id}/_integration`));
  assert.equal(integ.branch, `rt/${tag}/integration`);
  assert.equal(integ.head, ex.sha);
  assert.equal(integ.created, true);
  assert.equal(git(integ.path, "symbolic-ref", "HEAD"), `refs/heads/rt/${tag}/integration`);
  for (const d of [WORKTREES_DIR, W.executionWorktreesDir(ex.header.id), integ.path]) assert.equal(mode(d), 0o700, d);

  const t = await W.ensureTaskWorktree(ex.header, "build-nav");
  assert.equal(t.branch, `rt/${tag}/build-nav`);
  assert.equal(t.head, ex.sha);
  assert.equal(t.created, true);
  assert.equal(mode(t.path), 0o700);
  assert.ok(t.path.endsWith(`/${ex.header.id}/build-nav`));

  // Reuse keeps uncommitted work in place (a resumed run).
  write(t.path, "wip.txt", "half done\n");
  const again = await W.ensureTaskWorktree(ex.header, "build-nav", "integration");
  assert.equal(again.created, false);
  assert.equal(again.path, t.path);
  assert.equal(readFileSync(join(t.path, "wip.txt"), "utf8"), "half done\n");
  assert.equal((await W.ensureIntegrationWorktree(ex.header)).created, false);

  const st = await W.worktreeStatus(t.path);
  assert.deepEqual(st, { path: t.path, branch: `rt/${tag}/build-nav`, head: ex.sha, dirty: ["wip.txt"], merging: false, conflicts: [] });

  for (const bad of ["integration", "a..b", "x.lock", "trailing.", "Upper", "../up"]) {
    await assert.rejects(W.ensureTaskWorktree(ex.header, bad), /cannot name a branch|Not a task id/, bad);
  }
  await assert.rejects(W.ensureTaskWorktree(ex.header, "t", "-x"), /startPoint must be/);
  await assert.rejects(W.ensureTaskWorktree(ex.header, "t", "main"), /startPoint must be/);
});

test("removing a worktree keeps its branch; ensuring again checks the branch out where it stands", async () => {
  const ex = await makeExecution();
  const t = await W.ensureTaskWorktree(ex.header, "keep");
  write(t.path, "a.txt", "a\n");
  const c = await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "a", trailers: trailers(ex, "keep") });
  const removed = await W.removeWorktree(t.path);
  assert.deepEqual(removed, { removed: true, branch: t.branch });
  assert.equal(existsSync(t.path), false);
  assert.equal(git(ex.root, "rev-parse", `refs/heads/${t.branch}`), c.commit);
  const back = await W.ensureTaskWorktree(ex.header, "keep");
  assert.equal(back.created, true);
  assert.equal(back.head, c.commit, "the existing branch, not a fresh one from base");
  assert.equal(readFileSync(join(back.path, "a.txt"), "utf8"), "a\n");

  await W.removeWorktree(back.path, { deleteBranch: true });
  assert.equal(git(ex.root, "branch", "--list", t.branch), "");
  assert.equal((await W.removeWorktree(back.path)).removed, false, "removing twice is a no-op");
});

test("an interrupted create (empty directory) is reused; a stale record is dropped; pruning", async () => {
  const ex = await makeExecution();
  const empty = W.taskWorktreePath(ex.header.id, "fresh");
  await W.ensureIntegrationWorktree(ex.header);
  mkdirSync(empty, { mode: 0o700 });
  assert.equal((await W.ensureTaskWorktree(ex.header, "fresh")).created, true);

  const occupied = W.taskWorktreePath(ex.header.id, "occupied");
  write(occupied, "junk.txt", "x");
  await assert.rejects(W.ensureTaskWorktree(ex.header, "occupied"), /exists and is not a worktree/);

  const gone = await W.ensureTaskWorktree(ex.header, "gone");
  rmSync(gone.path, { recursive: true, force: true });
  const pruned = await W.pruneWorktrees(ex.header.id);
  assert.deepEqual(pruned.pruned, [gone.path]);
  assert.equal((await W.ensureTaskWorktree(ex.header, "gone")).created, true, "re-created from its branch");

  const purge = await W.pruneWorktrees(ex.header, { remove: true, branches: true });
  assert.ok(purge.removed.length >= 3);
  assert.equal(existsSync(W.executionWorktreesDir(ex.header.id)), false);
  const tag = executionTag(ex.header.id);
  assert.equal(git(ex.root, "for-each-ref", "--format=%(refname)", `refs/heads/rt/${tag}/`), "");
  assert.equal(git(ex.root, "worktree", "list").split("\n").length, 1, "only the main work tree is left");
});

test("taskStartPoint is integration once a dependency is accepted; such a task starts from the merged work", async () => {
  const ex = await makeExecution();
  const s = initialState(ex.header.id);
  const spec = (id, depends_on = []) => ({ id, title: id, persona: "p", kind: "build", depends_on, paths: { write: ["**"] }, acceptance: [], checks: [] });
  s.tasks.api = { spec: spec("api"), state: "in_progress", attempt: 1 };
  s.tasks.ui = { spec: spec("ui", ["api"]), state: "pending", attempt: 0 };
  assert.equal(W.taskStartPoint(s, "api"), "base");
  assert.equal(W.taskStartPoint(s, "ui"), "base");

  const api = await W.ensureTaskWorktree(ex.header, "api");
  write(api.path, "api.ts", "export const api = 1;\n");
  await W.commitLeasedPaths(api.path, [{ paths: ["**"] }], { message: "api", trailers: trailers(ex, "api") });
  const m = await mergeTask(ex.header, "api");
  assert.equal(m.ok, true);
  s.tasks.api.state = "accepted";
  assert.equal(W.taskStartPoint(s, "ui"), "integration");

  const ui = await W.ensureTaskWorktree(ex.header, "ui", W.taskStartPoint(s, "ui"));
  assert.equal(ui.head, m.sha);
  assert.equal(readFileSync(join(ui.path, "api.ts"), "utf8"), "export const api = 1;\n");
  const pinned = await W.ensureTaskWorktree(ex.header, "pinned", ex.sha);
  assert.equal(pinned.head, ex.sha);
});

// ============================================================================
// Enforcement
// ============================================================================

/** A task branch carrying `edit`, committed under a lease that covers everything (enforcement judges the branch). */
async function committed(ex, task, edit) {
  const t = await W.ensureTaskWorktree(ex.header, task);
  edit(t.path);
  await W.commitLeasedPaths(t.path, [{ paths: ["**", ".gitattributes"] }], { message: task, trailers: trailers(ex, task) });
  return t;
}

test("enforcement: in-lease edits pass, edits outside the lease are violations", async () => {
  const ex = await makeExecution({ "src/nav/bar.ts": "bar\n", "docs/readme.md": "docs\n" });
  const base = integrationBranch(ex.header.id);
  const t = await committed(ex, "nav", (p) => {
    write(p, "src/nav/bar.ts", "bar v2\n");
    write(p, "src/nav/new.ts", "new\n");
  });
  const leases = [{ paths: ["src/nav/**"] }];
  const ok = await W.checkLeaseCoverage(t.path, base, leases);
  assert.equal(ok.ok, true);
  assert.equal(ok.base, ex.sha);
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(W.touchedPaths(ok.changes).sort(), ["src/nav/bar.ts", "src/nav/new.ts"]);

  write(t.path, "docs/readme.md", "sneaky\n");
  await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "docs", trailers: trailers(ex, "nav") });
  const bad = await W.checkLeaseCoverage(t.path, base, leases);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.violations, ["docs/readme.md"]);
  assert.deepEqual(bad.details, [{ path: "docs/readme.md", reason: "not leased" }]);
  assert.equal(await W.mergeBase(t.path, base), ex.sha);
});

test("enforcement: a rename out of a leased directory touches both paths", async () => {
  const ex = await makeExecution({ "src/nav/bar.ts": lines(20) });
  const t = await committed(ex, "mover", (p) => {
    mkdirSync(join(p, "lib"));
    renameSync(join(p, "src/nav/bar.ts"), join(p, "lib/bar.ts"));
  });
  const changes = await W.changedPaths(t.path, integrationBranch(ex.header.id));
  assert.deepEqual(changes.map((c) => [c.status, c.from, c.path]), [["R", "src/nav/bar.ts", "lib/bar.ts"]]);
  const cov = await W.checkLeaseCoverage(t.path, integrationBranch(ex.header.id), [{ paths: ["src/nav/**"] }]);
  assert.deepEqual(cov.violations, ["lib/bar.ts"]);
  const into = await W.checkLeaseCoverage(t.path, integrationBranch(ex.header.id), [{ paths: ["lib/**"] }]);
  assert.deepEqual(into.violations, ["src/nav/bar.ts"], "deleting the unleased source counts too");
});

test("enforcement: .gitattributes needs an explicit lease; escaping symlinks are refused", async () => {
  const ex = await makeExecution({ "src/a.ts": "a\n" });
  const base = integrationBranch(ex.header.id);
  const t = await committed(ex, "meta", (p) => {
    write(p, ".gitattributes", "* merge=ours\n");
    write(p, "src/a.ts", "a2\n");
  });
  const broad = await W.checkLeaseCoverage(t.path, base, [{ paths: ["**"] }]);
  assert.deepEqual(broad.details, [{ path: ".gitattributes", reason: "git metadata needs an explicit lease" }]);
  const narrow = await W.checkLeaseCoverage(t.path, base, [{ paths: ["src/**"] }]);
  assert.deepEqual(narrow.details, [{ path: ".gitattributes", reason: "not leased" }]);
  const explicit = await W.checkLeaseCoverage(t.path, base, [{ paths: ["src/**", ".gitattributes"] }]);
  assert.equal(explicit.ok, true);

});

const linkCases = [
  { name: "two-link escape through ..", links: { "dir/up": "..", escape: "dir/up/../outside" }, unsafe: ["escape"] },
  { name: "cycle", links: { a: "b", b: "a" }, unsafe: ["a", "b"] },
  { name: "dangling link inside the tree", links: { dangling: "missing" }, unsafe: ["dangling"] },
  { name: "safe relative chain inside the tree", links: { "dir/up": "..", safe: "dir/up/outside" }, unsafe: [] },
  { name: "absolute target", links: { absolute: "/etc/passwd" }, unsafe: ["absolute"] },
  { name: "temporary escape then return", links: { escape: "../root/outside" }, unsafe: ["escape"] },
  { name: "missing component before ..", links: { dangling: "missing/../outside" }, unsafe: ["dangling"] },
  { name: "file component before ..", links: { invalid: "outside/../outside" }, unsafe: ["invalid"] },
];

for (const { name, links, unsafe } of linkCases) {
  test(`commit symlink resolution: ${name}`, async () => {
    const ex = await makeExecution({ "dir/keep": "keep\n", outside: "inside root\n" });
    const t = await W.ensureTaskWorktree(ex.header, "links");
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(t.path, path));
    const r = await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "links", trailers: trailers(ex, "links") });
    assert.deepEqual(r.rejected.map((v) => v.path).sort(), [...unsafe].sort());
    const allowed = Object.keys(links).filter((path) => !unsafe.includes(path)).sort();
    assert.deepEqual(r.files.sort(), allowed);
    assert.equal(r.created, allowed.length > 0);
    assert.equal((await W.checkLeaseCoverage(t.path, ex.sha, [{ paths: ["**"] }])).ok, true);
  });

  test(`range symlink resolution uses committed blobs: ${name}`, async () => {
    const ex = await makeExecution({ "dir/keep": "keep\n", outside: "inside root\n" });
    const t = await W.ensureTaskWorktree(ex.header, "links");
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(t.path, path));
    // Bypass the API in this temporary fixture to simulate a hostile submitted branch.
    git(t.path, "add", "-A");
    git(t.path, "commit", "-q", "--no-verify", "-m", "submitted links");
    const tip = git(t.path, "rev-parse", "HEAD");
    // The checkout must have no influence on tree-based coverage checks.
    for (const path of Object.keys(links)) rmSync(join(t.path, path));
    const cov = await W.checkLeaseCoverage(t.path, ex.sha, [{ paths: ["**"] }]);
    assert.equal(cov.ok, unsafe.length === 0);
    assert.deepEqual(cov.details, [...unsafe].sort().map((path) => ({ path, reason: "symlink leaves the worktree" })));
    // An arbitrary tip must be checked even when HEAD now contains a different tree.
    git(t.path, "add", "-A");
    git(t.path, "commit", "-q", "--no-verify", "-m", "remove links");
    const { target } = await W.openWorktree(t.path);
    const range = await W.checkRangeCoverage(target, ex.sha, tip, [{ paths: ["**"] }]);
    assert.deepEqual(range.details, cov.details);
  });
}

test("symlink resolution allows 40 hops and refuses longer chains", async () => {
  for (const count of [40, 41]) {
    const ex = await makeExecution({ target: "inside\n" });
    const t = await W.ensureTaskWorktree(ex.header, "hops");
    for (let i = 0; i < count; i++) symlinkSync(i + 1 === count ? "target" : `link${i + 1}`, join(t.path, `link${i}`));
    const r = await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "chain", trailers: trailers(ex, "hops") });
    assert.deepEqual(r.rejected.map((v) => v.path), count === 40 ? [] : ["link0"]);
    git(t.path, "add", "-A");
    if (count === 41) git(t.path, "commit", "-q", "--no-verify", "-m", "long chain");
    const cov = await W.checkLeaseCoverage(t.path, ex.sha, [{ paths: ["**"] }]);
    assert.deepEqual(cov.violations, count === 40 ? [] : ["link0"]);
  }
});

test("commit checks the proposed tree when a link target is outside the leases", async () => {
  const ex = await makeExecution();
  const t = await W.ensureTaskWorktree(ex.header, "links");
  write(t.path, "unleased", "exists only on disk\n");
  symlinkSync("unleased", join(t.path, "link"));
  await assert.rejects(
    W.commitLeasedPaths(t.path, [{ paths: ["link"] }], { message: "link", trailers: trailers(ex, "links") }),
    (e) => e instanceof W.CommitRefusedError && e.paths.includes("link")
  );
  assert.equal(git(t.path, "rev-parse", "HEAD"), ex.sha);
  assert.equal(git(t.path, "diff", "--cached", "--name-only"), "");
});

test("commit and range checks revalidate unchanged links when their target is deleted", async () => {
  const ex = await makeExecution({ target: "inside\n" });
  const t = await W.ensureTaskWorktree(ex.header, "links");
  symlinkSync("target", join(t.path, "link"));
  const safe = await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "safe", trailers: trailers(ex, "links") });
  rmSync(join(t.path, "target"));
  await assert.rejects(
    W.commitLeasedPaths(t.path, [{ paths: ["target"] }], { message: "delete", trailers: trailers(ex, "links") }),
    (e) => e instanceof W.CommitRefusedError && e.paths.includes("link")
  );
  assert.equal(git(t.path, "rev-parse", "HEAD"), safe.commit);
  git(t.path, "add", "-A");
  git(t.path, "commit", "-q", "--no-verify", "-m", "delete target");
  const cov = await W.checkLeaseCoverage(t.path, safe.commit, [{ paths: ["target"] }]);
  assert.deepEqual(cov.violations, ["link"]);
});

// ============================================================================
// Commits
// ============================================================================

test("commitLeasedPaths commits only leased paths, with trailers, and a scrubbed message", async () => {
  const ex = await makeExecution({ "src/a.ts": "a\n", "docs/b.md": "b\n", "keep.txt": "k\n" });
  const t = await W.ensureTaskWorktree(ex.header, "build");
  write(t.path, "src/a.ts", "a2\n");
  write(t.path, "src/new.ts", "n\n");
  write(t.path, "docs/b.md", "b2\n");
  write(t.path, "stray.txt", "s\n");
  rmSync(join(t.path, "keep.txt"));
  process.env.WS06_TEST_API_KEY = "sk-test-not-really-a-secret-1234567890";
  let r;
  try {
    r = await W.commitLeasedPaths(t.path, [{ paths: ["src/**"] }, { paths: ["keep.txt"] }], {
      message: `Build the thing\n\nUsed key ${process.env.WS06_TEST_API_KEY}\nRoundtable-Task: someone-else\n`,
      trailers: trailers(ex, "build", "worker-7"),
      summaryBase: integrationBranch(ex.header.id),
    });
  } finally {
    delete process.env.WS06_TEST_API_KEY;
  }
  assert.equal(r.created, true);
  assert.deepEqual(r.files.sort(), ["keep.txt", "src/a.ts", "src/new.ts"]);
  assert.match(r.stat, /3 files changed/);
  assert.deepEqual(r.uncovered.sort(), ["docs/b.md", "stray.txt"]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(git(t.path, "show", "--name-only", "--format=", r.commit).split("\n").sort(), ["keep.txt", "src/a.ts", "src/new.ts"]);
  const status = (await W.worktreeStatus(t.path)).dirty.sort();
  assert.deepEqual(status, ["docs/b.md", "stray.txt"], "unleased changes stay in the worktree, uncommitted");

  const body = git(t.path, "log", "-1", "--format=%B", r.commit);
  assert.doesNotMatch(body, /sk-test-not-really/);
  assert.match(body, /\[redacted/);
  assert.doesNotMatch(body, /someone-else/, "forged trailers are dropped");
  const parsed = git(t.path, "log", "-1", "--format=%(trailers:only,unfold)", r.commit);
  assert.equal(parsed, `Roundtable-Execution: ${ex.header.id}\nRoundtable-Task: build\nRoundtable-Agent: worker-7`);

  const none = await W.commitLeasedPaths(t.path, [{ paths: ["src/**"] }], { message: "nothing", trailers: trailers(ex, "build") });
  assert.equal(none.created, false);
  assert.equal(none.commit, r.commit);

  await assert.rejects(
    W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "x", trailers: trailers(ex, "other-task") }),
    /must name this worktree's execution/
  );
  await assert.rejects(
    W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "x", trailers: { ...trailers(ex, "build"), agent: "bad\nagent" } }),
    /Invalid Roundtable-Agent/
  );
});

test("commits never take nested repositories, .git paths or escaping symlinks; .gitattributes needs its lease", async () => {
  const ex = await makeExecution({ "src/a.ts": "a\n" });
  const t = await W.ensureTaskWorktree(ex.header, "odd");
  write(t.path, "src/inner/x.txt", "x\n");
  git(join(t.path, "src/inner"), "init", "-q");
  symlinkSync("../../../../etc/passwd", join(t.path, "src", "passwd"));
  symlinkSync("a.ts", join(t.path, "src", "alias.ts"));
  write(t.path, ".gitattributes", "* merge=ours\n");
  const r = await W.commitLeasedPaths(t.path, [{ paths: ["**"] }], { message: "odd", trailers: trailers(ex, "odd") });
  assert.deepEqual(r.files, ["src/alias.ts"]);
  assert.deepEqual(
    r.rejected.map((x) => [x.path, x.reason]).sort(),
    [
      ["src/inner/", "nested repository"],
      ["src/passwd", "symlink leaves the worktree"],
    ]
  );
  assert.deepEqual(r.uncovered, [".gitattributes"]);
  const r2 = await W.commitLeasedPaths(t.path, [{ paths: ["**", ".gitattributes"] }], { message: "attrs", trailers: trailers(ex, "odd") });
  assert.deepEqual(r2.files, [".gitattributes"]);
});

test("snapshotWip commits all WIP, or only leased paths; diffForTask is capped; rewrites are reported", async () => {
  const ex = await makeExecution({ "big.txt": lines(200), "small.txt": "s\n" });
  const t = await W.ensureTaskWorktree(ex.header, "wip");
  write(t.path, "big.txt", lines(200, "totally different"));
  write(t.path, "small.txt", "s2\n");
  write(t.path, "other.txt", "o\n");
  const leased = await W.snapshotWip(t.path, undefined, [{ paths: ["small.txt"] }]);
  assert.deepEqual(leased.files, ["small.txt"]);
  assert.deepEqual(leased.uncovered.sort(), ["big.txt", "other.txt"]);
  const everything = await W.snapshotWip(t.path);
  assert.deepEqual(everything.files.sort(), ["big.txt", "other.txt"]);
  assert.deepEqual(everything.rewrites, ["big.txt"]);
  assert.match(git(t.path, "log", "-1", "--format=%B"), /^rt: wip snapshot\n\nRoundtable-Execution: .+\nRoundtable-Task: wip$/);
  assert.equal((await W.worktreeStatus(t.path)).dirty.length, 0);

  const summary = await W.taskDiffSummary(t.path, integrationBranch(ex.header.id));
  assert.deepEqual(summary.files.sort(), ["big.txt", "other.txt", "small.txt"]);
  assert.deepEqual(summary.rewrites, ["big.txt"]);
  const diff = await W.diffForTask(t.path, integrationBranch(ex.header.id));
  assert.match(diff, /^diff --git a\/big.txt b\/big.txt/m);
  assert.match(diff, /^\+totally different 1$/m);
  const capped = await W.diffForTask(t.path, integrationBranch(ex.header.id), 500);
  assert.ok(Buffer.byteLength(capped) < 600);
  assert.match(capped, /\[diff truncated at 500 bytes\]\n$/);
});

test("withCommitCheckout: a private detached checkout of one commit, removed afterwards (also on a throw and by prune)", async () => {
  const ex = await makeExecution({ "README.md": "base\n" });
  const t = await W.ensureTaskWorktree(ex.header, "build-nav");
  write(t.path, "README.md", "committed\n");
  git(t.path, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qam", "change");
  const sha = git(t.path, "rev-parse", "HEAD");
  write(t.path, "README.md", "uncommitted\n");
  let checks;
  const seen = await W.withCommitCheckout(ex.header, "build-nav", sha, async (dir) => {
    checks = realpathSync(W.executionChecksDir(ex.header.id));
    assert.ok(dir.startsWith(`${checks}/build-nav-`), dir);
    assert.equal(mode(dir), 0o700);
    assert.ok(statSync(join(dir, ".git")).isFile(), "a gitfile, mounted read-only by the docker backend");
    assert.equal(git(dir, "rev-parse", "HEAD"), sha);
    assert.equal(gitTry(dir, "symbolic-ref", "-q", "HEAD").status, 1, "detached");
    return readFileSync(join(dir, "README.md"), "utf8");
  });
  assert.equal(seen, "committed\n");
  assert.deepEqual(readdirSync(checks), []);
  assert.doesNotMatch(git(ex.root, "worktree", "list", "--porcelain"), /\/checks\//);

  await assert.rejects(W.withCommitCheckout(ex.header, "build-nav", sha, async () => { throw new Error("check crashed"); }), /check crashed/);
  assert.deepEqual(readdirSync(checks), []);
  await assert.rejects(W.withCommitCheckout(ex.header, "build-nav", "HEAD", async () => 1), /full commit id/);
  await assert.rejects(W.withCommitCheckout(ex.header, "build-nav", "0".repeat(40), async () => 1), /does not name a commit/);

  // A crash mid-check leaves the checkout behind: prune with remove takes it and its record.
  const left = join(checks, "build-nav-dead");
  git(ex.root, "worktree", "add", "-q", "--detach", left, sha);
  assert.match(git(ex.root, "worktree", "list", "--porcelain"), /\/checks\//);
  const pruned = await W.pruneWorktrees(ex.header, { remove: true });
  assert.ok(pruned.removed.includes(left), JSON.stringify(pruned));
  assert.equal(existsSync(checks), false);
  assert.doesNotMatch(git(ex.root, "worktree", "list", "--porcelain"), /\/checks\//);
});
