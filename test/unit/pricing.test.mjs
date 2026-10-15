import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { estimateUsd, priceFor, parsePricing, loadPricing, BUILTIN_PRICING, PRICING_FILE_ENV } = await import("../../dist/execution/pricing.js");
const { DEFAULT_MODELS } = await import("../../dist/config.js");

test("estimateUsd prices input, output and cache tokens per million", () => {
  const cases = [
    ["claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 24],
    ["claude-opus-5", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, 6.755],
    ["claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, 0.1],
    ["claude-sonnet-4-5-20250929", { inputTokens: 1_000_000, outputTokens: 0 }, 3],
    ["anthropic/claude-opus-4-8", { inputTokens: 0, outputTokens: 1_000_000 }, 25],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", { inputTokens: 1_000_000, outputTokens: 0 }, 1],
    ["claude-opus-4-5@20251101", { inputTokens: 1_000_000, outputTokens: 0 }, 5],
    ["claude-opus-4-20250514", { inputTokens: 0, outputTokens: 1_000_000 }, 75],
    ["Claude-Fable-5-1", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, 0.25],
    // Haiku 5.5 switches rate card above a 100K-token prompt.
    ["claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000_000 }, 0.51],
    ["claude-haiku-5-5", { inputTokens: 150_000, outputTokens: 1_000_000 }, 2.575],
  ];
  for (const [model, tokens, usd] of cases) {
    assert.deepEqual(estimateUsd(model, tokens), { usd, estimated: false }, model);
  }
});

test("unknown models and null prices are estimated; local providers are free", () => {
  assert.deepEqual(estimateUsd("mystery-model", { inputTokens: 10, outputTokens: 10 }), { usd: 0, estimated: true });
  assert.deepEqual(estimateUsd("mystery-model", { inputTokens: 0, outputTokens: 0 }), { usd: 0, estimated: false });
  assert.deepEqual(estimateUsd("gpt-5.6-luna", { inputTokens: 10, outputTokens: 10 }), { usd: 0, estimated: true });
  assert.deepEqual(estimateUsd("qwen3:14b", { inputTokens: 10, outputTokens: 10 }, { provider: "ollama" }), { usd: 0, estimated: false });
  const table = { partial: { input: 1, output: null, cache_read: null, cache_write: null } };
  assert.deepEqual(estimateUsd("partial", { inputTokens: 1_000_000, outputTokens: 5 }, { table }), { usd: 1, estimated: true });
});

test("every default model in config has a pricing entry", () => {
  for (const [provider, model] of Object.entries(DEFAULT_MODELS)) {
    // openai_compatible has no real default; a model overridden from the environment is not a default.
    if (provider === "openai_compatible" || process.env[`ROUNDTABLE_${provider.toUpperCase()}_MODEL`]) continue;
    assert.ok(priceFor(model, BUILTIN_PRICING), `${provider}: ${model}`);
  }
  assert.equal(BUILTIN_PRICING["claude-opus-5"].input, 5);
  assert.equal(BUILTIN_PRICING["claude-sonnet-5"].output, 10);
});

test("parsePricing validates override files", () => {
  const ok = parsePricing(
    JSON.stringify({
      "my-model": { input: 1, output: 2, cache_read: 0.1 },
      tiered: { input: 1, output: 2, long: { above_tokens: 1000, input: 2, output: 4 } },
      unknown: { input: null, output: null },
    })
  );
  assert.deepEqual(ok["my-model"], { input: 1, output: 2, cache_read: 0.1, cache_write: null });
  assert.equal(ok.tiered.long.above_tokens, 1000);
  assert.equal(ok.unknown.input, null);

  const bad = [
    ["{", /invalid JSON/],
    ["[]", /expected an object/],
    [JSON.stringify({ m: { input: -1, output: 1 } }), /m".input: must be a non-negative number/],
    [JSON.stringify({ m: { input: 1 } }), /"output" is required/],
    [JSON.stringify({ m: { input: 1, output: 1, inptu: 2 } }), /unknown field "inptu"/],
    [JSON.stringify({ m: { input: 1, output: 1, long: { input: 1, output: 1 } } }), /above_tokens: must be a positive integer/],
    [JSON.stringify({ m: "cheap" }), /expected an object of prices/],
    [JSON.stringify({ "": { input: 1, output: 1 } }), /1-200 characters/],
  ];
  for (const [text, re] of bad) assert.throws(() => parsePricing(text), re, text);
});

test("ROUNDTABLE_PRICING_FILE merges over the built-in table and is re-read when it changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-pricing-"));
  const file = join(dir, "pricing.json");
  writeFileSync(file, JSON.stringify({ "claude-opus-5-5": { input: 1, output: 1 }, "house-model": { input: 2, output: 2 } }));
  const env = { [PRICING_FILE_ENV]: file };
  const table = loadPricing(env);
  assert.equal(table["claude-opus-5-5"].input, 1);
  assert.equal(table["house-model"].output, 2);
  assert.equal(table["claude-sonnet-5"].input, 2, "built-ins kept");
  assert.equal(loadPricing(env), table, "cached");
  assert.deepEqual(estimateUsd("house-model", { inputTokens: 1_000_000, outputTokens: 0 }, { table }), { usd: 2, estimated: false });

  writeFileSync(file, JSON.stringify({ "house-model": { input: 3, output: 3, extra: 1 } }) + "\n");
  assert.throws(() => loadPricing(env), /ROUNDTABLE_PRICING_FILE .*unknown field "extra"/);
  assert.throws(() => loadPricing({ [PRICING_FILE_ENV]: join(dir, "missing.json") }), /ENOENT/);
  assert.equal(loadPricing({}), BUILTIN_PRICING);
});
