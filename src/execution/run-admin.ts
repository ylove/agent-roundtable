// ============================================================================
// Run administration for the CLI: status, verify and purge
//
//   status <exe> [--json]   the run at a glance: tasks, completion, budget, escalations, runner, watchers
//   verify <exe>            the event chain (verifyExecution) and the global audit chain (verifyAudit)
//   purge <exe> --confirm   terminal runs only: removes the worktrees, the rt/<tag>/* branches and the
//                           execution directory; audited. Never touches the base branch.
// ============================================================================

import { existsSync, rmSync } from "node:fs";
import { completion } from "../dashboard/render.js";
import { appendAudit, verifyAudit, type AuditVerifyResult } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { executionBudgetUsd } from "./budget.js";
import { runnerLiveness, type RunnerLiveness } from "./runner-launch.js";
import { reconcileLaunch } from "../workers/launch-intent.js";
import { agentDir, removeWorkerMcpConfig } from "../workers/files.js";
import { join } from "node:path";
import { acquireLock, processMatches, LockTimeoutError } from "./lock.js";
import { executionDir, openExecutionStore } from "./store.js";
import type { BlackboardState, EventSource, ExecutionStore, TaskState } from "./types.js";
import { verifyExecution, type VerifyResult } from "./verify.js";
import { watcherObservations } from "./watch.js";
import { executionWorktreesDir, pruneWorktrees } from "./worktrees.js";

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const OPEN_ESCALATION = new Set(["open", "routed", "in_huddle", "awaiting_human"]);

const cap = (s: string | undefined, n: number) => {
  const t = scrub((s ?? "").trim());
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ============================================================================
// stopping a run's workers
// ============================================================================

/**
 * Stop every runner-launched worker of a run that is still ours by start-time identity: adopt a
 * published launch first, record workers already gone as lost, then stop each live group. Used by
 * abort and by a runner that starts on an aborted run, so an abort interrupted before its workers
 * stopped never leaves them running (purge refuses while they do). `recordExit` records each
 * stopped worker as killed; only a caller that holds the runner lock passes it, so a live runner
 * never sees a second exit.
 */
export async function stopLiveWorkers(
  store: ExecutionStore,
  exe: string,
  source: EventSource,
  stop: (pgid: number, graceMs: number, started?: string) => Promise<void>,
  graceMs: number,
  recordExit = false,
): Promise<{ stopped: string[]; warnings: string[] }> {
  for (const x of Object.values((await store.state()).agents)) {
    if (x.external || !["registered", "running"].includes(x.status)) continue;
    const launch = await reconcileLaunch(join(agentDir(exe, x.id), "launch.json"));
    if (launch && processMatches(launch.pid, launch.started)) {
      await store.transact(() => ({ events: [{ type: "agent.spawned", source, payload: {
        agent: x.id, task: launch.task, attempt: launch.attempt, pid: launch.pid, started: launch.started,
      } }] }));
    }
  }
  const after = await store.state();
  const live = Object.values(after.agents).filter((x) => !x.external && x.status === "running" && x.pid !== undefined && x.pid > 1 && processMatches(x.pid, x.started));
  const gone = Object.values(after.agents).filter((x) => !x.external && x.status === "running" && !live.includes(x));
  for (const x of gone) removeWorkerMcpConfig(exe, x.id);
  if (gone.length) await store.transact(() => ({ events: gone.map((x) => ({
    type: "agent.exited" as const, source, payload: { agent: x.id, ...(x.task && { task: x.task }), code: null, reason: "lost" as const },
  })) }));
  const stopped: string[] = [];
  const warnings: string[] = [];
  await Promise.all(live.map(async (x) => {
    try {
      await stop(x.pid!, graceMs, x.started);
      if (!processMatches(x.pid!, x.started)) removeWorkerMcpConfig(exe, x.id);
      stopped.push(x.id);
    } catch (e) {
      warnings.push(`could not stop ${x.id} (pid ${x.pid}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
  const killed = live.filter((x) => stopped.includes(x.id));
  if (recordExit && killed.length) await store.transact(() => ({ events: killed.map((x) => ({
    type: "agent.exited" as const, source, payload: { agent: x.id, ...(x.task && { task: x.task }), code: null, reason: "killed" as const },
  })) }));
  return { stopped: stopped.sort(), warnings };
}

// ============================================================================
// status
// ============================================================================

export interface ExecutionStatusReport {
  execution: string;
  status: BlackboardState["status"];
  seq: number;
  contract?: { id: string; version: number; title: string };
  /** Weighted completion (heads-down.md §13), 0–100. */
  completion_pct: number;
  tasks: {
    total: number;
    by_state: Partial<Record<TaskState, number>>;
    list: Array<{ id: string; state: TaskState; attempt: number; agent?: string; percent?: number; note?: string }>;
  };
  paused_tasks: string[];
  budget: { spent_usd: number; budget_usd: number; pct: number; estimated: boolean };
  escalations: { open: number; awaiting_human: number; list: Array<{ id: string; kind: string; status: string; task?: string; summary: string }> };
  runner: RunnerLiveness;
  watchers: Record<string, { alive: boolean; last_seen_at?: string }>;
}

export async function executionStatus(exe: string): Promise<ExecutionStatusReport> {
  const store = await openExecutionStore(exe);
  const s = await store.state();
  const comp = completion(s);
  const total = executionBudgetUsd(s);
  const open = Object.values(s.escalations).filter((e) => OPEN_ESCALATION.has(e.status));
  const watchers: ExecutionStatusReport["watchers"] = {};
  for (const [name, w] of Object.entries(watcherObservations(exe))) {
    watchers[name] = { alive: w.alive, ...(w.lastSeenAt !== undefined && { last_seen_at: new Date(w.lastSeenAt).toISOString() }) };
  }
  return {
    execution: exe,
    status: s.status,
    seq: s.seq,
    ...(s.contract && { contract: { id: s.contract.id, version: s.contract.version, title: cap(s.contract.title, 200) } }),
    completion_pct: comp.percent,
    tasks: {
      total: Object.keys(s.tasks).length,
      by_state: comp.byState,
      list: Object.values(s.tasks).map((rt) => ({
        id: rt.spec.id,
        state: rt.state,
        attempt: rt.attempt,
        ...(rt.agent && { agent: rt.agent }),
        ...(rt.percent !== undefined && { percent: rt.percent }),
        ...(rt.last_note && { note: cap(rt.last_note, 200) }),
      })),
    },
    paused_tasks: [...s.paused_tasks],
    budget: { spent_usd: s.budget.spent_usd, budget_usd: total, pct: total > 0 ? Math.round((s.budget.spent_usd / total) * 100) : 0, estimated: s.budget.estimated },
    escalations: {
      open: open.length,
      awaiting_human: open.filter((e) => e.status === "awaiting_human").length,
      list: open.map((e) => ({ id: e.id, kind: e.kind, status: e.status, ...(e.task && { task: e.task }), summary: cap(e.summary, 300) })),
    },
    runner: runnerLiveness(exe),
    watchers,
  };
}

function describeRunner(r: RunnerLiveness): string {
  switch (r.state) {
    case "running":
      return `running (pid ${r.pid}${r.heartbeatAt ? `, heartbeat ${r.heartbeatAt}` : ""}${r.stale ? ", STALE" : ""})`;
    case "stopped":
      return r.pid ? `stopped (pid ${r.pid}${r.reason ? `: ${r.reason}` : ""})` : "never started";
    case "dead":
      return `dead (pid ${r.pid} is gone; the next orchestrator call restarts it)`;
    case "other_host":
      return `held by host ${r.host} (pid ${r.pid})`;
  }
}

/** The human-readable status. */
export function formatStatus(r: ExecutionStatusReport): string {
  const lines = [
    `Execution ${r.execution}: ${r.status} (seq ${r.seq})`,
    r.contract ? `Contract ${r.contract.id} v${r.contract.version}: ${r.contract.title}` : "No frozen contract yet",
    `Completion ${r.completion_pct}% · ${r.tasks.total} tasks · ${Object.entries(r.tasks.by_state).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`,
    `Budget $${r.budget.spent_usd.toFixed(2)} of $${r.budget.budget_usd.toFixed(2)} (${r.budget.pct}%${r.budget.estimated ? ", partly estimated" : ""})`,
    `Runner ${describeRunner(r.runner)}`,
  ];
  const w = Object.entries(r.watchers);
  if (w.length) lines.push(`Watchers ${w.map(([n, x]) => `${n} ${x.alive ? "alive" : "not running"}`).join(", ")}`);
  if (r.paused_tasks.length) lines.push(`Paused tasks: ${r.paused_tasks.join(", ")}`);
  lines.push("", "Tasks:");
  for (const t of r.tasks.list) {
    lines.push(`  ${t.id.padEnd(24)} ${t.state.padEnd(12)}${t.attempt ? ` attempt ${t.attempt}` : ""}${t.percent !== undefined ? ` ${t.percent}%` : ""}${t.agent ? ` (${t.agent})` : ""}`);
  }
  if (r.escalations.list.length) {
    lines.push("", `Escalations (${r.escalations.open} open, ${r.escalations.awaiting_human} awaiting the human):`);
    for (const e of r.escalations.list) lines.push(`  ${e.id} ${e.kind}/${e.status}${e.task ? ` on ${e.task}` : ""}: ${e.summary}`);
  }
  return lines.join("\n");
}

// ============================================================================
// verify
// ============================================================================

export interface VerifyReport {
  ok: boolean;
  execution: string;
  events: VerifyResult;
  audit: AuditVerifyResult;
}

export async function verifyRun(exe: string): Promise<VerifyReport> {
  executionDir(exe); // validates the id
  const events = await verifyExecution(exe);
  const audit = await verifyAudit();
  return { ok: events.ok && audit.ok, execution: exe, events, audit };
}

export function formatVerify(r: VerifyReport): string {
  const ev = r.events.ok ? `ok (${r.events.seq} events)` : `FAILED at seq ${r.events.badSeq}: ${r.events.reason}`;
  const au = r.audit.ok ? `ok (${r.audit.entries} entries in ${r.audit.files} files)` : `FAILED${r.audit.badFile ? ` in ${r.audit.badFile}${r.audit.badLine ? ` line ${r.audit.badLine}` : ""}` : ""}: ${r.audit.reason}`;
  return `Event chain of ${r.execution}: ${ev}\nAudit chain: ${au}`;
}

// ============================================================================
// purge
// ============================================================================

export class PurgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurgeRefusal";
  }
}

export interface PurgeResult {
  execution: string;
  status: string;
  worktrees: string[];
  branches: string[];
  removedDir: string;
}

/**
 * Remove a finished run: its worktrees, its rt/<tag>/* branches and its execution directory. Refused
 * without confirm, for a run that is not completed, failed or aborted, and while a runner holds it.
 * Audited as execution.purged.
 */
export async function purgeExecution(exe: string, opts: { confirm: boolean; actor?: string }): Promise<PurgeResult> {
  const dir = executionDir(exe);
  if (!existsSync(dir)) throw new PurgeRefusal(`Execution ${exe} not found`);
  if (opts.confirm !== true) throw new PurgeRefusal("purge deletes the run's worktrees, branches and log: pass --confirm");
  const live = runnerLiveness(exe);
  if (live.state === "running" || live.state === "other_host") throw new PurgeRefusal(`A runner (pid ${live.pid}) still holds ${exe}; wait for it to stop`);
  let release;
  try {
    release = await acquireLock(`${dir}/runner.lock`, { staleMs: 30_000, timeoutMs: 0 });
  } catch (e) {
    if (e instanceof LockTimeoutError) throw new PurgeRefusal(`A runner still holds ${exe}; wait for it to stop`);
    throw e;
  }
  try {
    const store = await openExecutionStore(exe);
    const state = await store.state();
    if (!TERMINAL.has(state.status)) throw new PurgeRefusal(`Execution ${exe} is ${state.status}; only completed, failed or aborted runs can be purged`);
    for (const a of Object.values(state.agents)) {
      if (a.external) continue;
      const launch = await reconcileLaunch(join(agentDir(exe, a.id), "launch.json"));
      if (launch === undefined || launch || (a.pid !== undefined && processMatches(a.pid, a.started))) {
        throw new PurgeRefusal(`Workers still run in ${exe}; stop them before purging their worktrees (\`agent-roundtable run ${exe}\` stops the workers of an aborted run)`);
      }
    }
    const repoMissing = !existsSync(store.header().repo_root);
    const pruned = repoMissing ? { removed: [], branches: [] } : await pruneWorktrees(store.header(), { remove: true, branches: true });
    if (repoMissing) rmSync(executionWorktreesDir(exe), { recursive: true, force: true });
    const result: PurgeResult = { execution: exe, status: state.status, worktrees: pruned.removed, branches: pruned.branches, removedDir: dir };
    await appendAudit({
      actor: opts.actor ?? "human",
      action: "execution.purged",
      target: exe,
      details: { status: state.status, worktrees: pruned.removed.length, branches: pruned.branches, repo_root: store.header().repo_root, ...(repoMissing && { repo_missing: true }) },
    });
    rmSync(dir, { recursive: true, force: true });
    return result;
  } finally {
    release();
  }
}
