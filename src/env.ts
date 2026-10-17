import { config } from "dotenv";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

// Load environment variables from the .env file next to package.json (dist/env.js -> ../.env).
// override: true so .env is the single source of truth even if the MCP host passes stale env values.
//
// This module MUST be the first static import of src/index.ts. ESM evaluates every import before the
// importing module's own body runs, so if dotenv were called from index.ts's body, config.ts (which
// reads process.env at module-evaluation time) would already have run against an unloaded .env.
// Importing "./env.js" first guarantees .env is loaded before config.ts is evaluated.
// quiet: true — dotenv 17 otherwise prints an "injected env" line to STDOUT, which is the MCP JSON-RPC channel.
//
// ROUNDTABLE_DOTENV=off skips .env entirely: worker MCP servers start keyless, with only the
// environment their launcher gave them. The processes a worker starts (`mcp --worker`, and the
// lease hook) never load it either, whatever their environment says.
const [command, ...rest] = process.argv.slice(2);
const workerProcess = command === "hook" || (command === "mcp" && rest.includes("--worker"));
if (!workerProcess && (process.env.ROUNDTABLE_DOTENV ?? "").trim().toLowerCase() !== "off") {
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"), override: true, quiet: true });
}
