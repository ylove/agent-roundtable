// Postmortem mode (WS14): telling the human. The watcher's wakes, the dashboard's Postmortems page, the
// parent GitHub issue's comment, execution_status and the draft retention sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, frozenRun, makeContract, src, taskSpec } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const { wakeFor, watchExecution } = await import("../../dist/execution/watch.js");
const { startDashboard } = await import("../../dist/dashboard/server.js");
const { GitHubSync } = await import("../../dist/github/sync.js");
const { executionStatusReport } = await import("../../dist/execution/status-report.js");
const { sweepPostmortemDrafts } = await import("../../dist/postmortem/retention.js");
const { saveDraft, listDrafts, loadDraft, projectDir } = await import("../../dist/postmortem/store.js");

const XSS = "<script>alert(1)</script>";
const EMAIL = "dana.private@example.com";
const KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwx";
const FAKE = fileURLToPath(new URL("../fixtures/github/fake-gh.mjs", import.meta.url));

function get(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method: "GET", headers: { Host: u.host, Connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const finding = (id, over = {}) => ({ id, summary: `The brief was misread ${XSS}`, detected_by: "check unit", responsible: ["builder"], category: "prompt_misread", ...over });
const record = (store, id, over) => emit(store, "postmortem.finding_recorded", finding(id, over), src("main", "orchestrator"));

async function postmortemRun() {
  const contract = makeContract({ postmortem: { enabled: true }, tasks: [taskSpec("a", [], { team: "core" }), taskSpec("b", ["a"])] });
  const { store } = await frozenRun(contract);
  return { store, contract };
}

test("the watcher wakes the orchestrator with postmortem_ready when the last pending fix settles, and with postmortem when it concludes", async () => {
  const { store } = await postmortemRun();
  await record(store, "pmf-one", { task: "a" });
  const [merged] = (await store.transact(() => ({ events: [{ type: "task.merged", source: src(), payload: { task: "a", integration_sha: "s".repeat(40) } }] }))).events;
  const state = await store.state();
  assert.equal(state.postmortem.ready_seq, merged.seq);
  const wake = wakeFor(state, merged, "main");
  assert.equal(wake.reason, "postmortem_ready");
  assert.equal(wake.seq, merged.seq);
  assert.match(wake.message, /hold_postmortem/);
  assert.match(wake.message, new RegExp(store.id));
  assert.equal(wakeFor(state, (await store.events({ types: ["postmortem.finding_recorded"] }))[0], "main"), null, "earlier events do not wake");

  // End to end through the watcher: it prints one wake, then the next watcher starts after it.
  const first = await watchExecution(store.id, { as: "main", timeoutMin: 0.05, pollMs: 20 });
  assert.equal(first.reason, "postmortem_ready");
  await emit(store, "postmortem.started", { id: "pm-00000003", format: "collaborate", seats: ["orchestrator", "builder", "tester"] });
  const blob = await store.putBlob("# Postmortem\n\nThe record.");
  const concluded = await emit(store, "postmortem.concluded", { id: "pm-00000003", artifacts: { rule: 2, persona_addendum: 1 }, flagged: 1, record: blob });
  const second = await watchExecution(store.id, { as: "main", timeoutMin: 0.05, pollMs: 20 });
  assert.equal(second.reason, "postmortem");
  assert.equal(second.seq, concluded.seq);
  assert.match(second.message, /2 rule, 1 persona_addendum/);
  assert.match(second.message, /postmortem\(action: "read", pm: "pm-00000003"\)/);

  // A run that ends with findings still recorded says so.
  const done = await emit(store, "execution.completed", { integration_sha: "f".repeat(40) });
  await record(store, "pmf-two", { task: "b" });
  const end = wakeFor(await store.state(), done, "main");
  assert.equal(end.reason, "completed");
  assert.match(end.message, /1 postmortem finding is recorded/);
});

test("the dashboard's Postmortems page shows findings and the full record, redacted and escaped, with no inline script or style", async (t) => {
  const { store } = await postmortemRun();
  await record(store, "pmf-one", { task: "a", responsible: [`builder ${XSS}`], summary: `Misread: ${XSS} mail ${EMAIL} key ${KEY}`, evidence: ["evt-0123abcd"] });
  await emit(store, "task.merged", { task: "a", integration_sha: "s".repeat(40) });
  // Unredacted on purpose: the page must redact and escape by itself.
  const md = `# Postmortem pm-00000003\n\n> **builder:** I misread it ${XSS} ${EMAIL} ${KEY}\n\n| Id | Text |\n| --- | --- |\n| a1 | "><img src=x onerror=alert(1)> |\n`;
  const blob = await store.putBlob(md, { redact: false });
  await emit(store, "postmortem.started", { id: "pm-00000003", format: "waffle-house", seats: ["orchestrator", "builder", `tester ${XSS}`] });
  await emit(store, "postmortem.concluded", { id: "pm-00000003", artifacts: { rule: 1 }, flagged: 1, record: blob });
  await emit(store, "postmortem.started", { id: "pm-00000004", format: "collaborate", seats: ["orchestrator", "builder", "tester"] });
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const page = await get(`${dash.url}postmortems`);
  assert.equal(page.status, 200);
  assert.deepEqual(inlineProblems(page.body), []);
  assert.ok(!page.body.includes(XSS), "escaped");
  assert.ok(!/<img\b/i.test(page.body), "no raw html from the record");
  assert.ok(!page.body.includes(EMAIL) && !page.body.includes(KEY), "redacted");
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.body, /pmf-one/);
  assert.match(page.body, /prompt misread/);
  assert.match(page.body, /pm-00000003/);
  assert.match(page.body, /I misread it/);
  assert.match(page.body, /concluded: 1 rule · 1 flagged/);
  assert.match(page.body, /held, waiting for the orchestrator(&#39;|')s conclusion/);
  assert.match(page.body, /class="here">Postmortems</);
  assert.match(page.body, /nothing typed anywhere reaches it/);
  const overview = await get(dash.url);
  assert.match(overview.body, />Postmortems</, "linked once the run has postmortem data");
  const state = JSON.parse((await get(`${dash.url}state.json`)).body);
  assert.deepEqual(state.postmortem, { findings: 1, pending_fixes: 0, meetings: 2 });
  assert.ok(!JSON.stringify(state).includes(EMAIL));
  // A run without postmortem data has no link, and the page says so.
  const plain = await frozenRun(makeContract());
  const dash2 = await startDashboard(plain.store.id, { store: plain.store });
  t.after(() => dash2.close());
  assert.doesNotMatch((await get(dash2.url)).body, />Postmortems</);
  assert.match((await get(`${dash2.url}postmortems`)).body, /No findings recorded/);
  assert.equal(JSON.parse((await get(`${dash2.url}state.json`)).body).postmortem, undefined);
});

test("the GitHub sync posts one redacted comment on the parent issue when a postmortem concludes", async () => {
  const made = mkdtempSync(join(tmpdir(), "rt-fake-gh-"));
  writeFileSync(join(made, "gh"), `#!${process.execPath}\nawait import(${JSON.stringify(FAKE)});\n`);
  chmodSync(join(made, "gh"), 0o755);
  writeFileSync(join(made, "state.json"), JSON.stringify({ issues: [], labels: [], scopes: "repo, project, read:org", permission: "WRITE", next: 1 }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${made}${delimiter}${oldPath}`;
  try {
    const { store } = await postmortemRun();
    await record(store, "pmf-one", { task: "a" });
    const blob = await store.putBlob("record");
    await emit(store, "postmortem.started", { id: "pm-00000003", format: "waffle-house", seats: ["orchestrator", `builder @octocat ${EMAIL}`, "tester"] });
    await emit(store, "postmortem.concluded", { id: "pm-00000003", artifacts: { rule: 2, persona_addendum: 1 }, flagged: 2, record: blob });
    const sync = new GitHubSync({ executionId: store.id, repo: "acme/app", store });
    const r = await sync.syncOnce();
    assert.equal(r.ok, true, r.errors.join("; "));
    const calls = readFileSync(join(made, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const comments = calls.filter((c) => c.argv[0] === "issue" && c.argv[1] === "comment" && c.body?.includes("postmortem meeting"));
    assert.equal(comments.length, 1);
    const body = comments[0].body;
    assert.match(body, /\*\*A postmortem meeting took place\*\*/);
    assert.match(body, /2 rule, 1 persona addendum/);
    assert.match(body, /2 misreadings flagged/);
    assert.match(body, /The human has no seat/);
    assert.ok(!body.includes(EMAIL), "redacted");
    assert.ok(body.includes("@​octo"), "mentions neutralized");
    assert.equal((body.match(/<!--/g) ?? []).length, 1, "only our own marker");
    // Once only, however often the sync runs.
    await sync.syncOnce();
    const again = readFileSync(join(made, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[1] === "comment" && c.body?.includes("postmortem meeting"));
    assert.equal(again.length, 1);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("execution_status reports the postmortem draft and says when it is ready", async () => {
  const { store } = await postmortemRun();
  assert.equal((await executionStatusReport({ execution_id: store.id })).postmortem, undefined);
  await record(store, "pmf-one", { task: "a" });
  let report = await executionStatusReport({ execution_id: store.id });
  assert.deepEqual(report.postmortem, { draft_findings: 1, pending_fixes: 1, tasks_in_flight: 1, ready: false, meetings: 0 });
  await emit(store, "task.merged", { task: "a", integration_sha: "s".repeat(40) });
  report = await executionStatusReport({ execution_id: store.id });
  assert.equal(report.postmortem.ready, true);
  assert.ok(report.next.some((n) => /postmortem draft is ready/.test(n)));
});

test("drafts that were never held are pruned after the session retention; held postmortems and lessons are kept", async () => {
  const key = "0123456789abcdef";
  saveDraft({ v: 1, pm: "pm-00000001", project: key, scope: { work: "old" }, created: "2026-01-01T00:00:00Z", findings: [] });
  saveDraft({ v: 1, pm: "pm-00000002", project: key, scope: { work: "new" }, created: "2026-01-01T00:00:00Z", findings: [] });
  const oldPath = join(projectDir(key), "postmortems", "drafts", "pm-00000001.json");
  const kept = join(projectDir(key), "postmortems", "pm-00000003.json");
  writeFileSync(kept, "{}");
  const tooOld = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(oldPath, tooOld, tooOld);
  utimesSync(kept, tooOld, tooOld);
  assert.deepEqual(sweepPostmortemDrafts({ days: null }), [], "off keeps everything");
  assert.deepEqual(sweepPostmortemDrafts({ days: 30 }), ["pm-00000001"]);
  assert.equal(existsSync(oldPath), false);
  assert.ok(loadDraft(key, "pm-00000002"));
  assert.equal(existsSync(kept), true, "a held postmortem stays");
  assert.deepEqual(listDrafts(key).map((d) => d.pm), ["pm-00000002"]);
});
