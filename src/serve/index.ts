// ============================================================================
// Read-only home index and execution pages, behind the SecureServer capability
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { EXECUTION_ID_RE } from "../ids.js";
import { ID_RE } from "../execution/events.js";
import { executionStatus, type ExecutionStatusReport } from "../execution/run-admin.js";
import { listExecutions, openExecutionStore } from "../execution/store.js";
import { runnerLiveness, type RunnerLiveness } from "../execution/runner-launch.js";
import { awaitingHuman, renderOverview, renderEscalations, t, tc, type RunnerHealth } from "../dashboard/render.js";
import { DASHBOARD_CSS } from "../dashboard/assets.js";
import { displayState, type DisplayState } from "../dashboard/display-state.js";
import { humanTime } from "../dashboard/time.js";
import type { BlackboardState, Escalation } from "../execution/types.js";
import { sitePage, type SiteSection } from "../dashboard/shell.js";
import { SecureServer, escapeHtml, type Route } from "../http/secure-server.js";
import { livePreviews, previewFramesHtml, previewOrigins, previewScreenshotRoute, withFrameSrc } from "../previews/embed.js";
import { PREVIEW_JS } from "../previews/assets.js";
import type { PreviewRecord } from "../previews/store.js";
import { persistedLiveDuels, type LiveDuel } from "../table/live-duels.js";
import { duelPageRoutes } from "./duel-pages.js";

export const INDEX_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// A page with a live preview does not reload: that would restart the previewed app every 15 seconds.
const POLL_JS = PREVIEW_JS + '\ninitPreviewCards();\nsetInterval(() => { if (!document.hidden && !document.querySelector("iframe.preview")) location.reload(); }, 15000);';
export interface IndexRun {
  report: ExecutionStatusReport;
  state?: BlackboardState;
  created?: string;
  startedAt?: string;
  lastEvent?: string;
  escalationTimes?: Record<string, { raised?: string; resolved?: string }>;
}
export interface ArchiveSummary { id: string; topic: string; winner: string }

/** An index page in the shared site shell. New pages should call sitePage directly to set the active section. */
export function indexFrame(base: string, title: string, body: string, active?: SiteSection): string {
  return sitePage({ base, title, body, ...(active && { active }) });
}

const money = (n: number): string => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
const timestamp = (value?: string): number => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const runTitle = (run: IndexRun): string => run.report.contract?.title || "Untitled run";
const runHref = (base: string, run: IndexRun): string => `${escapeHtml(base)}x/${run.report.execution}/`;
const runState = (run: IndexRun): DisplayState => displayState(run.state ?? run.report, run.report.runner);
const validRuns = (runs: IndexRun[]): IndexRun[] => runs.filter(run => EXECUTION_ID_RE.test(run.report.execution));
const newestRuns = (runs: IndexRun[]): IndexRun[] => [...runs].sort((a, b) =>
  timestamp(b.lastEvent ?? b.created) - timestamp(a.lastEvent ?? a.created) || b.report.execution.localeCompare(a.report.execution));
const waitingCount = (run: IndexRun): number => run.state ? awaitingHuman(run.state).length : run.report.escalations.awaiting_human;

function statePill(state: DisplayState): string {
  return `<span class="pill st-${state.kind}" title="${escapeHtml(state.detail)}">${state.label}</span>`;
}

function draftNote(base: string, path: string, count: number, show: boolean): string {
  if (!count) return "";
  return `<p class="draft-note muted">${count} draft${count === 1 ? "" : "s"} ${show ? "shown" : "hidden"}. Drafts have no frozen contract. ` +
    `<a href="${escapeHtml(base)}${path}${show ? "" : "?drafts=1"}">${show ? "Hide drafts" : `Show ${count} draft${count === 1 ? "" : "s"}`}</a></p>`;
}

function runCard(base: string, run: IndexRun): string {
  const r = run.report, state = runState(run), link = runHref(base, run);
  const total = Math.max(0, r.tasks.total - (r.tasks.by_state.cancelled ?? 0));
  const done = r.tasks.by_state.accepted ?? 0;
  const pct = Number.isFinite(r.completion_pct) ? Math.min(100, Math.max(0, r.completion_pct)) : 0;
  // The bar is weighted progress (tasks in flight count partly), so say so when it differs from finished tasks.
  const finishedPct = total ? Math.round((done / total) * 100) : 0;
  const progress = total ? `${done} of ${total} tasks done${Math.round(pct) !== finishedPct ? ` · ${Math.round(pct)}% of the work` : ""}` : "No tasks";
  const notStarted = total > 0 && pct === 0 ? "<span class=\"muted\">Not started</span> · " : "";
  const waiting = waitingCount(run);
  return `<article class="run-card card"><div class="run-card-heading"><div class="run-identity"><h3><a href="${link}">${tc(runTitle(run), 200)}</a></h3>` +
    `<code class="run-id">${t(r.execution)}</code></div>${statePill(state)}</div>` +
    `<div class="run-metrics"><div class="run-progress"><p>${notStarted}${progress}</p>` +
    `<progress max="100" value="${pct}" aria-label="Task progress: ${progress}">${progress}</progress></div>` +
    `<div><span class="metric-label">Spend / budget</span><strong class="amount">${money(r.budget.spent_usd)} <span class="muted">/ ${money(r.budget.budget_usd)}</span></strong>` +
    `${r.budget.estimated ? `<span class="metric-label" title="Some usage costs are estimates.">Partly estimated</span>` : ""}</div>` +
    `<div><span class="metric-label">Awaiting you</span><a class="awaiting-count${waiting ? " has-waiting" : ""}" href="${link}escalations">${waiting}${waiting ? " to review" : " pending"}</a></div></div>` +
    (state.kind === "interrupted" ? `<p class="run-guidance">The runner is not running. Resume with <code>roundtable run ${t(r.execution)}</code></p>` :
      state.label === "Running, no heartbeat" ? `<p class="run-guidance">The runner is alive, but its heartbeat is stale.</p>` : "") +
    `<footer class="run-times"><span>Last activity ${humanTime(run.lastEvent ?? run.created)}</span>` +
    `<span>${run.startedAt ? `Started ${humanTime(run.startedAt)}` : run.created ? `Created ${humanTime(run.created)}` : "Start time unknown"}</span></footer></article>`;
}

const noRuns = `<div class="card empty-state"><h3>No runs yet</h3><p>Runs show task progress, spending and outcomes here. From your chat, propose and freeze a contract, then execute it.</p></div>`;

interface IndexEscalation { run: IndexRun; escalation: Escalation; raised?: string; resolved?: string }
function escalationsFor(runs: IndexRun[], resolved = false): IndexEscalation[] {
  return runs.flatMap(run => {
    const list = run.state ? resolved ? Object.values(run.state.escalations).filter(e => e.status === "resolved") : awaitingHuman(run.state) : [];
    return list.map(escalation => ({ run, escalation, ...run.escalationTimes?.[escalation.id] }));
  }).sort((a, b) => timestamp(resolved ? b.resolved : b.raised) - timestamp(resolved ? a.resolved : a.raised) || b.escalation.raised_seq - a.escalation.raised_seq);
}

const ESCALATION_KINDS: Record<Escalation["kind"], [string, string]> = {
  blocker: ["Blocked work", "Work cannot continue without a decision or change."],
  ambiguity: ["Question", "A requirement needs clarification."],
  resource: ["Resource request", "The run needs more time, budget or capacity."],
  conflict: ["Conflict", "Two requirements or changes disagree."],
  assistance: ["Help needed", "An agent needs help to continue."],
  emergency: ["Urgent decision", "The run needs prompt attention from a person."],
};

function escalationCard(base: string, entry: IndexEscalation, resolved = false): string {
  const { run, escalation: e } = entry, link = runHref(base, run);
  const [kind, explanation] = ESCALATION_KINDS[e.kind] ?? ["Decision needed", "This request needs a person."];
  const task = e.task && run.state && Object.hasOwn(run.state.tasks, e.task) ? run.state.tasks[e.task].spec.title : undefined;
  return `<article class="card attention-card"><div class="attention-heading"><h3><a href="${link}">${tc(runTitle(run), 200)}</a></h3>` +
    `<span class="chip" title="${explanation}">${kind}</span></div><code class="run-id">${t(run.report.execution)}</code>` +
    `<p class="task-label">${e.task ? `Task: ${task ? `${tc(task, 160)} <code>${t(e.task)}</code>` : t(e.task)}` : "Run-wide decision"}</p>` +
    `<p class="decision-summary">${tc(e.summary, 600)}</p>${e.question ? `<p class="decision-question">${tc(e.question, 600)}</p>` : ""}` +
    (resolved && e.resolution ? `<p><strong>Decision:</strong> ${tc(e.resolution.decision, 600)}</p>` : "") +
    `<footer class="attention-footer"><span class="muted">Raised ${humanTime(entry.raised)}${resolved && entry.resolved ? ` · Resolved ${humanTime(entry.resolved)}` : ""}</span>` +
    `<a href="${link}escalations">${resolved ? "View decision" : "Review escalation"}<span class="sr-only"> for ${tc(runTitle(run), 200)}</span></a></footer></article>`;
}

export function renderIndex(base: string, runs: IndexRun[], duels: ArchiveSummary[] = [], live: Array<LiveDuel & { host: string }> = [], casting?: string, previews: PreviewRecord[] = [], showDrafts = false): string {
  const all = validRuns(runs), drafts = all.filter(r => runState(r).kind === "draft").length;
  const visible = newestRuns(all.filter(r => showDrafts || runState(r).kind !== "draft"));
  const waiting = escalationsFor(all), active = all.filter(r => runState(r).kind === "running").length;
  const interrupted = all.filter(r => runState(r).kind === "interrupted").length;
  const archived = duels.filter(d => ID_RE.test(d.id));
  const liveDuels = live.filter(d => d.kind !== "casting" && ID_RE.test(d.id));
  const duelIds = new Set([...archived.map(d => d.id), ...liveDuels.map(d => d.id)]);
  const duelLinks = new Map<string, { id: string; title: string; live: boolean }>();
  for (const d of liveDuels) duelLinks.set(d.id, { id: d.id, title: d.agents.join(" vs "), live: true });
  for (const d of archived) if (!duelLinks.has(d.id)) duelLinks.set(d.id, { id: d.id, title: d.topic || "Archived duel", live: false });
  const b = escapeHtml(base);
  const summary = (label: string, value: string | number, detail: string, path: string, tone = "") =>
    `<a class="card summary-card ${tone}" href="${b}${path}"><span class="metric-label">${label}</span><strong class="summary-value">${value}</strong><span class="summary-detail">${detail}</span></a>`;
  let castingAt: string | undefined;
  try { const report = JSON.parse(casting ?? "null"); if (typeof report?.createdAt === "string") castingAt = report.createdAt; } catch { /* only the link is needed */ }
  const body = `<div class="page-heading"><div><p class="eyebrow">Your workspace</p><h1>Overview</h1><p class="page-intro">Progress, outcomes and decisions that need you.</p></div><span class="refresh-note">Read-only · Refreshes every 15 seconds</span></div>` +
    `<section class="summary-grid" aria-label="Workspace summary">` +
    summary("Awaiting you", all.reduce((sum, r) => sum + waitingCount(r), 0), "Decisions needing a person", "escalations", "summary-warn") +
    summary("Active runs", active, "Runners working now", "runs", "summary-accent") +
    summary("Interrupted runs", interrupted, "Runners that need resuming", "runs", "summary-warn") +
    summary("Recent duels", duelIds.size, `${liveDuels.length} live · ${archived.length} archived`, "duels") +
    (casting ? summary("Latest casting report", "Ready", castingAt ? humanTime(castingAt) : "Review the recommended team", "casting") :
      `<div class="card summary-card"><span class="metric-label">Latest casting report</span><strong class="summary-value">None yet</strong><span class="summary-detail">Run <code>roundtable cast &quot;brief&quot;</code> to recommend a team.</span></div>`) + `</section>` +
    `<div class="overview-columns"><section class="recent-runs"><div class="section-heading"><h2>Recent runs</h2><a href="${b}runs${showDrafts ? "?drafts=1" : ""}">View all runs</a></div>` +
    draftNote(base, "", drafts, showDrafts) + `<div class="run-list">${visible.slice(0, 5).map(r => runCard(base, r)).join("") || (drafts ? `<div class="card empty-state"><h3>No started runs yet</h3><p>Freeze a contract and execute it from your chat to see progress here.</p></div>` : noRuns)}</div></section>` +
    `<section class="needs-you"><div class="section-heading"><h2>Needs you</h2><a href="${b}escalations">View all escalations</a></div>` +
    `<div class="attention-list">${waiting.slice(0, 5).map(e => escalationCard(base, e)).join("") || `<div class="card empty-state"><span class="pill st-completed">All clear</span><h3>No decisions waiting</h3><p>Questions and requests from your runs appear here when a person is needed.</p></div>`}</div></section></div>` +
    previewFramesHtml(previews, base) +
    `<section><div class="section-heading"><h2>Duels</h2><a href="${b}duels">View all duels</a></div><div class="card">` +
    (duelIds.size ? `<ul class="duel-shortlist">${[...duelLinks.values()].slice(0, 5).map(d => `<li><a href="${b}duels/${d.id}">${tc(d.title, 160)}</a>${d.live ? `<span class="pill st-running">Running</span>` : `<span class="chip">Archived</span>`}<code class="run-id">${t(d.id)}</code></li>`).join("")}</ul>` :
      `<p class="empty">No duels yet. Run <code>roundtable duel &quot;topic&quot; --team-a designer,builder --team-b marketer,skeptic --judges cfo</code>.</p>`) + `</div></section>`;
  return sitePage({ base, title: "Overview", active: "overview", body });
}

export function renderRuns(base: string, runs: IndexRun[], showDrafts = false): string {
  const all = validRuns(runs), drafts = all.filter(r => runState(r).kind === "draft").length;
  const visible = newestRuns(all.filter(r => showDrafts || runState(r).kind !== "draft"));
  const body = `<div class="page-heading"><div><p class="eyebrow">Heads-down work</p><h1>Runs</h1><p class="page-intro">Follow work from its first task to its outcome.</p></div><span class="refresh-note">Newest activity first</span></div>` +
    draftNote(base, "runs", drafts, showDrafts) + `<section class="run-list" aria-label="Runs">${visible.map(r => runCard(base, r)).join("") ||
      (drafts ? `<div class="card empty-state"><h3>No started runs yet</h3><p>Show drafts to review contracts that have not been frozen.</p></div>` : noRuns)}</section>`;
  return sitePage({ base, title: "Runs", active: "runs", body });
}

export function renderGlobalEscalations(base: string, runs: IndexRun[]): string {
  const all = validRuns(runs), waiting = escalationsFor(all), resolved = escalationsFor(all, true);
  const body = `<div class="page-heading"><div><p class="eyebrow">Human decisions</p><h1>Escalations</h1><p class="page-intro">Questions and requests awaiting a person, across all runs.</p></div><span class="pill st-${waiting.length ? "interrupted" : "completed"}">${waiting.length} awaiting you</span></div>` +
    `<section class="attention-list" aria-label="Awaiting you">${waiting.map(e => escalationCard(base, e)).join("") || `<div class="card empty-state"><h2>No escalations awaiting you</h2><p>When a run needs a decision, its question and task appear here. Answer it from your chat.</p></div>`}</section>` +
    `<details class="card resolved-escalations"><summary>Recently resolved (${Math.min(resolved.length, 20)})</summary>` +
    (resolved.length ? `<div class="attention-list">${resolved.slice(0, 20).map(e => escalationCard(base, e, true)).join("")}</div>` : `<p class="muted">Resolved decisions will appear here.</p>`) + `</details>`;
  return sitePage({ base, title: "Escalations", active: "escalations", body });
}

function jsonFile(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function castingReport(): string | undefined {
  try { return JSON.stringify(jsonFile(join(ROUNDTABLE_HOME, "casting", "latest.json")), null, 2); } catch { return undefined; }
}
function archives(): ArchiveSummary[] {
  let names: string[];
  try { names = readdirSync(join(ROUNDTABLE_HOME, "duels")); } catch { return []; }
  return names.filter(n => n.endsWith(".json") && ID_RE.test(n.slice(0, -5))).flatMap(name => {
    try {
      const data = jsonFile(join(ROUNDTABLE_HOME, "duels", name)) as { events?: Array<{ type: string; topic?: string; winner?: string }> };
      return [{ id: name.slice(0, -5), topic: data.events?.find(e => e.type === "start")?.topic ?? "", winner: data.events?.find(e => e.type === "end")?.winner ?? "unknown" }];
    } catch { return []; }
  });
}
export function indexRunnerHealth(live: RunnerLiveness): RunnerHealth {
  return { status: live.state === "running" ? live.stale ? "stale" : "alive" : "unknown", detail: live.state };
}

/** Read-only snapshots. A broken or concurrently purged run cannot hide the rest of the index. */
async function indexRuns(): Promise<IndexRun[]> {
  const runs: IndexRun[] = [];
  for (const header of await listExecutions()) {
    try {
      const store = await openExecutionStore(header.id);
      const report = await executionStatus(header.id);
      const [state, tail, history] = await Promise.all([
        store.state(),
        store.events({ sinceSeq: Math.max(0, report.seq - 1) }),
        store.events({ types: ["execution.started", "escalation.raised", "escalation.resolved", "escalation.auto_resolved"] }),
      ]);
      const escalationTimes: NonNullable<IndexRun["escalationTimes"]> = Object.create(null);
      let startedAt: string | undefined;
      for (const event of history) {
        if (event.type === "execution.started") startedAt ??= event.ts;
        if (event.type === "escalation.raised") {
          (escalationTimes[event.payload.escalation.id] ??= {}).raised = event.ts;
        } else if (event.type === "escalation.resolved" || event.type === "escalation.auto_resolved") {
          (escalationTimes[event.payload.id] ??= {}).resolved = event.ts;
        }
      }
      runs.push({ report, state, created: header.created, startedAt, lastEvent: tail.at(-1)?.ts, escalationTimes });
    } catch { /* purged or corrupt runs cannot hide the others */ }
  }
  return runs;
}

export function indexRoutes(): Route[] {
  return [
    previewScreenshotRoute(livePreviews),
    { path: "/static/dashboard.css", handler: c => c.send(200, DASHBOARD_CSS, "text/css; charset=utf-8") },
    { path: "/static/dashboard.js", handler: c => c.send(200, POLL_JS, "text/javascript; charset=utf-8") },
    { path: "/", async handler(c) {
      const runs = await indexRuns();
      const previews = livePreviews();
      c.html(200, renderIndex(c.base, runs, archives(), persistedLiveDuels(), castingReport(), previews, c.query.get("drafts") === "1"), withFrameSrc(INDEX_CSP, previewOrigins(previews)));
    } },
    { path: "/runs", async handler(c) {
      c.html(200, renderRuns(c.base, await indexRuns(), c.query.get("drafts") === "1"), INDEX_CSP);
    } },
    { path: "/escalations", async handler(c) {
      c.html(200, renderGlobalEscalations(c.base, await indexRuns()), INDEX_CSP);
    } },
    { path: /^\/x\/([^/]+)\/(|escalations|static\/dashboard\.(?:css|js))$/, async handler(c) {
      const id = c.match![1], page = c.match![2];
      if (!EXECUTION_ID_RE.test(id) || !(await listExecutions()).some(h => h.id === id)) return c.notFound();
      const store = await openExecutionStore(id);
      if (page.startsWith("static/")) return c.send(200, page.endsWith("css") ? DASHBOARD_CSS : POLL_JS, page.endsWith("css") ? "text/css" : "text/javascript");
      const state = await store.state();
      const last = (await store.events({ sinceSeq: Math.max(0, state.seq - 1) })).at(-1);
      const context = { state, lastEvent: last?.ts, header: store.header(), base: `${c.base}x/${id}/`, indexBase: c.base, runner: indexRunnerHealth(runnerLiveness(id)) };
      c.html(200, page === "escalations" ? renderEscalations(context) : renderOverview(context), INDEX_CSP);
    } },
    ...duelPageRoutes(INDEX_CSP),
  ];
}

export function startIndex(bindAddress = "127.0.0.1"): Promise<SecureServer> {
  return SecureServer.start({ name: "Roundtable index", bindAddress, routes: indexRoutes() });
}
