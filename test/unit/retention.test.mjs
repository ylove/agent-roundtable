// WS11 (#92): the startup retention sweep, with a fake clock. Finished runs past the retention
// period lose their worktrees, branches and directory (audited); live and recent runs stay;
// archived sessions and audit month files are pruned on their own periods.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitTry } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, runner } from "../fixtures/workers/run.mjs";

const { sweepRetention, describeRetention } = await import("../../dist/execution/retention.js");
const { ensureTaskWorktree, executionWorktreesDir } = await import("../../dist/execution/worktrees.js");
const { taskBranch } = await import("../../dist/execution/git.js");
const { appendAudit, verifyAudit } = await import("../../dist/security/audit.js");
const { archiveSession, readArchivedSession } = await import("../../dist/sessions/archive.js");
const { AUDIT_DIR } = await import("../../dist/config.js");

const DAY = 86_400_000;
const later = (days) => Date.now() + days * DAY;
const auditEntries = () =>
  readdirSync(AUDIT_DIR).filter((p) => p.endsWith(".jsonl")).flatMap((p) => readFileSync(join(AUDIT_DIR, p), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));

async function finished(status = "aborted") {
  const run = await makeRun();
  await ensureTaskWorktree(run.store.header(), "api");
  const type = status === "aborted" ? "execution.aborted" : status === "failed" ? "execution.failed" : "execution.completed";
  const payload = status === "completed" ? { integration_sha: run.sha } : { reason: "done with it" };
  await run.store.transact(() => ({ events: [{ type, source: runner, payload }] }));
  return run;
}

// First, so the old audit month comes before every entry the later tests append.
test("retention: audit month files past their period go (the newest stays), sessions on their own period", async () => {
  const old = Date.UTC(2024, 0, 10);
  await appendAudit({ actor: "test", action: "test.old" }, { now: old });
  await appendAudit({ actor: "test", action: "test.new" });
  const ended = (days) => new Date(Date.now() - days * DAY).toISOString();
  archiveSession({ id: "meeting-ws11old", kind: "meeting", agents: ["cfo"], topic: "old", started: ended(41), ended: ended(40), turns: [], public: null });
  archiveSession({ id: "meeting-ws11new", kind: "meeting", agents: ["cfo"], topic: "new", started: ended(3), ended: ended(2), turns: [], public: null });
  const r = await sweepRetention({ executionDays: null });
  assert.deepEqual(r.sessions, ["meeting-ws11old"]);
  assert.deepEqual(r.audit, ["audit-2024-01.jsonl"]);
  assert.deepEqual(r.executions, []);
  assert.equal(readArchivedSession("meeting-ws11old"), null);
  assert.ok(readArchivedSession("meeting-ws11new"));
  assert.ok((await verifyAudit()).ok, "the chain still verifies from its anchor");
  assert.match(describeRetention(r), /pruned 0 runs, 1 archived session, 1 audit month file$/);
  const none = await sweepRetention({ executionDays: null, sessionDays: null, auditDays: null, now: later(1000) });
  assert.deepEqual(none, { executions: [], sessions: [], audit: [], errors: [] });
});

test("retention: finished runs past the period lose worktrees, branches and directory; live and recent runs stay", async (t) => {
  const done = await finished("aborted");
  const completed = await finished("completed");
  const live = await makeRun();
  t.after(() => [done, completed, live].forEach((r) => rmSync(r.root, { recursive: true, force: true })));
  assert.ok(existsSync(join(executionWorktreesDir(done.store.id), "api")));

  const recent = await sweepRetention({ now: later(10), sessionDays: null, auditDays: null });
  assert.deepEqual(recent.executions, [], "within 30 days");

  const r = await sweepRetention({ now: later(31), sessionDays: null, auditDays: null });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.executions.sort(), [done.store.id, completed.store.id].sort());
  for (const run of [done, completed]) {
    assert.ok(!existsSync(run.store.dir), "execution directory removed");
    assert.ok(!existsSync(executionWorktreesDir(run.store.id)), "worktrees removed");
    assert.notEqual(gitTry(run.root, "rev-parse", "--verify", "--quiet", taskBranch(run.store.id, "api")).status, 0, "task branch deleted");
    assert.ok(auditEntries().some((e) => e.action === "execution.purged" && e.target === run.store.id && e.actor === "retention"));
  }
  assert.ok(existsSync(live.store.dir), "a running run is never pruned");
});

test("retention: a finished run whose repository is gone loses its directories; 0 or off keeps everything", async () => {
  const gone = await finished("failed");
  const kept = await finished("completed");
  rmSync(gone.root, { recursive: true, force: true });
  process.env.ROUNDTABLE_EXECUTION_RETENTION_DAYS = "off";
  try {
    assert.deepEqual((await sweepRetention({ now: later(400), sessionDays: null, auditDays: null })).executions, []);
  } finally {
    delete process.env.ROUNDTABLE_EXECUTION_RETENTION_DAYS;
  }
  process.env.ROUNDTABLE_EXECUTION_RETENTION_DAYS = "45";
  try {
    assert.deepEqual((await sweepRetention({ now: later(40), sessionDays: null, auditDays: null })).executions, [], "45 days");
    const r = await sweepRetention({ now: later(46), sessionDays: null, auditDays: null });
    assert.ok(r.executions.includes(gone.store.id) && r.executions.includes(kept.store.id), JSON.stringify(r));
  } finally {
    delete process.env.ROUNDTABLE_EXECUTION_RETENTION_DAYS;
    rmSync(kept.root, { recursive: true, force: true });
  }
  assert.ok(!existsSync(gone.store.dir) && !existsSync(executionWorktreesDir(gone.store.id)));
  assert.ok(auditEntries().some((e) => e.action === "execution.purged" && e.target === gone.store.id && e.details.repo_missing === true));
});
