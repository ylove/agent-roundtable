// ============================================================================
// Execution dashboard: server-rendered pages
//
// Every string that comes from the run (contract, notes, escalations, diffs, event payloads,
// even ids) is redacted (secrets and personal data) and then HTML-escaped where it is inserted.
// Pages carry no inline script, style or event handler: the stylesheet and the live-update
// script are static routes (assets.ts), and links are built from validated ids only. Contract
// markdown goes through a small converter that escapes everything and passes no raw HTML.
// ============================================================================

import { escapeHtml } from "../http/secure-server.js";
import { redact } from "../publishers/redact.js";
import { ID_RE } from "../execution/events.js";
import {
  EVENT_TYPES,
  type AnyEvent,
  type BlackboardState,
  type Contract,
  type Escalation,
  type ExecutionHeader,
  type TaskRuntime,
  type TaskState,
} from "../execution/types.js";
import { renderDagSvg } from "./dag-svg.js";

/** Redacted text (secrets and personal data). */
export const red = (s: unknown): string => redact(String(s ?? "")).text;
/** Redacted, then HTML-escaped: the only way run content reaches a page. */
const t = (s: unknown): string => escapeHtml(red(s));
/** Cut to n characters (code points, so no surrogate pair is split). */
const cap = (s: string, n: number) => {
  if (s.length <= n) return s;
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
};
/** Redacted, then capped: cutting first could leave half an email or key that no rule matches. */
const rc = (s: unknown, n: number): string => cap(red(s), n);
/** Redacted, capped, escaped. */
const tc = (s: unknown, n: number): string => escapeHtml(rc(s, n));
const money = (n: number) => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
const pctOf = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : undefined);

// ---------------------------------------------------------------------------
// Derived numbers
// ---------------------------------------------------------------------------

/**
 * A task's share of completion (heads-down.md §13): accepted 1, submitted (and checking or merging)
 * 0.8, in progress the reported percent or 0.4. A blocked or paused task that has an agent counts as
 * in progress; anything else counts 0.
 */
export function taskWeight(rt: TaskRuntime): number {
  const reported = pctOf(rt.percent);
  const working = reported !== undefined ? reported / 100 : 0.4;
  switch (rt.state) {
    case "accepted":
      return 1;
    case "submitted":
    case "checking":
    case "merging":
      return 0.8;
    case "claimed":
    case "in_progress":
      return working;
    case "blocked":
    case "paused":
      return rt.agent ? working : 0;
    default:
      return 0;
  }
}

export interface Completion {
  /** 0–100, rounded. Cancelled tasks (split or dropped) are left out. */
  percent: number;
  total: number;
  byState: Partial<Record<TaskState, number>>;
}

export function completion(state: BlackboardState): Completion {
  const byState: Partial<Record<TaskState, number>> = {};
  let sum = 0;
  let total = 0;
  for (const rt of Object.values(state.tasks)) {
    byState[rt.state] = (byState[rt.state] ?? 0) + 1;
    if (rt.state === "cancelled") continue;
    total++;
    sum += taskWeight(rt);
  }
  return { percent: total ? Math.round((sum / total) * 100) : 0, total, byState };
}

export function budgetOf(state: BlackboardState): { spent: number; limit?: number; pct?: number; estimated: boolean } {
  const spent = state.budget.spent_usd;
  const base = state.contract?.budget?.usd;
  const limit = typeof base === "number" ? base + state.budget.extensions_usd : undefined;
  const pct = limit && limit > 0 ? Math.round((spent / limit) * 100) : undefined;
  return { spent, ...(limit !== undefined && { limit }), ...(pct !== undefined && { pct }), estimated: state.budget.estimated };
}

/** Runner liveness from runner.json (written by the runner every 5 s); stale after 30 s. */
export interface RunnerHealth {
  status: "alive" | "stale" | "unknown";
  detail: string;
}

/** The task an event is about, if any. */
export function eventTask(ev: AnyEvent): string | undefined {
  const p = ev.payload as unknown as Record<string, unknown>;
  if (typeof p.task === "string") return p.task;
  switch (ev.type) {
    case "escalation.raised":
      return ev.payload.escalation.task;
    case "lease.granted":
      return ev.payload.lease.task;
    case "lease.queued":
      return ev.payload.request.task;
  }
  return ev.source.task;
}

/** One redacted line describing an event's payload. */
export function eventSummary(ev: AnyEvent, max = 280): string {
  let s: string;
  try {
    s = JSON.stringify(ev.payload);
  } catch {
    s = "";
  }
  return cap(red(s), max);
}

/** Open escalations waiting for a human, newest first. */
export function awaitingHuman(state: BlackboardState): Escalation[] {
  return Object.values(state.escalations)
    .filter((e) => e.status === "awaiting_human")
    .sort((a, b) => b.raised_seq - a.raised_seq);
}

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

export type PageKey = "overview" | "tasks" | "dag" | "escalations" | "events" | "contract" | "task";

export interface PageContext {
  state: BlackboardState;
  header: ExecutionHeader;
  /** "/<token>/" */
  base: string;
  runner: RunnerHealth;
}

const NAV: Array<[Exclude<PageKey, "task">, string, string]> = [
  ["overview", "Overview", ""],
  ["tasks", "Tasks", "tasks"],
  ["dag", "Graph", "dag"],
  ["escalations", "Escalations", "escalations"],
  ["events", "Events", "events"],
  ["contract", "Contract", "contract"],
];

/** "reload" pages refresh themselves on new events; the others show a notice. */
const LIVE: Record<PageKey, "reload" | "notice"> = {
  overview: "reload",
  tasks: "reload",
  dag: "reload",
  escalations: "reload",
  events: "notice",
  contract: "notice",
  task: "notice",
};

function badge(state: string): string {
  return `<span class="badge st-${escapeHtml(/^[a-z_]+$/.test(state) ? state : "unknown")}">${t(state.replace(/_/g, " "))}</span>`;
}

const taskHref = (base: string, id: string) => escapeHtml(`${base}tasks/${encodeURIComponent(id)}`);
const taskLink = (base: string, id: string) => (ID_RE.test(id) ? `<a href="${taskHref(base, id)}">${t(id)}</a>` : t(id));

function banner(c: PageContext): string {
  const waiting = awaitingHuman(c.state);
  if (!waiting.length) return "";
  const items = waiting.map(
    (e) =>
      `<li><strong>${t(e.emergency ?? "human action")}</strong>${e.task ? ` · task ${taskLink(c.base, e.task)}` : ""}: ${t(e.summary)}` +
      (e.question ? ` <em>${t(e.question)}</em>` : "") +
      ` <a href="${escapeHtml(c.base)}escalations">(${t(e.id)})</a></li>`
  );
  return `<section class="banner"><h2>A human is needed</h2><ul>${items.join("")}</ul></section>`;
}

function frame(c: PageContext, page: PageKey, title: string, body: string): string {
  const b = escapeHtml(c.base);
  const runTitle = c.state.contract?.title ?? c.state.execution;
  const nav = NAV.map(
    ([key, label, path]) => `<a href="${b}${path}"${key === page || (page === "task" && key === "tasks") ? ` class="here"` : ""}>${label}</a>`
  ).join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${t(title)} · ${tc(runTitle, 80)}</title><link rel="stylesheet" href="${b}static/dashboard.css"></head>` +
    `<body data-base="${b}" data-seq="${c.state.seq}" data-live="${LIVE[page]}"><main>` +
    `<nav>${nav}</nav>` +
    `<p class="meta">${tc(runTitle, 160)} · ${t(c.state.execution)} · ${badge(c.state.status)} · event ${c.state.seq}</p>` +
    `<p class="live" id="live">Read-only. This page follows the run as it happens.</p>` +
    banner(c) +
    body +
    `</main><script src="${b}static/dashboard.js"></script></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function renderOverview(c: PageContext): string {
  const s = c.state;
  const done = completion(s);
  const budget = budgetOf(s);
  const open = Object.values(s.escalations).filter((e) => e.status !== "resolved" && e.status !== "withdrawn").length;
  const counts = Object.entries(done.byState)
    .map(([state, n]) => `${badge(state)} ${n}`)
    .join(" ");
  const notes = s.notes.slice(-5).reverse();
  const body =
    `<h1>${t(s.contract?.title ?? "Heads-down run")}</h1>` +
    (s.goal ? `<p>${t(s.goal.ultimate)}</p>` : `<p class="empty">No contract frozen yet.</p>`) +
    `<div class="cards">` +
    `<div class="card"><h3>Status</h3><div class="big">${badge(s.status)}</div>` +
    (s.paused_tasks.length ? `<p class="meta">Paused tasks: ${s.paused_tasks.map((x) => taskLink(c.base, x)).join(", ")}</p>` : "") +
    `</div>` +
    `<div class="card"><h3>Complete</h3><div class="big">${done.percent}%</div>` +
    `<progress max="100" value="${done.percent}">${done.percent}%</progress><p class="meta">${done.total} task${done.total === 1 ? "" : "s"} ${counts}</p></div>` +
    `<div class="card"><h3>Budget</h3><div class="big">${money(budget.spent)}</div><p class="meta">` +
    (budget.limit !== undefined ? `of ${money(budget.limit)}${budget.pct !== undefined ? ` (${budget.pct}%)` : ""}` : "no budget recorded") +
    (budget.estimated ? " · partly estimated" : "") +
    (s.budget.thresholds_crossed.length ? ` · crossed ${s.budget.thresholds_crossed.map((p) => `${p}%`).join(", ")}` : "") +
    `</p></div>` +
    `<div class="card"><h3>Runner</h3><div class="big">${badge(c.runner.status)}</div>` +
    `<p class="meta">${t(c.runner.detail)}</p></div>` +
    `<div class="card"><h3>Escalations</h3><div class="big">${open}</div><p class="meta"><a href="${escapeHtml(c.base)}escalations">open</a></p></div>` +
    `</div>` +
    `<h2>Task graph</h2><div class="dagwrap">${renderDagSvg(s, { base: c.base })}</div>` +
    `<h2>Recent notes</h2>` +
    (notes.length
      ? `<ul>${notes.map((n) => `<li><strong>${t(n.agent)}</strong> on ${t(n.topic)}: ${tc(n.text, 500)}</li>`).join("")}</ul>`
      : `<p class="empty">No notes yet.</p>`);
  return frame(c, "overview", "Overview", body);
}

/** What a task waits on: its blocking escalation, blocking dependencies, open needs, or unaccepted dependencies. */
function blockers(c: PageContext, rt: TaskRuntime): string {
  const parts: string[] = [];
  if (rt.blocked_by?.escalation) parts.push(`escalation ${t(rt.blocked_by.escalation)}`);
  const deps =
    rt.blocked_by?.deps ??
    (rt.state === "pending" ? rt.spec.depends_on.filter((d) => !Object.hasOwn(c.state.tasks, d) || c.state.tasks[d].state !== "accepted") : []);
  if (deps.length) parts.push(`waits on ${deps.map((d) => taskLink(c.base, d)).join(", ")}`);
  if (rt.blocked_by?.needs?.length) parts.push(`needs ${rt.blocked_by.needs.map((n) => t(n.ref)).join(", ")}`);
  if (c.state.paused_tasks.includes(rt.spec.id)) parts.push("paused");
  return parts.join("; ");
}

function progressCell(rt: TaskRuntime): string {
  const p = pctOf(rt.percent);
  const w = Math.round(taskWeight(rt) * 100);
  return `<progress max="100" value="${w}">${w}%</progress> ${w}%${p !== undefined && p !== w ? ` (reported ${p}%)` : ""}`;
}

export function renderTasks(c: PageContext): string {
  const rows = Object.values(c.state.tasks)
    .sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1))
    .map(
      (rt) =>
        `<tr><td>${taskLink(c.base, rt.spec.id)}<br><span class="meta">${t(rt.spec.title)}</span></td><td>${badge(rt.state)}</td>` +
        `<td>${rt.agent ? t(rt.agent) : `<span class="empty">none</span>`}</td><td class="num">${progressCell(rt)}</td>` +
        `<td class="note">${rt.last_note ? tc(rt.last_note, 400) : ""}</td><td>${blockers(c, rt)}</td></tr>`
    );
  const body =
    `<h1>Tasks</h1>` +
    (rows.length
      ? `<table><thead><tr><th>Task</th><th>State</th><th>Agent</th><th>Progress</th><th>Last note</th><th>Blockers</th></tr></thead>` +
        `<tbody>${rows.join("")}</tbody></table>`
      : `<p class="empty">No tasks yet.</p>`);
  return frame(c, "tasks", "Tasks", body);
}

export interface TaskDetail {
  events: AnyEvent[];
  /** The latest diff, capped at a line boundary (it is redacted here). */
  diff?: { stat: string; text: string; truncated: boolean; commit: string } | { stat: string; error: string; commit: string };
  /** Latest output of failing checks by check key, capped at a line boundary (redacted here). */
  outputs: Record<string, string>;
}

function list(items: string[], empty = "none"): string {
  return items.length ? `<ul>${items.map((i) => `<li>${t(i)}</li>`).join("")}</ul>` : `<p class="empty">${empty}</p>`;
}

/** Diff text with per-line classes (added, removed, hunk). The text is redacted and escaped here. */
function diffHtml(text: string): string {
  return red(text)
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    })
    .join("\n");
}

export function renderTaskDetail(c: PageContext, id: string, d: TaskDetail): string {
  const rt = c.state.tasks[id];
  const spec = rt.spec;
  const checks = Object.entries(c.state.checks.task)
    .filter(([key]) => key.startsWith(`${id}/`))
    .map(([key, ch]) => {
      const out = d.outputs[key];
      return (
        `<tr><td><code>${t(key.slice(id.length + 1))}</code></td><td>${badge(ch.status)}</td>` +
        `<td><code>${ch.signature ? t(ch.signature) : ""}</code></td><td class="num">${ch.streak}</td><td class="num">${ch.at_seq}</td></tr>` +
        (out ? `<tr><td colspan="5"><details><summary>Output (redacted)</summary><pre>${t(out)}</pre></details></td></tr>` : "")
      );
    });
  const diff = d.diff;
  const events = d.events
    .slice(-50)
    .reverse()
    .map((ev) => `<tr><td class="num">${ev.seq}</td><td class="num">${t(ev.ts)}</td><td><code>${t(ev.type)}</code></td><td>${t(ev.source.id)}</td><td class="note">${t(eventSummary(ev))}</td></tr>`);
  const body =
    `<h1>${t(id)}: ${t(spec.title)}</h1>` +
    `<dl><dt>State</dt><dd>${badge(rt.state)}</dd><dt>Agent</dt><dd>${rt.agent ? t(rt.agent) : "none"}</dd>` +
    `<dt>Attempt</dt><dd>${rt.attempt}</dd><dt>Progress</dt><dd>${progressCell(rt)}</dd>` +
    `<dt>Persona</dt><dd>${t(spec.persona)}</dd><dt>Team</dt><dd>${spec.team ? t(spec.team) : "none"}</dd>` +
    `<dt>Kind</dt><dd>${t(spec.kind)}</dd><dt>Depends on</dt><dd>${spec.depends_on.length ? spec.depends_on.map((x) => taskLink(c.base, x)).join(", ") : "nothing"}</dd>` +
    `<dt>Writes</dt><dd>${spec.paths.write.map((p) => `<code>${t(p)}</code>`).join(" ")}</dd>` +
    (rt.branch ? `<dt>Branch</dt><dd><code>${t(rt.branch)}</code></dd>` : "") +
    (rt.last_commit ? `<dt>Last commit</dt><dd><code>${t(rt.last_commit)}</code></dd>` : "") +
    `<dt>Blockers</dt><dd>${blockers(c, rt) || "none"}</dd>` +
    `<dt>Last note</dt><dd>${rt.last_note ? t(rt.last_note) : "none"}</dd></dl>` +
    `<h2>Acceptance</h2>${list(spec.acceptance)}` +
    `<h2>Checks</h2>` +
    (checks.length
      ? `<table><thead><tr><th>Command</th><th>Status</th><th>Signature</th><th>Streak</th><th>At event</th></tr></thead><tbody>${checks.join("")}</tbody></table>`
      : `<p class="empty">No checks have run yet.</p>`) +
    `<h2>Latest diff</h2>` +
    (!diff
      ? `<p class="empty">Nothing submitted yet.</p>`
      : `<p class="meta">Commit <code>${t(diff.commit)}</code> · ${t(diff.stat)}</p>` +
        ("error" in diff
          ? `<p class="empty">${t(diff.error)}</p>`
          : `<pre class="diff">${diffHtml(diff.text)}</pre>` + (diff.truncated ? `<p class="meta">Truncated: the diff is longer than the dashboard shows.</p>` : ""))) +
    `<h2>Recent events</h2>` +
    (events.length
      ? `<table><thead><tr><th>Seq</th><th>Time</th><th>Type</th><th>Source</th><th>Payload</th></tr></thead><tbody>${events.join("")}</tbody></table>`
      : `<p class="empty">No events for this task.</p>`);
  return frame(c, "task", id, body);
}

export function renderEscalations(c: PageContext): string {
  const all = Object.values(c.state.escalations).sort((a, b) => b.raised_seq - a.raised_seq);
  const rows = all.map(
    (e) =>
      `<tr><td><code>${t(e.id)}</code></td><td>${badge(e.status)}</td><td>${e.task ? taskLink(c.base, e.task) : ""}</td><td>${t(e.agent)}</td>` +
      `<td>${t(e.kind)} with ${t(e.with)}${e.target ? ` (${t(e.target)})` : ""}${e.emergency ? `<br>${badge(e.emergency)}` : ""}</td>` +
      `<td class="note">${t(e.summary)}${e.question ? `<br><em>${t(e.question)}</em>` : ""}` +
      (e.options?.length ? `<ul>${e.options.map((o) => `<li>${t(o)}</li>`).join("")}</ul>` : "") +
      `</td><td class="note">${e.resolution ? `${t(e.resolution.action)} by ${t(e.resolution.by)}: ${t(e.resolution.decision)}` : e.routed_to ? `routed to ${t(e.routed_to)}` : ""}</td></tr>`
  );
  const body =
    `<h1>Escalations</h1>` +
    (rows.length
      ? `<table><thead><tr><th>Id</th><th>Status</th><th>Task</th><th>From</th><th>Kind</th><th>Summary</th><th>Resolution</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
      : `<p class="empty">No escalations.</p>`);
  return frame(c, "escalations", "Escalations", body);
}

// --- events ------------------------------------------------------------------

export const EVENTS_PAGE_SIZE = 100;

const EVENT_GROUPS = [...new Set(EVENT_TYPES.map((x) => x.split(".")[0]))];

export interface EventFilter {
  /** An event type ("task.progress") or a group ("task"). */
  type?: string;
  task?: string;
  /** Show events with seq below this (newest first). */
  before?: number;
}

/** Parse the events page query; anything unknown is dropped. */
export function parseEventFilter(q: URLSearchParams): EventFilter {
  const f: EventFilter = {};
  const type = q.get("type") ?? "";
  if ((EVENT_TYPES as readonly string[]).includes(type) || EVENT_GROUPS.includes(type)) f.type = type;
  const task = q.get("task") ?? "";
  if (ID_RE.test(task)) f.task = task;
  const before = Number(q.get("before"));
  if (Number.isSafeInteger(before) && before > 0) f.before = before;
  return f;
}

export function eventMatches(ev: AnyEvent, f: EventFilter): boolean {
  if (f.type && ev.type !== f.type && !ev.type.startsWith(`${f.type}.`)) return false;
  if (f.task && eventTask(ev) !== f.task) return false;
  return f.before === undefined || ev.seq < f.before;
}

function eventsHref(base: string, f: EventFilter): string {
  const q = new URLSearchParams();
  if (f.type) q.set("type", f.type);
  if (f.task) q.set("task", f.task);
  if (f.before) q.set("before", String(f.before));
  const s = q.toString();
  return escapeHtml(`${base}events${s ? `?${s}` : ""}`);
}

/** `page`: the matching events, newest first, at most EVENTS_PAGE_SIZE; `more`: older matches exist. */
export function renderEvents(c: PageContext, f: EventFilter, page: AnyEvent[], more: boolean): string {
  const here = (x: EventFilter) => (x.type === f.type && x.task === f.task ? ` class="here"` : "");
  const types =
    `<a href="${eventsHref(c.base, { task: f.task })}"${here({ task: f.task })}>all types</a>` +
    EVENT_GROUPS.map((g) => `<a href="${eventsHref(c.base, { type: g, task: f.task })}"${here({ type: g, task: f.task })}>${t(g)}</a>`).join("");
  const tasks =
    `<a href="${eventsHref(c.base, { type: f.type })}"${here({ type: f.type })}>all tasks</a>` +
    Object.keys(c.state.tasks)
      .sort()
      .map((id) => `<a href="${eventsHref(c.base, { type: f.type, task: id })}"${here({ type: f.type, task: id })}>${t(id)}</a>`)
      .join("");
  const rows = page.map((ev) => {
    const task = eventTask(ev);
    return (
      `<tr><td class="num">${ev.seq}</td><td class="num">${t(ev.ts)}</td>` +
      `<td><a href="${eventsHref(c.base, { type: ev.type, task: f.task })}"><code>${t(ev.type)}</code></a></td>` +
      `<td>${t(ev.source.kind)}:${t(ev.source.id)}</td><td>${task && ID_RE.test(task) ? `<a href="${eventsHref(c.base, { type: f.type, task })}">${t(task)}</a>` : ""}</td>` +
      `<td class="note">${t(eventSummary(ev))}</td></tr>`
    );
  });
  const oldest = page.length ? page[page.length - 1].seq : undefined;
  const pager =
    `<div class="pager">` +
    (f.before ? `<a href="${eventsHref(c.base, { type: f.type, task: f.task })}">Newest</a>` : "") +
    (more && oldest !== undefined ? `<a href="${eventsHref(c.base, { type: f.type, task: f.task, before: oldest })}">Older</a>` : "") +
    `</div>`;
  const body =
    `<h1>Events</h1>` +
    `<div class="filters"><span class="meta">Type:</span>${types}</div>` +
    `<div class="filters"><span class="meta">Task:</span>${tasks}</div>` +
    (rows.length
      ? `<table><thead><tr><th>Seq</th><th>Time</th><th>Type</th><th>Source</th><th>Task</th><th>Payload</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
      : `<p class="empty">No matching events.</p>`) +
    pager;
  return frame(c, "events", "Events", body);
}

// --- contract ------------------------------------------------------------------

export function renderContract(c: PageContext, markdown: string | undefined, source: string): string {
  const body =
    `<h1>Contract</h1>` +
    (markdown === undefined
      ? `<p class="empty">No contract frozen yet.</p>`
      : `<p class="meta">${t(source)}</p><article class="contract">${markdownToHtml(red(markdown))}</article>`);
  return frame(c, "contract", "Contract", body);
}

export function renderDagPage(c: PageContext): string {
  const legend = (["pending", "ready", "in_progress", "submitted", "accepted", "blocked", "failed", "cancelled"] as TaskState[])
    .map(badge)
    .join(" ");
  return frame(c, "dag", "Task graph", `<h1>Task graph</h1><p class="meta">${legend}</p><div class="dagwrap">${renderDagSvg(c.state, { base: c.base })}</div>`);
}

/** The contract as markdown, for when the contract tools left no CONTRACT.md. */
export function contractMarkdown(k: Contract): string {
  const lines: string[] = [`# ${k.title}`, ""];
  lines.push(`Contract ${k.id}, version ${k.version}. Status: ${k.status}.${k.frozen ? ` Frozen by ${k.frozen.by} at ${k.frozen.at}.` : ""}`, "");
  lines.push("## Goal", "", k.goal?.ultimate ?? "", "");
  if (k.goal?.original_prompt) lines.push("### Original prompt", "", ...k.goal.original_prompt.split("\n").map((l) => `> ${l}`), "");
  if (k.goal?.artifacts?.length) lines.push("### Artifacts", "", ...k.goal.artifacts.map((a) => `- ${a.kind}: ${a.title ? `${a.title} ` : ""}${a.ref}`), "");
  if (k.scope) lines.push("## Scope", "", `- Base ref: \`${k.scope.base_ref}\``, `- Paths: ${(k.scope.paths ?? []).map((p) => `\`${p}\``).join(", ")}`, "");
  lines.push("## Tasks", "");
  for (const task of k.tasks ?? []) {
    lines.push(`### ${task.id}: ${task.title}`, "");
    lines.push(`- Kind: ${task.kind}; persona: ${task.persona}${task.team ? `; team: ${task.team}` : ""}`);
    lines.push(`- Depends on: ${task.depends_on?.length ? task.depends_on.join(", ") : "nothing"}`);
    lines.push(`- Writes: ${(task.paths?.write ?? []).map((p) => `\`${p}\``).join(", ")}`);
    if (task.checks?.length) lines.push(`- Checks: ${task.checks.join(", ")}`);
    if (task.acceptance?.length) lines.push("", "Acceptance:", "", ...task.acceptance.map((a) => `- ${a}`));
    lines.push("");
  }
  if (k.interfaces?.length) {
    lines.push("## Interfaces", "", ...k.interfaces.map((i) => `- **${i.name}** (${i.kind}, owned by ${i.owner}): ${i.description}`), "");
  }
  if (k.decisions?.length) {
    lines.push("## Decisions", "", ...k.decisions.map((d) => `- **${d.id}** (${d.scope}): ${d.text}${d.rationale ? ` (${d.rationale})` : ""}`), "");
  }
  if (k.validation) {
    lines.push("## Validation", "", ...(k.validation.commands ?? []).map((cmd) => `- \`${cmd.id}\`: \`${(cmd.argv ?? []).join(" ")}\` (${cmd.timeout_s} s)`));
    if (k.validation.final?.length) lines.push(`- Final: ${k.validation.final.join(", ")}`);
    lines.push("");
  }
  if (k.budget) {
    lines.push(
      "## Budget",
      "",
      `- ${money(k.budget.usd)} in all, ${money(k.budget.per_task_usd)} per task; ${k.budget.wall_clock_min} min; ` +
        `${k.budget.max_parallel} in parallel; ${k.budget.max_attempts} attempts`,
      ""
    );
  }
  if (k.authority) lines.push("## Authority", "", `- Lead: ${k.authority.lead}; may: ${(k.authority.may ?? []).join(", ") || "nothing"}`, "");
  return lines.join("\n");
}

// --- minimal markdown --------------------------------------------------------

/**
 * Inline markdown on one line: code spans, bold, italics. Everything is escaped first, so the only
 * tags in the output are the ones added here. Links stay text ("label (url)"): no href is ever built.
 */
function inline(s: string): string {
  return s
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/!?\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
    })
    .join("");
}

function tableHtml(rows: string[]): string {
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
  const sep = rows.length > 1 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(rows[1]);
  const head = sep ? `<thead><tr>${cells(rows[0]).map((x) => `<th>${inline(x)}</th>`).join("")}</tr></thead>` : "";
  const body = (sep ? rows.slice(2) : rows).map((r) => `<tr>${cells(r).map((x) => `<td>${inline(x)}</td>`).join("")}</tr>`).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

/**
 * A small, safe markdown subset: headings, paragraphs, flat lists, block quotes, fenced code,
 * tables, rules, and inline code, bold and italics. Raw HTML is escaped like any other text.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];
  let listType: "ul" | "ol" = "ul";
  let quote: string[] = [];
  let table: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (items.length) out.push(`<${listType}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${listType}>`);
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    if (table.length) out.push(tableHtml(table));
    para = [];
    items = [];
    quote = [];
    table = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s*${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      // One level down: the page's own <h1> is the page title.
      const n = Math.min(6, h[1].length + 1);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const li = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      const type = /\d/.test(li[1]) ? "ol" : "ul";
      if (para.length || quote.length || table.length || (items.length && type !== listType)) flush();
      listType = type;
      items.push(li[2]);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      if (!quote.length) flush();
      quote.push(q[1]);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!table.length) flush();
      table.push(line);
      continue;
    }
    if (items.length && /^\s{2,}\S/.test(line)) {
      items[items.length - 1] += " " + line.trim();
      continue;
    }
    if (items.length || quote.length || table.length) flush();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

/**
 * The live-update document: a redacted subset of the blackboard. No diffs, no command output,
 * no blobs, no contract body, no tokens.
 */
export function publicState(state: BlackboardState, runner: RunnerHealth) {
  const done = completion(state);
  const budget = budgetOf(state);
  return {
    execution: state.execution,
    seq: state.seq,
    status: state.status,
    title: state.contract ? red(state.contract.title) : null,
    percent: done.percent,
    tasks: Object.values(state.tasks)
      .sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1))
      .map((rt) => ({
        id: rt.spec.id,
        title: red(rt.spec.title),
        state: rt.state,
        ...(rt.agent && { agent: red(rt.agent) }),
        ...(pctOf(rt.percent) !== undefined && { percent: pctOf(rt.percent) }),
        ...(rt.last_note && { last_note: rc(rt.last_note, 400) }),
      })),
    escalations: {
      open: Object.values(state.escalations).filter((e) => e.status !== "resolved" && e.status !== "withdrawn").length,
      awaiting_human: awaitingHuman(state).map((e) => ({
        id: red(e.id),
        ...(e.task && { task: e.task }),
        class: e.emergency ?? null,
        summary: rc(e.summary, 400),
      })),
    },
    budget: { spent_usd: budget.spent, ...(budget.limit !== undefined && { budget_usd: budget.limit }), estimated: budget.estimated },
    runner,
    notes: state.notes.slice(-10).map((n) => ({ seq: n.seq, agent: red(n.agent), topic: red(n.topic), text: rc(n.text, 400) })),
  };
}
