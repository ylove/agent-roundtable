import { test } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, json } from "./helpers.mjs";

process.env.OLLAMA_URL = "http://local-user:local-pass@127.0.0.1:11434/private?token=opaque";
process.env.REPLICATE_API_TOKEN = "fixture-provider-token";
const { readProviderJson, PROVIDER_BODY_LIMIT } = await import("../../dist/providers/shared.js");
const { callOllama, isOllamaAvailable } = await import("../../dist/providers/ollama.js");
const { createReplicateCall, clearReplicateSchemaCache } = await import("../../dist/providers/replicate.js");
const opts = () => ({ model: "fixture/model", maxTokens: 8, signal: AbortSignal.timeout(5000) });
const messages = [{ role: "user", content: "hello" }];
const schema = { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } };

function oversized(status = 200) {
  const state = { cancelled: false, pulls: 0 };
  state.response = new Response(new ReadableStream({
    pull(controller) { state.pulls++; controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { state.cancelled = true; },
  }), { status });
  return state;
}

test("provider JSON cancels oversized success and error bodies", async () => {
  for (const status of [200, 400]) {
    const body = oversized(status);
    await assert.rejects(readProviderJson(body.response), /body exceeds 8388608 byte limit/);
    assert.equal(body.cancelled, true);
    assert.ok(body.pulls <= PROVIDER_BODY_LIMIT / (64 * 1024) + 2);
  }
});

test("provider JSON preserves byte boundaries and strict success parsing", async () => {
  const bytes = Buffer.from('{"text":"héllo"}');
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  assert.deepEqual(await readProviderJson(response), { text: "héllo" });
  assert.deepEqual(await readProviderJson(new Response('\ufeff{"ok":true}')), { ok: true });
  assert.deepEqual(await readProviderJson(new Response(new ReadableStream({
    start(controller) { controller.error(new Error("fixture read error")); },
  }), { status: 502 })), {});
  await assert.rejects(readProviderJson(new Response("unfinished")), SyntaxError);
  assert.deepEqual(await readProviderJson(new Response("not JSON", { status: 502 })), {});
  const exact = JSON.stringify({ text: "a".repeat(PROVIDER_BODY_LIMIT - 11) });
  assert.equal(Buffer.byteLength(exact), PROVIDER_BODY_LIMIT);
  assert.equal((await readProviderJson(new Response(exact))).text.length, PROVIDER_BODY_LIMIT - 11);
});

test("prediction responses share streaming limits across schema, create, and poll", async (t) => {
  for (const phase of ["schema", "create", "poll"]) {
    clearReplicateSchemaCache();
    const body = oversized();
    const calls = stubFetch(t, (_url, init, index) => {
      if (index === 0) return phase === "schema" ? body.response : json(200, schema);
      if (init.method === "POST") return phase === "create" ? body.response
        : json(201, { status: "processing", urls: { get: new URL("/v1/predictions/fixture", _url).href } });
      return body.response;
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), /body exceeds 8388608 byte limit/);
    assert.equal(body.cancelled, true);
    assert.equal(calls.length, phase === "schema" ? 1 : phase === "create" ? 2 : 3);
    t.mock.restoreAll();
  }
});

test("local provider rejects redirects during availability and completion", async (t) => {
  let calls = stubFetch(t, () => new Response("", { status: 302, headers: { location: "http://elsewhere.example.test/private" } }));
  assert.equal(await isOllamaAvailable(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "manual");
  t.mock.restoreAll();
  calls = stubFetch(t, (_url, init) => init.method === "GET" ? json(200, { models: [] })
    : new Response("", { status: 307, headers: { location: "http://elsewhere.example.test/private" } }));
  await assert.rejects(callOllama(messages, opts()), /refusing to follow a redirect/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init.redirect === "manual"));
});

test("local provider availability errors show only the configured origin", async (t) => {
  stubFetch(t, () => { throw new Error("unavailable"); });
  await assert.rejects(callOllama(messages, opts()), (error) => {
    assert.match(error.message, /http:\/\/127\.0\.0\.1:11434/);
    for (const detail of ["local-user", "local-pass", "/private", "token=opaque"]) assert.ok(!error.message.includes(detail));
    return true;
  });
});
