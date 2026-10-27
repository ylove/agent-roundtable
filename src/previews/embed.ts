// ============================================================================
// Embedding previews in the dashboard task page, the duel room and the serve index
//
// Live and loaded click previews use sandbox="allow-scripts allow-forms", without same-origin.
// Their loopback origins enter frame-src; screenshot previews use a stored page-check PNG instead.
// Text about a preview is redacted and escaped. All handlers live in external scripts.
// ============================================================================

import { redact } from "../publishers/redact.js";
import { escapeHtml, type Route } from "../http/secure-server.js";
import { ORIGIN_RE, readPreviewScreenshot, readRecords, touchRecord, type PreviewRecord } from "./store.js";

export const PREVIEW_SANDBOX = "allow-scripts allow-forms";

const text = (s: unknown): string => escapeHtml(redact(String(s ?? "")).text);

/** The distinct, well-formed origins eligible for frames (live and click). */
export function previewOrigins(records: readonly (Pick<PreviewRecord, "origin"> & Partial<Pick<PreviewRecord, "display">>)[]): string[] {
  return [...new Set(records.filter(r => r.display !== "screenshot").map((r) => r.origin).filter((o) => ORIGIN_RE.test(o)))];
}

/** Public room metadata; screenshot URLs are relative to its capability root. */
export function previewView(r: PreviewRecord) {
  return { id: r.id, origin: r.origin, label: redact(previewLabel(r)).text, display: r.display,
    ...(readPreviewScreenshot(r.id) && { screenshot: `preview-shots/${r.id}.png` }) };
}

/** Only images belonging to this page's previews can be read through its capability. */
export function previewScreenshotRoute(records: () => readonly PreviewRecord[]): Route {
  return { path: /^\/preview-shots\/(prv-[0-9a-hjkmnp-tv-z]{8})\.png$/, handler: ctx => {
    const id = ctx.match![1];
    if (!records().some(r => r.id === id)) return ctx.notFound();
    const bytes = readPreviewScreenshot(id);
    return bytes ? ctx.send(200, bytes, "image/png") : ctx.notFound();
  } };
}

/**
 * The page CSP with frame-src for exactly these origins. A CSP that already has a frame-src gets the
 * origins appended to it; otherwise the directive is added. With no origins the CSP is returned as is.
 */
export function withFrameSrc(csp: string, origins: readonly string[]): string {
  const valid = [...new Set(origins.filter((o) => ORIGIN_RE.test(o)))];
  if (!valid.length) return csp;
  const parts = csp.split(";").map((p) => p.trim()).filter(Boolean);
  const at = parts.findIndex((p) => p === "frame-src" || p.startsWith("frame-src "));
  if (at >= 0) parts[at] = `${parts[at]} ${valid.join(" ")}`;
  else parts.push(`frame-src ${valid.join(" ")}`);
  return parts.join("; ");
}

/** What a preview is, in words (task or prototype name). */
export function previewLabel(r: Pick<PreviewRecord, "source">): string {
  return r.source.kind === "task" ? `task ${r.source.task ?? ""}` : `prototype ${r.source.prototype ?? ""}`;
}

/** A frame, click card or page-check screenshot for each preview. */
export function previewFramesHtml(records: readonly PreviewRecord[], base = ""): string {
  const items = records.filter((r) => ORIGIN_RE.test(r.origin)).map((r) => {
    const check = r.check && !r.check.loaded && r.check.reason !== "disabled" && r.check.reason !== "no browser" ? " · page check: did not load" : "";
    const caption = `<figure class="preview"><figcaption>${text(r.id)} · ${text(previewLabel(r))} · ${text(r.origin)}${check}</figcaption>`;
    if (r.display === "click") return caption + `<button type="button" data-preview-origin="${escapeHtml(r.origin)}" data-preview-id="${text(r.id)}">Load preview</button></figure>`;
    const link = `<a href="${escapeHtml(r.origin)}/" target="_blank" rel="noopener noreferrer">Open in a new tab</a>`;
    if (r.display === "screenshot") {
      const shot = previewView(r).screenshot;
      return caption + (shot ? `<img class="preview-shot" src="${escapeHtml(base + shot)}" alt="Page check for ${text(previewLabel(r))}">` : `<p>No page-check screenshot yet.</p>`) + link + `</figure>`;
    }
    return caption + link + `<iframe class="preview" sandbox="${PREVIEW_SANDBOX}" src="${escapeHtml(r.origin)}/" title="Preview ${text(r.id)}" referrerpolicy="no-referrer" loading="lazy"></iframe></figure>`;
  });
  return items.length ? `<h2>Previews</h2>${items.join("")}` : "";
}

/**
 * The running previews, optionally filtered. With `touch`, they count as used and their idle time
 * restarts (pages that reload on a timer pass false, or an open tab would keep a preview alive forever).
 */
export function livePreviews(filter?: (r: PreviewRecord) => boolean, touch = false): PreviewRecord[] {
  const found = readRecords().filter((r) => !filter || filter(r));
  if (touch) for (const r of found) touchRecord(r.id);
  return found;
}
