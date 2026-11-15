// ============================================================================
// Embedding previews in the dashboard task page, the duel room and the serve index
//
// A preview is a page served by another origin (http://127.0.0.1:<port>). It is shown in an iframe
// with sandbox="allow-scripts allow-forms" (no allow-same-origin, so the page cannot reach the
// embedding page's origin or storage), and each embedding page's CSP gains frame-src for exactly the
// running previews' origins. Nothing else in a CSP is loosened. Text about a preview is redacted
// and escaped.
// ============================================================================

import { redact } from "../publishers/redact.js";
import { escapeHtml } from "../http/secure-server.js";
import { ORIGIN_RE, readRecords, touchRecord, type PreviewRecord } from "./store.js";

export const PREVIEW_SANDBOX = "allow-scripts allow-forms";

const text = (s: unknown): string => escapeHtml(redact(String(s ?? "")).text);

/** The distinct, well-formed origins of these previews. */
export function previewOrigins(records: readonly Pick<PreviewRecord, "origin">[]): string[] {
  return [...new Set(records.map((r) => r.origin).filter((o) => ORIGIN_RE.test(o)))];
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

/** One iframe plus a caption for each preview. Empty string when there is none. */
export function previewFramesHtml(records: readonly PreviewRecord[]): string {
  const items = records.filter((r) => ORIGIN_RE.test(r.origin)).map((r) => {
    const check = r.check && !r.check.loaded && r.check.reason !== "disabled" && r.check.reason !== "no browser" ? " · page check: did not load" : "";
    return `<figure class="preview"><figcaption>${text(r.id)} · ${text(previewLabel(r))} · <a href="${escapeHtml(r.origin)}/" target="_blank" rel="noopener noreferrer">${text(r.origin)}</a>${check}</figcaption>` +
      `<iframe class="preview" sandbox="${PREVIEW_SANDBOX}" src="${escapeHtml(r.origin)}/" title="Preview ${text(r.id)}" referrerpolicy="no-referrer" loading="lazy"></iframe></figure>`;
  });
  return items.length ? `<h2>Live preview</h2>${items.join("")}` : "";
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
