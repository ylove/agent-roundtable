import test from "node:test";
import assert from "node:assert/strict";
import { SecureServer } from "../../dist/http/secure-server.js";
import { startRoom, lineDiff } from "../../dist/table/room.js";
import { attachPrototypeFiles, attachPrototypeScreenshot } from "../../dist/table/replay.js";
import { ROOM_CSP, ROOM_HTML, ROOM_JS } from "../../dist/table/room-assets.js";
import { APP_CSP } from "../../dist/prototypes/board.js";
import { inlineProblems } from "./helpers.mjs";

const seat = { id: "builder", name: "Builder", provider: "test", model: "test" };

test("room keeps versions, serves only their recorded files and shots, and computes diff JSON", async t => {
  const original = SecureServer.start;
  let options;
  SecureServer.start = async opts => { options = opts; return { url: "http://127.0.0.1:1/token/", close: async () => {}, closeNow() {} }; };
  t.after(() => { SecureServer.start = original; });
  const room = await startRoom({ hold: false });
  t.after(() => room.close());
  const check = { loaded: true, consoleErrors: [], exceptions: [], failedRequests: 0 };
  for (const [version, content] of ["<h1>Current</h1>\nsame", "<h1>Proposed</h1>\nsame"].entries()) {
    const event = { type: "prototype", team: "A", seat, kind: "web", ok: true, version: version + 1, check,
      files: [{ path: "index.html", bytes: Buffer.byteLength(content) }] };
    attachPrototypeFiles(event, [{ path: "index.html", content }]); attachPrototypeScreenshot(event, Buffer.from(`png${version + 1}`));
    await room.observer.onEvent(event);
  }
  assert.equal(room.state.prototypes.length, 1); assert.equal(room.state.history.length, 2);
  assert.deepEqual(room.state.history.map(p => p.version), [1, 2]);
  assert.equal(room.state.browser.version, 2);
  const request = async target => {
    const url = new URL(target, room.url);
    const path = url.pathname.slice("/token".length);
    const route = options.routes.find(route => typeof route.path === "string" ? route.path === path : route.path.test(path));
    let result;
    if (!route) return { status: 404 };
    const context = { req: { url: url.pathname }, query: url.searchParams, match: typeof route.path === "string" ? null : route.path.exec(path),
      send(status, body, type, headers) { result = { status, body, type, headers }; },
      html(status, body, csp) { result = { status, body, csp }; },
      json(status, body) { result = { status, body }; }, notFound() { result = { status: 404 }; } };
    await route.handler(context); return result;
  };
  const first = await request("p/A/1/index.html"); assert.match(first.body, /Current/); assert.equal(first.headers["Content-Security-Policy"], APP_CSP);
  assert.match((await request("p/A/index.html?v=2")).body, /Proposed/);
  assert.match((await request("p/A/index.html")).body, /Proposed/);
  const diff = await request("diff/A.json");
  assert.equal(diff.status, 200); assert.equal(diff.body.from, 1); assert.equal(diff.body.to, 2);
  assert.deepEqual(diff.body.lines.map(l => l.kind), ["remove", "add", "same"]);
  assert.equal((await request("shot/A/1.png")).body.toString(), "png1");
  for (const target of ["shot/A/3.png", "shot/B/1.png", "p/A/3/index.html", "p/A/1/secret", "p/A/%2e%2e/state.json", "diff/B.json"]) assert.equal((await request(target)).status, 404, target);
  await room.observer.onEvent({ type: "assessment", team: "A", judge: seat, verdict: "APPROVE", reason: "okay", version: 1 });
  assert.equal(room.state.assessments[0].version, 1); assert.equal(room.state.browser.version, 1);
  assert.equal(options.allowProxied("/state.json"), false); assert.equal(options.allowProxied("/shot/A/1.png"), false);
  assert.equal((await request("./")).csp, ROOM_CSP);
});

test("room version controls keep the strict CSP and use no inline script or HTML sinks", () => {
  assert.equal(ROOM_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.deepEqual(inlineProblems(ROOM_HTML), []); assert.doesNotMatch(ROOM_JS, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(ROOM_JS, /Current vs proposed/); assert.match(ROOM_JS, /not checked/); assert.match(ROOM_HTML, /Shared browser/);
  assert.doesNotThrow(() => new Function(ROOM_JS));
  assert.deepEqual(lineDiff("old\nkeep\nlast", "new\nkeep\nnext").map(l => l.kind), ["remove", "add", "same", "remove", "add"]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ kind: "same", text: "a" }, { kind: "remove", text: "b" }, { kind: "add", text: "x" }, { kind: "same", text: "c" }]);
});
