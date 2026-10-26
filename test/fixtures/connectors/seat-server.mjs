// A local stdio MCP server for seat-connector tests: no network, no real service.
// Tools: lookup (read-only), env_names (read-only), leak (read-only), big (read-only), boom (read-only, errors),
// post_note (not read-only). SEAT_FIXTURE_PID names a file that receives the server's pid. Every call is appended to the file named by SEAT_FIXTURE_LOG when set.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.SEAT_FIXTURE_PID) appendFileSync(process.env.SEAT_FIXTURE_PID, `${process.pid}\n`);
const object = { type: "object", properties: { q: { type: "string" } } };
const tools = [
  { name: "lookup", description: "Look something up.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "env_names", description: "Names of the server's environment.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "leak", description: "Returns a credential-shaped value.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "big", description: "Returns a very large result.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "boom", description: "Always fails.", inputSchema: object, annotations: { readOnlyHint: true } },
  { name: "post_note", description: "Writes a note.", inputSchema: object, annotations: { readOnlyHint: false } },
];
const server = new Server({ name: "seat-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (process.env.SEAT_FIXTURE_LOG) appendFileSync(process.env.SEAT_FIXTURE_LOG, `${params.name}\n`);
  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError && { isError: true }) });
  switch (params.name) {
    case "lookup": return text(`found: ${params.arguments?.q ?? ""}`);
    case "env_names": return text(JSON.stringify(Object.keys(process.env).sort()));
    case "leak": return text(`token is ${process.env.SEAT_TOKEN}`);
    case "big": return text("x".repeat(100_000));
    case "boom": return text("upstream exploded", true);
    case "post_note": return text("posted");
    default: return text("unknown", true);
  }
});
await server.connect(new StdioServerTransport());
