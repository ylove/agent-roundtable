// ============================================================================
// The site shell shared by every serve-index page: header band, mark, top nav
//
// Index pages live under one capability root (`indexBase`). A run's pages add their own sub-nav
// below this header. The standalone per-run dashboard (no index) keeps its own run nav only.
// Nothing here is inline script or style: the page CSP allows 'self' only.
// ============================================================================

import { escapeHtml } from "../http/secure-server.js";

export type SiteSection = "overview" | "runs" | "duels" | "escalations";

/** Top-level index sections, in nav order: [key, label, path under the index base]. */
export const SITE_NAV: ReadonlyArray<readonly [SiteSection, string, string]> = [
  ["overview", "Overview", ""],
  ["runs", "Runs", "runs"],
  ["duels", "Duels", "duels"],
  ["escalations", "Escalations", "escalations"],
];

/** A small round-table mark: a ring of seats. Decorative, so hidden from assistive tech. */
export const MARK_SVG = `<svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">` +
  `<circle cx="16" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/>` +
  [0, 60, 120, 180, 240, 300].map(a => {
    const r = (a * Math.PI) / 180;
    return `<circle cx="${(16 + 12 * Math.cos(r)).toFixed(2)}" cy="${(16 + 12 * Math.sin(r)).toFixed(2)}" r="2.6" fill="currentColor"/>`;
  }).join("") + `</svg>`;

/** The header band: the mark and name at the top left (home), then the section nav. */
export function siteHeader(indexBase: string, active?: SiteSection): string {
  const b = escapeHtml(indexBase);
  const links = SITE_NAV.map(([key, label, path]) =>
    `<a href="${b}${path}"${key === active ? ` class="here" aria-current="page"` : ""}>${label}</a>`).join("");
  return `<header class="site-header"><div class="site-inner"><a class="brand" href="${b}">${MARK_SVG}<span>Roundtable</span></a>` +
    `<nav class="site-nav" aria-label="Sections">${links}</nav></div></header>`;
}

export interface SitePageOptions {
  /** The index capability root, ending in "/". */
  base: string;
  title: string;
  active?: SiteSection;
  body: string;
  /** Extra <head> markup, such as a nonce meta. Must already be escaped. */
  head?: string;
  /** Stylesheets and scripts under the index base, after the shared ones. */
  stylesheets?: string[];
  scripts?: string[];
}

/** A complete index page: shared stylesheet and script, header band, then the content area. */
export function sitePage(o: SitePageOptions): string {
  const b = escapeHtml(o.base);
  const css = ["static/dashboard.css", ...(o.stylesheets ?? [])].map(p => `<link rel="stylesheet" href="${b}${escapeHtml(p)}">`).join("");
  const js = ["static/dashboard.js", ...(o.scripts ?? [])].map(p => `<script src="${b}${escapeHtml(p)}"></script>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `${o.head ?? ""}<title>${escapeHtml(o.title)} · Roundtable</title>${css}</head>` +
    `<body>${siteHeader(o.base, o.active)}<main>${o.body}</main>${js}</body></html>`;
}
