import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { json, stubFetch } from "./helpers.mjs";

process.env.ANTHROPIC_API_KEY = "sk-ant-billable-test";
process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1/v1";
process.env.REPLICATE_API_TOKEN = "r8_billable_test";

const { chatCompletion, callLLMWithTools } = await import("../../dist/providers/index.js");
const { BillableReplyError } = await import("../../dist/providers/shared.js");
const { withUsageSink, activeProviderOutcome, withProviderFailureSink } = await import("../../dist/providers/usage.js");
const { clearReplicateSchemaCache } = await import("../../dist/providers/replicate.js");
const { lineFor, metered } = await import("../../dist/usage/session-scope.js");
const { setSessionCap, sessionCapView, sessionSpend, clearSessionCap } = await import("../../dist/usage/session-caps.js");
const { readTableLines } = await import("../../dist/usage/table.js");

const messages = [{ role: "system", content: "Explain." }, { role: "user", content: "Why?" }];
const chars = { input: 12, output: 0 };
const hint = " Thinking/reasoning tokens count against max_tokens; raise max_tokens or ROUNDTABLE_MAX_TOKENS.";
const measured = { inputTokens: 7, outputTokens: 64 };
const cases = [
  {
    provider: "anthropic", label: "Anthropic", reason: "max_tokens",
    body: { model: "claude-actual", content: [{ type: "thinking", thinking: "reasoning" }], stop_reason: "max_tokens",
      usage: { input_tokens: 7, output_tokens: 64, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } },
    usage: { ...measured, cacheReadTokens: 11, cacheWriteTokens: 13 },
  },
  {
    provider: "openai_compatible", label: "OpenAI-compatible", reason: "length",
    body: { model: "openai-actual", choices: [{ message: { content: null }, finish_reason: "length" }],
      usage: { prompt_tokens: 7, completion_tokens: 64 } },
    usage: measured,
  },
  {
    provider: "ollama", label: "Ollama", reason: "length",
    body: { model: "ollama-actual", message: { content: "<think>reasoning</think>" }, done_reason: "length",
      prompt_eval_count: 7, eval_count: 64 },
    usage: measured,
  },
];
const options = c => ({ provider: c.provider, model: "requested-model", maxTokens: 64 });
const emptyMessage = c => `${c.label} returned no text (finish reason: ${c.reason}).${hint}`;
function stubReply(t, c, body = c.body, status = 200) {
  return stubFetch(t, url => url.endsWith("/api/tags") ? json(200, { models: [] }) : json(status, body));
}
function capture(run) {
  const reports = [], outcomes = [], failures = [];
  return withProviderFailureSink(o => failures.push(o), () => withUsageSink(r => {
    reports.push(r);
    outcomes.push(activeProviderOutcome());
  }, async () => { await run(reports, outcomes, failures); }));
}

for (const c of cases) {
  for (const estimateUsageOnFailure of [false, true]) {
    test(`${c.provider}: empty reply reports measured usage once (estimate=${estimateUsageOnFailure})`, async t => {
      const calls = stubReply(t, c);
      await capture(async (reports, outcomes, failures) => {
        await assert.rejects(chatCompletion(messages, { ...options(c), estimateUsageOnFailure }), error => {
          assert.ok(error instanceof BillableReplyError);
          assert.equal(error.message, emptyMessage(c));
          assert.equal(error.model, c.body.model);
          assert.deepEqual(error.usage, c.usage);
          return true;
        });
        assert.deepEqual(reports, [{ provider: c.provider, model: c.body.model, usage: c.usage, chars }]);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].outcome, "error");
        assert.equal(failures.length, 0, "the failure diagnostic must not add a second ledger row");
      });
      assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
    });
  }

  test(`${c.provider}: no sink preserves the empty-reply message`, async t => {
    stubReply(t, c);
    await assert.rejects(chatCompletion(messages, options(c)), { message: emptyMessage(c) });
  });

  test(`${c.provider}: malformed content retains already parsed usage`, async t => {
    const malformed = c.provider === "anthropic" ? { content: {} }
      : c.provider === "ollama" ? { message: { content: {} } }
      : { choices: [{ message: { content: {} } }] };
    stubReply(t, c, { ...c.body, ...malformed });
    await capture(async (reports, outcomes) => {
      await assert.rejects(chatCompletion(messages, options(c)), error => {
        assert.ok(error instanceof BillableReplyError);
        assert.ok(error.cause instanceof TypeError);
        assert.equal(error.message, error.cause.message);
        return true;
      });
      assert.deepEqual(reports, [{ provider: c.provider, model: c.body.model, usage: c.usage, chars }]);
      assert.equal(outcomes[0].outcome, "error");
    });
  });

  test(`${c.provider}: missing usage retains opt-in estimates and the reported model`, async t => {
    const body = { ...c.body };
    delete body.usage;
    delete body.prompt_eval_count;
    delete body.eval_count;
    stubReply(t, c, body);
    await capture(async reports => {
      await assert.rejects(chatCompletion(messages, options(c)), { message: emptyMessage(c) });
      assert.equal(reports.length, 0);
      await assert.rejects(chatCompletion(messages, { ...options(c), estimateUsageOnFailure: true }));
      assert.deepEqual(reports, [{ provider: c.provider, model: body.model, chars }]);
    });
  });

  for (const status of [401, 429, 500, 200]) {
    test(`${c.provider}: error response ${status} only reports an opt-in estimate`, async t => {
      const error = c.provider === "ollama" ? "denied" : { message: "denied" };
      stubReply(t, c, { ...c.body, error }, status);
      await capture(async (reports, outcomes, failures) => {
        await assert.rejects(chatCompletion(messages, options(c)), /API error/);
        assert.equal(reports.length, 0, "error envelopes are not billable, even if they include usage");
        assert.equal(failures.length, 1);
        await assert.rejects(chatCompletion(messages, { ...options(c), estimateUsageOnFailure: true }), /API error/);
        assert.deepEqual(reports, [{ provider: c.provider, model: "requested-model", chars }]);
        assert.equal(outcomes[0].outcome, status === 401 ? "auth" : status === 429 ? "rate_limit" : "error");
        assert.equal(failures.length, 1);
      });
    });
  }
}

test("zero token counts are still measured usage", async t => {
  const c = cases[1];
  stubReply(t, c, { ...c.body, usage: { prompt_tokens: 0, completion_tokens: 0 } });
  await capture(async reports => {
    await assert.rejects(chatCompletion(messages, options(c)));
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].usage, { inputTokens: 0, outputTokens: 0 });
  });
});

test("malformed JSON and failures before a response do not automatically estimate usage", async t => {
  const responses = [
    () => new Response("{broken", { status: 200 }),
    () => { throw new TypeError("fetch failed"); },
    () => { throw new DOMException("Timed out", "TimeoutError"); },
  ];
  stubFetch(t, (_url, _init, i) => responses[i]());
  await capture(async reports => {
    for (let i = 0; i < responses.length; i++) await assert.rejects(chatCompletion(messages, options(cases[1])));
    assert.equal(reports.length, 0);
  });
});

const schema = { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {}, max_tokens: {} } } } } } } };
for (const [output, message] of [
  [[], "Replicate returned no text for model meta/billable"],
  ["", "Replicate returned no text for model meta/billable"],
  [null, "Replicate returned no text for model meta/billable"],
  [undefined, "Replicate returned no text for model meta/billable"],
  [{}, "Replicate returned unexpected output type object for model meta/billable"],
  [42, "Replicate returned unexpected output type number for model meta/billable"],
  ["<think>reasoning</think>", "Replicate returned no text."],
]) {
  test(`Replicate: rejected output ${JSON.stringify(output)} retains its model for estimates`, async t => {
    clearReplicateSchemaCache();
    stubFetch(t, (_url, init) => init.method === "GET" ? json(200, schema) : json(200, { status: "succeeded", output }));
    const opts = { provider: "replicate", model: "https://replicate.com/meta/billable" };
    await capture(async reports => {
      await assert.rejects(chatCompletion(messages, opts), error => {
        assert.ok(error instanceof BillableReplyError);
        assert.equal(error.model, "meta/billable");
        assert.equal(error.message, message);
        assert.equal(error.usage, undefined);
        return true;
      });
      assert.equal(reports.length, 0);
      await assert.rejects(chatCompletion(messages, { ...opts, estimateUsageOnFailure: true }), { message });
      assert.deepEqual(reports, [{ provider: "replicate", model: "meta/billable", chars }]);
    });
  });
}

test("a rejected reply advances its session cap and writes one measured ledger row", async t => {
  const c = cases[0], scope = { session: "billable-failure-cap", kind: "meeting", agent: "sample" };
  stubReply(t, c);
  const report = { provider: c.provider, model: c.body.model, usage: c.usage, chars };
  const expected = sessionSpend(lineFor(scope, report, "test-server"));
  let stops = 0;
  setSessionCap(scope.session, expected * 2, 0, () => stops++);
  t.after(() => clearSessionCap(scope.session));
  await assert.rejects(metered(scope, () => chatCompletion(messages, options(c))), { message: emptyMessage(c) });
  assert.equal(sessionCapView(scope.session).spentUsd, expected);
  assert.equal(sessionCapView(scope.session).reached, false);
  const lines = readTableLines([new Date().toISOString().slice(0, 10)]).filter(line => line.session === scope.session);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "error");
  assert.equal(lines[0].model, c.body.model);
  assert.equal(lines[0].tokens_prov, "measured");
  assert.deepEqual(lines[0].tokens, { input: 7, output: 64, cache_read: 11, cache_write: 13 });
  await assert.rejects(metered(scope, () => chatCompletion(messages, options(c))), { name: "StoppedError" });
  assert.equal(sessionCapView(scope.session).spentUsd, expected * 2);
  assert.equal(sessionCapView(scope.session).reached, true);
  assert.equal(stops, 1);
  assert.equal(readTableLines([new Date().toISOString().slice(0, 10)]).filter(line => line.session === scope.session).length, 2);
});

test("a failed tool-loop round is metered once after a successful tool request", async t => {
  const c = cases[1];
  stubFetch(t, (_url, _init, i) => json(200, i === 0 ? {
    model: c.body.model, usage: c.body.usage,
    choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: "{}" } }] } }],
  } : c.body));
  let toolsRun = 0;
  await capture(async (reports, outcomes) => {
    await assert.rejects(callLLMWithTools("Explain.", messages.slice(1), options(c),
      [{ name: "lookup", description: "Look up a fact", inputSchema: { type: "object" } }],
      async () => { toolsRun++; return "a fact"; }), { message: emptyMessage(c) });
    assert.equal(toolsRun, 1);
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map(r => r.usage), [c.usage, c.usage]);
    assert.deepEqual(outcomes.map(o => o.outcome), ["ok", "error"]);
  });
});

test("casting failures produce one measured ledger row per dispatched call", async t => {
  const { runCastingCall } = await import("../../dist/casting/casting.js");
  const c = cases[1], calls = stubReply(t, c);
  const events = [];
  const report = await runCastingCall({
    brief: "Build a queue", agents: ["architect", "engineer"],
    agentsDir: fileURLToPath(new URL("../fixtures/casting", import.meta.url)),
    provider: c.provider, model: "requested-model", examine: false,
  }, { onEvent: e => events.push(e) }, new AbortController().signal);
  const lines = readTableLines([new Date().toISOString().slice(0, 10)]).filter(line => line.session === report.id);
  assert.equal(calls.length, 4, "two auditions and two separate director attempts");
  assert.equal(lines.length, calls.length);
  assert.ok(lines.every(line => line.outcome === "error" && line.tokens_prov === "measured"));
  assert.ok(lines.every(line => line.tokens.input === 7 && line.tokens.output === 64));
  const usage = events.filter(e => e.type === "usage").at(-1);
  assert.equal(usage.perSeat.reduce((n, s) => n + s.inputTokens, 0), 7 * calls.length);
  assert.equal(usage.perSeat.reduce((n, s) => n + s.outputTokens, 0), 64 * calls.length);
});
