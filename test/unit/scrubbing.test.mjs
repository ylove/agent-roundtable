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

test("a numeric max_tokens in a validation error survives while real secrets are still redacted", async () => {
  const { scrubSecrets } = await import("../../dist/security/secrets.js");
  assert.equal(scrubSecrets("422 input.max_tokens: 32768 is too large").text, "422 input.max_tokens: 32768 is too large");
  assert.match(scrubSecrets("api_key: sk-abcdefghijklmnopqrstuvwxyz0123").text, /redacted/);
  assert.match(scrubSecrets("max_tokens: hunter2hunter2").text, /redacted/);
  assert.match(scrubSecrets("access_token: 123456789012").text, /redacted/);
});

test("artifact scrubbing keeps ordinary identifiers byte for byte and still redacts credential shapes", async () => {
  const { scrubArtifact, scrub } = await import("../../dist/security/secrets.js");
  const code = [
    "private readonly state: Map<string, { tokens: number; lastRefill: number }>;",
    "let tokens = 5;",
    "const secretKey = options.secretKey;",
    "password: string;",
    'const apiKeyHeader = "X-Api-Key";',
    'apiKeyHeader = "X-Api-Key"',
    "const token = getToken();",
    "const tokensToAdd = (elapsed / 1000) * this.refillRate;",
  ].join("\n");
  assert.equal(scrubArtifact(code), code);
  assert.notEqual(scrub('let tokens = 5; apiKeyHeader = "X-Api-Key"'), 'let tokens = 5; apiKeyHeader = "X-Api-Key"', "turn text keeps the full scrubber");

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF123_-";
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const doc = [
    "key = sk-ant-api03-ABCDEFGHIJKLMNOP", "gh ghp_abcdefghijklmnopqrstuvwxyz0123", pem, jwt,
    "Authorization: Bearer abcdef1234567890xyz", "postgres://admin:hunter2pw@db.example.com/x", `const k = "${PATTERN_ONLY}"; // ${ANTHROPIC}`,
  ].join("\n");
  const out = scrubArtifact(doc);
  for (const leaked of ["sk-ant-api03-ABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz0123", "MIIEowIBAAKCAQEA", jwt, "abcdef1234567890xyz", "hunter2pw", ANTHROPIC]) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.ok(out.includes("[redacted:env:ANTHROPIC_API_KEY]"));
});

test("numeric token-limit exemptions cover quoted and dotted fields without exempting credentials", async () => {
  const { redactSecrets } = await import("../../dist/security/redaction-rules.js");
  const { scrubSecrets } = await import("../../dist/security/secrets.js");
  for (const field of ["max_tokens", "max_new_tokens", "max_completion_tokens", "MAX_TOKENS"]) {
    for (const prefix of ["", "input."]) {
      for (const quote of ["", '"', "'"]) {
        for (const separator of [": ", " = "]) {
          const input = `${quote}${prefix}${field}${quote}${separator}${quote}32768${quote}`;
          assert.deepEqual(redactSecrets(input), { text: input, counts: {} });
          assert.deepEqual(scrubSecrets(input, {}), { text: input, redactions: 0 });
        }
      }
    }
    const input = `${field}: 32768; access_token: 123456789012; ${field}="opaque-value"`;
    assert.deepEqual(redactSecrets(input), {
      text: `${field}: 32768; access_token: [redacted:secret]; ${field}="[redacted:secret]"`,
      counts: { secret: 2 },
    });
  }
  for (const input of ["prefix_max_tokens: 32768", "max_tokens_extra: 32768", "max_tokens: 32768x"]) {
    assert.equal(redactSecrets(input).counts.secret, 1, input);
  }
});

test("normal and artifact modes scrub private literals inherited by a runner, including numeric values", async (t) => {
  const { childEnv } = await import("../../dist/security/child-env.js");
  const { SCRUB_LITERALS_ENV, scrubSecrets, scrubArtifactSecrets, scrubArtifact } = await import("../../dist/security/secrets.js");
  const literal = "opaque.literal+[123456]";
  const longer = `${literal}-longer`;
  const numeric = "12345678";
  const env = childEnv("runner", {}, {
    DATABASE_PASSWORD: literal,
    [SCRUB_LITERALS_ENV]: JSON.stringify([longer, numeric]),
  });
  assert.equal(env.DATABASE_PASSWORD, undefined);
  const input = `plain ${longer} ${literal} ${literal}; max_tokens: ${numeric}; max_new_tokens: 32768; password: string;`;
  const artifact = "plain [redacted:env:ROUNDTABLE_SCRUB_LITERALS] [redacted:env:ROUNDTABLE_SCRUB_LITERALS] [redacted:env:ROUNDTABLE_SCRUB_LITERALS]; max_tokens: [redacted:env:ROUNDTABLE_SCRUB_LITERALS]; max_new_tokens: 32768; password: string;";
  assert.deepEqual(scrubArtifactSecrets(input, env), { text: artifact, redactions: 4 });
  assert.deepEqual(scrubSecrets(input, env), {
    text: artifact.replace("password: string", "password: [redacted:secret]"), redactions: 5,
  });
  const previous = process.env[SCRUB_LITERALS_ENV];
  process.env[SCRUB_LITERALS_ENV] = env[SCRUB_LITERALS_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[SCRUB_LITERALS_ENV];
    else process.env[SCRUB_LITERALS_ENV] = previous;
  });
  assert.equal(scrubArtifact(input), artifact, "the artifact convenience function also uses private literals");
});

test("artifact and normal modes share the hardened Basic, Bearer and sk rules", async () => {
  const { redactSecrets, redactArtifactSecrets } = await import("../../dist/security/redaction-rules.js");
  for (const redact of [redactSecrets, redactArtifactSecrets]) {
    for (const scheme of ["Basic", "Bearer"]) {
      for (const token of ["YWJjOmRlZmdo", "abc", "a1+/"]) {
        const kind = scheme === "Basic" ? "basic_auth" : "bearer";
        const out = redact(`Authorization: ${scheme} ${token}`);
        assert.ok(!out.text.includes(token));
        assert.ok(out.text.includes(`[redacted:${kind}]`));
        assert.equal(out.counts[kind], 1);
        if (redact === redactArtifactSecrets) {
          assert.equal(out.text, `Authorization: ${scheme} [redacted:${kind}]`);
        }
      }
    }
    assert.deepEqual(redact("sk-" + "z".repeat(32)), { text: "[redacted:api_key]", counts: { api_key: 1 } });
  }
});

test("a secret word inside a generated id is not a secret key; named keys still are", async () => {
  const { scrub } = await import("../../dist/security/secrets.js");
  // Random execution ids can contain "pwd", "auth" or "token"; markers built from them must survive.
  for (const id of ["exe-01m5rpwdqrx8mtc2", "exe-0auth9k2m4p6r8t1", "exe-1x2tokenq9w8e7r6"]) {
    assert.equal(scrub(`<!-- roundtable:${id}:b:e1 -->`), `<!-- roundtable:${id}:b:e1 -->`);
  }
  for (const line of ["API_KEY=abcdefgh12", "db_password: hunter2hunter", "accessToken=abcd1234efgh", "MYSQL_PWD=passw0rd!", "githubtoken2: abcdefghij", "x-api-key: abcdefghij"]) {
    assert.match(scrub(line), /\[redacted:secret\]$/, line);
  }
});
