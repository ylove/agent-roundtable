// ============================================================================
// Context bundles: what a huddle, the lead or a format engine is told about an escalation
//
// Built from the blackboard (plus the escalation's diagnostics blob, which the caller reads): the
// contract summary, the escalation and its diagnostics, the tasks involved with their state, last
// note and checks, the leases on the paths in question, recent notes on the topic and the
// decisions in force. Every string is scrubbed and capped, sections go in priority order, and the
// whole bundle stays under BUNDLE_LIMIT characters. The human's chat is never on the blackboard,
// so it can never reach a bundle.
// ============================================================================

import { scrub } from "../security/secrets.js";
import { globsOverlap } from "./leases.js";
import type { BlackboardState, Escalation, EscalationDiagnostics, ExecutionStore, Lease, LeaseRequest } from "./types.js";

export const BUNDLE_LIMIT = 12_000;

const LIMITS = { goal: 600, summary: 1500, question: 1000, diagnostics: 3000, note: 300, decision: 300, stat: 200, tasks: 8, notes: 8, decisions: 10 } as const;

const own = <V>(map: Readonly<Record<string, V>> | undefined, key: string | undefined): V | undefined =>
  map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

function cap(text: string | undefined, max: number): string {
  const t = scrub((text ?? "").trim());
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}… [truncated]`;
}

const oneLine = (text: string | undefined, max: number) => cap((text ?? "").replace(/\s+/g, " "), max);

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Diagnostics extends EscalationDiagnostics {
  /** The diagnostics as bundle text (scrubbed and capped). */
  text: string;
  files: string[];
}

/** The escalation's diagnostics blob (scrubbed JSON written by escalate), or undefined. Never throws. */
export async function readDiagnostics(store: Pick<ExecutionStore, "getBlob">, esc: Escalation): Promise<Diagnostics | undefined> {
  if (!esc.diagnostics_blob) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse((await store.getBlob(esc.diagnostics_blob)).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string" && !!f).slice(0, 200) : [];
  const d: Diagnostics = { text: "", files };
  if (str(o.command_id)) d.command_id = str(o.command_id);
  if (str(o.notes)) d.notes = str(o.notes);
  if (str(o.error_output)) d.error_output = str(o.error_output);
  const parts: string[] = [];
  if (d.command_id) parts.push(`Command: ${oneLine(d.command_id, 100)}`);
  if (files.length) parts.push(`Files: ${files.slice(0, 30).map((f) => oneLine(f, 200)).join(", ")}${files.length > 30 ? `, … (+${files.length - 30})` : ""}`);
  if (d.notes) parts.push(`Notes: ${cap(d.notes, 1000)}`);
  if (d.error_output) parts.push(`Error output:\n${fence(cap(d.error_output.slice(-LIMITS.diagnostics), LIMITS.diagnostics))}`);
  d.text = parts.join("\n");
  return d;
}

// ---------------------------------------------------------------------------
// What an escalation is about
// ---------------------------------------------------------------------------

/** Whether a target names a path or glob rather than an agent, task, team or interface. */
export function isPathTarget(state: Readonly<BlackboardState>, target: string | undefined): target is string {
  if (!target) return false;
  if (own(state.agents, target) || own(state.tasks, target) || own(state.teams, target) || own(state.interfaces, target)) return false;
  return /[/*?]/.test(target) || /\.[A-Za-z0-9]+$/.test(target);
}

/** The paths an escalation is about: a path-like target and the diagnostics' files. */
export function targetPaths(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): string[] {
  const out = isPathTarget(state, esc.target) ? [esc.target] : [];
  for (const f of diag?.files ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

const overlaps = (lease: { paths: readonly string[] }, paths: readonly string[]) =>
  lease.paths.some((g) => paths.some((p) => globsOverlap(g, p)));

/**
 * The leases in question, held by other tasks: those blocking the requester's queued requests,
 * those on the target paths, and (with: agent or path_owner) the target agent's.
 */
export function leasesInQuestion(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): Lease[] {
  const ids = new Set<string>();
  for (const r of requestsOf(state, esc)) for (const b of r.blocking) ids.add(b);
  const paths = targetPaths(state, esc, diag);
  const byAgent = esc.target && own(state.agents, esc.target) && (esc.with === "agent" || esc.with === "path_owner") ? esc.target : undefined;
  for (const l of Object.values(state.leases)) {
    if (l.task === esc.task) continue;
    if ((paths.length && overlaps(l, paths)) || (byAgent && l.agent === byAgent)) ids.add(l.id);
  }
  return [...ids].map((id) => own(state.leases, id)).filter((l): l is Lease => !!l && l.task !== esc.task);
}

/** The requester's queued lease requests. */
export function requestsOf(state: Readonly<BlackboardState>, esc: Escalation): LeaseRequest[] {
  return esc.task ? state.lease_queue.filter((r) => r.task === esc.task) : [];
}

/** Tasks involved: the requester's, the target (a task, an agent's task, an interface's owner), lease holders, then the requester's dependencies. */
export function involvedTasks(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): string[] {
  const out: string[] = [];
  const add = (t: string | undefined) => {
    if (t !== undefined && own(state.tasks, t) && !out.includes(t)) out.push(t);
  };
  add(esc.task);
  const t = esc.target;
  if (t) {
    add(t);
    add(own(state.agents, t)?.task);
    add(own(state.interfaces, t)?.spec?.owner);
  }
  for (const l of leasesInQuestion(state, esc, diag)) add(l.task);
  for (const d of own(state.tasks, esc.task)?.spec.depends_on ?? []) add(d);
  return out.slice(0, LIMITS.tasks);
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface BundleOptions {
  /** readDiagnostics(store, escalation). */
  diagnostics?: Diagnostics;
  /** Character cap (default BUNDLE_LIMIT). */
  limit?: number;
}

function contractSection(state: Readonly<BlackboardState>): string {
  const c = state.contract;
  if (!c) return "## Contract\n\n(no frozen contract)";
  const spent = state.budget.spent_usd;
  const total = c.budget.usd + state.budget.extensions_usd;
  const lines = [
    `- ${oneLine(c.title, 200)} (\`${c.id}\` v${c.version}), run ${state.status}`,
    `- Ultimate goal: ${oneLine(state.goal?.ultimate ?? c.goal.ultimate, LIMITS.goal)}`,
    `- Orchestrator: ${c.scope.orchestrator}${c.scope.parent ? ` (child of ${c.scope.parent.contract}, task ${c.scope.parent.task})` : ""}; lead: ${oneLine(c.authority.lead, 200)}, who may ${c.authority.may.join(", ") || "nothing"}`,
    `- Budget: $${spent.toFixed(2)} of $${total.toFixed(2)} spent; ${Object.values(state.tasks).filter((t) => t.state === "accepted").length} of ${Object.keys(state.tasks).length} tasks accepted`,
  ];
  return `## Contract\n\n${lines.join("\n")}`;
}

function escalationSection(esc: Escalation): string {
  const lines = [
    `- Raised by ${esc.agent}${esc.task ? ` on task \`${esc.task}\`` : ""}: ${esc.kind}, with ${esc.with}${esc.target ? ` (target ${oneLine(esc.target, 200)})` : ""}${esc.blocking ? ", blocking" : ""}${esc.emergency ? `, emergency ${esc.emergency}` : ""}`,
    `- Status: ${esc.status}${esc.routed_to ? `, routed to ${esc.routed_to}` : ""}`,
    `- Summary: ${cap(esc.summary, LIMITS.summary)}`,
  ];
  if (esc.question) lines.push(`- Question: ${cap(esc.question, LIMITS.question)}`);
  if (esc.options?.length) lines.push(`- Options:\n${esc.options.slice(0, 10).map((o, i) => `  ${i + 1}. ${oneLine(o, 200)}`).join("\n")}`);
  return `## Escalation ${esc.id}\n\n${lines.join("\n")}`;
}

function tasksSection(state: Readonly<BlackboardState>, ids: string[]): string {
  if (!ids.length) return "";
  const items = ids.map((id) => {
    const rt = state.tasks[id];
    const head = `- \`${id}\` (${rt.state}${rt.attempt ? `, attempt ${rt.attempt}` : ""}${rt.agent ? `, ${rt.agent}` : ""}${rt.percent !== undefined ? `, ${rt.percent}%` : ""}): ${oneLine(rt.spec.title, 200)}`;
    const more = [`  Persona ${oneLine(rt.spec.persona, 120)}; writes ${rt.spec.paths.write.slice(0, 8).join(", ") || "nothing"}`];
    if (rt.last_note) more.push(`  Last note: ${oneLine(rt.last_note, LIMITS.note)}`);
    const diff = own(state.diffs, id);
    if (diff?.stat) more.push(`  Changes: ${oneLine(diff.stat, LIMITS.stat)}`);
    const checks = Object.entries(state.checks.task).filter(([k]) => k.startsWith(`${id}/`));
    if (checks.length) {
      more.push(`  Checks: ${checks.slice(0, 6).map(([k, c]) => `${k.slice(id.length + 1)} ${c.status}${c.streak > 1 ? ` ×${c.streak}` : ""}${c.signature ? ` (${c.signature.slice(0, 12)})` : ""}`).join(", ")}`);
    }
    return [head, ...more].join("\n");
  });
  return `## Tasks involved\n\n${items.join("\n")}`;
}

function leasesSection(state: Readonly<BlackboardState>, esc: Escalation, diag?: Diagnostics): string {
  const leases = leasesInQuestion(state, esc, diag);
  const reqs = requestsOf(state, esc);
  if (!leases.length && !reqs.length) return "";
  const lines = leases.slice(0, 10).map((l) => {
    const holder = own(state.agents, l.agent);
    return `- \`${l.id}\` ${l.mode} on ${l.paths.slice(0, 6).join(", ")}: ${l.agent} (${holder?.status ?? "unknown"}), task \`${l.task}\` (${own(state.tasks, l.task)?.state ?? "unknown"})`;
  });
  for (const r of reqs.slice(0, 5)) lines.push(`- Queued request \`${r.id}\` by ${r.agent} for ${r.paths.slice(0, 6).join(", ")}, waiting on ${r.blocking.join(", ") || "the queue"}`);
  return `## Leases on the paths in question\n\n${lines.join("\n")}`;
}

function notesSection(state: Readonly<BlackboardState>, esc: Escalation, tasks: string[]): string {
  const agents = new Set([esc.agent, ...(esc.target ? [esc.target] : []), ...tasks.map((t) => state.tasks[t].agent).filter((a): a is string => !!a)]);
  const keys = [...tasks, ...(esc.target ? [esc.target] : [])].map((k) => k.toLowerCase());
  const relevant = state.notes.filter((n) => agents.has(n.agent) || keys.some((k) => n.topic.toLowerCase().includes(k) || n.refs.includes(k)));
  if (!relevant.length) return "";
  return `## Recent notes\n\n${relevant.slice(-LIMITS.notes).map((n) => `- ${n.agent} on "${oneLine(n.topic, 80)}": ${oneLine(n.text, LIMITS.note)}`).join("\n")}`;
}

function decisionsSection(state: Readonly<BlackboardState>, tasks: string[]): string {
  const scopes = new Set(["contract", ...tasks, ...tasks.map((t) => state.tasks[t].spec.team).filter((t): t is string => !!t)]);
  const list = state.decisions.filter((d) => scopes.has(d.scope));
  if (!list.length) return "";
  return `## Decisions in force\n\n${list.slice(-LIMITS.decisions).map((d) => `- ${oneLine(d.text, LIMITS.decision)} [${d.id}, ${d.scope}, by ${d.by}]`).join("\n")}`;
}

/**
 * The context a huddle works from, as markdown under opts.limit characters. Sections in priority
 * order: contract, escalation, diagnostics, tasks, leases, notes, decisions; the first one that
 * does not fit is cut and the rest are left out.
 */
export function buildContextBundle(state: Readonly<BlackboardState>, esc: Escalation, opts: BundleOptions = {}): string {
  const limit = opts.limit ?? BUNDLE_LIMIT;
  const tasks = involvedTasks(state, esc, opts.diagnostics);
  const sections = [
    contractSection(state),
    escalationSection(esc),
    opts.diagnostics?.text ? `## Diagnostics\n\n${opts.diagnostics.text}` : "",
    tasksSection(state, tasks),
    leasesSection(state, esc, opts.diagnostics),
    notesSection(state, esc, tasks),
    decisionsSection(state, tasks),
  ].filter(Boolean);
  let out = "";
  for (const s of sections) {
    const next = out ? `${out}\n\n${s}` : s;
    if (next.length <= limit) {
      out = next;
      continue;
    }
    const room = limit - out.length - 40;
    if (room > 200) out = `${out}${out ? "\n\n" : ""}${s.slice(0, room).trimEnd()}\n… [context truncated]`;
    break;
  }
  return out;
}
