import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const W = await import("../../dist/execution/worktrees.js");
const M = await import("../../dist/execution/merge.js");
const { integrationBranch } = await import("../../dist/execution/git.js");
const { validateDraft } = await import("../../dist/execution/events.js");
const { executionDir } = await import("../../dist/execution/store.js");
const { git, lines, makeExecution, src, write } = await import("../fixtures/execution/git-fixture.mjs");

const LOCK_HOLDER = fileURLToPath(new URL("../fixtures/execution/lock-holder.mjs", import.meta.url));
const all = [{ paths: ["**"] }];
const trailers = (ex, task) => ({ execution: ex.header.id, task, agent: "w1" });

/** A task branch with `files` written and committed. */
async function task(ex, id, files) {
  const t = await W.ensureTaskWorktree(ex.header, id);
  for (const [rel, content] of Object.entries(files)) write(t.path, rel, content);
  await W.commitLeasedPaths(t.path, all, { message: `${id} work`, trailers: trailers(ex, id) });
  return t;
}

const integrationClean = async (ex) => {
  const s = await W.worktreeStatus(W.integrationWorktreePath(ex.header.id));
  return { dirty: s.dirty, merging: s.merging, head: s.head };
};

test("two tasks touching different files both merge, as --no-ff merge commits with trailers", async () => {
  const ex = await makeExecution({ "shared.txt": lines(10) });
  await task(ex, "alpha", { "alpha.txt": "a\n" });
  await task(ex, "beta", { "beta.txt": "b\n" });
  const a = await M.mergeTask(ex.header, "alpha");
  assert.equal(a.ok, true);
  assert.equal(a.already, false);
  const b = await M.mergeTask(ex.header, "beta");
  assert.equal(b.ok, true);
  const integ = W.integrationWorktreePath(ex.header.id);
  assert.equal(readFileSync(join(integ, "alpha.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(integ, "beta.txt"), "utf8"), "b\n");
  assert.equal(git(integ, "rev-parse", "HEAD"), b.sha);
  assert.equal(git(integ, "rev-parse", `${b.sha}^1`), a.sha, "beta merged on top of alpha");
  assert.equal(git(integ, "log", "-1", "--format=%P", a.sha).split(" ").length, 2, "a merge commit even when a fast-forward was possible");
  assert.match(git(integ, "log", "-1", "--format=%B", b.sha), /^rt: merge task beta\n\nRoundtable-Execution: exe-\w+\nRoundtable-Task: beta$/);
  assert.equal(git(ex.root, "rev-parse", "main"), ex.sha, "the base branch is never touched");

  const again = await M.mergeTask(ex.header, "beta");
  assert.deepEqual(again, { ok: true, sha: b.sha, already: true });
  await assert.rejects(M.mergeTask(ex.header, "nobody"), /has no branch/);
  await assert.rejects(M.mergeTask(ex.header, "Bad"), /Not a task id/);
});

test("a same-line conflict is aborted, leaving the integration branch and worktree clean", async () => {
  const ex = await makeExecution({ "c.txt": lines(5) });
  await task(ex, "left", { "c.txt": lines(5).replace("line 3", "LEFT") });
  await task(ex, "right", { "c.txt": lines(5).replace("line 3", "RIGHT"), "right-only.txt": "r\n" });
  const first = await M.mergeTask(ex.header, "left");
  assert.equal(first.ok, true);
  // Leftover output from integration checks must not block or survive the merge.
  write(W.integrationWorktreePath(ex.header.id), "check-output.log", "x\n");
  const second = await M.mergeTask(ex.header, "right");
  assert.deepEqual(second, { ok: false, reason: "conflict", conflicts: ["c.txt"], violations: [] });
  assert.deepEqual(await integrationClean(ex), { dirty: [], merging: false, head: first.sha });

  assert.equal(M.classifyConflict(second.conflicts, [{ paths: ["c.txt"] }]), "inside");
  assert.equal(M.classifyConflict(second.conflicts, [{ paths: ["right-only.txt"] }]), "outside");
  assert.equal(M.classifyConflict(["c.txt", "docs/x.md"], [{ paths: ["*.txt"] }]), "outside");
  assert.equal(M.classifyConflict([".gitattributes"], all), "outside", ".git* needs an explicit lease");
});

test("prepareConflictResolution leaves markers; the worker's resolution concludes the merge and re-merges", async () => {
  const ex = await makeExecution({ "c.txt": lines(5), "untouched.txt": "u\n" });
  await task(ex, "left", { "c.txt": lines(5).replace("line 3", "LEFT"), "left-only.txt": "l\n" });
  const right = await task(ex, "right", { "c.txt": lines(5).replace("line 3", "RIGHT") });
  assert.equal((await M.mergeTask(ex.header, "left")).ok, true);
  const conflict = await M.mergeTask(ex.header, "right");
  assert.equal(conflict.ok, false);

  const prep = await M.prepareConflictResolution(ex.header, "right");
  assert.deepEqual(prep.conflicts, ["c.txt"]);
  assert.equal(prep.merged, false);
  const marked = readFileSync(join(right.path, "c.txt"), "utf8");
  assert.match(marked, /^<<<<<<< /m);
  assert.match(marked, /^>>>>>>> /m);
  const status = await W.worktreeStatus(right.path);
  assert.equal(status.merging, true);
  assert.deepEqual(status.conflicts, ["c.txt"]);
  assert.deepEqual(await M.prepareConflictResolution(ex.header, "right"), prep, "idempotent while the merge is open");

  const leases = [{ paths: ["c.txt"] }];
  await assert.rejects(
    W.commitLeasedPaths(right.path, leases, { message: "resolve", trailers: trailers(ex, "right") }),
    (e) => e.name === "CommitRefusedError" && /Conflict markers remain in c.txt/.test(e.message)
  );
  write(right.path, "c.txt", lines(5).replace("line 3", "LEFT and RIGHT"));
  const resolved = await W.commitLeasedPaths(right.path, leases, {
    message: "Resolve the conflict",
    trailers: trailers(ex, "right"),
    summaryBase: integrationBranch(ex.header.id),
  });
  assert.equal(resolved.created, true);
  assert.deepEqual(resolved.uncovered, [], "left-only.txt came with the merge; it is not the worker's edit");
  assert.deepEqual(resolved.files, ["c.txt"], "measured against the integration branch, only the task's own change");
  assert.equal(git(right.path, "log", "-1", "--format=%P").split(" ").length, 2, "the resolution is a merge commit");
  assert.equal((await W.worktreeStatus(right.path)).merging, false);
  const cov = await W.checkLeaseCoverage(right.path, integrationBranch(ex.header.id), leases);
  assert.deepEqual(cov.violations, []);

  const again = await M.mergeTask(ex.header, "right", { leases });
  assert.equal(again.ok, true);
  const integ = W.integrationWorktreePath(ex.header.id);
  assert.equal(readFileSync(join(integ, "c.txt"), "utf8"), lines(5).replace("line 3", "LEFT and RIGHT"));
  assert.equal(readFileSync(join(integ, "left-only.txt"), "utf8"), "l\n");
});

test("prepareConflictResolution merges cleanly when it can, and refuses a dirty worktree", async () => {
  const ex = await makeExecution({ "a.txt": "a\n" });
  await task(ex, "one", { "one.txt": "1\n" });
  const two = await task(ex, "two", { "two.txt": "2\n" });
  assert.equal((await M.mergeTask(ex.header, "one")).ok, true);
  write(two.path, "two.txt", "dirty\n");
  await assert.rejects(M.prepareConflictResolution(ex.header, "two"), /uncommitted changes \(two.txt\)/);
  git(two.path, "checkout", "--", "two.txt");
  const clean = await M.prepareConflictResolution(ex.header, "two");
  assert.deepEqual(clean.conflicts, []);
  assert.equal(clean.merged, true);
  assert.equal(readFileSync(join(two.path, "one.txt"), "utf8"), "1\n");
});

test("a merge whose branch strays outside the leases is refused before merging", async () => {
  const ex = await makeExecution({ "src/a.ts": "a\n" });
  await task(ex, "stray", { "src/a.ts": "a2\n", "docs/x.md": "x\n" });
  const before = await integrationClean(ex);
  const r = await M.mergeTask(ex.header, "stray", { leases: [{ paths: ["src/**"] }] });
  assert.deepEqual(r, { ok: false, reason: "violation", conflicts: [], violations: ["docs/x.md"] });
  assert.deepEqual(await integrationClean(ex), before);
});

test("concurrent mergeTask calls are serialized by git.lock", async () => {
  const ex = await makeExecution({ "base.txt": "b\n" });
  const ids = ["p1", "p2", "p3"];
  for (const id of ids) await task(ex, id, { [`${id}.txt`]: `${id}\n` });
  const results = await Promise.all(ids.map((id) => M.mergeTask(ex.header, id)));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  const integ = W.integrationWorktreePath(ex.header.id);
  const firstParents = git(integ, "rev-list", "--first-parent", "--merges", "HEAD").split("\n");
  assert.equal(firstParents.length, 3, "three merges, one after another on the first-parent chain");
  assert.deepEqual(new Set(results.map((r) => r.sha)), new Set(firstParents));

  // Another process holding git.lock makes the merge wait until it lets go.
  await task(ex, "late", { "late.txt": "l\n" });
  const holder = spawn(process.execPath, [LOCK_HOLDER, join(executionDir(ex.header.id), "git.lock")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    holder.stdout.on("data", (d) => /^held /.test(String(d)) && resolve());
    holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  let done = false;
  const pending = M.mergeTask(ex.header, "late").then((r) => {
    done = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(done, false, "waiting for the lock");
  holder.kill("SIGKILL");
  const late = await pending;
  assert.equal(late.ok, true);
});

test("merge draft builders produce valid events", () => {
  assert.deepEqual(validateDraft(M.mergeDrafts.succeeded("alpha", "a".repeat(40), src)).payload, { task: "alpha", sha: "a".repeat(40) });
  assert.deepEqual(validateDraft(M.mergeDrafts.taskMerged("alpha", "b".repeat(40), src)).payload, { task: "alpha", integration_sha: "b".repeat(40) });
  const many = Array.from({ length: 1000 }, (_, i) => `some/deep/path/${i}/conflicted-file.ts`);
  const c = validateDraft(M.mergeDrafts.conflicted("alpha", many, src));
  assert.equal(c.type, "merge.conflicted");
  assert.ok(c.payload.files.length < many.length);
});
