import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { json, stubFetch } from "./helpers.mjs";

// config.js reads process.env at module-evaluation time: set these before the dynamic import.
process.env.ROUNDTABLE_LLM_TIMEOUT_MS = "50";
process.env.REPLICATE_API_TOKEN = "r8_test";
process.env.OPENAI_API_KEY = "sk-test";

const { chatCompletion, PROVIDERS, callLLM } = await import("../../dist/providers/index.js");

const messages = [{ role: "user", content: "hi" }];
const schemaBody = { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } };

describe("chatCompletion routing", () => {
  test("exposes all six providers in order", () => {
    assert.deepEqual(Object.keys(PROVIDERS), ["anthropic", "openai", "together", "replicate", "ollama", "openai_compatible"]);
  });

  test("replicate with a never-finishing poll times out via ROUNDTABLE_LLM_TIMEOUT_MS", async (t) => {
    stubFetch(t, (url, init) => {
      if ((init.method ?? "GET") === "GET" && url.includes("/models/")) return json(200, schemaBody);
      if (init.method === "POST") return json(201, { status: "processing", urls: { get: "https://api.replicate.com/v1/predictions/p1" } });
      return json(200, { status: "processing" });
    });
    await assert.rejects(chatCompletion(messages, { provider: "replicate", model: "meta/llama" }), (e) => {
      assert.match(e.message, /timed out/);
      assert.match(e.message, /ROUNDTABLE_LLM_TIMEOUT_MS/);
      assert.match(e.message, /^replicate /);
      return true;
    });
  });

  test("replicate default model is used when none is given (ref parsed by the provider)", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if ((init.method ?? "GET") === "GET") return json(200, schemaBody);
      return json(200, { status: "succeeded", output: ["ok"] });
    });
    const r = await chatCompletion(messages, { provider: "replicate" });
    assert.equal(r.content, "ok");
    assert.match(calls[0].url, /^https:\/\/api\.replicate\.com\/v1\/models\/qwen\/qwen3-235b-a22b-instruct-2507$/);
  });

  test("base_url is rejected for every provider except openai_compatible", async (t) => {
    const calls = stubFetch(t, () => json(200, {}));
    await assert.rejects(
      chatCompletion(messages, { provider: "openai", baseUrl: "http://localhost:1234/v1" }),
      /^Error: base_url is only supported with provider "openai_compatible" \(got "openai"\)$/
    );
    assert.equal(calls.length, 0);
  });

  test("base_url reaches the openai_compatible provider", async (t) => {
    const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: "yo" } }] }));
    const r = await chatCompletion(messages, { provider: "openai_compatible", model: "m", baseUrl: "http://localhost:1234/v1" });
    assert.equal(r.content, "yo");
    assert.equal(calls[0].url, "http://localhost:1234/v1/chat/completions");
  });

  test("unknown provider lists the valid ids", async () => {
    await assert.rejects(
      chatCompletion(messages, { provider: "grok" }),
      /^Error: Unknown provider "grok"\. Valid providers: anthropic, openai, together, replicate, ollama, openai_compatible$/
    );
  });

  test("Object.prototype keys are not providers", async (t) => {
    const calls = stubFetch(t, () => json(200, {}));
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await assert.rejects(chatCompletion(messages, { provider: name }), new RegExp(`^Error: Unknown provider "${name}"`));
    }
    assert.equal(calls.length, 0);
  });

  test("callLLM prepends the system prompt and forwards baseUrl", async (t) => {
    const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: "reply" } }] }));
    const text = await callLLM("SYS", [{ role: "user", content: "q" }], {
      provider: "openai_compatible",
      model: "m",
      baseUrl: "http://localhost:1234/v1",
    });
    assert.equal(text, "reply");
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "q" },
    ]);
    assert.equal(calls[0].url, "http://localhost:1234/v1/chat/completions");
  });
});
