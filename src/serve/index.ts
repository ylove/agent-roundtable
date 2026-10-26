// ============================================================================
// Read-only home index and execution pages, behind the SecureServer capability
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { EXECUTION_ID_RE, executionTag } from "../ids.js";
import { ID_RE } from "../execution/events.js";
import { executionStatus, type ExecutionStatusReport } from "../execution/run-admin.js";
import { listExecutions, openExecutionStore } from "../execution/store.js";
import { runnerLiveness, type RunnerLiveness } from "../execution/runner-launch.js";
import { renderOverview, renderEscalations, t, type RunnerHealth } from "../dashboard/render.js";
import { DASHBOARD_CSS } from "../dashboard/assets.js";
import { SecureServer, escapeHtml, type Route } from "../http/secure-server.js";
import { persistedLiveDuels, type LiveDuel } from "../table/live-duels.js";

export const INDEX_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const POLL_JS = 'setInterval(() => { if (!document.hidden) location.reload(); }, 15000);';
export interface IndexRun { report: ExecutionStatusReport; lastEvent?: string }
export interface ArchiveSummary { id: string; topic: string; winner: string }

export function indexFrame(base: string, title: string, body: string): string {
  const b = escapeHtml(base);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t(title)}</title><link rel="stylesheet" href="${b}static/dashboard.css"></head><body><main><nav><a href="${b}">All runs</a></nav>${body}</main><script src="${b}static/dashboard.js"></script></body></html>`;
}

export function renderIndex(base: string, runs: IndexRun[], duels: ArchiveSummary[] = [], live: Array<LiveDuel & { host: string }> = [], casting?: string): string {
  const rows = runs.map(({ report: r, lastEvent }) => {
    if (!EXECUTION_ID_RE.test(r.execution)) return "";
    const link = `${escapeHtml(base)}x/${r.execution}/`;
    return `<tr><td><a href="${link}">${t(executionTag(r.execution))}</a> ${t(r.contract?.title ?? "")}</td><td>${t(r.status)}</td><td>${r.completion_pct}%</td><td>$${r.budget.spent_usd.toFixed(2)} / $${r.budget.budget_usd.toFixed(2)}</td><td><a href="${link}escalations">${r.escalations.awaiting_human}</a></td><td>${t(r.runner.state)}${r.runner.state === "running" && r.runner.stale ? " (stale heartbeat)" : ""}</td><td>${t(lastEvent ?? "")}</td></tr>`;
  });
  const body = `<h1>Roundtable</h1><p>Read-only. Refreshes every 15 seconds.</p><h2>Executions</h2><table><thead><tr><th>Run</th><th>State</th><th>Complete</th><th>Spend / budget</th><th>Awaiting you</th><th>Runner</th><th>Last event</th></tr></thead><tbody>${rows.join("")}</tbody></table>` +
    `<h2>Live duels and casting</h2><ul>${live.map(d => `<li>${t(d.id)} · ${t(d.kind ?? "duel")} · ${t(d.agents.join(", "))} · ${t(d.started)} · ${t(d.host)}</li>`).join("")}</ul>` +
    `<h2>Archived duels</h2><ul>${duels.filter(d => ID_RE.test(d.id)).map(d => `<li><a href="${escapeHtml(base)}duels/${d.id}">${t(d.id)}</a> · ${t(d.topic)} · winner ${t(d.winner)}</li>`).join("")}</ul>` +
    `<h2>Latest casting report</h2>${casting ? `<a href="${escapeHtml(base)}casting">Read report</a><pre>${t(casting)}</pre>` : "<p>No casting report yet.</p>"}`;
  return indexFrame(base, "Roundtable", body);
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

export function indexRoutes(): Route[] {
  return [
    { path: "/static/dashboard.css", handler: c => c.send(200, DASHBOARD_CSS, "text/css; charset=utf-8") },
    { path: "/static/dashboard.js", handler: c => c.send(200, POLL_JS, "text/javascript; charset=utf-8") },
    { path: "/", async handler(c) {
      const runs: IndexRun[] = [];
      for (const header of await listExecutions()) {
        try {
          const report = await executionStatus(header.id);
          const store = await openExecutionStore(header.id);
          const last = (await store.events({ sinceSeq: Math.max(0, report.seq - 1) })).at(-1);
          runs.push({ report, lastEvent: last?.ts });
        } catch { /* purged or corrupt runs cannot hide the others */ }
      }
      c.html(200, renderIndex(c.base, runs, archives(), persistedLiveDuels(), castingReport()), INDEX_CSP);
    } },
    { path: /^\/x\/([^/]+)\/(|escalations|static\/dashboard\.(?:css|js))$/, async handler(c) {
      const id = c.match![1], page = c.match![2];
      if (!EXECUTION_ID_RE.test(id) || !(await listExecutions()).some(h => h.id === id)) return c.notFound();
      const store = await openExecutionStore(id);
      if (page.startsWith("static/")) return c.send(200, page.endsWith("css") ? DASHBOARD_CSS : POLL_JS, page.endsWith("css") ? "text/css" : "text/javascript");
      const context = { state: await store.state(), header: store.header(), base: `${c.base}x/${id}/`, indexBase: c.base, runner: indexRunnerHealth(runnerLiveness(id)) };
      c.html(200, page === "escalations" ? renderEscalations(context) : renderOverview(context), INDEX_CSP);
    } },
    { path: /^\/duels\/([^/]+)$/, handler(c) {
      const id = c.match![1];
      if (!ID_RE.test(id)) return c.notFound();
      let archive;
      try { archive = jsonFile(join(ROUNDTABLE_HOME, "duels", `${id}.json`)); } catch { return c.notFound(); }
      c.html(200, indexFrame(c.base, id, `<h1>${t(id)}</h1><pre>${t(JSON.stringify(archive, null, 2))}</pre>`), INDEX_CSP);
    } },
    { path: "/casting", handler(c) {
      const report = castingReport();
      if (!report) return c.notFound();
      c.html(200, indexFrame(c.base, "Casting", `<h1>Latest casting report</h1><pre>${t(report)}</pre>`), INDEX_CSP);
    } },
  ];
}

export function startIndex(bindAddress = "127.0.0.1"): Promise<SecureServer> {
  return SecureServer.start({ name: "Roundtable index", bindAddress, routes: indexRoutes() });
}
