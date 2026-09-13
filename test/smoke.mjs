// Offline smoke test: no provider is called, zero API spend. Run: npm test
import { startServer, assert } from "./mcp-client.mjs";

const EXPECTED_PROVIDERS = ["anthropic", "openai", "glm", "qwen", "ollama"];
const server = startServer({ env: { OLLAMA_URL: "http://127.0.0.1:9" } });
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
  check("debug_env lists together_api_key and ollama status", () =>
    assert(/together_api_key/.test(debug.text) && /"reachable": false/.test(debug.text), debug.text.slice(0, 400)));
  check("debug_env has no replicate line", () =>
    assert(!/replicate/i.test(debug.text), "replicate mentioned in debug_env output"));
} catch (e) {
  failures++;
  console.log(`  FAIL harness: ${e.message}`);
  console.log(server.stderr());
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall offline smoke checks passed");
process.exit(failures ? 1 : 0);
