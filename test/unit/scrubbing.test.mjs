// Secrets are scrubbed from tool errors, provider errors and the activity log.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "rt-scrub-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Env secrets are matched by exact value (any shape); credential patterns catch the rest.
const ANTHROPIC = "anthropic-secret-value-0123456789";
const REPLICATE = "replicate-secret-value-0123456789";
const PATTERN_ONLY = "ghp_abcdefghijklmnopqrstuvwxyz0123";
process.env.ANTHROPIC_API_KEY = ANTHROPIC;
process.env.REPLICATE_API_TOKEN = REPLICATE;
process.env.OLLAMA_URL = "http://127.0.0.1:11434";

const { recordActivity, readActivity } = await import("../../dist/activity.js");
const { handleToolCall } = await import("../../dist/tools.js");
const { callAnthropic } = await import("../../dist/providers/anthropic.js");
const { callOllama } = await import("../../dist/providers/ollama.js");
const { createReplicateCall, clearReplicateSchemaCache } = await import("../../dist/providers/replicate.js");

const opts = (extra = {}) => ({ model: "m", maxTokens: 8, signal: new AbortController().signal, ...extra });
const messages = [{ role: "user", content: "hi" }];
const clean = (text) => !text.includes(ANTHROPIC) && !text.includes(REPLICATE) && !text.includes(PATTERN_ONLY);

test("activity topics and outcomes are scrubbed before they are stored", () => {
  const path = join(root, "activity.jsonl");
  recordActivity({
    session: "s1", kind: "meeting", agents: ["a"], public: false,
    topic: `rotate ${ANTHROPIC} today`,
    outcome: `new token ${PATTERN_ONLY} issued`,
  }, path);
  const raw = readFileSync(path, "utf8");
  assert.ok(clean(raw), raw);
  const [entry] = readActivity(path);
  assert.equal(entry.topic, "rotate [redacted:env:ANTHROPIC_API_KEY] today");
  assert.match(entry.outcome, /^new token \[redacted:api_key\] issued$/);
});

test("configuration that is not secret survives scrubbing (no over-redaction)", async (t) => {
  const { scrub } = await import("../../dist/security/secrets.js");
  const { SECRET_NAME_RE } = await import("../../dist/security/child-env.js");
  const saved = { a: process.env.GIT_AUTHOR_NAME, o: process.env.ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS };
  process.env.GIT_AUTHOR_NAME = "Some Name";
  process.env.ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS = "https://api.good.com";
  t.after(() => {
    for (const [k, v] of [["GIT_AUTHOR_NAME", saved.a], ["ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS", saved.o]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  assert.ok(!SECRET_NAME_RE.test("ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS"));
  const text = "Kickoff with Some Name about https://api.good.com";
  assert.equal(scrub(text), text);
});

test("tool errors are scrubbed at the dispatch boundary", async () => {
  // A bare agent name that is a secret: the not-found error echoes the ref.
  const r = await handleToolCall("start_meeting", { agent: ANTHROPIC, agenda: "x", provider: "openai_compatible", base_url: "http://localhost:1234/v1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Agent prompt not found for "\[redacted:env:ANTHROPIC_API_KEY\]"/);
  assert.ok(clean(r.content[0].text));
});

test("anthropic: echoed error bodies are scrubbed and capped", async (t) => {
  stubFetch(t, () => json(401, { error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC} ${"z".repeat(800)}` } }));
  const err = await callAnthropic(messages, opts()).then(() => null, (e) => e);
  assert.match(err.message, /^Anthropic API error \(401 authentication_error\): invalid x-api-key \[redacted:env:ANTHROPIC_API_KEY\]/);
  assert.ok(err.message.length < 400, `${err.message.length}`);
});

test("ollama: echoed error bodies are scrubbed", async (t) => {
  stubFetch(t, (url) => (url.endsWith("/api/tags") ? json(200, { models: [] }) : json(500, { error: `bad ${PATTERN_ONLY}` })));
  await assert.rejects(callOllama(messages, opts()), (e) => /^Ollama API error \(500\): bad \[redacted:api_key\]$/.test(e.message));
});

test("replicate: echoed error bodies and prediction errors are scrubbed", async (t) => {
  clearReplicateSchemaCache();
  stubFetch(t, (url, init) =>
    init.method === "POST"
      ? json(422, { detail: `token ${REPLICATE} rejected`, invalid_fields: [{ field: PATTERN_ONLY }] })
      : json(200, { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } }));
  const err = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ model: "meta/llama" })).then(() => null, (e) => e);
  assert.match(err.message, /token \[redacted:env:REPLICATE_API_TOKEN\] rejected/);
  assert.ok(clean(err.message), err.message);
  t.mock.restoreAll();
  stubFetch(t, (url, init) =>
    init.method === "POST"
      ? json(200, { status: "failed", error: `crashed with ${REPLICATE}` })
      : json(200, { latest_version: { openapi_schema: { components: { schemas: { Input: { properties: { prompt: {} } } } } } } }));
  const failed = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ model: "meta/llama" })).then(() => null, (e) => e);
  assert.match(failed.message, /prediction failed .*crashed with \[redacted:env:REPLICATE_API_TOKEN\]/);
});
