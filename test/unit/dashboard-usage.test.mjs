// The dashboard's Usage page and its one mutating route, POST <token>/agents/<agent>/stop
// (usage-visibility.md §7; docs/design/heads-down.md §14): rendering and escaping, the nonce, Origin,
// Sec-Fetch-Site, method, body and rate-limit checks, the stop request it records, and that the token
// and the nonce are never logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { emit, frozenRun } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const { startDashboard, DASHBOARD_CSP, ACTION_HEADER, STOPS_PER_MINUTE } = await import("../../dist/dashboard/server.js");
const { sparkline, avatarClass } = await import("../../dist/dashboard/usage-page.js");
const { COMMON_HEADERS } = await import("../../dist/http/secure-server.js");
const { AUDIT_DIR } = await import("../../dist/config.js");

const XSS = `<script>alert(1)</script>`;
const ATTR = `"><img src=x onerror=alert(1)>`;
const EMAIL = "alice.secret@example.com";

/** Raw HTTP, so headers (Origin, Sec-Fetch-Site, Content-Length) are exactly what the test says. */
function send(url, { method = "GET", headers = {}, host, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method, headers: { Host: host ?? u.host, Connection: "close", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const usage = (o) => ({ source: "worker", tokens: { inputTokens: 1000, outputTokens: 200 }, estimated: false, ...o });

/** A run with two runner-managed workers (live), an external worker, and spend with every provenance. */
async function run() {
  const { store } = await frozenRun();
  for (const [agent, task] of [["w-a", "a"], ["w-b", "b"]]) {
    await emit(store, "agent.registered", { agent, persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
    await emit(store, "agent.spawned", { agent, task, attempt: 1, pid: process.pid });
  }
  await emit(store, "agent.registered", { agent: "ext-1", persona: "dev", driver: "external", token_sha256: "t3", external: true });
  await emit(store, "budget.usage_recorded", usage({ agent: "w-a", task: "a", provider: "claude-code", model: "model-a", usd: 0.5, provenance: { tokens: "measured", usd: "measured" } }));
  await emit(store, "budget.usage_recorded", usage({ agent: "w-a", task: "a", provider: "claude-code", model: "model-a", usd: 0.25, provenance: { tokens: "measured", usd: "measured" } }));
  await emit(store, "budget.usage_recorded", usage({ agent: "w-b", task: "b", provider: "claude-code", model: "model-a", usd: 0.1, estimated: true, provenance: { tokens: "measured", usd: "estimated" } }));
  await emit(store, "budget.usage_recorded", usage({ agent: "ext-1", provider: "external", model: "model-x", usd: 0.2, provenance: { tokens: "reported", usd: "reported" } }));
  return store;
}

function metaNonce(html) {
  return /<meta name="roundtable-action" content="([A-Za-z0-9_-]{24})">/.exec(html)?.[1];
}

test("usage page: cards, provenance chips with words, legend, platform table; no inline script, style or handler", async (t) => {
  const store = await run();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const r = await send(`${dash.url}usage`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-security-policy"], DASHBOARD_CSP);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, k);
  assert.deepEqual(inlineProblems(r.body), []);
  assert.match(r.body, /<h1 id="usage-title">Usage<\/h1>/);
  assert.match(r.body, /Here's who's working and what it's cost so far\./);
  // The total mixes provenances, so it is shown split with words.
  assert.match(r.body, /<span class="big">\$1\.05<\/span>/);
  assert.match(r.body, /<span class="amt">\$0\.75<\/span> <span class="chip prov-measured">measured<\/span>/);
  assert.match(r.body, /<span class="amt">≈\$0\.10<\/span> <span class="chip prov-estimated">estimated<\/span>/);
  assert.match(r.body, /<span class="amt">\$0\.20<\/span> <span class="chip prov-reported">reported<\/span>/);
  for (const p of ["measured", "reported", "estimated"]) assert.match(r.body, new RegExp(`<dt><span class="chip prov-${p}">${p}</span></dt>`));
  // One card per agent, with platform, state word and share of the budget.
  assert.equal((r.body.match(/<li class="agent-card /g) ?? []).length, 3);
  assert.match(r.body, /<h3>w-a<\/h3><span class="chip platform">claude-code · model-a<\/span>/);
  assert.match(r.body, /<span class="pill st-working">● working<\/span>/);
  assert.match(r.body, /<progress max="100" value="8" aria-label="Share of the budget">/);
  assert.match(r.body, /<svg class="spark" viewBox="0 0 160 36" role="img"><title>w-a: spend over time<\/title><polygon class="area"/);
  // The platform table.
  assert.match(r.body, /<th scope="row">claude-code<\/th>/);
  // Stop buttons only on the cards that can be stopped (not the external worker).
  assert.equal((r.body.match(/data-stop="/g) ?? []).length, 2);
  assert.match(r.body, /<button type="button" class="stop" data-stop="w-a">Stop<span class="sr-only"> w-a<\/span><\/button>/);
  assert.doesNotMatch(r.body, /data-stop="ext-1"/);
  // The native confirm dialog, Cancel focused by default.
  assert.match(r.body, /<dialog id="stop-dialog" aria-labelledby="stop-title" aria-describedby="stop-text">/);
  assert.match(r.body, /Its task will pause and the orchestrator will be asked to rework or write a handoff\./);
  assert.match(r.body, /<button type="button" id="stop-cancel" autofocus>Cancel<\/button>/);
  assert.match(r.body, /<div id="announce" class="sr-only" aria-live="polite"><\/div>/);
  assert.match(r.body, /<p class="live" id="live" role="status" aria-live="polite">/);
  assert.match(r.body, /<nav>.*Overview.*Tasks.*>Usage<.*Graph.*Escalations.*Events.*Contract/);
  assert.match(r.body, /body data-base="[^"]+" data-seq="\d+" data-live="swap"/);
});

test("usage page: the nonce is delivered only inside the Usage page", async (t) => {
  const store = await run();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const usagePage = await send(`${dash.url}usage`);
  const nonce = metaNonce(usagePage.body);
  assert.ok(nonce, "a 24-character nonce in a <meta> element");
  assert.ok(!dash.url.includes(nonce));
  for (const path of ["", "tasks", "escalations", "events", "contract", "dag", "state.json", "static/dashboard.js", "static/dashboard.css"]) {
    const r = await send(dash.url + path);
    assert.ok(!r.body.includes(nonce), `${path} does not carry the nonce`);
    if (!path.startsWith("static/")) assert.doesNotMatch(r.body, /roundtable-action/, path);
  }
  // A fresh dashboard has a fresh nonce.
  const other = await startDashboard(store.id, { store, writeInfo: false });
  t.after(() => other.close());
  assert.notEqual(metaNonce((await send(`${other.url}usage`)).body), nonce);
});

test("usage page: hostile names are redacted and escaped everywhere", async (t) => {
  const { store } = await frozenRun();
  const agent = `w-x${ATTR}`;
  await emit(store, "agent.registered", { agent, persona: "dev", driver: "claude-code", token_sha256: "t", external: false });
  await emit(store, "agent.spawned", { agent, task: "a", attempt: 1, pid: process.pid });
  await emit(store, "budget.usage_recorded", usage({ agent, task: "a", provider: `p${XSS}`, model: `m ${EMAIL} ${ATTR}`, usd: 0.5, provenance: { tokens: "measured", usd: "measured" } }));
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  for (const path of ["usage", ""]) {
    const r = await send(dash.url + path);
    assert.deepEqual(inlineProblems(r.body), [], path);
    assert.ok(!r.body.includes("<script>alert"), `${path}: raw script`);
    assert.ok(!/<img\b/i.test(r.body), `${path}: raw img`);
    assert.ok(!r.body.includes(EMAIL), `${path}: email`);
  }
  const page = (await send(`${dash.url}usage`)).body;
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(page.includes("[redacted:email]"));
});

test("usage page: empty state is warm, the Overview has a usage card, a stopped agent says so", async (t) => {
  const { store } = await frozenRun();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const empty = await send(`${dash.url}usage`);
  assert.match(empty.body, /No usage yet\./);
  assert.match(empty.body, /Agents will show up here as soon as they start\./);
  assert.doesNotMatch(empty.body, /agent-card/);
  assert.match((await send(dash.url)).body, /<h3>Usage<\/h3><div class="big">none yet<\/div>/);

  const full = await run();
  const d2 = await startDashboard(full.id, { store: full });
  t.after(() => d2.close());
  const overview = (await send(d2.url)).body;
  assert.match(overview, /<h3>Usage<\/h3><div class="big">\$1\.05<\/div>/);
  assert.match(overview, /See who spent what/);
  // Stopping, then stopped.
  await emit(full, "agent.stop_requested", { agent: "w-a", by: "the human (dashboard)", surface: "dashboard" });
  const stopping = (await send(`${d2.url}usage`)).body;
  assert.match(stopping, /<span class="pill st-stopping">■ stopping…<\/span>/);
  assert.match(stopping, /<button type="button" class="stop" disabled>Stopping…<\/button>/);
  assert.equal((stopping.match(/data-stop="/g) ?? []).length, 1);
});

test("sparkline and avatar are stable, text-free helpers", () => {
  assert.equal(avatarClass("builder"), avatarClass("builder"));
  assert.match(avatarClass("builder"), /^av-(\d|1[01])$/);
  const flat = sparkline([{ at: 1, usd: 1 }], "x");
  assert.match(flat, /not enough points yet/);
  const s = sparkline([{ at: 0, usd: 0.1 }, { at: 10, usd: 0.5 }, { at: 20, usd: 1 }], `spend ${XSS}`);
  assert.match(s, /<polyline class="line" points="1,\d+ 80,\d+ 159,4"\/>/);
  assert.ok(!s.includes("<script>"));
});

// --- the stop route ---------------------------------------------------------------------------------

async function armed(t) {
  const store = await run();
  const woke = [];
  const dash = await startDashboard(store.id, { store, onStopRequested: () => woke.push(Date.now()) });
  t.after(() => dash.close());
  const nonce = metaNonce((await send(`${dash.url}usage`)).body);
  const origin = new URL(dash.url).origin;
  const stop = (agent, o = {}) =>
    send(`${dash.url}agents/${agent}/stop`, { method: "POST", ...o, headers: { [ACTION_HEADER]: nonce, "Content-Length": "0", ...(o.headers ?? {}) } });
  const stopEvents = async () => (await store.events({ types: ["agent.stop_requested"] }));
  return { store, dash, nonce, origin, stop, woke, stopEvents };
}

test("stop: a valid request records agent.stop_requested, audits it, wakes the runner and answers small JSON", async (t) => {
  const { store, stop, woke, stopEvents, origin } = await armed(t);
  const r = await stop("w-a", { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(r.status, 200, r.body);
  assert.match(r.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(r.body), { status: "requested", agent: "w-a", task: "a" });
  assert.equal(woke.length, 1);
  const [ev] = await stopEvents();
  assert.deepEqual(ev.payload, { agent: "w-a", by: "the human (dashboard)", surface: "dashboard" });
  assert.equal(ev.source.kind, "human");
  assert.equal((await store.state()).agents["w-a"].stop.state, "requested");
  assert.equal((await store.state()).agents["w-b"].stop, undefined, "only the named agent");
  // Audited with surface, agent, scope and by.
  const audit = readdirSync(AUDIT_DIR).flatMap((f) => readFileSync(join(AUDIT_DIR, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
  const entry = audit.filter((e) => e.action === "agent.stop_requested").at(-1);
  assert.equal(entry.actor, "the human (dashboard)");
  assert.equal(entry.target, store.id);
  assert.deepEqual(entry.details, { surface: "dashboard", agent: "w-a", scope: store.id });
  // Asking again while the request waits records nothing new.
  const again = await stop("w-a");
  assert.equal(again.status, 200);
  assert.equal(JSON.parse(again.body).already, true);
  assert.equal((await stopEvents()).length, 1);
  // The same-origin spelling localhost is the same origin.
  const viaLocalhost = await stop("w-b", { headers: { Origin: origin.replace("127.0.0.1", "localhost") } });
  assert.equal(viaLocalhost.status, 200);
});

test("stop: the nonce is required and compared against this dashboard's own", async (t) => {
  const { stop, stopEvents, dash } = await armed(t);
  for (const headers of [{ [ACTION_HEADER]: "" }, { [ACTION_HEADER]: "wrong-nonce" }, { [ACTION_HEADER]: "x".repeat(24) }, { [ACTION_HEADER]: "x".repeat(5000) }]) {
    const r = await stop("w-a", { headers });
    assert.equal(r.status, 403, JSON.stringify(headers).slice(0, 60));
    assert.match(JSON.parse(r.body).error, /did not come from the Usage page/);
  }
  const none = await send(`${dash.url}agents/w-a/stop`, { method: "POST", headers: { "Content-Length": "0" } });
  assert.equal(none.status, 403);
  // The nonce of another dashboard start does not work here.
  const other = await armed(t);
  assert.equal((await stop("w-a", { headers: { [ACTION_HEADER]: other.nonce } })).status, 403);
  assert.equal((await stopEvents()).length, 0, "nothing was recorded");
});

test("stop: a cross-origin Origin or a Sec-Fetch-Site other than same-origin is refused, even with the nonce", async (t) => {
  const { stop, stopEvents } = await armed(t);
  for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null", "http://localhost:1"]) {
    assert.equal((await stop("w-a", { headers: { Origin: origin } })).status, 403, origin);
  }
  for (const site of ["cross-site", "same-site", "none"]) assert.equal((await stop("w-a", { headers: { "Sec-Fetch-Site": site } })).status, 403, site);
  assert.equal((await stopEvents()).length, 0);
});

test("stop: a body is refused (Content-Length must be 0)", async (t) => {
  const { stop, stopEvents, dash, nonce } = await armed(t);
  assert.equal((await stop("w-a", { body: "agent=w-a", headers: { "Content-Length": "9" } })).status, 400);
  const noLength = await send(`${dash.url}agents/w-a/stop`, { method: "POST", headers: { [ACTION_HEADER]: nonce, "Transfer-Encoding": "chunked" }, body: "5\r\nhello\r\n0\r\n\r\n" }).catch(() => ({ status: 400 }));
  assert.equal(noLength.status, 400);
  assert.equal((await stopEvents()).length, 0);
});

test("stop: only POST on this route, only GET and HEAD elsewhere, and the token and Host still apply", async (t) => {
  const { dash, nonce, stop } = await armed(t);
  const route = `${dash.url}agents/w-a/stop`;
  const get = await send(route);
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const r = await send(route, { method, headers: { [ACTION_HEADER]: nonce } });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
  // POST anywhere else is the old read-only 405.
  for (const path of ["", "tasks", "usage", "state.json", "stream", "tasks/a", "static/dashboard.js"]) {
    const r = await send(dash.url + path, { method: "POST", headers: { [ACTION_HEADER]: nonce, "Content-Length": "0" } });
    assert.equal(r.status, 405, path);
    assert.equal(r.headers.allow, "GET, HEAD", path);
  }
  const origin = new URL(dash.url).origin;
  assert.equal((await send(`${origin}/agents/w-a/stop`, { method: "POST", headers: { [ACTION_HEADER]: nonce } })).status, 404, "no token");
  assert.equal((await send(`${origin}/AAAAAAAAAAAAAAAAAAAAAAAA/agents/w-a/stop`, { method: "POST", headers: { [ACTION_HEADER]: nonce } })).status, 404, "wrong token");
  assert.equal((await stop("w-a", { host: "evil.example" })).status, 421, "Host");
});

test("stop: unknown agents, bad ids, and agents that cannot be stopped get a plain answer", async (t) => {
  const { stop, store } = await armed(t);
  assert.equal((await stop("nobody")).status, 404);
  for (const bad of ["..", "a%2Fb", "%2e%2e", "x".repeat(70), "constructor", "__proto__"]) {
    const r = await stop(bad);
    assert.ok([404].includes(r.status), `${bad}: ${r.status}`);
  }
  const ext = await stop("ext-1");
  assert.equal(ext.status, 409);
  assert.match(JSON.parse(ext.body).error, /external worker/);
  assert.match(JSON.parse(ext.body).error, /steer/);
  await emit(store, "agent.exited", { agent: "w-b", task: "b", code: 0, reason: "completed" });
  const done = await stop("w-b");
  assert.equal(done.status, 409);
  assert.match(JSON.parse(done.body).error, /no live process/);
  await emit(store, "execution.aborted", { reason: "test" });
  const ended = await stop("w-a");
  assert.equal(ended.status, 409);
  assert.match(JSON.parse(ended.body).error, /aborted/);
});

test(`stop: at most ${STOPS_PER_MINUTE} accepted requests a minute`, async (t) => {
  const { stop, stopEvents } = await armed(t);
  for (let i = 0; i < STOPS_PER_MINUTE; i++) assert.equal((await stop("w-a")).status, 200, `request ${i + 1}`);
  const limited = await stop("w-a");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal((await stopEvents()).length, 1);
  // A refused request (bad nonce) never counted against the limit.
  assert.equal((await stop("w-a", { headers: { [ACTION_HEADER]: "nope" } })).status, 403);
});

test("stop: neither the token nor the nonce is ever logged", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  const { stop, dash, nonce, store } = await armed(t);
  const token = new URL(dash.url).pathname.split("/")[1];
  await stop("w-a");
  await stop("w-a", { headers: { [ACTION_HEADER]: "wrong" } });
  await stop("nobody");
  await stop("ext-1");
  await emit(store, "agent.exited", { agent: "w-b", task: "b", code: 0, reason: "completed" });
  await stop("w-b");
  assert.ok(logged.every((l) => !l.includes(nonce) && !l.includes(token)), logged.join("\n"));
});

test("the dashboard script: a native dialog, the custom header, textContent only, no inline anything", async (t) => {
  const { dash } = await armed(t);
  const js = (await send(`${dash.url}static/dashboard.js`)).body;
  assert.match(js, /showModal/);
  assert.match(js, /X-Roundtable-Action/);
  assert.match(js, /method:"POST"/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.write|new Function/);
  const css = (await send(`${dash.url}static/dashboard.css`)).body;
  assert.match(css, /prefers-color-scheme:dark/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width:480px/);
  assert.doesNotMatch(css, /@import|url\(http/);
});
