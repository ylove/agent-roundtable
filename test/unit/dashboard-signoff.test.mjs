// Dashboard lesson review and sign-off use the CLI's effects and audit, behind local HTTP guards.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { makeRun, runner } from "../fixtures/workers/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const { startDashboard, ACTION_HEADER, DASHBOARD_CSP, SIGNOFFS_PER_MINUTE, MAX_SIGNOFF_BODY_BYTES } = await import("../../dist/dashboard/server.js");
const { SecureServer } = await import("../../dist/http/secure-server.js");
const { concludePostmortem } = await import("../../dist/postmortem/meeting.js");
const { setEnabled } = await import("../../dist/postmortem/project.js");
const { loadRecord, saveRecord, pendingPostmortems, recordPath, lessonsPath, loadLessons, projectKeyOf } = await import("../../dist/postmortem/store.js");
const { renderRecord } = await import("../../dist/postmortem/record.js");
const { parseArtifactBlock } = await import("../../dist/postmortem/artifacts.js");
const { renderPostmortems } = await import("../../dist/dashboard/render.js");
const { newId } = await import("../../dist/ids.js");
const { AUDIT_DIR } = await import("../../dist/config.js");
const { DASHBOARD_JS } = await import("../../dist/dashboard/assets.js");

let oldMode;
beforeEach(() => { oldMode = process.env.ROUNDTABLE_LESSON_SIGNOFF; delete process.env.ROUNDTABLE_LESSON_SIGNOFF; });
afterEach(() => {
  if (oldMode === undefined) delete process.env.ROUNDTABLE_LESSON_SIGNOFF;
  else process.env.ROUNDTABLE_LESSON_SIGNOFF = oldMode;
});

function send(url, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(url);
  headers = Object.fromEntries(Object.entries({ Host: u.host, Connection: "close", ...headers }).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const metaNonce = html => /<meta name="roundtable-action" content="([A-Za-z0-9_-]{24})">/.exec(html)?.[1];
const auditFor = pm => readdirSync(AUDIT_DIR).flatMap(n => readFileSync(join(AUDIT_DIR, n), "utf8").split("\n").filter(Boolean).map(JSON.parse))
  .filter(e => e.action === "postmortem.applied" && e.target === pm);

async function concluded() {
  const repo = await makeRun({ contract: { postmortem: { enabled: true } } });
  const project = projectKeyOf(repo.root);
  await setEnabled({ key: project, root: repo.root }, true, "Review lessons");
  const pm = newId("pm"), finding = "pmf-00000001";
  const { artifacts } = parseArtifactBlock([
    "Artifact: rule | project | pmf-00000001 | Check <script>alert(1)</script> for private@example.com",
    "Artifact: contract_rule | project | pmf-00000001 | Review the acceptance checks",
    "Artifact: agent_rule | builder | pmf-00000001 | Check retries",
  ].join("\n"), ["builder"], new Set([finding]));
  const rec = {
    v: 1, pm, project, scope: { execution_id: repo.store.id }, status: "held",
    created: new Date().toISOString(), held_at: new Date().toISOString(), format: "collaborate", rounds: 1,
    seats: ["orchestrator", "builder"], session: "review", opening: "Review the work",
    findings: [{ id: finding, summary: "Clarify checks", detected_by: "review", responsible: ["builder"], category: "implementation", at: new Date().toISOString() }],
    transcript: [], proposed: artifacts, rejected_lines: [],
  };
  saveRecord(rec, renderRecord(rec));
  await repo.store.transact(() => ({ events: [{ type: "postmortem.started", source: runner, payload: { id: pm, format: rec.format, seats: rec.seats } }] }));
  await concludePostmortem({ pm, closing: "Ready for human review", accept: artifacts.map(a => a.id) });
  return { repo, store: repo.store, project, pm };
}

async function armed(t) {
  const f = await concluded();
  const dash = await startDashboard(f.store.id, { store: f.store, writeInfo: false });
  t.after(() => dash.close());
  const nonce = metaNonce((await send(dash.url + "postmortems")).body);
  assert.ok(nonce);
  const post = (options = {}) => {
    const body = options.body ?? JSON.stringify(options.input ?? { by: "main", accept: ["a1"] });
    return send(`${dash.url}postmortems/${options.pm ?? f.pm}/signoff`, { method: "POST", body,
      headers: { [ACTION_HEADER]: nonce, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...options.headers } });
  };
  return { ...f, dash, nonce, post };
}

async function snapshot(f) {
  return {
    json: readFileSync(recordPath(f.project, f.pm), "utf8"), md: readFileSync(recordPath(f.project, f.pm, "md"), "utf8"),
    lessons: existsSync(lessonsPath(f.project)) ? readFileSync(lessonsPath(f.project), "utf8") : null,
    audit: auditFor(f.pm), events: await f.store.events(),
  };
}

// Invalid transport/body requests must not even open the blackboard or postmortem store.
async function beforeState(t, f, action) {
  const state = t.mock.method(f.store, "state");
  const reads = t.mock.method(fs, "readFileSync");
  const lists = t.mock.method(fs, "readdirSync");
  syncBuiltinESMExports();
  try {
    const r = await action();
    assert.equal(state.mock.callCount(), 0, "no blackboard read");
    assert.equal(reads.mock.callCount(), 0, "no postmortem file read");
    assert.equal(lists.mock.callCount(), 0, "no postmortem search");
    return r;
  } finally {
    state.mock.restore(); reads.mock.restore(); lists.mock.restore(); syncBuiltinESMExports();
  }
}

test("signoff: selected ids apply with the CLI's audit fields, and replay does not reapply", async t => {
  const f = await armed(t);
  const r = await f.post({ headers: { Origin: new URL(f.dash.url).origin, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), { applied: ["a1"], already_signed_off: [], errors: [] });
  assert.deepEqual(loadRecord(f.project, f.pm).pending, ["a2", "a3"]);
  const again = await f.post({ input: { by: " main ", accept: ["a1", "a2"] } });
  assert.deepEqual(JSON.parse(again.body), { applied: ["a2"], already_signed_off: ["a1"], errors: [] });
  assert.equal(auditFor(f.pm).filter(a => a.details.artifact === "a1").length, 1);

  const cli = JSON.parse(execFileSync(process.execPath, [new URL("../../dist/index.js", import.meta.url).pathname,
    "postmortem", "signoff", f.pm, "--by", "main", "a3", "--json"],
  { encoding: "utf8", env: { ...process.env, ROUNDTABLE_DOTENV: "off" } }));
  assert.deepEqual(cli.pending, []);
  const audits = auditFor(f.pm), fromCli = audits.find(a => a.details.artifact === "a3");
  const record = loadRecord(f.project, f.pm);
  for (const a of audits) {
    const done = record.applied.find(x => x.id === a.details.artifact);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(fromCli).sort());
    assert.deepEqual(Object.keys(a.details).sort(), Object.keys(fromCli.details).sort());
    assert.deepEqual(Object.keys(done.signoff).sort(), ["at", "by"]);
    assert.equal(a.details.signed_off_by, "main");
    assert.equal(a.details.signed_off_at, done.signoff.at);
    assert.ok(Number.isFinite(Date.parse(done.signoff.at)));
    assert.equal(a.details.hash, done.hash);
    assert.equal(done.hash, record.proposed.find(x => x.id === done.id).hash);
  }
  assert.equal(loadLessons(f.project).length, 3);
  assert.equal((await f.store.verify()).ok, true);
  assert.doesNotMatch((await send(f.dash.url + "postmortems")).body, /data-signoff="/);
});

for (const [name, options, status] of [
  ["missing nonce", { headers: { [ACTION_HEADER]: undefined } }, 403],
  ["wrong nonce", { headers: { [ACTION_HEADER]: "wrong-nonce" } }, 403],
  ["cross-origin Origin", { headers: { Origin: "https://evil.example" } }, 403],
  ["cross-site Sec-Fetch-Site", { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
  ["wrong content type", { headers: { "Content-Type": "text/plain" } }, 415],
  ["declared body too large", { headers: { "Content-Length": String(MAX_SIGNOFF_BODY_BYTES + 1) } }, 413],
  ["streamed body too large", { body: " ".repeat(MAX_SIGNOFF_BODY_BYTES + 1), headers: { "Content-Length": undefined, "Transfer-Encoding": "chunked" } }, 413],
  ["malformed JSON", { body: "{DO_NOT_ECHO" }, 400],
  ["extra fields", { input: { by: "main", accept: ["a1"], extra: "DO_NOT_ECHO" } }, 400],
  ["bad by", { input: { by: " ", accept: ["a1"] } }, 400],
  ["bad artifact id", { input: { by: "main", accept: ["a1", "<script>DO_NOT_ECHO</script>"] } }, 400],
  ["too many ids", { input: { by: "main", accept: Array(21).fill("a1") } }, 400],
]) {
  test(`signoff refuses ${name} before state access, with no state change`, async t => {
    const f = await armed(t), before = await snapshot(f);
    const r = await beforeState(t, f, () => f.post(options));
    assert.equal(r.status, status, r.body);
    assert.deepEqual(JSON.parse(r.body).applied, []);
    assert.ok(JSON.parse(r.body).errors.length);
    assert.doesNotMatch(r.body, /DO_NOT_ECHO|<script>/);
    assert.deepEqual(await snapshot(f), before);
  });
}

test("signoff rejects invalid JSON shapes, identities and id lists before state access", async t => {
  const f = await armed(t), before = await snapshot(f);
  for (const input of [null, [], { by: "main" }, { by: 7, accept: ["a1"] }, { by: "x".repeat(201), accept: ["a1"] },
    { by: "main", accept: [] }, { by: "main", accept: [1] }, { by: "main", accept: ["a01"] }, { by: "main", accept: ["a0"] }]) {
    assert.equal((await beforeState(t, f, () => f.post({ body: JSON.stringify(input) }))).status, 400);
  }
  assert.deepEqual(await snapshot(f), before);
});

test("signoff refuses a pm from another run, without changing either run", async t => {
  const f = await armed(t), other = await concluded(), before = await snapshot(f), beforeOther = await snapshot(other);
  const r = await f.post({ pm: other.pm });
  assert.equal(r.status, 404);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(await snapshot(other), beforeOther);
});

test("signoff preserves the CLI's frozen-contract identity and unknown-id refusals", async t => {
  const f = await armed(t), before = await snapshot(f);
  for (const input of [{ by: "DO_NOT_ECHO_SIGNER", accept: ["a1"] }, { by: "main", accept: ["a1", "a99"] }]) {
    const r = await f.post({ input });
    assert.equal(r.status, 409);
    assert.doesNotMatch(r.body, /DO_NOT_ECHO_SIGNER/);
    assert.deepEqual(await snapshot(f), before);
  }
});

// Exercise bind/peer checks without requiring a tailnet interface on the test machine.
async function simulated(t, origin, peer) {
  const f = await concluded();
  let routes;
  t.mock.method(SecureServer, "start", async opts => {
    routes = opts.routes;
    return { origin, url: origin + "/test/", base: "/test/", close: async () => {} };
  });
  const dash = await startDashboard(f.store.id, { store: f.store, writeInfo: false });
  t.after(() => dash.close());
  let html;
  await routes.find(r => r.path === "/postmortems").handler({ html: (_s, body) => { html = body; } });
  const nonce = metaNonce(html), path = `/postmortems/${f.pm}/signoff`;
  const route = routes.find(r => r.path instanceof RegExp && r.path.test(path));
  const post = async (headers = {}) => {
    const body = JSON.stringify({ by: "main", accept: ["a1"] });
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      headers: { [ACTION_HEADER]: nonce, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers },
      socket: { remoteAddress: peer },
    });
    let response;
    await route.handler({ req, match: route.path.exec(path), json: (status, body) => { response = { status, body }; } });
    return response;
  };
  return { ...f, post };
}

test("signoff refuses a tailnet bind even for a loopback peer, with no state access or changes", async t => {
  const f = await simulated(t, "http://100.64.0.1:1234", "127.0.0.1"), before = await snapshot(f);
  const r = await beforeState(t, f, () => f.post());
  assert.equal(r.status, 403);
  assert.match(r.body.errors[0], /tailnet.*Use the CLI/);
  const missing = await beforeState(t, f, () => f.post({ [ACTION_HEADER]: undefined }));
  assert.equal(missing.status, 403);
  assert.match(missing.body.errors[0], /tailnet.*Use the CLI/);
  assert.deepEqual(await snapshot(f), before);
});

test("signoff refuses a non-loopback peer before state access", async t => {
  const f = await simulated(t, "http://127.0.0.1:1234", "100.64.0.2"), before = await snapshot(f);
  assert.equal((await beforeState(t, f, () => f.post())).status, 403);
  assert.deepEqual(await snapshot(f), before);
});

test("signoff accepts the IPv6 loopback bind and peer", async t => {
  const f = await simulated(t, "http://[::1]:1234", "::1");
  assert.deepEqual((await f.post()).body, { applied: ["a1"], already_signed_off: [], errors: [] });
});

test("signoff works in human mode", async t => {
  process.env.ROUNDTABLE_LESSON_SIGNOFF = "human";
  const f = await armed(t);
  assert.equal(pendingPostmortems(f.project).length, 3);
  assert.equal((await f.post()).status, 200);
  assert.equal(loadLessons(f.project)[0].signoff.by, "main");
});

test("signoff rate limit bounds admitted bodies before state access", async t => {
  const f = await armed(t), before = await snapshot(f);
  assert.equal((await f.post({ headers: { [ACTION_HEADER]: "wrong" } })).status, 403);
  for (let i = 0; i < SIGNOFFS_PER_MINUTE; i++) assert.equal((await f.post({ body: "{" })).status, 400);
  const r = await beforeState(t, f, () => f.post());
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers["retry-after"]) > 0);
  assert.deepEqual(await snapshot(f), before);
});

test("signoff keeps the token, Host, method, pm pattern and preflight defenses", async t => {
  const f = await armed(t), before = await snapshot(f), url = `${f.dash.url}postmortems/${f.pm}/signoff`;
  for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
    const r = await send(url, { method, headers: { Origin: "https://evil.example", "Access-Control-Request-Headers": "X-Roundtable-Action" } });
    assert.equal(r.status, 405);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["access-control-allow-headers"], undefined);
  }
  assert.equal((await f.post({ headers: { Host: "evil.example" } })).status, 421);
  assert.equal((await send(url.replace(new URL(f.dash.url).pathname, "/wrong-token/"), { method: "POST" })).status, 404);
  for (const pm of ["pm-invalid", "pm-0000000i", "pm-00000001%0A", "constructor"]) assert.equal((await f.post({ pm })).status, 404);
  assert.deepEqual(await snapshot(f), before);
});

test("Postmortems lists pending text, ids, kinds, targets and hashes, with unchecked boxes and its own nonce", async t => {
  const f = await armed(t), page = await send(f.dash.url + "postmortems");
  assert.equal(page.headers["content-security-policy"], DASHBOARD_CSP);
  assert.deepEqual(inlineProblems(page.body), []);
  for (const a of pendingPostmortems(f.project)) {
    assert.ok(page.body.includes(a.id)); assert.ok(page.body.includes(a.kind)); assert.ok(page.body.includes(a.target)); assert.ok(page.body.includes(a.hash));
    assert.ok(page.body.includes(`type="checkbox" name="accept" value="${a.id}"`));
  }
  assert.doesNotMatch(page.body, /\bchecked\b|private@example.com|<script>alert/);
  assert.match(page.body, /Check &lt;script&gt;alert\(1\)&lt;\/script&gt; for \[redacted:email\]/);
  assert.match(page.body, /name="by" required/);
  assert.match(page.body, /type="submit"/);
  for (const path of ["", "usage", "tasks", "contract", "events", "dissents", "escalations", "dag", "static/dashboard.js", "static/dashboard.css"]) {
    const other = await send(f.dash.url + path);
    assert.ok(!other.body.includes(f.nonce), path);
    if (path === "usage") assert.ok(metaNonce(other.body));
    else if (!path.startsWith("static/")) assert.equal(metaNonce(other.body), undefined);
  }
  const pending = pendingPostmortems(f.project);
  const context = { state: await f.store.state(), header: f.store.header(), base: "/test/", runner: { status: "unknown", detail: "" } };
  const hostile = `<img src=x onerror=alert(1)> private@example.com`;
  const html = renderPostmortems(context, { [f.pm]: { markdown: "Review", pending: pending.map(a => ({ ...a, id: hostile, kind: hostile, target: hostile, text: hostile, hash: hostile })) } });
  assert.doesNotMatch(html, /<img|private@example.com/);
  assert.match(html, /&lt;img/);
  assert.deepEqual(inlineProblems(html), []);
});

test("the signoff nonce never appears in state JSON, SSE or logs", async t => {
  const f = await armed(t), logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  await f.post();
  await f.post({ input: { by: "DO_NOT_LOG_SIGNER", accept: ["a2"] } });
  const state = await send(f.dash.url + "state.json");
  assert.ok(!state.body.includes(f.nonce));
  const stream = await new Promise((resolve, reject) => {
    const u = new URL(f.dash.url + "stream?since=0");
    const req = request(u, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", data => { text += data; if (text.includes("event: rev")) { res.destroy(); resolve(text); } });
    });
    req.setTimeout(3000, () => req.destroy(new Error("SSE timed out")));
    req.on("error", reject); req.end();
  });
  assert.ok(!stream.includes(f.nonce));
  const token = new URL(f.dash.url).pathname.split("/")[1];
  for (const secret of [f.nonce, token, "DO_NOT_LOG_SIGNER"]) assert.ok(logs.every(l => !l.includes(secret)));
});

test("the page script submits only selected ids, shows the JSON result safely, then reloads Postmortems", async () => {
  let submit, sent, navigation;
  const timers = [], result = { textContent: "" }, button = { disabled: false };
  const form = {
    matches: selector => selector === "[data-signoff]", getAttribute: () => "pm-00000001",
    querySelector: selector => selector === "[data-signoff-result]" ? result : selector === 'button[type="submit"]' ? button : { value: "main" },
    querySelectorAll: () => [{ value: "a1" }, { value: "a3" }],
  };
  const document = {
    body: { getAttribute: key => ({ "data-base": "/token/", "data-seq": "1", "data-live": "reload" })[key] },
    querySelectorAll: () => [], getElementById: () => null,
    querySelector: () => ({ getAttribute: () => "page-nonce" }),
    addEventListener: (name, handler) => { if (name === "submit") submit = handler; },
  };
  runInNewContext(DASHBOARD_JS, { document, window: {}, location: { assign: path => { navigation = path; } },
    setTimeout: fn => timers.push(fn), setInterval: () => 1,
    fetch: async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({ applied: ["a1", "a3"], already_signed_off: [], errors: ["<img src=x>"] }) }; },
  });
  submit({ target: form, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.url, "/token/postmortems/pm-00000001/signoff");
  assert.equal(sent.options.headers["X-Roundtable-Action"], "page-nonce");
  assert.equal(sent.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(sent.options.body), { by: "main", accept: ["a1", "a3"] });
  assert.match(result.textContent, /Applied: a1, a3/);
  assert.match(result.textContent, /<img src=x>/, "result is assigned as text");
  assert.equal(navigation, undefined, "result is shown before navigation");
  timers[0]();
  assert.equal(navigation, "/token/postmortems");
});
