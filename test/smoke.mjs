// Offline smoke test: no provider is called, zero API spend. Run: npm test
import { startServer, assert } from "./mcp-client.mjs";

const EXPECTED_PROVIDERS = ["anthropic", "openai", "together", "replicate", "ollama", "openai_compatible"];
// Keys are deliberately absent/unset so no provider can be reached even by accident; a fake
// REPLICATE_API_TOKEN is set only to prove debug_env never echoes any part of a configured key.
const server = startServer({
  env: {
    OLLAMA_URL: "http://127.0.0.1:9",
    OPENAI_COMPATIBLE_BASE_URL: "",
    OPENAI_COMPATIBLE_API_KEY: "",
    REPLICATE_API_TOKEN: "r8_test",
  },
});
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

try {
  await server.init();
  const tools = await server.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const serialized = JSON.stringify(tools);

  console.log("tools/list");
  check("exposes 17 tools", () => assert(tools.length === 17, `got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`));
  for (const name of ["start_meeting", "chat_completion", "start_collaboration"]) {
    check(`${name}.provider enum = ${EXPECTED_PROVIDERS.join("|")}`, () => {
      const e = byName[name]?.inputSchema?.properties?.provider?.enum;
      assert(JSON.stringify(e) === JSON.stringify(EXPECTED_PROVIDERS), `got ${JSON.stringify(e)}`);
    });
    check(`${name}.model description names both Claude ids + aliases`, () => {
      const d = byName[name]?.inputSchema?.properties?.model?.description || "";
      assert(d.includes("claude-opus-5") && d.includes("claude-sonnet-5") && d.includes('"opus"'), d);
    });
    check(`${name}.model description explains Replicate ref forms`, () => {
      const d = byName[name]?.inputSchema?.properties?.model?.description || "";
      assert(d.includes("owner/name:version") && d.includes("https://replicate.com/owner/name"), d);
    });
    check(`${name}.base_url is a string parameter scoped to openai_compatible`, () => {
      const p = byName[name]?.inputSchema?.properties?.base_url;
      assert(p && p.type === "string" && /openai_compatible/.test(p.description), JSON.stringify(p));
    });
    check(`${name}.provider description lists all six providers`, () => {
      const d = byName[name]?.inputSchema?.properties?.provider?.description || "";
      for (const id of EXPECTED_PROVIDERS) assert(d.includes(id), `missing ${id} in: ${d}`);
    });
  }
  for (const name of tools.map((t) => t.name)) {
    if (["start_meeting", "chat_completion", "start_collaboration"].includes(name)) continue;
    check(`${name} has no base_url parameter`, () =>
      assert(!byName[name]?.inputSchema?.properties?.base_url, "unexpected base_url"));
  }
  // The forbidden names are assembled from fragments so this file itself passes the repo hygiene grep
  // (which rejects any file containing the legacy project name or the removed image-tool names).
  const forbidden = new RegExp(["vo" + "uch", "generate_" + "image", "list_image_" + "models"].join("|"), "i");
  check("tool schemas carry no legacy names or image tools", () =>
    assert(!forbidden.test(serialized), "found legacy/image text in tool schemas"));

  console.log("tools/call");
  const unknown = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "grok",
  });
  check("unknown provider is rejected (no silent fallthrough to OpenAI)", () =>
    assert(unknown.isError && /Unknown provider "grok"/.test(unknown.text), unknown.text));
  check("unknown provider error lists the six valid ids", () =>
    assert(unknown.text.includes(`Valid providers: ${EXPECTED_PROVIDERS.join(", ")}`), unknown.text));

  const baseUrlMisuse = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "openai",
    base_url: "http://127.0.0.1:9/v1",
  });
  check("base_url is rejected for providers other than openai_compatible", () =>
    assert(baseUrlMisuse.isError && /base_url is only supported with provider "openai_compatible" \(got "openai"\)/.test(baseUrlMisuse.text), baseUrlMisuse.text));

  const noBase = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "openai_compatible",
  });
  check("openai_compatible without a base URL explains what to set", () =>
    assert(noBase.isError && /OPENAI_COMPATIBLE_BASE_URL/.test(noBase.text) && /base_url/.test(noBase.text), noBase.text));

  const badRef = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "replicate",
    model: "not-a-ref",
  });
  check("replicate rejects a malformed model ref before any request", () =>
    assert(badRef.isError && /Invalid Replicate model "not-a-ref"/.test(badRef.text), badRef.text));

  const ollama = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "ollama",
  });
  check("ollama provider reports unreachable host clearly", () =>
    assert(ollama.isError && /Ollama is not reachable at http:\/\/127\.0\.0\.1:9/.test(ollama.text), ollama.text));

  const debug = await server.callTool("debug_env");
  check("debug_env reports version 0.1.0", () => assert(/"version": "0\.1\.0"/.test(debug.text), debug.text.slice(0, 200)));
  check("debug_env does not leak key material", () =>
    assert(!/sk-[A-Za-z0-9_-]{8,}|r8_[A-Za-z0-9]{8,}/.test(debug.text), "key-like string in debug_env output"));
  check("debug_env reports a configured key as exactly \"configured\" (no prefix, no length)", () =>
    assert(!debug.text.includes("r8_test") && !debug.text.includes("r8_") && /"replicate_api_token": "configured"/.test(debug.text), debug.text.slice(0, 600)));
  check("debug_env lists together_api_key and ollama status", () =>
    assert(/together_api_key/.test(debug.text) && /"reachable": false/.test(debug.text), debug.text.slice(0, 400)));
  check("debug_env reports replicate_api_token and openai_compatible", () =>
    assert(/"replicate_api_token"/.test(debug.text) && /"openai_compatible": \{/.test(debug.text) && /"base_url"/.test(debug.text), debug.text.slice(0, 600)));
  check("debug_env default_models covers all six providers", () => {
    const parsed = JSON.parse(debug.text);
    assert(JSON.stringify(Object.keys(parsed.default_models)) === JSON.stringify(EXPECTED_PROVIDERS), JSON.stringify(parsed.default_models));
  });
} catch (e) {
  failures++;
  console.log(`  FAIL harness: ${e.message}`);
  console.log(server.stderr());
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall offline smoke checks passed");
process.exit(failures ? 1 : 0);
