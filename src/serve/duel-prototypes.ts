// Threat model: archived HTML is hostile. The index token must never reach it, even through
// location.href, document.referrer, a base URL, or an inherited origin. A separate loopback
// listener serves ONLY in-memory, redacted artifacts at public content-hash paths (no capability
// secret). Both the response CSP and the index iframe sandbox omit allow-same-origin. No index
// routes, disk reads, CORS, subresource scripts, forms, frames, workers, or network connections
// are available here. Only a web index.html is HTML; all other files are inert nosniff text.
// CSP cannot stop every browser's self-navigation, but it blocks resource/network APIs; the
// sandbox also denies popups and ancestor navigation. The artifact never possesses the index URL.
// Content hashes are identifiers, not access controls: local processes can read published
// artifacts during the ten-minute idle window. The listener is unref'ed and memory is bounded.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { COMMON_HEADERS } from "../http/secure-server.js";
import { boundHost, hostMatches } from "../http/bind.js";
import { validatePath } from "../prototypes/parse.js";
import type { DuelPrototype } from "./duel-data.js";

export const DUEL_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export interface ArtifactResponse { status: number; body: string; headers: Record<string, string> }
interface Artifact { kind: string; files: Map<string, string>; parentOrigin: string }

export class DuelArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();
  add(prototype: DuelPrototype, parentOrigin: string): string | undefined {
    const files = new Map(prototype.files.flatMap(f => f.content !== undefined && !validatePath(f.path) ? [[f.path, f.content] as const] : []));
    if (!files.size) return;
    const key = createHash("sha256").update(JSON.stringify([prototype.kind, [...files], parentOrigin])).digest("hex");
    this.artifacts.delete(key);
    this.artifacts.set(key, { kind: prototype.kind, files, parentOrigin });
    while (this.artifacts.size > 24) this.artifacts.delete(this.artifacts.keys().next().value!);
    return `/artifacts/${key}/`;
  }
  clear(): void { this.artifacts.clear(); }
  response(target: string, method: string, host: string | undefined, address: string, port: number): ArtifactResponse {
    const headers: Record<string, string> = { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; sandbox" };
    const result = (status: number, body: string): ArtifactResponse => ({ status, body: method === "HEAD" ? "" : body, headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } });
    if (!hostMatches(host, address, port)) return result(421, "Misdirected request");
    if (method !== "GET" && method !== "HEAD") { headers.Allow = "GET, HEAD"; return result(405, "Method not allowed"); }
    // Match the raw request target, without URL normalization, decoding, or filesystem access.
    const match = /^\/artifacts\/([a-f0-9]{64})\/([^?]+)$/.exec(target);
    if (!match || match[2].includes("%") || validatePath(match[2])) return result(404, "Not found");
    const artifact = this.artifacts.get(match[1]), content = artifact?.files.get(match[2]);
    if (!artifact || content === undefined) return result(404, "Not found");
    if (artifact.kind === "web" && match[2] === "index.html") {
      headers["Content-Type"] = "text/html; charset=utf-8";
      headers["Content-Security-Policy"] = `${DUEL_APP_CSP}; frame-ancestors ${artifact.parentOrigin}`;
      // The index and this listener have different origins. The exact CSP ancestor replaces XFO.
      delete headers["X-Frame-Options"];
      headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    }
    return result(200, content);
  }
}

export interface ArtifactListener { origin: string; close(): void }
export type ArtifactListen = (store: DuelArtifactStore) => Promise<ArtifactListener>;
const listen: ArtifactListen = store => new Promise((resolve, reject) => {
  const address = "127.0.0.1";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const { port } = server.address() as AddressInfo;
    const response = store.response(req.url ?? "", req.method ?? "", req.headers.host, address, port);
    res.writeHead(response.status, response.headers); res.end(response.body);
  });
  server.maxConnections = 16;
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  server.on("connection", socket => { socket.setTimeout(10_000, () => socket.destroy()); });
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.once("error", reject);
  server.listen(0, address, () => {
    server.off("error", reject); server.on("error", () => { server.close(); store.clear(); });
    server.unref();
    const { port } = server.address() as AddressInfo;
    resolve({ origin: `http://${boundHost(address, port)}`, close() { server.close(); server.closeAllConnections(); } });
  });
});

/** Lazy and bounded. Tests supply an in-memory listener, so no sockets or browser are needed. */
export class DuelPreviewHost {
  readonly store = new DuelArtifactStore();
  private listener?: Promise<ArtifactListener>;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly start: ArtifactListen = listen) {}
  async publish(prototypes: DuelPrototype[], parentOrigin: string): Promise<Map<number, string>> {
    const urls = new Map<number, string>();
    if (!prototypes.some(p => p.ok && p.kind === "web" && p.files.some(f => f.path === "index.html" && f.content !== undefined))) return urls;
    let parent: URL;
    try { parent = new URL(parentOrigin); } catch { return urls; }
    // Loopback previews are useful only when the index is also opened locally. Tailnet viewers
    // get View code, rather than an unreachable localhost frame on their own machine.
    if (parent.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parent.hostname) || parent.origin !== parentOrigin) return urls;
    try {
      const listener = await (this.listener ??= this.start(this.store));
      for (const p of prototypes) {
        const path = this.store.add(p, parentOrigin);
        if (path && p.ok && p.kind === "web" && p.files.some(f => f.path === "index.html" && f.content !== undefined)) urls.set(p.index, listener.origin + path + "index.html");
      }
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.close(), 10 * 60_000); this.idle.unref();
    } catch { this.listener = undefined; /* View code remains available if the listener cannot bind. */ }
    return urls;
  }
  close(): void {
    clearTimeout(this.idle); this.idle = undefined;
    void this.listener?.then(l => l.close(), () => {}); this.listener = undefined; this.store.clear();
  }
}
