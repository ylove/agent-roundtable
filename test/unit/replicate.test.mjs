import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { json, stubFetch } from "./helpers.mjs";

process.env.REPLICATE_API_TOKEN = "r8_test";

const {
  parseReplicateModelRef,
  formatReplicateModelRef,
  buildReplicateInput,
  normalizeReplicateOutput,
  clearReplicateSchemaCache,
  createReplicateCall,
} = await import("../../dist/providers/replicate.js");

const API = "https://api.replicate.com/v1";
const schemaBody = (keys) => ({
  latest_version: {
    openapi_schema: {
      components: { schemas: { Input: { properties: Object.fromEntries(keys.map((k) => [k, {}])) } } },
    },
  },
});
const versionSchemaBody = (keys) => ({
  openapi_schema: {
    components: { schemas: { Input: { properties: Object.fromEntries(keys.map((k) => [k, {}])) } } },
  },
});
const opts = (extra = {}) => ({
  model: "meta/llama",
  maxTokens: 64,
  signal: new AbortController().signal,
  ...extra,
});
const messages = [{ role: "user", content: "hi" }];
const isSchemaGet = (url, init) => (init.method ?? "GET") === "GET" && url.startsWith(`${API}/models/`);

beforeEach(() => clearReplicateSchemaCache());

describe("parseReplicateModelRef", () => {
  test("accepts every documented form", () => {
    const plain = { owner: "meta", name: "llama" };
    const pinned = { owner: "meta", name: "llama", version: "abc123" };
    assert.deepEqual(parseReplicateModelRef("meta/llama"), plain);
    assert.deepEqual(parseReplicateModelRef("meta/llama:abc123"), pinned);
    assert.deepEqual(parseReplicateModelRef("https://replicate.com/meta/llama"), plain);
    assert.deepEqual(parseReplicateModelRef("https://www.replicate.com/meta/llama/"), plain);
    assert.deepEqual(parseReplicateModelRef("https://replicate.com/meta/llama?x=1#api"), plain);
    assert.deepEqual(parseReplicateModelRef("https://replicate.com/meta/llama/versions/abc123"), pinned);
    assert.deepEqual(parseReplicateModelRef("https://api.replicate.com/v1/models/meta/llama"), plain);
    assert.deepEqual(
      parseReplicateModelRef("https://api.replicate.com/v1/models/meta/llama/versions/abc123"),
      pinned
    );
    assert.deepEqual(parseReplicateModelRef("qwen/qwen3-235b-a22b-instruct-2507"), {
      owner: "qwen",
      name: "qwen3-235b-a22b-instruct-2507",
    });
    assert.equal(formatReplicateModelRef(plain), "meta/llama");
    assert.equal(formatReplicateModelRef(pinned), "meta/llama:abc123");
  });

  test("rejects malformed refs", () => {
    for (const bad of ["", "llama", "a/b/c", "a b/c", "https://example.com/meta/llama", "meta/llama:v-1"]) {
      assert.throws(() => parseReplicateModelRef(bad), /Invalid Replicate model/, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("schema GET", () => {
  test("first request fetches the model schema with the bearer token; cache dedupes", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt", "max_tokens"]));
      return json(200, { status: "succeeded", output: ["ok"] });
    });
    const call = createReplicateCall({ pollIntervalMs: 1 });
    await call(messages, opts());
    await call(messages, opts());
    assert.equal(calls[0].url, `${API}/models/meta/llama`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.Authorization, "Bearer r8_test");
    const schemaGets = calls.filter((c) => isSchemaGet(c.url, c.init));
    assert.equal(schemaGets.length, 1, "exactly one schema GET across two calls");
    assert.equal(calls.length, 3);
  });

  test("versioned ref fetches the version schema", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, versionSchemaBody(["prompt"]));
      return json(200, { status: "succeeded", output: "ok" });
    });
    await createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ model: "meta/llama:abc123" }));
    assert.equal(calls[0].url, `${API}/models/meta/llama/versions/abc123`);
  });

  test("404 surfaces status and model ref, and is not cached", async (t) => {
    let gets = 0;
    stubFetch(t, () => {
      gets++;
      return json(404, { detail: "Not found" });
    });
    const call = createReplicateCall({ pollIntervalMs: 1 });
    await assert.rejects(call(messages, opts()), (e) => {
      assert.match(e.message, /Replicate API error \(404\)/);
      assert.match(e.message, /meta\/llama/);
      assert.match(e.message, /owner\/name:version/);
      return true;
    });
    await assert.rejects(call(messages, opts()), /Replicate API error \(404\)/);
    assert.equal(gets, 2, "a failed schema fetch must not poison the cache");
  });

  test("missing Input schema yields an empty key set (prompt only)", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, { latest_version: {} });
      return json(200, { status: "succeeded", output: ["ok"] });
    });
    await createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ temperature: 0.5 }));
    assert.deepEqual(Object.keys(calls[1].body.input), ["prompt"]);
  });
});

describe("buildReplicateInput", () => {
  const msgs = [
    { role: "system", content: "Be terse." },
    { role: "user", content: "hi" },
  ];
  const schema = (keys) => ({ keys: new Set(keys) });

  test("uses system_prompt, max_tokens and temperature when declared", () => {
    const input = buildReplicateInput(msgs, schema(["prompt", "system_prompt", "max_tokens", "temperature"]), {
      maxTokens: 64,
      temperature: 0.2,
    });
    assert.deepEqual(input, { system_prompt: "Be terse.", prompt: "User: hi\n\n", max_tokens: 64, temperature: 0.2 });
  });

  test("prepends system text and uses max_new_tokens when that is what the model declares", () => {
    const input = buildReplicateInput(msgs, schema(["prompt", "max_new_tokens"]), { maxTokens: 64, temperature: 0.2 });
    assert.deepEqual(input, { prompt: "Be terse.\n\nUser: hi\n\n", max_new_tokens: 64 });
  });

  test("prompt-only schema emits only prompt", () => {
    const input = buildReplicateInput(msgs, schema(["prompt"]), { maxTokens: 64 });
    assert.deepEqual(Object.keys(input), ["prompt"]);
  });

  test("temperature omitted when undefined; transcript renders assistant turns", () => {
    const input = buildReplicateInput(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      schema(["prompt", "temperature", "max_tokens"]),
      { maxTokens: 8 }
    );
    assert.deepEqual(input, { prompt: "User: a\n\nAssistant: b\n\nUser: c\n\n", max_tokens: 8 });
  });

  test("emitted keys are always a subset of the declared keys", () => {
    for (const keys of [
      ["prompt"],
      ["prompt", "system_prompt"],
      ["prompt", "max_tokens", "temperature"],
      ["prompt", "max_new_tokens"],
      ["prompt", "system_prompt", "max_tokens", "max_new_tokens", "temperature", "top_p"],
    ]) {
      const input = buildReplicateInput(msgs, schema(keys), { maxTokens: 5, temperature: 1 });
      for (const k of Object.keys(input)) assert.ok(keys.includes(k), `${k} not declared in ${keys}`);
      assert.ok(!("top_p" in input));
    }
  });
});

describe("prediction POST", () => {
  test("unversioned ref posts to the model predictions URL with Prefer: wait", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt", "max_tokens"]));
      return json(200, { status: "succeeded", output: ["ok"] });
    });
    await createReplicateCall({ pollIntervalMs: 1 })(messages, opts());
    const post = calls[1];
    assert.equal(post.url, `${API}/models/meta/llama/predictions`);
    assert.equal(post.init.method, "POST");
    assert.equal(post.init.headers.Prefer, "wait=60");
    assert.equal(post.init.headers.Authorization, "Bearer r8_test");
    assert.equal(post.init.headers["Content-Type"], "application/json");
    assert.deepEqual(post.body, { input: { prompt: "User: hi\n\n", max_tokens: 64 } });
    assert.ok(!("version" in post.body));
  });

  test("versioned ref posts to /predictions with the version", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, versionSchemaBody(["prompt"]));
      return json(200, { status: "succeeded", output: ["ok"] });
    });
    const r = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ model: "meta/llama:abc123" }));
    assert.equal(calls[1].url, `${API}/predictions`);
    assert.equal(calls[1].body.version, "abc123");
    assert.deepEqual(calls[1].body.input, { prompt: "User: hi\n\n" });
    assert.equal(r.model, "meta/llama:abc123");
  });

  test("422 error carries status, ref, detail and invalid fields", async (t) => {
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      return json(422, { detail: "Input validation failed", invalid_fields: [{ field: "top_p" }] });
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), (e) => {
      assert.match(e.message, /422/);
      assert.match(e.message, /meta\/llama/);
      assert.match(e.message, /Input validation failed/);
      assert.match(e.message, /top_p/);
      return true;
    });
  });
});

describe("normalizeReplicateOutput", () => {
  test("joins chunks and passes strings through", () => {
    assert.equal(normalizeReplicateOutput(["Hel", "lo"], "m"), "Hello");
    assert.equal(normalizeReplicateOutput("plain", "m"), "plain");
  });
  test("rejects empty and unexpected outputs", () => {
    for (const empty of [[], "", null, undefined]) {
      assert.throws(() => normalizeReplicateOutput(empty, "meta/llama"), /returned no text.*meta\/llama/);
    }
    assert.throws(() => normalizeReplicateOutput({}, "meta/llama"), /unexpected output type object/);
    assert.throws(() => normalizeReplicateOutput(42, "meta/llama"), /unexpected output type number/);
  });
});

describe("poll loop", () => {
  const GET_URL = `${API}/predictions/p1`;

  test("polls urls.get until succeeded", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      if (init.method === "POST") return json(201, { status: "processing", urls: { get: GET_URL } });
      const polls = calls.filter((c) => c.url === GET_URL).length;
      return polls === 1 ? json(200, { status: "processing" }) : json(200, { status: "succeeded", output: ["ok"] });
    });
    const r = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts());
    assert.equal(r.content, "ok");
    assert.equal(r.provider, "replicate");
    assert.equal(r.model, "meta/llama");
    const polls = calls.filter((c) => c.url === GET_URL);
    assert.equal(polls.length, 2);
    for (const p of polls) {
      assert.equal(p.init.headers.Authorization, "Bearer r8_test");
      assert.equal(p.init.method ?? "GET", "GET");
    }
  });

  test("strips <think> from output", async (t) => {
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      return json(200, { status: "succeeded", output: ["<think>hmm</think>", "answer"] });
    });
    const r = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts());
    assert.equal(r.content, "answer");
  });

  test("immediate succeeded returns without polling", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      return json(200, { status: "succeeded", output: ["done"], urls: { get: GET_URL } });
    });
    const r = await createReplicateCall({ pollIntervalMs: 1 })(messages, opts());
    assert.equal(r.content, "done");
    assert.equal(calls.length, 2);
  });

  test("failed and canceled predictions throw with detail", async (t) => {
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      return json(200, { status: "failed", error: "boom" });
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), (e) => {
      assert.match(e.message, /failed/);
      assert.match(e.message, /boom/);
      assert.match(e.message, /meta\/llama/);
      return true;
    });
    clearReplicateSchemaCache();
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      if (init.method === "POST") return json(201, { status: "starting", urls: { get: GET_URL } });
      return json(200, { status: "canceled" });
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), /canceled.*meta\/llama.*no error detail/);
  });

  test("missing polling URL and non-OK poll are reported", async (t) => {
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      return json(201, { status: "processing" });
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), /no polling URL for model meta\/llama/);
    clearReplicateSchemaCache();
    stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      if (init.method === "POST") return json(201, { status: "processing", urls: { get: GET_URL } });
      return json(500, {});
    });
    await assert.rejects(createReplicateCall({ pollIntervalMs: 1 })(messages, opts()), /Replicate API error \(500\) polling model meta\/llama/);
  });

  test("caller's signal aborts a never-finishing poll and stops all fetching", async (t) => {
    const calls = stubFetch(t, (url, init) => {
      if (isSchemaGet(url, init)) return json(200, schemaBody(["prompt"]));
      if (init.method === "POST") return json(201, { status: "processing", urls: { get: GET_URL } });
      return json(200, { status: "processing" });
    });
    await assert.rejects(
      createReplicateCall({ pollIntervalMs: 1 })(messages, opts({ signal: AbortSignal.timeout(30) })),
      (e) => {
        assert.ok(e.name === "AbortError" || e.name === "TimeoutError", `got ${e.name}: ${e.message}`);
        return true;
      }
    );
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, after, "no fetch after the rejection");
  });
});
