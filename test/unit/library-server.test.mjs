import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { Script } from "node:vm";
import { startLibrary, ACTION_HEADER, IMPORTS_PER_MINUTE, MAX_BODY_BYTES } from "../../dist/library/server.js";
import { LIBRARY_JS } from "../../dist/library/assets.js";
import { ROUNDTABLE_HOME } from "../../dist/config.js";

async function library(t) {
  const server = await startLibrary();
  t.after(() => server.close());
  const response = await fetch(server.url);
  const page = await response.text();
  const nonce = /name="roundtable-action" content="([^"]+)"/.exec(page)?.[1];
  assert.ok(nonce);
  const headers = { "Content-Type": "application/json", [ACTION_HEADER]: nonce };
  return { server, response, page, headers };
}
const body = JSON.stringify({ files: [{ filename: "server-reader.md", content: "---\nname: server-reader\ndescription: Reads from the drop zone.\ntools: Read\n---\nRead carefully." }] });

test("all library routes require the capability; the page has strict CSP and external assets", async t => {
  const { server, response, page } = await library(t);
  const origin = new URL(server.url).origin;
  for (const path of ["/", "/agents.json", "/library.js", "/library.css"]) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  assert.equal((await fetch(origin + "/import", { method: "POST", body })).status, 404);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.ok(!response.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.match(page, /<script src="library.js" defer><\/script>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(page));
  assert.ok(!/\s(?:style|on\w+)=/i.test(page));
  assert.equal((await fetch(server.url + "library.css")).status, 200);
  const js = await (await fetch(server.url + "library.js")).text();
  assert.equal(js, LIBRARY_JS);
  assert.doesNotThrow(() => new Script(js));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
  assert.match(js, /new FileReader/);
});

test("import refuses missing nonce, cross-origin, cross-site and non-JSON requests", async t => {
  const { server, headers } = await library(t);
  const post = custom => fetch(server.url + "import", { method: "POST", headers: custom, body });
  assert.equal((await post({ "Content-Type": "application/json" })).status, 403);
  assert.equal((await post({ ...headers, [ACTION_HEADER]: "wrong" })).status, 403);
  assert.equal((await post({ ...headers, Origin: "https://outside.invalid" })).status, 403);
  assert.equal((await post({ ...headers, "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ ...headers, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(server.url + "import")).status, 405);
  assert.equal((await fetch(server.url + "agents.json", { method: "POST" })).status, 405);
});

test("a valid page action imports files and refreshes discovery without exposing paths", async t => {
  const { server, headers } = await library(t);
  const response = await fetch(server.url + "import", { method: "POST", headers: { ...headers, Origin: new URL(server.url).origin, "Sec-Fetch-Site": "same-origin" }, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].status, "imported");
  const state = await (await fetch(server.url + "agents.json")).json();
  const agent = state.agents.find(agent => agent.key === "server-reader");
  assert.equal(agent.source, "library");
  assert.equal(agent.file, "server-reader.md");
  assert.deepEqual(agent.tools, ["Read"]);
  assert.deepEqual(agent.warnings, []);
  assert.ok(!JSON.stringify(state).includes(ROUNDTABLE_HOME));
  const second = await fetch(server.url + "import", { method: "POST", headers, body });
  assert.equal((await second.json()).results[0].status, "exists");
});

test("import rejects malformed JSON and too many files, and returns per-file refusals", async t => {
  const { server, headers } = await library(t);
  const post = body => fetch(server.url + "import", { method: "POST", headers, body });
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(JSON.stringify({ files: Array(51).fill({ filename: "a.md", content: "a" }) }))).status, 400);
  assert.equal((await post(JSON.stringify({ files: "not an array" }))).status, 400);
  const mixed = await post(JSON.stringify({ files: [null, { filename: "../escape.md", content: "a" }, { filename: "huge.md", content: "x".repeat(131073) }] }));
  assert.deepEqual((await mixed.json()).results.map(result => result.status), ["refused", "refused", "refused"]);
  assert.equal((await post("x".repeat(MAX_BODY_BYTES + 1))).status, 413);
});

test("the body cap also applies to chunked requests", async t => {
  const { server, headers } = await library(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(server.url + "import", { method: "POST", headers }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("x".repeat(MAX_BODY_BYTES));
    req.end("x");
  });
  assert.equal(status, 413);
});

test("library action nonces are per server and imports are rate limited", async t => {
  const first = await library(t);
  const second = await library(t);
  assert.notEqual(first.headers[ACTION_HEADER], second.headers[ACTION_HEADER]);
  assert.equal((await fetch(second.server.url + "import", { method: "POST", headers: first.headers, body })).status, 403);
  for (let i = 0; i < IMPORTS_PER_MINUTE; i++) {
    assert.equal((await fetch(first.server.url + "import", { method: "POST", headers: first.headers, body: '{"files":[]}' })).status, 200);
  }
  const limited = await fetch(first.server.url + "import", { method: "POST", headers: first.headers, body });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
});

test("the latest Casting Call is summarized; missing, invalid and partial files are omitted", async t => {
  const { server } = await library(t);
  const dir = join(ROUNDTABLE_HOME, "casting");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "latest.json");
  const summary = { id: "casting-fixture", createdAt: "2026-10-22T10:00:00Z", brief: "Review a plan", agents: [{ key: "server-reader", verdict: "cast", role: "Evidence reader" }] };
  const report = { ...summary, agents: [{ ...summary.agents[0], strengths: ["Reads"], risks: [], overlapsWith: [], lint: [] }], redundancy: [], gaps: [], recommended: { seats: ["server-reader"] } };
  writeFileSync(path, JSON.stringify(report));
  const state = await (await fetch(server.url + "agents.json")).json();
  assert.deepEqual(state.casting, summary);
  for (const bad of ["{", "null", "{}", JSON.stringify({ ...report, agents: [{ key: "x", verdict: "invalid" }] })]) {
    writeFileSync(path, bad);
    assert.equal(Object.hasOwn(await (await fetch(server.url + "agents.json")).json(), "casting"), false);
  }
  rmSync(path);
  assert.equal(Object.hasOwn(await (await fetch(server.url + "agents.json")).json(), "casting"), false);
});
