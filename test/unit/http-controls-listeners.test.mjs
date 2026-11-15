// Loopback integration for process HTTP, local connection deadlines and dashboard bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { promisify } from "node:util";
import { installHttpStack } from "../../dist/http/fetch.js";
import { SecureServer, INITIAL_IDLE_TIMEOUT_MS } from "../../dist/http/secure-server.js";
import { guardedDispatcher } from "../../dist/security/url-guard.js";
import { postCheckIn } from "../../dist/serve/senders.js";
import { startDashboard } from "../../dist/dashboard/server.js";
import { frozenRun, makeContract } from "../fixtures/execution/run.mjs";
import { stubDns } from "./helpers.mjs";

installHttpStack();

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("request deadline")));
    req.on("error", reject);
    req.end();
  });
}

test("six content codings reject cleanly through fetch and the preview probe", { timeout: 15_000 }, async () => {
  const stack = new URL("../../dist/http/fetch.js", import.meta.url).href;
  const previews = new URL("../../dist/previews/manager.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createServer } from "node:net";
    import { installHttpStack } from ${JSON.stringify(stack)};
    import { defaultDeps } from ${JSON.stringify(previews)};
    installHttpStack();
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\nContent-Length: 100\\r\\nConnection: close\\r\\n\\r\\n"));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = "http://127.0.0.1:" + server.address().port + "/";
      await assert.rejects(globalThis.fetch(url, { signal: AbortSignal.timeout(2000) }));
      assert.equal(await defaultDeps({}).probe(url), false);
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log("preview probe complete");
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, timeout: 10_000,
  });
  assert.match(result.stdout, /preview probe complete/);
  assert.equal(result.stderr, "");
});

test("the package fetch and check-in POST connect using only approved DNS answers", async t => {
  const hosts = [];
  const port = await listen(t, (req, res) => { hosts.push(req.headers.host); res.end("approved"); });
  const asked = stubDns(t, { "approved.example.test": ["127.0.0.1"] });
  t.mock.method(dns, "lookup", () => { throw new Error("connection uses the pinned lookup"); });
  const url = `http://approved.example.test:${port}/`;
  const dispatcher = await guardedDispatcher(url);
  try {
    const res = await globalThis.fetch(url, { dispatcher, redirect: "manual", signal: AbortSignal.timeout(2000) });
    assert.equal(await res.text(), "approved");
  } finally { await dispatcher.close(); }
  assert.deepEqual(await postCheckIn(url, "{}", { "content-type": "application/json" }), { ok: true });
  assert.deepEqual(asked, ["approved.example.test", "approved.example.test"]);
  assert.deepEqual(hosts, [`approved.example.test:${port}`, `approved.example.test:${port}`]);
});

test("guarded check-in POST returns a manual redirect result without following its location", async t => {
  let requests = 0;
  const port = await listen(t, (_req, res) => {
    requests++;
    res.writeHead(307, { location: "http://169.254.169.254/" });
    res.end();
  });
  const result = await postCheckIn(`http://127.0.0.1:${port}/`, "{}", {});
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(requests, 1);
});

test("128 idle loopback connections expire and leave slots for a fresh client", { timeout: 20_000 }, async t => {
  const server = await SecureServer.start({ name: "Fixture", routes: [{ path: "/", handler: c => c.text(200, "ready") }] });
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await server.close(); });
  const port = Number(new URL(server.url).port);
  const closed = [];
  await Promise.all(Array.from({ length: 128 }, async () => {
    const socket = connect({ host: "127.0.0.1", port });
    sockets.push(socket);
    socket.on("error", () => {});
    closed.push(new Promise(resolve => socket.once("close", resolve)));
    await once(socket, "connect");
  }));
  await Promise.race([
    Promise.all(closed),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("initial idle deadline")), INITIAL_IDLE_TIMEOUT_MS + 3000);
      timer.unref();
      t.after(() => clearTimeout(timer));
    }),
  ]);
  assert.ok(sockets.every(s => s.destroyed));
  assert.deepEqual(await get(server.url), { status: 200, body: "ready\n" });
});

test("dashboard contract pages bound long goal lines from stored contracts", async t => {
  const { store } = await frozenRun(makeContract({ goal: { ultimate: "# a" + " ".repeat(20_000) + "x", original_prompt: "Ship", artifacts: [] } }));
  const dashboard = await startDashboard(store.id, { store });
  t.after(() => dashboard.close());
  const result = await get(dashboard.url + "contract");
  assert.equal(result.status, 200);
  assert.match(result.body, /\[truncated\]/);
  assert.equal((await get(dashboard.url + "state.json")).status, 200);
});
