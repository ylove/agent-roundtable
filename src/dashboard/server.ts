// ============================================================================
// Execution dashboard: a read-only local web view of one heads-down run
//
// Served by the runner on the shared secure server (src/http/secure-server.ts): 127.0.0.1, a
// capability token in every URL, Host check, GET and HEAD only, strict headers. There is no
// mutating route at all, so CSRF does not apply: steering, pausing and resolving stay in the
// orchestrator's tools. Pages read the run through the execution store (lock-free reads) and
// are rendered on the server with every run-derived string redacted and escaped (render.ts).
//
// Live updates: GET <token>/stream?since=<seq> is a server-sent event stream that sends
// "rev" {seq} whenever the event log grows; the page script falls back to polling
// <token>/state.json, a redacted subset of the blackboard.
// ============================================================================

import { lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { openExecutionStore } from "../execution/store.js";
import { EVENT_TYPES, type AnyEvent, type BlackboardState, type EventType, type ExecutionStore } from "../execution/types.js";
import { SecureServer, type ResponseStream, type RouteContext } from "../http/secure-server.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { STATIC_ASSETS } from "./assets.js";
import { renderDagSvg } from "./dag-svg.js";
import {
  contractMarkdown,
  eventMatches,
  eventTask,
  EVENTS_PAGE_SIZE,
  parseEventFilter,
  publicState,
  renderContract,
  renderDagPage,
  renderEscalations,
  renderEvents,
  renderOverview,
  renderTaskDetail,
  renderTasks,
  type PageContext,
  type RunnerHealth,
  type TaskDetail,
} from "./render.js";

/** Every dashboard page. No inline script or style anywhere, nothing from outside 'self'. */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Most bytes of a diff shown on a task page, and of a failing check's output. */
const DIFF_CAP_BYTES = 512 * 1024;
const OUTPUT_CAP_BYTES = 64 * 1024;
/** Most concurrent event streams; more get 503 and the page falls back to polling. */
const MAX_STREAMS = 32;
const KEEPALIVE_MS = 15_000;
/** A runner whose heartbeat is older than this is stale (heads-down.md §2). */
const RUNNER_STALE_MS = 30_000;

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

/** Cut text to at most `max` bytes at a line boundary, so redaction never sees half a secret. */
export function capAtLine(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  let cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl);
  return { text: cut, truncated: true };
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
        { path: "/", handler: page(async () => renderOverview(await this.context())) },
        { path: "/tasks", handler: page(async () => renderTasks(await this.context())) },
        { path: /^\/tasks\/([a-z0-9][a-z0-9._-]{0,63})$/, handler: page((c) => this.taskPage(c.match![1])) },
        { path: "/escalations", handler: page(async () => renderEscalations(await this.context())) },
        { path: "/events", handler: page((c) => this.eventsPage(c.query)) },
        { path: "/contract", handler: page(() => this.contractPage()) },
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

  private async context(state?: BlackboardState): Promise<PageContext> {
    const s = state ?? (await this.store.state());
    return { state: s, header: this.store.header(), base: this.server!.base, runner: this.runnerHealth() };
  }

  /** From runner.json, which the runner rewrites every 5 s ({pid, heartbeatAt}). */
  private runnerHealth(): RunnerHealth {
    let raw: { pid?: unknown; heartbeatAt?: unknown };
    try {
      raw = JSON.parse(readFileSync(join(this.store.dir, "runner.json"), "utf8"));
    } catch {
      return { status: "unknown", detail: "No runner heartbeat yet (runner.json is missing)." };
    }
    const at = typeof raw?.heartbeatAt === "string" ? Date.parse(raw.heartbeatAt) : NaN;
    const pid = Number.isSafeInteger(raw?.pid) ? ` ${raw.pid}` : "";
    if (!Number.isFinite(at)) return { status: "unknown", detail: `Runner${pid}: no heartbeat time recorded.` };
    const age = Math.max(0, Math.round((Date.now() - at) / 1000));
    return age * 1000 > RUNNER_STALE_MS
      ? { status: "stale", detail: `Runner${pid}: last heartbeat ${age} s ago (stale after 30 s).` }
      : { status: "alive", detail: `Runner${pid}: heartbeat ${age} s ago.` };
  }

  private async blobText(ref: string, max: number): Promise<{ text: string; truncated: boolean }> {
    const buf = await this.store.getBlob(ref);
    return capAtLine(buf.toString("utf8"), max);
  }

  private async taskPage(id: string): Promise<string | undefined> {
    const state = await this.store.state();
    if (!Object.hasOwn(state.tasks, id)) return undefined;
    const detail: TaskDetail = { events: [], outputs: {} };
    detail.events = (await this.store.events()).filter((ev) => eventTask(ev) === id).slice(-50);
    const diff = Object.hasOwn(state.diffs, id) ? state.diffs[id] : undefined;
    if (diff) {
      try {
        detail.diff = { stat: diff.stat, commit: diff.commit, ...(await this.blobText(diff.blob, DIFF_CAP_BYTES)) };
      } catch (e) {
        detail.diff = { stat: diff.stat, commit: diff.commit, error: `The diff cannot be read: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    for (const [key, ch] of Object.entries(state.checks.task)) {
      if (!key.startsWith(`${id}/`) || ch.status !== "failed" || !ch.blob) continue;
      try {
        detail.outputs[key] = (await this.blobText(ch.blob, OUTPUT_CAP_BYTES)).text;
      } catch {
        /* output not stored or unreadable: the signature still shows */
      }
    }
    return renderTaskDetail(await this.context(state), id, detail);
  }

  private async eventsPage(query: URLSearchParams): Promise<string> {
    const state = await this.store.state();
    const f = parseEventFilter(query);
    let found: AnyEvent[];
    if (!f.type && !f.task) {
      // Unfiltered: read only the page's window of the log.
      const top = Math.min(state.seq, (f.before ?? state.seq + 1) - 1);
      found = await this.store.events({ sinceSeq: Math.max(0, top - EVENTS_PAGE_SIZE - 1), limit: EVENTS_PAGE_SIZE + 1 });
    } else {
      const types = f.type ? (EVENT_TYPES.filter((x) => x === f.type || x.startsWith(`${f.type}.`)) as EventType[]) : undefined;
      found = await this.store.events(types ? { types } : {});
    }
    const matches = found.filter((ev) => ev.seq <= state.seq && eventMatches(ev, f));
    const more = matches.length > EVENTS_PAGE_SIZE || (!f.type && !f.task && matches.length > 0 && matches[0].seq > 1);
    return renderEvents(await this.context(state), f, matches.slice(-EVENTS_PAGE_SIZE).reverse(), more);
  }

  private async contractPage(): Promise<string> {
    const state = await this.store.state();
    const c = state.contract;
    let md: string | undefined;
    let source = "";
    if (c) {
      md = contractMarkdown(c);
      source = `Generated from the frozen contract, version ${c.version}.`;
      const written = this.contractFile(c.id);
      if (written !== undefined) md += `\n\n---\n\n# CONTRACT.md\n\n${written}`;
    }
    return renderContract(await this.context(state), md, source);
  }

  /** contracts/<ctr>/CONTRACT.md as the contract tools wrote it, when present (a regular file up to 1 MiB). */
  private contractFile(ctr: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(ctr) || ctr.includes("..")) return undefined;
    const path = join(this.store.dir, "contracts", ctr, "CONTRACT.md");
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > 1024 * 1024) return undefined;
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

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
