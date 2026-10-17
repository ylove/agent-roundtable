// The usage sink: provider usage reaches the active sink through nested async work; no sink is a no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
process.env.ANTHROPIC_API_KEY = "sk-ant-usage-test-key";

const { callLLM, callLLMDetailed, withUsageSink, reportUsage } = await import("../../dist/providers/index.js");
const { callAnthropic } = await import("../../dist/providers/anthropic.js");
const { startMeeting, endMeeting } = await import("../../dist/sessions/meetings.js");

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../fixtures/agents/sample.md");
const llm = { provider: "openai_compatible", model: "m", baseUrl: "http://localhost:1234/v1" };
const reply = (i) => json(200, { choices: [{ message: { content: `reply ${i}` } }], model: `served-${i}`, usage: { prompt_tokens: 10 + i, completion_tokens: i } });
const user = [{ role: "user", content: "hi" }];

test("callLLMDetailed returns the whole result and callLLM its content", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  const r = await callLLMDetailed("sys", user, llm);
  assert.deepEqual(r, { content: "reply 0", model: "served-0", provider: "openai_compatible", usage: { inputTokens: 10, outputTokens: 0 } });
  assert.equal(await callLLM("sys", user, llm), "reply 1");
});

test("usage reaches the sink through nested async calls, and only the active sink", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  const a = [];
  const b = [];
  const nested = async () => {
    await sleep(1);
    await Promise.all([callLLM("s", user, llm), new Promise((r) => setImmediate(() => r(callLLM("s", user, llm))))]);
  };
  // Two sinks at once: each sees exactly its own calls.
  await Promise.all([withUsageSink((r) => a.push(r), nested), withUsageSink((r) => b.push(r), () => callLLM("s", user, llm))]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  for (const r of [...a, ...b]) {
    assert.equal(r.provider, "openai_compatible");
    assert.match(r.model, /^served-\d$/);
    assert.equal(r.usage.inputTokens, 10 + Number(r.model.slice(-1)));
  }
});

test("engines report through the sink with their signatures unchanged", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  const seen = [];
  await withUsageSink((r) => seen.push(r), async () => {
    const { meetingId } = await startMeeting(sample, "agenda", undefined, "openai_compatible", "m", llm.baseUrl);
    await endMeeting(meetingId, true);
  });
  assert.equal(seen.length, 2, "the opening reply and the summary");
});

test("the chat_completion tool reports through the sink too, exactly once per call", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  const { handleToolCall } = await import("../../dist/tools.js");
  const seen = [];
  const r = await withUsageSink((u) => seen.push(u), () =>
    handleToolCall("chat_completion", { messages: user, provider: "openai_compatible", model: "m", base_url: llm.baseUrl }));
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(seen.length, 1);
  const { chars, ...report } = seen[0];
  assert.deepEqual(report, { provider: "openai_compatible", model: "served-0", usage: { inputTokens: 10, outputTokens: 0 } });
  assert.ok(chars.input > 0 && chars.output > 0, "the lengths of the request and the reply ride along (never the text)");
  const viaCallLLM = [];
  await withUsageSink((u) => viaCallLLM.push(u), () => callLLMDetailed("s", user, llm));
  assert.equal(viaCallLLM.length, 1, "callLLMDetailed does not report twice");
});

test("a nested sink replaces the outer one for its scope only", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  const outer = [];
  const inner = [];
  await withUsageSink((r) => outer.push(r), async () => {
    await callLLM("s", user, llm);
    await withUsageSink((r) => inner.push(r), () => callLLM("s", user, llm));
    await callLLM("s", user, llm);
  });
  assert.equal(outer.length, 2);
  assert.equal(inner.length, 1);
});

test("no sink is a no-op, and a failing sink never fails the call", async (t) => {
  stubFetch(t, (_u, _i, i) => reply(i));
  reportUsage({ provider: "x", model: "y" });
  assert.equal(await callLLM("s", user, llm), "reply 0");
  const r = await withUsageSink(() => { throw new Error("ledger down"); }, () => callLLM("s", user, llm));
  assert.equal(r, "reply 1");
});

test("anthropic: prompt-cache reads and writes are captured when present", async (t) => {
  const opts = { model: "claude-x", maxTokens: 8, signal: new AbortController().signal };
  stubFetch(t, (_u, _i, i) =>
    json(200, {
      content: [{ type: "text", text: "ok" }],
      model: "claude-x",
      usage: i === 0
        ? { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }
        : { input_tokens: 5, output_tokens: 2 },
    }));
  assert.deepEqual((await callAnthropic(user, opts)).usage, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 40 });
  assert.deepEqual((await callAnthropic(user, opts)).usage, { inputTokens: 5, outputTokens: 2 });
});
