import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeBoard, APP_CSP, VIEWER_CSP, escapeHtml } from "../../dist/prototypes/board.js";

const XSS = `<script>alert("x")</script>`;

/** Raw HTTP so the path is never normalized and the Host header can be forged. */
function get(url, path, { method = "GET", host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: u.port, path, method, headers: { Host: host ?? u.host, Connection: "close" } },
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

async function liveWeb(dir) {
  await mkdir(join(dir, "css"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><h1>Coupon</h1>");
  await writeFile(join(dir, "css", "site.css"), "h1{color:red}");
  await writeFile(join(dir, "secret.txt"), "not a prototype file");
  return {
    key: "P1v1", id: "P1", version: 1, label: "P1 v1",
    title: `Coupon ${XSS}`, kind: "web", proposer: `alice ${XSS}`, fileCount: 2, entry: "index.html",
    demo: `Impatient user ${XSS}`, status: "live",
    verdicts: [{ assessor: "bob", verdict: "REVISE", reason: `too small ${XSS}` }],
    awaiting: ["carol"], createdAt: new Date().toISOString(),
    live: {
      dir,
      entry: "index.html",
      files: [
        { path: "index.html", content: `<!doctype html><h1>Coupon</h1>` },
        { path: "css/site.css", content: "h1{color:red}" },
      ],
    },
  };
}

function codeProto() {
  return {
    key: "P2v1", id: "P2", version: 1, label: "P2 v1", title: "Schema", kind: "code", proposer: "bob",
    fileCount: 1, demo: "", status: "live", verdicts: [], awaiting: ["alice"], createdAt: new Date().toISOString(),
    live: { dir: "/nonexistent", files: [{ path: "schema.sql", content: `CREATE TABLE t (x int); -- ${XSS}` }] },
  };
}

test("board: binds 127.0.0.1, serves board, state.json and viewer with safe headers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rt-board-"));
  const board = await PrototypeBoard.start({ sessionId: "collab-1", mode: "collaborate", participants: ["alice", "bob", "carol"], topic: `T ${XSS}` });
  t.after(() => board.close());
  assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  board.update({ prototypes: [await liveWeb(dir), codeProto()] });

  const home = await get(board.url, "/");
  assert.equal(home.status, 200);
  assert.equal(home.headers["cache-control"], "no-store");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["referrer-policy"], "no-referrer");
  assert.equal(home.headers["access-control-allow-origin"], undefined);
  assert.match(home.body, /Feedback opens when the session ends\./);
  assert.ok(!home.body.includes(XSS), "board escapes agent content");
  assert.ok(home.body.includes(escapeHtml(XSS)));
  assert.match(home.body, /fetch\("\/state\.json"/);

  const st = await get(board.url, "/state.json");
  assert.equal(st.status, 200);
  assert.match(st.headers["content-type"], /application\/json/);
  const state = JSON.parse(st.body);
  assert.equal(state.prototypes.length, 2);
  assert.deepEqual(state.prototypes[0].files, ["index.html", "css/site.css"]);
  assert.ok(!st.body.includes("<h1>Coupon</h1>"), "state.json never carries file contents");

  const v = await get(board.url, "/p/P1v1/");
  assert.equal(v.status, 200);
  assert.equal(v.headers["content-security-policy"], VIEWER_CSP);
  assert.ok(!v.body.includes(XSS), "viewer escapes title, proposer, demo and verdict reasons");
  assert.ok(v.body.includes(`src="/p/P1v1/app/index.html"`));
  assert.match(v.body, /width="1280" height="800"/);
  assert.match(v.body, /width="390" height="844"/);
  assert.match(v.body, /sandbox="allow-scripts allow-forms allow-modals"/);
  assert.ok(v.body.includes(escapeHtml("<!doctype html><h1>Coupon</h1>")), "escaped source");

  const c = await get(board.url, "/p/P2v1/");
  assert.equal(c.status, 200);
  assert.ok(!c.body.includes(XSS));
  assert.ok(c.body.includes(escapeHtml(`CREATE TABLE t (x int); -- ${XSS}`)));

  const head = await get(board.url, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("board: app files are served with CSP and content type; only the prototype's own files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rt-board-"));
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({ prototypes: [await liveWeb(dir), codeProto()] });

  const html = await get(board.url, "/p/P1v1/app/index.html");
  assert.equal(html.status, 200);
  assert.equal(html.headers["content-security-policy"], APP_CSP);
  assert.match(html.headers["content-type"], /^text\/html/);
  assert.equal(html.body, "<!doctype html><h1>Coupon</h1>");
  const css = await get(board.url, "/p/P1v1/app/css/site.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  const entry = await get(board.url, "/p/P1v1/app/");
  assert.equal(entry.status, 200);
  assert.equal(entry.body, "<!doctype html><h1>Coupon</h1>");

  // Files in the directory that are not part of the prototype, traversal and encoded traversal
  for (const p of [
    "/p/P1v1/app/secret.txt",
    "/p/P1v1/app/../../../../etc/passwd",
    "/p/P1v1/app/%2e%2e/%2e%2e/owner.json",
    "/p/P1v1/app/..%2f..%2fowner.json",
    "/p/P1v1/app/css/..%2F..%2Fsecret.txt",
    "/p/P1v1/app/%ZZ",
  ]) {
    const r = await get(board.url, p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.body.includes("not a prototype file"));
  }
  // Code prototypes have no app route
  assert.equal((await get(board.url, "/p/P2v1/app/schema.sql")).status, 404);
  assert.equal((await get(board.url, "/p/P9v1/")).status, 404);
  assert.equal((await get(board.url, "/nope")).status, 404);
});

test("board: Host header check (DNS rebinding) and read-only methods", async (t) => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  const port = new URL(board.url).port;
  assert.equal((await get(board.url, "/", { host: `localhost:${port}` })).status, 200);
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `127.0.0.1.nip.io:${port}`]) {
    const r = await get(board.url, "/state.json", { host });
    assert.ok([421, 403].includes(r.status), `${host} -> ${r.status}`);
    assert.ok(!r.body.includes("prototypes"));
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const r = await get(board.url, "/", { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

test("board: destroyed prototypes answer 410 on every route, with verdicts and decision", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rt-board-"));
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  const p = await liveWeb(dir);
  board.update({ prototypes: [p] });
  assert.equal((await get(board.url, "/p/P1v1/app/index.html")).status, 200);
  const { live, ...rest } = p;
  board.update({
    prototypes: [{ ...rest, status: "shortlisted", awaiting: [], decision: { decision: "SHORTLIST", reason: `great ${XSS}` } }],
  });
  for (const path of ["/p/P1v1/", "/p/P1v1", "/p/P1v1/app/index.html", "/p/P1v1/app/css/site.css", "/p/P1v1/render"]) {
    const r = await get(board.url, path);
    assert.equal(r.status, 410, path);
    assert.match(r.body, /Destroyed after assessment/);
    assert.match(r.body, /SHORTLIST/);
    assert.match(r.body, /REVISE/);
    assert.ok(!r.body.includes(XSS));
  }
  const st = JSON.parse((await get(board.url, "/state.json")).body);
  assert.equal(st.prototypes[0].destroyed, true);
  assert.equal(st.prototypes[0].files, undefined);
});

test("board: diagram viewer renders Mermaid client-side from the pinned module", async (t) => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({
    prototypes: [{
      key: "P1v1", id: "P1", version: 1, label: "P1 v1", title: "Flow", kind: "diagram", proposer: "a", fileCount: 1,
      demo: "", status: "live", verdicts: [], awaiting: ["b"], createdAt: new Date().toISOString(),
      live: { dir: "/nonexistent", files: [{ path: "flow.mmd", content: `flowchart TD\nA["${XSS}"]-->B` }] },
    }],
  });
  const v = await get(board.url, "/p/P1v1/");
  assert.equal(v.status, 200);
  assert.match(v.body, /<script type="module">import mermaid from "https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1\/dist\/mermaid\.esm\.min\.mjs"/);
  assert.match(v.body, /securityLevel:"strict"/);
  assert.ok(!v.body.includes(XSS));
  assert.match(v.body, /<pre class="mermaid">flowchart TD/);
  const r = await get(board.url, "/p/P1v1/render");
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes(XSS));
});

test("board: close() stops the server and is idempotent", async () => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  await board.close();
  await board.close();
  await assert.rejects(() => get(board.url, "/"));
});
