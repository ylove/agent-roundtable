#!/usr/bin/env node
// Writes package.json's version into every distribution file that repeats it.
// Runs from npm's `version` lifecycle script; takes no dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const write = (p, v) => writeFileSync(join(root, p), JSON.stringify(v, null, 2) + "\n");

const { version } = read("package.json");

const server = read("server.json");
server.version = version;
for (const pkg of server.packages ?? []) if (pkg.registryType === "npm") pkg.version = version;
write("server.json", server);

const plugin = read("plugins/agent-roundtable/.claude-plugin/plugin.json");
plugin.version = version;
write("plugins/agent-roundtable/.claude-plugin/plugin.json", plugin);

const market = read(".claude-plugin/marketplace.json");
for (const entry of market.plugins) if (entry.name === plugin.name) entry.version = version;
write(".claude-plugin/marketplace.json", market);

const mcp = read("plugins/agent-roundtable/.mcp.json");
for (const srv of Object.values(mcp.mcpServers)) {
  srv.args = srv.args.map((a) => a.replace(/^agent-roundtable@.*$/, `agent-roundtable@${version}`));
}
write("plugins/agent-roundtable/.mcp.json", mcp);

const configPath = join(root, "src/config.ts");
const config = readFileSync(configPath, "utf8");
const synced = config.replace(/^export const VERSION = "[^"]*";$/m, `export const VERSION = "${version}";`);
if (!/^export const VERSION = "/m.test(config)) throw new Error("src/config.ts has no VERSION constant to sync");
writeFileSync(configPath, synced);

console.log(`distribution files set to ${version}`);
