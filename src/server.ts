// ============================================================================
// MCP stdio servers: the orchestrator's (no arguments) and a heads-down worker's (mcp --worker)
//
// The orchestrator server lists every orchestrator tool and holds the provider keys from .env.
// A worker server is started by one worker through its generated mcp.json, keyless
// (ROUNDTABLE_DOTENV=off): it consumes its single-use token before it serves anything, lists only
// the seven worker tools, and stamps every event it writes with the worker's agent id.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { VERSION, AGENTS_DIR, SKILLS_DIR, WORKSPACE_DIR, ACTIVITY_LOG_PATH, PROVIDER_IDS, DEFAULT_MODELS, OLLAMA_URL, PUBLISHER_KIND, NTFY_URL, WEBHOOK_URL } from "./config.js";
import { handleToolCall, toolsFor, type ToolMode } from "./tools.js";
import { findExecutable } from "./executables.js";
import { describeUrl } from "./security/url-guard.js";
import { finalizeOpenChannels } from "./publishers/index.js";
import { stopLocalMeetingProcesses } from "./sessions/local-meetings.js";
import { destroyAllPrototypes, prototypeDiagnostics, sweepStaleSessionDirs } from "./prototypes/index.js";
import { killAllSandboxed } from "./sandbox/index.js";
import { bindWorkerIdentity } from "./tools/worker.js";
import { startTableService } from "./usage/table-service.js";
import { consumeWorkerToken } from "./workers/token.js";

// ============================================================================
// Server
// ============================================================================

/** An MCP server offering the tools of one mode, with progress notifications when the client asks for them. */
export function buildServer(mode: ToolMode): Server {
  const server = new Server({ name: "agent-roundtable", version: VERSION }, { capabilities: { tools: {} } });
  const listed = toolsFor(mode);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const token = request.params._meta?.progressToken;
    const progress =
      token === undefined
        ? undefined
        : (progress: number, total?: number, message?: string) => {
            const note = {
              method: "notifications/progress",
              params: { progressToken: token, progress, ...(total !== undefined && { total }), ...(message && { message }) },
            } as ServerNotification;
            extra.sendNotification(note).catch(() => {
              /* the client went away; the call itself still completes */
            });
          };
    return handleToolCall(name, args, mode, { ...(progress && { progress }), signal: extra.signal });
  });
  return server;
}

export interface WorkerServerOptions {
  execution: string;
  agent: string;
  tokenFile: string;
}

/** Start the stdio server of a mode. A worker server first consumes its token and refuses to start without a valid one. */
export async function startStdio(mode: ToolMode = "orchestrator", worker?: WorkerServerOptions): Promise<void> {
  if (mode === "worker") {
    process.umask(0o077);
    return startWorker(worker);
  }
  return startOrchestrator();
}

// ============================================================================
// Worker server
// ============================================================================

async function startWorker(opts: WorkerServerOptions | undefined): Promise<void> {
  if (!opts) throw new Error("A worker server needs --execution, --agent and --token-file");
  const id = await consumeWorkerToken(opts);
  bindWorkerIdentity({ store: id.store, execution: id.execution, agent: id.agent, tokenSha256: id.record.token_sha256 });
  const server = buildServer("worker");
  await server.connect(new StdioServerTransport());
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAllSandboxed().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  console.error(`agent-roundtable v${VERSION} worker server: agent ${id.agent} in ${id.execution} (${toolsFor("worker").length} tools)`);
}

// ============================================================================
// Orchestrator server
// ============================================================================

async function startOrchestrator(): Promise<void> {
  const server = buildServer("orchestrator");
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Best effort: when the host disconnects or the process is told to stop, flush and close any public
  // channel still open (bounded by the publisher flush timeout) so the topic gets an end and a transcript,
  // and destroy every live prototype (boards stopped, sandboxes removed). Local-meeting CLIs run in their
  // own process groups, so they get no signal of ours: stop them (SIGTERM, then SIGKILL); an exit hook in
  // local-meetings.ts SIGKILLs any still left when the process exits. Sandboxed commands of external
  // workers' run_command and submit_work calls are killed too.
  // Usage visibility: the live file other processes read, and the stop requests they leave for this server's sessions.
  const table = startTableService();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    table.close();
    Promise.allSettled([finalizeOpenChannels(), destroyAllPrototypes("shutdown"), stopLocalMeetingProcesses(), killAllSandboxed()])
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

  // Best effort: the retention sweep (finished runs, archived sessions, audit months). Never fails startup.
  import("./execution/retention.js")
    .then(async ({ sweepRetention, describeRetention }) => console.error(describeRetention(await sweepRetention())))
    .catch((e) => console.error(`[Retention] startup sweep skipped: ${e instanceof Error ? e.message : String(e)}`));

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
