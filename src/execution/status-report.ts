// ============================================================================
// execution_status (heads-down.md §13): the orchestrator's view of a run
//
// Without an id: every execution with its status. With one, the views:
//   summary      status, completion (§13 weights), blockers, latest checks, a rough ETA, the budget,
//                runner health (runner.json's heartbeat), the dashboard, GitHub sync health, watchers
//   tasks        every task (or the focused ones) with state, weight, progress, checks and timing
//   escalations  open escalations first, with the question, options and routing
//   events       the log from since_seq (compact; focus keeps the focused tasks' events)
//   budget       spend by task, agent and team, thresholds and extensions
//   context      a redacted bundle for running a format at the table: from the blackboard only, so
//                never the human's chat (no confirmation, no original prompt) and never a secret
//
// focus is fuzzy: its words and their 3+-character prefixes are scored against each task's id,
// title, team, path segments and interface names, so "nav" finds build-nav-bar and the task that
// writes src/components/nav/**. Everything returned is scrubbed and capped.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completion, taskWeight } from "../dashboard/render.js";
import { scrub } from "../security/secrets.js";
import { executionBudgetUsd } from "./budget.js";
import { BUNDLE_LIMIT, buildContextBundle, readDiagnostics } from "./context-bundle.js";
import { orchestratorDeps, dashboardUrl } from "./orchestrator.js";
import { readRunnerInfo, runnerLiveness } from "./runner-launch.js";
import { executionDir, listExecutions, openExecutionStore, type FileExecutionStore } from "./store.js";
import type { AnyEvent, BlackboardState, Escalation, TaskRuntime, Visibility } from "./types.js";
import { watcherObservations } from "./watch.js";

type Json = Record<string, unknown>;

export const STATUS_VIEWS = ["summary", "tasks", "escalations", "events", "budget", "context"] as const;
export type StatusView = (typeof STATUS_VIEWS)[number];

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const OPEN_ESCALATION: ReadonlySet<string> = new Set(["open", "routed", "in_huddle", "awaiting_human"]);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const own = <V>(map: Readonly<Record<string, V>>, key: string | undefined): V | undefined =>
  key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

function cap(text: string | undefined, max: number): string {
  const t = scrub((text ?? "").trim());
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
const oneLine = (text: string | undefined, max: number): string => cap((text ?? "").replace(/\s+/g, " "), max);

// ============================================================================
// Focus: fuzzy matching of tasks
// ============================================================================

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "be", "of", "to", "in", "on", "for", "and", "or", "it", "its", "how", "close", "far", "along",
  "what", "whats", "about", "with", "has", "have", "did", "does", "do", "done", "yet", "status", "progress", "there", "any", "which",
  "who", "where", "when", "we", "our", "my", "me", "can", "will", "still", "task", "tasks", "team", "part", "work", "thing", "stuff",
]);

const words = (s: string | undefined): string[] => (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The focus's search words: two characters or more, stop words dropped (unless nothing else is left). */
export function focusTokens(focus: string): string[] {
  const all = words(focus).filter((t) => t.length >= 2);
  const meaningful = all.filter((t) => !STOP_WORDS.has(t));
  return [...new Set(meaningful.length ? meaningful : all)];
}

/** Per token, the best match in vocab: 3 exact, 2 a shared 3+-character prefix, 1 contained (3+ characters). */
export function focusScore(tokens: readonly string[], vocab: readonly string[]): number {
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const w of vocab) {
      if (w === t) best = 3;
      else if (t.length >= 3 && w.length >= 3 && (w.startsWith(t) || t.startsWith(w))) best = Math.max(best, 2);
      else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 1);
      if (best === 3) break;
    }
    total += best;
  }
  return total;
}

/** What a task is known by: its id, title, team, path segments and the interfaces it owns or consumes. */
export function taskVocabulary(state: Readonly<BlackboardState>, rt: TaskRuntime): string[] {
  const id = rt.spec.id;
  const globs = [...rt.spec.paths.write, ...(rt.spec.paths.read ?? [])];
  const interfaces = Object.entries(state.interfaces)
    .filter(([, i]) => (i.spec?.owner ?? i.task) === id || i.spec?.consumers?.includes(id))
    .flatMap(([name, i]) => [...words(name), ...words(i.path ?? i.spec?.path)]);
  return [...new Set([...words(id), ...words(rt.spec.title), ...words(rt.spec.team), ...globs.flatMap((g) => words(g.replace(/\*+|\?/g, " "))), ...interfaces])];
}

export interface FocusMatch {
  task: string;
  score: number;
}

/**
 * The tasks a focus names, best first: every task scoring at least half the best score (and above
 * zero), so a strong match is not drowned by incidental ones.
 */
export function matchFocus(state: Readonly<BlackboardState>, focus: string): FocusMatch[] {
  const tokens = focusTokens(focus);
  if (!tokens.length) return [];
  const scored = Object.values(state.tasks)
    .map((rt) => ({ task: rt.spec.id, score: focusScore(tokens, taskVocabulary(state, rt)) }))
    .filter((m) => m.score > 0)
    .sort((x, y) => y.score - x.score || x.task.localeCompare(y.task));
  const top = scored[0]?.score ?? 0;
  return scored.filter((m) => m.score * 2 >= top);
}

// ============================================================================
// Completion and the ETA
// ============================================================================

/** Weighted completion of some tasks (§13: accepted 1, submitted 0.8, otherwise the reported percent or 0.4), 0–100. */
export function weightedCompletion(tasks: readonly TaskRuntime[]): number {
  const counted = tasks.filter((rt) => rt.state !== "cancelled");
  if (!counted.length) return 0;
  return Math.round((counted.reduce((sum, rt) => sum + taskWeight(rt), 0) / counted.length) * 100);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface Eta {
  minutes?: number;
  /** ISO time the run (or the focused tasks) should be done by, from `now`. */
  at?: string;
  median_task_min?: number;
  remaining_tasks: number;
  parallelism: number;
  samples: number;
  note: string;
}

/**
 * A rough ETA: the median duration of the run's accepted tasks × the remaining work (each
 * unfinished task's 1 − weight) ÷ the parallelism (max_parallel, at most the unfinished tasks).
 */
export function estimateEta(state: Readonly<BlackboardState>, tasks: readonly TaskRuntime[] = Object.values(state.tasks), now = Date.now()): Eta {
  const durations = Object.values(state.tasks)
    .filter((rt) => rt.state === "accepted" && rt.started_at && rt.finished_at)
    .map((rt) => Date.parse(rt.finished_at!) - Date.parse(rt.started_at!))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const open = tasks.filter((rt) => !["accepted", "cancelled", "failed"].includes(rt.state));
  const remaining = Math.round(open.reduce((sum, rt) => sum + (1 - taskWeight(rt)), 0) * 100) / 100;
  const parallelism = Math.max(1, Math.min(state.contract?.budget.max_parallel ?? 1, open.length || 1));
  const base = { remaining_tasks: remaining, parallelism, samples: durations.length };
  if (!open.length) return { ...base, minutes: 0, note: "nothing left to do" };
  if (!durations.length) return { ...base, note: "no task has been accepted yet, so there is no duration to go by" };
  const med = median(durations);
  const minutes = Math.round((med * remaining) / parallelism / 60_000);
  return {
    ...base,
    minutes,
    at: new Date(now + minutes * 60_000).toISOString(),
    median_task_min: Math.round(med / 6_000) / 10,
    note: "rough: the median accepted task's duration × the remaining work ÷ the parallelism",
  };
}

// ============================================================================
// Health: runner, dashboard, GitHub sync, watchers
// ============================================================================

function runnerHealth(exe: string, now = Date.now()): Json {
  const live = runnerLiveness(exe, now);
  const info = readRunnerInfo(exe);
  const age = info ? Math.round((now - Date.parse(info.heartbeatAt)) / 1000) : undefined;
  return {
    state: live.state,
    ...("pid" in live && live.pid !== undefined && { pid: live.pid }),
    ...(live.state === "running" && { healthy: !live.stale }),
    ...(age !== undefined && Number.isFinite(age) && { heartbeat_age_s: age }),
    ...(info?.version && { version: info.version }),
    ...(live.state === "stopped" && live.reason && { stop_reason: cap(live.reason, 300) }),
  };
}

function githubHealth(exe: string, state: Readonly<BlackboardState>, v: Visibility | undefined): Json | undefined {
  if (!v?.github) return undefined;
  try {
    const g = JSON.parse(readFileSync(join(executionDir(exe), "github.json"), "utf8")) as {
      repo?: string; cursor?: number; failed_rounds?: number; issues?: Record<string, unknown>; outbox?: unknown[]; backoff_until?: number; completed?: boolean;
    };
    const failed = typeof g.failed_rounds === "number" ? g.failed_rounds : 0;
    return {
      repo: v.github.repo,
      healthy: failed < 3,
      ...(failed && { failed_rounds: failed }),
      behind_events: Math.max(0, state.seq - (typeof g.cursor === "number" ? g.cursor : 0)),
      issues: g.issues ? Object.keys(g.issues).length : 0,
      pending: Array.isArray(g.outbox) ? g.outbox.length : 0,
      ...(typeof g.backoff_until === "number" && g.backoff_until > Date.now() && { backing_off_until: new Date(g.backoff_until).toISOString() }),
    };
  } catch {
    return { repo: v.github.repo, healthy: false, note: "not synced yet (the runner starts the sync)" };
  }
}

function watchers(exe: string, orchestrator: string | undefined): Json {
  const out: Json = {};
  for (const [name, w] of Object.entries(watcherObservations(exe))) {
    out[name] = { alive: w.alive, ...(w.lastSeenAt !== undefined && { last_seen_at: new Date(w.lastSeenAt).toISOString() }) };
  }
  if (orchestrator && !own(out as Record<string, Json>, orchestrator)) out[orchestrator] = { alive: false };
  return out;
}

async function startedPayload(store: FileExecutionStore): Promise<{ visibility?: Visibility; sandbox?: string } | undefined> {
  const [e] = await store.events({ types: ["execution.started"], limit: 1 });
  return e?.type === "execution.started" ? { visibility: e.payload.visibility, sandbox: e.payload.sandbox } : undefined;
}

// ============================================================================
// Pieces of a report
// ============================================================================

function taskLine(state: Readonly<BlackboardState>, rt: TaskRuntime, full = false): Json {
  const id = rt.spec.id;
  const checks = Object.entries(state.checks.task).filter(([k]) => k.startsWith(`${id}/`));
  return {
    id,
    title: oneLine(rt.spec.title, 200),
    ...(rt.spec.team && { team: rt.spec.team }),
    state: rt.state,
    weight_pct: Math.round(taskWeight(rt) * 100),
    ...(rt.percent !== undefined && { reported_pct: rt.percent }),
    ...(rt.agent && { agent: rt.agent }),
    ...(rt.attempt && { attempt: rt.attempt }),
    ...(state.paused_tasks.includes(id) && { paused: true }),
    ...(rt.blocked_by && { blocked_by: rt.blocked_by }),
    ...(rt.last_note && { last_note: oneLine(rt.last_note, full ? 400 : 160) }),
    ...(full && {
      depends_on: rt.spec.depends_on,
      writes: rt.spec.paths.write.slice(0, 10),
      checks: checks.slice(0, 8).map(([k, c]) => ({ command: k.slice(id.length + 1), status: c.status, ...(c.streak > 1 && { streak: c.streak }) })),
      ...(rt.started_at && { started_at: rt.started_at }),
      ...(rt.finished_at && { finished_at: rt.finished_at }),
    }),
  };
}

function escalationLine(e: Escalation, full = false): Json {
  return {
    id: e.id,
    kind: e.kind,
    with: e.with,
    status: e.status,
    ...(e.task && { task: e.task }),
    agent: e.agent,
    ...(e.emergency && { emergency: e.emergency }),
    ...(e.routed_to && { routed_to: e.routed_to }),
    summary: oneLine(e.summary, full ? 600 : 240),
    ...(full && e.question && { question: cap(e.question, 800) }),
    ...(full && e.options?.length && { options: e.options.slice(0, 10).map((o) => oneLine(o, 200)) }),
    ...(e.resolution && { resolution: { action: e.resolution.action, decision: oneLine(e.resolution.decision, 300), by: e.resolution.by } }),
  };
}

function blockers(state: Readonly<BlackboardState>, tasks: readonly TaskRuntime[]): Json[] {
  const ids = new Set(tasks.map((t) => t.spec.id));
  const out: Json[] = [];
  if (state.status === "paused") out.push({ kind: "run_paused" });
  for (const rt of tasks) {
    if (rt.state === "blocked") out.push({ kind: "blocked_task", task: rt.spec.id, ...(rt.blocked_by && { by: rt.blocked_by }) });
    else if (rt.state === "failed") out.push({ kind: "failed_task", task: rt.spec.id });
    else if (state.paused_tasks.includes(rt.spec.id)) out.push({ kind: "paused_task", task: rt.spec.id });
  }
  for (const e of Object.values(state.escalations)) {
    if (!OPEN_ESCALATION.has(e.status) || (e.task && !ids.has(e.task) && tasks.length !== Object.keys(state.tasks).length)) continue;
    if (e.status === "awaiting_human" || e.status === "routed") {
      out.push({ kind: e.status === "awaiting_human" ? "awaiting_human" : "awaiting_orchestrator", escalation: e.id, ...(e.task && { task: e.task }), summary: oneLine(e.summary, 200) });
    }
  }
  return out;
}

function latestChecks(state: Readonly<BlackboardState>, tasks: readonly TaskRuntime[], limit = 6): Json[] {
  const ids = new Set(tasks.map((t) => t.spec.id));
  const all = [
    ...Object.entries(state.checks.task).filter(([k]) => ids.has(k.split("/")[0])).map(([k, c]) => ({ scope: "task", key: k, c })),
    ...Object.entries(state.checks.integration).map(([k, c]) => ({ scope: "integration", key: k, c })),
  ];
  return all
    .sort((x, y) => y.c.at_seq - x.c.at_seq)
    .slice(0, limit)
    .map(({ scope, key, c }) => ({ scope, check: key, status: c.status, at_seq: c.at_seq, ...(c.streak > 1 && { streak: c.streak }), ...(c.signature && { signature: c.signature.slice(0, 16) }) }));
}

function budgetSection(state: Readonly<BlackboardState>, full = false): Json {
  const total = executionBudgetUsd(state as BlackboardState);
  const b = state.budget;
  const top = (m: Record<string, number>, n: number) =>
    Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return {
    spent_usd: Math.round(b.spent_usd * 100) / 100,
    budget_usd: total,
    pct: total > 0 ? Math.round((b.spent_usd / total) * 100) : 0,
    ...(b.estimated && { estimated: true }),
    ...(b.extensions_usd && { extensions_usd: b.extensions_usd }),
    ...(b.thresholds_crossed.length && { thresholds_crossed: b.thresholds_crossed }),
    ...(state.contract && { per_task_usd: state.contract.budget.per_task_usd }),
    by_task: top(b.by_task, full ? 50 : 5),
    ...(full && { by_agent: top(b.by_agent, 50), by_team: top(b.by_team, 50) }),
  };
}

function compactEvent(e: AnyEvent): Json {
  const text = scrub(JSON.stringify(e.payload));
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    source: e.source.id,
    ...(e.correlation && { correlation: e.correlation }),
    payload: text.length > 1200 ? `${text.slice(0, 1200)}…` : JSON.parse(text),
  };
}

// ============================================================================
// The context bundle for a format at the table
// ============================================================================

/**
 * The run as a format at the table needs it. An escalation named by focus (its id) gets WS10's
 * bundle; otherwise the run itself: the contract summary, the focused tasks (or all), interfaces,
 * decisions in force, open escalations, failing checks and recent notes. Built from the blackboard,
 * which holds no chat: the confirmation and the original prompt are left out, and everything is
 * scrubbed of secrets and capped at BUNDLE_LIMIT characters.
 */
export async function runContext(store: FileExecutionStore, state: Readonly<BlackboardState>, focus?: string): Promise<{ escalation?: string; tasks: string[]; text: string }> {
  const esc = focus ? own(state.escalations, focus.trim()) : undefined;
  if (esc) {
    const text = buildContextBundle(state, esc, { diagnostics: await readDiagnostics(store, esc) });
    return { escalation: esc.id, tasks: esc.task ? [esc.task] : [], text };
  }
  const c = state.contract;
  const matched = focus ? matchFocus(state, focus).map((m) => m.task) : [];
  const tasks = (matched.length ? matched : Object.keys(state.tasks)).map((id) => state.tasks[id]);
  const sections: string[] = [];
  if (c) {
    sections.push(
      "## Contract\n\n" +
        [
          `- ${oneLine(c.title, 200)} (\`${c.id}\` v${c.version}); the run is ${state.status}`,
          `- Ultimate goal: ${oneLine(state.goal?.ultimate ?? c.goal.ultimate, 600)}`,
          `- Orchestrator ${c.scope.orchestrator}; lead ${oneLine(c.authority.lead, 120)}, who may ${c.authority.may.join(", ") || "nothing"}`,
          `- Scope: ${c.scope.paths.slice(0, 12).join(", ")}`,
          `- Budget: $${state.budget.spent_usd.toFixed(2)} of $${executionBudgetUsd(state as BlackboardState).toFixed(2)} spent; completion ${completion(state as BlackboardState).percent}%`,
        ].join("\n")
    );
  }
  sections.push(
    `## Tasks${matched.length ? ` matching "${oneLine(focus, 80)}"` : ""}\n\n` +
      tasks.slice(0, 30).map((rt) => {
        const head = `- \`${rt.spec.id}\` (${rt.state}, ${Math.round(taskWeight(rt) * 100)}%${rt.agent ? `, ${rt.agent}` : ""}): ${oneLine(rt.spec.title, 160)}`;
        const more = [`  Writes ${rt.spec.paths.write.slice(0, 6).join(", ") || "nothing"}${rt.spec.depends_on.length ? `; after ${rt.spec.depends_on.join(", ")}` : ""}`];
        if (rt.spec.acceptance.length) more.push(`  Acceptance: ${rt.spec.acceptance.slice(0, 4).map((x) => oneLine(x, 160)).join("; ")}`);
        if (rt.last_note) more.push(`  Last note: ${oneLine(rt.last_note, 240)}`);
        const diff = own(state.diffs, rt.spec.id);
        if (diff?.stat) more.push(`  Changes: ${oneLine(diff.stat, 200)}`);
        return [head, ...more].join("\n");
      }).join("\n")
  );
  const interfaces = Object.entries(state.interfaces).slice(0, 12);
  if (interfaces.length) {
    sections.push(`## Interfaces\n\n${interfaces.map(([name, i]) => `- ${oneLine(name, 80)}: ${i.version > 0 ? `published v${i.version}` : "not published"}${i.spec?.owner ? `, owned by ${i.spec.owner}` : ""}${i.spec?.description ? `: ${oneLine(i.spec.description, 200)}` : ""}`).join("\n")}`);
  }
  if (state.decisions.length) sections.push(`## Decisions in force\n\n${state.decisions.slice(-10).map((d) => `- ${oneLine(d.text, 300)} [${d.scope}, by ${d.by}]`).join("\n")}`);
  const open = Object.values(state.escalations).filter((e) => OPEN_ESCALATION.has(e.status));
  if (open.length) sections.push(`## Open escalations\n\n${open.slice(0, 10).map((e) => `- \`${e.id}\` ${e.kind} (${e.status})${e.task ? ` on \`${e.task}\`` : ""}: ${oneLine(e.summary, 300)}`).join("\n")}`);
  const failing = Object.entries(state.checks.task).filter(([, x]) => x.status === "failed" || x.status === "timed_out");
  if (failing.length) sections.push(`## Failing checks\n\n${failing.slice(0, 10).map(([k, x]) => `- ${k} ${x.status}${x.streak > 1 ? ` ×${x.streak}` : ""}`).join("\n")}`);
  if (state.notes.length) sections.push(`## Recent notes\n\n${state.notes.slice(-8).map((n) => `- ${n.agent} on "${oneLine(n.topic, 80)}": ${oneLine(n.text, 300)}`).join("\n")}`);
  let text = "";
  for (const s of sections) {
    const next = text ? `${text}\n\n${s}` : s;
    if (next.length > BUNDLE_LIMIT) {
      text = `${next.slice(0, BUNDLE_LIMIT - 40).trimEnd()}\n… [context truncated]`;
      break;
    }
    text = next;
  }
  return { tasks: tasks.map((t) => t.spec.id), text: scrub(text).slice(0, BUNDLE_LIMIT) };
}

// ============================================================================
// The reports
// ============================================================================

export interface StatusInput {
  execution_id?: string;
  focus?: string;
  view?: StatusView;
  since_seq?: number;
  limit?: number;
}

/** Every execution, newest first, with its status. */
export async function listExecutionStatus(limit = 20): Promise<Json> {
  const headers = (await listExecutions()).reverse();
  const out: Json[] = [];
  for (const h of headers.slice(0, Math.max(1, Math.min(100, limit)))) {
    try {
      const s = await (await openExecutionStore(h.id)).state();
      out.push({
        execution_id: h.id,
        ...(s.contract && { contract_id: s.contract.id, title: oneLine(s.contract.title, 120) }),
        status: s.status,
        completion_pct: completion(s).percent,
        tasks: Object.keys(s.tasks).length,
        open_escalations: Object.values(s.escalations).filter((e) => OPEN_ESCALATION.has(e.status)).length,
        runner: runnerLiveness(h.id).state,
        created: h.created,
      });
    } catch (e) {
      out.push({ execution_id: h.id, error: cap(errText(e), 200) });
    }
  }
  return {
    executions: out,
    total: headers.length,
    ...(headers.length > out.length && { note: `the ${out.length} newest of ${headers.length}; raise limit for more` }),
    next: out.length ? "execution_status(execution_id) for one run; focus narrows it to what the human asked about." : "No heads-down run yet: propose_contract, freeze_contract, then execute.",
  };
}

/** execution_status with an id (or the list without one). Calls ensureRunner for a live run. */
export async function executionStatusReport(a: StatusInput, now = Date.now()): Promise<Json> {
  if (!a.execution_id) return listExecutionStatus(a.limit);
  const exe = a.execution_id;
  const store = await openExecutionStore(exe);
  const warnings: string[] = [];
  let ensured: string | undefined;
  const before = await store.state();
  if (before.status === "running" || before.status === "paused") {
    try {
      ensured = (await orchestratorDeps().ensureRunner(exe)).status;
    } catch (e) {
      warnings.push(`runner: ${cap(errText(e), 300)}`);
    }
  }
  const state = await store.state();
  const view: StatusView = a.view ?? "summary";
  const focus = a.focus?.trim() || undefined;
  const matches = focus ? matchFocus(state, focus) : [];
  const focused = focus ? matches.map((m) => state.tasks[m.task]) : Object.values(state.tasks);
  if (focus && !matches.length && !own(state.escalations, focus)) warnings.push(`Nothing in the run matches "${oneLine(focus, 80)}"; showing the whole run.`);
  const scope = focus && matches.length ? focused : Object.values(state.tasks);
  const head: Json = {
    execution_id: exe,
    status: state.status,
    seq: state.seq,
    ...(state.contract && { contract: { id: state.contract.id, version: state.contract.version, title: oneLine(state.contract.title, 200) } }),
    ...(focus && { focus: { query: oneLine(focus, 200), matches: matches.slice(0, 20) } }),
  };
  const limit = Math.max(1, Math.min(200, a.limit ?? 50));

  switch (view) {
    case "tasks":
      return { ...head, view, tasks: scope.slice(0, limit).map((rt) => taskLine(state, rt, true)), warnings };
    case "escalations": {
      const list = Object.values(state.escalations)
        .filter((e) => !focus || !matches.length || !e.task || matches.some((m) => m.task === e.task))
        .sort((x, y) => Number(OPEN_ESCALATION.has(y.status)) - Number(OPEN_ESCALATION.has(x.status)) || y.raised_seq - x.raised_seq);
      return {
        ...head, view,
        open: list.filter((e) => OPEN_ESCALATION.has(e.status)).length,
        escalations: list.slice(0, limit).map((e) => escalationLine(e, true)),
        warnings,
        next: "resolve_escalation(execution_id, escalation_id, action) answers one: decide, huddle (with a format), retry, reassign, amend, dismiss or await_human.",
      };
    }
    case "events": {
      const since = a.since_seq ?? Math.max(0, state.seq - limit);
      const ids = new Set(scope.map((t) => t.spec.id));
      let events = await store.events({ sinceSeq: since, ...(focus && matches.length ? {} : { limit }) });
      if (focus && matches.length) events = events.filter((e) => ids.has(String((e.payload as { task?: unknown }).task ?? e.source.task ?? ""))).slice(0, limit);
      return { ...head, view, since_seq: since, events: events.map(compactEvent), warnings, ...(events.length && { next_since_seq: events[events.length - 1].seq }) };
    }
    case "budget":
      return { ...head, view, budget: budgetSection(state, true), warnings };
    case "context": {
      const ctx = await runContext(store, state, focus);
      return {
        ...head, view,
        ...(ctx.escalation && { escalation: ctx.escalation }),
        tasks: ctx.tasks,
        context: ctx.text,
        warnings,
        next:
          "Pass context to the format you run at the table (start_collaboration, start_meeting, start_ultraplan ...). Pause first with control_execution(action: \"pause\", to_table: true); " +
          "afterwards amend_contract(from_session) and control_execution(action: \"resume\", to_table: true), or resolve_escalation(action: \"decide\") for an escalation.",
      };
    }
    default: {
      const started = await startedPayload(store);
      const health = runnerHealth(exe, now);
      if (ensured === "launched") health.restarted = true;
      const url = dashboardUrl(exe);
      const open = Object.values(state.escalations).filter((e) => OPEN_ESCALATION.has(e.status));
      const orchestrator = state.contract?.scope.orchestrator;
      const watch = TERMINAL.has(state.status) || state.status === "created" ? undefined : watchers(exe, orchestrator);
      const next: string[] = [];
      if (state.status === "created") next.push("The run has not started: execute it when the human says so.");
      if (orchestrator && watch && !(watch[orchestrator] as { alive?: boolean } | undefined)?.alive) {
        next.push(`Your watcher is not running: start \`agent-roundtable watch ${exe} --as ${orchestrator}\` in the background (execute returned its exact command).`);
      }
      if (open.some((e) => e.status === "awaiting_human")) next.push("Something awaits the human: view \"escalations\" has the question; ask them, then resolve_escalation.");
      else if (open.some((e) => e.status === "routed" && e.routed_to === orchestrator)) next.push("An escalation is routed to you: view \"escalations\", then resolve_escalation.");
      return {
        ...head,
        completion_pct: focus && matches.length ? weightedCompletion(scope) : completion(state).percent,
        ...(focus && matches.length && { run_completion_pct: completion(state).percent }),
        tasks: {
          total: scope.length,
          by_state: scope.reduce<Record<string, number>>((m, rt) => ((m[rt.state] = (m[rt.state] ?? 0) + 1), m), {}),
          ...(scope.length <= 12 && { list: scope.map((rt) => taskLine(state, rt)) }),
        },
        blockers: blockers(state, scope),
        latest_checks: latestChecks(state, scope),
        eta: estimateEta(state, scope, now),
        budget: budgetSection(state),
        escalations: { open: open.length, awaiting_human: open.filter((e) => e.status === "awaiting_human").length, list: open.slice(0, 5).map((e) => escalationLine(e)) },
        runner: health,
        dashboard: { requested: started?.visibility?.dashboard === true, ...(url && { url }) },
        ...(started?.visibility?.github && { github: githubHealth(exe, state, started.visibility) }),
        ...(watch && { watchers: watch }),
        warnings,
        ...(next.length && { next }),
      };
    }
  }
}
