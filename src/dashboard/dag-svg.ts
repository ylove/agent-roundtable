// ============================================================================
// Task DAG as a server-rendered SVG: a simple layered layout, no libraries
//
// A task's layer is one more than its deepest dependency's, so every edge points right. Within a
// layer, tasks are ordered by the mean position of their dependencies (one barycenter pass),
// then by id. Nodes are colored by state with presentation attributes, so the SVG reads the same
// inline, as an image or opened on its own. Every label is escaped (and redacted).
// ============================================================================

import { escapeHtml } from "../http/secure-server.js";
import { redact } from "../publishers/redact.js";
import type { BlackboardState, TaskRuntime, TaskState } from "../execution/types.js";

const NODE_W = 196;
const NODE_H = 46;
const GAP_X = 64;
const GAP_Y = 18;
const PAD = 16;
const LABEL_CHARS = 26;

/** [fill, stroke] per task state. */
export const STATE_COLORS: Readonly<Record<TaskState, readonly [string, string]>> = {
  pending: ["#eceff3", "#8a94a6"],
  ready: ["#e3edff", "#2f6fde"],
  claimed: ["#fff4d6", "#a5660a"],
  in_progress: ["#fff4d6", "#a5660a"],
  submitted: ["#efe3ff", "#7a4cc2"],
  checking: ["#efe3ff", "#7a4cc2"],
  merging: ["#efe3ff", "#7a4cc2"],
  accepted: ["#dff5e8", "#1f8a4c"],
  blocked: ["#ffe2df", "#b3261e"],
  paused: ["#f0f0ee", "#6b6b70"],
  failed: ["#ffd6d2", "#b3261e"],
  cancelled: ["#f0f0ee", "#9a9aa2"],
};

/** Not allowed in XML 1.0 (dag.svg is served on its own): C0 controls but tab, LF and CR, DEL, U+FFFE/FFFF, lone surrogates. */
const XML_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text for the SVG: redacted first, then cut to `max` code points, then made XML-safe and escaped. */
function text(s: unknown, max = Infinity): string {
  const chars = Array.from(redact(String(s ?? "")).text);
  const cut = chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
  return escapeHtml(cut.replace(XML_UNSAFE, ""));
}

/** Layer of every task: 0 without dependencies, else 1 + the deepest known dependency (cycles are cut). */
export function layers(tasks: Record<string, TaskRuntime>): Map<string, number> {
  const out = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle (contracts are validated as DAGs): cut it here
    visiting.add(id);
    let layer = 0;
    for (const d of [...(tasks[id]?.spec.depends_on ?? []), ...(tasks[id]?.spec.parent ? [tasks[id].spec.parent!] : [])]) {
      if (Object.hasOwn(tasks, d) && d !== id) layer = Math.max(layer, visit(d) + 1);
    }
    visiting.delete(id);
    out.set(id, layer);
    return layer;
  };
  for (const id of Object.keys(tasks).sort()) visit(id);
  return out;
}

export interface DagSvgOptions {
  /** "/<token>/": nodes link to <base>tasks/<id>. Without it, nodes are not links. */
  base?: string;
  /** Add the XML namespace declarations for serving the SVG as a file. */
  standalone?: boolean;
}

export function renderDagSvg(state: BlackboardState, opts: DagSvgOptions = {}): string {
  const tasks = state.tasks;
  const ids = Object.keys(tasks).sort();
  const ns = opts.standalone ? ` xmlns="http://www.w3.org/2000/svg"` : "";
  if (ids.length === 0) {
    return `<svg${ns} class="dag" role="img" aria-label="No tasks yet" width="240" height="40" viewBox="0 0 240 40">` +
      `<rect class="bg" x="0" y="0" width="240" height="40" fill="#fafafa"/>` +
      `<text x="${PAD}" y="25" fill="#1d1d1f">No tasks yet.</text></svg>`;
  }
  const layerOf = layers(tasks);
  const columns: string[][] = [];
  for (const id of ids) (columns[layerOf.get(id)!] ??= []).push(id);
  const row = new Map<string, number>();
  for (const col of columns) {
    if (!col) continue;
    const key = (id: string) => {
      const deps = [...tasks[id].spec.depends_on, ...(tasks[id].spec.parent ? [tasks[id].spec.parent!] : [])].filter((d) => row.has(d));
      return deps.length ? deps.reduce((s, d) => s + row.get(d)!, 0) / deps.length : Number.POSITIVE_INFINITY;
    };
    const keyed = col.map((id) => ({ id, k: key(id) }));
    keyed.sort((a, b) => (a.k === b.k ? (a.id < b.id ? -1 : 1) : a.k - b.k));
    keyed.forEach(({ id }, i) => row.set(id, i));
  }
  const rows = Math.max(...columns.map((c) => c?.length ?? 0));
  const width = PAD * 2 + columns.length * NODE_W + (columns.length - 1) * GAP_X;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y;
  const pos = (id: string) => ({
    x: PAD + layerOf.get(id)! * (NODE_W + GAP_X),
    y: PAD + row.get(id)! * (NODE_H + GAP_Y),
  });

  const edges: string[] = [];
  for (const id of ids) {
    const to = pos(id);
    for (const d of [...tasks[id].spec.depends_on, ...(tasks[id].spec.parent ? [tasks[id].spec.parent!] : [])]) {
      if (!Object.hasOwn(tasks, d) || d === id || layerOf.get(d)! >= layerOf.get(id)!) continue;
      const from = pos(d);
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x - 4;
      const y2 = to.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const parentEdge = tasks[id].spec.parent === d;
      edges.push(`<path class="edge${parentEdge ? " parent-edge" : ""}"${parentEdge ? ' stroke-dasharray="5 4"' : ""} d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="#8a94a6" stroke-width="1.5" marker-end="url(#rt-dag-arrow)"/>`);
    }
  }

  const nodes = ids.map((id) => {
    const rt = tasks[id];
    const { x, y } = pos(id);
    const [fill, stroke] = STATE_COLORS[rt.state] ?? STATE_COLORS.pending;
    const pct = typeof rt.percent === "number" && Number.isFinite(rt.percent) ? ` · ${Math.round(Math.min(100, Math.max(0, rt.percent)))}%` : "";
    const dash = rt.state === "cancelled" ? ` stroke-dasharray="4 3"` : "";
    const inner =
      `<title>${text(`${id}: ${rt.spec.title} (${rt.state})`)}</title>` +
      `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}/>` +
      `<text x="${x + 10}" y="${y + 19}" fill="#1d1d1f">${text(id, LABEL_CHARS)}</text>` +
      `<text class="sub" x="${x + 10}" y="${y + 36}" fill="#55555a">${text(rt.spec.title, LABEL_CHARS - 6)} · ${text(rt.state.replace(/_/g, " "))}${pct}</text>`;
    const node = opts.base ? `<a href="${escapeHtml(`${opts.base}tasks/${encodeURIComponent(id)}`)}">${inner}</a>` : inner;
    return `<g class="node st-${escapeHtml(rt.state)}">${node}</g>`;
  });

  return (
    `<svg${ns} class="dag" role="img" aria-label="Task dependency graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><marker id="rt-dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0 0 L10 5 L0 10 z" fill="#8a94a6"/></marker></defs>` +
    `<rect class="bg" x="0" y="0" width="${width}" height="${height}" fill="#fafafa"/>` +
    edges.join("") +
    nodes.join("") +
    `</svg>`
  );
}
