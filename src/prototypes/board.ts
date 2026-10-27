// Read-only prototype board: one HTTP server per session on 127.0.0.1 (random port).
// Serves a live list of prototypes, a viewer per prototype version and the static files of web
// prototypes. The hardening (capability token, Host check, GET/HEAD only, strict headers, no CORS,
// no caching) is the shared secure server's (src/http/secure-server.ts). Everything rendered from
// agent content is HTML-escaped. The board's own scripts and styles are static routes, so the
// board and viewer pages run no inline script.
//
// The board is also the deny-all proxy of the screenshot browser (see screenshot.ts): a proxied
// (absolute-form) request is served only when it targets this board's own prototype files; every
// other target, and every CONNECT or upgrade, is answered 403.
import { pageCheckSummary } from "./page-check.js";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { escapeHtml, SecureServer, type RouteContext } from "../http/secure-server.js";
import { childEnv } from "../security/child-env.js";
import { findExecutable } from "../executables.js";
import { diagramFile, mermaidSourceOf, validatePath } from "./parse.js";
import type { PrototypeFile, PrototypeRecord } from "./types.js";

export { escapeHtml } from "../http/secure-server.js";

/**
 * Mermaid for diagram prototypes: the single-file build, pinned to the newest 11.x release with no
 * known advisory (the GitHub advisories for mermaid were last fixed in 11.16.1), loaded with
 * Subresource Integrity. The hash is of the exact file:
 *   curl -sL <MERMAID_SCRIPT_URL> | openssl dgst -sha384 -binary | openssl base64 -A
 */
export const MERMAID_VERSION = "11.17.2";
export const MERMAID_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
export const MERMAID_SRI = "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2";

export const BOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const viewerCsp = (style: string, frames: string) =>
  `default-src 'self'; script-src 'self' ${MERMAID_SCRIPT_URL}; style-src ${style}; ` +
  `img-src 'self' data:; frame-src ${frames}; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
/** Viewer and destroyed pages: scripts from the board and the pinned Mermaid file only; no inline script or style. */
export const VIEWER_CSP = viewerCsp("'self'", "'self'");
/**
 * The viewer of a diagram. Mermaid runs with securityLevel "sandbox": it renders the diagram into a
 * script-less, opaque-origin data: iframe, so nothing in the diagram can restyle or overlay the
 * viewer (its verdicts, status or links). That iframe's style attribute and the SVG's own <style>
 * (the frame inherits this policy) are why inline styles are allowed here; inline scripts never are.
 * Configuration directives (%%{…}%% and front matter, which can carry themeCSS) are refused before
 * rendering. Residual risk: inside its own frame a diagram shows whatever text and shapes it likes,
 * and a link in it can open a popup or navigate the tab on a click.
 */
export const DIAGRAM_VIEWER_CSP = viewerCsp("'self' 'unsafe-inline'", "data:");
/**
 * Prototype files. `sandbox` gives the page an opaque origin wherever it is shown (the viewer's iframe or
 * a top-level screenshot), so it behaves the same in both and can never read the board (state.json).
 * Accepted risk: a prototype is an agent-written page, so inline scripts and styles stay allowed here.
 * The opaque origin and the sandbox flags contain it, and the board answers it nothing but its own
 * files (same-origin CORP on everything else, no CORS).
 */
export const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-modals";
/**
 * A live prototype's missing or removed file, shown inside the viewer's frame. Plain text with
 * nosniff, framable by the board's own pages only (frame-ancestors 'self', SAMEORIGIN); every other
 * board response keeps frame-ancestors 'none' and DENY. A destroyed prototype's routes answer with
 * the destroyed page instead, which the viewer reloads into at top level.
 */
const APP_ERROR_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "SAMEORIGIN",
};
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

/** A prototype page's own subresources: its opaque (sandboxed) origin is cross-origin to them. */
const APP_SUBRESOURCE_CORP = "cross-origin";

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

// ----------------------------------------------------------------------------
// Static assets (served under <token>/static/; tsc copies no asset files)
// ----------------------------------------------------------------------------

const BOARD_STYLE = `
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

// Board page: reload when the state revision changes (no agent content is ever built in client JS).
const BOARD_SCRIPT = `(function(){var rev=document.body.getAttribute("data-rev");var base=document.body.getAttribute("data-base");
var t=setInterval(function(){fetch(base+"state.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){if(String(s.rev)!==rev)location.reload()})
.catch(function(){clearInterval(t);var n=document.getElementById("live-note");if(n)n.textContent="The board has closed (the session ended)."})},2000)})();`;

// Viewer: refresh the status and verdicts in place (textContent only), reload once the prototype is destroyed.
// The frames are scaled through the CSSOM (element.style), which CSP style-src does not restrict.
const VIEWER_SCRIPT = `(function(){var key=document.body.getAttribute("data-key");var base=document.body.getAttribute("data-base");
if(!key)return;
function fit(){document.querySelectorAll(".scaler").forEach(function(el){var w=+el.getAttribute("data-w"),h=+el.getAttribute("data-h");
var avail=el.parentElement.clientWidth||w;var s=Math.min(1,avail/w);var f=el.querySelector("iframe");f.style.transform="scale("+s+")";
el.style.width=Math.floor(w*s)+"px";el.style.height=Math.floor(h*s)+"px"})}
window.addEventListener("resize",fit);fit();
var t=setInterval(function(){fetch(base+"state.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){
var p=null;for(var i=0;i<s.prototypes.length;i++)if(s.prototypes[i].key===key)p=s.prototypes[i];
if(!p||p.destroyed){location.reload();return}
document.getElementById("status").textContent=p.statusText;
var check=document.getElementById("page-check");if(check&&p.check){var c=p.check;check.textContent=c.exceptions.length?"Page check: threw "+c.exceptions[0]:c.reason?"Page check: "+c.reason:c.loaded?"Page check: loaded; "+c.consoleErrors.length+" console errors":"Page check: not loaded";}
var ul=document.getElementById("verdicts");ul.textContent="";
if(!p.verdicts.length){var e=document.createElement("li");e.className="empty";e.textContent="No verdicts yet.";ul.appendChild(e)}
p.verdicts.forEach(function(v){var li=document.createElement("li");var b=document.createElement("strong");b.textContent=v.assessor;
li.appendChild(b);li.appendChild(document.createTextNode(": "+v.verdict+(v.reason?" — "+v.reason:"")));ul.appendChild(li)});
document.getElementById("awaiting").textContent=p.awaiting.length?"Awaiting verdicts from: "+p.awaiting.join(", "):""})
.catch(function(){clearInterval(t);document.getElementById("status").textContent="The board has closed (the session ended)."})},2000)})();`;

// Runs after the pinned mermaid.min.js (a classic script that defines window.mermaid). The diagram is
// rendered into a sandboxed frame, without HTML labels; `secure` keeps every styling and safety key
// out of reach of a directive (the board also refuses diagrams that carry one).
const MERMAID_INIT_SCRIPT =
  `(function(){if(!window.mermaid)return;` +
  `mermaid.initialize({startOnLoad:false,securityLevel:"sandbox",htmlLabels:false,flowchart:{htmlLabels:false},` +
  `theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default",` +
  `secure:["secure","securityLevel","startOnLoad","maxTextSize","maxEdges","suppressErrorRendering","htmlLabels","flowchart",` +
  `"theme","themeCSS","themeVariables","fontFamily","altFontFamily","darkMode","dompurifyConfig"]});` +
  `mermaid.run({querySelector:".mermaid"})})();`;

/**
 * Mermaid source that configures Mermaid itself: an init directive (%%{…}%%) or YAML front matter,
 * either of which can carry themeCSS. The board shows such a diagram as source and never renders it.
 */
export function mermaidConfigured(code: string): boolean {
  return /%%\s*\{/.test(code) || /^\s*---[ \t]*\r?\n/.test(code);
}

const STATIC_FILES: Record<string, { body: string; type: string }> = {
  "board.css": { body: BOARD_STYLE, type: "text/css; charset=utf-8" },
  "board.js": { body: BOARD_SCRIPT, type: "text/javascript; charset=utf-8" },
  "viewer.js": { body: VIEWER_SCRIPT, type: "text/javascript; charset=utf-8" },
  "mermaid-init.js": { body: MERMAID_INIT_SCRIPT, type: "text/javascript; charset=utf-8" },
};

// ----------------------------------------------------------------------------

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

/** Route of a prototype's own files, under the token: "/p/<key>/app" or "/p/<key>/app/<path>". */
const APP_ROUTE_RE = /^\/p\/P\d{1,4}v\d{1,4}\/app(?:\/|$)/;

export class PrototypeBoard {
  private state: BoardState = { prototypes: [] };
  private rev = 0;

  private constructor(
    private readonly meta: BoardMeta,
    private readonly server: SecureServer
  ) {}

  /** Start the board on 127.0.0.1 with a random port. */
  static async start(meta: BoardMeta): Promise<PrototypeBoard> {
    let board: PrototypeBoard | undefined;
    const server = await SecureServer.start({
      name: "Prototype board",
      // The screenshot browser may load prototype files only: never the board, its state or a viewer.
      allowProxied: (path) => APP_ROUTE_RE.test(path),
      routes: [
        { path: "/", handler: (c) => c.html(200, board!.boardPage(), BOARD_CSP) },
        { path: "/state.json", handler: (c) => c.json(200, board!.publicState()) },
        { path: /^\/static\/([a-z-]+\.(?:css|js))$/, handler: (c) => serveStatic(c) },
        { path: /^\/p\/(P\d{1,4}v\d{1,4})(?:\/(.*))?$/, handler: (c) => board!.prototypeRoute(c) },
      ],
    });
    board = new PrototypeBoard(meta, server);
    return board;
  }

  /** "http://127.0.0.1:<port>/<token>/" */
  get url(): string {
    return this.server.url;
  }

  /** "/<token>/": the path prefix of every route. */
  private get base(): string {
    return this.server.base;
  }

  update(state: BoardState): void {
    this.state = state;
    this.rev++;
  }

  /** Stop the server and drop every connection. Idempotent. */
  close(): Promise<void> {
    return this.server.close();
  }

  /** Synchronous best-effort stop (process exit). */
  closeNow(): void {
    this.server.closeNow();
  }

  // --------------------------------------------------------------------------

  private async prototypeRoute(c: RouteContext): Promise<void> {
    const m = c.match!;
    const p = this.state.prototypes.find((x) => x.key === m[1]);
    if (!p) return c.notFound();
    if (!p.live) return c.html(410, this.destroyedPage(p), VIEWER_CSP);
    const rest = m[2];
    if (rest === undefined || rest === "") {
      return c.html(200, this.viewerPage(p), p.kind === "diagram" ? DIAGRAM_VIEWER_CSP : VIEWER_CSP);
    }
    if (rest === "app" || rest.startsWith("app/")) return this.serveApp(c, p, rest.slice(4));
    return c.notFound();
  }

  private async serveApp(c: RouteContext, p: BoardPrototype, sub: string): Promise<void> {
    // Plain-text errors shown inside the viewer's frame: framable by the board itself, nothing else.
    const fail = (status: number, message: string) => c.text(status, message, APP_ERROR_HEADERS);
    const live = p.live;
    if (p.kind !== "web" || !live) return fail(404, "Not found");
    let path: string;
    try {
      path = sub.split("/").map((s) => decodeURIComponent(s)).join("/");
    } catch {
      return fail(400, "Bad request");
    }
    if (path === "") path = live.entry ?? "";
    // Only the prototype's own validated files are served: nothing else in the sandbox is reachable.
    if (validatePath(path) !== null || !live.files.some((f) => f.path === path)) return fail(404, "Not found");
    const dir = resolve(live.dir);
    const target = resolve(dir, ...path.split("/"));
    const rel = relative(dir, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return fail(404, "Not found");
    let bytes: Buffer;
    try {
      const st = await lstat(target);
      if (!st.isFile()) return fail(404, "Not found");
      bytes = await readFile(target);
    } catch {
      return fail(410, "Destroyed after assessment");
    }
    if (!this.state.prototypes.find((x) => x.key === p.key)?.live) return fail(410, "Destroyed after assessment");
    const type = contentTypeFor(path);
    return c.send(200, bytes, type, {
      "Content-Security-Policy": APP_CSP,
      // The viewer frames the page (frame-ancestors 'self' in APP_CSP says the same).
      "X-Frame-Options": "SAMEORIGIN",
      // A page is a navigation (CORP does not apply); its CSS, scripts and images are loaded by its
      // opaque origin, which "same-origin" would block.
      ...(!type.startsWith("text/html") && { "Cross-Origin-Resource-Policy": APP_SUBRESOURCE_CORP }),
    });
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
        ...(p.check && { check: p.check }),
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
        url: `${this.base}p/${p.key}/`,
      })),
    };
  }

  /** A page: the stylesheet and scripts are static routes under the token (nothing inline). */
  private page(title: string, body: string, opts: { bodyAttrs?: string; scripts?: string[]; mermaid?: boolean } = {}): string {
    const b = esc(this.base);
    const scripts =
      (opts.mermaid
        ? `<script src="${esc(MERMAID_SCRIPT_URL)}" integrity="${MERMAID_SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`
        : "") + (opts.scripts ?? []).map((s) => `<script src="${b}static/${s}"></script>`).join("");
    return (
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><link rel="stylesheet" href="${b}static/board.css"></head>` +
      `<body${opts.bodyAttrs ?? ""}><main>${body}</main>${scripts}</body></html>`
    );
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
              (p.live ? `<p><a href="${esc(this.base)}p/${esc(p.key)}/">Open prototype</a></p>` : `<p class="meta">Destroyed.</p>`) +
              `</article>`
          )
          .join("")}</div>`
      : `<p class="empty">No prototypes yet. They appear here as the participants propose them.</p>`;
    return this.page("Prototype board", this.header() + `<h2>Prototypes</h2>` + cards, {
      bodyAttrs: ` data-rev="${this.rev}" data-base="${esc(this.base)}"`,
      scripts: ["board.js"],
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
    let mermaid = false;
    if (p.kind === "web" && live.entry) {
      const src = `${this.base}p/${p.key}/app/${encodePath(live.entry)}`;
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
      mermaid = !mermaidConfigured(code);
      content =
        `<h2>Diagram</h2>` +
        (mermaid
          ? `<pre class="mermaid">${esc(code)}</pre>`
          : `<p class="notice">Not rendered: this diagram sets Mermaid's own configuration (an %%{…}%% directive or front matter), which the board does not allow. Its source is below.</p>`) +
        `<h2>Source</h2>${this.filesHtml(live.files, !mermaid)}`;
    } else {
      content = `<h2>${p.kind === "text" ? "Draft" : "Source (never executed)"}</h2>${this.filesHtml(live.files, true)}`;
    }
    const body =
      `<p class="meta"><a href="${esc(this.base)}">← Board</a></p>` +
      `<h1>${esc(p.label)} · ${esc(p.title)}</h1>` +
      `<p class="meta">${esc(p.kind)} · proposed by ${esc(p.proposer)}</p>` +
      `<p class="notice">Read-only. Feedback opens when the session ends. This prototype is destroyed as soon as it has been assessed.</p>` +
      `<p><span class="badge s-${esc(p.status)}" id="status">${esc(statusText(p))}</span></p>` +
      (p.kind === "web" ? `<p id="page-check">${esc(pageCheckSummary(p.check))}</p>` : "") +
      `<p class="meta" id="awaiting">${p.awaiting.length ? `Awaiting verdicts from: ${esc(p.awaiting.join(", "))}` : ""}</p>` +
      `<h2>Verdicts so far</h2>${verdictsHtml(p)}` +
      (p.demo.trim() ? `<h2>Demo walkthroughs</h2><div class="demo">${esc(p.demo)}</div>` : "") +
      content;
    return this.page(`${p.label} · ${p.title}`, body, {
      bodyAttrs: ` data-key="${esc(p.key)}" data-base="${esc(this.base)}"`,
      scripts: mermaid ? ["viewer.js", "mermaid-init.js"] : ["viewer.js"],
      mermaid,
    });
  }

  private destroyedPage(p: BoardPrototype): string {
    const body =
      `<p class="meta"><a href="${esc(this.base)}">← Board</a></p>` +
      `<h1>${esc(destroyedHeading(p))}</h1>` +
      `<p><strong>${esc(p.label)}</strong> · ${esc(p.title)} · ${esc(p.kind)} · proposed by ${esc(p.proposer)}</p>` +
      `<p><span class="badge s-${esc(p.status)}">${esc(statusText(p))}</span></p>` +
      `<h2>Verdicts</h2>${verdictsHtml(p)}` +
      decisionHtml(p) +
      `<p class="notice">Prototypes are ephemeral: the artifact no longer exists. Feedback opens when the session ends.</p>`;
    return this.page(`${p.label} · destroyed`, body);
  }
}

function serveStatic(c: RouteContext): void {
  const name = c.match![1];
  const file = Object.hasOwn(STATIC_FILES, name) ? STATIC_FILES[name] : undefined;
  if (!file) return c.notFound();
  c.send(200, file.body, file.type);
}

/**
 * Open the board in the default browser. Best effort: detached, errors ignored; only our own local URL.
 * The opener gets the "open" allowlist environment (plus what cmd.exe needs on Windows), never secrets.
 */
export function openInBrowser(url: string): void {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]{8,64}\/$/.test(url)) return;
  try {
    const env = childEnv("open", process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
      : {});
    const opts = { detached: true, stdio: "ignore" as const, windowsHide: true, env };
    const opener = findExecutable(process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", env.PATH);
    if (!opener) return;
    const child =
      process.platform === "darwin"
        ? spawn(opener, [url], opts)
        : process.platform === "win32"
          ? spawn(opener, ["/c", "start", '""', url], { ...opts, windowsVerbatimArguments: true })
          : spawn(opener, [url], opts);
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
