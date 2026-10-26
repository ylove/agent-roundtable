// These integration checks need a loopback listener; run them outside the restricted sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startIndex } from "../../dist/serve/index.js";
import { startServe, serveStatus, serveInfoPath, serveDir } from "../../dist/serve/service.js";
import { registerDuel, unregisterDuel } from "../../dist/table/live-duels.js";
import { mkdirPrivate } from "../../dist/security/fs-safe.js";
import { ROUNDTABLE_HOME } from "../../dist/config.js";
import { newExecutionId } from "../../dist/ids.js";
import { emit, frozenRun, makeContract } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

function get(url, method = "GET", host) {
  const u = new URL(url);
  const m = /^https?:\/\/[^/]+(\/.*)$/.exec(url);
  const rawPath = m ? m[1] : u.pathname;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: u.port, path: rawPath, method, headers: { Host: host ?? u.host, Connection: "close" } }, res => {
      const parts = [];
      res.on("data", part => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serve index capability, escaped fixtures, valid ids, strict CSP and read-only routes", async t => {
  const hostile = '<script>alert("bad")</script>';
  const { store } = await frozenRun(makeContract({ title: hostile }));
  await emit(store, "escalation.raised", { escalation: { id: "e1", agent: "a", kind: "emergency", with: "orchestrator", summary: hostile, blocking: true, status: "open", raised_seq: 0 } });
  await emit(store, "escalation.awaiting_human", { id: "e1", class: "money", message: hostile });
  mkdirPrivate(join(ROUNDTABLE_HOME, "duels"));
  mkdirPrivate(join(ROUNDTABLE_HOME, "casting"));
  writeFileSync(join(ROUNDTABLE_HOME, "duels", "duel-archive.json"), JSON.stringify({ events: [{ type: "start", topic: hostile }, { type: "end", winner: "A" }] }));
  writeFileSync(join(ROUNDTABLE_HOME, "casting", "latest.json"), JSON.stringify({ brief: hostile }));
  registerDuel({ id: "duel-live", agents: ["a", "b"], started: new Date().toISOString() });
  t.after(() => unregisterDuel("duel-live"));
  const index = await startIndex();
  t.after(() => index.close());
  assert.equal((await get(new URL("/", index.url).href)).status, 404);
  assert.equal((await get(index.url.replace(index.base, "/wrong-token/"))).status, 404);
  assert.equal((await get(index.url, "GET", `localhost:${new URL(index.url).port}`)).status, 421);
  const root = await get(index.url);
  assert.equal(root.status, 200);
  assert.match(root.body, new RegExp(store.id));
  assert.match(root.body, /&lt;script&gt;/);
  for (const name of ["duel-live", "duel-archive", "Latest casting"]) assert.ok(root.body.includes(name));
  for (const path of ["", `x/${store.id}/`, `x/${store.id}/escalations`, "duels/duel-archive", "casting"]) {
    const page = await get(index.url + path);
    assert.equal(page.status, 200, path);
    assert.deepEqual(inlineProblems(page.body), [], path);
    assert.ok(!page.body.includes(hostile));
    assert.ok(!page.body.includes("roundtable-action"));
    assert.ok(!page.body.includes("stop-agent"));
    assert.match(page.headers["content-security-policy"], /script-src 'self'/);
    assert.equal((await get(index.url + path, "POST")).status, 405);
    assert.equal((await get(index.url + path, "HEAD")).body, "");
  }
  for (const path of ["x/bad/", `x/${newExecutionId()}/`, "x/%2Ftmp/", "x/../../secrets", `x/${store.id}/stop`, "stop"]) assert.equal((await get(index.url + path)).status, 404, path);
  const js = await get(index.url + `x/${store.id}/static/dashboard.js`);
  assert.equal(js.status, 200);
  assert.match(js.body, /setInterval/);
  assert.match(js.body, /location.reload/);
});

test("serve lifecycle holds one lock, publishes private metadata and cleans up", async () => {
  const logs = [];
  const service = await startServe({ keepRunners: false, log: s => logs.push(s) });
  try {
    const status = serveStatus();
    assert.equal(status.running, true);
    assert.equal(status.info.url, service.url);
    assert.equal(statSync(serveInfoPath()).mode & 0o777, 0o600);
    assert.equal(statSync(join(serveDir(), "notify-state.json")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(serveInfoPath())).pid, process.pid);
    await assert.rejects(startServe({ keepRunners: false }), /Timed out/);
    assert.equal(logs.filter(s => s.includes("no check-in channel configured")).length, 1);
    assert.ok(logs.every(s => !s.includes(service.url) && !s.includes(new URL(service.url).pathname)));
  } finally { await service.close(); }
  assert.equal(serveStatus().running, false);
  assert.equal(existsSync(serveInfoPath()), false);
  assert.equal(existsSync(join(serveDir(), "serve.lock")), false);
});
