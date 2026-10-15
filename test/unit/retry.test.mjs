// Provider retries: which failures are retried, backoff and Retry-After, the caller's signal, and each provider.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { json, stubFetch } from "./helpers.mjs";

process.env.ANTHROPIC_API_KEY = "sk-ant-retry-test-key";
process.env.OPENAI_API_KEY = "sk-retry-test-openai-0123456789";
process.env.REPLICATE_API_TOKEN = "r8_retry";
process.env.OLLAMA_URL = "http://127.0.0.1:11434";

const { withRetry, retryDelayMs, retryClock, ProviderHttpError, isRetryableError, RETRY_AFTER_CAP_MS } = await import("../../dist/providers/retry.js");
const { callAnthropic } = await import("../../dist/providers/anthropic.js");
const { callOpenAI, parseChatCompletions } = await import("../../dist/providers/openai-compatible.js");
const { callOllama } = await import("../../dist/providers/ollama.js");
const { createReplicateCall, clearReplicateSchemaCache } = await import("../../dist/providers/replicate.js");

const http = (status, retryAfterMs) => new ProviderHttpError(`HTTP ${status}`, status, retryAfterMs);
const netError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });

/** Record backoff waits instead of sleeping. */
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); } };
}

/** Turn provider retries on for one test and make their sleeps instant. */
function providerRetries(t, n = "2") {
  const saved = process.env.ROUNDTABLE_PROVIDER_RETRIES;
  process.env.ROUNDTABLE_PROVIDER_RETRIES = n;
  t.after(() => {
    process.env.ROUNDTABLE_PROVIDER_RETRIES = saved;
  });
  const waits = [];
  t.mock.method(retryClock, "sleep", async (ms) => {
    waits.push(ms);
  });
  return waits;
}

describe("withRetry", () => {
  test("retries 408, 409, 429, 5xx and 529, then succeeds", async () => {
    for (const status of [408, 409, 429, 500, 502, 503, 529]) {
      const { waits, sleep } = fakeSleep();
      let n = 0;
      const r = await withRetry(async () => (++n < 3 ? Promise.reject(http(status)) : "ok"), { attempts: 3, sleep, random: () => 0 });
      assert.equal(r, "ok");
      assert.equal(n, 3, `status ${status}`);
      assert.deepEqual(waits, [250, 500], "exponential: half of 500 ms, then half of 1000 ms with random() = 0");
    }
  });

  test("does not retry client errors or other failures, and stops after the last attempt", async () => {
    for (const error of [http(400), http(401), http(404), http(422), new Error("empty reply"), new SyntaxError("bad json")]) {
      let n = 0;
      await assert.rejects(withRetry(async () => { n++; throw error; }, { attempts: 3, sleep: async () => {} }), error);
      assert.equal(n, 1, String(error));
    }
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw http(503); }, { attempts: 3, sleep: async () => {} }), /HTTP 503/);
    assert.equal(n, 3);
  });

  test("retries network errors but never aborts or timeouts", async () => {
    let n = 0;
    assert.equal(await withRetry(async () => (++n === 1 ? Promise.reject(netError()) : "ok"), { attempts: 2, sleep: async () => {} }), "ok");
    assert.ok(isRetryableError(new TypeError("fetch failed")));
    assert.ok(!isRetryableError(Object.assign(new Error("aborted"), { name: "AbortError" })));
    assert.ok(!isRetryableError(new DOMException("timed out", "TimeoutError")));
    assert.ok(!isRetryableError(new TypeError("Cannot read properties of undefined")));
  });

  test("backoff: exponential with equal jitter, capped", () => {
    assert.equal(retryDelayMs(1, http(503), { random: () => 0 }), 250);
    assert.equal(retryDelayMs(1, http(503), { random: () => 1 }), 500);
    assert.equal(retryDelayMs(3, http(503), { random: () => 1 }), 2000);
    assert.equal(retryDelayMs(10, http(503), { random: () => 1 }), 8000, "capped at 8 s");
    for (let i = 0; i < 50; i++) {
      const d = retryDelayMs(2, netError());
      assert.ok(d >= 500 && d <= 1000, `${d}`);
    }
  });

  test("Retry-After wins (seconds or HTTP date) and is capped at 60 s", async (t) => {
    assert.equal(retryDelayMs(1, http(429, 7000)), 7000);
    assert.equal(retryDelayMs(1, http(429, 0)), 0);
    assert.equal(retryDelayMs(1, http(429, 3_600_000)), RETRY_AFTER_CAP_MS);
    const waits = providerRetries(t, "1");
    const when = new Date(Date.now() + 5000).toUTCString();
    let n = 0;
    stubFetch(t, () =>
      ++n === 1
        ? new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": when } })
        : json(200, { choices: [{ message: { content: "ok" } }] }));
    // An HTTP date is relative to now: a few seconds, give or take the clock tick.
    await callOpenAI([{ role: "user", content: "hi" }], { model: "m", maxTokens: 8, signal: new AbortController().signal });
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 3000 && waits[0] <= 5000, `${waits[0]} from ${when}`);
    t.mock.restoreAll();
  });

  test("never outlives the caller's signal: a backoff ends when it fires, and no attempt follows", async () => {
    let n = 0;
    const signal = AbortSignal.timeout(50);
    const t0 = Date.now();
    await assert.rejects(
      withRetry(async () => { n++; throw http(503, 30_000); }, { attempts: 5, signal }),
      (e) => e.name === "TimeoutError"
    );
    assert.equal(n, 1);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    const aborted = AbortSignal.abort();
    let m = 0;
    await assert.rejects(withRetry(async () => { m++; return "never"; }, { signal: aborted }));
    assert.equal(m, 0);
  });

  test("ROUNDTABLE_PROVIDER_RETRIES sets the default attempts", async (t) => {
    providerRetries(t, "0");
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw http(503); }));
    assert.equal(n, 1);
    process.env.ROUNDTABLE_PROVIDER_RETRIES = "4";
    n = 0;
    await assert.rejects(withRetry(async () => { n++; throw http(503); }));
    assert.equal(n, 5);
  });
});

describe("providers throw ProviderHttpError and retry their calls", () => {
  const messages = [{ role: "user", content: "hi" }];
  const opts = (model = "m") => ({ model, maxTokens: 8, signal: new AbortController().signal });

  test("parseChatCompletions carries status and Retry-After", () => {
    const res = new Response("", { status: 429, headers: { "retry-after": "3" } });
    assert.throws(() => parseChatCompletions("X", "openai", res, { error: { message: "busy" } }, "m"), (e) => {
      assert.ok(e instanceof ProviderHttpError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 3000);
      return /X API error \(429\): busy/.test(e.message);
    });
  });

  test("anthropic retries 529 overloaded", async (t) => {
    const waits = providerRetries(t);
    const calls = stubFetch(t, (_u, _i, i) =>
      i < 2 ? json(529, { error: { type: "overloaded_error", message: "Overloaded" } }) : json(200, { content: [{ type: "text", text: "ok" }] }));
    assert.equal((await callAnthropic(messages, opts())).content, "ok");
    assert.equal(calls.length, 3);
    assert.equal(waits.length, 2);
  });

  test("anthropic does not retry 400 and reports the last error after the final attempt", async (t) => {
    providerRetries(t);
    let calls = stubFetch(t, () => json(400, { error: { type: "invalid_request_error", message: "bad" } }));
    await assert.rejects(callAnthropic(messages, opts()), /400 invalid_request_error/);
    assert.equal(calls.length, 1);
    t.mock.restoreAll();
    providerRetries(t);
    calls = stubFetch(t, () => json(503, { error: { type: "api_error", message: "down" } }));
    await assert.rejects(callAnthropic(messages, opts()), (e) => e instanceof ProviderHttpError && e.status === 503);
    assert.equal(calls.length, 3);
  });

  test("openai retries a network error", async (t) => {
    providerRetries(t);
    let n = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++n === 1) throw netError();
      return json(200, { choices: [{ message: { content: "ok" } }] });
    });
    assert.equal((await callOpenAI(messages, opts())).content, "ok");
    assert.equal(n, 2);
  });

  test("ollama retries the chat call, not the reachability check", async (t) => {
    providerRetries(t);
    let chats = 0;
    stubFetch(t, (url) => {
      if (url.endsWith("/api/tags")) return json(200, { models: [] });
      return ++chats === 1 ? json(503, { error: "loading model" }) : json(200, { message: { content: "ok" } });
    });
    assert.equal((await callOllama(messages, opts())).content, "ok");
    assert.equal(chats, 2);
  });

  test("replicate retries the create call", async (t) => {
    providerRetries(t);
    clearReplicateSchemaCache();
    let creates = 0;
    stubFetch(t, (url, init) => {
      if (init.method !== "POST") return json(200, { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } });
      return ++creates === 1 ? json(429, { detail: "throttled" }) : json(201, { status: "succeeded", output: ["ok"] });
    });
    assert.equal((await createReplicateCall({ pollIntervalMs: 1 })(messages, opts("meta/llama"))).content, "ok");
    assert.equal(creates, 2);
  });
});
