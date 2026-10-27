import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ntfySender, webhookSender, desktopSender, configuredSenders } from "../../dist/serve/senders.js";
import { stubDns, stubFetch } from "./helpers.mjs";

beforeEach(t => { stubDns(t); });

const message = { v: 1, kind: "test", execution: "exe", tag: "abcdef", title: "Run abcdef needs a decision", body: "Approve?", seq: 1, at: "2026-01-02T03:04:05Z" };
const topic = "private_topic_0123456789";

test("serve ntfy requires authentication, long private topics and TLS off loopback", async t => {
  assert.throws(() => ntfySender({ url: "https://ntfy.example", topic }), /requires authentication.*expose/);
  for (const bad of ["short", "a".repeat(65), "a/".repeat(16)]) assert.throws(() => ntfySender({ url: "https://ntfy.example", topic: bad, token: "test" }), /topic/);
  for (const url of ["http://ntfy.example", "http://192.168.1.2", "https://user:password@example.com", "file:///tmp/a"]) assert.throws(() => ntfySender({ url, topic, token: "test" }));
  assert.throws(() => ntfySender({ url: "https://ntfy.example", topic, token: "bad\r\nInjected: yes" }), /header/);
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  const sender = ntfySender({ url: "http://127.0.0.1:8080", topic, token: "ntfy-token" });
  assert.deepEqual(await sender.send(message), { ok: true });
  assert.equal(calls[0].init.headers.Authorization, "Bearer ntfy-token");
  assert.equal(calls[0].body.topic, topic);
  assert.equal(calls[0].body.message, message.body);
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].signal instanceof AbortSignal);
  await ntfySender({ url: "https://ntfy.example", topic, user: "me", password: "password" }).send(message);
  assert.equal(calls[1].init.headers.Authorization, `Basic ${Buffer.from("me:password").toString("base64")}`);
});

test("serve webhook signs the exact raw JSON body and includes the timestamp", async t => {
  assert.throws(() => webhookSender("http://public.example", "secret"), /https/);
  assert.throws(() => webhookSender("https://public.example", ""), /secret/);
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  const sender = webhookSender("https://receiver.example/check-in", "test-signing-key");
  assert.equal((await sender.send(message)).ok, true);
  const call = calls[0];
  assert.equal(call.init.body, JSON.stringify(message));
  assert.equal(call.init.headers["X-Roundtable-Signature"], `sha256=${createHmac("sha256", "test-signing-key").update(call.init.body).digest("hex")}`);
  assert.equal(call.init.headers["X-Roundtable-Timestamp"], message.at);
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(call.init.redirect, "manual");
  assert.doesNotThrow(() => webhookSender("http://[::1]:8080/check-in", "key"));
});

test("serve HTTP senders retry only network, 429 and 5xx failures", async t => {
  const statuses = [400, 401, 403, 408, 429, 500, 503, 302];
  const calls = stubFetch(t, (_url, _init, i) => {
    if (i >= statuses.length) throw new Error("network with private details");
    return new Response("", { status: statuses[i], headers: { "Retry-After": "12" } });
  });
  const sender = webhookSender("https://example.com/check-in", "key");
  for (const status of statuses) {
    const result = await sender.send(message);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, status === 429 || status >= 500, String(status));
  }
  const network = await sender.send(message);
  assert.equal(network.retryable, true);
  assert.ok(!network.error.includes("private details"));
  assert.equal(calls.length, 9);
});

test("serve desktop puts hostile text in argv, never in AppleScript source", async () => {
  const m = { ...message, title: '" & do shell script "bad"', body: 'line 1\nline 2 $(bad)' };
  const calls = [], exec = async (file, args) => { calls.push({ file, args }); };
  const mac = desktopSender("darwin", name => `/usr/bin/${name}`, exec);
  assert.equal((await mac.send(m)).ok, true);
  assert.equal(calls[0].file, "/usr/bin/osascript");
  assert.deepEqual(calls[0].args.slice(2), ["--", m.title, m.body]);
  assert.match(calls[0].args[1], /^on run argv/);
  assert.ok(!calls[0].args[1].includes(m.title));
  const linux = desktopSender("linux", name => `/bin/${name}`, exec);
  await linux.send(m);
  assert.deepEqual(calls[1], { file: "/bin/notify-send", args: ["--", m.title, m.body] });
  assert.equal(desktopSender("linux", () => null, exec), null);
  assert.equal(desktopSender("win32", () => null, exec), null);
  assert.equal((await desktopSender("darwin", name => name, async () => { throw new Error("private"); }).send(m)).ok, false);
});

test("serve config isolates sender failures and uses environment authentication", async t => {
  const old = process.env.ROUNDTABLE_NOTIFY_NTFY_TOKEN;
  process.env.ROUNDTABLE_NOTIFY_NTFY_TOKEN = "env-ntfy-key";
  t.after(() => { if (old === undefined) delete process.env.ROUNDTABLE_NOTIFY_NTFY_TOKEN; else process.env.ROUNDTABLE_NOTIFY_NTFY_TOKEN = old; });
  const logs = [];
  const calls = stubFetch(t, () => new Response("", { status: 200 }));
  const senders = await configuredSenders({ ntfy: { url: "https://example.com", topic }, webhook: { url: "https://example.com/hook" } }, m => logs.push(m));
  assert.deepEqual(senders.map(s => s.name), ["ntfy"]);
  assert.equal(logs.length, 1);
  await senders[0].send(message);
  assert.equal(calls[0].init.headers.Authorization, "Bearer env-ntfy-key");
  const noChannels = [];
  assert.deepEqual(await configuredSenders({}, m => noChannels.push(m)), []);
  assert.deepEqual(noChannels, ["no check-in channel configured"]);
});
