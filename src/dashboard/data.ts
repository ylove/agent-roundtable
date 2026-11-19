// Shared read-only run loaders. Both the index and standalone dashboard use this path.
import { closeSync, lstatSync, readSync } from "node:fs";
import { join } from "node:path";
import { ID_RE } from "../execution/events.js";
import { runnerLiveness } from "../execution/runner-launch.js";
import { EVENT_TYPES, type AnyEvent, type EventType, type ExecutionStore } from "../execution/types.js";
import { openRegularFile, readRegularFile } from "../security/fs-safe.js";
import { pendingPostmortems, projectKeyOf } from "../postmortem/store.js";
import { collectUsage } from "../usage/model.js";
import type { PreviewRecord } from "../previews/store.js";
import { renderUsage, usageSpendSeries } from "./usage-page.js";
import {
  contractMarkdown, eventTask, eventMatches, parseEventFilter, EVENTS_PAGE_SIZE,
  renderOverview, renderTasks, renderTaskDetail, renderEscalations, renderEscalationDetail,
  renderDissents, renderEvents, renderContract, renderPostmortems, renderDagPage,
  validEscalationId, type TaskDetail, type PageContext, type PostmortemRecordView, type RunnerHealth,
} from "./render.js";

const DIFF_CAP_BYTES = 512 * 1024;
const OUTPUT_CAP_BYTES = 64 * 1024;
const RECORD_CAP_BYTES = 256 * 1024;

/** Cut at complete lines before redaction, so a partial secret is never displayed. */
export function capAtLine(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  return { text: nl >= 0 ? cut.slice(0, nl) : "[line too long to display]", truncated: true };
}

export function runnerHealth(store: ExecutionStore): RunnerHealth {
  const live = runnerLiveness(store.id);
  if (live.state === "running") {
    const heartbeat = live.heartbeatAt ? Date.parse(live.heartbeatAt) : NaN;
    const minutes = Number.isFinite(heartbeat) ? Math.max(1, Math.round((Date.now() - heartbeat) / 60_000)) : undefined;
    return live.stale
      ? { status: "stale", detail: `Running, but no heartbeat for ${minutes ?? "an unknown number of"} minutes.` }
      : { status: "alive", detail: "The scheduler process is running." };
  }
  if (live.state === "stopped" && !live.pid) return { status: "unknown", detail: "No record of a runner." };
  if (live.state === "other_host") return { status: "unknown", detail: "The runner is recorded on another host; its process cannot be checked here." };
  return { status: "stopped", detail: `Not running; resume with roundtable run ${store.id}.` };
}

async function blobText(store: ExecutionStore, ref: string, max: number) {
  return capAtLine((await store.getBlob(ref)).toString("utf8"), max);
}

/** Read only complete trailing log lines through a checked descriptor. Never follow log symlinks. */
function workerTail(store: ExecutionStore, agent: string, attempt: number): TaskDetail["log"] {
  if (!ID_RE.test(agent) || !Number.isSafeInteger(attempt) || attempt < 1) return undefined;
  const dirs = [join(store.dir, "agents"), join(store.dir, "agents", agent), join(store.dir, "agents", agent, "runs")];
  try {
    if (dirs.some(p => { const st = lstatSync(p); return !st.isDirectory() || st.isSymbolicLink(); })) return undefined;
    const { fd, stat } = openRegularFile(join(dirs[2], `${attempt}.jsonl`), { noFollow: true });
    try {
      const start = Math.max(0, stat.size - OUTPUT_CAP_BYTES);
      const buf = Buffer.alloc(Math.min(stat.size, OUTPUT_CAP_BYTES));
      let n = 0;
      while (n < buf.length) { const got = readSync(fd, buf, n, buf.length - n, start + n); if (!got) break; n += got; }
      let text = buf.subarray(0, n).toString("utf8");
      if (start) { const nl = text.indexOf("\n"); text = nl < 0 ? "" : text.slice(nl + 1); }
      // The relay appends complete lines. An unfinished final line can contain a partial key.
      const end = text.lastIndexOf("\n");
      text = end < 0 ? "" : text.slice(0, end);
      return text.trim() ? { text, truncated: start > 0, label: `Worker ${agent}, attempt ${attempt}: output tail` } : undefined;
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

export async function loadTaskDetail(store: ExecutionStore, id: string, previews: PreviewRecord[] = []): Promise<TaskDetail | undefined> {
  const state = await store.state();
  if (!ID_RE.test(id) || !Object.hasOwn(state.tasks, id)) return undefined;
  const detail: TaskDetail = { events: [], outputs: {}, previews };
  detail.events = (await store.events()).filter((ev) => eventTask(ev, state) === id);
  const diff = Object.hasOwn(state.diffs, id) ? state.diffs[id] : undefined;
  if (diff) {
    try {
      detail.diff = { stat: diff.stat, commit: diff.commit, ...(await blobText(store, diff.blob, DIFF_CAP_BYTES)) };
    } catch (e) {
      detail.diff = { stat: diff.stat, commit: diff.commit, error: `The diff cannot be read: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  for (const [key, ch] of Object.entries(state.checks.task)) {
    if (!key.startsWith(`${id}/`) || ch.status !== "failed" || !ch.blob) continue;
    try {
      detail.outputs[key] = (await blobText(store, ch.blob, OUTPUT_CAP_BYTES)).text;
    } catch {
      /* output not stored or unreadable: the signature still shows */
    }
  }
  for (const ev of detail.events) {
    if ((ev.type !== "check.failed" && ev.type !== "command.completed") || !ev.payload.output_blob) continue;
    try { detail.outputs[`event:${ev.seq}`] = (await blobText(store, ev.payload.output_blob, OUTPUT_CAP_BYTES)).text; } catch { /* Optional output. */ }
  }
  const launches = detail.events.filter(ev => ev.type === "agent.spawned" || ev.type === "task.claimed").reverse();
  for (const ev of launches) {
    if (ev.type !== "agent.spawned" && ev.type !== "task.claimed") continue;
    detail.log = workerTail(store, ev.payload.agent, ev.payload.attempt);
    if (detail.log) break;
  }
  if (!detail.log && state.tasks[id].agent) detail.log = workerTail(store, state.tasks[id].agent!, state.tasks[id].attempt);
  return detail;
}

export async function eventsPage(store: ExecutionStore, c: PageContext, query: URLSearchParams): Promise<string> {
  const state = await store.state();
  const f = parseEventFilter(query);
  let found: AnyEvent[];
  if (!f.type && !f.task) {
    // Unfiltered: read only the page's window of the log.
    const top = Math.min(state.seq, (f.before ?? state.seq + 1) - 1);
    found = await store.events({ sinceSeq: Math.max(0, top - EVENTS_PAGE_SIZE - 1), limit: EVENTS_PAGE_SIZE + 1 });
  } else {
    const types = f.type ? (EVENT_TYPES.filter((x) => x === f.type || x.startsWith(`${f.type}.`)) as EventType[]) : undefined;
    found = await store.events(types ? { types } : {});
  }
  const matches = found.filter((ev) => ev.seq <= state.seq && eventMatches(ev, f));
  const more = matches.length > EVENTS_PAGE_SIZE || (!f.type && !f.task && matches.length > 0 && matches[0].seq > 1);
  return renderEvents({ ...c, state }, f, matches.slice(-EVENTS_PAGE_SIZE).reverse(), more);
}

export async function contractPage(store: ExecutionStore, c: PageContext): Promise<string> {
  const state = await store.state();
  const contract = state.contract;
  let md: string | undefined;
  let source = "";
  if (contract) {
    md = contractMarkdown(contract);
    source = `Generated from the frozen contract, version ${contract.version}.`;
    const written = contractFile(store, contract.id);
    if (written !== undefined) md += `\n\n---\n\n# CONTRACT.md\n\n${written}`;
  }
  return renderContract({ ...c, state }, md, source);
}

export async function postmortemsPage(store: ExecutionStore, c: PageContext): Promise<string> {
  const state = await store.state();
  const records: Record<string, PostmortemRecordView> = {};
  const pending = !c.indexBase && c.nonce ? pendingPostmortems(projectKeyOf(store.header().repo_root)) : [];
  for (const [id, m] of Object.entries(state.postmortem?.meetings ?? {})) {
    if (!m.concluded) continue;
    try {
      Object.defineProperty(records, id, { value: { markdown: (await blobText(store, m.concluded.record, RECORD_CAP_BYTES)).text, pending: pending.filter(a => a.pm === id) }, enumerable: true });
    } catch (e) {
      Object.defineProperty(records, id, { value: { error: `The record cannot be read: ${e instanceof Error ? e.message : String(e)}`, pending: pending.filter(a => a.pm === id) }, enumerable: true });
    }
  }
  return renderPostmortems({ ...c, state }, records);
}

function contractFile(store: ExecutionStore, ctr: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(ctr) || ctr.includes("..")) return undefined;
  const path = join(store.dir, "contracts", ctr, "CONTRACT.md");
  try {
    return readRegularFile(path, { noFollow: true, maxBytes: 1024 * 1024 }).data.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Render every read-only run page, without any action nonce in index contexts. */
export async function runPage(store: ExecutionStore, c: PageContext, path: string, query = new URLSearchParams()): Promise<string | undefined> {
  switch (path) {
    case "": return renderOverview({ ...c, usage: await collectUsage({ executions: [store.id], table: false }), recentEvents: await store.events({ sinceSeq: Math.max(0, c.state.seq - 5) }) });
    case "tasks": return renderTasks(c);
    case "events": return eventsPage(store, c, query);
    case "contract": return contractPage(store, c);
    case "postmortems": return postmortemsPage(store, c);
    case "dag": return renderDagPage(c);
    case "dissents": return renderDissents(c);
    case "escalations": return renderEscalations(c);
    case "usage": return renderUsage(c, await collectUsage({ executions: [store.id], table: false }), usageSpendSeries(await store.events({ types: ["budget.usage_recorded"] })));
  }
  if (path.startsWith("tasks/")) {
    const id = path.slice(6);
    const detail = await loadTaskDetail(store, id);
    return detail ? renderTaskDetail(c, id, detail) : undefined;
  }
  if (path.startsWith("escalations/")) {
    const id = path.slice(12);
    if (!validEscalationId(id) || !Object.hasOwn(c.state.escalations, id)) return undefined;
    const events = await store.events();
    const e = c.state.escalations[id];
    let diagnostics: string | undefined;
    if (e.diagnostics_blob) { try { diagnostics = (await blobText(store, e.diagnostics_blob, OUTPUT_CAP_BYTES)).text; } catch { /* Optional evidence. */ } }
    return renderEscalationDetail(c, id, events, diagnostics);
  }
  return undefined;
}
