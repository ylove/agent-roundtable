import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayState } from "../../dist/dashboard/display-state.js";
import { formatDate } from "../../dist/dashboard/time.js";
import { INDEX_CSP, indexRoutes, renderIndex, renderRuns, renderGlobalEscalations } from "../../dist/serve/index.js";
import { createExecutionStore } from "../../dist/execution/store.js";
import { executionStatus } from "../../dist/execution/run-admin.js";
import { ROUNDTABLE_HOME } from "../../dist/config.js";
import { emit, frozenRun, makeContract, taskSpec } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const contract = { id: "ctr-fixture", version: 1, title: "A frozen contract" };
const alive = { state: "running", pid: 123, stale: false };

for (const [name, report, live, kind, label] of [
  ["live runner", { status: "running", contract }, alive, "running", "Running"],
  ["created record with live runner", { status: "created", contract }, alive, "running", "Running"],
  ["stale heartbeat with live pid", { status: "running", contract }, { ...alive, stale: true }, "running", "Running, no heartbeat"],
  ["dead runner", { status: "running", contract }, { state: "dead", pid: 123 }, "interrupted", "Interrupted"],
  ["absent runner", { status: "running", contract }, undefined, "interrupted", "Interrupted"],
  ["never recorded runner", { status: "running", contract }, { state: "stopped" }, "interrupted", "Interrupted"],
  ["cleanly stopped runner", { status: "running", contract }, { state: "stopped", pid: 123 }, "interrupted", "Interrupted"],
  ["created frozen record with no runner", { status: "created", contract }, { state: "stopped" }, "interrupted", "Interrupted"],
  ["runner on another host", { status: "running", contract }, { state: "other_host", pid: 123, host: "elsewhere" }, "interrupted", "Interrupted"],
  ["no contract", { status: "created" }, undefined, "draft", "Draft"],
  ["running record without contract", { status: "running" }, alive, "draft", "Draft"],
  ["unfrozen contract", { status: "created", contract: { ...contract, status: "draft" } }, undefined, "draft", "Draft"],
  ["consenting contract", { status: "created", contract: { ...contract, status: "consenting" } }, undefined, "draft", "Draft"],
  ["frozen projection", { status: "running", contract: { ...contract, status: "frozen", frozen: { by: "main", at: "2026-11-01", hash: "h" } } }, undefined, "interrupted", "Interrupted"],
  ...["completed", "failed", "aborted", "paused"].flatMap(status => [
    [`stored ${status} with live runner`, { status, contract }, alive, status, status[0].toUpperCase() + status.slice(1)],
    [`stored ${status} without a contract`, { status }, undefined, status, status[0].toUpperCase() + status.slice(1)],
  ]),
]) {
  test(`display state: ${name}`, () => {
    const result = displayState(report, live);
    assert.equal(result.kind, kind);
    assert.equal(result.label, label);
    assert.ok(result.detail.length);
  });
}

async function page(path, query = "") {
  const route = indexRoutes().find(r => r.path === path);
  assert.ok(route, path);
  let result;
  await route.handler({ base: "/cap/", query: new URLSearchParams(query), html(status, body, csp) { result = { status, body, csp }; } });
  return result;
}

const visibleText = html => html.replace(/<[^>]*>/g, "");
const esc = (id, over = {}) => ({ id, task: "a", agent: "w1", kind: "ambiguity", with: "orchestrator",
  summary: "Choose a colour", question: "Which palette should we use?", blocking: true, status: "open", raised_seq: 0, ...over });

test("index routes read fixture runs, hide drafts, name decisions and escape all run text", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T15:00:00Z") });
  const { store: completed } = await frozenRun(makeContract({ title: "Shipped navigation" }));
  await emit(completed, "task.accepted", { task: "a" });
  await emit(completed, "task.accepted", { task: "b" });
  await emit(completed, "budget.usage_recorded", { source: "worker", agent: "w1", task: "a", model: "fixture", tokens: { inputTokens: 10, outputTokens: 5 }, usd: 1.25, estimated: false });
  await emit(completed, "execution.completed", { integration_sha: "abc" });
  t.mock.timers.tick(1000);
  const { store: interrupted } = await frozenRun(makeContract({ title: "Interrupted design" }));
  t.mock.timers.tick(1000);
  const draft = await createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc", agentsDir: "/srv/agents" });
  t.mock.timers.tick(1000);
  const { store: pending } = await frozenRun(makeContract({
    title: 'Review <script>alert("title")</script>',
    tasks: [taskSpec("a", [], { title: 'Task <script>alert("task")</script>' })],
  }));
  await emit(pending, "escalation.raised", { escalation: esc("resolved", { summary: "Old decision" }) });
  await emit(pending, "escalation.resolved", { id: "resolved", action: "decide", decision: '<script>alert("decision")</script>', by: "human" });
  const raised = await emit(pending, "escalation.raised", { escalation: esc("pending", {
    summary: 'Need <script>alert("summary")</script> alice.private@example.com',
    question: 'Approve <img src=x onerror="bad">?',
  }) });
  await emit(pending, "escalation.awaiting_human", { id: "pending", class: "human_action", message: "Please choose" });
  // An open request routed to an agent must not enter the human decision queue.
  await emit(pending, "escalation.raised", { escalation: esc("agent-only", { summary: "Agent handles this" }) });
  await emit(pending, "escalation.routed", { id: "agent-only", to: "w1", wake: false });
  mkdirSync(join(ROUNDTABLE_HOME, "casting"), { recursive: true });
  writeFileSync(join(ROUNDTABLE_HOME, "casting", "latest.json"), JSON.stringify({ createdAt: raised.ts, brief: "CASTING_RAW_DUMP_MUST_NOT_APPEAR" }));
  mkdirSync(join(ROUNDTABLE_HOME, "duels"), { recursive: true });
  writeFileSync(join(ROUNDTABLE_HOME, "duels", "duel-pages.json"), JSON.stringify({ events: [{ type: "start", topic: "Compare layouts" }, { type: "end", winner: "A" }] }));

  for (const path of ["/", "/runs", "/escalations"]) {
    const { status, body, csp } = await page(path);
    assert.equal(status, 200);
    assert.equal(csp, INDEX_CSP);
    assert.deepEqual(inlineProblems(body), [], path);
    assert.match(body, /class="site-header"/);
    assert.match(body, /aria-current="page"/);
    assert.ok(body.includes("Review &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"));
    assert.doesNotMatch(body, /<script>(?!<\/script>)|<img src=x|alice\.private@example\.com/);
    assert.doesNotMatch(visibleText(body), /2026-11-12T15:/, "ISO dates may appear only in time attributes");
    assert.ok(body.includes(formatDate(raised.ts)));
    assert.doesNotMatch(body, /CASTING_RAW_DUMP_MUST_NOT_APPEAR/);
    if (path !== "/escalations") {
      assert.ok(!body.includes(draft.id));
      assert.match(body, /Show 1 draft/);
      assert.match(body, /class="pill st-completed"[^>]*>Completed</);
      assert.match(body, /class="pill st-interrupted"[^>]*>Interrupted</);
      assert.match(body, /2 of 2 tasks done/);
      assert.match(body, /Not started/);
      assert.match(body, /\$1\.25/);
      assert.match(body, /Started <time/);
      assert.ok(body.includes(`roundtable run ${interrupted.id}`));
      assert.ok(body.indexOf(pending.id) < body.indexOf(interrupted.id));
      const shown = (await page(path, "drafts=1")).body;
      assert.ok(shown.includes(draft.id));
      assert.match(shown, /class="pill st-draft"[^>]*>Draft</);
      assert.match(shown, /No tasks/);
      assert.match(shown, /Hide drafts/);
    }
  }
  const overview = (await page("/")).body;
  for (const label of ["Awaiting you", "Active runs", "Interrupted runs", "Recent duels", "Latest casting report", "Needs you"]) assert.ok(overview.includes(label), label);
  assert.ok(overview.includes('href="/cap/casting"'));
  assert.ok(overview.includes('href="/cap/duels/duel-pages"'));
  const decisions = (await page("/escalations")).body;
  assert.ok(decisions.includes(`href="/cap/x/${pending.id}/"`));
  assert.ok(decisions.includes(`href="/cap/x/${pending.id}/escalations"`));
  assert.match(decisions, /Task &lt;script&gt;alert\(&quot;task&quot;\)&lt;\/script&gt;/);
  assert.match(decisions, /Need &lt;script&gt;/);
  assert.match(decisions, /Approve &lt;img/);
  assert.match(decisions, /\[redacted:email\]/);
  assert.doesNotMatch(decisions, /Agent handles this/);
  assert.match(decisions, /<details class="card resolved-escalations"><summary>Recently resolved \(1\)/);
  assert.doesNotMatch(decisions, /<details[^>]*\bopen\b/);
  assert.match(decisions, /&lt;script&gt;alert\(&quot;decision&quot;\)&lt;\/script&gt;/);
  assert.match(decisions, /Raised <time/);
  assert.match(decisions, /Resolved <time/);

  const runRoute = indexRoutes().find(r => r.path instanceof RegExp && r.path.source.includes("x"));
  let runHtml;
  await runRoute.handler({ base: "/cap/", match: runRoute.path.exec(`/x/${pending.id}/`), html(status, html) { assert.equal(status, 200); runHtml = html; } });
  assert.match(runHtml, /<nav class="run-nav"/);
  assert.match(runHtml, /Last event <time/);
  assert.match(runHtml, /<header class="run-heading"><h1>Review &lt;script&gt;/);
  assert.match(runHtml, /class="pill st-interrupted"/);
  assert.deepEqual(inlineProblems(runHtml), []);
});

test("run lists use last activity, explain stale heartbeats and handle cancelled tasks", async () => {
  const { store } = await frozenRun();
  const report = await executionStatus(store.id);
  const old = { report: { ...report, contract: { ...report.contract, title: "Older activity" } }, lastEvent: "2026-10-01T12:00:00Z" };
  const fresh = { report: { ...report, contract: { ...report.contract, title: "Newest activity" }, runner: { ...alive, stale: true },
    tasks: { total: 3, by_state: { accepted: 1, cancelled: 1, ready: 1 }, list: [] }, completion_pct: 50 }, lastEvent: "2026-11-18T12:00:00Z" };
  const html = renderRuns("/cap/", [old, fresh]);
  assert.ok(html.indexOf("Newest activity</a>") < html.indexOf("Older activity</a>"));
  assert.match(html, /class="pill st-running"[^>]*>Running, no heartbeat</);
  assert.match(html, /1 of 2 tasks done/);
  assert.match(html, /value="50" aria-label="Task progress: 1 of 2 tasks done"/);
  const home = renderIndex("/cap/", [fresh]);
  assert.match(home, /Active runs<\/span><strong class="summary-value">1</);
  const inFlight = { ...fresh, report: { ...fresh.report, tasks: { total: 3, by_state: { submitted: 1, blocked: 1, pending: 1 }, list: [] }, completion_pct: 27 } };
  assert.match(renderRuns("/cap/", [inFlight]), /0 of 3 tasks done · 27% of the work/, "a weighted bar never reads as contradicting the done count");
});

test("empty index pages explain what will appear and previews retain their reload guard", () => {
  assert.match(renderIndex("/cap/", []), /No runs yet/);
  assert.match(renderRuns("/cap/", []), /propose and freeze a contract/);
  assert.match(renderGlobalEscalations("/cap/", []), /No escalations awaiting you/);
  const previews = [{ id: "prv-12345678", origin: "http://127.0.0.1:1234", display: "live", source: { kind: "task", task: "a" } }];
  const html = renderIndex("/cap/", [], [], [], undefined, previews);
  assert.match(html, /<iframe class="preview"/);
  assert.deepEqual(inlineProblems(html), []);
  const route = indexRoutes().find(r => r.path === "/static/dashboard.js");
  let script;
  route.handler({ send(_status, js) { script = js; } });
  assert.match(script, /!document\.querySelector\("iframe\.preview"\)/);
  assert.match(script, /initPreviewCards\(\)/);
});
