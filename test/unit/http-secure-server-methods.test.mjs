// Per-route methods of the shared secure server (usage-visibility.md §7): a route may allow POST and
// nothing else; every other route stays GET and HEAD; the token and the Host check still come first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { SecureServer, COMMON_HEADERS, hasBody, sameOriginProblem } from "../../dist/http/secure-server.js";

function send(url, { method = "GET", host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method, headers: { Host: host ?? u.host, Connection: "close", "Content-Length": "0" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/([A-Za-z0-9_-]{24})\/$/;

async function start(t, routes) {
  const s = await SecureServer.start({ name: "Test server", routes });
  t.after(() => s.close());
  return s;
}

test("secure-server: a route may allow POST and nothing else; every other route stays GET and HEAD", async (t) => {
  const seen = [];
  const s = await start(t, [
    { path: "/", handler: (c) => c.text(200, "root") },
    { path: /^\/act\/([a-z]+)$/, methods: ["POST"], handler: (c) => { seen.push(c.method); c.json(200, { did: c.match[1] }); } },
  ]);
  const token = URL_RE.exec(s.url)[1];
  const origin = new URL(s.url).origin;
  // The mutating route answers POST only, with the common headers.
  const ok = await send(`${s.url}act/now`, { method: "POST" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { did: "now" });
  assert.deepEqual(seen, ["POST"]);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) assert.equal(ok.headers[k.toLowerCase()], v, k);
  for (const method of ["GET", "HEAD"]) {
    const r = await send(`${s.url}act/now`, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "POST");
  }
  // Methods no route allows are refused before anything else, with the read-only Allow.
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
    const r = await send(`${s.url}act/now`, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
  // POST elsewhere stays the read-only 405.
  const root = await send(s.url, { method: "POST" });
  assert.equal(root.status, 405);
  assert.equal(root.headers.allow, "GET, HEAD");
  // The token and the Host check come first for a POST too, and say nothing about the route.
  assert.equal((await send(`${origin}/act/now`, { method: "POST" })).status, 404);
  assert.equal((await send(`${origin}/${"A".repeat(24)}/act/now`, { method: "POST" })).status, 404);
  assert.equal((await send(`${s.url}act/now`, { method: "POST", host: "evil.example" })).status, 421);
  assert.equal((await send(`${origin}/${token}/nothing`, { method: "POST" })).status, 404);
  assert.deepEqual(seen, ["POST"], "the handler ran once");
});

test("secure-server: a server whose routes are all read-only refuses POST before the token", async (t) => {
  const s = await start(t, [{ path: "/", handler: (c) => c.text(200, "root") }]);
  const origin = new URL(s.url).origin;
  for (const target of [s.url, `${origin}/`, `${origin}/nope`]) {
    const r = await send(target, { method: "POST" });
    assert.equal(r.status, 405, target);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

test("secure-server: sameOriginProblem and hasBody", () => {
  const req = (headers) => ({ headers });
  const own = ["http://127.0.0.1:5"];
  assert.equal(sameOriginProblem(req({}), own), null, "a non-browser client sends neither header");
  assert.equal(sameOriginProblem(req({ origin: "http://127.0.0.1:5", "sec-fetch-site": "same-origin" }), own), null);
  assert.match(sameOriginProblem(req({ origin: "https://evil.example" }), own), /Cross-origin/);
  assert.match(sameOriginProblem(req({ origin: "null" }), own), /Cross-origin/);
  assert.match(sameOriginProblem(req({ "sec-fetch-site": "cross-site" }), own), /Cross-site/);
  assert.match(sameOriginProblem(req({ "sec-fetch-site": "same-site" }), own), /Cross-site/);
  assert.equal(hasBody(req({ "content-length": "0" })), false);
  assert.equal(hasBody(req({ "content-length": "3" })), true);
  assert.equal(hasBody(req({})), true, "no Content-Length: unknown, so refused");
  assert.equal(hasBody(req({ "content-length": "0", "transfer-encoding": "chunked" })), true);
});
