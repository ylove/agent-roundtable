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
import { VERSION, AGENTS_DIR, PROVIDER_IDS, DEFAULT_MODELS, OLLAMA_URL } from "./config.js";
import { tools, handleToolCall } from "./tools.js";

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

  // Check if claude CLI is available for local meetings
  let claudeCliAvailable = false;
  try {
    const { execSync } = await import("child_process");
    execSync("which claude", { stdio: "pipe" });
    claudeCliAvailable = true;
  } catch {
    claudeCliAvailable = false;
  }

  console.error(`agent-roundtable v${VERSION} running on stdio`);
  console.error(`  Agents dir: ${resolve(AGENTS_DIR)}`);
  console.error(`  Default models: ${PROVIDER_IDS.map((p) => `${p}=${DEFAULT_MODELS[p]}`).join(", ")}`);
  console.error(`  Anthropic API key: ${process.env.ANTHROPIC_API_KEY ? "configured" : "NOT configured"}`);
  console.error(`  OpenAI API key: ${process.env.OPENAI_API_KEY ? "configured" : "NOT configured"}`);
  console.error(`  Together AI key (glm, qwen): ${process.env.TOGETHER_API_KEY ? "configured" : "NOT configured"}`);
  console.error(`  Ollama: ${OLLAMA_URL} (optional; checked on use)`);
  console.error(`  Local meetings (CLI): ${claudeCliAvailable ? "available" : "NOT available (install claude CLI)"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
