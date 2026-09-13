// Opt-in live smoke: one tiny chat_completion per provider (max_tokens 128). Spends real API credits.
// Run: ROUNDTABLE_LIVE_TEST=1 npm run test:live
//   ROUNDTABLE_LIVE_PROVIDERS=anthropic,openai,together   narrows or widens the provider list (default shown)
//   ROUNDTABLE_LIVE_REPLICATE=1                            also calls replicate (default model; ~1 min cold start)
//   ROUNDTABLE_LIVE_OPENAI_COMPATIBLE=1                    also calls openai_compatible (needs OPENAI_COMPATIBLE_BASE_URL)
//   ROUNDTABLE_LIVE_OLLAMA=1                               also calls ollama (needs a reachable OLLAMA_URL)
// replicate and openai_compatible are never called unless opted in via their flag or listed explicitly.
import { startServer } from "./mcp-client.mjs";

if (process.env.ROUNDTABLE_LIVE_TEST !== "1") {
  console.log("skipped (set ROUNDTABLE_LIVE_TEST=1 to spend a few tiny API calls)");
  process.exit(0);
}

const providers = (process.env.ROUNDTABLE_LIVE_PROVIDERS || "anthropic,openai,together")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
if (process.env.ROUNDTABLE_LIVE_REPLICATE === "1" && !providers.includes("replicate")) providers.push("replicate");
if (process.env.ROUNDTABLE_LIVE_OPENAI_COMPATIBLE === "1" && !providers.includes("openai_compatible")) {
  providers.push("openai_compatible");
}
const server = startServer({ timeoutMs: 300_000 });
let failures = 0;

async function tinyCall(label, args) {
  const started = Date.now();
  const r = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 128,
    ...args,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const oneLine = r.text.replace(/\s+/g, " ").slice(0, 160);
  if (r.isError) {
    failures++;
    console.log(`  FAIL ${label} (${secs}s): ${oneLine}`);
  } else {
    console.log(`  ok   ${label} (${secs}s): ${oneLine}`);
  }
}

try {
  await server.init();
  for (const provider of providers) await tinyCall(provider, { provider });
  if (providers.includes("anthropic")) {
    await tinyCall('anthropic model:"opus" alias', { provider: "anthropic", model: "opus" });
  }
  if (process.env.ROUNDTABLE_LIVE_OLLAMA === "1") await tinyCall("ollama", { provider: "ollama" });
} catch (e) {
  failures++;
  console.log(`  FAIL harness: ${e.message}`);
  console.log(server.stderr());
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall live smoke calls succeeded");
process.exit(failures ? 1 : 0);
