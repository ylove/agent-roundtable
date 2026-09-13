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
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"), override: true });
