// Opt-in live smoke: one tiny chat_completion per provider (max_tokens 128).
// Run: ROUNDTABLE_LIVE_TEST=1 npm run test:live   (ROUNDTABLE_LIVE_PROVIDERS=anthropic,openai,glm,qwen to narrow)
import { startServer } from "./mcp-client.mjs";

if (process.env.ROUNDTABLE_LIVE_TEST !== "1") {
  console.log("skipped (set ROUNDTABLE_LIVE_TEST=1 to spend a few tiny API calls)");
  process.exit(0);
}

const providers = (process.env.ROUNDTABLE_LIVE_PROVIDERS || "anthropic,openai,glm,qwen")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
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
