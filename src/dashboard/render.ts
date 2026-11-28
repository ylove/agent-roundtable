// ============================================================================
// Execution dashboard: server-rendered pages
//
// Every string that comes from the run (contract, notes, escalations, diffs, event payloads,
// even ids) is redacted (secrets and personal data) and then HTML-escaped where it is inserted.
// The Usage page's Stop buttons and the Postmortems sign-off forms mutate state. Each surface
// receives its own per-start nonce only in that page's <meta>.
// Pages carry no inline script, style or event handler: the stylesheet and the live-update
// script are static routes (assets.ts), and links are built from validated ids only. Contract
// markdown goes through a small converter that escapes everything and passes no raw HTML.
// ============================================================================

import { humanTime } from "./time.js";
import { describeEvent, taskTitle } from "./event-labels.js";
import { siteHeader } from "./shell.js";
import { displayState } from "./display-state.js";
import { runnerLiveness } from "../execution/runner-launch.js";
import { EXECUTION_ID_RE } from "../ids.js";
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
import { previewFramesHtml } from "../previews/embed.js";
import type { PreviewRecord } from "../previews/store.js";
import { moneyText, tokensShort, usd, useText } from "../usage/format.js";
import { moneyTotal, tokenTotal, type UsageView } from "../usage/types.js";
import { ARTIFACT_ID_RE, PM_ID_RE } from "../postmortem/types.js";
import type { pendingPostmortems } from "../postmortem/store.js";

/** Redacted text (secrets and personal data). */
export const red = (s: unknown): string => redact(String(s ?? "")).text;
/** Redacted, then HTML-escaped: the only way run content reaches a page. */
export const t = (s: unknown): string => escapeHtml(red(s));
/** Cut to n characters (code points, so no surrogate pair is split). */
const cap = (s: string, n: number) => {
  if (s.length <= n) return s;
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
};
/** Redacted, then capped: cutting first could leave half an email or key that no rule matches. */
const rc = (s: unknown, n: number): string => cap(red(s), n);
/** Redacted, capped, escaped. */
export const tc = (s: unknown, n: number): string => escapeHtml(rc(s, n));
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
  status: "alive" | "stale" | "stopped" | "unknown";
  detail: string;
}

/** The task an event is about, if any. */
export function eventTask(ev: AnyEvent, state?: BlackboardState): string | undefined {
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
  if (state && ev.type.startsWith("escalation.") && typeof p.id === "string" && Object.hasOwn(state.escalations, p.id)) return state.escalations[p.id].task;
  return ev.source.task;
}

/** One redacted line describing an event's payload. */
export function eventSummary(ev: AnyEvent, max = 280, state?: BlackboardState): string {
  return cap(red(describeEvent(ev, state)), max);
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

export type PageKey = "overview" | "tasks" | "usage" | "dag" | "escalations" | "dissents" | "events" | "contract" | "postmortems" | "task";

export interface PageContext {
  /** The home link of the read-only multi-run index. */
  indexBase?: string;
  state: BlackboardState;
  recentEvents?: AnyEvent[];
  header: ExecutionHeader;
  /** "/<token>/" */
  base: string;
  runner: RunnerHealth;
  /** Timestamp of the latest event, when supplied by the index. */
  lastEvent?: string;
  /** Who is using what in this run (the Overview card and the Usage page). */
  usage?: UsageView;
  /** The per-start action nonce for this surface; only Usage and Postmortems print one. */
  nonce?: string;
}

const NAV: Array<[Exclude<PageKey, "task">, string, string]> = [
  ["overview", "Overview", ""],
  ["tasks", "Tasks", "tasks"],
  ["usage", "Usage", "usage"],
  ["dag", "Graph", "dag"],
  ["escalations", "Escalations", "escalations"],
  ["dissents", "Dissents", "dissents"],
  ["events", "Events", "events"],
  ["contract", "Contract", "contract"],
  ["postmortems", "Postmortems", "postmortems"],
];

/** The Postmortems page is linked once the run has postmortem mode on, or any finding or meeting. */
function hasPostmortems(s: BlackboardState): boolean {
  return s.contract?.postmortem?.enabled === true || Object.keys(s.postmortem?.findings ?? {}).length > 0 || Object.keys(s.postmortem?.meetings ?? {}).length > 0;
}

/** "reload" pages refresh themselves on new events; "swap" pages replace their content in place; the others show a notice. */
const LIVE: Record<PageKey, "reload" | "swap" | "notice"> = {
  overview: "reload",
  tasks: "reload",
  usage: "swap",
  dag: "reload",
  escalations: "reload",
  dissents: "reload",
  events: "notice",
  contract: "notice",
  postmortems: "reload",
  task: "notice",
};

export function badge(state: string, explanation?: string): string {
  const label: Record<string, string> = { running: "Running", interrupted: "Interrupted", completed: "Completed", failed: "Failed", aborted: "Aborted", paused: "Paused", created: "Draft" };
  return `<span class="badge st-${escapeHtml(/^[a-z_]+$/.test(state) ? state : "unknown")}" title="${t(explanation ?? STATE_HELP[state] ?? state.replace(/_/g, " "))}">${t(label[state] ?? state.replace(/_/g, " "))}</span>`;
}

const taskHref = (base: string, id: string) => escapeHtml(`${base}tasks/${encodeURIComponent(id)}`);
export function taskLink(base: string, id: string, state?: BlackboardState): string {
  const title = t(taskTitle(state, id));
  if (!ID_RE.test(id) || (state && !Object.hasOwn(state.tasks, id))) return `${title} <small class="task-id">${t(id)}</small>`;
  return `<span class="task-ref"><a href="${taskHref(base, id)}">${title}</a> <small class="task-id"><a href="${taskHref(base, id)}">${t(id)}</a></small></span>`;
}

/** Escalation ids are opaque strings in the store, bounded by the tool schema. */
export function validEscalationId(id: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes(".."); }
const escalationHref = (c: PageContext, id: string) => escapeHtml(`${c.base}escalations/${encodeURIComponent(id)}`);
function escalationLink(c: PageContext, e: Escalation, label = e.summary || "Help requested"): string {
  return validEscalationId(e.id) ? `<a href="${escalationHref(c, e.id)}">${t(label)}</a>` : t(label);
}

const STATE_HELP: Record<string, string> = {
  pending: "Waiting for dependencies to finish", ready: "Ready for a worker to claim", claimed: "A worker has claimed this task",
  in_progress: "A worker is building this task", submitted: "Work submitted for review", checking: "Acceptance checks are running",
  merging: "Work is being combined with the run", accepted: "Completed and accepted", blocked: "Waiting for help or dependencies",
  paused: "Work is paused", failed: "Work failed and needs attention", cancelled: "Task dropped or split into other tasks",
  alive: "The scheduler process is running", stale: "Running, but the heartbeat is overdue", stopped: "Not running; use the resume command shown on the overview",
  unknown: "No record of a runner", running: "The run is carrying out its contract", completed: "The run completed", aborted: "The run was stopped by request",
  created: "The run has not started", awaiting_human: "A person must answer before work can continue", in_huddle: "Workers are discussing the request",
};
function taskLegend(): string {
  return `<details class="run-legend"><summary>What task states mean</summary><dl>${["pending", "ready", "claimed", "in_progress", "submitted", "checking", "merging", "accepted", "blocked", "paused", "failed", "cancelled"].map(s => `<dt>${badge(s)}</dt><dd>${t(STATE_HELP[s])}</dd>`).join("")}</dl></details>`;
}

/** Linked sentences, with raw payloads available only on request. */
function eventCards(c: PageContext, events: AnyEvent[]): string {
  return `<ol class="event-list">${events.map(ev => {
    const task = eventTask(ev, c.state);
    return `<li id="activity-${ev.seq}"><p>${t(eventSummary(ev, 1200, c.state))}</p>` +
      `<div class="event-meta">${humanTime(ev.ts)} · ${sourceText(ev.source)}${task ? ` · ${taskLink(c.base, task, c.state)}` : ""} ` +
      `<a class="event-seq" href="${escapeHtml(c.base)}events?before=${ev.seq + 1}#event-${ev.seq}">#${ev.seq}</a></div></li>`;
  }).join("")}</ol>`;
}

function banner(c: PageContext): string {
  const waiting = awaitingHuman(c.state);
  if (!waiting.length) return "";
  const items = waiting.map(
    (e) =>
      `<li><strong>${t(e.emergency === "money" ? "Budget extension" : e.emergency?.replace(/_/g, " ") ?? "Human action")}</strong>${e.task ? ` · task ${taskLink(c.base, e.task, c.state)}` : ""}: ${t(e.summary)}` +
      (e.question ? ` <em>${t(e.question)}</em>` : "") +
      ` ${escalationLink(c, e, "Review request")} <small class="task-id">${t(e.id)}</small></li>`
  );
  return `<section class="banner"><h2>A human is needed</h2><ul>${items.join("")}</ul></section>`;
}

/** "agent w2", or "runner" alone when the source's id just repeats its kind. */
function sourceText(source: { kind: string; id: string }): string {
  return source.id && source.id !== source.kind ? `${t(source.kind)} ${t(source.id)}` : t(source.kind);
}

/** The run's state as people should read it: a stored "running" with no live runner is Interrupted. */
function runDisplayState(c: PageContext) {
  return displayState(c.state, EXECUTION_ID_RE.test(c.state.execution) ? runnerLiveness(c.state.execution) : undefined);
}
function runStatePill(c: PageContext): string {
  const state = runDisplayState(c);
  return `<span class="pill st-${state.kind}" title="${t(state.detail)}">${state.label}</span>`;
}

export function frame(c: PageContext, page: PageKey, title: string, body: string, after = ""): string {
  const b = escapeHtml(c.base);
  const runTitle = c.state.contract?.title?.trim() || "Untitled run";
  const nav = NAV.filter(([key]) => c.indexBase || key !== "postmortems" || page === "postmortems" || hasPostmortems(c.state)).map(
    ([key, label, path]) => `<a${key === page || (page === "task" && key === "tasks") ? ` aria-current="page"` : ""} href="${b}${path}"${key === page || (page === "task" && key === "tasks") ? ` class="here"` : ""}>${label}</a>`
  ).join("");
  const state = runDisplayState(c);
  // Overview already supplies the run heading. Move it into the shared chrome without changing its renderer.
  const overviewHeading = page === "overview" ? /^<h1>[\s\S]*?<\/h1>/.exec(body)?.[0] : undefined;
  const heroTitled = page === "overview" && body.startsWith('<section class="run-hero">');
  // A page with its own <h1> keeps it as the only page title; the run name above it is a label.
  const runName = /<h1[ >]/.test(body) ? `<p class="run-title">${tc(runTitle, 200)}</p>` : `<h1>${tc(runTitle, 200)}</h1>`;
  const heading = heroTitled ? "" : overviewHeading ?? runName;
  const content = overviewHeading ? body.slice(overviewHeading.length) : body;
  const runMeta = `<header class="run-heading">${heading}<p class="meta run-meta" id="runmeta"><code>${t(c.state.execution)}</code>` +
    `<span class="pill st-${state.kind}" title="${t(state.detail)}">${state.label}</span>` +
    `<span>Last event ${c.lastEvent ? humanTime(c.lastEvent) : `#${c.state.seq} (time unavailable)`}</span></p></header>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    ((page === "usage" || page === "postmortems") && !c.indexBase && c.nonce ? `<meta name="roundtable-action" content="${escapeHtml(c.nonce)}">` : "") +
    `<title>${t(title)} · ${tc(runTitle, 80)}</title><link rel="stylesheet" href="${b}static/dashboard.css"></head>` +
    `<body class="run-page" data-base="${b}" data-seq="${c.state.seq}" data-live="${LIVE[page]}">${c.indexBase ? siteHeader(c.indexBase, "runs") : ""}<main>` +
    `<nav class="run-nav" aria-label="This run">${nav}</nav>` +
    runMeta +
    `<p class="live" id="live" role="status" aria-live="polite">${c.indexBase ? "Read-only run record. Refreshes every 15 seconds." : page === "usage" ? "This page follows the run as it happens. The Stop buttons are the one thing it can change." : page === "postmortems" ? "This page follows the run as it happens. Review pending artifacts before signing off." : "Read-only. This page follows the run as it happens."}</p>` +
    (LIVE[page] === "swap" ? `<div id="swap">${banner(c)}${content}</div>` : banner(c) + content) +
    after +
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
  const open = Object.values(s.escalations).filter(e => e.status !== "resolved" && e.status !== "withdrawn").length;
  const accepted = done.byState.accepted ?? 0;
  const body = `<section class="run-hero"><p class="eyebrow">Run overview</p><h1>${t(s.contract?.title?.trim() || "Untitled run")}</h1>` +
    `<p class="run-goal">${t(s.goal?.ultimate || s.contract?.goal?.ultimate || "No goal was recorded for this run.")}</p>` +
    `<h2>The request</h2><p>${t(s.contract?.goal?.original_prompt || "No request summary was recorded. Open the contract to see the available scope.")}</p>` +
    `<p class="meta">Started ${humanTime(c.header.created)} · <a href="${escapeHtml(c.base)}contract">Read the contract</a></p></section>` +
    `<div class="cards">` +
    `<div class="card"><h3>Progress</h3><p class="run-metric">${accepted} of ${done.total} tasks done</p><div class="big">${done.percent}%</div>` +
    `<progress max="100" value="${done.percent}" aria-label="Task completion">${done.percent}%</progress><p class="meta">${runStatePill(c)} · <a href="${escapeHtml(c.base)}tasks">See every task</a></p>` +
    (s.paused_tasks.length ? `<p>Paused: ${s.paused_tasks.map(x => taskLink(c.base, x, s)).join(", ")}</p>` : "") + `</div>` +
    `<div class="card"><h3>Budget used</h3><div class="big">${money(budget.spent)}</div><p>${budget.limit !== undefined ? `of ${money(budget.limit)}${budget.pct !== undefined ? ` (${budget.pct}%)` : ""}` : "No budget limit was recorded."}${budget.estimated ? " · partly estimated" : ""}</p>` +
    (s.budget.thresholds_crossed.length ? `<p class="meta">Passed ${s.budget.thresholds_crossed.map(p => `${p}%`).join(", ")} of the budget</p>` : "") +
    (s.contract ? `<p class="meta">Swarm limits: max agents ${t(s.contract.budget.max_agents ?? "unset (swarms disabled)")} · max subtasks ${t(s.contract.budget.max_subtasks ?? 16)}</p>` : "") + `</div>` +
    usageCard(c) +
    `<div class="card"><h3>Runner</h3><div class="big">${badge(c.runner.status, c.runner.detail)}</div><p>${t(c.runner.detail)}</p>` +
    `<details class="run-legend"><summary>What runner states mean</summary><dl>` +
    `<dt>${badge("alive")}</dt><dd>The scheduler process is running.</dd><dt>${badge("stale")}</dt><dd>Running, but no heartbeat for the number of minutes shown above.</dd>` +
    `<dt>${badge("stopped")}</dt><dd>Not running; resume with <code>roundtable run ${t(s.execution)}</code>.</dd>` +
    `<dt>${badge("unknown")}</dt><dd>No record of a runner.</dd></dl></details></div>` +
    `<div class="card"><h3>Needs attention</h3><div class="big">${open}</div><p><a href="${escapeHtml(c.base)}escalations">Escalations</a> are requests for help or a decision.</p></div>` +
    `<div class="card"><h3>Recorded concerns</h3><div class="big">${Object.keys(s.dissents).length}</div><p><a href="${escapeHtml(c.base)}dissents">Dissents</a> preserve risks raised while planning.</p></div></div>` +
    `<section class="run-section"><h2>Task graph</h2><p class="meta">Follow a task to see its work, checks and activity. Arrows point from a dependency to the task that needs it.</p><div class="dagwrap">${renderDagSvg(s, { base: c.base })}</div></section>` +
    `<section class="run-section"><h2>Latest activity</h2>${c.recentEvents?.length ? eventCards(c, c.recentEvents.slice(-5).reverse()) : `<p class="empty">No recent activity was recorded.</p>`}<p><a href="${escapeHtml(c.base)}events">All events</a></p></section>` +
    `<section class="run-section"><h2>Recent notes</h2>${s.notes.length ? `<ul>${s.notes.slice(-5).reverse().map(n => `<li><strong>${t(n.agent)}</strong> on ${t(n.topic)}: ${tc(n.text, 800)}</li>`).join("")}</ul>` : `<p class="empty">No notes were recorded. Worker updates will appear here.</p>`}</section>`;
  return frame(c, "overview", "Overview", body);
}

/** The Overview's compact usage card: the run's spend with its provenance, and a way into the Usage page. */
function usageCard(c: PageContext): string {
  const v = c.usage;
  const href = escapeHtml(`${c.base}usage`);
  if (!v || (!v.agents.length && moneyTotal(v.totals) === 0)) {
    return `<div class="card"><h3>Usage</h3><div class="big">none yet</div><p class="meta"><a href="${href}">Who is using what</a></p></div>`;
  }
  const spent = moneyTotal(v.totals) > 0 ? usd(moneyTotal(v.totals)) : tokenTotal(v.totals.tokens) > 0 ? `${tokensShort(tokenTotal(v.totals.tokens))} tok` : usd(0);
  const split = moneyTotal(v.totals) > 0 ? moneyText(v.totals, "words") : useText(v.totals, v.totals.tokens, "words");
  const working = v.agents.filter((a) => a.state === "working").length;
  return (
    `<div class="card"><h3>Usage</h3><div class="big">${t(spent)}</div>` +
    `<p class="meta">${t(split)}</p>` +
    `<p class="meta">${working} working · <a href="${href}">See who spent what</a></p></div>`
  );
}

/** What a task waits on: its blocking escalation, blocking dependencies, open needs, or unaccepted dependencies. */
function blockers(c: PageContext, rt: TaskRuntime): string {
  const parts: string[] = [];
  if (rt.blocked_by?.escalation) parts.push(validEscalationId(rt.blocked_by.escalation) && Object.hasOwn(c.state.escalations, rt.blocked_by.escalation) ? escalationLink(c, c.state.escalations[rt.blocked_by.escalation], "Request for help") : `escalation ${t(rt.blocked_by.escalation)}`);
  const deps =
    rt.blocked_by?.deps ??
    (rt.state === "pending" ? rt.spec.depends_on.filter((d) => !Object.hasOwn(c.state.tasks, d) || c.state.tasks[d].state !== "accepted") : []);
  if (deps.length) parts.push(`waits on ${deps.map((d) => taskLink(c.base, d, c.state)).join(", ")}`);
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
  const rows = Object.values(c.state.tasks).sort((a, b) => a.spec.id.localeCompare(b.spec.id)).map(rt =>
    `<tr><td>${taskLink(c.base, rt.spec.id, c.state)}</td><td>${badge(rt.state)}</td>` +
    `<td>${rt.agent ? t(rt.agent) : `<span class="empty">No worker assigned</span>`}</td><td class="num">${progressCell(rt)}</td>` +
    `<td class="note">${rt.last_note ? tc(rt.last_note, 500) : "No update recorded."}</td><td>${blockers(c, rt) || "None"}</td></tr>`);
  return frame(c, "tasks", "Tasks", `<h1>Tasks</h1><p class="meta">Each task comes from the contract. The small code next to its title is its task id.</p>${taskLegend()}` +
    (rows.length ? `<div class="run-section tablewrap"><table><thead><tr><th>Task</th><th>State</th><th>Worker</th><th>Progress</th><th>Last update</th><th>Waiting on</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<section class="run-section"><p class="empty">No tasks yet. Freeze a contract with tasks to see their progress here.</p></section>`));
}

export interface TaskDetail {
  events: AnyEvent[];
  log?: { text: string; truncated: boolean; label: string };
  /** The latest diff, capped at a line boundary (it is redacted here). */
  diff?: { stat: string; text: string; truncated: boolean; commit: string } | { stat: string; error: string; commit: string };
  /** Latest output of failing checks by check key, capped at a line boundary (redacted here). */
  outputs: Record<string, string>;
  /** Running previews of this task (embedded in a sandboxed frame). */
  previews?: PreviewRecord[];
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
  const rt = c.state.tasks[id], spec = rt.spec;
  const commands = spec.checks.map(key => {
    const cmd = c.state.contract?.validation.commands.find(cmd => cmd.id === key);
    return `<li><code>${t(key)}</code>${cmd ? `: <code>${t(cmd.argv.join(" "))}</code><span class="meta"> · timeout ${cmd.timeout_s} seconds</span>` : " · No command definition was recorded."}</li>`;
  });
  const interfaces = (c.state.contract?.interfaces ?? []).filter(i => i.owner === id || i.consumers?.includes(id));
  const workers = [...new Set([rt.agent, ...d.events.flatMap(ev => ev.type === "task.claimed" || ev.type === "agent.spawned" ? [ev.payload.agent] : [])].filter((a): a is string => !!a))];
  const attempts = d.events.filter(ev => ev.type === "task.claimed" || ev.type === "task.retried" || ev.type === "agent.spawned");
  const attemptAt = (seq: number) => {
    const start = attempts.filter(ev => ev.seq <= seq).at(-1);
    return start && "attempt" in start.payload ? start.payload.attempt : undefined;
  };
  const checks = d.events.filter(ev => ev.type.startsWith("check.") || ev.type === "command.completed").map(ev => {
    const out = d.outputs[`event:${ev.seq}`];
    return `<li><p>${t(eventSummary(ev, 1000, c.state))}${attemptAt(ev.seq) ? ` <span class="meta">(attempt ${attemptAt(ev.seq)})</span>` : ""}</p><p class="meta">${humanTime(ev.ts)} · <a href="${escapeHtml(c.base)}events?before=${ev.seq + 1}#event-${ev.seq}">Event #${ev.seq}</a></p>` +
      (out ? `<details><summary>Output (redacted)</summary><pre>${t(out)}</pre></details>` : "") + `</li>`;
  });
  // Older stores may retain the check snapshot but omit the check event's output reference.
  for (const [key, check] of Object.entries(c.state.checks.task)) {
    if (!key.startsWith(`${id}/`) || checks.some(row => row.includes(`Event #${check.at_seq}<`))) continue;
    checks.push(`<li><p>Check <code>${t(key.slice(id.length + 1))}</code> ${badge(check.status)}</p>` +
      (d.outputs[key] ? `<details><summary>Output (redacted)</summary><pre>${t(d.outputs[key])}</pre></details>` : `<p class="empty">No check output was recorded.</p>`) + `</li>`);
  }
  const diff = d.diff;
  const body = `<section class="run-hero"><p class="eyebrow">Task detail</p><h1>${t(spec.title?.trim() || "untitled task")}</h1><p class="meta"><code>${t(id)}</code> · ${badge(rt.state)}</p>` +
    `<h2>Description</h2><p class="run-copy">${t(spec.instructions || "No description was recorded in the contract for this task.")}</p></section>` +
    `<div class="run-columns"><section class="run-section"><h2>Plan and ownership</h2><dl>` +
    `<dt>Worker and runtime</dt><dd>${workers.length ? workers.map(a => `${t(a)} <span class="meta">(${t(Object.hasOwn(c.state.agents, a) ? c.state.agents[a].driver : "runtime not recorded")})</span>`).join(", ") : "No worker was recorded."}</dd>` +
    `<dt>Attempt</dt><dd>${rt.attempt || "No attempt yet"}</dd><dt>Progress</dt><dd>${progressCell(rt)}</dd>` +
    `<dt>Persona</dt><dd>${t(spec.persona || "Not recorded")}</dd><dt>Team</dt><dd>${t(spec.team || "No team assigned")}</dd>` +
    `<dt>Kind</dt><dd>${t(spec.kind)} <span class="meta">${spec.kind === "review" ? "Reviews another task's work" : spec.kind === "subcontract" ? "Delegates work to subtasks" : "Produces the requested work"}</span></dd>` +
    `<dt>Dependencies</dt><dd>${spec.depends_on.length ? spec.depends_on.map(x => taskLink(c.base, x, c.state)).join(", ") : "No dependencies."}</dd>` +
    (spec.parent ? `<dt>Parent task</dt><dd>${taskLink(c.base, spec.parent, c.state)}</dd>` : "") +
    `<dt>Subtasks</dt><dd>${Object.values(c.state.tasks).filter(child => child.spec.parent === id).map(child => taskLink(c.base, child.spec.id, c.state)).join(", ") || "No subtasks."}</dd>` +
    `<dt>Started</dt><dd>${rt.started_at ? humanTime(rt.started_at) : "Not recorded"}</dd><dt>Finished</dt><dd>${rt.finished_at ? humanTime(rt.finished_at) : "Not recorded"}</dd>` +
    `<dt>Waiting on</dt><dd>${blockers(c, rt) || "Nothing recorded."}</dd><dt>Last update</dt><dd>${t(rt.last_note || "No update was recorded.")}</dd>` +
    (rt.branch ? `<dt>Branch</dt><dd><code>${t(rt.branch)}</code></dd>` : "") + `</dl></section>` +
    `<section class="run-section"><h2>Acceptance checks</h2>${list(spec.acceptance, "No acceptance criteria were recorded.")}` +
    `<h3>Commands</h3>${commands.length ? `<ul>${commands.join("")}</ul>` : `<p class="empty">No check commands were specified.</p>`}` +
    `<h3>Allowed write paths</h3><p class="meta">File globs limit where this task may write.</p>${list(spec.paths.write, "No write paths were specified.")}` +
    `<h3>Interfaces</h3>${interfaces.length ? `<ul>${interfaces.map(i => `<li><strong>${t(i.name)}</strong> (${t(i.kind)}): ${t(i.description)}${i.path ? ` <code>${t(i.path)}</code>` : ""}<p class="meta">Owner: ${taskLink(c.base, i.owner, c.state)}</p></li>`).join("")}</ul>` : `<p class="empty">No interfaces were recorded for this task.</p>`}</section></div>` +
    previewFramesHtml(d.previews ?? [], c.base) +
    `<section class="run-section"><h2>Check results</h2>${checks.length ? `<ol class="event-list">${checks.join("")}</ol>` : `<p class="empty">No checks have run yet.</p>`}</section>` +
    `<section class="run-section"><h2>Latest diff</h2>${!diff ? `<p class="empty">Nothing submitted yet.</p>` : `<p class="meta">Commit <code>${t(diff.commit)}</code> · ${t(diff.stat)}</p>` +
      ("error" in diff ? `<p class="empty">${t(diff.error)}</p>` : `<details><summary>View submitted changes</summary><pre class="diff">${diffHtml(diff.text)}</pre>${diff.truncated ? `<p class="meta">The diff was truncated.</p>` : ""}</details>`)}</section>` +
    `<section class="run-section"><h2>Worker activity</h2>${d.log ? `<details><summary>${t(d.log.label)} (redacted)</summary><pre>${t(d.log.text)}</pre>${d.log.truncated ? `<p class="meta">Only the latest complete lines are shown.</p>` : ""}</details>` : `<p class="empty">No worker log was recorded for this task.</p>`}</section>` +
    `<section class="run-section"><h2>State history and attempts</h2>${attempts.length ? `<ul>${attempts.map(ev => `<li>Attempt ${"attempt" in ev.payload ? ev.payload.attempt : "unknown"}${"agent" in ev.payload ? ` · worker ${t(ev.payload.agent)}` : ""} · ${humanTime(ev.ts)}</li>`).join("")}</ul>` : ""}${d.events.length ? eventCards(c, d.events.slice().reverse()) : `<p class="empty">No events for this task.</p>`}</section>`;
  return frame(c, "task", spec.title?.trim() || "untitled task", body);
}

function escalationKind(e: Escalation): { label: string; explanation: string } {
  if (e.emergency === "money") return { label: "Budget extension", explanation: "The run hit its budget and asks for more." };
  const kinds: Record<string, [string, string]> = {
    blocker: ["Blocked work", "A worker cannot continue without help."], ambiguity: ["Question about the plan", "A worker needs a clearer requirement or a decision."],
    resource: ["Resource request", "A worker needs more resources to continue."], conflict: ["Conflicting work", "Changes or requirements conflict and need a decision."],
    assistance: ["Help requested", "A worker needs another participant's help."], emergency: ["Human action needed", "Work needs a person to act before it can continue."],
  };
  const [label, explanation] = kinds[e.kind] ?? ["Help requested", "A worker raised a request for help."];
  return { label, explanation };
}

export function renderEscalations(c: PageContext): string {
  const all = Object.values(c.state.escalations).sort((a, b) => b.raised_seq - a.raised_seq);
  return frame(c, "escalations", "Escalations", `<h1>Escalations</h1><p class="meta">Requests for help, resources or a decision. Open a request to see the evidence and how to answer.</p>` +
    (all.length ? `<div class="run-grid">${all.map(e => `<article class="run-section"><p class="eyebrow">${t(escalationKind(e).label)} · ${badge(e.status)}</p><h2>${escalationLink(c, e)}</h2>` +
      `<p>${t(escalationKind(e).explanation)}</p><p>${e.question ? t(e.question) : "No additional question was recorded."}</p><p class="meta">Raised by ${t(e.agent)}${e.task ? ` · ${taskLink(c.base, e.task, c.state)}` : " · Whole run"}</p>` +
      `<small class="task-id">${t(e.id)}</small>${e.resolution ? `<p>${t(e.resolution.action)} by ${t(e.resolution.by)}: ${t(e.resolution.decision)}</p>` : ""}</article>`).join("")}</div>` : `<section class="run-section"><p class="empty">No escalations. Requests will appear here when a worker needs help.</p></section>`));
}

export function renderEscalationDetail(c: PageContext, id: string, events: AnyEvent[], diagnostics?: string): string {
  const e = c.state.escalations[id], kind = escalationKind(e);
  const related = events.filter(ev => ev.type === "escalation.raised" ? ev.payload.escalation.id === id :
    ev.type.startsWith("escalation.") ? (ev.payload as { id: string }).id === id :
    "escalation" in ev.payload && ev.payload.escalation === id);
  const raised = related.find(ev => ev.seq === e.raised_seq) ?? related[0];
  const latest = related.at(-1);
  const resolve = `resolve_escalation(${JSON.stringify({ execution_id: c.state.execution, escalation_id: id, action: "decide", decision: "Replace this with your answer" }, null, 2)})`;
  const amend = `resolve_escalation(${JSON.stringify({ execution_id: c.state.execution, escalation_id: id, action: "amend", amendment: { budget: { usd: "REPLACE_WITH_APPROVED_TOTAL_USD" } }, decision: "Record the human-approved budget here" }, null, 2)})`;
  return frame(c, "escalations", kind.label, `<section class="run-hero"><p class="eyebrow">${t(kind.label)}</p><h1>${t(e.summary || "Help requested")}</h1><p class="run-goal">${t(kind.explanation)}</p><p class="meta"><code>${t(e.id)}</code> · ${badge(e.status)}</p></section>` +
    `<div class="run-columns"><section class="run-section"><h2>What is asked</h2><p class="run-copy">${t(e.question || e.summary || "No question or amount was recorded.")}</p>` +
    (e.options?.length ? `<h3>Options recorded</h3>${list(e.options)}` : `<p class="empty">No options were recorded.</p>`) +
    `<h3>Recorded request</h3>${related.filter(ev => ev.type === "escalation.awaiting_human").map(ev => ev.type === "escalation.awaiting_human" ? `<p>${t(ev.payload.message)}</p>` : "").join("") || `<p class="empty">No further request details were recorded.</p>`}` +
    (diagnostics ? `<details><summary>Supporting evidence (redacted)</summary><pre>${t(diagnostics)}</pre></details>` : `<p class="empty">No separate diagnostic log was recorded.</p>`) + `</section>` +
    `<section class="run-section"><h2>Who and when</h2><dl><dt>Raised by</dt><dd>${t(e.agent || "Not recorded")}</dd><dt>Task</dt><dd>${e.task ? taskLink(c.base, e.task, c.state) : "Whole run"}</dd>` +
    `<dt>Raised</dt><dd>${humanTime(raised?.ts)}</dd><dt>Last changed</dt><dd>${humanTime(latest?.ts)}</dd><dt>Blocks work</dt><dd>${e.blocking ? "Yes" : "No"}</dd>` +
    `<dt>Routed to</dt><dd>${t(e.routed_to || e.target || e.with || "Not recorded")}</dd></dl>${e.resolution ? `<h3>Resolution</h3><p>${t(e.resolution.decision)}</p><p class="meta">${t(e.resolution.action)} by ${t(e.resolution.by)}</p>` : ""}</section></div>` +
    `<section class="run-section"><h2>How to resolve</h2><p>This page is read-only. Give your answer to the run's orchestrator.</p>` +
    (e.emergency === "money" ? `<p>Approve a new total budget explicitly, then replace the placeholder below with that number. Amending the budget records the increase; answering alone does not add funds.</p><pre><code>${t(amend)}</code></pre>` : `<p>Replace the answer in this MCP tool call with your decision.</p><pre><code>${t(resolve)}</code></pre>`) +
    (e.emergency === "money" ? `<p>For a decision that needs no contract change:</p><pre><code>${t(resolve)}</code></pre>` : "") +
    `<p>Inspect from the CLI:</p><pre><code>roundtable status ${t(c.state.execution)} --json</code></pre><p>The CLI has no escalation-resolution subcommand. Use the MCP call above to answer. If the scheduler is stopped, restart it with:</p>` +
    `<pre><code>roundtable run ${t(c.state.execution)}</code></pre><p>Resume a paused run through MCP after resolving its requests:</p><pre><code>${t(`control_execution(${JSON.stringify({ execution_id: c.state.execution, action: "resume" })})`)}</code></pre></section>` +
    `<section class="run-section"><h2>Related events</h2>${related.length ? eventCards(c, related.slice().reverse()) : `<p class="empty">No related events were recorded.</p>`}</section>`);
}



// --- postmortems ---------------------------------------------------------------

/** A concluded meeting's record, read from its blob by the server (markdown), or why it could not be. */
export interface PostmortemRecordView {
  markdown?: string;
  error?: string;
  pending?: ReturnType<typeof pendingPostmortems>;
}

function signoffForm(pm: string, pending: NonNullable<PostmortemRecordView["pending"]>): string {
  if (!PM_ID_RE.test(pm) || !pending.length) return "";
  return `<form data-signoff="${t(pm)}"><h3>Pending sign-off</h3>` +
    pending.map(a => `<label class="pending-artifact">` +
      (ARTIFACT_ID_RE.test(a.id) ? `<input type="checkbox" name="accept" value="${t(a.id)}"> ` : "") +
      `<code>${t(a.id)}</code> (${t(a.kind)} → ${t(a.target)})<span class="artifact-text">${t(a.text)}</span>` +
      `<span class="artifact-hash">Hash: <code>${t(a.hash)}</code></span></label>`).join("") +
    `<p><label>Your identity <input type="text" name="by" required autocomplete="off"></label></p>` +
    `<button type="submit">Sign off selected artifacts</button><p data-signoff-result role="status" aria-live="polite"></p></form>`;
}

/** Findings with their fix status, then each meeting: its dialogue, artifacts and their status (the record, redacted and escaped). */
export function renderPostmortems(c: PageContext, records: Record<string, PostmortemRecordView>): string {
  const st = c.state.postmortem;
  const findings = Object.values(st?.findings ?? {});
  const fixClass = { pending: "st-pending", fixed: "st-accepted", abandoned: "st-cancelled" } as const;
  const rows = findings.map(
    (f) =>
      `<tr><td><code>${t(f.id)}</code></td><td>${t(f.category.replace(/_/g, " "))}</td>` +
      `<td class="note">${humanTime(f.at)}<br>${tc(f.summary, 600)}${f.repeats ? ` <span class="meta">(repeated ${f.repeats}×)</span>` : ""}</td>` +
      `<td>${tc(f.detected_by, 200)}</td><td>${f.responsible.map((r) => tc(r, 80)).join(", ")}</td><td>${f.task ? taskLink(c.base, f.task, c.state) : ""}</td>` +
      `<td><span class="badge ${fixClass[f.fix.status]}">${t(f.fix.status)}</span>${f.fix.by ? ` <span class="meta">${tc(f.fix.by, 80)}</span>` : ""}</td>` +
      `<td>${f.pm ? t(f.pm) : `<span class="empty">draft</span>`}</td></tr>`
  );
  const meetings = Object.entries(st?.meetings ?? {}).map(([id, m]) => {
    const rec = Object.hasOwn(records, id) ? records[id] : undefined;
    const done = m.concluded;
    const counts = done ? Object.entries(done.artifacts).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ") : "";
    return (
      `<section class="run-section"><h2>${t(id)}</h2><p class="meta">${t(m.format)} · seats ${m.seats.map((x) => tc(x, 80)).join(", ")} · ` +
      (done
        ? `concluded: ${t(counts || "no artifacts applied")}${done.flagged ? ` · ${done.flagged} flagged` : ""}`
        : "held, waiting for the orchestrator's conclusion") +
      `</p>` +
      (rec?.markdown !== undefined
        ? `<details open><summary>The full record: every turn, the artifacts and their status</summary><article class="contract">${markdownToHtml(red(rec.markdown))}</article></details>`
        : `<p class="empty">${t(rec?.error ?? (done ? "The record could not be read." : "The record appears once the meeting is concluded."))}</p>`) +
      (done && !c.indexBase && rec?.pending ? signoffForm(id, rec.pending) : "") + `</section>`
    );
  });
  const body =
    `<h1>Postmortems</h1>` +
    (c.indexBase ? `<p class="meta">Retrospectives record what went wrong and the lessons proposed. This index is read-only. Review pending lessons with <code>roundtable postmortem pending</code>.</p>` : `<p class="meta">The meeting has no seat for the human: nothing typed anywhere reaches it. Sign-off applies only the artifacts you select below.</p>`) +
    `<h2>Findings</h2>` +
    (rows.length
      ? `<div class="run-section tablewrap"><table><thead><tr><th>Id</th><th>Category</th><th>What went wrong</th><th>Caught by</th><th>Responsible</th><th>Task</th><th>Fix</th><th>Meeting</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : `<p class="empty">No findings recorded.</p>`) +
    (meetings.length ? meetings.join("") : `<p class="empty">No postmortem meeting yet.</p>`);
  return frame(c, "postmortems", "Postmortems", body);
}

export function renderDissents(c: PageContext): string {
  const sections = Object.entries(c.state.dissents).map(([id, rec]) => {
    const d = rec.spec;
    const fires = Object.values(rec.fires).sort((a, b) => a.seq - b.seq);
    const status = fires.some((f) => f.generation === rec.generation) ? "fired" : d?.tripwire ? (c.state.contract?.status === "frozen" ? "armed" : "pending freeze") : "needs tripwire";
    const escalations = Object.values(c.state.escalations).filter((e) => e.dissent_id === id);
    const huddles = Object.entries(c.state.huddles).flatMap(([huddleId, h]) => {
      const e = escalations.find((e) => e.id === h.escalation);
      return e ? [`<tr><td>${e.task ? taskLink(c.base, e.task, c.state) : "Integration"}</td><td>${t(huddleId)}</td><td>${t(e.task ?? "Integration")}</td>` +
        `<td>${t(h.outcome ?? "Pending")}</td><td class="note">${t(h.decision ?? "")}</td></tr>`] : [];
    });
    return `<section class="run-section"><h2>${t(id)}</h2>` +
      `<p>Dissenter: ${t(d?.by ?? "Unknown")} · Status: ${t(status)}</p>` +
      `<p class="note">${t(d?.claim ?? "Dissent definition unavailable.")}</p>` +
      `<p class="note">Predicted failure: ${t(d?.predicted_failure ?? "Unknown")}</p>` +
      `<p>Source: ${t(d?.source.kind ?? "Unknown")}${d?.source.ref ? ` · ${t(d.source.ref)}` : ""}</p>` +
      `<details><summary>Tripwire: the condition that triggers this concern</summary><pre>${t(d?.tripwire ? JSON.stringify(d.tripwire, null, 2) : "Not supplied")}</pre></details>` +
      `<p>On fire: ${t(d?.on_fire ?? "Unknown")} · Score: ${t(rec.score ?? "not assessed")}</p>` +
      (fires.length ? `<h3>Firings</h3><div class="tablewrap"><table><thead><tr><th>Task</th><th>Task id</th><th>Tripped by</th><th>Evidence</th><th>Notification</th></tr></thead><tbody>` +
        fires.map((f) => `<tr><td>${f.task ? taskLink(c.base, f.task, c.state) : "Integration"}</td><td>${t(f.task ?? "Integration")}</td><td>${t(f.tripped_by)}</td><td class="note">${t(f.evidence)}</td>` +
          `<td>${t((f.notified ?? []).join(", "))}${f.orchestrator_woken ? ` · ${t("Orchestrator woken")}` : ""}</td></tr>`).join("") +
        `</tbody></table></div>` : "") +
      `<h3>Huddles</h3>` +
      (huddles.length ? `<div class="tablewrap"><table><thead><tr><th>Task</th><th>Id</th><th>Task id</th><th>Outcome</th><th>Decision</th></tr></thead><tbody>${huddles.join("")}</tbody></table></div>` :
        `<p class="empty">No huddles recorded.</p>`) + `</section>`;
  });
  return frame(c, "dissents", "Dissents", `<h1>Dissents</h1><p>Dissents are concerns recorded during planning. A tripwire watches for evidence that a concern came true.</p><p>Scores are advisory and never change voting or consent weight.</p>` +
    (sections.length ? sections.join("") : `<p class="empty">No dissents.</p><p class="meta">Concerns recorded in the contract during planning will appear here.</p>`));
}

// --- events ------------------------------------------------------------------

export const EVENTS_PAGE_SIZE = 100;

const EVENT_GROUPS = [...new Set(EVENT_TYPES.map((x) => x.split(".")[0]))];
const EVENT_GROUP_LABELS: Record<string, string> = { execution: "Run", contract: "Plan", runner: "Scheduler", agent: "Workers", task: "Tasks", lease: "File access", artifact: "Artifacts", dependency: "Dependencies", check: "Checks", command: "Commands", merge: "Merges", note: "Notes", decision: "Decisions", directive: "Instructions", dissent: "Concerns", escalation: "Help requests", huddle: "Discussions", budget: "Budget", watchdog: "Run monitor", sandbox: "Isolation", postmortem: "Retrospectives" };

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
    EVENT_GROUPS.map((g) => `<a href="${eventsHref(c.base, { type: g, task: f.task })}"${here({ type: g, task: f.task })} title="${t(g)} events">${t(EVENT_GROUP_LABELS[g] ?? g)}</a>`).join("");
  const tasks =
    `<a href="${eventsHref(c.base, { type: f.type })}"${here({ type: f.type })}>all tasks</a>` +
    Object.keys(c.state.tasks)
      .sort()
      .map((id) => `<a href="${eventsHref(c.base, { type: f.type, task: id })}"${here({ type: f.type, task: id })}>${t(taskTitle(c.state, id))} <small class="task-id">${t(id)}</small></a>`)
      .join("");
  const rows = page.map(ev => `<tr><td class="num">${ev.seq}</td><td id="event-${ev.seq}"><p class="event-sentence">${t(eventSummary(ev, 1200, c.state))}</p>` +
    `<p class="event-meta">${humanTime(ev.ts)} · ${sourceText(ev.source)} ` +
    `<a class="event-seq" href="${eventsHref(c.base, { before: ev.seq + 1 })}#event-${ev.seq}">#${ev.seq}</a></p>` +
    (eventTask(ev, c.state) ? `<p>${taskLink(c.base, eventTask(ev, c.state)!, c.state)}</p>` : "") +
    `<details><summary>Technical details: ${t(ev.type)}</summary><pre>${t(JSON.stringify(ev.payload, null, 2))}</pre></details></td></tr>`);
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
      ? `<div class="run-section tablewrap"><table class="event-table"><thead><tr><th>Event</th><th>What happened</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
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
      : `<section class="run-section"><p class="meta">${t(source)}${c.state.contract?.frozen ? ` · Frozen ${humanTime(c.state.contract.frozen.at)}` : ""}</p><article class="contract">${markdownToHtml(red(markdown))}</article></section>`);
  return frame(c, "contract", "Contract", body);
}

export function renderDagPage(c: PageContext): string {
  return frame(c, "dag", "Task graph", `<h1>Task graph</h1><p class="meta">Arrows connect tasks to the work that depends on them. Select a title to see the task story.</p>${taskLegend()}<section class="run-section"><div class="dagwrap">${renderDagSvg(c.state, { base: c.base })}</div></section>`);
}

/** The contract as markdown, for when the contract tools left no CONTRACT.md. */
export function contractMarkdown(k: Contract): string {
  const lines: string[] = [`# ${k.title}`, ""];
  if (k.connectors?.length) lines.push(`Connectors: ${k.connectors.join(", ")}`, "");
  lines.push(`Contract ${k.id}, version ${k.version}. Status: ${k.status}.${k.frozen ? ` Frozen by ${k.frozen.by}.` : ""}`, "");
  lines.push("## Goal", "", k.goal?.ultimate ?? "", "");
  if (k.goal?.original_prompt) lines.push("### Original prompt", "", ...k.goal.original_prompt.split("\n").map((l) => `> ${l}`), "");
  if (k.goal?.artifacts?.length) lines.push("### Artifacts", "", ...k.goal.artifacts.map((a) => `- ${a.kind}: ${a.title ? `${a.title} ` : ""}${a.ref}`), "");
  if (k.scope) lines.push("## Scope", "", `- Base ref: \`${k.scope.base_ref}\``, `- Paths: ${(k.scope.paths ?? []).map((p) => `\`${p}\``).join(", ")}`, "");
  lines.push("## Tasks", "");
  for (const task of k.tasks ?? []) {
    lines.push(`### ${task.title?.trim() || "untitled task"} (${task.id})`, "");
    if (task.instructions) lines.push(task.instructions, "");
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
        `${k.budget.max_parallel} top-level in parallel; max agents ${k.budget.max_agents ?? "unset (swarms disabled)"}; max subtasks ${k.budget.max_subtasks ?? 16}; ${k.budget.max_attempts} attempts`,
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
        .replace(/!?\[([^\[\]]+)\]\(([^)\s\[\]]+)\)/g, "$1 ($2)")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
    })
    .join("");
}

function tableHtml(rows: string[]): string {
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
  const sep = rows.length > 1 && cells(rows[1]).every(cell => /^:?-{3,}:?$/.test(cell));
  const head = sep ? `<thead><tr>${cells(rows[0]).map((x) => `<th>${inline(x)}</th>`).join("")}</tr></thead>` : "";
  const body = (sep ? rows.slice(2) : rows).map((r) => `<tr>${cells(r).map((x) => `<td>${inline(x)}</td>`).join("")}</tr>`).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

export const MARKDOWN_LINE_LIMIT = 4000;
const LINE_TRUNCATED = " … [truncated]";

/** Bound each source line before running Markdown rules, including fenced code. */
export function capMarkdownLine(line: string): string {
  return line.length <= MARKDOWN_LINE_LIMIT ? line : line.slice(0, MARKDOWN_LINE_LIMIT - LINE_TRUNCATED.length) + LINE_TRUNCATED;
}

/** Heading suffixes are trimmed with a single backwards pass. */
function headingText(text: string): string {
  let end = text.length;
  while (end && /\s/.test(text[end - 1])) end--;
  while (end && text[end - 1] === "#") end--;
  while (end && /\s/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function isRule(line: string): boolean {
  const text = line.trim();
  if (!/^[-*_]/.test(text)) return false;
  let count = 0;
  for (const ch of text) {
    if (ch === text[0]) count++;
    else if (!/\s/.test(ch)) return false;
  }
  return count >= 3;
}

/**
 * A small, safe markdown subset: headings, paragraphs, flat lists, block quotes, fenced code,
 * tables, rules, and inline code, bold and italics. Raw HTML is escaped like any other text.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n").map(capMarkdownLine);
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
    const h = /^\s{0,3}(#{1,6})\s+/.exec(line);
    if (h) {
      flush();
      // One level down: the page's own <h1> is the page title.
      const n = Math.min(6, h[1].length + 1);
      out.push(`<h${n}>${inline(headingText(line.slice(h[0].length)))}</h${n}>`);
      continue;
    }
    if (/^\s{0,3}[-*_]/.test(line) && isRule(line)) {
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
    ...(hasPostmortems(state) && {
      postmortem: {
        findings: Object.keys(state.postmortem?.findings ?? {}).length,
        pending_fixes: Object.values(state.postmortem?.findings ?? {}).filter((f) => f.pm === undefined && f.fix.status === "pending").length,
        meetings: Object.keys(state.postmortem?.meetings ?? {}).length,
      },
    }),
  };
}
