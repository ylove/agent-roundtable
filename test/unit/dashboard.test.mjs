import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { startDashboard, DASHBOARD_CSP, capAtLine } from "../../dist/dashboard/server.js";
import { completion, markdownToHtml, taskWeight } from "../../dist/dashboard/render.js";
import { renderDagSvg, layers } from "../../dist/dashboard/dag-svg.js";
import { COMMON_HEADERS } from "../../dist/http/secure-server.js";
import { emit, frozenRun, makeContract, src, taskSpec } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const XSS = `<script>alert(1)</script>`;
const ATTR = `"><img src=x onerror=alert(1)>`;
const JS_URL = "javascript:alert(1)";
const EMAIL = "alice.secret@example.com";
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwx";

function get(url, { method = "GET", host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method, headers: { Host: host ?? u.host, Connection: "close" } },
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

function hostileContract() {
  return makeContract({
    title: `Nav ${XSS}`,
    goal: { ultimate: `Ship it ${ATTR} ${JS_URL}`, original_prompt: `build ${XSS}`, artifacts: [{ kind: "url", ref: JS_URL, title: ATTR }] },
    tasks: [
      taskSpec("a", [], { team: "core", title: `Build ${XSS}`, acceptance: [ATTR, `see ${JS_URL}`], persona: `dev${ATTR}` }),
      taskSpec("b", ["a"], { title: `Wire ${ATTR}` }),
      taskSpec("c", ["a", "b"], { title: "Docs" }),
    ],
    interfaces: [{ name: "NavProps", kind: "type", owner: "a", description: `props ${XSS}` }],
    decisions: [{ id: "d0", scope: "contract", text: `Use ${ATTR}`, by: "main" }],
    validation: { commands: [{ id: "test", argv: ["npm", "test", XSS], timeout_s: 600 }], final: ["test"] },
  });
}

/** A run with hostile text in every field the store lets through, a diff and a failing check output. */
async function hostileRun() {
  const { store } = await frozenRun(hostileContract());
  const agent = `w1${ATTR}`;
  await emit(store, "agent.registered", { agent, persona: "dev", team: "core", driver: "claude-code", token_sha256: "t1", external: false });
  await emit(store, "task.claimed", { task: "a", agent, attempt: 1, ttl_s: 0 });
  await emit(store, "task.progress", { task: "a", percent: 40, note: `halfway ${XSS} mail ${EMAIL}` }, src(agent, "agent"));
  await emit(store, "note.posted", { topic: `topic ${ATTR}`, text: `ping ${EMAIL} key ${KEY} ${XSS}`, refs: [] }, src(agent, "agent"));
  // Stored unredacted on purpose: the dashboard must redact what it shows by itself.
  const diff = await store.putBlob(
    `diff --git a/src/a/x.ts b/src/a/x.ts\n@@ -1 +1 @@\n-old\n+const token = "${GH_TOKEN}"; // ${EMAIL}\n+${XSS}\n`,
    { redact: false }
  );
  await emit(store, "task.submitted", { task: "a", commit: "c1", diff_blob: diff, stat: `1 file changed ${XSS}`, files: ["src/a/x.ts"], rewrites: [] }, src(agent, "agent"));
  const output = await store.putBlob(`FAIL ${XSS}\nAuthorization: Bearer ${GH_TOKEN}\nmail ${EMAIL}\n`, { redact: false });
  await emit(store, "check.failed", { command_id: "test", scope: "task", task: "a", exit: 1, signature: `sig${ATTR}`, output_blob: output });
  const escalation = {
    id: `E1${ATTR}`, task: "b", agent: "w2", kind: "emergency", with: "orchestrator", summary: `Need money ${XSS}`,
    question: `Approve ${ATTR}?`, options: [JS_URL, `${EMAIL}`], blocking: true, status: "open", raised_seq: 0,
  };
  await emit(store, "escalation.raised", { escalation }, src("w2", "agent"));
  await emit(store, "task.blocked", { task: "b", escalation: escalation.id });
  await emit(store, "escalation.awaiting_human", { id: escalation.id, class: "money", message: `Budget ${XSS}` });
  return store;
}

const PAGES = ["", "tasks", "tasks/a", "tasks/b", "tasks/c", "escalations", "events", "events?task=a", "events?type=task", "events?type=note.posted", "contract", "dag"];

test("dashboard: every page escapes and redacts hostile run content, with no inline script, style or handler", async (t) => {
  const store = await hostileRun();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{24}\/$/);
  const seen = {};
  for (const path of PAGES) {
    const r = await get(dash.url + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["content-security-policy"], DASHBOARD_CSP, path);
    assert.match(r.headers["content-type"], /^text\/html/, path);
    for (const [k, v] of Object.entries(COMMON_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${path} ${k}`);
    assert.deepEqual(inlineProblems(r.body), [], path);
    assert.ok(!r.body.includes("<script>alert"), `${path}: raw script`);
    assert.ok(!/<img\b/i.test(r.body), `${path}: raw img`);
    assert.ok(!r.body.includes(EMAIL), `${path}: email`);
    assert.ok(!r.body.includes(GH_TOKEN) && !r.body.includes(KEY), `${path}: secret`);
    assert.ok(!/(?:href|src)="\s*javascript:/i.test(r.body), `${path}: javascript: url`);
    assert.match(r.body, /<script src="\/[A-Za-z0-9_-]{24}\/static\/dashboard\.js"><\/script>/, path);
    // The escalation banner is on every page while a human is needed.
    assert.match(r.body, /A human is needed/, path);
    seen[path] = r.body;
  }
  // The hostile content is there, escaped.
  assert.ok(seen[""].includes("Nav &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(seen[""].includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(seen["tasks/a"].includes("Build &lt;script&gt;alert(1)&lt;/script&gt;"), "task title");
  assert.ok(seen["tasks/a"].includes("see javascript:alert(1)"), "acceptance");
  assert.ok(seen["tasks/a"].includes("[redacted:email]"), "redacted diff and note");
  assert.match(seen["tasks/a"], /<pre class="diff">/);
  assert.match(seen["tasks/a"], /<span class="add">\+const token = &quot;\[redacted:api_key\]&quot;; \/\/ \[redacted:email\]<\/span>/);
  assert.match(seen["tasks/a"], /Output \(redacted\)/);
  assert.match(seen["tasks/a"], /Authorization: \[redacted:secret\] \[redacted:bearer\]/);
  assert.match(seen["escalations"], /Need money &lt;script&gt;/);
  assert.match(seen["contract"], /<h3>Goal<\/h3>/);
  assert.ok(seen["contract"].includes("(javascript:alert(1))") || seen["contract"].includes("javascript:alert(1)"));
  assert.match(seen["dag"], /<svg class="dag"/);
  // Overview numbers: a submitted (0.8), b blocked and c pending (0).
  assert.match(seen[""], /<div class="big">27%<\/div>/);
  assert.match(seen[""], /<progress max="100" value="27">/);
  assert.match(seen["tasks"], /<a href="\/[A-Za-z0-9_-]{24}\/tasks\/a">a<\/a>/);
  assert.match(seen["events?task=a"], /task\.progress/);
  assert.doesNotMatch(seen["events?task=a"], /note\.posted<\/code>/);
});

test("dashboard: read-only, under the token, Host checked; unknown tasks and assets are 404", async (t) => {
  const { store } = await frozenRun();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const origin = new URL(dash.url).origin;
  for (const path of ["/", "/state.json", "/stream", "/tasks"]) assert.equal((await get(origin + path)).status, 404, path);
  assert.equal((await get(dash.url, { host: "evil.example" })).status, 421);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await get(dash.url, { method })).status, 405, method);
  for (const path of ["tasks/zz", "tasks/constructor", "tasks/__proto__", "static/nope.js", "static/constructor.js", "nope"]) {
    assert.equal((await get(dash.url + path)).status, 404, path);
  }
  const css = await get(`${dash.url}static/dashboard.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/);
  const js = await get(`${dash.url}static/dashboard.js`);
  assert.match(js.headers["content-type"], /^text\/javascript/);
  assert.match(js.body, /new EventSource\(base\+"stream\?since="\+seq\)/);
  assert.match(js.body, /fetch\(base\+"state\.json"/);
  assert.doesNotMatch(js.body, /innerHTML|eval\(|document\.write/);
});

test("dashboard: state.json is a redacted subset (no diff, no output, no email or secret)", async (t) => {
  const store = await hostileRun();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const r = await get(`${dash.url}state.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^application\/json/);
  assert.ok(!r.body.includes(EMAIL), "email redacted");
  assert.ok(!r.body.includes(GH_TOKEN) && !r.body.includes(KEY), "secrets redacted");
  assert.ok(!r.body.includes("diff --git") && !r.body.includes("FAIL"), "no diff, no command output");
  const s = JSON.parse(r.body);
  assert.equal(s.execution, store.id);
  assert.equal(s.seq, (await store.state()).seq);
  assert.equal(s.status, "running");
  assert.equal(s.percent, 27);
  const a = s.tasks.find((x) => x.id === "a");
  assert.equal(a.state, "submitted");
  assert.match(a.last_note, /halfway <script>alert\(1\)<\/script> mail \[redacted:email\]/);
  assert.match(s.notes.at(-1).text, /ping \[redacted:email\] key \[redacted:[a-z_]+\]/);
  assert.equal(s.escalations.awaiting_human.length, 1);
  assert.equal(s.escalations.awaiting_human[0].class, "money");
  assert.deepEqual(Object.keys(s).sort(), ["budget", "escalations", "execution", "notes", "percent", "runner", "seq", "status", "tasks", "title"]);
  assert.equal(s.runner.status, "unknown");
  for (const k of ["contract", "diffs", "checks", "agents", "leases", "inbox"]) assert.equal(s[k], undefined, k);
});

test("dashboard: the event stream sends a revision when store.transact appends", async (t) => {
  const { store } = await frozenRun();
  const dash = await startDashboard(store.id, { store, pollMs: 50 });
  t.after(() => dash.close());
  const seq = (await store.state()).seq;
  const u = new URL(`${dash.url}stream?since=${seq}`);
  const chunks = [];
  let res;
  const got = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { Host: u.host } }, (r) => {
      res = r;
      assert.equal(r.statusCode, 200);
      assert.match(r.headers["content-type"], /^text\/event-stream/);
      assert.equal(r.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      r.setEncoding("utf8");
      r.on("data", (d) => {
        chunks.push(d);
        if (chunks.join("").includes("event: rev")) resolve(chunks.join(""));
      });
    });
    req.on("error", reject);
    req.end();
  });
  // Nothing is sent for the seq the page already shows.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(chunks.join(""), "retry: 3000\n\n");
  await store.transact(() => ({ events: [{ type: "note.posted", source: src(), payload: { topic: "t", text: "hello", refs: [] } }] }));
  const text = await got;
  assert.match(text, new RegExp(`event: rev\\ndata: \\{"seq":${seq + 1}\\}\\n\\n`));
  res.destroy();
  // An older since gets the current seq at once.
  const late = await new Promise((resolve, reject) => {
    const v = new URL(`${dash.url}stream?since=0`);
    const req = request({ host: "127.0.0.1", port: v.port, path: v.pathname + v.search, headers: { Host: v.host } }, (r) => {
      r.setEncoding("utf8");
      let acc = "";
      r.on("data", (d) => {
        acc += d;
        if (acc.includes("event: rev")) {
          r.destroy();
          resolve(acc);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
  assert.match(late, new RegExp(`data: \\{"seq":${seq + 1}\\}`));
});

test("dashboard: dashboard.json carries the URL while it runs and goes away on close", async () => {
  const { store } = await frozenRun();
  const dash = await startDashboard(store.id);
  const info = JSON.parse(readFileSync(join(store.dir, "dashboard.json"), "utf8"));
  assert.equal(info.url, dash.url);
  assert.equal(info.pid, process.pid);
  await dash.close();
  assert.equal(existsSync(join(store.dir, "dashboard.json")), false);
  await assert.rejects(() => get(dash.url));
  await assert.rejects(startDashboard("exe-0000000000000000"), /not found/);
});

test("dashboard: the DAG SVG lays tasks out in layers, colors them by state and escapes labels", async (t) => {
  const store = await hostileRun();
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const r = await get(`${dash.url}dag.svg`);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^image\/svg\+xml/);
  assert.match(r.body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="dag"/);
  assert.deepEqual(inlineProblems(r.body), []);
  assert.ok(!r.body.includes("<script>") && !/<img\b/.test(r.body));
  assert.ok(r.body.includes("Build &lt;script&gt;"), "escaped title");
  assert.equal((r.body.match(/<g class="node /g) ?? []).length, 3);
  assert.equal((r.body.match(/<path class="edge"/g) ?? []).length, 3, "a→b, a→c, b→c");
  assert.match(r.body, /<g class="node st-submitted">/);
  assert.match(r.body, /<g class="node st-blocked">/);
  assert.match(r.body, /fill="#efe3ff" stroke="#7a4cc2"/, "submitted colors");
  assert.match(r.body, /<a href="\/[A-Za-z0-9_-]{24}\/tasks\/b">/);

  const state = await store.state();
  assert.deepEqual(Object.fromEntries(layers(state.tasks)), { a: 0, b: 1, c: 2 });
  // A cycle (never valid in a contract) is cut instead of looping.
  const cyc = { x: { spec: { id: "x", title: "x", depends_on: ["y"] }, state: "pending" }, y: { spec: { id: "y", title: "y", depends_on: ["x"] }, state: "pending" } };
  assert.equal(layers(cyc).size, 2);
  assert.match(renderDagSvg({ ...state, tasks: {} }), /No tasks yet/);
});

test("dashboard: completion weights and the safe markdown subset", () => {
  const rt = (state, percent, agent) => ({ spec: { id: "t" }, state, attempt: 1, ...(percent !== undefined && { percent }), ...(agent && { agent }) });
  assert.equal(taskWeight(rt("accepted")), 1);
  assert.equal(taskWeight(rt("submitted")), 0.8);
  assert.equal(taskWeight(rt("merging")), 0.8);
  assert.equal(taskWeight(rt("in_progress")), 0.4);
  assert.equal(taskWeight(rt("in_progress", 70)), 0.7);
  assert.equal(taskWeight(rt("claimed", 250)), 1);
  assert.equal(taskWeight(rt("blocked", undefined, "w1")), 0.4);
  assert.equal(taskWeight(rt("blocked")), 0);
  assert.equal(taskWeight(rt("pending")), 0);
  const c = completion({ tasks: { a: rt("accepted"), b: rt("in_progress", 50), c: rt("cancelled"), d: rt("ready") } });
  assert.equal(c.percent, 50);
  assert.equal(c.total, 3);

  const html = markdownToHtml(
    `# Title <b>x</b>\n\nText with **bold**, *it*, \`<code>\` and [link](javascript:alert(1)).\n\n` +
      `- one <script>alert(1)</script>\n- two\n\n> quote ${ATTR}\n\n\`\`\`\n<img src=x onerror=alert(1)>\n\`\`\`\n\n| a | b |\n|---|---|\n| <i>1</i> | 2 |\n\n---\n<div onclick="x">raw</div>`
  );
  assert.deepEqual(inlineProblems(html), []);
  assert.ok(!/<(?:b|i|div|img|script)\b/.test(html), html);
  assert.match(html, /<h2>Title &lt;b&gt;x&lt;\/b&gt;<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <em>it<\/em>, <code>&lt;code&gt;<\/code> and link \(javascript:alert\(1\)\)\./);
  assert.match(html, /<ul><li>one &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre><code>&lt;img src=x onerror=alert\(1\)&gt;<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>&lt;i&gt;1&lt;\/i&gt;<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>&lt;div onclick=&quot;x&quot;&gt;raw&lt;\/div&gt;<\/p>/);

  const cut = capAtLine("line one\nline two with a secret ghp_xxxxxxxxxxxxxxxxxxxxxxxxxx\n", 20);
  assert.deepEqual(cut, { text: "line one", truncated: true });
  assert.deepEqual(capAtLine("short", 20), { text: "short", truncated: false });
});

/** The store, with state() held until `open()` (a slow read in flight while a client goes away) and events() calls recorded. */
function gatedStore(store) {
  let open;
  const gate = new Promise((r) => (open = r));
  const reads = [];
  return {
    open,
    reads,
    store: {
      id: store.id,
      dir: store.dir,
      header: () => store.header(),
      state: async () => {
        await gate;
        return store.state();
      },
      events: (o) => {
        reads.push(o);
        return store.events(o);
      },
      getBlob: (r) => store.getBlob(r),
    },
  };
}

test("dashboard: text is redacted before it is cut, so no half email or key survives a cap", async (t) => {
  const pad = "x".repeat(385);
  const contract = makeContract({ tasks: [taskSpec("a", [], { title: `Ask ${EMAIL} now` })] });
  const { store } = await frozenRun(contract);
  await emit(store, "task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 });
  await emit(store, "task.progress", { task: "a", note: `${pad} ${EMAIL} tail` }, src("w1", "agent"));
  await emit(store, "note.posted", { topic: "t", text: `${pad} ${EMAIL}`, refs: [] }, src("w1", "agent"));
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const prefix = EMAIL.slice(0, 14); // "alice.secret@e"
  for (const path of ["", "tasks", "state.json", "dag.svg", "dag"]) {
    const r = await get(dash.url + path);
    assert.ok(!r.body.includes(prefix), `${path}: a cut email`);
  }
  const s = JSON.parse((await get(`${dash.url}state.json`)).body);
  assert.match(s.tasks[0].last_note, /x \[redacted:e/, "the cap falls inside the redaction mark, not the address");
});

test("dashboard: a stream whose client leaves during a slow read is never registered", async (t) => {
  const { store } = await frozenRun();
  const gated = gatedStore(store);
  const dash = await startDashboard(store.id, { store: gated.store, writeInfo: false });
  t.after(() => dash.close());
  const u = new URL(`${dash.url}stream?since=0`);
  // 40 clients connect and leave while state() is still pending (more than the 32-stream cap).
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { Host: u.host } });
      req.on("error", () => resolve());
      req.on("socket", (sock) => sock.on("connect", () => setTimeout(() => (req.destroy(), resolve()), 5)));
      req.end();
    });
  }
  await new Promise((r) => setTimeout(r, 50));
  gated.open();
  await new Promise((r) => setTimeout(r, 100));
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { Host: u.host } }, (res) => {
      resolve(res.statusCode);
      res.destroy();
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 200, "no slot was leaked by the clients that left");
});

test("dashboard: dag.svg is well-formed XML even with control characters in a title", async (t) => {
  const contract = makeContract({ tasks: [taskSpec("a", [], { title: "form\ffeed\u0000nul\u0007bell\u007fdel\ud800lone" })] });
  const { store } = await frozenRun(contract);
  const dash = await startDashboard(store.id, { store });
  t.after(() => dash.close());
  const svg = (await get(`${dash.url}dag.svg`)).body;
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  assert.match(svg, /formfeednulbelldellone/);
  // The page's inline copy is cleaned the same way.
  assert.doesNotMatch((await get(`${dash.url}dag`)).body, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test("dashboard: an events page with before= reads only its window of the log", async (t) => {
  const { store } = await frozenRun();
  const base = (await store.state()).seq;
  await store.transact(() => ({ events: Array.from({ length: 250 }, (_, i) => ({ type: "note.posted", source: src(), payload: { topic: "t", text: `n${i}`, refs: [] } })) }));
  const gated = gatedStore(store);
  gated.open();
  const dash = await startDashboard(store.id, { store: gated.store, writeInfo: false });
  t.after(() => dash.close());
  const before = base + 200;
  const r = await get(`${dash.url}events?before=${before}`);
  assert.equal(r.status, 200);
  const seqs = [...r.body.matchAll(/<tr><td class="num">(\d+)<\/td>/g)].map((m) => Number(m[1]));
  assert.equal(seqs.length, 100);
  assert.equal(seqs[0], before - 1);
  assert.equal(seqs.at(-1), before - 100);
  assert.ok(r.body.includes(`events?before=${before - 100}">Older</a>`));
  assert.deepEqual(gated.reads.at(-1), { sinceSeq: before - 1 - 101, limit: 101 }, "one window, not the whole log");
});
