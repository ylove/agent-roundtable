import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyPageLoads } from "../../dist/execution/verify.js";
import { APP_CSP } from "../../dist/prototypes/board.js";
import { PrototypeTracker } from "../../dist/prototypes/session.js";

const predicate = { page_loads: { path: "index.html" } };
const clean = { ok: true, loaded: true, consoleErrors: [], exceptions: [], failedRequests: 0 };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "rt-page-loads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.html"), "<h1>Committed page</h1>");
  let closed = 0;
  const startServer = async options => {
    assert.equal(options.allowProxied("/state.json"), false);
    assert.equal(options.allowProxied("/p/check/index.html"), true);
    const route = options.routes[0];
    route.handler({ send(status, body, type, headers) {
      assert.equal(status, 200); assert.equal(body.toString(), "<h1>Committed page</h1>");
      assert.equal(headers["Content-Security-Policy"], APP_CSP);
    } });
    return { url: "http://127.0.0.1:1/capability/", close: async () => { closed++; } };
  };
  return { dir, startServer, closed: () => closed };
}

test("page_loads passes, fails on exceptions or missing load, and skips with a note", async t => {
  const f = await fixture(t);
  for (const [result, ok] of [[clean, true], [{ ...clean, exceptions: ["TypeError: bad"] }, false], [{ ...clean, loaded: false, reason: "timed out" }, false]]) {
    const actual = await verifyPageLoads(f.dir, predicate, { startServer: f.startServer, checkPage: async url => {
      assert.equal(url, "http://127.0.0.1:1/capability/p/check/index.html"); return result;
    } });
    assert.equal(actual.ok, ok);
  }
  const skipped = await verifyPageLoads(f.dir, predicate, { chromePath: "", startServer: () => { throw new Error("must not listen"); } });
  assert.equal(skipped.ok, true); assert.equal(skipped.skipped, true); assert.match(skipped.note, /skipped \(no browser\)/);
  assert.equal(f.closed(), 3);
});

test("page_loads refuses traversal and symlinks, and fails for missing files", async t => {
  const f = await fixture(t);
  const opts = { startServer: f.startServer, checkPage: async () => clean };
  assert.equal((await verifyPageLoads(f.dir, { page_loads: { path: "../index.html" } }, opts)).ok, false);
  assert.equal((await verifyPageLoads(f.dir, { page_loads: { path: "missing.html" } }, opts)).ok, false);
  await symlink(join(f.dir, "index.html"), join(f.dir, "link.html"));
  assert.match((await verifyPageLoads(f.dir, { page_loads: { path: "link.html" } }, opts)).note, /symlink refused/);
});

test("page_loads supports repository paths deeper than prototype file paths", async t => {
  const f = await fixture(t);
  const path = "public/a/b/c/d/index.html";
  await mkdir(join(f.dir, "public/a/b/c/d"), { recursive: true });
  await writeFile(join(f.dir, path), "<h1>Committed page</h1>");
  const result = await verifyPageLoads(f.dir, { page_loads: { path } }, { startServer: f.startServer, checkPage: async () => clean });
  assert.equal(result.ok, true);
});

test("prototype assessments and prompts carry the web page check; opt-out skips it", async t => {
  const f = await fixture(t);
  const board = { url: "http://127.0.0.1:1/capability/", update() {}, close: async () => {} };
  const result = { ...clean, ok: false, exceptions: ["TypeError: proposal broke"] };
  let calls = 0;
  const tracker = new PrototypeTracker({ sessionId: "check", mode: "collaborate", participants: ["a", "b"], public: false,
    assessorIsCaller: false, screenshots: false, checkPage: async () => { calls++; return result; } }, f.dir, board);
  t.after(() => tracker.close("ended"));
  const created = await tracker.onTurn(0, '<prototype kind="web" title="Page"><file path="index.html"><h1>Page</h1></file></prototype>', 0);
  assert.ok(created.created);
  assert.match(tracker.statusPromptFor(1), /Page check: threw TypeError: proposal broke/);
  await tracker.onTurn(1, "Verdict on P1: REVISE — fix it", 1);
  const record = tracker.toRecord(tracker.protos[0]);
  assert.deepEqual(record.check.exceptions, result.exceptions);
  assert.deepEqual(record.verdicts[0].check, record.check);
  assert.equal(calls, 1);
  tracker.opts.pageCheck = false;
  await tracker.onTurn(0, '<prototype kind="web" title="Other"><file path="index.html"><p>Other</p></file></prototype>', 2);
  assert.equal(calls, 1);
});
