// ============================================================================
// Execution dashboard: a local web view of one heads-down run
//
// Served by the runner on the shared secure server (src/http/secure-server.ts): 127.0.0.1, a
// capability token in every URL, Host check, GET and HEAD, strict headers. Steering, pausing and
// resolving stay in the orchestrator's tools. One mutating route is the Usage page's Stop button:
// POST <token>/agents/<agent>/stop (usage-visibility.md §7, heads-down.md §14). Because the page is
// served from this origin, it is protected as a CSRF target: the request must carry
// X-Roundtable-Action: <nonce>, a second random value made per dashboard start and delivered only
// inside the Usage page (a <meta> element); a custom header forces a CORS preflight this server never
// approves, so no other origin can send it. Origin and Sec-Fetch-Site, when present, must say
// same-origin; a body is refused; at most 10 stops a minute. Pages read the run through the execution
// store (lock-free reads) and are rendered on the server with every run-derived string redacted and
// escaped (render.ts). The Postmortems page also accepts lesson sign-off, with its own action
// nonce, bounded JSON, loopback-only access and the shared CLI sign-off checks (signoff below).
//
// Live updates: GET <token>/stream?since=<seq> is a server-sent event stream that sends
// "rev" {seq} whenever the event log grows; the page script falls back to polling
// <token>/state.json, a redacted subset of the blackboard.
// ============================================================================

import { readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { openExecutionStore } from "../execution/store.js";
import type { BlackboardState, ExecutionStore } from "../execution/types.js";
import { hasBody, newCapabilityToken, sameOriginProblem, SecureServer, tokenMatches, type ResponseStream, type RouteContext } from "../http/secure-server.js";
import { livePreviews, previewOrigins, previewScreenshotRoute, withFrameSrc } from "../previews/embed.js";
import type { PreviewRecord } from "../previews/store.js";
import { collectUsage } from "../usage/model.js";
import { requestAgentStop, StopRefusal, stopper } from "../usage/stop.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { signOffPostmortem, validateSignoffIdentity } from "../postmortem/meeting.js";
import { ARTIFACT_ID_RE, LIMITS, PM_ID_RE } from "../postmortem/types.js";
import { runPage, loadTaskDetail, eventsPage, contractPage, postmortemsPage, runnerHealth } from "./data.js";
export { capAtLine } from "./data.js";
import { STATIC_ASSETS } from "./assets.js";
import { renderDagSvg } from "./dag-svg.js";
import { renderUsage, usageSpendSeries, type SpendSeries } from "./usage-page.js";
import {
  publicState,
  renderDagPage,
  renderDissents,
  renderEscalations,
  renderTaskDetail,
  renderTasks,
  type PageContext,
  type RunnerHealth,
} from "./render.js";

/** Every dashboard page. No inline script or style anywhere, nothing from outside 'self'. */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Most concurrent event streams; more get 503 and the page falls back to polling. */
const MAX_STREAMS = 32;
const KEEPALIVE_MS = 15_000;
/** The header an action request must carry, with its surface's per-start nonce. */
export const ACTION_HEADER = "x-roundtable-action";
/** Most stop requests a dashboard accepts a minute. */
export const STOPS_PER_MINUTE = 10;
export const SIGNOFFS_PER_MINUTE = 10;
export const MAX_SIGNOFF_BODY_BYTES = 16 * 1024;

/** Stop buffering at the cap, including chunked requests; refused connections are closed. */
function readSignoffBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (body?: Buffer) => {
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", error);
      // Keep the error listener until close, including after a size refusal.
      resolve(body);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SIGNOFF_BODY_BYTES) { req.pause(); finish(); }
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

export interface DashboardOptions {
  /** The store to read through (default: openExecutionStore(executionId)). */
  store?: ExecutionStore;
  /** How often the event log is checked while streams are open, in ms (default 500). */
  pollMs?: number;
  /** Write executions/<exe>/dashboard.json {url, pid, host, started_at} (default true); removed on close. */
  writeInfo?: boolean;
  /** Called after a stop request was recorded: the runner this dashboard lives in runs its next tick at once. */
  onStopRequested?: () => void;
}

export interface Dashboard {
  /** "http://127.0.0.1:<port>/<token>/": a capability. Give it to the human; never log it. */
  readonly url: string;
  close(): Promise<void>;
}

/** Start the dashboard of one execution on 127.0.0.1 (random port). */
export async function startDashboard(executionId: string, opts: DashboardOptions = {}): Promise<Dashboard> {
  const store = opts.store ?? (await openExecutionStore(executionId));
  if (store.id !== executionId) throw new Error(`startDashboard: the store is ${store.id}, not ${executionId}`);
  const d = new DashboardServer(store, opts);
  await d.start();
  return { url: d.url, close: () => d.close() };
}

interface Client {
  stream: ResponseStream;
  seq: number;
  lastWrite: number;
}

class DashboardServer {
  private server?: SecureServer;
  private readonly clients = new Set<Client>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private seq = 0;
  private logSize = -1;
  private warned = false;
  private readonly infoPath: string;
  /** The nonce stop requests carry: made per start, delivered only inside the Usage page, compared by digest. */
  private readonly nonce = newCapabilityToken();
  /** A separate per-start nonce delivered only in the Postmortems page's meta element. */
  private readonly signoffNonce = newCapabilityToken();
  private readonly signoffTimes: number[] = [];
  /** When the last accepted stop requests came in (ms), for the per-minute limit. */
  private readonly stopTimes: number[] = [];

  constructor(
    private readonly store: ExecutionStore,
    private readonly opts: DashboardOptions
  ) {
    this.infoPath = join(store.dir, "dashboard.json");
  }

  get url(): string {
    return this.server!.url;
  }

  async start(): Promise<void> {
    const page = (fn: (c: RouteContext) => Promise<string | undefined>) => async (c: RouteContext) => {
      const html = await fn(c);
      if (html === undefined) return c.notFound();
      c.html(200, html, DASHBOARD_CSP);
    };
    this.server = await SecureServer.start({
      name: "Dashboard",
      routes: [
        previewScreenshotRoute(() => livePreviews(r => r.source.execution === this.store.id)),
        { path: "/", handler: page(async () => (await runPage(this.store, await this.context(), ""))!) },
        { path: "/tasks", handler: page(async () => renderTasks(await this.context())) },
        { path: "/usage", handler: page(() => this.usagePage()) },
        { path: /^\/agents\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/stop$/, methods: ["POST"], handler: (c) => this.stopAgent(c) },
        { path: /^\/tasks\/([a-z0-9][a-z0-9._-]{0,63})$/, handler: async (c) => {
          // Only live and click previews add frame origins to the CSP.
          const id = c.match![1];
          const previews = livePreviews((r) => r.source.execution === this.store.id && r.source.task === id, true);
          const html = await this.taskPage(id, previews);
          if (html === undefined) return c.notFound();
          c.html(200, html, withFrameSrc(DASHBOARD_CSP, previewOrigins(previews)));
        } },
        { path: /^\/escalations\/([^/]+)$/, handler: page(async c => runPage(this.store, await this.context(), `escalations/${c.match![1]}`)) },
        { path: "/escalations", handler: page(async () => renderEscalations(await this.context())) },
        { path: "/dissents", handler: page(async () => renderDissents(await this.context())) },
        { path: "/events", handler: page((c) => this.eventsPage(c.query)) },
        { path: "/contract", handler: page(() => this.contractPage()) },
        { path: "/postmortems", handler: page(() => this.postmortemsPage()) },
        { path: new RegExp(`^/postmortems/(${PM_ID_RE.source.slice(1, -1)})/signoff$`), methods: ["POST"], handler: (c) => this.signoff(c) },
        { path: "/dag", handler: page(async () => renderDagPage(await this.context())) },
        { path: "/dag.svg", handler: (c) => this.dagSvg(c) },
        { path: "/state.json", handler: async (c) => c.json(200, publicState(await this.store.state(), this.runnerHealth())) },
        { path: "/stream", handler: (c) => this.openStream(c) },
        { path: /^\/static\/([a-z-]+\.(?:css|js))$/, handler: (c) => this.asset(c) },
      ],
    });
    if (this.opts.writeInfo !== false) {
      try {
        writeFileAtomic(
          this.infoPath,
          JSON.stringify({ url: this.server.url, pid: process.pid, host: hostname(), started_at: new Date().toISOString() }) + "\n"
        );
      } catch (e) {
        console.error(`[Dashboard] ${this.store.id}: cannot write dashboard.json: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.clients) c.stream.end();
    this.clients.clear();
    if (this.opts.writeInfo !== false && this.server) {
      try {
        if (JSON.parse(readFileSync(this.infoPath, "utf8")).url === this.server.url) rmSync(this.infoPath, { force: true });
      } catch {
        /* gone already, or another dashboard's */
      }
    }
    await this.server?.close();
  }

  // --------------------------------------------------------------------------

  /** Who is using what in this run (the run's own agents; the at-the-table ledger is not part of it). */
  private usage() {
    return collectUsage({ executions: [this.store.id], table: false });
  }

  /** Cumulative spend over time by agent, and for the whole run under "", from the usage events. */
  private async spendSeries(): Promise<SpendSeries> {
    return usageSpendSeries(await this.store.events({ types: ["budget.usage_recorded"] }));
  }

  private async usagePage(): Promise<string> {
    const state = await this.store.state();
    return renderUsage({ ...(await this.context(state)), nonce: this.nonce }, await this.usage(), await this.spendSeries());
  }

  /**
   * POST <token>/agents/<agent>/stop (usage-visibility.md §7). Checked in this order: same origin
   * (Origin, Sec-Fetch-Site), the action header against this start's nonce, no body, the rate limit,
   * the agent. The nonce and the token are never logged.
   */
  private async stopAgent(c: RouteContext): Promise<void> {
    const refuse = (status: number, error: string, headers?: Record<string, string>) => c.json(status, { error }, headers);
    const origin = this.server!.origin;
    const problem = sameOriginProblem(c.req, [origin, origin.replace("127.0.0.1", "localhost")]);
    if (problem) return refuse(403, problem);
    const sent = c.req.headers[ACTION_HEADER];
    if (typeof sent !== "string" || !tokenMatches(sent, this.nonce)) return refuse(403, "This request did not come from the Usage page. Reload the page and try again.");
    if (hasBody(c.req)) return refuse(400, "A stop request has no body.", { Connection: "close" });
    const now = Date.now();
    while (this.stopTimes.length && now - this.stopTimes[0] >= 60_000) this.stopTimes.shift();
    if (this.stopTimes.length >= STOPS_PER_MINUTE) return refuse(429, `At most ${STOPS_PER_MINUTE} stops a minute. Wait a moment and try again.`, { "Retry-After": "30" });
    const agent = c.match![1];
    const state = await this.store.state();
    if (!Object.hasOwn(state.agents, agent)) return refuse(404, "There is no such agent in this run.");
    this.stopTimes.push(now);
    try {
      const r = await requestAgentStop(this.store, { agent, by: stopper("dashboard"), surface: "dashboard" });
      this.opts.onStopRequested?.();
      c.json(200, { status: "requested", agent, ...(r.task !== undefined && { task: r.task }), ...(r.already && { already: true }) });
    } catch (e) {
      if (e instanceof StopRefusal) return refuse(409, e.message);
      console.error(`[Dashboard] ${this.store.id}: stop failed: ${e instanceof Error ? e.message : String(e)}`);
      refuse(500, "The stop could not be recorded.");
    }
  }

  private async context(state?: BlackboardState): Promise<PageContext> {
    const s = state ?? (await this.store.state());
    return { state: s, header: this.store.header(), base: this.server!.base, runner: this.runnerHealth() };
  }

  /**
   * POST <token>/postmortems/<pm>/signoff is a CSRF target. Its nonce and custom header force
   * a CORS preflight this server never approves. Origin checks add defense in depth. An agent
   * with shell access and the dashboard URL can post just as it can run the CLI. This is not a sandbox.
   * All transport and body checks precede state reads. Never log the nonce, token or identity.
   */
  private async signoff(c: RouteContext): Promise<void> {
    const refuse = (status: number, error: string, headers: Record<string, string> = {}) =>
      c.json(status, { applied: [], already_signed_off: [], errors: [error] }, { Connection: "close", ...headers });
    // origin is built from SecureServer's validated bind address, never from the Host header.
    const origin = this.server!.origin;
    const bound = new URL(origin).hostname;
    if (bound !== "127.0.0.1" && bound !== "[::1]") return refuse(403, "Dashboard sign-off is disabled on a tailnet bind. Use the CLI.");
    const sent = c.req.headers[ACTION_HEADER];
    if (typeof sent !== "string" || !tokenMatches(sent, this.signoffNonce)) return refuse(403, "Reload the Postmortems page and try again.");
    const problem = sameOriginProblem(c.req, [origin, origin.replace("127.0.0.1", "localhost")]);
    if (problem) return refuse(403, problem);
    if (c.req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return refuse(415, "Sign-off requires application/json.");
    if (Number(c.req.headers["content-length"]) > MAX_SIGNOFF_BODY_BYTES) return refuse(413, "Sign-off accepts at most 16 KiB.");
    const peer = c.req.socket.remoteAddress;
    if (peer !== "127.0.0.1" && peer !== "::1") return refuse(403, "Sign-off requires a loopback connection. Use the CLI.");
    const now = Date.now();
    while (this.signoffTimes.length && now - this.signoffTimes[0] >= 60_000) this.signoffTimes.shift();
    if (this.signoffTimes.length >= SIGNOFFS_PER_MINUTE) return refuse(429, `At most ${SIGNOFFS_PER_MINUTE} sign-off requests a minute.`, { "Retry-After": "60" });
    this.signoffTimes.push(now);
    const body = await readSignoffBody(c.req);
    if (body === undefined) return refuse(413, "Sign-off accepts at most 16 KiB.");
    let input: unknown;
    try { input = JSON.parse(body.toString("utf8")); } catch { return refuse(400, "Invalid sign-off JSON."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return refuse(400, "Sign-off needs exactly by and accept.");
    const fields = input as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "by") || !Object.hasOwn(fields, "accept")) return refuse(400, "Sign-off needs exactly by and accept.");
    if (typeof fields.by !== "string") return refuse(400, "Identity must be non-blank and at most 200 characters after scrubbing.");
    try { validateSignoffIdentity(fields.by); } catch { return refuse(400, "Identity must be non-blank and at most 200 characters after scrubbing."); }
    if (!Array.isArray(fields.accept) || !fields.accept.length || fields.accept.length > LIMITS.artifacts || fields.accept.some(id => typeof id !== "string" || !ARTIFACT_ID_RE.test(id))) {
      return refuse(400, `Select between 1 and ${LIMITS.artifacts} artifact ids (a1, a2, ...).`);
    }
    const accept: string[] = fields.accept;
    const pm = c.match![1];
    const state = await this.store.state();
    const meetings = state.postmortem?.meetings ?? {};
    if (!Object.hasOwn(meetings, pm)) return refuse(404, "There is no such postmortem in this run.");
    try {
      const r = await signOffPostmortem({ pm, orchestrator: fields.by, accept });
      c.json(200, {
        applied: r.applied.filter(a => accept.includes(a.id) && a.signoff && !r.already_signed_off.includes(a.id)).map(a => a.id),
        already_signed_off: r.already_signed_off,
        // Shared failures can contain paths or run text. Do not echo them or request text.
        errors: r.warnings.length ? ["Some effects or audit updates could not be completed. Use the CLI to review and retry."] : [],
      });
    } catch {
      refuse(409, "Sign-off was refused. Check the pending ids and the reviewed contract's identity, or use the CLI for details.");
    }
  }

  private runnerHealth(): RunnerHealth { return runnerHealth(this.store); }

  private async taskPage(id: string, previews: PreviewRecord[] = []): Promise<string | undefined> {
    const detail = await loadTaskDetail(this.store, id, previews);
    return detail ? renderTaskDetail(await this.context(), id, detail) : undefined;
  }

  private async eventsPage(query: URLSearchParams): Promise<string> { return eventsPage(this.store, await this.context(), query); }
  private async contractPage(): Promise<string> { return contractPage(this.store, await this.context()); }
  private async postmortemsPage(): Promise<string> { return postmortemsPage(this.store, { ...(await this.context()), nonce: this.signoffNonce }); }

  private async dagSvg(c: RouteContext): Promise<void> {
    const state = await this.store.state();
    c.send(200, renderDagSvg(state, { base: c.base, standalone: true }), "image/svg+xml; charset=utf-8");
  }

  private asset(c: RouteContext): void {
    const name = c.match![1];
    const file = Object.hasOwn(STATIC_ASSETS, name) ? STATIC_ASSETS[name] : undefined;
    if (!file) return c.notFound();
    c.send(200, file.body, file.type);
  }

  // --------------------------------------------------------------------------
  // Server-sent events
  // --------------------------------------------------------------------------

  private async openStream(c: RouteContext): Promise<void> {
    if (this.clients.size >= MAX_STREAMS) return c.text(503, "Too many open streams; poll state.json instead.", { "Retry-After": "10" });
    const sinceRaw = c.query.get("since");
    const since = sinceRaw !== null && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    const state = await this.store.state();
    this.seq = Math.max(this.seq, state.seq);
    const stream = c.stream("text/event-stream; charset=utf-8", { "X-Accel-Buffering": "no" });
    if (!stream) return;
    const client: Client = { stream, seq: since ?? state.seq, lastWrite: Date.now() };
    this.clients.add(client);
    stream.onClose(() => {
      this.clients.delete(client);
      if (this.clients.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    });
    stream.write("retry: 3000\n\n");
    this.notify(client);
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), Math.max(50, this.opts.pollMs ?? 500));
      this.timer.unref();
    }
  }

  /** Tell one client about a newer seq, if there is one. */
  private notify(client: Client): void {
    if (client.seq >= this.seq) return;
    client.seq = this.seq;
    client.lastWrite = Date.now();
    client.stream.write(`event: rev\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
  }

  /** Check the log for growth (a cheap stat first), then notify every client. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let size = -2;
      try {
        size = statSync(join(this.store.dir, "events.jsonl")).size;
      } catch {
        size = -2; // not a file store, or the log is gone: ask the store
      }
      if (size === -2 || size !== this.logSize) {
        this.logSize = size;
        const state = await this.store.state();
        this.seq = Math.max(this.seq, state.seq);
      }
      const now = Date.now();
      for (const client of this.clients) {
        this.notify(client);
        if (now - client.lastWrite >= KEEPALIVE_MS) {
          client.lastWrite = now;
          client.stream.write(": keepalive\n\n");
        }
      }
      this.warned = false;
    } catch (e) {
      if (!this.warned) console.error(`[Dashboard] ${this.store.id}: cannot read the event log: ${e instanceof Error ? e.message : String(e)}`);
      this.warned = true;
    } finally {
      this.polling = false;
    }
  }
}
