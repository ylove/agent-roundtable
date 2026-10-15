#!/usr/bin/env node

// Must be the first static import: loads .env before config.ts reads process.env (see src/env.ts).
import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "path";
import { VERSION, AGENTS_DIR, SKILLS_DIR, WORKSPACE_DIR, ACTIVITY_LOG_PATH, PROVIDER_IDS, DEFAULT_MODELS, OLLAMA_URL, PUBLISHER_KIND, NTFY_URL, WEBHOOK_URL } from "./config.js";
import { tools, handleToolCall } from "./tools.js";
import { findExecutable } from "./executables.js";
import { describeUrl } from "./security/url-guard.js";
import { finalizeOpenChannels } from "./publishers/index.js";
import { stopLocalMeetingProcesses } from "./sessions/local-meetings.js";
import { destroyAllPrototypes, prototypeDiagnostics, sweepStaleSessionDirs } from "./prototypes/index.js";

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: "agent-roundtable",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args);
});

// ============================================================================
// Main
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Best effort: when the host disconnects or the process is told to stop, flush and close any public
  // channel still open (bounded by the publisher flush timeout) so the topic gets an end and a transcript,
  // and destroy every live prototype (boards stopped, sandboxes removed). Local-meeting CLIs run in their
  // own process groups, so they get no signal of ours: stop them (SIGTERM, then SIGKILL); an exit hook in
  // local-meetings.ts SIGKILLs any still left when the process exits.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.allSettled([finalizeOpenChannels(), destroyAllPrototypes("shutdown"), stopLocalMeetingProcesses()])
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  // Best effort: remove prototype sandboxes left behind by a crashed server. Never fails startup.
  Promise.resolve()
    .then(() => sweepStaleSessionDirs())
    .catch((e) => console.error(`[Prototype] startup sweep skipped: ${e instanceof Error ? e.message : String(e)}`));

  // Check if claude CLI is available for local meetings (PATH scan, no shell)
  const claudeCliAvailable = findExecutable("claude") !== null;

  console.error(`agent-roundtable v${VERSION} running on stdio`);
  console.error(`  Agents dir: ${resolve(AGENTS_DIR)}`);
  console.error(`  Skills dir: ${resolve(SKILLS_DIR)}`);
  console.error(`  Workspace dir: ${resolve(WORKSPACE_DIR)}`);
  console.error(`  Activity log: ${ACTIVITY_LOG_PATH ?? "off"}`);
  console.error(`  Default models: ${PROVIDER_IDS.map((p) => `${p}=${DEFAULT_MODELS[p]}`).join(", ")}`);
  const status = (name: string) => (process.env[name] ? "configured" : "NOT configured");
  console.error(`  anthropic: ANTHROPIC_API_KEY ${status("ANTHROPIC_API_KEY")}`);
  console.error(`  openai: OPENAI_API_KEY ${status("OPENAI_API_KEY")}`);
  console.error(`  together: TOGETHER_API_KEY ${status("TOGETHER_API_KEY")}`);
  console.error(`  replicate: REPLICATE_API_TOKEN ${status("REPLICATE_API_TOKEN")}`);
  // URLs as scheme://host[:port] only: a path or query may carry a token, userinfo a password.
  console.error(`  ollama: ${describeUrl(OLLAMA_URL)} (optional; checked on use)`);
  const compatibleBase = process.env.OPENAI_COMPATIBLE_BASE_URL;
  console.error(
    `  openai_compatible: OPENAI_COMPATIBLE_BASE_URL ${compatibleBase ? describeUrl(compatibleBase) : "NOT SET (pass base_url per call)"}, ` +
      `OPENAI_COMPATIBLE_API_KEY ${process.env.OPENAI_COMPATIBLE_API_KEY ? "configured" : "not set (no auth header)"}`
  );
  console.error(
    `  public sessions: publisher ${PUBLISHER_KIND}` +
      (PUBLISHER_KIND === "webhook" ? ` (${WEBHOOK_URL ? "URL configured" : "URL NOT SET"})` : ` (${describeUrl(NTFY_URL)})`) +
      ` (used only when a session sets public: true)`
  );
  console.error(`  Local meetings (CLI): ${claudeCliAvailable ? "available" : "NOT available (install claude CLI)"}`);
  try {
    const p = prototypeDiagnostics();
    console.error(
      `  Prototype mode: dir ${p.dir}, chrome ${p.chrome ?? "not found"}, ` +
        `screenshots ${p.screenshots ? "on" : "off"}, auto-open ${p.open_browser ? "on" : "off"}`
    );
  } catch (e) {
    console.error(`  Prototype mode: diagnostics unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
