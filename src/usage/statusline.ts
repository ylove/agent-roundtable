// ============================================================================
// The status line: `agent-roundtable statusline` (usage-visibility.md §5)
//
// A Claude Code `statusLine` command. It reads the host's JSON on stdin (missing fields and invalid
// JSON are fine) and prints up to three lines:
//   1. the host:        Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%
//   2. the roundtable:  ◆ roundtable  heads-down exe-1a2b3c 4/7 tasks · $1.62 meas + ≈$0.22 est of $20 · table 2 agents ≈$0.05 est
//   3. the busiest agents, highest spend first, each with its platform and a stop hint
// The view is cached for 2 s (usage/statusline.cache.json) so a fast refresh never re-reads every log,
// and the whole command answers within about 150 ms. It never reads or prints message text, prompts,
// diffs or command output, and any failure prints line 1 (or nothing): it must never show a stack trace
// and always exits 0.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { useText, usdBudget, usd } from "./format.js";
import { collectUsage, type HostFigures } from "./model.js";
import { usageDir } from "./table.js";
import { moneyTotal, REPORT_MAX_USD, tokenTotal, type UsageAgent, type UsageView } from "./types.js";

export const CACHE_MS = 2_000;
const STALE_OK_MS = 60_000;
const DEADLINE_MS = 110;
const STDIN_MAX = 256 * 1024;
const DEFAULT_COLS = 120;

export interface StatuslineOptions {
  /** Line 1, the host (default true). */
  host: boolean;
  /** Most agents on line 3 (default 4). */
  agents: number;
  color: boolean;
  cols: number;
}

// ---------------------------------------------------------------------------
// The host's JSON
// ---------------------------------------------------------------------------

export interface HostInput {
  model?: string;
  project?: string;
  five?: { pct: number; resets_at?: number };
  seven?: { pct: number; resets_at?: number };
  cost_usd?: number;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const label = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = scrub(v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return t || undefined;
};

/** The last path segment of a directory, whichever separator the host's system uses. */
export function dirName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  const name = basename(trimmed.replace(/\\/g, "/"));
  return name || undefined;
}

/** A reset time as epoch milliseconds: epoch seconds, epoch milliseconds or an ISO date. */
function resetMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function window(v: unknown): HostInput["five"] {
  const o = obj(v);
  const pct = o?.used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return undefined;
  const at = resetMs(o?.resets_at);
  return { pct: Math.min(999, Math.max(0, Math.round(pct))), ...(at !== undefined && { resets_at: at }) };
}

/** What the host's status line JSON told us. Invalid JSON, wrong types and missing fields give less, never an error. */
export function parseHost(raw: string): HostInput {
  let j: Record<string, unknown> | undefined;
  try {
    j = obj(JSON.parse(raw));
  } catch {
    return {};
  }
  if (!j) return {};
  const model = obj(j.model);
  const ws = obj(j.workspace);
  const rl = obj(j.rate_limits);
  const out: HostInput = {};
  const name = label(model?.display_name, 40) ?? label(model?.id, 40);
  if (name) out.model = name;
  const dir = typeof ws?.project_dir === "string" && ws.project_dir ? ws.project_dir : typeof ws?.current_dir === "string" && ws.current_dir ? ws.current_dir : typeof j.cwd === "string" ? j.cwd : undefined;
  const project = dir ? label(dirName(dir), 40) : undefined;
  if (project) out.project = project;
  const five = window(rl?.five_hour);
  if (five) out.five = five;
  const seven = window(rl?.seven_day);
  if (seven) out.seven = seven;
  const cost = obj(j.cost)?.total_cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) out.cost_usd = Math.min(cost, REPORT_MAX_USD);
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export interface Paint {
  (code: string, s: string): string;
}

export function painter(color: boolean): Paint {
  return (code, s) => (color ? `${ESC}[${code}m${s}${ESC}[0m` : s);
}

export const CYAN = "36";
export const AMBER = "33";
export const RED = "31";
export const DIM = "2";
export const BOLD = "1";

/** Visible width: ANSI sequences take no room. */
export function visibleWidth(s: string): number {
  return Array.from(s.replace(ANSI_RE, "")).length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function windowText(prefix: string, w: NonNullable<HostInput["five"]>, withReset: boolean, paint: Paint): string {
  const pct = `${w.pct}%`;
  const shown = w.pct >= 90 ? paint(RED, pct) : w.pct >= 70 ? paint(AMBER, pct) : pct;
  return `${prefix} ${shown}${withReset && w.resets_at !== undefined ? `→${clock(w.resets_at)}` : ""}`;
}

/** Line 1: model | project | 5h 0%→21:50 | 7d 82%. A field the host did not send is left out with its separator. */
export function hostLine(h: HostInput, paint: Paint = painter(false)): string {
  const parts: string[] = [];
  if (h.model) parts.push(h.model);
  if (h.project) parts.push(h.project);
  if (h.five) parts.push(windowText("5h", h.five, true, paint));
  if (h.seven) parts.push(windowText("7d", h.seven, false, paint));
  return parts.join(" | ");
}

const exeLabel = (id: string): string => `exe-${id.slice(-6)}`;
const noun = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Line 2, or undefined when there is nothing to show. */
export function roundtableLine(view: UsageView, paint: Paint, cols: number): string | undefined {
  const segments: string[] = [];
  const spent = (r: UsageView["runs"][number]) => moneyTotal(r.money) * 1e6 + tokenTotal(r.tokens);
  const live = view.runs.filter((r) => r.live).sort((a, b) => spent(b) - spent(a));
  const run = live[0];
  if (run) {
    const used = moneyTotal(run.money) > 0 || tokenTotal(run.tokens) > 0 ? useText(run.money, run.tokens, "abbr") : usd(0);
    const over = run.budget_pct !== undefined && run.budget_pct >= 80;
    const of = run.budget_usd !== undefined ? `of ${usdBudget(run.budget_usd)}${over ? ` (${Math.round(run.budget_pct!)}%)` : ""}` : "";
    const budget = of ? ` ${over ? paint(RED, of) : of}` : "";
    const more = live.length > 1 ? ` (+${live.length - 1} more)` : "";
    segments.push(`heads-down ${exeLabel(run.id)} ${run.tasks.done}/${run.tasks.total} tasks · ${used}${budget}${more}`);
  }
  const table = view.table;
  const tableSeg = table.agents > 0 ? `table ${noun(table.agents, "agent")} ${useText(table.money, table.tokens, "abbr")}` : undefined;
  if (!segments.length && !tableSeg) return undefined;
  const head = `${paint(CYAN, "◆ roundtable")}  `;
  const full = head + [...segments, ...(tableSeg ? [tableSeg] : [])].join(" · ");
  if (visibleWidth(full) <= cols || !tableSeg || !segments.length) return full;
  return head + segments.join(" · "); // too wide: the table segment goes first
}

function agentSegment(a: UsageAgent, paint: Paint, chip: boolean): string {
  const name = a.state === "stopped" ? paint(AMBER, a.id) : a.state === "working" ? paint(CYAN, a.id) : a.id;
  const flag = a.state === "stopped" ? ` ${paint(AMBER, "(stopped)")}` : a.stopping ? ` ${paint(AMBER, "(stopping)")}` : "";
  const platform = chip && a.provider ? ` [${a.provider}]` : "";
  return `${name}${flag} ${useText(a.money, a.tokens, "abbr")}${platform}`;
}

/** The stop hint: the exact command when one agent could be stopped, else the generic form. */
export function stopHint(view: UsageView): string | undefined {
  const stoppable = view.agents.filter((a) => a.stoppable);
  if (!stoppable.length) return undefined;
  return `stop: agent-roundtable stop ${stoppable.length === 1 ? stoppable[0].id : "<agent>"}`;
}

/** Line 3: the busiest agents with their platforms, fitted to `cols` by dropping agents before anything else. */
export function agentsLine(view: UsageView, paint: Paint, max: number, cols: number): string | undefined {
  const liveRuns = new Set(view.runs.filter((r) => r.live).map((r) => r.id));
  const candidates = view.agents.filter(
    (a) => a.where !== "host" && !a.label && (a.state !== "done" || liveRuns.has(a.scope)) && (a.state !== "idle" || moneyTotal(a.money) > 0 || tokenTotal(a.tokens) > 0)
  );
  let shown = candidates.slice(0, Math.max(0, max));
  if (!shown.length) return undefined;
  const hint = stopHint(view);
  const build = (agents: UsageAgent[], withHint: boolean, chip: boolean): string =>
    "  " + [...agents.map((a) => agentSegment(a, paint, chip)), ...(withHint && hint ? [paint(DIM, hint)] : [])].join(" · ");
  // Too wide: agents go down to two while the hint stays, then the hint goes, then agents down to one.
  let line = build(shown, true, true);
  while (visibleWidth(line) > cols && shown.length > 2) {
    shown = shown.slice(0, -1);
    line = build(shown, true, true);
  }
  if (visibleWidth(line) > cols) line = build(shown, false, true);
  while (visibleWidth(line) > cols && shown.length > 1) {
    shown = shown.slice(0, -1);
    line = build(shown, false, true);
  }
  // One agent left and still too wide: the platform chip goes, never a provenance label.
  if (visibleWidth(line) > cols) line = build(shown, false, false);
  return line;
}

/** The lines to print. Pure: the view and the host's figures in, text out. */
export function renderStatusline(view: UsageView | undefined, host: HostInput, o: StatuslineOptions): string[] {
  const paint = painter(o.color);
  const lines: string[] = [];
  if (o.host) {
    const l1 = hostLine(host, paint);
    if (l1) lines.push(l1);
  }
  if (view) {
    const l2 = roundtableLine(view, paint, o.cols);
    if (l2) lines.push(l2);
    const l3 = l2 ? agentsLine(view, paint, o.agents, o.cols) : undefined;
    if (l3) lines.push(l3);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const cachePath = (home: string): string => join(usageDir(home), "statusline.cache.json");

function readCache(home: string, now: number, maxAge: number): UsageView | undefined {
  try {
    const c = JSON.parse(readFileSync(cachePath(home), "utf8")) as { at?: unknown; view?: UsageView };
    if (typeof c.at !== "number" || now - c.at > maxAge || !c.view || !Array.isArray(c.view.agents) || !Array.isArray(c.view.runs) || !c.view.table) return undefined;
    return c.view;
  } catch {
    return undefined;
  }
}

function writeCache(home: string, view: UsageView, now: number): void {
  try {
    mkdirPrivate(usageDir(home));
    writeFileAtomic(cachePath(home), JSON.stringify({ at: now, view }) + "\n");
  } catch {
    /* a cache that cannot be written is only slower */
  }
}

/** The host agent's latest figures, for `usage` (the status line writes them; they are reported, not measured). */
export function writeHostFigures(home: string, h: HostFigures): void {
  try {
    mkdirPrivate(usageDir(home));
    writeFileAtomic(join(usageDir(home), "host.json"), JSON.stringify(h) + "\n");
  } catch {
    /* best effort */
  }
}

/** The host's figures the status line saved less than `maxAgeMs` ago. */
export function readHostFigures(home = ROUNDTABLE_HOME, now = Date.now(), maxAgeMs = 30 * 60_000): HostFigures | undefined {
  try {
    const h = JSON.parse(readFileSync(join(usageDir(home), "host.json"), "utf8")) as HostFigures;
    const at = typeof h.at === "string" ? Date.parse(h.at) : NaN;
    if (!Number.isFinite(at) || now - at > maxAgeMs) return undefined;
    return {
      ...(typeof h.model === "string" && { model: label(h.model, 40) }),
      ...(typeof h.cost_usd === "number" && Number.isFinite(h.cost_usd) && h.cost_usd >= 0 && { cost_usd: Math.min(h.cost_usd, REPORT_MAX_USD) }),
      at: h.at,
    };
  } catch {
    return undefined;
  }
}

export interface RunOptions extends StatuslineOptions {
  home?: string;
  now?: number;
}

/** The view for the status line: cached for 2 s, and never later than the deadline (a stale view, or none, beats a slow line). */
async function viewFor(home: string, now: number): Promise<UsageView | undefined> {
  if (!existsSync(home)) return undefined;
  const fresh = readCache(home, now, CACHE_MS);
  if (fresh) return fresh;
  const work = collectUsage({ home, now }).then((v) => {
    writeCache(home, v, now);
    return v;
  });
  work.catch(() => undefined);
  const timer = new Promise<undefined>((r) => setTimeout(() => r(undefined), DEADLINE_MS).unref());
  try {
    return (await Promise.race([work, timer])) ?? readCache(home, now, STALE_OK_MS);
  } catch {
    return readCache(home, now, STALE_OK_MS);
  }
}

/** Everything the command prints, as text. Never throws. */
export async function statuslineText(stdin: string, o: RunOptions): Promise<string> {
  const host = parseHost(stdin);
  const home = o.home ?? ROUNDTABLE_HOME;
  const now = o.now ?? Date.now();
  let view: UsageView | undefined;
  try {
    view = await viewFor(home, now);
    if (existsSync(home) && (host.cost_usd !== undefined || host.model)) {
      writeHostFigures(home, { ...(host.model && { model: host.model }), ...(host.cost_usd !== undefined && { cost_usd: host.cost_usd }), at: new Date(now).toISOString() });
    }
    return renderStatusline(view, host, o).join("\n");
  } catch {
    try {
      return renderStatusline(undefined, host, o).join("\n");
    } catch {
      return "";
    }
  }
}

/** Read stdin without waiting for a terminal or a host that never closes it. */
export function readStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean }, timeoutMs = 300): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.pause?.(); // a host that keeps stdin open must not keep the process alive
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
      if (data.length > STDIN_MAX) {
        data = data.slice(0, STDIN_MAX);
        return finish();
      }
      // A host that keeps stdin open after its JSON must not make the line wait for the timeout.
      try {
        JSON.parse(data);
        finish();
      } catch {
        /* not all of it yet */
      }
    });
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

export function defaultCols(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.COLUMNS);
  return Number.isInteger(n) && n >= 40 && n <= 500 ? n : DEFAULT_COLS;
}
