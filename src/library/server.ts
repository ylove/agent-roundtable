import { readRegularFile } from "../security/fs-safe.js";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { escapeHtml, newCapabilityToken, sameOriginProblem, SecureServer, tokenMatches, type RouteContext } from "../http/secure-server.js";
import { listLibrary } from "./catalog.js";
import { importAgent } from "./import.js";
import { libraryHtml, LIBRARY_CSP, LIBRARY_CSS, LIBRARY_JS } from "./assets.js";

export const ACTION_HEADER = "x-roundtable-action";
export const IMPORTS_PER_MINUTE = 20;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export interface LibraryServer { readonly url: string; close(): Promise<void> }
interface CastingSummary {
  id: string;
  brief: string;
  createdAt: string;
  agents: Array<{ key: string; verdict: string; role?: string }>;
}

/** Casting Call owns the report. A missing, partial or invalid report never breaks discovery. */
export function latestCasting(): CastingSummary | undefined {
  try {
    const path = join(ROUNDTABLE_HOME, "casting", "latest.json");
    const report = JSON.parse(readRegularFile(path, { noFollow: true, maxBytes: MAX_BODY_BYTES }).data.toString("utf8"));
    if (!report || typeof report.id !== "string" || typeof report.brief !== "string" || typeof report.createdAt !== "string" || !Array.isArray(report.agents)) return undefined;
    const agents: CastingSummary["agents"] = [];
    for (const agent of report.agents) {
      if (!agent || typeof agent.key !== "string" || !["cast", "bench", "redundant", "unclear"].includes(agent.verdict) || (agent.role !== undefined && typeof agent.role !== "string")) return undefined;
      agents.push({ key: agent.key, verdict: agent.verdict, ...(agent.role !== undefined && { role: agent.role }) });
    }
    return { id: report.id, brief: report.brief, createdAt: report.createdAt, agents };
  } catch { return undefined; }
}

/** Stop buffering at the cap, including chunked requests; the caller closes refused connections. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (body?: Buffer) => {
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", error);
      resolve(body);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.pause(); finish(); }
      else chunks.push(chunk);
    };
    const end = () => finish(Buffer.concat(chunks, size));
    const error = () => finish();
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", error);
  });
}

/** Loopback capability page. The import route also requires this start's action nonce. */
export async function startLibrary(): Promise<LibraryServer> {
  const nonce = newCapabilityToken();
  const times: number[] = [];
  let server: SecureServer;
  const importFiles = async (c: RouteContext): Promise<void> => {
    const refuse = (status: number, error: string, headers: Record<string, string> = {}) => c.json(status, { error }, { Connection: "close", ...headers });
    const origin = server.origin;
    const problem = sameOriginProblem(c.req, [origin, origin.replace("127.0.0.1", "localhost")]);
    if (problem) return refuse(403, problem);
    const sent = c.req.headers[ACTION_HEADER];
    if (typeof sent !== "string" || !tokenMatches(sent, nonce)) return refuse(403, "This request did not come from the library page. Reload the page and try again.");
    if (c.req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return refuse(415, "Import requires application/json.");
    const now = Date.now();
    while (times.length && now - times[0] >= 60_000) times.shift();
    if (times.length >= IMPORTS_PER_MINUTE) return refuse(429, `At most ${IMPORTS_PER_MINUTE} imports a minute. Wait a moment and try again.`, { "Retry-After": "60" });
    times.push(now);
    if (Number(c.req.headers["content-length"]) > MAX_BODY_BYTES) return refuse(413, "Import accepts at most 2 MiB.");
    const body = await readBody(c.req);
    if (body === undefined) return refuse(413, "Import accepts at most 2 MiB.");
    let input: unknown;
    try { input = JSON.parse(body.toString("utf8")); } catch { return refuse(400, "Invalid import JSON."); }
    const files = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).files : undefined;
    if (!Array.isArray(files) || files.length > 50) return refuse(400, "Import needs a files array of at most 50 files.");
    const results = files.map(file => {
      if (!file || typeof file !== "object" || typeof file.filename !== "string" || typeof file.content !== "string") {
        return { status: "refused", warnings: [], error: "Each file needs a filename and string content." };
      }
      return { filename: file.filename, ...importAgent({ filename: file.filename, content: file.content }) };
    });
    c.json(200, { results });
  };
  server = await SecureServer.start({ name: "Agents library", routes: [
    { path: "/", handler: c => c.html(200, libraryHtml(escapeHtml(nonce)), LIBRARY_CSP) },
    { path: "/library.js", handler: c => c.send(200, LIBRARY_JS, "text/javascript; charset=utf-8") },
    { path: "/library.css", handler: c => c.send(200, LIBRARY_CSS, "text/css; charset=utf-8") },
    { path: "/agents.json", handler: c => { const casting = latestCasting(); c.json(200, { agents: listLibrary(), ...(casting && { casting }) }); } },
    { path: "/import", methods: ["POST"], handler: importFiles },
  ] });
  return { url: server.url, close: () => server.close() };
}
