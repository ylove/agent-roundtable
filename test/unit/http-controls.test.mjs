// Process HTTP stack, bounded Markdown, private browser handoff and guarded check-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import * as undici from "undici";
import { installHttpStack, bundledUndiciNeedsUpdate } from "../../dist/http/fetch.js";
import { SecureServer, peerConnectionLimit } from "../../dist/http/secure-server.js";
import { browserRedirectHtml, createBrowserRedirect } from "../../dist/http/browser-redirect.js";
import { openInBrowser } from "../../dist/prototypes/board.js";
import { defaultDeps } from "../../dist/previews/manager.js";
import { capMarkdownLine, MARKDOWN_LINE_LIMIT, markdownToHtml } from "../../dist/dashboard/render.js";
import { checkContract } from "../../dist/execution/contract.js";
import { runDoctor, formatDoctor } from "../../dist/cli-up.js";
import { ntfySender, webhookSender } from "../../dist/serve/senders.js";
import { stubDns, stubFetch } from "./helpers.mjs";

installHttpStack();

test("process HTTP globals come from the pinned package and installation preserves later stubs", async t => {
  for (const name of ["fetch", "Headers", "Request", "Response", "FormData"]) assert.equal(globalThis[name], undici[name]);
  const calls = stubFetch(t, () => new Response(null, { status: 204 }));
  installHttpStack();
  assert.equal(await defaultDeps({}).probe("http://127.0.0.1:1234/"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].signal instanceof AbortSignal);
  const form = new FormData();
  form.set("name", "fixture");
  const request = new Request("https://example.test/", { method: "POST", body: form });
  assert.match(request.headers.get("content-type"), /^multipart\/form-data; boundary=/);
});

test("preview probes turn request rejections into an unavailable result", async t => {
  stubFetch(t, () => { throw new TypeError("request ended"); });
  assert.equal(await defaultDeps({}).probe("http://127.0.0.1:1234/"), false);
});

test("bundled undici update notices follow GHSA-xjj6-f33q-929c version boundaries", () => {
  for (const version of ["6.23.0", "6.29.0", "7.18.0", "7.24.4", "7.30.0", "8.0.0", "8.12.1", "7.30.1-rc.1"]) {
    assert.equal(bundledUndiciNeedsUpdate(version), true, version);
  }
  for (const version of [undefined, "unknown", "6.22.0", "6.29.1", "7.17.0", "7.30.1", "7.31.0", "8.12.2", "9.0.0"]) {
    assert.equal(bundledUndiciNeedsUpdate(version), false, String(version));
  }
});

test("doctor's bundled HTTP update notice is informational and scrubbed", async () => {
  const result = await runDoctor({
    nodeVersion: "24.15.0", engines: ">=22", bundledUndiciVersion: "7.24.4\x1b[31m",
    providers: () => ["ollama"], keyNames: {}, findExecutable: () => "/bin/fixture",
    runtimes: [], docker: async () => ({ ok: true }), chrome: () => "/bin/fixture",
  });
  const check = result.checks.find(c => c.id === "bundled-undici");
  assert.equal(check.ok, false);
  assert.equal(check.essential, false);
  assert.equal(result.ok, true);
  assert.match(formatDoctor(result), /pinned npm undici package/);
  assert.match(formatDoctor(result), /GHSA-xjj6-f33q-929c/);
  assert.doesNotMatch(check.detail, /[\r\n]/);
});

test("dashboard headings with 20000 characters render within 100 ms", () => {
  markdownToHtml("# warmup");
  const start = performance.now();
  const html = markdownToHtml("# a" + " ".repeat(20_000) + "x");
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `render took ${elapsed} ms`);
  assert.match(html, /^<h2>a/);
  assert.match(html, /\[truncated\]/);
  assert.ok(html.length < 4100);
});

test("Markdown bounds every line and preserves headings, rules, tables and inline formatting", () => {
  assert.equal(capMarkdownLine("x".repeat(20_000)).length, MARKDOWN_LINE_LIMIT);
  assert.equal(capMarkdownLine("unchanged"), "unchanged");
  assert.equal(markdownToHtml("## Title ###   "), "<h3>Title</h3>");
  assert.equal(markdownToHtml("  * * *  "), "<hr>");
  const html = markdownToHtml("| a | b |\n| :--- | ---: |\n| **bold** | `code` |\n\n[link](https://example.test/) and *em*\n\n```\n" + "x".repeat(5000) + "\n```");
  assert.match(html, /<thead>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /link \(https:\/\/example.test\/\) and <em>em<\/em>/);
  assert.match(html, /\[truncated\]<\/code><\/pre>/);
  for (const line of ["[".repeat(20_000), "| ---" + " ".repeat(20_000) + "x", "***" + " ".repeat(20_000) + "x"]) {
    assert.ok(markdownToHtml(line).length < 5000);
  }
});

const contract = () => ({
  id: "ctr-abc123-1", title: "Fixture", goal: { ultimate: "Ship", original_prompt: "Ship the fixture" },
  scope: { orchestrator: "main", repo_root: "/srv/repo", base_ref: "main", paths: ["src/**"] },
  tasks: [{ id: "a", title: "Build", persona: "dev", paths: { write: ["src/**"] }, acceptance: ["works"] }],
  budget: { usd: 10, per_task_usd: 5, wall_clock_min: 60 },
});

test("contract goals have a 2000 character limit and rendered prose has finite bounds", () => {
  const value = contract();
  assert.equal(checkContract(value).ok, true);
  value.goal.ultimate = "x".repeat(2000);
  assert.equal(checkContract(value).ok, true);
  value.goal.ultimate += "x";
  assert.ok(checkContract(value).errors.includes("goal.ultimate is longer than 2000 characters"));
  value.goal.ultimate = "Ship";
  value.goal.original_prompt = "x".repeat(64_001);
  value.goal.artifacts = [{ kind: "url", ref: "x".repeat(4001) }];
  value.tasks[0].acceptance = ["x".repeat(4001)];
  value.interfaces = [{ name: "API", kind: "type", owner: "a", description: "x".repeat(4001) }];
  value.interfaces[0].path = "x".repeat(4001);
  value.tasks[0].verify = [{ page_loads: { path: "x".repeat(4001) } }];
  value.validation = { commands: [{ id: "test", argv: ["npm", "test"], cwd: "x".repeat(4001), env: { ["X".repeat(4001)]: "fixture" } }] };
  value.decisions = [{ id: "d1", text: "x".repeat(4001), rationale: "x".repeat(4001) }];
  for (const field of ["goal.original_prompt", "goal.artifacts[0].ref", "tasks[0].acceptance[0]", "tasks[0].verify[0].page_loads.path", "interfaces[0].description", "interfaces[0].path", "decisions[0].text", "decisions[0].rationale", "validation.commands[0].cwd"]) {
    assert.ok(checkContract(value).errors.some(e => e.startsWith(field + " is longer than")), field);
  }
  assert.ok(checkContract(value).errors.some(e => /^validation.commands\[0\]\.env name .* is longer than 4000 characters$/.test(e)));
});

test("local browser handoff uses private permissions and expires", async t => {
  const url = "http://127.0.0.1:1234/abcdefghijklmnopqrstuvwx/";
  const file = createBrowserRedirect(url, 25);
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.match(readFileSync(file, "utf8"), /content="0;url=http:\/\/127\.0\.0\.1/);
  assert.match(browserRedirectHtml('a"<&'), /a&quot;&lt;&amp;/);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(existsSync(file), false);
});

test("browser opener argv carries a file path with no capability token", t => {
  const calls = [];
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(childProcess, "spawn", (file, args, opts) => {
    calls.push({ file, args, opts });
    return Object.assign(new EventEmitter(), { unref() {} });
  });
  syncBuiltinESMExports();
  const token = "abcdefghijklmnopqrstuvwx";
  openInBrowser(`http://127.0.0.1:1234/${token}/`);
  assert.equal(calls.length, 2);
  const call = calls.find(c => c.file !== process.execPath);
  for (const call of calls) assert.ok(!JSON.stringify(call.args).includes(token));
  const file = call.args.at(-1).replace(/^"|"$/g, "");
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
  assert.ok(isAbsolute(file));
  assert.match(readFileSync(file, "utf8"), new RegExp(token));
  assert.equal(call.opts.detached, true);
  openInBrowser("https://example.test/");
  assert.equal(calls.length, 2);
});

test("browser handoff cleanup continues after its creating CLI exits", { timeout: 5000 }, async t => {
  const module = new URL("../../dist/http/browser-redirect.js", import.meta.url).href;
  const code = `import { createBrowserRedirect } from ${JSON.stringify(module)}; console.log(createBrowserRedirect("http://127.0.0.1:1234/abcdefghijklmnopqrstuvwx/", 50));`;
  const { stdout } = await promisify(childProcess.execFile)(process.execPath, ["--input-type=module", "--eval", code], {
    env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, timeout: 2000,
  });
  const file = stdout.trim();
  assert.ok(isAbsolute(file));
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(existsSync(file), false);
});

test("tailnet peers share connection slots while loopback uses the total limit", () => {
  assert.equal(peerConnectionLimit("127.0.0.1", 128), 128);
  assert.equal(peerConnectionLimit("::1", 128), 128);
  assert.equal(peerConnectionLimit("100.64.0.1", 128), 16);
  assert.equal(peerConnectionLimit("fd7a:115c:a1e0::1", 8), 2);
});

test("local server deadlines, per-peer admission and slot release apply before HTTP bytes", async t => {
  const servers = [];
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(http, "createServer", () => {
    const server = Object.assign(new EventEmitter(), {
      listen(_port, _address, ready) { ready(); }, address: () => ({ port: 1234 }), unref() {},
      close(done) { done?.(); }, closeAllConnections() {},
    });
    servers.push(server);
    return server;
  });
  t.mock.method(os, "networkInterfaces", () => ({ tailnet: [{ address: "100.64.0.1" }] }));
  syncBuiltinESMExports();
  const local = await SecureServer.start({ name: "Fixture", routes: [] });
  assert.equal(servers[0].maxConnections, 128);
  assert.equal(servers[0].requestTimeout, 30_000);
  assert.equal(servers[0].headersTimeout, 15_000);
  assert.equal(servers[0].keepAliveTimeout, 5000);
  await local.close();
  const tailnet = await SecureServer.start({ name: "Fixture", routes: [], bindAddress: "100.64.0.1", idleTimeoutMs: 30 });
  t.after(() => tailnet.close());
  const connect = address => {
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: address, destroyed: false,
      destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } },
    });
    sockets.push(socket);
    servers[1].emit("connection", socket);
    return socket;
  };
  const held = Array.from({ length: 16 }, () => connect("100.64.0.2"));
  assert.ok(held.every(s => !s.destroyed));
  assert.equal(connect("100.64.0.2").destroyed, true);
  const other = connect("100.64.0.3");
  assert.equal(other.destroyed, false);
  other.emit("data", Buffer.from("GET / HTTP/1.1\r\n"));
  held[0].destroy();
  assert.equal(connect("100.64.0.2").destroyed, false);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.ok(held.every(s => s.destroyed));
  assert.equal(other.destroyed, false, "HTTP requests use their own deadlines after the first byte");
  assert.equal(connect("100.64.0.2").destroyed, false);
});

const message = { v: 1, kind: "test", execution: "exe", tag: "abcdef", title: "Update", body: "Ready", seq: 1, at: "2026-01-02T03:04:05Z" };

test("both HTTP check-in senders pin DNS, use manual redirects and close their dispatcher", async t => {
  const asked = stubDns(t, { "receiver.example.test": ["192.168.1.2"], "ntfy.example.test": ["203.0.113.10"] });
  const dispatchers = [];
  const calls = stubFetch(t, (_url, init) => {
    assert.ok(init.dispatcher instanceof undici.Agent);
    dispatchers.push(init.dispatcher);
    return new Response(null, { status: 302, headers: { location: "https://other.example.test/" } });
  });
  const senders = [webhookSender("https://receiver.example.test/check-in", "fixture-key"), ntfySender({ url: "https://ntfy.example.test", topic: "private_topic_0123456789", token: "fixture-token" })];
  for (const sender of senders) assert.deepEqual(await sender.send(message), { ok: false, retryable: false, error: "HTTP 302" });
  assert.deepEqual(asked, ["receiver.example.test", "ntfy.example.test"]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.redirect, "manual");
  for (const dispatcher of dispatchers) assert.equal(dispatcher.closed, true);
});

test("check-in URL policy refuses metadata answers before fetch and keeps endpoint paths private", async t => {
  stubDns(t, { "receiver.example.test": ["203.0.113.10", "169.254.169.254"] });
  const calls = stubFetch(t, () => { throw new Error("fetch must not run"); });
  const result = await webhookSender("https://receiver.example.test/private-path?token=fixture", "fixture-key").send(message);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error, /metadata/);
  assert.doesNotMatch(result.error, /private-path|token=fixture/);
  assert.equal(calls.length, 0);
});

test("check-in temporary DNS and request errors remain retryable and dispatchers close", async t => {
  stubDns(t, { "dns.example.test": new Error("temporary DNS detail") });
  let dispatcher;
  const calls = stubFetch(t, (_url, init) => {
    dispatcher = init.dispatcher;
    throw new Error("private request detail");
  });
  const dnsResult = await webhookSender("https://dns.example.test/check-in", "fixture-key").send(message);
  assert.equal(dnsResult.ok, false);
  assert.equal(dnsResult.retryable, true);
  assert.equal(calls.length, 0);
  const requestResult = await webhookSender("https://request.example.test/check-in", "fixture-key").send(message);
  assert.deepEqual(requestResult, { ok: false, retryable: true, error: "check-in network error" });
  assert.equal(dispatcher.closed, true);
});
