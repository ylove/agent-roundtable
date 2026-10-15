import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import {
  SecureServer, COMMON_HEADERS, DEFAULT_CSP, escapeHtml, newCapabilityToken, tokenMatches,
} from "../../dist/http/secure-server.js";

/** Raw HTTP: the path is never normalized and the Host header can be forged. */
function get(url, { method = "GET", host, target } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: u.port, path: target ?? u.pathname + u.search, method, headers: { Host: host ?? u.host, Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const PAGE_CSP = "default-src 'none'; style-src 'self'";

async function start(t, extra = {}) {
  const s = await SecureServer.start({
    name: "Test server",
    routes: [
      { path: "/", handler: (c) => c.html(200, `<p>${escapeHtml(c.query.get("q"))}</p>`, PAGE_CSP) },
      { path: "/data.json", handler: (c) => c.json(200, { ok: true }) },
      { path: /^\/item\/([a-z]+)$/, handler: (c) => c.text(200, `item ${c.match[1]}`) },
      { path: "/boom", handler: () => { throw new Error(`failed at ${c0.url}`); } },
      { path: "/frame", handler: (c) => c.send(200, "x", "text/plain; charset=utf-8", { "X-Frame-Options": "SAMEORIGIN", "Cross-Origin-Opener-Policy": null }) },
    ],
    ...extra,
  });
  const c0 = s;
  t.after(() => s.close());
  return s;
}

const URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/([A-Za-z0-9_-]{24})\/$/;

function assertCommonHeaders(r, label) {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${label}: ${k}`);
  assert.ok(r.headers["content-security-policy"], `${label}: CSP`);
  assert.equal(r.headers["access-control-allow-origin"], undefined, label);
}

test("secure-server: 127.0.0.1, a 24-character token, and the common headers on every response", async (t) => {
  const s = await start(t);
  const token = URL_RE.exec(s.url)?.[1];
  assert.ok(token, s.url);
  assert.equal(s.base, `/${token}/`);
  assert.equal(newCapabilityToken().length, 24);
  assert.notEqual(newCapabilityToken(), newCapabilityToken());

  const home = await get(`${s.url}?q=${encodeURIComponent('<script>x</script>')}`);
  assert.equal(home.status, 200);
  assert.equal(home.headers["content-security-policy"], PAGE_CSP, "per-response CSP");
  assert.match(home.headers["content-type"], /^text\/html/);
  assert.equal(home.body, "<p>&lt;script&gt;x&lt;/script&gt;</p>");
  assertCommonHeaders(home, "page");
  assert.match(COMMON_HEADERS["Permissions-Policy"], /camera=\(\)/);
  assert.match(COMMON_HEADERS["Permissions-Policy"], /microphone=\(\)/);
  assert.match(COMMON_HEADERS["Permissions-Policy"], /geolocation=\(\)/);
  assert.equal(COMMON_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(COMMON_HEADERS["Cross-Origin-Opener-Policy"], "same-origin");

  const data = await get(`${s.url}data.json`);
  assert.equal(data.status, 200);
  assert.deepEqual(JSON.parse(data.body), { ok: true });
  assert.equal(data.headers["content-security-policy"], DEFAULT_CSP, "routes without a CSP get the default");
  assertCommonHeaders(data, "json");
  assert.equal((await get(`${s.url}item/abc`)).body, "item abc\n");
  // A route may override or drop a common header.
  const framed = await get(`${s.url}frame`);
  assert.equal(framed.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(framed.headers["cross-origin-opener-policy"], undefined);

  for (const [path, opts] of [["nope", {}], ["", { host: "evil.example" }], ["", { method: "POST" }]]) {
    assertCommonHeaders(await get(s.url + path, opts), `error ${path} ${JSON.stringify(opts)}`);
  }
  const head = await get(s.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  const bare = await get(`${new URL(s.url).origin}/${token}`);
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, `/${token}/`);
});

test("secure-server: no token, a wrong token or a near miss is the same plain 404", async (t) => {
  const s = await start(t);
  const token = URL_RE.exec(s.url)[1];
  const origin = new URL(s.url).origin;
  const flip = (i) => token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
  const paths = [
    "/", "/data.json", "/item/abc", `/${"A".repeat(24)}/`, `/${token.slice(1)}/`, `/${token}x/`, `/${flip(0)}/`,
    `/${flip(23)}/data.json`, `/${token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()}/`, `/x/${token}/`,
  ];
  const bodies = new Set();
  for (const path of paths) {
    const r = await get(origin + path);
    assert.equal(r.status, 404, path);
    bodies.add(r.body);
    assert.equal(r.headers["content-length"], "10", path);
  }
  assert.deepEqual([...bodies], ["Not found\n"], "one answer whatever the guess");
  assert.equal((await get(`${s.url}nope`)).status, 404, "unknown route under the token");
});

test("secure-server: the token is compared with crypto.timingSafeEqual, on equal-length digests", async (t) => {
  const s = await start(t);
  const token = URL_RE.exec(s.url)[1];
  const seen = [];
  const original = crypto.timingSafeEqual;
  t.mock.method(crypto, "timingSafeEqual", function (a, b) {
    seen.push([a.length, b.length]);
    return original.call(this, a, b);
  });
  assert.equal((await get(`${new URL(s.url).origin}/short/`)).status, 404);
  assert.equal((await get(`${new URL(s.url).origin}/${"z".repeat(200)}/`)).status, 404);
  assert.equal((await get(s.url)).status, 200);
  assert.deepEqual(seen, [[32, 32], [32, 32], [32, 32]], "every request, any candidate length, compares sha256 digests");
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token.slice(0, -1), token), false);
  assert.equal(tokenMatches("", token), false);
});

test("secure-server: Host header check (421) before anything else is revealed", async (t) => {
  const s = await start(t);
  const port = new URL(s.url).port;
  assert.equal((await get(s.url, { host: `localhost:${port}` })).status, 200);
  assert.equal((await get(s.url, { host: `LOCALHOST:${port}` })).status, 200);
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `127.0.0.1.nip.io:${port}`]) {
    const r = await get(`${s.url}data.json`, { host });
    assert.equal(r.status, 421, host);
    assert.ok(!r.body.includes("ok"), host);
  }
});

test("secure-server: GET and HEAD only (405 with Allow)", async (t) => {
  const s = await start(t);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH", "TRACE"]) {
    const r = await get(s.url, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

test("secure-server: proxy requests, CONNECT and upgrades are refused unless it is a deny-all proxy", async (t) => {
  const s = await start(t);
  const r = await get(s.url, { target: `${s.url}data.json` });
  assert.equal(r.status, 403);
  assert.equal(r.body, "");
  const port = Number(new URL(s.url).port);
  const line = await new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data.split("\r\n")[0]));
    sock.on("error", reject);
  });
  assert.match(line, /^HTTP\/1\.1 403/);

  const proxy = await start(t, { allowProxied: (p) => p === "/item/ok" });
  assert.equal((await get(proxy.url, { target: `${proxy.url}item/ok` })).status, 200);
  for (const target of [`${proxy.url}data.json`, `${proxy.url}`, "http://example.com/", `http://localhost:${new URL(proxy.url).port}${proxy.base}item/ok`]) {
    const x = await get(proxy.url, { target });
    assert.equal(x.status, 403, target);
    assert.equal(x.body, "", target);
  }
});

test("secure-server: a failing route is a 500 and the log never carries the token", async (t) => {
  const s = await start(t);
  const token = URL_RE.exec(s.url)[1];
  const lines = [];
  t.mock.method(console, "error", (...a) => lines.push(a.join(" ")));
  const r = await get(`${s.url}boom`);
  assert.equal(r.status, 500);
  assert.equal(r.body, "Internal error\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[Test server\] request failed: failed at http:\/\/127\.0\.0\.1:\d+\/<token>\/$/);
  assert.ok(!lines.join("\n").includes(token));
});

test("secure-server: streams end when the client leaves or the server closes", async (t) => {
  let opened;
  const closedFlags = [];
  const s = await SecureServer.start({
    name: "Stream",
    routes: [{
      path: "/stream",
      handler: (c) => {
        const st = c.stream("text/event-stream; charset=utf-8");
        if (!st) return;
        st.onClose(() => closedFlags.push(true));
        st.write("event: hello\ndata: 1\n\n");
        opened = st;
      },
    }],
  });
  t.after(() => s.close());
  const head = await get(`${s.url}stream`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.match(head.headers["content-type"], /^text\/event-stream/);
  const first = await new Promise((resolve, reject) => {
    const u = new URL(`${s.url}stream`);
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname, headers: { Host: u.host } }, (res) => {
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      res.once("data", (d) => resolve(String(d)));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(first, "event: hello\ndata: 1\n\n");
  assert.equal(opened.closed, false);
  await s.close();
  assert.equal(opened.closed, true);
  assert.deepEqual(closedFlags, [true]);
});

test("escapeHtml escapes the five HTML metacharacters", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(5), "5");
});
