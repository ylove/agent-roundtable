import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import vm from "node:vm";
import { SecureServer } from "../../dist/http/secure-server.js";
import { createRoomState, startRoom } from "../../dist/table/room.js";
import { ROOM_HTML, ROOM_JS, ROOM_CSS } from "../../dist/table/room-assets.js";
import { attachPrototypeFiles } from "../../dist/table/replay.js";

const ts = "2026-10-26T12:00:00Z";
const seats = ["A", "B"].map(team => ({ id: team, name: "Builder " + team, team, provider: "fixture", model: "model" }));
const start = { type: "start", id: "duel-test", topic: "A shared brief", mode: "duel", kind: "web", seats, teams: { A: ["A"], B: ["B"] }, stages: [{ index: 1, name: "Shell" }, { index: 2, name: "Screens" }], humanJudge: true, startedAt: ts };
const metric = extra => ({ elapsedMs: 130000, stagesDone: 1, stagesTotal: 2, inputTokens: 14000, outputTokens: 4200, costUsd: 0, unpricedTokens: 18200, turns: 2, failedTurns: 0, versions: 1, rewrites: 0, validationFailures: 0, pageErrors: 0, toolCalls: 1, ...extra });
const prototype = (version, extra = {}) => ({ type: "prototype", team: "A", seat: seats[0], kind: "web", title: "A build", ok: true, stage: version, version, files: [{ path: "index.html", bytes: 15 }], ...extra });

// Run the real SecureServer dispatcher with in-memory request/response streams; never listen.
async function harness(t, controls) {
  let server, routes;
  t.mock.method(SecureServer, "start", async opts => {
    routes = opts.routes;
    server = new SecureServer(opts, { close(done) { done?.(); }, closeAllConnections() {} });
    server.port = 23456;
    return server;
  });
  const room = await startRoom({ hold: false, controls });
  t.after(() => room.close());
  async function request(path = "", { method = "GET", headers = {}, body = "", raw = false, chunks } = {}) {
    const req = Readable.from(chunks ?? [Buffer.from(body)]);
    req.url = raw ? path : new URL(path, room.url).pathname;
    req.method = method;
    req.headers = { host: "127.0.0.1:23456", ...headers };
    const result = {};
    const res = { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(body) { result.text = body?.toString() ?? ""; }, destroy() {} };
    await server.route(req, res);
    if (result.headers?.["Content-Type"]?.startsWith("application/json")) result.body = JSON.parse(result.text);
    return result;
  }
  return { room, request, get routes() { return routes; } };
}

test("room reduces duel events, refreshes capabilities, and resumes without losing history or bytes", async t => {
  let available = { stop: true, resume: false, choose: false };
  const { room, request } = await harness(t, { available: () => ({ ...available }), send: () => true });
  const emit = e => room.observer.onEvent(e);
  await emit(start);
  const turn = { type: "turn", seat: seats[0], round: "concept", text: "A concept", ts };
  await emit(turn);
  const p = prototype(1); attachPrototypeFiles(p, [{ path: "index.html", content: "<h1>first</h1>" }]); await emit(p);
  await emit({ type: "stage", team: "A", stage: 1, of: 2, name: "Shell", status: "done", version: 1, ts });
  const metrics = { A: metric(), B: metric({ stagesDone: 0 }) };
  await emit({ type: "metrics", teams: metrics, ts });
  await emit({ type: "control", action: "stopped", by: "room", ts });
  await emit({ type: "end", winner: "none", tally: { A: 0, B: 0 }, resumable: true });
  assert.deepEqual(room.state.stopped, { by: "room", at: ts });
  assert.deepEqual((await request("state.json")).body.controls, available);
  available = { stop: false, resume: true, choose: false };
  assert.deepEqual((await request("state.json")).body.controls, available);
  await emit({ ...start, resumed: true, seats: seats.map(s => ({ ...s, model: "refreshed" })) });
  assert.equal(room.state.history.length, 1); assert.equal(room.state.turns.length, 1);
  assert.equal(room.state.stopped, undefined); assert.equal(room.state.end, undefined);
  assert.equal(room.state.seats[0].model, "refreshed");
  assert.deepEqual(room.state.metrics, metrics);
  assert.equal((await request("p/A/1/index.html")).text, "<h1>first</h1>");
  assert.equal(room.state.kind, "web"); assert.deepEqual(room.state.stages, start.stages);
  assert.deepEqual(room.state.teams, start.teams); assert.equal(room.state.humanJudge, true);
  assert.deepEqual(room.state.progress.A, { stage: 1, of: 2, name: "Shell", status: "done" });
  await emit({ type: "control", action: "stopped", by: "terminal", ts });
  await emit({ type: "control", action: "resumed", by: "terminal", ts });
  assert.equal(room.state.stopped, undefined);
  await emit({ type: "decision", status: "awaiting", ts });
  assert.deepEqual(room.state.decision, { status: "awaiting", at: ts });
  await emit({ type: "decision", status: "made", by: "human", winner: "A", version: 1, ts });
  assert.deepEqual(room.state.decision, { status: "made", winner: "A", at: ts });
  const end = { type: "end", winner: "A", tally: { A: 2, B: 0 }, decidedBy: "human", chosen: { team: "A", version: 1, dir: "duels/test/chosen", files: ["index.html"] }, metrics };
  await emit(end); assert.deepEqual(room.state.end, end);
  const failed = prototype(2, { ok: false, error: "Failed validation" });
  attachPrototypeFiles(failed, [{ path: "index.html", content: "<h1>failed</h1>" }]);
  room.setPrototypeFiles("A", [{ path: "index.html", content: "<h1>failed</h1>" }]);
  await emit(failed);
  assert.equal(room.state.history.length, 2); assert.equal(room.state.prototypes[0].version, 1);
  assert.equal((await request("p/A/index.html")).text, "<h1>first</h1>");
  await emit({ ...start, id: "duel-next", kind: "text" });
  assert.equal(room.state.history.length, 0); assert.equal(room.state.decision, undefined);
  assert.deepEqual(room.state.metrics, {}); assert.equal((await request("p/A/1/index.html")).status, 404);
});

test("control route checks capability, method, opaque/cross-site origins, nonce, strict JSON, size and availability", async t => {
  let available = { stop: true, resume: false, choose: false }, accept = true;
  const sent = [];
  const { room, request, routes } = await harness(t, { available: () => available, send: (command, by) => { sent.push({ command, by }); return accept; } });
  const page = await request();
  const nonce = /name="roundtable-action" content="([^"]+)"/.exec(page.text)[1];
  assert.equal(nonce.length, 24);
  assert.deepEqual(routes.find(r => r.path === "/control").methods, ["POST"]);
  const headers = { "content-type": "application/json", "x-roundtable-action": nonce, origin: new URL(room.url).origin, "sec-fetch-site": "same-origin" };
  const post = (body, extra = {}) => request("control", { method: "POST", headers, body, ...extra });
  assert.equal((await request("/wrong/control", { method: "POST", headers, body: '{"action":"stop"}', raw: true })).status, 404);
  assert.equal((await request("control")).status, 405);
  assert.equal((await request("control", { method: "PUT" })).status, 405);
  assert.equal((await request("p/A/index.html", { method: "POST", headers, body: '{"action":"stop"}' })).status, 405);
  for (const origin of ["null", "https://other.example"]) assert.equal((await post('{"action":"stop"}', { headers: { ...headers, origin } })).status, 403);
  for (const site of ["cross-site", "same-site", "none"]) assert.equal((await post('{"action":"stop"}', { headers: { ...headers, "sec-fetch-site": site } })).status, 403);
  for (const value of [undefined, "wrong"]) { const h = { ...headers }; if (value) h["x-roundtable-action"] = value; else delete h["x-roundtable-action"]; assert.equal((await post('{"action":"stop"}', { headers: h })).status, 403); }
  assert.equal((await post('{"action":"stop"}', { headers: { ...headers, "content-type": "text/plain" } })).status, 400);
  for (const body of ["", "{", "null", "[]", "true", '"stop"', '{}', '{"action":"unknown"}', '{"action":"stop","team":"A"}', '{"action":"choose"}', '{"action":"choose","team":"C"}', '{"action":"stop","extra":1}', '{"action":"choose","team":"A","extra":1}']) assert.equal((await post(body)).status, 400, body);
  assert.equal((await post(" ".repeat(1025))).status, 400);
  assert.equal((await post("", { chunks: [Buffer.alloc(600, 32), Buffer.alloc(600, 32)] })).status, 400);
  assert.equal((await post("", { headers: { ...headers, "content-length": "1025" } })).status, 400);
  assert.deepEqual(sent, []);
  assert.deepEqual((await post('{"action":"stop"}')).body, { ok: true });
  assert.deepEqual(sent.at(-1), { command: { action: "stop" }, by: "room" });
  const exactLimit = '{"action":"stop"}'.padEnd(1024, " ");
  assert.equal((await post(exactLimit)).status, 202);
  assert.equal((await post('{"action":"stop"}', { headers: { ...headers, origin: new URL(room.url).origin.replace("127.0.0.1", "localhost"), "content-type": "application/json; charset=UTF-8" } })).status, 202);
  const nativeHeaders = { ...headers }; delete nativeHeaders.origin; delete nativeHeaders["sec-fetch-site"];
  assert.equal((await post('{"action":"stop"}', { headers: nativeHeaders })).status, 202);
  assert.equal((await post('{"action":"resume"}')).status, 409);
  assert.equal((await post('{"action":"choose","team":"A"}')).status, 409);
  available = { stop: false, resume: true, choose: false };
  assert.equal((await post('{"action":"resume"}')).status, 202);
  available = { stop: false, resume: false, choose: true };
  assert.equal((await post('{"action":"choose","team":"B"}')).status, 202);
  assert.deepEqual(sent.at(-1), { command: { action: "choose", team: "B" }, by: "room" });
  accept = false;
  assert.equal((await post('{"action":"choose","team":"A"}')).status, 409);
});

test("rooms without controls expose no capabilities and return 404 for POST control", async t => {
  const { request } = await harness(t);
  assert.deepEqual((await request("state.json")).body.controls, { stop: false, resume: false, choose: false });
  assert.equal((await request("control", { method: "POST", body: '{}' })).status, 404);
});

// A small DOM model exercises event-driven UI transitions without a browser or listener.
class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.text = ""; this.className = ""; this.hidden = false; this.classList = { add: c => this.classList.toggle(c, true), remove: c => this.classList.toggle(c, false), toggle: (c, on) => { const classes = new Set(this.className.split(" ").filter(Boolean)); const add = on ?? !classes.has(c); add ? classes.add(c) : classes.delete(c); this.className = [...classes].join(" "); } }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parentNode = this; this.children.push(n); } }
  prepend(n) { n.remove(); n.parentNode = this; this.children.unshift(n); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  replaceChildren(...nodes) { for (const c of [...this.children]) c.remove(); this.text = ""; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? (k === "src" ? this.src : null); }
  addEventListener(name, fn) { this.events[name] = fn; }
  click() { if (!this.disabled) return this.events.click?.(); }
}
function domHarness(state) {
  const elements = new Map([...ROOM_HTML.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const requests = [], location = { hash: "" }, timers = [];
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag), querySelector: () => ({ content: "test-nonce" }) }, location, window: { addEventListener() {} }, setTimeout: fn => timers.push(fn), fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => url === "previews.json" ? [] : state, text: async () => "<script>inert source</script>" }; } });
  vm.runInContext(ROOM_JS.replace(/poll\(\);\s*$/, ""), context);
  return { elements, requests, location, render(next = state) { context.state = next; vm.runInContext("render(state)", context); }, card(team = "A") { return vm.runInContext('cards.get("' + team + '")', context); } };
}

test("Apps swaps loaded frames, keeps pinned versions, and renders progress, efficiency and human choice", async () => {
  const state = { ...createRoomState(), ...start, transcript: [], turns: [], history: [prototype(1)], controls: { stop: true, resume: false, choose: false } };
  const ui = domHarness(state); ui.render();
  const a = ui.card(), b = ui.card("B"), first = a.pending;
  assert.equal(first.getAttribute("sandbox"), "allow-scripts allow-forms allow-modals");
  assert.equal(first.className, "incoming"); first.events.load();
  assert.equal(a.frame, first); assert.equal(a.live.children.length, 1);
  state.history.push(prototype(2)); ui.render();
  const second = a.pending;
  assert.equal(a.frame, first); assert.equal(a.live.children.length, 2);
  ui.render(); assert.equal(a.pending, second);
  second.events.load(); assert.equal(a.frame, second); assert.equal(a.live.children.length, 1);
  assert.match(a.badge.textContent, /v2 · Screens · just now/);
  a.versions.children.find(n => n.textContent.startsWith("v1")).click();
  a.pending.events.load(); const pinned = a.frame;
  state.history.push(prototype(3)); ui.render(); assert.equal(a.frame, pinned); assert.equal(a.pending, null);
  assert.match(a.versions.textContent, /new version/);
  a.versions.children[0].click(); assert.match(a.pending.src, /\/3\//); a.pending.events.load();
  state.progress.A = { stage: 2, of: 2, name: "Screens", status: "started" };
  state.transcript.push({ type: "stage", team: "A", stage: 1, of: 2, name: "Shell", status: "done", ts }, { type: "stage", team: "A", stage: 2, of: 2, name: "Screens", status: "started", ts });
  state.metrics = { A: metric({ finishedAt: ts, elapsedMs: 90000 }), B: metric({ elapsedMs: 190000, inputTokens: 25000, outputTokens: 5000 }) };
  state.progress.B = { stage: 2, of: 2, name: "Screens", status: "started" };
  ui.render(); assert.equal(a.status.textContent, "Done in 1m 30s"); assert.match(b.status.textContent, /Building stage 2 of 2/);
  assert.match(a.progress.children[0].className, /done/); assert.match(a.progress.children[1].className, /started/);
  assert.match(a.metrics.textContent, /18.2k tok.*no price/);
  state.decision = { status: "awaiting", at: ts }; state.controls = { stop: false, resume: false, choose: true }; ui.render();
  assert.equal(a.approval.children[0].textContent, "Approve Team A"); assert.equal(b.approval.children[0].disabled, true);
  a.approval.children[0].click(); assert.equal(ui.requests.length, 0);
  assert.equal(a.approval.children[0].textContent, "Confirm Team A wins");
  await a.approval.children[0].click();
  assert.equal(ui.requests[0].url, "control"); assert.deepEqual(JSON.parse(ui.requests[0].opts.body), { action: "choose", team: "A" });
  assert.equal(ui.requests[0].opts.headers["X-Roundtable-Action"], "test-nonce");
  state.decision = { status: "made", winner: "A", at: ts }; state.controls.choose = false;
  state.end = { type: "end", winner: "A", tally: { A: 2, B: 0 }, decidedBy: "human", chosen: { dir: "duels/test/chosen", team: "A" }, metrics: { A: state.metrics.A, B: { ...state.metrics.B, finishedAt: ts } } };
  ui.render(); assert.match(a.card.className, /chosen/); assert.equal(a.approval.children.length, 0);
  assert.match(ui.elements.get("banner").textContent, /Chosen by you.*1m 40s sooner.*39% fewer tokens.*duels\/test\/chosen/);
  ui.location.hash = "#harness"; ui.render(); assert.equal(ui.elements.get("artifacts").hidden, true); assert.equal(ui.elements.get("harness").hidden, false);
});

test("Harness groups team notes and shared judging; source artifacts stay inert with no view switch or replay controls", async () => {
  const teamTurn = { type: "turn", seat: seats[0], round: "concept", text: "<script>concept</script>", ts };
  const toolTurn = { ...teamTurn, round: "tool", text: "Builder A used connector.search" };
  const judgeTurn = { ...teamTurn, seat: { ...seats[0], id: "judge", team: "judge", name: "Judge" }, round: "judge", text: "Judge's advice" };
  const closing = { ...teamTurn, round: "closing", text: "Closing statement" };
  const state = { ...createRoomState(), ...start, kind: "code", history: [prototype(1, { kind: "code", files: [{ path: "main.ts", bytes: 1 }] })], turns: [teamTurn, toolTurn, judgeTurn, closing], transcript: [teamTurn, toolTurn, judgeTurn, closing], decision: { status: "made", winner: "A", at: ts }, end: { winner: "A", decidedBy: "human", tally: { A: 0, B: 0 } } };
  const ui = domHarness(state); ui.render(); await new Promise(resolve => setImmediate(resolve));
  const a = ui.card();
  assert.equal(ui.elements.get("view-switch").hidden, true); assert.equal(ui.elements.get("harness").hidden, false);
  assert.equal(a.card.parentNode, a.column); assert.equal(a.frame, null);
  assert.equal(a.live.children[0].children[1].textContent, "<script>inert source</script>");
  assert.match(a.transcript.textContent, /<script>concept<\/script>.*connector.search/);
  assert.doesNotMatch(a.transcript.textContent, /Closing statement|Judge's advice/);
  assert.match(ui.elements.get("judges").textContent, /Judge's advice/);
  assert.equal(ui.elements.get("closings").textContent, "Builder A · closingClosing statement");
  assert.equal(a.approval.children.length, 0); assert.equal(ui.elements.get("header-controls").children.length, 0);
  state.stopped = { by: "room", at: ts }; state.controls.resume = true; ui.render();
  assert.match(ui.elements.get("banner").textContent, /Stopped\. Resume continues from where it stopped\./);
  assert.equal(ui.elements.get("banner").children.at(-1).textContent, "Resume");
});

test("room assets use external assets, event listeners and a 960px responsive split", () => {
  assert.doesNotMatch(ROOM_HTML, /\son\w+=|<style\b|<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(ROOM_JS, /innerHTML|outerHTML|insertAdjacentHTML|\.on\w+\s*=|\.style\b|localStorage|sessionStorage/);
  assert.match(ROOM_CSS, /max-width:959px/); assert.match(ROOM_CSS, /100dvh/); assert.match(ROOM_CSS, /prefers-reduced-motion/);
  assert.match(ROOM_JS, /setTimeout\(poll, 1000\)/);
});

test("each room start uses a fresh action nonce", async t => {
  const controls = { available: () => ({ stop: true, resume: false, choose: false }), send: () => true };
  const first = await harness(t, controls), second = await harness(t, controls);
  const nonce = async h => /name="roundtable-action" content="([^"]+)"/.exec((await h.request()).text)[1];
  const a = await nonce(first), b = await nonce(second); assert.notEqual(a, b);
  assert.equal((await second.request("control", { method: "POST", headers: { "content-type": "application/json", "x-roundtable-action": a }, body: '{"action":"stop"}' })).status, 403);
});

test('room metrics retain the cap and cumulative spend from usage events', async t => {
  const { room, request } = await harness(t);
  await room.observer.onEvent(start);
  const usage = { type: 'usage', perSeat: [], totalCostUsd: 0.1, capUsd: 0.2, spentUsd: 0.15, capReached: false };
  await room.observer.onEvent(usage);
  const response = await request('state.json');
  assert.deepEqual(response.body.usage, usage);
  assert.match(ROOM_JS, /state.usage.capUsd/);
});
