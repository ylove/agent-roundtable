// Read-only prototype board: one HTTP server per session on 127.0.0.1 (random port).
// Serves a live list of prototypes, a viewer per prototype version and the static files of web
// prototypes. GET/HEAD only, Host-header checked (blocks DNS rebinding), no CORS, no caching.
// Everything rendered from agent content is HTML-escaped.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { diagramFile, mermaidSourceOf, validatePath } from "./parse.js";
import type { PrototypeFile, PrototypeRecord } from "./types.js";

export const MERMAID_MODULE_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

export const VIEWER_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'";
export const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'";
const BOARD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'";
/** Prototype pages run in an opaque origin: no access to the board, no top-level navigation, no popups. */
const IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals";

export interface BoardMeta {
  sessionId: string;
  mode: string;
  participants: string[];
  topic?: string;
}

export interface BoardPrototype extends Omit<PrototypeRecord, "files"> {
  /** Names of assessors who have not taken their turn yet (live prototypes). */
  awaiting: string[];
  createdAt: string;
  /** Present only while live: the sandbox directory and files the viewer and app route serve. */
  live?: { dir: string; files: PrototypeFile[]; entry?: string };
}

export interface BoardState {
  prototypes: BoardPrototype[];
}

const COMMON_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return (i > 0 && CONTENT_TYPES[base.slice(i + 1).toLowerCase()]) || "text/plain; charset=utf-8";
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const esc = escapeHtml;

const STATUS_TEXT: Record<BoardPrototype["status"], string> = {
  live: "Live: under assessment",
  awaiting_decision: "Assessed: awaiting the proposer's decision",
  shortlisted: "Shortlisted for the human",
  scrapped: "Scrapped",
  revised: "Revised",
  expired: "Expired (time limit reached)",
  closed: "Closed at session end",
};

function statusText(p: BoardPrototype): string {
  if (p.status === "revised" && p.supersededBy) return `Revised: superseded by ${p.supersededBy}`;
  return STATUS_TEXT[p.status];
}

function destroyedHeading(p: BoardPrototype): string {
  if (p.status === "expired") return "Destroyed: its time limit ran out before assessment finished";
  if (p.status === "closed" && p.verdicts.length === 0) return "Destroyed when the session ended";
  return "Destroyed after assessment";
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e2e2e0;--accent:#2f6fde;
--live:#1f8a4c;--warn:#a5660a;--bad:#b3261e;--code:#f0f0ee}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;
--accent:#7aa7ff;--live:#5fd08e;--warn:#e3a54a;--bad:#ff8a80;--code:#25252a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1400px;margin:0 auto;padding:20px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}
.meta{color:var(--muted);margin:0 0 12px}.notice{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:10px 14px;margin:12px 0}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card h3{margin:0 0 6px;font-size:1rem}.badge{display:inline-block;font-size:.8rem;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.s-live{color:var(--live)}.s-awaiting_decision,.s-expired{color:var(--warn)}.s-scrapped,.s-closed{color:var(--muted)}.s-shortlisted{color:var(--accent)}.s-revised{color:var(--muted)}
ul{padding-left:20px;margin:6px 0}a{color:var(--accent)}.empty{color:var(--muted)}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.demo{white-space:pre-wrap}.frames{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
figure{margin:0}figcaption{color:var(--muted);font-size:.85rem;margin-bottom:4px}
.desktop{flex:1 1 640px;min-width:0}.mobile{flex:0 0 auto;max-width:100%}
.scaler{overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#fff}
.scaler iframe{border:0;transform-origin:0 0;display:block;background:#fff}
details{margin:8px 0}summary{cursor:pointer;font-family:ui-monospace,Menlo,monospace}
`;

function page(title: string, body: string, opts: { bodyAttrs?: string; script?: string; moduleScript?: string } = {}): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body${opts.bodyAttrs ?? ""}><main>${body}</main>` +
    (opts.script ? `<script>${opts.script}</script>` : "") +
    (opts.moduleScript ? `<script type="module">${opts.moduleScript}</script>` : "") +
    `</body></html>`
  );
}

function verdictsHtml(p: BoardPrototype): string {
  if (p.verdicts.length === 0) return `<ul id="verdicts"><li class="empty">No verdicts yet.</li></ul>`;
  return (
    `<ul id="verdicts">` +
    p.verdicts
      .map((v) => `<li><strong>${esc(v.assessor)}</strong>: ${esc(v.verdict)}${v.reason ? ` — ${esc(v.reason)}` : ""}</li>`)
      .join("") +
    `</ul>`
  );
}

function decisionHtml(p: BoardPrototype): string {
  if (!p.decision) return "";
  return `<p><strong>Decision:</strong> ${esc(p.decision.decision)}${p.decision.reason ? ` — ${esc(p.decision.reason)}` : ""}</p>`;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

// Board page: reload when the state revision changes (no agent content is ever built in client JS).
const BOARD_SCRIPT = `(function(){var rev=document.body.getAttribute("data-rev");var t=setInterval(function(){
fetch("/state.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){if(String(s.rev)!==rev)location.reload()})
.catch(function(){clearInterval(t);var n=document.getElementById("live-note");if(n)n.textContent="The board has closed (the session ended)."})},2000)})();`;

// Viewer: refresh the status and verdicts in place (textContent only), reload once the prototype is destroyed.
const VIEWER_SCRIPT = `(function(){var key=document.body.getAttribute("data-key");
function fit(){document.querySelectorAll(".scaler").forEach(function(el){var w=+el.getAttribute("data-w"),h=+el.getAttribute("data-h");
var avail=el.parentElement.clientWidth||w;var s=Math.min(1,avail/w);var f=el.querySelector("iframe");f.style.transform="scale("+s+")";
el.style.width=Math.floor(w*s)+"px";el.style.height=Math.floor(h*s)+"px"})}
window.addEventListener("resize",fit);fit();
var t=setInterval(function(){fetch("/state.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){
var p=null;for(var i=0;i<s.prototypes.length;i++)if(s.prototypes[i].key===key)p=s.prototypes[i];
if(!p||p.destroyed){location.reload();return}
document.getElementById("status").textContent=p.statusText;
var ul=document.getElementById("verdicts");ul.textContent="";
if(!p.verdicts.length){var e=document.createElement("li");e.className="empty";e.textContent="No verdicts yet.";ul.appendChild(e)}
p.verdicts.forEach(function(v){var li=document.createElement("li");var b=document.createElement("strong");b.textContent=v.assessor;
li.appendChild(b);li.appendChild(document.createTextNode(": "+v.verdict+(v.reason?" — "+v.reason:"")));ul.appendChild(li)});
document.getElementById("awaiting").textContent=p.awaiting.length?"Awaiting verdicts from: "+p.awaiting.join(", "):""})
.catch(function(){clearInterval(t);document.getElementById("status").textContent="The board has closed (the session ended)."})},2000)})();`;

const MERMAID_SCRIPT =
  `import mermaid from "${MERMAID_MODULE_URL}";` +
  `mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"});` +
  `await mermaid.run({querySelector:".mermaid"});`;

export class PrototypeBoard {
  private state: BoardState = { prototypes: [] };
  private rev = 0;
  private port = 0;
  private closing?: Promise<void>;

  private constructor(
    private readonly meta: BoardMeta,
    private readonly server: Server
  ) {}

  /** Start the board on 127.0.0.1 with a random port. */
  static start(meta: BoardMeta): Promise<PrototypeBoard> {
    const server = createServer();
    const board = new PrototypeBoard(meta, server);
    server.on("request", (req, res) => board.handle(req, res));
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (e) => console.error(`[Prototype] board error: ${e.message}`));
        board.port = (server.address() as AddressInfo).port;
        // A forgotten board must never keep the process alive.
        server.unref();
        resolvePromise(board);
      });
    });
  }

  /** "http://127.0.0.1:<port>/" */
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  update(state: BoardState): void {
    this.state = state;
    this.rev++;
  }

  /** Stop the server and drop every connection. Idempotent. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = new Promise<void>((done) => {
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
      this.server.close();
      this.server.closeAllConnections();
    } catch {
      /* already closed */
    }
  }

  // --------------------------------------------------------------------------

  private send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    contentType: string,
    extra: Record<string, string> = {}
  ): void {
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    res.writeHead(status, {
      ...COMMON_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
      ...extra,
    });
    if (req.method === "HEAD") res.end();
    else res.end(buf);
  }

  private text(req: IncomingMessage, res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
    this.send(req, res, status, message + "\n", "text/plain; charset=utf-8", extra);
  }

  private html(req: IncomingMessage, res: ServerResponse, status: number, body: string, csp: string): void {
    this.send(req, res, status, body, "text/html; charset=utf-8", { "Content-Security-Policy": csp });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    void this.route(req, res).catch((e) => {
      console.error(`[Prototype] board request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) this.text(req, res, 500, "Internal error");
      else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return this.text(req, res, 421, "Misdirected request: this board only answers on its own local address.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return this.text(req, res, 405, "Method not allowed: the board is read-only.", { Allow: "GET, HEAD" });
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      return this.text(req, res, 400, "Bad request");
    }
    if (pathname === "/") return this.html(req, res, 200, this.boardPage(), BOARD_CSP);
    if (pathname === "/state.json") {
      return this.send(req, res, 200, JSON.stringify(this.publicState()), "application/json; charset=utf-8");
    }
    const m = /^\/p\/(P\d{1,4}v\d{1,4})(?:\/(.*))?$/.exec(pathname);
    if (!m) return this.text(req, res, 404, "Not found");
    const p = this.state.prototypes.find((x) => x.key === m[1]);
    if (!p) return this.text(req, res, 404, "Not found");
    if (!p.live) return this.html(req, res, 410, this.destroyedPage(p), VIEWER_CSP);
    const rest = m[2];
    if (rest === undefined || rest === "") return this.html(req, res, 200, this.viewerPage(p), VIEWER_CSP);
    if (rest === "render" && p.kind === "diagram") return this.html(req, res, 200, this.renderPage(p), VIEWER_CSP);
    if (rest === "app" || rest.startsWith("app/")) return this.serveApp(req, res, p, rest.slice(4));
    return this.text(req, res, 404, "Not found");
  }

  private async serveApp(req: IncomingMessage, res: ServerResponse, p: BoardPrototype, sub: string): Promise<void> {
    const live = p.live;
    if (p.kind !== "web" || !live) return this.text(req, res, 404, "Not found");
    let path: string;
    try {
      path = sub.split("/").map((s) => decodeURIComponent(s)).join("/");
    } catch {
      return this.text(req, res, 400, "Bad request");
    }
    if (path === "") path = live.entry ?? "";
    // Only the prototype's own validated files are served: nothing else in the sandbox is reachable.
    if (validatePath(path) !== null || !live.files.some((f) => f.path === path)) {
      return this.text(req, res, 404, "Not found");
    }
    const dir = resolve(live.dir);
    const target = resolve(dir, ...path.split("/"));
    const rel = relative(dir, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return this.text(req, res, 404, "Not found");
    let bytes: Buffer;
    try {
      const st = await lstat(target);
      if (!st.isFile()) return this.text(req, res, 404, "Not found");
      bytes = await readFile(target);
    } catch {
      return this.text(req, res, 410, "Destroyed after assessment");
    }
    if (!this.state.prototypes.find((x) => x.key === p.key)?.live) {
      return this.text(req, res, 410, "Destroyed after assessment");
    }
    return this.send(req, res, 200, bytes, contentTypeFor(path), { "Content-Security-Policy": APP_CSP });
  }

  /** state.json: metadata only. Never any file content; file names only while live. */
  private publicState() {
    return {
      rev: this.rev,
      session: {
        id: this.meta.sessionId,
        mode: this.meta.mode,
        participants: this.meta.participants,
        ...(this.meta.topic !== undefined && { topic: this.meta.topic }),
      },
      prototypes: this.state.prototypes.map((p) => ({
        key: p.key,
        id: p.id,
        version: p.version,
        label: p.label,
        title: p.title,
        kind: p.kind,
        proposer: p.proposer,
        status: p.status,
        statusText: statusText(p),
        destroyed: !p.live,
        createdAt: p.createdAt,
        fileCount: p.fileCount,
        ...(p.live && { files: p.live.files.map((f) => f.path) }),
        demo: p.demo,
        verdicts: p.verdicts,
        awaiting: p.awaiting,
        ...(p.decision && { decision: p.decision }),
        ...(p.supersededBy && { supersededBy: p.supersededBy }),
        url: `/p/${p.key}/`,
      })),
    };
  }

  private header(): string {
    const m = this.meta;
    return (
      `<h1>Prototype board</h1>` +
      `<p class="meta">Session <strong>${esc(m.sessionId)}</strong> · mode ${esc(m.mode)} · ` +
      `participants: ${esc(m.participants.join(", "))}${m.topic ? ` · topic: ${esc(m.topic)}` : ""}</p>` +
      `<p class="notice">Read-only. Feedback opens when the session ends. <span id="live-note">This page updates itself.</span></p>`
    );
  }

  private boardPage(): string {
    const ps = this.state.prototypes;
    const cards = ps.length
      ? `<div class="cards">${ps
          .map(
            (p) =>
              `<article class="card"><h3>${esc(p.label)} · ${esc(p.title)}</h3>` +
              `<p class="meta">${esc(p.kind)} · ${p.fileCount} file${p.fileCount === 1 ? "" : "s"} · proposed by ${esc(p.proposer)}</p>` +
              `<p><span class="badge s-${esc(p.status)}">${esc(statusText(p))}</span></p>` +
              (p.live && p.awaiting.length ? `<p class="meta">Awaiting verdicts from: ${esc(p.awaiting.join(", "))}</p>` : "") +
              verdictsHtml(p).replace(' id="verdicts"', "") +
              decisionHtml(p) +
              (p.live ? `<p><a href="/p/${esc(p.key)}/">Open prototype</a></p>` : `<p class="meta">Destroyed.</p>`) +
              `</article>`
          )
          .join("")}</div>`
      : `<p class="empty">No prototypes yet. They appear here as the participants propose them.</p>`;
    return page("Prototype board", this.header() + `<h2>Prototypes</h2>` + cards, {
      bodyAttrs: ` data-rev="${this.rev}"`,
      script: BOARD_SCRIPT,
    });
  }

  private filesHtml(files: PrototypeFile[], open: boolean): string {
    return files
      .map((f) => `<details${open ? " open" : ""}><summary>${esc(f.path)}</summary><pre><code>${esc(f.content)}</code></pre></details>`)
      .join("");
  }

  private viewerPage(p: BoardPrototype): string {
    const live = p.live!;
    let content = "";
    let moduleScript: string | undefined;
    if (p.kind === "web" && live.entry) {
      const src = `/p/${p.key}/app/${encodePath(live.entry)}`;
      const frame = (cls: string, label: string, w: number, h: number) =>
        `<figure class="${cls}"><figcaption>${label} ${w}×${h}</figcaption>` +
        `<div class="scaler" data-w="${w}" data-h="${h}"><iframe sandbox="${IFRAME_SANDBOX}" src="${esc(src)}" ` +
        `width="${w}" height="${h}" title="${label} view" referrerpolicy="no-referrer"></iframe></div></figure>`;
      content =
        `<h2>Prototype</h2><div class="frames">${frame("desktop", "Desktop", 1280, 800)}${frame("mobile", "Mobile", 390, 844)}</div>` +
        `<h2>Source</h2>${this.filesHtml(live.files, false)}`;
    } else if (p.kind === "diagram") {
      const f = diagramFile(live.files);
      const code = f ? mermaidSourceOf(f.content) ?? "" : "";
      content = `<h2>Diagram</h2><pre class="mermaid">${esc(code)}</pre><h2>Source</h2>${this.filesHtml(live.files, false)}`;
      moduleScript = MERMAID_SCRIPT;
    } else {
      content = `<h2>${p.kind === "text" ? "Draft" : "Source (never executed)"}</h2>${this.filesHtml(live.files, true)}`;
    }
    const body =
      `<p class="meta"><a href="/">← Board</a></p>` +
      `<h1>${esc(p.label)} · ${esc(p.title)}</h1>` +
      `<p class="meta">${esc(p.kind)} · proposed by ${esc(p.proposer)}</p>` +
      `<p class="notice">Read-only. Feedback opens when the session ends. This prototype is destroyed as soon as it has been assessed.</p>` +
      `<p><span class="badge s-${esc(p.status)}" id="status">${esc(statusText(p))}</span></p>` +
      `<p class="meta" id="awaiting">${p.awaiting.length ? `Awaiting verdicts from: ${esc(p.awaiting.join(", "))}` : ""}</p>` +
      `<h2>Verdicts so far</h2>${verdictsHtml(p)}` +
      (p.demo.trim() ? `<h2>Demo walkthroughs</h2><div class="demo">${esc(p.demo)}</div>` : "") +
      content;
    return page(`${p.label} · ${p.title}`, body, {
      bodyAttrs: ` data-key="${esc(p.key)}"`,
      script: VIEWER_SCRIPT,
      ...(moduleScript && { moduleScript }),
    });
  }

  /** Bare diagram page (used for screenshots). */
  private renderPage(p: BoardPrototype): string {
    const f = diagramFile(p.live!.files);
    const code = f ? mermaidSourceOf(f.content) ?? "" : "";
    return (
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.label)}</title>` +
      `<style>body{margin:0;padding:24px;background:#fff;color:#111;font-family:system-ui,sans-serif}</style></head>` +
      `<body><pre class="mermaid">${esc(code)}</pre><script type="module">` +
      `import mermaid from "${MERMAID_MODULE_URL}";mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"default"});` +
      `await mermaid.run({querySelector:".mermaid"});</script></body></html>`
    );
  }

  private destroyedPage(p: BoardPrototype): string {
    const body =
      `<p class="meta"><a href="/">← Board</a></p>` +
      `<h1>${esc(destroyedHeading(p))}</h1>` +
      `<p><strong>${esc(p.label)}</strong> · ${esc(p.title)} · ${esc(p.kind)} · proposed by ${esc(p.proposer)}</p>` +
      `<p><span class="badge s-${esc(p.status)}">${esc(statusText(p))}</span></p>` +
      `<h2>Verdicts</h2>${verdictsHtml(p)}` +
      decisionHtml(p) +
      `<p class="notice">Prototypes are ephemeral: the artifact no longer exists. Feedback opens when the session ends.</p>`;
    return page(`${p.label} · destroyed`, body);
  }
}

/** Open the board in the default browser. Best effort: detached, errors ignored; only our own local URL. */
export function openInBrowser(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) return;
  try {
    const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], opts)
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", '""', url], { ...opts, windowsVerbatimArguments: true })
          : spawn("xdg-open", [url], opts);
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
