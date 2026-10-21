import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { loadUserEnvironment } from "./user-config.js";

// Keep this the first static import in index.ts: config.ts reads its defaults during evaluation.
// Keep package .env overrides; the configured env file fills allowed unset keys only.
// Workers and hooks never load either file or the user's persisted settings.
const [command, ...rest] = process.argv.slice(2);
const workerProcess = command === "hook" || (command === "mcp" && rest.includes("--worker"));
if (!workerProcess) {
  loadUserEnvironment({ packageEnvFile: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
}
