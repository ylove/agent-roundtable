// The outbound URL guard (SSRF), the per-call base_url key binding, manual redirects and the webhook guard.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { json, stubDns, stubFetch } from "./helpers.mjs";

delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
delete process.env.ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS;
delete process.env.ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS;

const { classifyAddress, checkUrl, guardUrl, describeUrl, UrlGuardError } = await import("../../dist/security/url-guard.js");
const { callOpenAICompatible } = await import("../../dist/providers/openai-compatible.js");
const { WebhookPublisher } = await import("../../dist/publishers/webhook.js");

/** Set env vars for one test. */
function env(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const ok = (content = "hi") => json(200, { choices: [{ message: { content }, finish_reason: "stop" }] });
const messages = [{ role: "user", content: "hi" }];
const opts = (extra = {}) => ({ model: "m", maxTokens: 8, signal: new AbortController().signal, ...extra });

describe("classifyAddress", () => {
  test("IPv4 ranges", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "100.100.100.200"]) assert.equal(classifyAddress(ip), "metadata", ip);
    for (const ip of ["127.0.0.1", "127.255.255.254"]) assert.equal(classifyAddress(ip), "loopback", ip);
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      assert.equal(classifyAddress(ip), "private", ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.10", "1.1.1.1"]) assert.equal(classifyAddress(ip), "public", ip);
  });

  test("IPv6 ranges, including IPv4 embedded in mapped, NAT64 and 6to4 addresses", () => {
    assert.equal(classifyAddress("::1"), "loopback");
    assert.equal(classifyAddress("fd00:ec2::254"), "metadata");
    assert.equal(classifyAddress("fd00:0ec2:0:0:0:0:0:254"), "metadata");
    assert.equal(classifyAddress("::ffff:169.254.169.254"), "metadata");
    assert.equal(classifyAddress("::ffff:a9fe:a9fe"), "metadata");
    assert.equal(classifyAddress("64:ff9b::a9fe:a9fe"), "metadata");
    assert.equal(classifyAddress("2002:a9fe:a9fe::1"), "metadata");
    assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
    assert.equal(classifyAddress("::ffff:10.0.0.1"), "private");
    for (const ip of ["::", "fd12:3456::1", "fc00::1", "fe80::1", "fe80::1%en0", "ff02::1", "2002:0a00:0001::1"]) {
      assert.equal(classifyAddress(ip), "private", ip);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:db8::1", "::ffff:8.8.8.8"]) assert.equal(classifyAddress(ip), "public", ip);
  });

  test("translated, compatible and local-use NAT64 addresses: never this host's loopback", () => {
    // IPv4-translated ::ffff:0:a.b.c.d (SIIT), IPv4-compatible ::a.b.c.d.
    assert.equal(classifyAddress("::ffff:0:a9fe:a9fe"), "metadata");
    assert.equal(classifyAddress("::ffff:0:169.254.169.254"), "metadata");
    assert.equal(classifyAddress("::ffff:0:a00:1"), "private");
    assert.equal(classifyAddress("::ffff:0:808:808"), "public");
    assert.equal(classifyAddress("::ffff:0:7f00:1"), "private");
    assert.equal(classifyAddress("::a9fe:a9fe"), "metadata");
    assert.equal(classifyAddress("::127.0.0.1"), "private");
    // NAT64: well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48 (never public).
    assert.equal(classifyAddress("64:ff9b::7f00:1"), "private", "loopback behind a translator is not ours");
    assert.equal(classifyAddress("64:ff9b::808:808"), "public");
    assert.equal(classifyAddress("64:ff9b:1::808:808"), "private");
    assert.equal(classifyAddress("64:ff9b:1::a9fe:a9fe"), "metadata");
    assert.equal(classifyAddress("2002:7f00:1::1"), "private");
  });
});

describe("checkUrl / guardUrl", () => {
  test("https anywhere public; http only to loopback (literal or resolved); no other schemes", async (t) => {
    stubDns(t, { "llm.localhost": ["127.0.0.1"], "api.example.test": ["203.0.113.10"] });
    assert.equal((await guardUrl("https://api.example.test/v1")).host, "api.example.test");
    for (const u of ["http://localhost:1234/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1", "https://localhost/v1"]) {
      assert.ok(await guardUrl(u), u);
    }
    for (const u of ["http://8.8.8.8/v1", "http://[2606:4700:4700::1111]/v1", "ftp://example.test/", "file:///etc/passwd"]) {
      assert.throws(() => checkUrl(u, { label: "base_url" }), /base_url must use https/, u);
    }
    await assert.rejects(guardUrl("http://api.example.test/v1", { label: "base_url" }), /base_url must use https \(http is allowed only to loopback\)/);
    // *.localhost is resolved like any other name (only the literal "localhost" is trusted as is).
    assert.ok(await guardUrl("http://llm.localhost/v1"));
    t.mock.restoreAll();
    stubDns(t, { "llm.localhost": ["203.0.113.7"] });
    await assert.rejects(guardUrl("http://llm.localhost/v1"), /must use https/);
    assert.throws(() => checkUrl("not a url", { label: "base_url" }), /base_url is not a valid URL/);
  });

  test("with private targets allowed, plain http reaches private and LAN addresses too (never metadata)", async (t) => {
    stubDns(t, { "receiver.lan": ["192.168.1.10"], "lmstudio.lan": ["fd12::7"], "public.example.test": ["203.0.113.10"], "imds.lan": ["169.254.169.254"] });
    for (const u of ["http://192.168.1.10:8080/hook", "http://10.0.0.5:8000/v1", "http://[fd12::7]:1234/v1", "http://receiver.lan/hook", "http://lmstudio.lan:1234/v1"]) {
      await assert.rejects(guardUrl(u, { label: "base_url" }), /private, link-local or reserved/, u);
      assert.ok(await guardUrl(u, { allowPrivate: true }), u);
    }
    await assert.rejects(guardUrl("http://public.example.test/", { allowPrivate: true }), /http is allowed only to loopback and private addresses/);
    assert.throws(() => checkUrl("http://169.254.169.254/latest", { allowPrivate: true }), /cloud metadata/);
    await assert.rejects(guardUrl("http://imds.lan/", { allowPrivate: true }), /cloud metadata/);
  });

  test("userinfo is refused and never echoed", () => {
    assert.throws(
      () => checkUrl("https://user:hunter2@api.example.test/v1", { label: "base_url" }),
      (e) => e instanceof UrlGuardError && /must not contain credentials/.test(e.message) && !e.message.includes("hunter2")
    );
  });

  test("metadata is always blocked, even with private networks allowed", async (t) => {
    env(t, { ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS: "1" });
    for (const u of ["https://169.254.169.254/latest", "https://[fd00:ec2::254]/", "https://100.100.100.200/", "https://metadata.google.internal/", "https://metadata/", "https://METADATA.google.internal./x", "https://[::ffff:169.254.169.254]/"]) {
      assert.throws(() => checkUrl(u), /cloud metadata address/, u);
    }
    stubDns(t, { "imds.example.test": ["169.254.169.254"] });
    await assert.rejects(guardUrl("https://imds.example.test/"), /imds\.example\.test \(169\.254\.169\.254\) is a cloud metadata address/);
  });

  test("private, CGNAT, link-local and ULA need ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1", async (t) => {
    stubDns(t, { "lan.example.test": ["203.0.113.9", "192.168.1.20"], "ula.example.test": ["fd12::5"] });
    for (const u of ["https://10.0.0.5/", "https://100.64.1.1/", "https://[fe80::1]/", "https://[fd12::5]/"]) {
      assert.throws(() => checkUrl(u, { label: "base_url" }), /private, link-local or reserved.*ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1/, u);
    }
    // Every resolved address is checked, not just the first.
    await assert.rejects(guardUrl("https://lan.example.test/"), /lan\.example\.test \(192\.168\.1\.20\)/);
    await assert.rejects(guardUrl("https://ula.example.test/"), /private/);
    assert.ok(await guardUrl("https://lan.example.test/", { allowPrivate: true }));
    env(t, { ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS: "1" });
    assert.ok(checkUrl("https://10.0.0.5/"));
    assert.ok(await guardUrl("https://ula.example.test/"));
  });

  test("loopback is always allowed; the literal localhost and IP literals never reach DNS", async (t) => {
    const asked = stubDns(t, { "loop.example.test": ["127.0.0.1", "::1"], "a.localhost": ["127.0.0.1"] });
    assert.ok(await guardUrl("http://localhost:1234/v1"));
    assert.ok(await guardUrl("http://LOCALHOST.:1234/v1"));
    assert.ok(await guardUrl("http://127.0.0.1:1234/v1"));
    assert.ok(await guardUrl("https://8.8.8.8/v1"));
    assert.deepEqual(asked, []);
    assert.ok(await guardUrl("https://loop.example.test/v1"));
    assert.ok(await guardUrl("http://loop.example.test/v1"), "http to a name that resolves only to loopback");
    assert.ok(await guardUrl("http://a.localhost/v1"));
    assert.deepEqual(asked, ["loop.example.test", "loop.example.test", "a.localhost"]);
  });

  test("resolution failures and timeouts are retryable refusals", async (t) => {
    const nx = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    stubDns(t, { "nx.example.test": nx });
    await assert.rejects(guardUrl("https://nx.example.test/", { label: "base_url" }), (e) => e instanceof UrlGuardError && e.retryable && /could not resolve nx\.example\.test \(ENOTFOUND\)/.test(e.message));
    t.mock.restoreAll();
    const dns = (await import("node:dns")).default;
    t.mock.method(dns.promises, "lookup", () => new Promise(() => {}));
    const t0 = Date.now();
    await assert.rejects(guardUrl("https://slow.example.test/", { lookupTimeoutMs: 50 }), (e) => e.retryable && /within 50 ms/.test(e.message));
    assert.ok(Date.now() - t0 < 2000);
  });

  test("describeUrl keeps only scheme, host and port", () => {
    assert.equal(describeUrl("https://user:pw@hooks.example.test:8443/T0K3N/path?key=secret#x"), "https://hooks.example.test:8443");
    assert.equal(describeUrl("http://localhost:1234/v1"), "http://localhost:1234");
    assert.equal(describeUrl("https://api.example.test:443/v1"), "https://api.example.test");
    assert.equal(describeUrl("nope"), "(invalid URL)");
    assert.equal(describeUrl(""), "(not set)");
  });
});

describe("openai_compatible per-call base_url", () => {
  test("is guarded: metadata, private and plain-http hosts are refused before any request", async (t) => {
    stubDns(t, { "internal.example.test": ["10.1.2.3"] });
    const calls = stubFetch(t, () => ok());
    for (const baseUrl of ["https://169.254.169.254/v1", "http://api.example.test/v1", "https://internal.example.test/v1", "https://u:p@api.example.test/v1"]) {
      await assert.rejects(callOpenAICompatible(messages, opts({ baseUrl })), /base_url/, baseUrl);
    }
    assert.equal(calls.length, 0);
  });

  test("the key goes only to the configured origin", async (t) => {
    env(t, { OPENAI_COMPATIBLE_API_KEY: "sk-compat-bound-key", OPENAI_COMPATIBLE_BASE_URL: "https://llm.example.test/v1" });
    stubDns(t);
    const calls = stubFetch(t, () => ok());
    await callOpenAICompatible(messages, opts()); // env base URL
    await callOpenAICompatible(messages, opts({ baseUrl: "https://llm.example.test/other/v1" })); // same origin
    await callOpenAICompatible(messages, opts({ baseUrl: "https://elsewhere.example.test/v1" })); // other origin
    await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1" })); // loopback, other origin
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-compat-bound-key");
    assert.equal(calls[1].init.headers.Authorization, "Bearer sk-compat-bound-key");
    assert.ok(!("Authorization" in calls[2].init.headers), "no key to another origin");
    assert.ok(!("Authorization" in calls[3].init.headers), "no key to an unlisted local server");
    assert.equal(calls[2].url, "https://elsewhere.example.test/v1/chat/completions");
  });

  test("ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS lists more origins for the key", async (t) => {
    env(t, {
      OPENAI_COMPATIBLE_API_KEY: "sk-compat-bound-key",
      ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS: "http://localhost:1234, https://router.example.test:8443/ignored-path, not-an-origin",
    });
    const calls = stubFetch(t, () => ok());
    await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1" }));
    await callOpenAICompatible(messages, opts({ baseUrl: "https://router.example.test:8443/v1" }));
    await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:9999/v1" }));
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-compat-bound-key");
    assert.equal(calls[1].init.headers.Authorization, "Bearer sk-compat-bound-key");
    assert.ok(!("Authorization" in calls[2].init.headers), "the port is part of the origin");
  });

  test("redirects are never followed", async (t) => {
    env(t, { OPENAI_COMPATIBLE_API_KEY: "sk-compat-bound-key", OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234/v1" });
    const calls = stubFetch(t, () => new Response("", { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data?x=1" } }));
    await assert.rejects(
      callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1" })),
      /OpenAI-compatible API error \(307\): refusing to follow a redirect to http:\/\/169\.254\.169\.254$/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, "manual");
  });

  test("echoed error bodies are redacted and capped", async (t) => {
    env(t, { OPENAI_COMPATIBLE_API_KEY: "sk-compat-echoed-key-123456" });
    stubFetch(t, () => json(400, { error: { message: `bad key sk-compat-echoed-key-123456 ${"y".repeat(1000)}` } }));
    const err = await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1" })).then(() => null, (e) => e);
    assert.match(err.message, /^OpenAI-compatible API error \(400\): bad key \[redacted:env:OPENAI_COMPATIBLE_API_KEY\]/);
    assert.ok(err.message.length <= "OpenAI-compatible API error (400): ".length + 300);
  });

  test("a non-JSON error body is reported by its status", async (t) => {
    stubFetch(t, () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    await assert.rejects(callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1" })), /API error \(502\): Bad Gateway/);
  });
});

describe("display", () => {
  test("debug_env reports OPENAI_COMPATIBLE_BASE_URL as scheme://host[:port] only", async (t) => {
    env(t, { OPENAI_COMPATIBLE_BASE_URL: "https://user:pw@llm.example.test:8443/proxy/T0K3N-in-path/v1?key=q" });
    const { handleToolCall } = await import("../../dist/tools.js");
    const text = (await handleToolCall("debug_env", {})).content[0].text;
    assert.equal(JSON.parse(text).openai_compatible.base_url, "https://llm.example.test:8443");
    for (const part of ["T0K3N", "key=q", "user:pw"]) assert.ok(!text.includes(part), part);
  });
});

describe("webhook publisher URL", () => {
  test("constructor refuses metadata, plain http to a public literal and userinfo; allows private (http too) and loopback", () => {
    const make = (url) => new WebhookPublisher({ url, topicPrefix: "rt" });
    assert.throws(() => make("https://169.254.169.254/hook"), /ROUNDTABLE_WEBHOOK_URL refused: .*cloud metadata/);
    assert.throws(() => make("http://169.254.169.254/hook"), /cloud metadata/);
    assert.throws(() => make("https://metadata.google.internal/hook"), /cloud metadata/);
    assert.throws(() => make("http://8.8.8.8/hook"), /ROUNDTABLE_WEBHOOK_URL must use https \(http is allowed only to loopback and private addresses\)/);
    assert.throws(() => make("https://u:p@hooks.example.test/hook"), /must not contain credentials/);
    for (const url of ["https://10.0.0.8/hook", "http://192.168.1.10:8080/hook", "http://receiver.lan/hook", "http://127.0.0.1:8080/hook"]) {
      assert.ok(make(url), url);
    }
  });

  test("send resolves the host: metadata and plain http to a public host are refused (not retried), LAN is allowed", async (t) => {
    stubDns(t, { "imds.example.test": ["169.254.169.254"], "lan.example.test": ["10.0.0.8"], "receiver.lan": ["192.168.1.10"], "hooks.example.test": ["203.0.113.10"] });
    const calls = stubFetch(t, () => new Response("", { status: 200 }));
    const channel = { id: "rt-x", sessionId: "s", suffix: "x" };
    const msg = { turn: 1, part: 1, parts: 1, speaker: "a", kind: "turn", content: "c", timestamp: "t" };
    for (const [url, why] of [["https://imds.example.test/hook", /cloud metadata/], ["http://hooks.example.test/hook", /must use https/]]) {
      const bad = await new WebhookPublisher({ url, topicPrefix: "rt" }).send(channel, msg);
      assert.equal(bad.ok, false);
      assert.equal(bad.retryable, false);
      assert.match(bad.error, why);
    }
    assert.equal(calls.length, 0);
    for (const url of ["https://lan.example.test/hook", "http://receiver.lan/hook"]) {
      assert.deepEqual(await new WebhookPublisher({ url, topicPrefix: "rt" }).send(channel, msg), { ok: true }, url);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.redirect, "manual");
  });

  test("a redirect fails the send without following it", async (t) => {
    stubDns(t);
    stubFetch(t, () => new Response("", { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
    const r = await new WebhookPublisher({ url: "https://hooks.example.test/hook", topicPrefix: "rt", authHeader: "Authorization: Bearer x" })
      .send({ id: "rt-x", sessionId: "s", suffix: "x" }, { turn: 1, part: 1, parts: 1, speaker: "a", kind: "turn", content: "c", timestamp: "t" });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
  });
});
