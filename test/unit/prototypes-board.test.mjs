import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeBoard, APP_CSP, BOARD_CSP, VIEWER_CSP, escapeHtml } from "../../dist/prototypes/board.js";

const XSS = `<script>alert("x")</script>`;

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rt-board-"));
  made.push(d);
  return d;
};

/**
 * Raw HTTP so the path is never normalized and the Host header can be forged. `url` is a full URL on the
 * board (built from board.url); `target` sends a raw request-target instead (absolute form = a proxy request).
 */
function get(url, { method = "GET", host, target } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: u.port,
        path: target ?? u.pathname + u.search,
        method,
        headers: { Host: host ?? u.host, Connection: "close" },
      },
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

/** A CONNECT (tunnel) request: returns the status line the board answers with. */
function tunnel(boardUrl, authority) {
  const port = Number(new URL(boardUrl).port);
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("end", () => resolve(data.split("\r\n")[0]));
    s.on("error", reject);
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

const BOARD_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/([A-Za-z0-9_-]{20,})\/$/;

test("board: binds 127.0.0.1 under a capability token, serves board, state.json and viewer with safe headers", async (t) => {
  const dir = await tmp();
  const board = await PrototypeBoard.start({ sessionId: "collab-1", mode: "collaborate", participants: ["alice", "bob", "carol"], topic: `T ${XSS}` });
  t.after(() => board.close());
  const token = BOARD_URL_RE.exec(board.url)?.[1];
  assert.ok(token, board.url);
  const base = `/${token}/`;
  board.update({ prototypes: [await liveWeb(dir), codeProto()] });

  const home = await get(board.url);
  assert.equal(home.status, 200);
  assert.equal(home.headers["content-security-policy"], BOARD_CSP);
  assert.match(BOARD_CSP, /frame-ancestors 'none'/);
  assert.equal(home.headers["cache-control"], "no-store");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["referrer-policy"], "no-referrer");
  assert.equal(home.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(home.headers["access-control-allow-origin"], undefined);
  assert.match(home.body, /Feedback opens when the session ends\./);
  assert.ok(!home.body.includes(XSS), "board escapes agent content");
  assert.ok(home.body.includes(escapeHtml(XSS)));
  assert.ok(home.body.includes(`data-base="${base}"`));
  assert.match(home.body, /fetch\(base\+"state\.json"/);
  assert.ok(home.body.includes(`href="${base}p/P1v1/"`), "links stay under the token");

  const st = await get(`${board.url}state.json`);
  assert.equal(st.status, 200);
  assert.match(st.headers["content-type"], /application\/json/);
  assert.equal(st.headers["cross-origin-resource-policy"], "same-origin");
  const state = JSON.parse(st.body);
  assert.equal(state.prototypes.length, 2);
  assert.deepEqual(state.prototypes[0].files, ["index.html", "css/site.css"]);
  assert.equal(state.prototypes[0].url, `${base}p/P1v1/`);
  assert.ok(!st.body.includes("<h1>Coupon</h1>"), "state.json never carries file contents");

  const v = await get(`${board.url}p/P1v1/`);
  assert.equal(v.status, 200);
  assert.equal(v.headers["content-security-policy"], VIEWER_CSP);
  assert.equal(v.headers["cross-origin-resource-policy"], "same-origin");
  assert.ok(!v.body.includes(XSS), "viewer escapes title, proposer, demo and verdict reasons");
  assert.ok(v.body.includes(`src="${base}p/P1v1/app/index.html"`));
  assert.ok(v.body.includes(`href="${base}"`), "back link stays under the token");
  assert.match(v.body, /width="1280" height="800"/);
  assert.match(v.body, /width="390" height="844"/);
  assert.match(v.body, /sandbox="allow-scripts allow-forms allow-modals"/);
  assert.ok(v.body.includes(escapeHtml("<!doctype html><h1>Coupon</h1>")), "escaped source");

  const c = await get(`${board.url}p/P2v1/`);
  assert.equal(c.status, 200);
  assert.ok(!c.body.includes(XSS));
  assert.ok(c.body.includes(escapeHtml(`CREATE TABLE t (x int); -- ${XSS}`)));

  const head = await get(board.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("board: every route needs the token; the bare token redirects to the board", async (t) => {
  const dir = await tmp();
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({ prototypes: [await liveWeb(dir)] });
  const token = BOARD_URL_RE.exec(board.url)[1];
  const origin = new URL(board.url).origin;
  const wrong = "A".repeat(token.length);
  for (const path of ["/", "/state.json", "/p/P1v1/", "/p/P1v1/app/index.html", `/${wrong}/`, `/${wrong}/state.json`, `/${token.slice(1)}/`, `/${token}x/`]) {
    const r = await get(origin + path);
    assert.equal(r.status, 404, path);
    assert.ok(!r.body.includes("Coupon") && !r.body.includes("prototypes"), path);
  }
  const bare = await get(`${origin}/${token}`);
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, `/${token}/`);
});

test("board: app files are served with the sandboxing CSP and content type; only the prototype's own files", async (t) => {
  const dir = await tmp();
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({ prototypes: [await liveWeb(dir), codeProto()] });
  assert.match(APP_CSP, /sandbox allow-scripts allow-forms allow-modals/);
  assert.match(APP_CSP, /frame-ancestors 'self'/);

  const html = await get(`${board.url}p/P1v1/app/index.html`);
  assert.equal(html.status, 200);
  assert.equal(html.headers["content-security-policy"], APP_CSP);
  assert.match(html.headers["content-type"], /^text\/html/);
  assert.equal(html.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(html.body, "<!doctype html><h1>Coupon</h1>");
  const css = await get(`${board.url}p/P1v1/app/css/site.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  // The sandboxed page has an opaque origin: its own subresources are cross-origin to it.
  assert.equal(css.headers["cross-origin-resource-policy"], "cross-origin");
  const entry = await get(`${board.url}p/P1v1/app/`);
  assert.equal(entry.status, 200);
  assert.equal(entry.body, "<!doctype html><h1>Coupon</h1>");

  // Files in the directory that are not part of the prototype, traversal and encoded traversal
  for (const p of [
    "p/P1v1/app/secret.txt",
    "p/P1v1/app/../../../../etc/passwd",
    "p/P1v1/app/%2e%2e/%2e%2e/owner.json",
    "p/P1v1/app/..%2f..%2fowner.json",
    "p/P1v1/app/css/..%2F..%2Fsecret.txt",
    "p/P1v1/app/%ZZ",
  ]) {
    const r = await get(board.url, { target: new URL(board.url).pathname + p });
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.body.includes("not a prototype file"));
  }
  // Code prototypes have no app route; diagrams have no render route (no screenshots of diagrams).
  assert.equal((await get(`${board.url}p/P2v1/app/schema.sql`)).status, 404);
  assert.equal((await get(`${board.url}p/P9v1/`)).status, 404);
  assert.equal((await get(`${board.url}nope`)).status, 404);
});

test("board: as the screenshot proxy, only its own prototype files are reachable", async (t) => {
  const dir = await tmp();
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({ prototypes: [await liveWeb(dir)] });
  const { port } = new URL(board.url);
  const other = Number(port) === 65535 ? 65534 : Number(port) + 1;

  // Proxied (absolute-form) requests for this board's app files are served.
  const app = await get(board.url, { target: `${board.url}p/P1v1/app/index.html` });
  assert.equal(app.status, 200);
  assert.equal(app.body, "<!doctype html><h1>Coupon</h1>");
  assert.equal(app.headers["content-security-policy"], APP_CSP);
  assert.equal((await get(board.url, { target: `${board.url}p/P1v1/app/css/site.css` })).status, 200);

  // Everything else is refused: other loopback ports, localhost, external hosts, https, the board's own
  // pages and state, and prototype routes without the token.
  const refused = [
    [`http://127.0.0.1:${other}/`, `127.0.0.1:${other}`],
    [`http://localhost:${other}/admin`, `localhost:${other}`],
    [`http://localhost:${port}${new URL(board.url).pathname}p/P1v1/app/index.html`, `localhost:${port}`],
    ["http://example.com/", "example.com"],
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254"],
    [`https://127.0.0.1:${port}/`, `127.0.0.1:${port}`],
    [`http://user:pw@127.0.0.1:${port}${new URL(board.url).pathname}p/P1v1/app/index.html`, `127.0.0.1:${port}`],
    [board.url, undefined],
    [`${board.url}state.json`, undefined],
    [`${board.url}p/P1v1/`, undefined],
    [`http://127.0.0.1:${port}/p/P1v1/app/index.html`, undefined],
  ];
  for (const [target, host] of refused) {
    const r = await get(board.url, { target, ...(host && { host }) });
    assert.ok([403, 404].includes(r.status), `${target} -> ${r.status}`);
    assert.ok(!r.body.includes("Coupon") && !r.body.includes("prototypes"), target);
    // An empty 403 makes Chrome show its own error page (a 403 with a body can stall a capture).
    if (r.status === 403) assert.equal(r.body, "", target);
  }
  assert.equal((await get(board.url, { target: "http://example.com/", host: "example.com" })).status, 403);
  assert.equal((await get(board.url, { target: `${board.url}state.json` })).status, 403);

  // Tunnels are never opened.
  assert.match(await tunnel(board.url, "example.com:443"), /^HTTP\/1\.1 403/);
  assert.match(await tunnel(board.url, `127.0.0.1:${other}`), /^HTTP\/1\.1 403/);
});

test("board: Host header check (DNS rebinding) and read-only methods", async (t) => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  const port = new URL(board.url).port;
  assert.equal((await get(board.url, { host: `localhost:${port}` })).status, 200);
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `127.0.0.1.nip.io:${port}`]) {
    const r = await get(`${board.url}state.json`, { host });
    assert.ok([421, 403].includes(r.status), `${host} -> ${r.status}`);
    assert.ok(!r.body.includes("prototypes"));
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const r = await get(board.url, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET, HEAD");
  }
});

test("board: destroyed prototypes answer 410 on every route, with verdicts and decision", async (t) => {
  const dir = await tmp();
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  const p = await liveWeb(dir);
  board.update({ prototypes: [p] });
  assert.equal((await get(`${board.url}p/P1v1/app/index.html`)).status, 200);
  const { live, ...rest } = p;
  board.update({
    prototypes: [{ ...rest, status: "shortlisted", awaiting: [], decision: { decision: "SHORTLIST", reason: `great ${XSS}` } }],
  });
  for (const path of ["p/P1v1/", "p/P1v1", "p/P1v1/app/index.html", "p/P1v1/app/css/site.css"]) {
    const r = await get(board.url + path);
    assert.equal(r.status, 410, path);
    assert.equal(r.headers["content-security-policy"], VIEWER_CSP);
    assert.match(r.body, /Destroyed after assessment/);
    assert.match(r.body, /SHORTLIST/);
    assert.match(r.body, /REVISE/);
    assert.ok(!r.body.includes(XSS));
  }
  const st = JSON.parse((await get(`${board.url}state.json`)).body);
  assert.equal(st.prototypes[0].destroyed, true);
  assert.equal(st.prototypes[0].files, undefined);
});

test("board: diagram viewer renders Mermaid client-side from the pinned module only", async (t) => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  t.after(() => board.close());
  board.update({
    prototypes: [{
      key: "P1v1", id: "P1", version: 1, label: "P1 v1", title: "Flow", kind: "diagram", proposer: "a", fileCount: 1,
      demo: "", status: "live", verdicts: [], awaiting: ["b"], createdAt: new Date().toISOString(),
      live: { dir: "/nonexistent", files: [{ path: "flow.mmd", content: `flowchart TD\nA["${XSS}"]-->B` }] },
    }],
  });
  const v = await get(`${board.url}p/P1v1/`);
  assert.equal(v.status, 200);
  assert.match(v.body, /<script type="module">import mermaid from "https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1\/dist\/mermaid\.esm\.min\.mjs"/);
  assert.match(v.body, /securityLevel:"strict"/);
  assert.ok(!v.body.includes(XSS));
  assert.match(v.body, /<pre class="mermaid">flowchart TD/);
  // Scripts may come from the pinned mermaid package only, never anywhere else on the CDN.
  assert.match(VIEWER_CSP, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1\/;/);
  assert.match(VIEWER_CSP, /frame-ancestors 'none'/);
  // No bare render page any more (diagram screenshots were dropped).
  assert.equal((await get(`${board.url}p/P1v1/render`)).status, 404);
});

test("board: close() stops the server and is idempotent", async () => {
  const board = await PrototypeBoard.start({ sessionId: "s", mode: "collaborate", participants: ["a", "b"] });
  await board.close();
  await board.close();
  await assert.rejects(() => get(board.url));
});
