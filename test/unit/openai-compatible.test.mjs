import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { json, stubFetch } from "./helpers.mjs";

process.env.OPENAI_API_KEY = "sk-test-openai";
process.env.TOGETHER_API_KEY = "sk-test-together";
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const { callOpenAI, callTogether, callOpenAICompatible, parseChatCompletions } = await import(
  "../../dist/providers/openai-compatible.js"
);

const ok = (content = "hello", extra = {}) =>
  json(200, { choices: [{ message: { content }, finish_reason: "stop" }], model: "m-actual", usage: { prompt_tokens: 1, completion_tokens: 2 }, ...extra });
const messages = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];
const opts = (extra = {}) => ({ model: "m", maxTokens: 32, signal: new AbortController().signal, ...extra });

describe("callOpenAI", () => {
  test("posts to api.openai.com with max_completion_tokens and the bearer key", async (t) => {
    const calls = stubFetch(t, () => ok());
    const signal = new AbortController().signal;
    const r = await callOpenAI(messages, opts({ temperature: 0.3, signal }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal, signal, "the request carries the caller's signal");
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-openai");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(calls[0].body, { model: "m", messages, max_completion_tokens: 32, temperature: 0.3 });
    assert.deepEqual(r, { content: "hello", model: "m-actual", provider: "openai", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  test("omits temperature when undefined", async (t) => {
    const calls = stubFetch(t, () => ok());
    await callOpenAI(messages, opts());
    assert.ok(!("temperature" in calls[0].body));
  });
});

describe("callTogether", () => {
  test("posts to api.together.xyz with max_tokens", async (t) => {
    const calls = stubFetch(t, () => ok());
    const r = await callTogether(messages, opts());
    assert.equal(calls[0].url, "https://api.together.xyz/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-together");
    assert.deepEqual(calls[0].body, { model: "m", messages, max_tokens: 32 });
    assert.equal(r.provider, "together");
  });

  test("API errors are labelled Together", async (t) => {
    stubFetch(t, () => json(401, { error: { message: "bad key" } }));
    await assert.rejects(callTogether(messages, opts()), /Together API error \(401\): bad key/);
  });
});

describe("callOpenAICompatible", () => {
  test("baseUrl option with trailing slash → /chat/completions, max_tokens, no auth header", async (t) => {
    const calls = stubFetch(t, () => ok());
    const r = await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1/" }));
    assert.equal(calls[0].url, "http://localhost:1234/v1/chat/completions");
    assert.deepEqual(calls[0].body, { model: "m", messages, max_tokens: 32 });
    assert.ok(!("Authorization" in calls[0].init.headers), "no Authorization header without a key");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.equal(r.provider, "openai_compatible");
  });

  test("sends Authorization when OPENAI_COMPATIBLE_API_KEY is set", async (t) => {
    process.env.OPENAI_COMPATIBLE_API_KEY = "sk-test-local";
    t.after(() => delete process.env.OPENAI_COMPATIBLE_API_KEY);
    const calls = stubFetch(t, () => ok());
    const signal = new AbortController().signal;
    await callOpenAICompatible(messages, opts({ baseUrl: "http://localhost:1234/v1", signal }));
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-local");
    assert.equal(calls[0].signal, signal, "the request carries the caller's signal");
  });

  test("falls back to OPENAI_COMPATIBLE_BASE_URL when no baseUrl option is given", async (t) => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://vllm.internal:8000/v1";
    t.after(() => delete process.env.OPENAI_COMPATIBLE_BASE_URL);
    const calls = stubFetch(t, () => ok());
    await callOpenAICompatible(messages, opts());
    assert.equal(calls[0].url, "http://vllm.internal:8000/v1/chat/completions");
  });

  test("no baseUrl and no env → error names OPENAI_COMPATIBLE_BASE_URL and makes no request", async (t) => {
    const calls = stubFetch(t, () => ok());
    await assert.rejects(callOpenAICompatible(messages, opts()), /OPENAI_COMPATIBLE_BASE_URL/);
    assert.equal(calls.length, 0);
  });
});

describe("parseChatCompletions", () => {
  test("strips <think> blocks", () => {
    const r = parseChatCompletions("X", "together", new Response("", { status: 200 }), {
      choices: [{ message: { content: "<think>reasoning</think>\nanswer" }, finish_reason: "stop" }],
    }, "m");
    assert.equal(r.content, "answer");
    assert.equal(r.model, "m");
  });

  test("empty content with finish_reason length includes the max_tokens hint", () => {
    assert.throws(
      () =>
        parseChatCompletions("X", "openai", new Response("", { status: 200 }), {
          choices: [{ message: { content: "" }, finish_reason: "length" }],
        }, "m"),
      /X returned no text \(finish reason: length\)\..*ROUNDTABLE_MAX_TOKENS/
    );
  });

  test("HTTP errors and error envelopes surface the message", () => {
    assert.throws(
      () => parseChatCompletions("X", "openai", new Response("", { status: 500, statusText: "Server Error" }), {}, "m"),
      /X API error \(500\): Server Error/
    );
    assert.throws(
      () => parseChatCompletions("X", "openai", new Response("", { status: 200 }), { error: "quota" }, "m"),
      /X API error \(200\): quota/
    );
  });
});
