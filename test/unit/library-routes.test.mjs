// Exercise the real route stack with an in-memory transport, including on hosts without sockets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecureServer } from "../../dist/http/secure-server.js";
import { startLibrary, ACTION_HEADER, MAX_BODY_BYTES } from "../../dist/library/server.js";
import { ROUNDTABLE_HOME } from "../../dist/config.js";

test("library routes enforce capability, nonce, origin, content type, body caps and rate limits", async t => {
  const servers = new Map();
  t.mock.method(SecureServer, "start", async options => {
    const transport = { close(done) { done(); }, closeAllConnections() {} };
    const server = new SecureServer(options, transport);
    server.port = 45000 + servers.size;
    servers.set(server.origin, server);
    return server;
  });
  const library = await startLibrary();
  t.after(() => library.close());
  const fetch = async (url, { method = "GET", headers = {}, body, chunks } = {}) => {
    const target = new URL(url);
    const server = servers.get(target.origin);
    const req = new PassThrough();
    req.method = method;
    req.url = target.pathname;
    req.headers = { host: target.host, ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) };
    let response;
    const res = {
      writeHead(status, headers) { response = { status, headers: new Headers(headers) }; },
      end(buffer) { const text = buffer?.toString() ?? ""; response.text = async () => text; response.json = async () => JSON.parse(text); },
    };
    const pending = server.route(req, res);
    for (const chunk of chunks ?? (body !== undefined ? [body] : [])) req.write(chunk);
    req.end();
    await pending;
    req.destroy();
    return response;
  };
  const page = await fetch(library.url);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const nonce = /name="roundtable-action" content="([^"]+)"/.exec(await page.text())[1];
  const headers = { "Content-Type": "application/json", [ACTION_HEADER]: nonce };
  const origin = new URL(library.url).origin;
  const body = JSON.stringify({ files: [{ filename: "route-reader.md", content: "Read carefully." }] });
  const post = (options = {}) => fetch(library.url + "import", { method: "POST", headers, body, ...options });
  assert.equal((await fetch(origin + "/agents.json")).status, 404);
  assert.equal((await fetch(origin + "/import", { method: "POST", body })).status, 404);
  assert.equal((await post({ headers: { "Content-Type": "application/json" } })).status, 403);
  assert.equal((await post({ headers: { ...headers, Origin: "https://outside.invalid" } })).status, 403);
  assert.equal((await post({ headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await post({ headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post({ headers: { ...headers, host: "outside.invalid" } })).status, 421);
  assert.equal((await fetch(library.url + "import")).status, 405);
  assert.equal((await fetch(library.url + "agents.json", { method: "POST", body })).status, 405);
  assert.equal((await post({ body: "{" })).status, 400);
  assert.equal((await post({ body: JSON.stringify({ files: Array(51).fill({ filename: "x.md", content: "x" }) }) })).status, 400);
  assert.equal((await post({ chunks: [Buffer.alloc(MAX_BODY_BYTES), Buffer.from("x")] })).status, 413);
  assert.equal((await post({ headers: { ...headers, "Content-Length": String(MAX_BODY_BYTES + 1) } })).status, 413);
  const imported = await post({ headers: { ...headers, Origin: origin, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).results[0].status, "imported");
  const agents = (await (await fetch(library.url + "agents.json")).json()).agents;
  assert.equal(agents.find(agent => agent.key === "route-reader").source, "library");
  assert.equal((await (await post()).json()).results[0].status, "exists");
  const dir = join(ROUNDTABLE_HOME, "casting");
  mkdirSync(dir, { recursive: true });
  const summary = { id: "route-casting", brief: "Read evidence", createdAt: "2026-10-22T10:00:00Z", agents: [{ key: "route-reader", verdict: "cast", role: "Reader" }] };
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ ...summary, recommended: { seats: ["route-reader"] } }));
  assert.deepEqual((await (await fetch(library.url + "agents.json")).json()).casting, summary);
  writeFileSync(join(dir, "latest.json"), "{");
  assert.equal((await (await fetch(library.url + "agents.json")).json()).casting, undefined);
  const second = await startLibrary();
  t.after(() => second.close());
  assert.equal((await fetch(second.url + "import", { method: "POST", headers, body })).status, 403);
  let limited;
  for (let i = 0; i < 21; i++) {
    limited = await post({ body: '{"files":[]}' });
    if (limited.status === 429) break;
  }
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
});
