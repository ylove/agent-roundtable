// ============================================================================
// Secure localhost HTTP server (prototype board, execution dashboard)
//
//   - binds to 127.0.0.1 on a random port; a forgotten server never keeps the process alive
//   - every route lives under a random capability token: http://127.0.0.1:<port>/<token>/...
//     The token is compared in constant time, and a request without it is a plain 404 that says
//     nothing about how close the guess was. The token is never logged.
//   - the Host header must name this server (127.0.0.1:<port> or localhost:<port>), else 421:
//     a DNS-rebinding page cannot read anything
//   - GET and HEAD only (405 otherwise): the server is read-only, so no CSRF protection is needed
//   - strict headers on every response (COMMON_HEADERS) and a Content-Security-Policy per
//     response (DEFAULT_CSP unless the route sets its own)
//   - CONNECT and upgrades are always refused. Absolute-form (proxy) requests are refused too,
//     unless the server is a deny-all proxy (allowProxied), as the prototype board is for the
//     screenshot browser: then only its own origin and the paths allowProxied accepts are served.
// ============================================================================

import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Sent on every response; a route may override one (or drop it with null). */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), " +
    "microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), xr-spatial-tracking=()",
};

/** The policy of any response whose route sets none (errors, JSON, static files). */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A fresh capability token: 18 random bytes, base64url (24 characters). */
export function newCapabilityToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Constant-time token check. Both sides are hashed first, so the comparison takes the same time
 * whatever the candidate's length or how many of its characters are right.
 */
export function tokenMatches(candidate: string, token: string): boolean {
  const a = crypto.createHash("sha256").update(candidate, "utf8").digest();
  const b = crypto.createHash("sha256").update(token, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export type Headers = Record<string, string | null>;

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: "GET" | "HEAD";
  /** The path after the token, starting with "/" ("/" is the root page). Not percent-decoded. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The match of the route's RegExp (null for a string route). */
  readonly match: RegExpExecArray | null;
  /** True for an absolute-form request the deny-all proxy accepted. */
  readonly proxied: boolean;
  /** "/<token>/": prefix links with it. */
  readonly base: string;
  send(status: number, body: string | Buffer, contentType: string, headers?: Headers): void;
  text(status: number, message: string, headers?: Headers): void;
  html(status: number, body: string, csp: string, headers?: Headers): void;
  json(status: number, value: unknown, headers?: Headers): void;
  notFound(): void;
  /**
   * Start a streaming response (server-sent events). Returns null for HEAD, which gets the headers
   * only. The stream ends when the client goes away or the server closes.
   */
  stream(contentType: string, headers?: Headers): ResponseStream | null;
}

export interface ResponseStream {
  write(chunk: string): boolean;
  end(): void;
  /** Runs once, when the stream ends for any reason. */
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface Route {
  /** Exact path ("/state.json") or a RegExp tested against the path after the token. */
  path: string | RegExp;
  handler: RouteHandler;
}

export interface SecureServerOptions {
  /** Label for console.error lines, e.g. "Prototype board". */
  name: string;
  routes: readonly Route[];
  /**
   * Deny-all proxy mode: an absolute-form request for this server's own origin is served only
   * when this accepts its path (after the token). Every other proxied request gets an empty 403.
   */
  allowProxied?: (path: string) => boolean;
  /** Most concurrent connections (default 128). */
  maxConnections?: number;
}

const TEXT = "text/plain; charset=utf-8";

function headerList(base: Record<string, string>, extra: Headers = {}): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export class SecureServer {
  private port = 0;
  private closing?: Promise<void>;
  private readonly token = newCapabilityToken();
  private readonly streams = new Set<ResponseStream>();

  private constructor(
    private readonly opts: SecureServerOptions,
    private readonly server: Server
  ) {}

  /** Listen on 127.0.0.1 with a random port. */
  static start(opts: SecureServerOptions): Promise<SecureServer> {
    const server = createServer();
    const s = new SecureServer(opts, server);
    server.maxConnections = opts.maxConnections ?? 128;
    server.on("request", (req, res) => s.handle(req, res));
    // Never a tunnel or a protocol switch, proxy or not.
    server.on("connect", (_req: IncomingMessage, socket: Duplex) => refuseSocket(socket));
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => refuseSocket(socket));
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (e) => s.log(`server error: ${e.message}`));
        s.port = (server.address() as AddressInfo).port;
        server.unref();
        resolvePromise(s);
      });
    });
  }

  /** "http://127.0.0.1:<port>/<token>/". A capability: hand it to the human, never to a log. */
  get url(): string {
    return `http://127.0.0.1:${this.port}${this.base}`;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** "/<token>/": the path prefix of every route. */
  get base(): string {
    return `/${this.token}/`;
  }

  /** Stop listening, end open streams and drop every connection. Idempotent. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = new Promise<void>((done) => {
        for (const st of [...this.streams]) st.end();
        const timer = setTimeout(done, 2000);
        timer.unref?.();
        this.server.close(() => {
          clearTimeout(timer);
          done();
        });
        this.server.closeAllConnections();
      });
    }
    return this.closing;
  }

  /** Synchronous best-effort stop (process exit). */
  closeNow(): void {
    try {
      for (const st of [...this.streams]) st.end();
      this.server.close();
      this.server.closeAllConnections();
    } catch {
      /* already closed */
    }
  }

  /** console.error with the token removed, whatever the message holds. */
  private log(message: string): void {
    console.error(`[${this.opts.name}] ${message.split(this.token).join("<token>")}`);
  }

  // --------------------------------------------------------------------------

  private send(req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, contentType: string, extra?: Headers): void {
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    res.writeHead(
      status,
      headerList(
        { ...COMMON_HEADERS, "Content-Security-Policy": DEFAULT_CSP, "Content-Type": contentType, "Content-Length": String(buf.length) },
        extra
      )
    );
    if (req.method === "HEAD") res.end();
    else res.end(buf);
  }

  private text(req: IncomingMessage, res: ServerResponse, status: number, message: string, extra?: Headers): void {
    this.send(req, res, status, message + "\n", TEXT, extra);
  }

  /** An empty 403 (a proxied request that is not ours to serve). */
  private refuseProxied(res: ServerResponse): void {
    res.writeHead(403, { ...COMMON_HEADERS, "Content-Security-Policy": DEFAULT_CSP, "Content-Length": "0" });
    res.end();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    void this.route(req, res).catch((e) => {
      this.log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) this.text(req, res, 500, "Internal error");
      else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let target = req.url ?? "/";
    const proxied = !target.startsWith("/");
    if (proxied) {
      // Absolute-form: only a deny-all proxy answers, and only for its own origin.
      if (!this.opts.allowProxied) return this.refuseProxied(res);
      let u: URL | null;
      try {
        u = new URL(target);
      } catch {
        u = null;
      }
      if (!u || u.protocol !== "http:" || u.host !== `127.0.0.1:${this.port}` || u.username || u.password) {
        return this.refuseProxied(res);
      }
      target = u.pathname + u.search;
    }
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return this.text(req, res, 421, "Misdirected request: this server only answers on its own local address.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return this.text(req, res, 405, "Method not allowed: this server is read-only.", { Allow: "GET, HEAD" });
    }
    let url: URL;
    try {
      url = new URL(target, "http://127.0.0.1");
    } catch {
      return this.text(req, res, 400, "Bad request");
    }
    // "/<token>" then the route; anything else does not exist.
    const t = /^\/([^/]*)(\/.*)?$/.exec(url.pathname);
    if (!t || !tokenMatches(t[1], this.token)) return this.text(req, res, 404, "Not found");
    const sub = t[2];
    if (proxied && (sub === undefined || !this.opts.allowProxied!(sub))) return this.refuseProxied(res);
    if (sub === undefined) {
      res.writeHead(308, { ...COMMON_HEADERS, "Content-Security-Policy": DEFAULT_CSP, Location: this.base, "Content-Length": "0" });
      return void res.end();
    }
    for (const r of this.opts.routes) {
      let match: RegExpExecArray | null = null;
      if (typeof r.path === "string") {
        if (r.path !== sub) continue;
      } else {
        match = r.path.exec(sub);
        if (!match) continue;
      }
      return r.handler(this.context(req, res, sub, url.searchParams, match, proxied));
    }
    return this.text(req, res, 404, "Not found");
  }

  private context(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
    match: RegExpExecArray | null,
    proxied: boolean
  ): RouteContext {
    const server = this;
    return {
      req,
      res,
      method: req.method === "HEAD" ? "HEAD" : "GET",
      path,
      query,
      match,
      proxied,
      base: this.base,
      send: (status, body, type, headers) => this.send(req, res, status, body, type, headers),
      text: (status, message, headers) => this.text(req, res, status, message, headers),
      html: (status, body, csp, headers) =>
        this.send(req, res, status, body, "text/html; charset=utf-8", { "Content-Security-Policy": csp, ...headers }),
      json: (status, value, headers) => this.send(req, res, status, JSON.stringify(value), "application/json; charset=utf-8", headers),
      notFound: () => this.text(req, res, 404, "Not found"),
      stream(contentType, headers) {
        return server.openStream(req, res, contentType, headers);
      },
    };
  }

  private openStream(req: IncomingMessage, res: ServerResponse, contentType: string, extra?: Headers): ResponseStream | null {
    res.writeHead(200, headerList({ ...COMMON_HEADERS, "Content-Security-Policy": DEFAULT_CSP, "Content-Type": contentType }, extra));
    if (req.method === "HEAD" || this.closing) {
      res.end();
      return null;
    }
    res.flushHeaders();
    const hooks: Array<() => void> = [];
    let closed = false;
    const st: ResponseStream = {
      write: (chunk) => (closed ? false : res.write(chunk)),
      end: () => {
        if (!closed) res.end();
        finish();
      },
      onClose: (fn) => {
        if (closed) fn();
        else hooks.push(fn);
      },
      get closed() {
        return closed;
      },
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      this.streams.delete(st);
      for (const fn of hooks.splice(0)) {
        try {
          fn();
        } catch {
          /* a hook must not break the others */
        }
      }
    };
    res.on("close", finish);
    res.on("error", finish);
    this.streams.add(st);
    return st;
  }
}

/** Answer a CONNECT or upgrade with 403 and close the socket. */
function refuseSocket(socket: Duplex): void {
  socket.on("error", () => {});
  try {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  } catch {
    socket.destroy();
  }
}
