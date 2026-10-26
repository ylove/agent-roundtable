#!/usr/bin/env node

// Must be the first static import: loads .env before config.ts reads process.env (see src/env.ts).
import "./env.js";

// No arguments (or only options) is the MCP stdio orchestrator server, exactly as before; a first
// argument that is a word is a subcommand (src/cli.ts). Both load lazily: the lease hook runs before
// every edit a worker makes and must not pay for the server's imports.
const sub = process.argv[2];
// Heads-down processes create private files; the orchestrator keeps the host's umask.
if (sub && !sub.startsWith("-") && (sub !== "mcp" || process.argv.slice(3).includes("--worker"))) process.umask(0o077);
try {
  if (sub !== undefined && (!sub.startsWith("-") || sub === "--version" || sub === "-v")) {
    const { runCli } = await import("./cli.js");
    await runCli(process.argv.slice(2));
  } else {
    const { startStdio } = await import("./server.js");
    await startStdio("orchestrator");
  }
} catch (error) {
  console.error("Fatal error:", error);
  process.exit(sub === "hook" ? 2 : 1);
}
