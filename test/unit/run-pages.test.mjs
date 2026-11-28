import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { indexRoutes, INDEX_CSP } from "../../dist/serve/index.js";
import { startDashboard } from "../../dist/dashboard/server.js";
import { loadTaskDetail, runnerHealth } from "../../dist/dashboard/data.js";
import { renderPostmortems } from "../../dist/dashboard/render.js";
import { SecureServer } from "../../dist/http/secure-server.js";
import { frozenRun, makeContract, taskSpec, emit, src } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const BASE = "/fixture-capability/";
const TITLE = "Build <script>alert(1)</script> navigation";
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const EMAIL = "private.person@example.com";

async function fixture() {
  const { store } = await frozenRun(makeContract({
    title: "Navigation <script>alert(1)</script>",
    goal: { ultimate: "Make navigation usable by keyboard and screen reader", original_prompt: "Build a responsive navigation bar with a clear current page", artifacts: [] },
    tasks: [
      taskSpec("api", [], { title: TITLE, instructions: "Implement keyboard navigation and announce the active page.", acceptance: ["Tab reaches every item", "Current page is announced"], paths: { write: ["src/navigation/**"] } }),
      taskSpec("b", ["api"], { title: "", acceptance: [], checks: [] }),
    ],
    interfaces: [{ name: "NavigationProps", kind: "type", owner: "api", consumers: ["b"], description: "Current page and the navigation items", path: "src/navigation/types.ts" }],
    validation: { commands: [{ id: "test", argv: ["npm", "run", "test:navigation"], timeout_s: 45 }], final: ["test"] },
    postmortem: { enabled: true },
    dissents: [{ id: "keyboard-risk", by: "critic", source: { kind: "manual" }, claim: "Keyboard users may lose focus", predicted_failure: "Focus resets after navigation", on_fire: "notify", tripwire: { kind: "check_failed", check: "test" } }],
  }));
  await emit(store, "agent.registered", { agent: "w-a", persona: "builder", driver: "claude-code", token_sha256: "test-only", external: false });
  await emit(store, "task.claimed", { task: "api", agent: "w-a", attempt: 1, ttl_s: 0 });
  await emit(store, "agent.spawned", { agent: "w-a", task: "api", attempt: 1, pid: process.pid });
  await emit(store, "task.progress", { task: "api", percent: 60, note: "Keyboard support is ready; checking focus" }, { ...src("w-a", "agent"), task: "api" });
  const diff = await store.putBlob("@@ -1 +1 @@\n-old\n+accessible navigation\n", { redact: false });
  await emit(store, "task.submitted", { task: "api", commit: "abc123", diff_blob: diff, stat: "1 file changed", files: ["src/navigation/index.ts"], rewrites: [] });
  const output = await store.putBlob(`FAIL focus should return to the current item\n${TOKEN}\n${EMAIL}\n<script>alert(1)</script>\n`, { redact: false });
  await emit(store, "check.failed", { command_id: "test", scope: "task", task: "api", exit: 1, signature: "focus-reset", output_blob: output });
  await emit(store, "task.retried", { task: "api", attempt: 2, why: "Repair focus restoration" });
  await emit(store, "budget.usage_recorded", { source: "worker", agent: "w-a", task: "api", model: "fixture-model", usd: 10, estimated: false, tokens: { inputTokens: 100, outputTokens: 50 } });
  const diagnostics = await store.putBlob(`The focus check failed before the budget ran out.\n${EMAIL}\n`, { redact: false });
  await emit(store, "escalation.raised", { escalation: { id: "esc-budget", agent: "w-a", task: "api", kind: "emergency", with: "orchestrator", summary: "Request $5.00 more to finish the navigation checks", question: "Approve $5.00 more for task api?", options: ["Approve the extension", "Keep the current budget"], emergency: "money", diagnostics_blob: diagnostics, blocking: true, status: "open", raised_seq: 0 } }, src("w-a", "agent"));
  await emit(store, "task.blocked", { task: "api", escalation: "esc-budget" });
  await emit(store, "escalation.awaiting_human", { id: "esc-budget", class: "money", message: "The $10.00 budget is spent. Request $5.00 more.", alternatives: ["Extend the budget", "Keep the completed work"] });
  await emit(store, "postmortem.finding_recorded", { id: "focus", summary: "Focus check found a regression", detected_by: "test", responsible: ["builder"], task: "api", category: "implementation" });
  await emit(store, "postmortem.started", { id: "pm-fixture", format: "collaborate", seats: ["builder", "critic"] });
  const record = await store.putBlob("# Review\n\nRestore focus after navigation.\n\n```json\n{\"status\": \"pending\"}\n```\n", { redact: false });
  await emit(store, "postmortem.concluded", { id: "pm-fixture", artifacts: {}, flagged: 1, record });
  return store;
}

/** Call the actual SecureServer route handlers in-process, without opening a socket. */
function transport(routes, base = BASE) {
  return async function get(path) {
    const url = new URL(path, "http://fixture.test");
    if (!url.pathname.startsWith(base)) return { status: 404, body: "" };
    const relative = "/" + url.pathname.slice(base.length);
    const route = routes.find(r => typeof r.path === "string" ? r.path === relative : r.path.test(relative));
    if (!route) return { status: 404, body: "" };
    let response;
    await route.handler({
      base, query: url.searchParams, match: route.path instanceof RegExp ? route.path.exec(relative) : undefined,
      req: { headers: {} },
      html(status, body, csp) { response = { status, body, csp, type: "text/html" }; },
      send(status, body, type) { response = { status, body, type }; },
      json(status, body) { response = { status, body: JSON.stringify(body), type: "application/json" }; },
      notFound() { response = { status: 404, body: "" }; },
    });
    assert.ok(response, relative);
    return response;
  };
}

const paths = ["", "tasks", "tasks/api", "tasks/b", "events", "contract", "dag", "dag.svg", "dissents", "escalations", "escalations/esc-budget", "postmortems", "usage"];

test("index run pages: every page and every same-site run link resolves, including event anchors and assets", async () => {
  const store = await fixture(), root = `${BASE}x/${store.id}/`, get = transport(indexRoutes());
  const queue = paths.map(p => root + p), visited = new Set();
  // These shell destinations are owned by the index-shell branch. Crawl the entire run namespace.
  const shellLinks = new Set([BASE, BASE + "runs", BASE + "duels", BASE + "escalations"]);
  while (queue.length) {
    const href = queue.shift();
    if (visited.has(href)) continue;
    visited.add(href);
    const r = await get(href);
    assert.equal(r.status, 200, href);
    const anchor = new URL(href, "http://fixture.test").hash.slice(1);
    if (anchor) assert.ok(r.body.includes(`id="${anchor}"`), `missing anchor ${href}`);
    if (r.type !== "text/html" && !r.type?.startsWith("image/svg")) continue;
    if (r.type === "text/html") {
      assert.equal(r.csp, INDEX_CSP);
      assert.deepEqual(inlineProblems(r.body), [], href);
      assert.ok(r.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), href);
      assert.doesNotMatch(r.body, /<script>alert|<form\b|roundtable-action|data-stop=/, href);
      assert.equal((r.body.match(/<h1[ >]/g) ?? []).length, 1, `one page title on ${href}`);
    }
    for (const [, raw] of r.body.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const link = new URL(raw.replaceAll("&amp;", "&"), `http://fixture.test${href}`);
      assert.equal(link.origin, "http://fixture.test", raw);
      if (shellLinks.has(link.pathname)) continue;
      assert.ok(link.pathname.startsWith(root), `unexpected link ${raw}`);
      queue.push(link.pathname + link.search + link.hash);
    }
  }
  assert.ok(visited.size > 40, `only ${visited.size} links crawled`);
  for (const path of paths) assert.ok(visited.has(root + path), path);
});

test("index task detail shows its contract, dependencies, attempts, worker runtime, checks, diff and missing log", async () => {
  const store = await fixture(), root = `${BASE}x/${store.id}/`, get = transport(indexRoutes());
  const { body } = await get(root + "tasks/api");
  for (const text of ["Implement keyboard navigation", "Tab reaches every item", "Current page is announced", "npm run test:navigation", "src/navigation/**", "NavigationProps", "Current page and the navigation items", "w-a", "claude-code", "Attempt 1", "Attempt 2", "(attempt 1)", "FAIL focus should return", "accessible navigation", "No worker log was recorded for this task."]) assert.ok(body.includes(text), text);
  assert.match(body, /<h1>Build &lt;script&gt;alert\(1\)&lt;\/script&gt; navigation<\/h1>/);
  assert.match(body, /<details><summary>View submitted changes/);
  assert.match(body, /<details><summary>Output \(redacted\)/);
  assert.match(body, /<time datetime="/);
  assert.doesNotMatch(body, new RegExp(EMAIL + "|" + TOKEN));
  const thin = (await get(root + "tasks/b")).body;
  for (const text of ["untitled task", "No description was recorded", "No acceptance criteria were recorded", "No check commands were specified", "No worker was recorded", "tasks/api", "Build &lt;script&gt;"]) assert.ok(thin.includes(text), text);
});

test("index escalation detail explains the budget request, evidence, times and supported resolution calls", async () => {
  const store = await fixture(), root = `${BASE}x/${store.id}/`, get = transport(indexRoutes());
  const { body } = await get(root + "escalations/esc-budget");
  for (const text of ["Budget extension", "The run hit its budget and asks for more.", "$5.00", "w-a", "Build &lt;script&gt;", "awaiting human", "The focus check failed", "resolve_escalation", "&quot;action&quot;: &quot;amend&quot;", "REPLACE_WITH_APPROVED_TOTAL_USD", "&quot;action&quot;: &quot;decide&quot;", "control_execution", `roundtable status ${store.id} --json`, `roundtable run ${store.id}`, "CLI has no escalation-resolution subcommand", "#event-"]) assert.ok(body.includes(text), text);
  assert.match(body, /<time datetime="/);
  assert.doesNotMatch(body, new RegExp(EMAIL));
  assert.ok((await get(root)).body.includes(`href="${root}escalations/esc-budget"`));
  assert.ok((await get(root + "escalations")).body.includes(`href="${root}escalations/esc-budget"`));
});

test("index run routing validates task, escalation and execution ids and never opens unknown pages", async () => {
  const store = await fixture(), root = `${BASE}x/${store.id}/`, get = transport(indexRoutes());
  for (const path of ["tasks/missing", "tasks/constructor", "tasks/__proto__", "tasks/API", "tasks/a%2fb", "tasks/api/extra", "escalations/missing", "escalations/constructor", "escalations/__proto__", "escalations/esc%2fb", "escalations/esc-budget/extra", "static/nope.js", "agents/w-a/stop", "postmortems/pm-fixture/signoff"]) assert.equal((await get(root + path)).status, 404, path);
  assert.equal((await get(`${BASE}x/not-an-execution/`)).status, 404);
});

test("index overview explains outcomes, budget, runner state and missing information", async () => {
  const store = await fixture(), root = `${BASE}x/${store.id}/`, get = transport(indexRoutes());
  const { body } = await get(root);
  for (const text of ["Make navigation usable by keyboard", "Build a responsive navigation bar", "0 of 2 tasks done", "$10.00", "Budget used", "Latest activity", "Review finding", "Recorded concerns", "What runner states mean", "No record of a runner", "roundtable run"]) assert.ok(body.includes(text), text);
  const { store: thin } = await frozenRun(makeContract({ title: "", goal: { ultimate: "", original_prompt: "", artifacts: [] } }));
  const thinBody = (await get(`${BASE}x/${thin.id}/`)).body;
  for (const text of ["Untitled run", "No goal was recorded", "No request summary was recorded", "No notes were recorded"]) assert.ok(thinBody.includes(text), text);
});

test("worker output tail is bounded, redacted, escaped and tied to the task's recorded worker attempt", async () => {
  const store = await fixture();
  const dir = join(store.dir, "agents", "w-a", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1.jsonl"), "Old activity\n".repeat(12_000) + `${EMAIL} ${TOKEN}\nWorker restored <script>alert(1)</script> focus\n`);
  const detail = await loadTaskDetail(store, "api");
  assert.ok(detail.log.truncated);
  assert.ok(Buffer.byteLength(detail.log.text) <= 64 * 1024);
  const body = (await transport(indexRoutes())(`${BASE}x/${store.id}/tasks/api`)).body;
  assert.match(body, /Worker w-a, attempt 1: output tail/);
  assert.match(body, /Worker restored &lt;script&gt;alert\(1\)&lt;\/script&gt; focus/);
  assert.doesNotMatch(body, new RegExp(EMAIL + "|" + TOKEN));
  // A log file cannot redirect the renderer into another file, even inside the temp home.
  const other = join(store.dir, "other-output");
  writeFileSync(other, "Do not display me\n");
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(dir, "1.jsonl"));
  symlinkSync(other, join(dir, "1.jsonl"));
  assert.equal((await loadTaskDetail(store, "api")).log, undefined);
});

test("index postmortems suppress signoff even if an action nonce and pending artifacts are supplied", async () => {
  const store = await fixture();
  const state = await store.state();
  const body = renderPostmortems({ state, header: store.header(), base: `${BASE}x/${store.id}/`, indexBase: BASE, runner: { status: "unknown", detail: "No record" }, nonce: "must-never-appear" }, {
    "pm-fixture": { markdown: "# Review\n", pending: [{ id: "a1", pm: "pm-fixture", kind: "rule", target: "builder", text: "Keep focus", hash: "fixture-hash" }] },
  });
  assert.doesNotMatch(body, /<form\b|roundtable-action|must-never-appear|data-signoff/);
  assert.deepEqual(inlineProblems(body), []);
});

test("standalone dashboard shares the index's data loaders and supports escalation detail", async t => {
  const store = await fixture();
  let routes;
  t.mock.method(SecureServer, "start", async options => {
    routes = options.routes;
    return { base: BASE, url: "http://fixture.test" + BASE, close: async () => {} };
  });
  const dashboard = await startDashboard(store.id, { store, writeInfo: false });
  t.after(() => dashboard.close());
  const get = transport(routes);
  for (const path of ["tasks/api", "events", "contract", "postmortems", "escalations/esc-budget"]) {
    const response = await get(BASE + path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(inlineProblems(response.body), [], path);
  }
  assert.match((await get(BASE + "tasks/api")).body, /No worker log was recorded/);
  assert.equal((await get(BASE + "escalations/unknown")).status, 404);
  assert.match((await get(BASE + "usage")).body, /roundtable-action/);
  assert.match((await get(BASE + "postmortems")).body, /roundtable-action/);
});

test("runner states explain live, stale, stopped and missing records", async () => {
  const store = await fixture();
  assert.equal(runnerHealth(store).status, "unknown");
  const { hostname } = await import("node:os");
  const record = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), version: "fixture" };
  writeFileSync(join(store.dir, "runner.json"), JSON.stringify(record));
  assert.deepEqual(runnerHealth(store), { status: "alive", detail: "The scheduler process is running." });
  writeFileSync(join(store.dir, "runner.json"), JSON.stringify({ ...record, heartbeatAt: new Date(Date.now() - 180_000).toISOString() }));
  assert.match(runnerHealth(store).detail, /no heartbeat for 3 minutes/);
  assert.equal(runnerHealth(store).status, "stale");
  writeFileSync(join(store.dir, "runner.json"), JSON.stringify({ ...record, stoppedAt: new Date().toISOString() }));
  assert.equal(runnerHealth(store).status, "stopped");
  assert.match(runnerHealth(store).detail, new RegExp(`roundtable run ${store.id}`));
});

test("shared event loader keeps pagination bounded and links back to older events", async () => {
  const store = await fixture();
  await store.transact(() => ({ events: Array.from({ length: 220 }, (_, n) => ({ type: "note.posted", source: src(), payload: { topic: "fixture", text: `Progress note ${n}`, refs: [] } })) }));
  const state = await store.state(), reads = [];
  const { eventsPage } = await import("../../dist/dashboard/data.js");
  const tracked = { ...store, events: opts => { reads.push(opts); return store.events(opts); }, state: () => store.state() };
  const before = state.seq - 10;
  const html = await eventsPage(tracked, { state, header: store.header(), base: BASE, runner: { status: "unknown", detail: "" } }, new URLSearchParams({ before: String(before) }));
  const seqs = [...html.matchAll(/<tr><td class="num">(\d+)<\/td>/g)].map(m => Number(m[1]));
  assert.equal(seqs.length, 100);
  assert.equal(seqs[0], before - 1);
  assert.equal(seqs.at(-1), before - 100);
  assert.deepEqual(reads, [{ sinceSeq: before - 102, limit: 101 }]);
  assert.ok(html.includes(`events?before=${before - 100}">Older</a>`));
});
