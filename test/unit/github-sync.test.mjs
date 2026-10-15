import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubSync, statusFor, ghText } from "../../dist/github/sync.js";
import { checkGhReady, classifyGhError, runGh, withBodyFile } from "../../dist/github/gh.js";
import { emit, frozenRun, makeContract, src, taskSpec } from "../fixtures/execution/run.mjs";

const FAKE = fileURLToPath(new URL("../fixtures/github/fake-gh.mjs", import.meta.url));
const REPO = "acme/app";
const EMAIL = "carol.private@example.com";
const SECRET = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const made = [];
const originalPath = process.env.PATH;
before(() => {
  // gh's own credentials never reach the fake (and must not come from the developer's machine).
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});
after(() => {
  process.env.PATH = originalPath;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A directory with a fake `gh` first on PATH. Returns helpers to read its calls and state. */
function fakeGh(initial) {
  const dir = mkdtempSync(join(tmpdir(), "rt-fake-gh-"));
  made.push(dir);
  writeFileSync(join(dir, "gh"), `#!${process.execPath}\nawait import(${JSON.stringify(FAKE)});\n`);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "state.json"), JSON.stringify(initial ?? { issues: [], labels: [], scopes: "repo, project, read:org", permission: "WRITE", next: 1 }));
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  const calls = () =>
    existsSync(join(dir, "calls.jsonl"))
      ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  return {
    dir,
    calls,
    /** Calls as strings, body files shown as <body>, from index `from`. */
    lines: (from = 0) =>
      calls()
        .slice(from)
        .map((c) => c.argv.map((a, i) => (c.argv[i - 1] === "--body-file" ? "<body>" : a)).join(" ")),
    state: () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")),
    failNext: (rules) => writeFileSync(join(dir, "fail.json"), JSON.stringify(rules)),
  };
}

function clock(start = Date.parse("2026-10-15T10:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

const twoTasks = () => makeContract({ tasks: [taskSpec("a", [], { team: "core" }), taskSpec("b", ["a"])] });
const agent = (id) => src(id, "agent");

test("gh sync: a whole run, call by call (issues, sub-issues, project, coalesced statuses, needs-human, closes)", async () => {
  const gh = fakeGh();
  const { store } = await frozenRun(twoTasks());
  const exe = store.id;
  const now = clock();
  const sync = new GitHubSync({ executionId: exe, repo: REPO, projectNumber: 5, store, now });

  const r1 = await sync.syncOnce();
  assert.equal(r1.ok, true, r1.errors.join("; "));
  assert.equal(r1.created, 3);
  assert.equal(r1.pending, 0);
  const marker = `"roundtable:${exe}" in:body`;
  assert.deepEqual(gh.lines(), [
    `label list --repo ${REPO} --json name --limit 500`,
    `label create roundtable --repo ${REPO} --color 5319e7 --description Mirrored from an agent-roundtable heads-down run`,
    `label create needs-human --repo ${REPO} --color d93f0b --description The roundtable run is waiting for a human decision`,
    "project view 5 --owner acme --format json",
    "project field-list 5 --owner acme --format json --limit 100",
    `issue list --repo ${REPO} --search ${marker} --state all --json number,url,id,body,state --limit 1000`,
    `issue create --repo ${REPO} --title Roundtable: Nav bar --body-file <body> --label roundtable`,
    `issue view 1 --repo ${REPO} --json id,number,url`,
    `project item-add 5 --owner acme --url https://github.com/${REPO}/issues/1 --format json`,
    `issue create --repo ${REPO} --title a: Task a --body-file <body> --label roundtable`,
    `issue view 2 --repo ${REPO} --json id,number,url`,
    `api graphql -H GraphQL-Features: sub_issues -f query=mutation($parent: ID!, $child: ID!) { addSubIssue(input: {issueId: $parent, subIssueId: $child}) { subIssue { id } } } -f parent=I_1 -f child=I_2`,
    `project item-add 5 --owner acme --url https://github.com/${REPO}/issues/2 --format json`,
    `issue create --repo ${REPO} --title b: Task b --body-file <body> --label roundtable`,
    `issue view 3 --repo ${REPO} --json id,number,url`,
    `api graphql -H GraphQL-Features: sub_issues -f query=mutation($parent: ID!, $child: ID!) { addSubIssue(input: {issueId: $parent, subIssueId: $child}) { subIssue { id } } } -f parent=I_1 -f child=I_3`,
    `project item-add 5 --owner acme --url https://github.com/${REPO}/issues/3 --format json`,
    "project item-edit --id PVTI_1 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_prog",
    "project item-edit --id PVTI_2 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_todo",
    "project item-edit --id PVTI_3 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_todo",
  ]);
  const bodies = gh.calls().filter((c) => c.body !== undefined).map((c) => c.body);
  assert.match(bodies[0], new RegExp(`<!-- roundtable:${exe} -->$`));
  assert.match(bodies[1], new RegExp(`<!-- roundtable:${exe}:a -->$`));
  assert.match(bodies[1], /## Acceptance\n\n- it works/);
  assert.match(bodies[2], /\(#1\)/, "a task issue names its parent");

  // a runs to the end in one round: claimed → in progress → accepted. b is claimed, then blocked on a human.
  let mark = gh.calls().length;
  await emit(store, "agent.registered", { agent: "w1", persona: "dev", team: "core", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 });
  await emit(store, "task.progress", { task: "a", percent: 30, note: "started" }, agent("w1"));
  await emit(store, "task.progress", { task: "a", percent: 60, note: "endpoints done" }, agent("w1"));
  await emit(store, "task.merged", { task: "a", integration_sha: "i1" });
  await emit(store, "task.claimed", { task: "b", agent: "w2", attempt: 1, ttl_s: 0 });
  const escalation = { id: "E1", task: "b", agent: "w2", kind: "emergency", with: "orchestrator", summary: "Paid API", question: "Buy a key?", blocking: true, status: "open", raised_seq: 0 };
  await emit(store, "escalation.raised", { escalation }, agent("w2"));
  await emit(store, "task.blocked", { task: "b", escalation: "E1" });
  await emit(store, "escalation.awaiting_human", { id: "E1", class: "money", message: "The task needs a paid API key", alternatives: ["Use the free tier", "Skip the feature"] });
  const r2 = await sync.syncOnce();
  assert.equal(r2.ok, true, r2.errors.join("; "));
  assert.equal(r2.updated, 2, "one edit per task, the latest state only");
  assert.equal(r2.comments, 2);
  assert.deepEqual(gh.lines(mark), [
    "project item-edit --id PVTI_2 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_done",
    "project item-edit --id PVTI_3 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_prog",
    `issue comment 3 --repo ${REPO} --body-file <body>`,
    `issue edit 3 --repo ${REPO} --add-label needs-human`,
    `issue comment 2 --repo ${REPO} --body-file <body>`,
  ]);
  const [human, note] = gh.calls().slice(mark).filter((c) => c.body).map((c) => c.body);
  assert.match(human, /^\*\*A human is needed\*\* \(money\): The task needs a paid API key\n\nQuestion: Buy a key\?\n\nAlternatives:\n- Use the free tier\n- Skip the feature/);
  assert.match(human, new RegExp(`<!-- roundtable:${exe}:b:e\\d+ -->$`));
  assert.match(note, /^\*\*Progress \(60%\):\*\* endpoints done\n\n<!-- roundtable:/, "only the latest note");

  // Nothing new: nothing to do.
  mark = gh.calls().length;
  const idle = await sync.syncOnce();
  assert.equal(idle.calls, 0);
  assert.equal(gh.calls().length, mark);

  // Resolved: the label comes off. A note within 10 minutes of the last one waits.
  await emit(store, "escalation.resolved", { id: "E1", action: "decide", decision: "Use the free tier", by: "main" });
  await emit(store, "task.unblocked", { task: "b" });
  await emit(store, "task.progress", { task: "b", note: "on the free tier" }, agent("w2"));
  now.advance(60_000);
  await sync.syncOnce();
  assert.deepEqual(gh.lines(mark), [`issue edit 3 --repo ${REPO} --remove-label needs-human`, `issue comment 3 --repo ${REPO} --body-file <body>`]);
  await emit(store, "task.progress", { task: "b", note: "almost" }, agent("w2"));
  mark = gh.calls().length;
  now.advance(5 * 60_000);
  await sync.syncOnce();
  assert.deepEqual(gh.lines(mark), [], "throttled");
  now.advance(5 * 60_000);
  await sync.syncOnce();
  assert.deepEqual(gh.lines(mark), [`issue comment 3 --repo ${REPO} --body-file <body>`]);

  // Completion: statuses, a comment linking the PR on the parent, then every issue closed.
  mark = gh.calls().length;
  await emit(store, "task.merged", { task: "b", integration_sha: "i2" });
  await emit(store, "execution.completed", { integration_sha: "i2", pr_url: "https://github.com/acme/app/pull/77" });
  const r4 = await sync.syncOnce();
  assert.equal(r4.ok, true, r4.errors.join("; "));
  assert.equal(r4.closed, 3);
  assert.deepEqual(gh.lines(mark), [
    "project item-edit --id PVTI_1 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_done",
    "project item-edit --id PVTI_3 --project-id PVT_5 --field-id PVTSSF_status --single-select-option-id opt_done",
    `issue comment 1 --repo ${REPO} --body-file <body>`,
    `issue close 2 --repo ${REPO} --reason completed --comment The run completed. Pull request: https://github.com/acme/app/pull/77`,
    `issue close 3 --repo ${REPO} --reason completed --comment The run completed. Pull request: https://github.com/acme/app/pull/77`,
    `issue close 1 --repo ${REPO} --reason completed --comment The run completed. Pull request: https://github.com/acme/app/pull/77`,
  ]);
  assert.match(gh.calls().at(-4).body, /^\*\*The run completed\.\*\* Pull request: https:\/\/github\.com\/acme\/app\/pull\/77/);
  const final = gh.state();
  assert.deepEqual(final.issues.map((i) => [i.number, i.closed, i.labels, i.parent ?? null]), [
    [1, true, ["roundtable"], null], [2, true, ["roundtable"], "I_1"], [3, true, ["roundtable"], "I_1"],
  ]);
  const file = JSON.parse(readFileSync(join(store.dir, "github.json"), "utf8"));
  assert.equal(file.cursor, (await store.state()).seq);
  assert.equal(statSync(join(store.dir, "github.json")).mode & 0o777, 0o600);
  assert.equal((await sync.syncOnce()).calls, 0, "done");
});

test("gh sync: idempotent across rounds, a lost github.json and a crash between create and record", async () => {
  const gh = fakeGh();
  const { store } = await frozenRun(twoTasks());
  const now = clock();
  const opts = { executionId: store.id, repo: REPO, store, now };
  await new GitHubSync(opts).syncOnce();
  await emit(store, "task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 });
  await emit(store, "escalation.raised", { escalation: { id: "E9", task: "a", agent: "w1", kind: "emergency", with: "orchestrator", summary: "s", blocking: true, status: "open", raised_seq: 0 } }, agent("w1"));
  await emit(store, "escalation.awaiting_human", { id: "E9", class: "credentials", message: "Need a deploy key" });
  const first = new GitHubSync(opts);
  await first.syncOnce();
  await first.syncOnce();
  const creates = () => gh.lines().filter((l) => l.startsWith("issue create")).length;
  const comments = () => gh.lines().filter((l) => l.startsWith("issue comment")).length;
  assert.equal(creates(), 3);
  assert.equal(comments(), 1);

  // github.json is lost: a fresh instance finds the issues by their markers, and the comment by its marker.
  rmSync(join(store.dir, "github.json"));
  const mark = gh.calls().length;
  const fresh = await new GitHubSync(opts).syncOnce();
  assert.equal(fresh.ok, true, fresh.errors.join("; "));
  assert.equal(fresh.created, 0);
  assert.equal(creates(), 3, "no duplicate issues");
  assert.equal(comments(), 1, "no duplicate comment");
  const after = gh.lines(mark);
  assert.ok(after.includes(`issue list --repo ${REPO} --search "roundtable:${store.id}" in:body --state all --json number,url,id,body,state --limit 1000`));
  assert.ok(after.includes(`issue view 2 --repo ${REPO} --json comments`), "checks the posted comments before posting");
  assert.ok(after.includes(`issue edit 2 --repo ${REPO} --add-label needs-human`), "labels are idempotent: set again");

  // A crash after the create went through but before it was recorded: the next round finds it.
  const { store: s2 } = await frozenRun(twoTasks());
  const o2 = { executionId: s2.id, repo: REPO, store: s2, now };
  gh.failNext([{ match: `issue view 5 `, times: 1, stderr: "HTTP 502: Bad Gateway" }]);
  const crashed = await new GitHubSync(o2).syncOnce();
  assert.equal(crashed.ok, false);
  assert.match(crashed.errors[0], /gh issue view failed \(exit 1\): HTTP 502/);
  const recorded = JSON.parse(readFileSync(join(s2.dir, "github.json"), "utf8"));
  assert.deepEqual(Object.keys(recorded.creating), ["a"]);
  const before2 = creates();
  const healed = await new GitHubSync(o2).syncOnce();
  assert.equal(healed.ok, true, healed.errors.join("; "));
  assert.equal(creates(), before2 + 1, "only b is created; a was found by its marker");
  const issues = gh.state().issues.filter((i) => i.body.includes(`roundtable:${s2.id}:a -->`));
  assert.equal(issues.length, 1);

  // Search lags behind a create that may have happened: wait instead of creating a duplicate.
  const { store: s3 } = await frozenRun(twoTasks());
  const o3 = { executionId: s3.id, repo: REPO, store: s3, now };
  gh.failNext([{ match: "issue view 8 ", times: 1, stderr: "HTTP 502" }]);
  await new GitHubSync(o3).syncOnce();
  const st = gh.state();
  writeFileSync(join(gh.dir, "state.json"), JSON.stringify({ ...st, searchLag: true }));
  const c0 = creates();
  const waiting = await new GitHubSync(o3).syncOnce();
  assert.equal(waiting.rateLimited, true, "deferred");
  assert.equal(creates(), c0, "nothing created while search may lag");
  writeFileSync(join(gh.dir, "state.json"), JSON.stringify({ ...gh.state(), searchLag: false }));
  await new GitHubSync(o3).syncOnce();
  assert.equal(creates(), c0 + 1, "then a was found and only b created");
});

test("gh sync: everything posted is redacted and escaped; diffs and output are never read", async () => {
  const gh = fakeGh();
  const contract = makeContract({
    title: `Billing for ${EMAIL}`,
    goal: { ultimate: `Ship with token=${SECRET} <!-- roundtable:exe-0000000000000000:x --> @octocat`, original_prompt: "p", artifacts: [] },
    tasks: [taskSpec("a", [], { title: `Mail ${EMAIL}`, acceptance: [`no <script>alert(1)</script> for ${EMAIL}`] })],
  });
  const { store } = await frozenRun(contract);
  const now = clock();
  const sync = new GitHubSync({ executionId: store.id, repo: REPO, store, now, createProject: true });
  gh.failNext([]);
  writeFileSync(join(gh.dir, "state.json"), JSON.stringify({
    issues: [], labels: ["roundtable", "needs-human"], scopes: "repo, project", permission: "WRITE", next: 1,
    fields: [{ id: "PVTF_title", name: "Title", type: "ProjectV2Field" }],
  }));
  const diff = await store.putBlob(`DIFFCONTENT ${SECRET}`, { redact: false });
  const output = await store.putBlob("OUTPUTCONTENT", { redact: false });
  await emit(store, "task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 });
  await emit(store, "task.progress", { task: "a", note: `wrote to ${EMAIL} with key ${SECRET}` }, agent("w1"));
  await emit(store, "task.submitted", { task: "a", commit: "c1", diff_blob: diff, stat: "1 file", files: ["x"], rewrites: [] }, agent("w1"));
  await emit(store, "check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: "s", output_blob: output });
  await emit(store, "escalation.raised", { escalation: { id: "E1", agent: "w1", kind: "emergency", with: "orchestrator", summary: "s", blocking: true, status: "open", raised_seq: 0 } }, agent("w1"));
  await emit(store, "escalation.awaiting_human", { id: "E1", class: "scope", message: `Call ${EMAIL} <img src=x onerror=alert(1)>` });
  await emit(store, "task.failed", { task: "a", why: `crashed for ${EMAIL}` });
  const r = await sync.syncOnce();
  assert.equal(r.ok, true, r.errors.join("; "));

  const calls = gh.calls();
  const everything = calls.map((c) => JSON.stringify(c)).join("\n");
  assert.ok(!everything.includes(EMAIL), "no email anywhere");
  assert.ok(!everything.includes(SECRET), "no secret anywhere");
  assert.ok(!everything.includes("DIFFCONTENT") && !everything.includes("OUTPUTCONTENT"), "no diff or output");
  assert.ok(everything.includes("[redacted:email]"));
  const bodies = calls.filter((c) => c.body).map((c) => c.body);
  for (const b of bodies) {
    assert.equal((b.match(/<!--/g) ?? []).length, 1, "only our own marker is an HTML comment");
    assert.ok(!/<(?:script|img)\b/i.test(b), b);
  }
  assert.ok(bodies[0].includes("&lt;!-- roundtable:exe-0000000000000000:x --&gt;"), "a forged marker is defused");
  assert.ok(bodies[0].includes("@​octocat"), "mentions are defused");
  assert.ok(bodies.some((b) => b.startsWith(`**A human is needed** (scope): Call [redacted:email] &lt;img src=x onerror=alert(1)&gt;`)), "needs-human on the parent");
  assert.ok(bodies.some((b) => b.startsWith("**Task failed:** crashed for [redacted:email]")));
  assert.ok(gh.lines().includes(`issue edit 1 --repo ${REPO} --add-label needs-human`), "an escalation without a task flags the parent");
  // The project was created, and its missing Status field replaced by "Roundtable Status".
  assert.ok(gh.lines().some((l) => l.startsWith("project create --owner acme --title Roundtable: Billing for [redacted:email] --format json")));
  assert.ok(gh.lines().includes("project field-create 9 --owner acme --name Roundtable Status --data-type SINGLE_SELECT --single-select-options Todo,In Progress,Done --format json"));
  assert.ok(gh.lines().includes("project item-edit --id PVTI_2 --project-id PVT_new --field-id PVTSSF_rt --single-select-option-id rt_2"), "failed → Done");
  assert.equal(ghText("a <b> & @x"), "a &lt;b&gt; &amp; @​x");
});

test("gh sync: token buckets (20 creates, 60 others a minute) on a fake clock", async () => {
  const gh = fakeGh({ issues: [], labels: ["roundtable", "needs-human"], scopes: "repo", permission: "WRITE", next: 1 });
  const tasks = Array.from({ length: 30 }, (_, i) => taskSpec(`t${String(i).padStart(2, "0")}`));
  const { store } = await frozenRun(makeContract({ tasks }));
  const now = clock();
  const sync = new GitHubSync({ executionId: store.id, repo: REPO, store, now });
  const creates = () => gh.lines().filter((l) => l.startsWith("issue create")).length;
  const r1 = await sync.syncOnce();
  assert.equal(r1.rateLimited, true);
  assert.equal(r1.ok, true, "a deferral is not a failure");
  assert.equal(creates(), 20);
  assert.equal(r1.pending, 11);
  const m2 = gh.calls().length;
  const r2 = await sync.syncOnce();
  assert.equal(creates(), 20, "no token, no create");
  assert.deepEqual(gh.lines(m2), []);
  assert.equal(r2.calls, 0);
  now.advance(30_000);
  await sync.syncOnce();
  assert.equal(creates(), 30, "half a minute refills 10");
  now.advance(60_000);
  const r4 = await sync.syncOnce();
  assert.equal(creates(), 31);
  assert.equal(r4.rateLimited, false);
  assert.equal(r4.pending, 0);
  // Other calls: a burst of 60 at most. 31 issue views and 30 sub-issue links ran over three rounds.
  const linkTimes = gh.lines().filter((l) => l.startsWith("api graphql")).length;
  assert.equal(linkTimes, 30);
});

test("gh sync: a secondary rate limit backs off 60 s plus jitter; repeated failures degrade, never throw", async () => {
  const gh = fakeGh();
  const { store } = await frozenRun(twoTasks());
  const now = clock();
  const sync = new GitHubSync({ executionId: store.id, repo: REPO, store, now, random: () => 0.5 });
  gh.failNext([{ match: "issue create", times: 1, stderr: "GraphQL: You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }]);
  const r1 = await sync.syncOnce();
  assert.equal(r1.ok, false);
  assert.equal(r1.rateLimited, true);
  assert.equal(r1.backoffUntil, new Date(now() + 60_000 + 7_500).toISOString());
  const mark = gh.calls().length;
  now.advance(30_000);
  const r2 = await sync.syncOnce();
  assert.equal(r2.rateLimited, true);
  assert.equal(gh.calls().length, mark, "no call while backing off");
  now.advance(40_000);
  const r3 = await sync.syncOnce();
  assert.equal(r3.ok, true, r3.errors.join("; "));
  assert.equal(r3.created, 3);

  // gh keeps failing: a report every round, degraded from the third.
  const { store: s2 } = await frozenRun(twoTasks());
  const broken = new GitHubSync({ executionId: s2.id, repo: REPO, store: s2, now });
  gh.failNext([{ match: "", times: 100, stderr: "HTTP 500: Internal Server Error" }]);
  const reports = [];
  for (let i = 0; i < 3; i++) reports.push(await broken.syncOnce());
  assert.deepEqual(reports.map((x) => [x.ok, x.degraded]), [[false, false], [false, false], [false, true]]);
  assert.match(reports[0].errors[0], /HTTP 500/);
  gh.failNext([]);
  const healed = await broken.syncOnce();
  assert.equal(healed.degraded, false);
  assert.equal(healed.ok, true, healed.errors.join("; "));

  // No gh at all, a bad repo name, an unknown execution: reports, not exceptions.
  process.env.PATH = "/nonexistent";
  const { store: s3 } = await frozenRun(twoTasks());
  const missing = await new GitHubSync({ executionId: s3.id, repo: REPO, store: s3, now }).syncOnce();
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /gh is not installed/);
  process.env.PATH = `${gh.dir}${delimiter}${originalPath}`;
  const badRepo = await new GitHubSync({ executionId: s3.id, repo: "--help", store: s3, now }).syncOnce();
  assert.equal(badRepo.ok, false);
  assert.match(badRepo.errors[0], /not a repository name/);
  const unknown = await new GitHubSync({ executionId: "exe-0000000000000000", repo: REPO }).syncOnce();
  assert.equal(unknown.ok, false);
  assert.equal(unknown.degraded, true);
});

test("gh sync: nothing happens before execution.started, and statuses map as designed", async () => {
  const gh = fakeGh();
  const { store } = await frozenRun(twoTasks(), { start: false });
  const r = await new GitHubSync({ executionId: store.id, repo: REPO, store }).syncOnce();
  assert.equal(r.ok, true);
  assert.equal(r.calls, 0);
  assert.equal(gh.calls().length, 0);
  const map = Object.fromEntries(
    ["pending", "ready", "claimed", "in_progress", "submitted", "checking", "merging", "blocked", "paused", "accepted", "failed", "cancelled"].map((s) => [s, statusFor(s)])
  );
  assert.deepEqual(map, {
    pending: "todo", ready: "todo", claimed: "in_progress", in_progress: "in_progress", submitted: "in_progress", checking: "in_progress",
    merging: "in_progress", blocked: "in_progress", paused: "in_progress", accepted: "done", failed: "done", cancelled: "done",
  });
});

test("gh runner: argv only, gh's env allowlist, bodies in 0600 temp files; checkGhReady", async () => {
  const gh = fakeGh();
  process.env.ROUNDTABLE_TEST_SECRET_KEY = "should-not-pass-1234";
  process.env.GH_TOKEN = "gho_" + "x".repeat(36);
  try {
    const out = await runGh(["repo", "view", REPO, "--json", "viewerPermission"]);
    assert.deepEqual(JSON.parse(out.stdout), { viewerPermission: "WRITE", hasIssuesEnabled: true });
  } finally {
    delete process.env.ROUNDTABLE_TEST_SECRET_KEY;
    delete process.env.GH_TOKEN;
  }
  const { env, cwd } = gh.calls().at(-1);
  assert.ok(!env.includes("ROUNDTABLE_TEST_SECRET_KEY"), "only the gh allowlist reaches gh");
  assert.ok(env.includes("GH_TOKEN") && env.includes("GH_PROMPT_DISABLED") && env.includes("PATH"));
  assert.ok(!env.some((k) => /^(?:ANTHROPIC|OPENAI)_/.test(k)));
  assert.equal(realpathSync(cwd), realpathSync(tmpdir()), "gh runs outside any repository");
  let seenPath;
  await withBodyFile("hello; $(rm -rf /)", async (p) => {
    seenPath = p;
    assert.equal(statSync(p).mode & 0o777, 0o600);
    await runGh(["issue", "comment", "1", "--repo", REPO, "--body-file", p]).catch(() => {});
  });
  assert.equal(existsSync(seenPath), false, "removed afterwards");
  assert.equal(gh.calls().at(-1).body, "hello; $(rm -rf /)");
  assert.equal(classifyGhError("You have exceeded a secondary rate limit"), "rate_limit");
  assert.equal(classifyGhError("HTTP 401: Bad credentials"), "auth");

  assert.deepEqual(await checkGhReady({ repo: REPO, project: { number: 5 } }), { ok: true, missing: [] });
  writeFileSync(join(gh.dir, "state.json"), JSON.stringify({ ...gh.state(), scopes: "repo, read:org", permission: "READ" }));
  const r = await checkGhReady({ repo: REPO, project: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.split(" (")[0]), ["the gh token scope `project`", "write access to acme/app"]);
  assert.equal((await checkGhReady({ repo: REPO })).missing.some((m) => /project/.test(m)), false, "project scope only when a project is wanted");
  writeFileSync(join(gh.dir, "state.json"), JSON.stringify({ ...gh.state(), loggedOut: true }));
  assert.match((await checkGhReady({ repo: REPO })).missing[0], /gh login/);
  assert.match((await checkGhReady({ repo: "not a repo" })).missing[0], /valid repository/);
  process.env.PATH = "/nonexistent";
  try {
    assert.match((await checkGhReady({ repo: REPO })).missing[0], /gh CLI/);
  } finally {
    process.env.PATH = `${gh.dir}${delimiter}${originalPath}`;
  }
});
