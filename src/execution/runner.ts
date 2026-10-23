// ============================================================================
// The runner: `agent-roundtable run <exe>` (heads-down.md §2, §3, §10, §11)
//
// One runner holds an execution at a time (runner.lock, never taken from a live pid). It starts
// the workers, tails their output, applies the watchdog, merges finished tasks into the
// integration branch, runs the integration checks and completes the run. It keeps no state the
// event log does not: a runner that dies is replaced by one that verifies the chain, replays the
// log, adopts the workers whose pids still live and resumes the ones that died.
//
// A tick (every 1–2 s):
//   1. catch up on the log (and rewrite leases.json for every lease the new events changed);
//   2. stop the workers a person asked to stop (agent.stop_requested), then poll each live worker's
//      RunMonitor and append its drafts (agent.attested, budget.usage_recorded, agent.exited); a
//      failed attestation kills the worker and escalates; a stopped worker's exit is settled with
//      agent.stopped and an escalation to the orchestrator (usage-visibility.md §6);
//   3. evaluate the watchdog inside transact, append its drafts, then perform its process
//      operations after the commit (every one idempotent; standing ones repeat each pass);
//   4. hand new open escalations to the escalation router (a WS10 hook);
//   5. schedule ready tasks up to max_parallel (paused tasks and runs, the respawn gate, budget
//      and circuits respected);
//   6. feed the merge queue (runner-merge.ts) and check for the end of the run;
//   7. a snapshot every 500 events or 60 s (the runner is the only snapshot writer).
// Slow work (git, the sandbox, hooks that call models) never runs inside transact.
// ============================================================================

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_IDS, VERSION } from "../config.js";
import { executionTag } from "../ids.js";
import { executionLLM, seedExecutionProvider } from "./provider-routing.js";
import { loadAgent } from "../agents.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { DockerBackend, LocalBackend, SANDBOX_ENV, selectBackend } from "../sandbox/index.js";
import { localSandboxAllowed } from "../sandbox/common.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { scrub, scrubAndCap } from "../security/secrets.js";
import { ClaudeCodeDriver, WORKER_ATTESTATION } from "../workers/claude-code.js";
import { CodexDriver } from "../workers/codex.js";
import { agentDir, writeAgentLeases, prepareWorkerFiles, removeWorkerMcpConfig, registerWorkerSecrets } from "../workers/files.js";
import { RunMonitor, type ExitReason, type MonitorCheckpoint } from "../workers/monitor.js";
import { reconcileLaunch } from "../workers/launch-intent.js";
import { stopGroup, workerExit, type WorkerExit } from "../workers/process.js";
import { autoFindings } from "../postmortem/auto.js";
import { cardLessons } from "../postmortem/lessons.js";
import { scrubbedJSON } from "./blobs.js";
import { remainingUsd } from "./budget.js";
import { classifyFailure } from "./circuit.js";
import { createRunnerHooks } from "./escalation.js";
import { stopMicroHuddles } from "./huddle.js";
import { integrationBranch, SubmodulesUnsupportedError } from "./git.js";
import { acknowledgeHandoff, takeHandoffs } from "./handoff.js";
import { decideLeaseRequest, leaseDrafts, leasesFor } from "./leases.js";
import { acquireLock, LockTimeoutError, processMatches, processStart, readLockOwner, type LockRelease } from "./lock.js";
import { MergeQueue } from "./runner-merge.js";
import { stopLiveWorkers } from "./run-admin.js";
import {
  newRunnerInfo,
  readRunnerInfo,
  RUNNER_HEARTBEAT_MS,
  runnerLockDir,
  writeRunnerInfo,
  type RunnerInfo,
} from "./runner-launch.js";
import { runnerEscalation, runnerEscalationId, withDefaults, type ProcessOp, type RunnerContext, type RunnerEscalationSpec, type RunnerHooks } from "./runner-hooks.js";
import { executionDir, openExecutionStore, type FileExecutionStore } from "./store.js";
import { buildTaskCard, interruptedContext, respawnContext, type Immediate, type TaskCardOptions } from "./task-card.js";
import type {
  AnyEvent,
  AnyEventDraft,
  BlackboardState,
  EventPayloads,
  EventSource,
  ExecutionHeader,
  SandboxBackend,
  Visibility,
  WorkerDriver,
  WorkerDriverId,
  WorkerLaunch,
  WorkerRecord,
} from "./types.js";
import { verifyExecution } from "./verify.js";
import { watcherObservations } from "./watch.js";
import {
  actionsToDrafts,
  canRespawn,
  evaluate,
  observeEvents,
  processActions,
  type AgentObservation,
  type Observations,
  type ProcessAction,
  type WatchdogAction,
  type WatchdogConfig,
} from "./watchdog.js";
import { ensureIntegrationWorktree, taskDiffSummary, taskStartPoint, ensureTaskWorktree, snapshotWip, taskWorktreePath } from "./worktrees.js";
import { startDashboard, type Dashboard } from "../dashboard/server.js";
import { taskHeld, blockingIds } from "./task-holds.js";
import { GitHubSync } from "../github/sync.js";

// ============================================================================
// Options
// ============================================================================

export interface RunnerOptions {
  /**
   * WS10's escalation router, lead fallback, goal review and escalation pass. runRunner installs
   * createRunnerHooks (persona calls per ROUNDTABLE_EXECUTION_*); a Runner built without them uses
   * DEFAULT_HOOKS, which only log and review COMPLETE (tests).
   */
  hooks?: Partial<RunnerHooks>;
  /** Worker drivers by id (default ClaudeCodeDriver and CodexDriver). */
  drivers?: Partial<Record<WorkerDriverId, WorkerDriver>>;
  /** First pause before a failed escalation route is retried; doubles per attempt (default 30 s). */
  routeRetryBaseMs?: number;
  /** Tick interval (default 1500 ms). */
  tickMs?: number;
  heartbeatMs?: number;
  watchdog?: Partial<WatchdogConfig>;
  /** Exit this long after the run was paused (default 6 h). */
  idleExitMs?: number;
  /** How long a second runner waits for runner.lock before it refuses (default 3 s). */
  lockTimeoutMs?: number;
  /** Stop on SIGTERM and SIGINT (the CLI; default false). */
  signals?: boolean;
  /** GitHub sync interval (default 12 s). */
  githubSyncMs?: number;
  /** Command ids run on the integration branch after each merge (default ROUNDTABLE_SMOKE_CHECKS, else validation.final). */
  integrationChecks?: string[];
  /** How long a worker may keep running after its task merged before it is stopped (default 60 s). */
  mergeGraceMs?: number;
  /** A sandbox backend for the runner's own checks (tests). */
  sandbox?: SandboxBackend;
}

const HOUR = 3_600_000;
/** The escalation pass runs at least this often (and whenever the log moved). */
const PASS_MS = 5_000;
const SNAPSHOT_EVENTS = 500;
const SNAPSHOT_MS = 60_000;
const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
/** As control_execution abort: the CLI's time to stop before its group is killed. */
const ABORT_STOP_GRACE_MS = 5_000;
const ROUTE_RETRY_BASE_MS = 30_000;
const ROUTE_MAX_ATTEMPTS = 5;
const OPEN_ESCALATION: ReadonlySet<string> = new Set(["open", "routed", "in_huddle", "awaiting_human"]);
const ACTIVE_TASK: ReadonlySet<string> = new Set(["claimed", "in_progress", "submitted", "checking"]);
const SESSION_GONE_RE = /no conversation found|session(?: id)?[^\n]{0,80}\bnot found|could not (?:find|resume) (?:the )?session/i;

/** The runner refused to start: another runner holds the execution, or the chain does not verify. */
export class RunnerRefusal extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "RunnerRefusal";
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
const own = <T>(rec: Readonly<Record<string, T>> | undefined, key: string | undefined): T | undefined =>
  rec !== undefined && key !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

/** The runner's agent id for a task: w-<task>, shortened with a hash when that would pass 64 characters. */
export function workerAgentId(task: string): string {
  const id = `w-${task}`;
  if (id.length <= 64) return id;
  let h = 0;
  for (const c of task) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `w-${task.slice(0, 52)}-${h.toString(36).padStart(7, "0").slice(0, 7)}`;
}

// ============================================================================
// agents/<id>/run.json: what an adopting runner needs to keep tailing a live worker
// ============================================================================

export interface RunFile {
  v: 1;
  agent: string;
  task: string;
  attempt: number;
  driver: WorkerDriverId;
  pid: number;
  pgid: number;
  started?: string;
  /** The session the run was started with (claude-code), or the thread id the stream reported (codex). */
  session_id: string;
  output: string;
  cwd: string;
  /** Byte offset in output just past the last line this runner consumed and committed. */
  offset: number;
  /** Where this run's output starts in the file (resumes append to the same file). */
  start_offset: number;
  started_at: string;
  resumed: boolean;
  /** agent.attested's ok, once seen. */
  attested?: boolean;
  monitor?: MonitorCheckpoint;
}

const runFilePath = (exe: string, agent: string) => join(agentDir(exe, agent), "run.json");

export function readRunFile(exe: string, agent: string): RunFile | null {
  try {
    const r = JSON.parse(readFileSync(runFilePath(exe, agent), "utf8")) as RunFile;
    return r && r.v === 1 && Number.isSafeInteger(r.pid) && Number.isSafeInteger(r.offset) ? r : null;
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The last `max` bytes of a file from `from` on, as text. */
function readTail(path: string, from: number, max = 4096): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - max);
    if (start >= size) return "";
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Live workers
// ============================================================================

interface Tracked {
  agent: string;
  task: string;
  attempt: number;
  driver: WorkerDriverId;
  pid: number;
  pgid: number;
  started?: string;
  sessionId: string;
  outputPath: string;
  cwd: string;
  startOffset: number;
  startedAt: number;
  lastOutputAt?: number;
  monitor: RunMonitor;
  /** Set once the process is known to have exited. */
  exit?: WorkerExit;
  adopted: boolean;
  resumed: boolean;
  /** Why the runner stopped it (overrides the inferred exit reason). */
  killReason?: ExitReason;
  attested?: boolean;
  /** For an adopted run: drafts the previous runner already committed. */
  skip?: { attested: boolean; usage: boolean };
  /** Stop it at this time (its task merged and it has not exited). */
  retireAt?: number;
}

export interface StartOptions {
  /** Claim a ready task (scheduler, spawn_retry) rather than continue a task this agent holds. */
  claim: boolean;
  attempt?: number;
  /** "continue" (default) resumes the previous session when one is known; "new" starts fresh. */
  session?: "continue" | "new";
  immediate?: Immediate;
  /** Committed with the registration (the previous run's agent.exited): exit and re-registration in one transaction. */
  preDrafts?: AnyEventDraft[];
  /** For the default card context of a respawn. */
  why?: string;
  /** The task may still be submitted, checking or merging: preDrafts move it back to in_progress (a merge conflict). */
  reopen?: boolean;
}

// ============================================================================
// The runner
// ============================================================================

export class Runner {
  readonly execution: string;
  readonly source: EventSource;
  store!: FileExecutionStore;
  header!: ExecutionHeader;
  readonly hooks: RunnerHooks;
  readonly ctx: RunnerContext;

  private readonly opts: Required<Pick<RunnerOptions, "tickMs" | "heartbeatMs" | "idleExitMs" | "lockTimeoutMs" | "githubSyncMs" | "mergeGraceMs">> & RunnerOptions;
  private readonly drivers: Partial<Record<WorkerDriverId, WorkerDriver>>;
  private lock?: LockRelease;
  private info?: RunnerInfo;
  private heartbeat?: NodeJS.Timeout;
  private stopping?: string;
  private closed = false;
  private wake?: () => void;
  private startedAt = Date.now();

  /** The log, cached and extended every tick (observeEvents folds over it). */
  private log: AnyEvent[] = [];
  private readonly workers = new Map<string, Tracked>();
  /** Agents with a kill, resume or spawn in flight. */
  private readonly busy = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly trialReservations = new Set<string>();
  readonly abort = new AbortController();
  /** Non-standing process operations already performed by this process. */
  private readonly opsDone = new Set<string>();
  /** Stop requests (agent.stop_requested event ids) this process has applied. */
  private readonly stopApplied = new Set<string>();
  private readonly routed = new Set<string>();
  /** A failed route (for example no healthy provider) is offered again after a pause, not on every tick. */
  private readonly routeRetryAt = new Map<string, number>();
  private readonly routeAttempts = new Map<string, number>();
  private readonly leadInFlight = new Set<string>();
  /** The hooks' escalation pass: one at a time, when the log moved or every PASS_MS. */
  private passInFlight = false;
  private passSeq = -1;
  private passAt = 0;
  private readonly pending = new Set<Promise<unknown>>();
  /** Claims present at startup: their TTLs restart now (heads-down.md §3). */
  private readonly renewed: Record<string, { renewedAt: number }> = {};
  private spawnBlocked = false;
  private snapSeq = 0;
  /** The last event seq the postmortem pass has scanned (docs/design/postmortem.md §4). */
  private pmScanned = 0;
  private snapAt = Date.now();
  private sandboxP?: Promise<SandboxBackend>;
  private driverChecked?: Promise<{ ok: boolean; missing: string[] }>;
  private driverCheckedId?: WorkerDriverId;
  private merge!: MergeQueue;
  private dashboard?: Dashboard;
  private github?: GitHubSync;
  private githubTimer?: NodeJS.Timeout;
  private exitCode = 0;

  constructor(execution: string, opts: RunnerOptions = {}) {
    executionDir(execution); // validates the id
    this.execution = execution;
    this.source = { kind: "runner", id: "runner", pid: process.pid };
    this.opts = {
      tickMs: 1500,
      heartbeatMs: RUNNER_HEARTBEAT_MS,
      idleExitMs: 6 * HOUR,
      lockTimeoutMs: 3000,
      githubSyncMs: 12_000,
      mergeGraceMs: 60_000,
      ...opts,
    };
    this.hooks = withDefaults(opts.hooks);
    this.drivers = { "claude-code": new ClaudeCodeDriver(), codex: new CodexDriver(), ...opts.drivers };
    const self = this;
    this.ctx = {
      execution,
      get store() {
        return self.store;
      },
      get header() {
        return self.header;
      },
      source: this.source,
      log: (m) => this.say(m),
      resumeTask: (task, immediate) => this.resumeTask(task, immediate),
      worker: (agent) => this.workerRecord(agent),
      driver: () => this.driver(),
    };
  }

  say(message: string): void {
    console.error(`[Runner ${new Date().toISOString()}] ${scrubAndCap(message, 2000)}`);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Take runner.lock, verify the chain, load the store, record runner.started (and
   * runner.takeover after a crash), ensure the integration worktree, reconcile the workers and
   * start the dashboard and the GitHub sync. Throws RunnerRefusal when another runner holds the
   * run or the chain does not verify (nothing is emitted then).
   */
  async start(): Promise<void> {
    const dir = executionDir(this.execution);
    if (!existsSync(join(dir, "execution.json"))) throw new RunnerRefusal(`Execution ${this.execution} not found`);
    const previous = readRunnerInfo(this.execution);
    try {
      this.lock = await acquireLock(runnerLockDir(this.execution), { staleMs: 30_000, timeoutMs: this.opts.lockTimeoutMs });
    } catch (e) {
      if (e instanceof LockTimeoutError) {
        const o = readLockOwner(runnerLockDir(this.execution));
        throw new RunnerRefusal(`Another runner${o ? ` (pid ${o.pid} on ${o.host})` : ""} holds ${this.execution}; a live runner is never replaced`);
      }
      throw e;
    }
    try {
      const v = await verifyExecution(this.execution);
      if (!v.ok) throw new RunnerRefusal(`The event chain of ${this.execution} does not verify (seq ${v.badSeq}: ${v.reason}); not running it`);
      this.store = await openExecutionStore(this.execution);
      this.header = this.store.header();
      this.info = newRunnerInfo();
      writeRunnerInfo(this.execution, this.info);
      this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeatMs);
      this.merge = new MergeQueue(this);
      await this.refreshLog();
      const state = await this.store.state();
      this.snapSeq = state.seq;
      this.contractConnectors = state.contract?.connectors;
      this.driverId = state.contract?.workers.driver === "codex" ? "codex" : "claude-code";
      if (TERMINAL_RUN.has(state.status)) {
        if (state.status === "failed") this.exitCode = 1;
        // An abort interrupted before its workers stopped (both the tool and the previous runner
        // gone) would otherwise leave them running, and purge refuses while they do.
        if (state.status === "aborted") {
          const { stopped, warnings } = await stopLiveWorkers(this.store, this.execution, this.source, stopGroup, ABORT_STOP_GRACE_MS, true);
          if (stopped.length) this.say(`stopped ${stopped.length} worker(s) still running after the abort: ${stopped.join(", ")}`);
          for (const w of warnings) this.say(w);
        }
        if (state.status === "completed" && this.githubSettings()?.pr) {
          await this.startVisibility();
          const completed = [...this.log].reverse().find((e) => e.type === "execution.completed");
          if (completed?.type === "execution.completed") await this.merge.publishCompleted(state, completed.payload.integration_sha);
        }
        this.say(`${this.execution} is already ${state.status}; nothing to run`);
        this.stopping = state.status;
        return;
      }
      const takeover = previous && !previous.stoppedAt && previous.pid !== process.pid;
      await this.commit([
        ...(takeover ? [{ type: "runner.takeover", source: this.source, payload: { previous_pid: previous.pid } } as AnyEventDraft] : []),
        { type: "runner.started", source: this.source, payload: { pid: process.pid, version: VERSION } },
      ]);
      this.say(`runner ${process.pid} started on ${this.execution}${takeover ? ` (took over from pid ${previous!.pid})` : ""}`);
      try {
        await ensureIntegrationWorktree(this.header);
      } catch (e) {
        if (e instanceof SubmodulesUnsupportedError) {
          await this.commit([{ type: "execution.failed", source: this.source, payload: { reason: e.message } }]);
          this.say(`${e.message}: the run failed`);
          this.stopping = "failed";
          this.exitCode = 1;
          return;
        }
        throw e;
      }
      for (const task of Object.keys((await this.store.state()).claims)) this.renewed[task] = { renewedAt: Date.now() };
      await this.reconcile();
      await this.startVisibility();
    } catch (e) {
      await this.release();
      throw e;
    }
  }

  /** Tick until the run ends, a signal arrives, or the idle limit passes. Returns the exit code. */
  async run(): Promise<number> {
    const onSignal = (sig: string) => this.stop(`signal ${sig}`);
    if (this.opts.signals) {
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    }
    try {
      while (!this.stopping) {
        try {
          await this.tick();
        } catch (e) {
          this.say(`tick failed: ${errText(e)}`);
        }
        if (this.stopping) break;
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.opts.tickMs);
          this.wake = () => {
            clearTimeout(t);
            r();
          };
        });
      }
    } finally {
      if (this.opts.signals) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      await this.shutdown(this.stopping ?? "stopped");
    }
    return this.exitCode;
  }

  /** Stop scheduling and leave the loop. Workers keep running (they are detached); a new runner adopts them. */
  stop(reason: string): void {
    if (this.stopping) return;
    this.stopping = reason;
    this.abort.abort();
    this.say(`stopping: ${reason}`);
    this.wake?.();
  }

  isStopping(): boolean {
    return this.stopping !== undefined;
  }

  private beat(): void {
    if (!this.info) return;
    if (this.lock && !this.lock.held()) {
      this.exitCode = 1;
      this.stop("runner.lock is no longer ours");
      return;
    }
    this.info = { ...this.info, heartbeatAt: new Date().toISOString() };
    try {
      writeRunnerInfo(this.execution, this.info);
    } catch (e) {
      this.say(`heartbeat failed: ${errText(e)}`);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearInterval(this.githubTimer);
    if (!this.store) return this.release();
    await bounded(Promise.allSettled([...this.pending]), 10_000);
    const state = await this.store.state().catch(() => undefined);
    const terminal = state !== undefined && TERMINAL_RUN.has(state.status);
    if (terminal && this.github) {
      await bounded(this.github.syncOnce(), 60_000).catch(() => undefined);
    }
    await this.dashboard?.close().catch(() => undefined);
    if (this.lock?.held()) {
      await this.commit([{ type: "runner.stopped", source: this.source, payload: { reason: scrub(reason) } }]).catch((e) => this.say(`runner.stopped: ${errText(e)}`));
      await this.store.writeSnapshot().catch((e) => this.say(`final snapshot failed: ${errText(e)}`));
    }
    if (this.info) {
      try {
        writeRunnerInfo(this.execution, { ...this.info, heartbeatAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), stopReason: scrub(reason) });
      } catch {
        /* a purged execution */
      }
    }
    this.say(`runner ${process.pid} stopped: ${reason}`);
    await this.release();
  }

  private async release(): Promise<void> {
    clearInterval(this.heartbeat);
    this.lock?.();
    this.lock = undefined;
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  async commit(drafts: AnyEventDraft[]): Promise<AnyEvent[]> {
    if (!drafts.length) return [];
    return (await this.store.transact(() => ({ events: drafts }))).events;
  }

  /** Read the new events into the cache and rewrite leases.json for every agent whose leases they changed. */
  private async refreshLog(): Promise<AnyEvent[]> {
    const since = this.log.length ? this.log[this.log.length - 1].seq : 0;
    const fresh = (await this.store.events({ sinceSeq: since })).filter((e) => e.seq > (this.log.at(-1)?.seq ?? 0));
    if (!fresh.length) return fresh;
    this.log.push(...fresh);
    const touched = new Set<string>();
    const owners = this.leaseOwners();
    for (const e of fresh) {
      if (e.type === "lease.granted") touched.add(e.payload.lease.agent);
      else if (e.type === "lease.expired" || e.type === "lease.released" || e.type === "lease.revoked") {
        const a = owners.get(e.payload.lease_id);
        if (a) touched.add(a);
      }
    }
    for (const agent of touched) {
      try {
        await writeAgentLeases(this.store, agent);
      } catch (e) {
        this.say(`leases.json for ${agent}: ${errText(e)}`);
      }
    }
    return fresh;
  }

  private leaseOwners(): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of this.log) {
      if (e.type === "lease.granted") m.set(e.payload.lease.id, e.payload.lease.agent);
      else if (e.type === "lease.queued") m.set(e.payload.request.id, e.payload.request.agent);
    }
    return m;
  }

  /** The cached log (read-only). */
  events(): readonly AnyEvent[] {
    return this.log;
  }

  /** Seq of the last event matching `pred`, or 0. */
  lastSeq(pred: (e: AnyEvent) => boolean): number {
    for (let i = this.log.length - 1; i >= 0; i--) if (pred(this.log[i])) return this.log[i].seq;
    return 0;
  }

  started(): EventPayloads["execution.started"] | undefined {
    const e = this.log.find((x) => x.type === "execution.started");
    return e?.type === "execution.started" ? e.payload : undefined;
  }

  // ==========================================================================
  // The tick
  // ==========================================================================

  async tick(): Promise<void> {
    if (this.stopping) return;
    await this.refreshLog();
    let state = await this.store.state();
    if (TERMINAL_RUN.has(state.status)) return this.finish(state);

    if (Object.entries(state.agents).some(([id, a]) => !a.external && !this.workers.has(id) && !this.busy.has(id) && ["registered", "running"].includes(a.status))) {
      await this.reconcile();
    }
    await this.stopSuperseded();
    await this.applyStops();
    await this.pollWorkers();
    await this.settleStops();
    state = await this.store.state();
    for (const claim of Object.values(state.claims)) {
      if (!taskHeld(state, claim.task) && ["submitted", "checking"].includes(state.tasks[claim.task]?.state) &&
          !state.agents[claim.agent]?.external && !this.hasLiveWorker(claim.task) && !this.busy.has(claim.agent)) {
        await this.recoverLost(claim.agent, claim.task, readRunFile(this.execution, claim.agent), true);
      }
    }
    // Before the watchdog: a resolution's resume must not be mistaken for a worker that died.
    await this.applyHandoffs();
    await this.watchdogPass();
    await this.refreshLog();
    state = await this.store.state();
    if (TERMINAL_RUN.has(state.status)) return this.finish(state);

    this.routeEscalations(state);
    this.passEscalations();
    await this.postmortemPass();
    await this.retireMerged();
    await this.schedule(state);
    this.merge.feed(await this.store.state());
    await this.checkFailure(await this.store.state());
    this.checkIdle(state);
    await this.maybeSnapshot();
  }

  /** Postmortem mode: record a finding for each submission that testing sent back (autoFindings; idempotent). */
  private async postmortemPass(): Promise<void> {
    try {
      // Scan a fresh, locked tail so a recovery cannot land between the scan and its findings.
      const scanned = await this.store.transact(async ({ state }) => {
        const tail = await this.store.events({ sinceSeq: this.log.at(-1)?.seq ?? 0 });
        const log = [...this.log, ...tail];
        const seq = log.at(-1)?.seq ?? 0;
        return { events: seq === this.pmScanned ? [] : autoFindings(log, state, this.pmScanned, this.source), result: seq };
      });
      this.pmScanned = scanned.result!;
    } catch (e) {
      this.say(`postmortem pass: ${errText(e)}`);
    }
  }

  /** Superseded claims and connector amendments stop workers even if a handoff was lost. */
  private async stopSuperseded(): Promise<void> {
    const state = await this.store.state();
    for (const t of this.workers.values()) {
      const registered = this.lastSeq((e) => e.type === "agent.registered" && e.payload.agent === t.agent);
      let connectorsChanged = false;
      for (const e of this.log) {
        if (e.type !== "contract.amended" || e.seq <= registered || !e.payload.affected_tasks.includes(t.task)) continue;
        const patch = JSON.parse((await this.store.getBlob(e.payload.patch_blob)).toString("utf8"));
        if (Object.hasOwn(patch, "connectors")) { connectorsChanged = true; break; }
      }
      // An accepted task drops its claim; retireMerged stops its worker after the merge grace.
      if (own(state.tasks, t.task)?.state === "accepted" && !connectorsChanged) continue;
      const claim = own(state.claims, t.task);
      if (!t.exit && (connectorsChanged || !claim || claim.agent !== t.agent || claim.attempt > t.attempt)) {
        await this.killWorker(t.agent, "killed", connectorsChanged ? "its connectors were amended" : "its task claim or attempt was superseded");
      }
    }
  }

  /**
   * Stop the workers a person asked to stop (agent.stop_requested), before anything is scheduled: the
   * same stop as a superseded worker's. The next poll records the exit with reason "stopped".
   */
  private async applyStops(): Promise<void> {
    const state = await this.store.state();
    for (const rec of Object.values(state.agents)) {
      const stop = rec.stop;
      if (stop) await stopMicroHuddles(this.store, rec.id, this.source);
      // A worker with a kill, resume or spawn in flight is tried again next tick.
      if (stop?.state !== "requested" || rec.status !== "running" || rec.external || this.stopApplied.has(stop.request) || this.busy.has(rec.id)) continue;
      this.stopApplied.add(stop.request);
      this.say(`stopping ${rec.id} (asked by ${stop.by}, from the ${stop.surface})`);
      await this.killWorker(rec.id, "stopped", `stopped by ${stop.by}`);
    }
  }

  /**
   * A stopped worker has exited: record agent.stopped and, when it held a task, raise a blocking
   * escalation to the orchestrator and block the task (never retried automatically; its WIP branch and
   * worktree are kept). The orchestrator's watcher wakes with the choices: rework around the stopped
   * agent with resolve_escalation, or write a handoff with control_execution.
   */
  private async settleStops(): Promise<void> {
    let state = await this.store.state();
    if (!Object.values(state.agents).some((a) => a.stop?.state === "requested" && a.status === "exited")) return;
    await this.refreshLog();
    state = await this.store.state();
    for (const rec of Object.values(state.agents)) {
      const stop = rec.stop;
      if (stop?.state !== "requested" || rec.status !== "exited" || this.busy.has(rec.id)) continue;
      // Any exit after the request settles it, whatever its reason (stopped, or lost with a runner that died
      // mid-stop): the log alone says so, so a restarted runner finishes what an earlier one began.
      const exit = [...this.log].reverse().find((e) => e.type === "agent.exited" && e.payload.agent === rec.id);
      if (exit?.type !== "agent.exited" || exit.seq < stop.seq) continue;
      const task = exit.payload.task ?? rec.task;
      const key = `agent_stopped:${stop.request}`;
      await this.store.transact(({ state: s }) => {
        const cur = own(s.agents, rec.id);
        if (cur?.stop?.request !== stop.request || cur.stop.state !== "requested") return { events: [] };
        const taskState = task !== undefined ? own(s.tasks, task)?.state : undefined;
        const working = taskState === "claimed" || taskState === "in_progress" || taskState === "blocked";
        const held = taskState !== undefined && !["accepted", "failed", "cancelled"].includes(taskState);
        const escalation = held
          ? runnerEscalation(
              s,
              {
                key,
                task,
                kind: "blocker",
                summary: `${rec.id} was stopped by ${stop.by}.`,
                question: `Rework around ${rec.id}, or write a handoff?`,
                options: [
                  "Rework around the stopped agent with resolve_escalation (reassign, retry, amend or decide)",
                  'Write a handoff with control_execution(action: "handoff")',
                ],
                block: working,
              },
              this.source
            )
          : [];
        return {
          events: [
            {
              type: "agent.stopped",
              source: this.source,
              payload: { agent: rec.id, ...(task !== undefined && { task }), request: stop.request, ...(escalation.length && { escalation: runnerEscalationId(key) }) },
            },
            ...escalation,
          ],
        };
      });
      this.say(`${rec.id} stopped by ${stop.by}${task ? `; task ${task} waits for the orchestrator` : ""}`);
    }
  }

  /** Run the next tick now (a request arrived: the dashboard wakes the runner it lives in). */
  wakeNow(): void {
    this.wake?.();
  }

  private async finish(state: BlackboardState): Promise<void> {
    await this.postmortemPass();
    if (state.status === "failed") this.exitCode = 1;
    if (state.status === "aborted") {
      for (const t of this.workers.values()) if (!t.exit) await this.killWorker(t.agent, "killed", "the run was aborted");
    }
    await this.pollWorkers();
    if (this.merge.busy()) return;
    this.stop(state.status);
  }

  private async maybeSnapshot(): Promise<void> {
    const seq = this.log.length ? this.log[this.log.length - 1].seq : 0;
    if (seq - this.snapSeq >= SNAPSHOT_EVENTS || (seq !== this.snapSeq && Date.now() - this.snapAt >= SNAPSHOT_MS)) {
      const s = await this.store.writeSnapshot();
      this.snapSeq = s.seq;
      this.snapAt = Date.now();
    }
  }

  /** 6 h after the whole run was paused (and not resumed), the runner exits; ensureRunner restarts it on resume. */
  private checkIdle(state: BlackboardState): void {
    if (state.status !== "paused") return;
    const seq = this.lastSeq((e) => e.type === "execution.paused" && e.payload.scope === "all");
    const paused = seq ? this.log.find((e) => e.seq === seq) : undefined;
    const since = paused ? Date.parse(paused.ts) : this.startedAt;
    if (Date.now() - since >= this.opts.idleExitMs) this.stop(`idle: paused for ${Math.round(this.opts.idleExitMs / 60_000)} min`);
  }

  // ==========================================================================
  // Workers: monitoring
  // ==========================================================================

  private async pollWorkers(): Promise<void> {
    for (const t of [...this.workers.values()]) {
      if (this.busy.has(t.agent)) continue;
      try {
        await this.pollOne(t);
      } catch (e) {
        this.say(`monitor of ${t.agent}: ${errText(e)}`);
      }
    }
  }

  private async pollOne(t: Tracked): Promise<void> {
    if (own((await this.store.state()).agents, t.agent)?.status === "registered") {
      await this.store.transact(({ state }) => ({ events: own(state.agents, t.agent)?.status === "registered" ? [{
        type: "agent.spawned", source: this.source,
        payload: { agent: t.agent, task: t.task, attempt: t.attempt, pid: t.pid, started: t.started, ...(t.driver === "claude-code" && { session_id: t.sessionId }) },
      }] : [] }));
    }
    const offset = t.monitor.offset;
    const checkpoint = t.monitor.checkpoint();
    if (!t.exit && t.adopted && !processMatches(t.pid, t.started)) t.exit = { code: null, signal: null };
    const p = t.monitor.poll();
    if (p.bytes > 0) t.lastOutputAt = Date.now();
    let drafts = p.drafts;
    if (p.attestation) t.attested = p.attestation.ok;
    if (t.exit && this.sessionGone(t)) return this.restartFresh(t);
    if (t.exit) {
      removeWorkerMcpConfig(this.execution, t.agent);
      // An adopted worker is not our child: its exit code is unknown, so its stream says how it ended.
      const acc = t.monitor.acc;
      const reason = t.killReason ?? (t.adopted && t.exit.code === null && !t.exit.signal ? (acc.done && !acc.isError ? "completed" : "lost") : undefined);
      drafts = [...drafts, ...t.monitor.finish({ code: t.exit.code, signal: t.exit.signal, ...(reason && { reason }) })];
    }
    drafts = this.classifyExit(t, drafts);
    drafts = this.markPaused(t, drafts, await this.store.state());
    drafts = this.unseen(t, drafts);
    try {
      await this.commit(drafts);
    } catch (e) {
      t.monitor = this.monitorFor(this.drivers[t.driver] ?? this.driver(), t.agent, t.task, t.outputPath, offset, undefined, checkpoint);
      t.attested = checkpoint.attestation?.ok;
      throw e;
    }
    const attestation = drafts.find((d) => d.type === "agent.attested");
    if (attestation?.type === "agent.attested") t.attested = attestation.payload.ok;
    if (t.attested === false) {
      await this.attestationFailed(t, p.attestation?.reasons ?? t.monitor.attestation?.reasons ?? ["worker attestation failed"]);
      return;
    }
    if (t.exit) {
      this.workers.delete(t.agent);
      this.writeRun(t);
      this.say(`${t.agent} exited on ${t.task} (attempt ${t.attempt}, code ${t.exit.code ?? "none"}${t.exit.signal ? `, ${t.exit.signal}` : ""})`);
      return;
    }
    this.writeRun(t);
  }

  /** Drop drafts an earlier runner already committed for an adopted run. */
  private unseen(t: Tracked, drafts: AnyEventDraft[]): AnyEventDraft[] {
    const skip = t.skip;
    if (!skip) return drafts;
    return drafts.filter((d) => {
      if (d.type === "agent.attested" && skip.attested) return false;
      if (d.type === "budget.usage_recorded" && skip.usage) return false;
      return true;
    });
  }

  /** A resumed claude-code run that died before system/init because its session no longer exists. */
  private sessionGone(t: Tracked): boolean {
    if (!t.resumed || t.driver !== "claude-code" || !t.exit || t.exit.code === 0 || t.monitor.acc.tools !== undefined || t.killReason) return false;
    return SESSION_GONE_RE.test(readTail(t.outputPath, t.startOffset));
  }

  /** Its session is gone: record the run as lost and start a fresh session with the WIP diff stat in the card. */
  private async restartFresh(t: Tracked): Promise<void> {
    this.workers.delete(t.agent);
    const drafts = this.unseen(t, t.monitor.finish({ code: t.exit?.code ?? null, signal: t.exit?.signal ?? null, reason: "lost" })).filter((d) => d.type !== "agent.attested");
    let wipStat: string | undefined;
    try {
      wipStat = (await taskDiffSummary(t.cwd, integrationBranch(this.execution))).stat || undefined;
    } catch {
      /* no branch yet */
    }
    this.say(`${t.agent}: session ${t.sessionId} is gone; starting a fresh session on ${t.task}`);
    await this.startWorker(t.task, {
      claim: false,
      session: "new",
      preDrafts: drafts,
      immediate: interruptedContext({ why: "Your worker was interrupted and its session could not be resumed.", fresh: true, ...(wipStat && { wipStat }) }),
    });
  }

  /**
   * A worker that exits while its task or the run is paused stopped for the pause (it was told to):
   * its agent.exited names the pause, so the watchdog resumes it on the same attempt.
   */
  private markPaused(t: Tracked, drafts: AnyEventDraft[], state: Readonly<BlackboardState>): AnyEventDraft[] {
    if (taskHeld(state, t.task)) {
      const paused = blockingIds(state.tasks[t.task])[0] ?? "dissent hold";
      return drafts.map((d) => d.type === "agent.exited" ? { ...d, payload: { ...d.payload, paused } } : d);
    }
    if (state.status !== "paused" && !state.paused_tasks.includes(t.task)) return drafts;
    const pause = [...this.log].reverse().find((e) => e.type === "execution.paused" && (e.payload.scope === "all" || e.payload.scope.includes(t.task)));
    const paused = pause?.type === "execution.paused" ? scrubAndCap(pause.correlation ?? pause.payload.reason, 300) : "paused";
    return drafts.map((d) => (d.type === "agent.exited" && d.payload.paused === undefined ? { ...d, payload: { ...d.payload, paused } } : d));
  }

  /** Rate limits, auth and credit failures in a worker's error output feed the circuit breaker. */
  private classifyExit(t: Tracked, drafts: AnyEventDraft[]): AnyEventDraft[] {
    const acc = t.monitor.acc;
    if (!acc.isError) return drafts;
    const message = [acc.lastText, ...(acc.errors ?? [])].filter(Boolean).join("\n");
    const kind = message ? classifyFailure(message, { source: "driver" }) : "error";
    if (kind === "error") return drafts;
    const label = { rate_limit: "rate_limit_error", auth: "authentication_error", credit: "insufficient_quota" }[kind];
    return drafts.map((d) => d.type === "agent.exited" && d.payload.reason === "error"
      ? { ...d, payload: { ...d.payload, result_subtype: `${acc.resultSubtype ?? "error"}: ${label}` } }
      : d);
  }

  private writeRun(t: Tracked): void {
    const run: RunFile = {
      v: 1,
      agent: t.agent,
      task: t.task,
      attempt: t.attempt,
      driver: t.driver,
      pid: t.pid,
      pgid: t.pgid,
      started: t.started,
      session_id: t.driver === "codex" ? (t.monitor.acc.sessionId ?? t.sessionId) : t.sessionId,
      output: t.outputPath,
      cwd: t.cwd,
      offset: t.monitor.offset,
      start_offset: t.startOffset,
      started_at: new Date(t.startedAt).toISOString(),
      resumed: t.resumed,
      monitor: t.monitor.checkpoint(),
      ...(t.attested !== undefined && { attested: t.attested }),
    };
    try {
      writeFileAtomic(runFilePath(this.execution, t.agent), scrubbedJSON(run) + "\n");
    } catch (e) {
      this.say(`run.json of ${t.agent}: ${errText(e)}`);
    }
  }

  private async attestationFailed(t: Tracked, reasons: string[]): Promise<void> {
    this.busy.add(t.agent);
    try {
      t.killReason = "attestation";
      if (!t.exit) await this.stopProcess(t, "attestation failed");
      const exit = await this.waitExit(t);
      const drafts = this.unseen(t, t.monitor.finish({ code: exit.code, signal: exit.signal, reason: "attestation" }));
      this.workers.delete(t.agent);
      this.writeRun(t);
      const summary = `Worker ${t.agent} on task ${t.task} did not start as required and was stopped: ${reasons.join("; ")}.`;
      await this.store.transact(({ state }) => ({
        events: [
          ...drafts,
          ...runnerEscalation(
            state,
            {
              key: `attestation:${t.task}:${t.attempt}:${t.startedAt}`,
              task: t.task,
              kind: "blocker",
              summary,
              question: "Its claude CLI loaded tools or MCP servers it must not have. Check the CLI's configuration before retrying.",
              options: ["Retry once the CLI is fixed", "Cancel the task"],
              block: true,
            },
            this.source
          ),
        ],
      }));
      this.say(summary);
    } finally {
      this.busy.delete(t.agent);
    }
  }

  // ==========================================================================
  // Workers: stopping
  // ==========================================================================

  private handleOf(t: Tracked) {
    return { agent: t.agent, task: t.task, attempt: t.attempt, pid: t.pid, pgid: t.pgid, started: t.started, sessionId: t.sessionId, outputPath: t.outputPath, startedAt: new Date(t.startedAt).toISOString() };
  }

  private async stopProcess(t: Tracked, reason: string): Promise<void> {
    if (!processMatches(t.pid, t.started)) {
      t.exit = { code: null, signal: null };
      return;
    }
    const d = this.drivers[t.driver];
    if (d) await d.stop(this.handleOf(t), reason);
    else await stopGroup(t.pgid, 10_000, t.started);
  }

  /** The exit of a stopped worker (the pid gone, or this process saw it exit). */
  private async waitExit(t: Tracked, ms = 15_000): Promise<WorkerExit> {
    const end = Date.now() + ms;
    while (!t.exit && Date.now() < end) {
      if (!processMatches(t.pid, t.started)) t.exit = { code: null, signal: "SIGTERM" };
      else await sleep(25);
    }
    if (t.exit) removeWorkerMcpConfig(this.execution, t.agent);
    return t.exit ?? { code: null, signal: "SIGKILL" };
  }

  /** Stop an agent's worker; the next poll records its exit with `reason`. Idempotent. */
  async killWorker(agent: string, reason: ExitReason, why: string): Promise<void> {
    const t = this.workers.get(agent);
    if (!t) {
      // Not ours (or already gone): signal its group if the blackboard still has a live pid.
      const rec = own((await this.store.state()).agents, agent);
      if (rec?.status === "running" && rec.pid && !rec.external) {
        if (processMatches(rec.pid, rec.started)) await stopGroup(rec.pid, 10_000, rec.started);
        else await this.commit([{ type: "agent.exited", source: this.source, payload: { agent, code: null, reason: "lost" } }]);
        if (!processMatches(rec.pid, rec.started)) removeWorkerMcpConfig(this.execution, agent);
      }
      return;
    }
    if (t.exit || this.busy.has(agent)) return;
    this.busy.add(agent);
    try {
      t.killReason = reason;
      await this.stopProcess(t, why);
      await this.waitExit(t);
    } finally {
      this.busy.delete(agent);
    }
  }

  /**
   * Stop the task's live worker, if any, and return its exit drafts uncommitted, so they can be
   * committed together with a re-registration.
   */
  /**
   * Stop a task's worker and hand its uncommitted exit drafts to `then`, which commits them (as a
   * restart's preDrafts). The agent stays busy until `then` settles, so a tick in between never
   * mistakes the untracked worker for a lost one and records a second exit.
   */
  async withStoppedWorker<T>(task: string, reason: ExitReason, why: string, then: (drafts: AnyEventDraft[]) => Promise<T>): Promise<T> {
    const t = [...this.workers.values()].find((w) => w.task === task);
    if (!t) return then([]);
    this.busy.add(t.agent);
    try {
      t.killReason ??= reason;
      if (!t.exit) await this.stopProcess(t, why);
      const exit = await this.waitExit(t);
      this.workers.delete(t.agent);
      this.writeRun(t);
      return await then(this.unseen(t, t.monitor.finish({ code: exit.code, signal: exit.signal, reason: t.killReason })));
    } finally {
      this.busy.delete(t.agent);
    }
  }

  /** A worker still running after its task merged is stopped once mergeGraceMs has passed. */
  private async retireMerged(): Promise<void> {
    const state = await this.store.state();
    for (const t of this.workers.values()) {
      if (t.exit || own(state.tasks, t.task)?.state !== "accepted") continue;
      t.retireAt ??= Date.now() + this.opts.mergeGraceMs;
      if (Date.now() >= t.retireAt) await this.killWorker(t.agent, "completed", "its task was merged");
    }
  }

  workerRecord(agent: string): WorkerRecord | undefined {
    const t = this.workers.get(agent);
    if (!t || t.exit) return undefined;
    return { ...this.handleOf(t), driver: t.driver, cwd: t.cwd };
  }

  hasLiveWorker(task: string): boolean {
    return [...this.workers.values()].some((t) => t.task === task && !t.exit);
  }

  hasAnyLiveWorker(): boolean {
    return [...this.workers.values()].some((t) => !t.exit);
  }

  // ==========================================================================
  // The watchdog
  // ==========================================================================

  /** The runner's process observations, merged with what the log shows (observeEvents). */
  observations(state: Readonly<BlackboardState>): Observations {
    const agents: Record<string, AgentObservation> = {};
    const claims = { ...this.renewed };
    for (const c of Object.values(state.claims)) {
      if (c.ttl_s <= 0) continue;
      const heartbeat = mtimeMs(join(agentDir(this.execution, c.agent), "heartbeat"));
      if (heartbeat !== undefined) claims[c.task] = { renewedAt: Math.max(own(claims, c.task)?.renewedAt ?? 0, heartbeat) };
    }
    for (const [id, rec] of Object.entries(state.agents)) {
      if (rec.external || (rec.status !== "running" && rec.status !== "registered")) continue;
      const t = this.workers.get(id);
      const heartbeat = mtimeMs(join(agentDir(this.execution, id), "heartbeat"));
      const o: AgentObservation = t
        ? {
            pid: t.pid,
            // The runner reports the exit itself (with its reason and usage), so a tracked worker counts as alive until then.
            alive: true,
            startedAt: t.startedAt,
            ...(t.lastOutputAt !== undefined && { lastOutputAt: t.lastOutputAt }),
            ...(heartbeat !== undefined && { lastHeartbeatAt: heartbeat }),
          }
        : { ...(rec.pid !== undefined && { pid: rec.pid }), alive: rec.pid !== undefined && processMatches(rec.pid, rec.started) };
      if (this.busy.has(id) || (!t && rec.status === "registered")) o.busy = true;
      Object.defineProperty(agents, id, { value: o, enumerable: true, writable: true, configurable: true });
    }
    const leadInFlight: Record<string, boolean> = {};
    for (const id of this.leadInFlight) leadInFlight[id] = true;
    return observeEvents(this.log, {
      agents,
      watchers: watcherObservations(this.execution),
      claims,
      leadInFlight,
      retainedTasks: Object.values(state.tasks).filter((t) => t.state === "accepted").map((t) => t.spec.id),
    });
  }

  /** evaluate inside transact (its diagnostics stored as blobs), then the process operations after the commit. */
  private async watchdogPass(): Promise<void> {
    await this.refreshLog();
    const obs = this.observations(await this.store.state());
    const now = Date.now();
    const r = await this.store.transact<WatchdogAction[]>(async ({ state }) => {
      const actions = evaluate(state as BlackboardState, now, obs, this.opts.watchdog);
      const blobs: Record<string, string> = {};
      for (const a of actions) {
        if (a.type === "emit" && a.diagnostics) blobs[a.key] = await this.store.putBlob(scrubbedJSON(a.diagnostics), { redact: false });
      }
      return { events: actionsToDrafts(actions, { pid: process.pid, diagnosticsBlobs: blobs }), result: actions };
    });
    if (r.events.length) await this.refreshLog();
    const ops = processActions(r.result ?? []);
    this.background(this.applyProcessOps(ops));
  }

  /**
   * Perform the watchdog's process operations. Each is idempotent: a non-standing one is done once
   * per process (and a repeat after a crash finds its effect done: a claimed task, a dead pid);
   * standing ones (stop_spawning, kill_worker) repeat every pass while their condition holds.
   */
  async applyProcessOps(ops: readonly ProcessAction[]): Promise<void> {
    this.spawnBlocked = ops.some((op) => op.type === "stop_spawning");
    const resuming = new Set(ops.filter((o) => o.type === "resume_worker").map((o) => (o as { agent: string }).agent));
    for (const op of ops) {
      const key = `${op.type}\0${op.key}`;
      if (!op.standing && this.opsDone.has(key)) continue;
      if (!op.standing) this.opsDone.add(key);
      try {
        switch (op.type) {
          case "stop_spawning":
            this.spawnBlocked = true;
            break;
          case "kill_worker":
            if (resuming.has(op.agent)) break; // the resume stops it and records the exit with the re-registration
            await this.killWorker(op.agent, op.rule === "worker_stall" ? "stalled" : op.rule === "budget_cap" ? "budget" : "killed", op.reason);
            break;
          case "resume_worker": {
            const started = await this.withStoppedWorker(op.task, "stalled", op.why, (drafts) =>
              this.startWorker(op.task, { claim: false, preDrafts: drafts, immediate: interruptedContext({ why: op.why }) }));
            if (!started) this.opsDone.delete(key);
            break;
          }
          case "spawn_retry":
            if (!(await this.startWorker(op.task, { claim: true, attempt: op.attempt }))) this.opsDone.delete(key);
            break;
          case "lead_fallback":
            this.startLead(op.escalation);
            break;
          case "wake_orchestrator":
            // The watcher wakes on the event itself (budget.threshold_crossed ≥ 80%).
            this.say(`wake ${op.orchestrator}: ${op.reason}`);
            break;
        }
      } catch (e) {
        this.opsDone.delete(key);
        this.say(`${op.type} ${op.target}: ${errText(e)}`);
      }
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  /** The lead fallback, with obs.leadInFlight set until its call and its operations are done. */
  private startLead(id: string): void {
    if (this.leadInFlight.has(id)) return;
    this.leadInFlight.add(id);
    this.track(
      this.hooks
        .leadFallback(this.ctx, id)
        .then((ops) => this.applyResolutionOps(ops ?? [], `lead ${id}`))
        .catch((e) => this.say(`lead fallback for ${id}: ${errText(e)}`))
        .finally(() => this.leadInFlight.delete(id))
    );
  }

  /** Retry a failed route with exponential backoff (30 s, 60 s, 120 s...), then hand the escalation to a human. */
  private routeFailed(id: string, e: unknown): void {
    const attempts = (this.routeAttempts.get(id) ?? 0) + 1;
    this.routeAttempts.set(id, attempts);
    this.say(`escalation router on ${id} (attempt ${attempts} of ${ROUTE_MAX_ATTEMPTS}): ${errText(e)}`);
    if (attempts < ROUTE_MAX_ATTEMPTS) {
      this.routed.delete(id);
      this.routeRetryAt.set(id, Date.now() + (this.opts.routeRetryBaseMs ?? ROUTE_RETRY_BASE_MS) * 2 ** (attempts - 1));
      return;
    }
    const message = `The runner could not route this escalation after ${ROUTE_MAX_ATTEMPTS} attempts (${scrubAndCap(errText(e), 300)}). Check the provider keys, or resolve it by hand.`;
    this.track(Promise.resolve(this.hooks.escalationGiveUp?.(this.ctx, id, message)).catch((err) => this.say(`escalation ${id} could not be handed to the human: ${errText(err)}`)));
  }

  /** New open escalations go to the router once per process (a restarted runner offers them again). */
  private routeEscalations(state: Readonly<BlackboardState>): void {
    for (const esc of Object.values(state.escalations)) {
      if (esc.status !== "open" || this.routed.has(esc.id) || (this.routeRetryAt.get(esc.id) ?? 0) > Date.now()) continue;
      this.routed.add(esc.id);
      this.track(
        this.hooks
          .escalationRouter(this.ctx, structuredClone(esc))
          .then((ops) => { this.routeAttempts.delete(esc.id); this.routeRetryAt.delete(esc.id); return this.applyResolutionOps(ops ?? [], `escalation ${esc.id}`); })
          .catch((e) => this.routeFailed(esc.id, e))
      );
    }
  }

  /**
   * The hooks' escalation pass (owed resumes, concluded huddles), one at a time: when the log has
   * moved since the last one, and every PASS_MS anyway (a resume the respawn gate held).
   */
  private passEscalations(): void {
    const pass = this.hooks.escalationPass;
    const seq = this.log.length ? this.log[this.log.length - 1].seq : 0;
    if (!pass || this.passInFlight || (seq === this.passSeq && Date.now() - this.passAt < PASS_MS)) return;
    this.passInFlight = true;
    this.passSeq = seq;
    this.passAt = Date.now();
    this.track(
      pass(this.ctx)
        .then((ops) => this.applyResolutionOps(ops ?? [], "escalation pass"))
        .catch((e) => this.say(`escalation pass: ${errText(e)}`))
        .finally(() => (this.passInFlight = false))
    );
  }

  // ==========================================================================
  // Scheduling and starting workers
  // ==========================================================================

  /** The contract's worker driver (claude-code unless it names codex). */
  driver(): WorkerDriver {
    const d = this.drivers[this.driverId];
    if (!d) throw new Error(`No worker driver ${this.driverId}`);
    return d;
  }

  private driverId: WorkerDriverId = "claude-code";
  private contractConnectors?: string[];

  /** The driver must pass detect() (its required flags) before the first spawn; a failure escalates once. */
  private async driverReady(state: Readonly<BlackboardState>): Promise<boolean> {
    this.contractConnectors = state.contract?.connectors;
    this.driverId = state.contract?.workers.driver === "codex" ? "codex" : "claude-code";
    const d = this.driver();
    if (this.driverCheckedId !== d.id) this.driverChecked = undefined;
    this.driverCheckedId = d.id;
    this.driverChecked ??= d.detect().then((r) => ({ ok: r.ok, missing: r.missing }));
    const r = await this.driverChecked;
    if (r.ok) return true;
    await this.store.transact(({ state: s }) => ({
      events: runnerEscalation(
        s,
        {
          key: `driver:${d.id}`,
          kind: "blocker",
          summary: `The ${d.id} worker CLI cannot run workers: missing ${r.missing.join(", ")}. No worker starts until it is fixed.`,
          options: ["Install or update the CLI, then resume the run", "Switch the contract's worker driver"],
        },
        this.source
      ),
    }));
    this.driverChecked = undefined; // checked again next pass, so a fixed CLI is picked up
    return false;
  }

  /** Spawn ready tasks, in contract order, up to max_parallel. */
  private async schedule(state: Readonly<BlackboardState>): Promise<void> {
    if (state.status !== "running" || this.spawnBlocked || !state.contract) return;
    const max = Math.max(1, state.contract.budget.max_parallel);
    let active = Object.values(state.tasks).filter((rt) => ACTIVE_TASK.has(rt.state) || this.hasLiveWorker(rt.spec.id)).length;
    for (const rt of Object.values(state.tasks)) {
      if (active >= max) break;
      const task = rt.spec.id;
      if (rt.state !== "ready" || own(state.claims, task) || state.paused_tasks.includes(task) || this.starting.has(task)) continue;
      if (await this.startWorker(task, { claim: true })) active++;
      else if (this.spawnBlocked) break;
    }
  }

  /** Why the task cannot start a worker for `agent` now, or null. */
  private startProblem(s: Readonly<BlackboardState>, task: string, agent: string, claim: boolean, reopen = false): string | null {
    if (this.stopping) return "the runner is stopping";
    if (s.status !== "running") return `the run is ${s.status}`;
    if (s.paused_tasks.includes(task)) return `task ${task} is paused`;
    if (taskHeld(s, task)) return `task ${task} is held by an escalation`;
    const rt = own(s.tasks, task);
    if (!rt) return `unknown task ${task}`;
    if (own(s.agents, agent)?.external) return `${agent} is an external agent`;
    // A person asked for this agent to stop: whatever lost or resumed it must not undo that. The stop settles first.
    if (own(s.agents, agent)?.stop?.state === "requested") return `a stop for ${agent} is waiting`;
    if (this.hasLiveWorker(task)) return `a worker already runs on ${task}`;
    const active = Object.values(s.tasks).filter((t) => t.spec.id !== task && (ACTIVE_TASK.has(t.state) || this.hasLiveWorker(t.spec.id))).length;
    if (active >= (s.contract?.budget.max_parallel ?? 1)) return "max_parallel workers already run";
    const c = own(s.claims, task);
    if (claim) {
      if (c) return `${task} is claimed by ${c.agent}`;
      if (rt.state !== "ready") return `${task} is ${rt.state}`;
      if (!rt.spec.depends_on.every((d) => own(s.tasks, d)?.state === "accepted")) return `${task} waits on dependencies`;
    } else {
      if (!c || c.agent !== agent) return `${task} is not claimed by ${agent}`;
      const ok = rt.state === "claimed" || rt.state === "in_progress" || (reopen && (rt.state === "submitted" || rt.state === "checking" || rt.state === "merging"));
      if (!ok) return `${task} is ${rt.state}`;
    }
    return null;
  }

  private async persona(ref: string): Promise<string | { body: string; skills: [] }> {
    try {
      await loadAgent(ref);
      return ref;
    } catch (e) {
      this.say(`persona ${ref} not found (${errText(e).split("\n")[0]}); the worker gets a generic persona`);
      return { body: `You are ${ref}, a careful software engineer working on one task of a larger plan.`, skills: [] };
    }
  }

  /**
   * Start (or resume) a worker on a task:
   *  ensureTaskWorktree → prepareWorkerFiles (a fresh token) → one transaction with the previous
   *  run's exit (preDrafts), agent.registered, task.claimed {ttl_s: 0} when claiming, and the task's
   *  initial lease (granted, or queued behind a conflict) → writeAgentLeases → driver.launch or
   *  .resume with the task card on stdin → run.json → agent.spawned.
   * Returns false when it cannot start now; preDrafts are committed whatever happens.
   */
  async startWorker(task: string, o: StartOptions): Promise<boolean> {
    let pre = o.preDrafts ?? [];
    const flush = async () => {
      if (pre.length) {
        const d = pre;
        pre = [];
        await this.commit(d);
      }
    };
    if (this.starting.has(task)) {
      await flush();
      return false;
    }
    this.starting.add(task);
    let agent = workerAgentId(task);
    let registered = false;
    let trial: string | undefined;
    try {
      await this.refreshLog();
      const state = await this.store.state();
      const claimed = own(state.claims, task);
      if (!o.claim && claimed && !own(state.agents, claimed.agent)?.external) agent = claimed.agent;
      this.busy.add(agent);
      const problem = this.startProblem(state, task, agent, o.claim, o.reopen);
      if (problem) {
        await flush();
        return false;
      }
      if (!(await this.driverReady(state))) {
        await flush();
        return false;
      }
      const driver = this.driver();
      const obs = this.observations(state);
      const gate = canRespawn(state, Date.now(), obs, { task, agent, driver: driver.id });
      if (!gate.ok) {
        if (gate.why === "budget") this.spawnBlocked = true;
        await flush();
        return false;
      }
      if (state.watchdog.circuits[driver.id]?.open) {
        if (this.trialReservations.has(driver.id)) { await flush(); return false; }
        this.trialReservations.add(driver.id);
        trial = driver.id;
      }
      let budgetUsd = remainingUsd(state, { task, agent });
      if (budgetUsd < 0.01) {
        await flush();
        return false;
      }
      const rt = state.tasks[task];
      const spec = rt.spec;
      const wt = await ensureTaskWorktree(this.header, task, taskStartPoint(state, task));
      const files = await prepareWorkerFiles({ store: this.store, agent, persona: await this.persona(spec.persona), task, driver: driver.id });
      const rec = own(state.agents, agent);
      const run = readRunFile(this.execution, agent);
      const previous = run && run.task === task ? run.session_id : rec?.task === task ? rec.session_id : undefined;
      const resume = o.session !== "new" && previous !== undefined && (driver.id === "claude-code" ? /^[0-9a-f-]{36}$/i.test(previous) : true);
      const sessionId = resume ? previous! : randomUUID();
      const attempt = o.claim ? Math.max(1, o.attempt ?? rt.attempt) : (claimed?.attempt ?? Math.max(1, rt.attempt));
      const mode = state.contract?.workers;

      const reg = await this.store.transact<string | null>(({ state: s }) => {
        const p = this.startProblem(s, task, agent, o.claim, o.reopen);
        if (p) return { events: pre, result: p };
        const gate = canRespawn(s, Date.now(), this.observations(s), { task, agent, driver: driver.id });
        if (!gate.ok || remainingUsd(s, { task, agent }) < 0.01 || s.contract?.version !== state.contract?.version) return { events: pre, result: "the spawn gate changed" };
        budgetUsd = remainingUsd(s, { task, agent });
        const events: AnyEventDraft[] = [
          ...pre,
          {
            type: "agent.registered",
            source: this.source,
            payload: { agent, persona: spec.persona, driver: driver.id, token_sha256: files.token_sha256, external: false, budget_usd: budgetUsd, ...(spec.team && { team: spec.team }) },
          },
        ];
        if (o.claim) events.push({ type: "task.claimed", source: this.source, payload: { task, agent, attempt, ttl_s: 0 } });
        if (spec.paths.write.length) {
          const queued = s.lease_queue.some((q) => q.agent === agent && q.task === task);
          const d = decideLeaseRequest(s, { agent, task, paths: spec.paths.write, mode: "exclusive", reason: `the write scope of task ${task}` });
          if ("grant" in d) {
            if (!d.existing) events.push(leaseDrafts.granted(d.grant, this.source));
          } else if (!queued) events.push(leaseDrafts.queued(d.queue, this.source));
        }
        return { events, result: null };
      });
      pre = [];
      if (reg.result) { removeWorkerMcpConfig(this.execution, agent); return false; }
      registered = true;
      await writeAgentLeases(this.store, agent, { task });
      const after = await this.store.state();
      const finalGate = canRespawn(after, Date.now(), this.observations(after), { task, agent, driver: driver.id });
      if (this.stopping || after.status !== "running" || after.paused_tasks.includes(task) || after.contract?.version !== state.contract?.version || !finalGate.ok || remainingUsd(after, { task, agent }) < 0.01) {
        removeWorkerMcpConfig(this.execution, agent);
        await this.commit([{ type: "agent.exited", source: this.source, payload: { agent, task, code: null, reason: "lost", result_subtype: "launch_interrupted" } }]);
        return false;
      }
      const sinceSeq = this.lastSeq((e) => e.type === "agent.spawned" && e.payload.task === task);
      const immediate: TaskCardOptions["immediate"] | undefined =
        o.immediate ?? (sinceSeq > 0 ? respawnContext(after, task, { sinceSeq, why: o.why ?? rt.last_note ?? "Your previous worker run ended before the task was done." }) : undefined);
      const card = buildTaskCard(after, task, { ...(immediate && { immediate }), ...cardLessons(after, task) });
      const outputPath = join(files.runsDir, `${attempt}.jsonl`);
      const startOffset = fileSize(outputPath);
      const launch: WorkerLaunch = {
        execution: this.execution,
        agent,
        task,
        attempt,
        cwd: wt.path,
        prompt: card,
        appendPromptPath: files.promptPath,
        mcpConfigPath: files.mcpConfigPath,
        connectors: state.contract?.connectors,
        settingsPath: files.settingsPath,
        ...(mode?.model && { model: mode.model }),
        ...(mode?.fallback_model && { fallbackModel: mode.fallback_model }),
        ...(spec.effort && { effort: spec.effort }),
        budgetUsd: Math.min(budgetUsd, remainingUsd(after, { task, agent })),
        sessionId,
        outputPath,
        env: { ROUNDTABLE_LAUNCH_INTENT: join(agentDir(this.execution, agent), "launch.json"), ROUNDTABLE_LAUNCH_SHA: files.token_sha256 },
        timeoutMs: Math.round((state.contract?.budget.wall_clock_min ?? 120) * 60_000),
      };
      const record: WorkerRecord = { agent, task, attempt, pid: 0, sessionId, outputPath, startedAt: new Date().toISOString(), driver: driver.id, cwd: wt.path };
      const intentRun: RunFile = {
        v: 1, agent, task, attempt, driver: driver.id, pid: 0, pgid: 0,
        session_id: sessionId, output: outputPath, cwd: wt.path, offset: startOffset,
        start_offset: startOffset, started_at: record.startedAt, resumed: resume,
      };
      writeFileAtomic(launch.env.ROUNDTABLE_LAUNCH_INTENT, JSON.stringify({
        token_sha256: files.token_sha256, at: record.startedAt, run: intentRun,
      }) + "\n");
      const handle = resume ? await driver.resume(record, launch) : await driver.launch(launch);
      const t: Tracked = {
        agent,
        task,
        attempt,
        driver: driver.id,
        pid: handle.pid,
        pgid: handle.pgid ?? handle.pid,
        started: handle.started ?? processStart(handle.pid) ?? undefined,
        sessionId: handle.sessionId,
        outputPath,
        cwd: wt.path,
        startOffset,
        startedAt: Date.now(),
        monitor: this.monitorFor(driver, agent, task, outputPath, startOffset, mode?.model),
        adopted: false,
        resumed: resume,
      };
      this.workers.set(agent, t);
      void workerExit(handle.pid)?.then((e) => {
        t.exit ??= e;
      });
      this.writeRun(t);
      await this.commit([
        { type: "agent.spawned", source: this.source, payload: { agent, task, attempt, pid: handle.pid, started: t.started, ...(driver.id === "claude-code" && { session_id: handle.sessionId }) } },
      ]);
      await this.refreshLog();
      this.say(`${resume ? "resumed" : "started"} ${agent} on ${task} (attempt ${attempt}, pid ${handle.pid}, $${budgetUsd.toFixed(2)} budget)`);
      return true;
    } catch (e) {
      this.say(`could not start a worker on ${task}: ${errText(e)}`);
      if (e instanceof SubmodulesUnsupportedError) {
        await this.store
          .transact(({ state: s }) => ({ events: [...pre, ...runnerEscalation(s, { key: `submodules:${task}`, task, kind: "blocker", summary: e.message, block: true }, this.source)] }))
          .catch(() => undefined);
        pre = [];
      }
      await flush().catch((x) => this.say(`committing the previous run's exit: ${errText(x)}`));
      const pending = registered && !this.workers.has(agent)
        ? await reconcileLaunch(join(agentDir(this.execution, agent), "launch.json")).catch(() => undefined) : null;
      if (!this.workers.has(agent) && pending === null) removeWorkerMcpConfig(this.execution, agent);
      if (registered && !this.workers.has(agent) && pending === null) {
        // Registered and claimed but nothing runs: an exit lets the watchdog retry it (and count it).
        await this.commit([{ type: "agent.exited", source: this.source, payload: { agent, task, code: null, reason: "error", result_subtype: "spawn_failed" } }]).catch(() => undefined);
      }
      return this.workers.has(agent);
    } finally {
      if (trial) this.trialReservations.delete(trial);
      this.busy.delete(agent);
      this.starting.delete(task);
    }
  }

  private monitorFor(driver: WorkerDriver, agent: string, task: string, path: string, offset: number, model?: string, checkpoint?: MonitorCheckpoint): RunMonitor {
    return new RunMonitor({
      path,
      parse: (line, acc) => driver.parse(line, acc),
      agent,
      task,
      source: this.source,
      expected: driver.id === "claude-code" ? { ...WORKER_ATTESTATION, mcpServers: [...WORKER_ATTESTATION.mcpServers, ...(this.contractConnectors ?? [])] } : null,
      provider: driver.id,
      ...(model && { model }),
      offset,
      ...(checkpoint && { checkpoint }),
    });
  }

  /** RunnerContext.resumeTask: WS10 resumes a blocked or waiting task with a resolution. */
  private async resumeTask(task: string, immediate?: TaskCardOptions["immediate"]): Promise<boolean> {
    const state = await this.store.state();
    const im = typeof immediate === "string" ? { kind: "note" as const, text: immediate } : immediate;
    if (this.hasLiveWorker(task)) return false;
    const claim = own(state.claims, task);
    if (claim) {
      // The previous run's exit, if this process still tracks it, goes in with the re-registration.
      return this.startWorker(task, { claim: false, ...(im && { immediate: im }) });
    }
    return this.startWorker(task, { claim: true, ...(im && { immediate: im }) });
  }

  /** Process operations an orchestrator tool handed over (handoff.ts: resolve_escalation's resume, retry and kill). */
  private async applyHandoffs(): Promise<void> {
    await this.applyResolutionOps(takeHandoffs(this.execution), "handed-over");
  }

  /**
   * A resolution's process operations, from a handoff or a hook: kills first, then resumes and
   * retries. Each is done once per process by its deterministic key, shared by both paths (a hook
   * may offer again what was handed over). One that could not start now (paused, the respawn gate,
   * a live worker) or failed is forgotten, so a later offer of it (the escalation pass) applies it.
   */
  async applyResolutionOps(ops: readonly ProcessOp[], from: string): Promise<void> {
    const kills = ops.filter((op) => op.type === "kill_worker");
    for (const op of [...kills, ...ops.filter((op) => op.type !== "kill_worker")]) {
      const key = `resolution\0${op.type}\0${op.key}`;
      if (this.opsDone.has(key)) { acknowledgeHandoff(this.execution, op); continue; }
      this.opsDone.add(key);
      try {
        let done = true;
        if (op.type === "kill_worker") await this.killWorker(op.agent, "killed", op.reason);
        else if (op.type === "resume_worker") done = await this.resumeTask(op.task, { kind: "resolution", text: op.card });
        else done = await this.resumeTask(op.task, { kind: "resolution", text: `Retry attempt ${op.attempt} after escalation resolution. Re-read the contract and your task.` });
        if (op.type === "kill_worker") {
          const t = this.workers.get(op.agent);
          const rec = own((await this.store.state()).agents, op.agent);
          done = t ? !!t.exit || !processMatches(t.pid, t.started) :
            rec?.pid === undefined || !processMatches(rec.pid, rec.started);
        }
        if (!done) this.opsDone.delete(key);
        else acknowledgeHandoff(this.execution, op);
      } catch (e) {
        this.opsDone.delete(key);
        this.say(`${from} ${op.type} ${op.target}: ${errText(e)}`);
      }
    }
  }

  // ==========================================================================
  // Resume reconciliation (heads-down.md §3)
  // ==========================================================================

  /**
   * After the chain verified and the store replayed: adopt every runner worker whose pid still
   * lives (tailing its output from run.json's offset, with the attestation it already had), and
   * for each claimed task whose worker died, commit its WIP (rt: wip snapshot, leased paths only),
   * record agent.exited {lost} and resume its session with an "interrupted" card (a fresh session
   * with the WIP diff stat when the session is gone). Lease files are rewritten (TTLs restart).
   */
  private async reconcile(): Promise<void> {
    const state = await this.store.state();
    this.contractConnectors = state.contract?.connectors;
    for (const [agent, rec] of Object.entries(state.agents)) {
      if (this.workers.has(agent) || this.busy.has(agent) || rec.external || (rec.status !== "running" && rec.status !== "registered")) continue;
      let run = readRunFile(this.execution, agent);
      const pending = await reconcileLaunch(join(agentDir(this.execution, agent), "launch.json"));
      if (pending === undefined) continue;
      if (pending && (!run || run.pid !== pending.pid || run.started !== pending.started)) run = pending;
      const claim = Object.values(state.claims).find((c) => c.agent === agent);
      const task = claim?.task ?? rec.task ?? run?.task;
      const pid = pending?.pid ?? (rec.status === "running" ? rec.pid : run?.pid);
      const started = pending?.started ?? run?.started ?? rec.started;
      const alive = pid !== undefined && processMatches(pid, started) && (!run || run.pid === pid);
      try {
        if (alive && !run && task !== undefined && pid !== undefined) {
          const spawned = [...this.log].reverse().find((e) => e.type === "agent.spawned" && e.payload.agent === agent);
          const attempt = claim?.attempt ?? state.tasks[task]?.attempt ?? 1;
          run = {
            v: 1, agent, task, attempt, driver: rec.driver, pid, pgid: pid, started,
            session_id: rec.session_id ?? "", output: join(agentDir(this.execution, agent), "runs", `${attempt}.jsonl`),
            cwd: taskWorktreePath(this.execution, task), offset: 0, start_offset: 0,
            started_at: spawned?.ts ?? new Date().toISOString(), resumed: false,
          };
        }
        if (alive && run && task !== undefined) {
          registerWorkerSecrets(this.execution, agent);
          await this.adopt(agent, run, rec.status === "registered");
          continue;
        }
        removeWorkerMcpConfig(this.execution, agent);
        if (!claim) {
          if (rec.status === "running") await this.commit(this.lostDrafts(agent, rec.task ?? run?.task, run));
          continue;
        }
        await this.recoverLost(agent, claim.task, run, rec.status === "running");
      } catch (e) {
        this.say(`reconciling ${agent}: ${errText(e)}`);
      }
    }
    for (const c of Object.values(state.claims)) {
      try {
        await writeAgentLeases(this.store, c.agent, { task: c.task });
      } catch {
        /* an external agent without a directory yet */
      }
    }
  }

  /** Keep tailing a live worker an earlier runner started. */
  private async adopt(agent: string, run: RunFile, registeredOnly: boolean): Promise<void> {
    const driver = this.drivers[run.driver] ?? this.driver();
    const spawnSeq = this.lastSeq((e) => e.type === "agent.spawned" && e.payload.agent === agent);
    const after = this.log.filter((e) => e.seq > spawnSeq);
    const attestedEv = after.find((e) => e.type === "agent.attested" && e.payload.agent === agent);
    const skip = {
      attested: attestedEv !== undefined || run.attested !== undefined,
      usage: after.some((e) => e.type === "budget.usage_recorded" && e.payload.source === "worker" && e.payload.agent === agent),
    };
    const state = await this.store.state();
    const t: Tracked = {
      agent,
      task: run.task,
      attempt: run.attempt,
      driver: driver.id,
      pid: run.pid,
      pgid: run.pgid,
      started: run.started,
      sessionId: run.session_id,
      outputPath: run.output,
      cwd: run.cwd,
      startOffset: run.start_offset,
      startedAt: Date.parse(run.started_at) || Date.now(),
      lastOutputAt: Date.now(),
      monitor: this.monitorFor(driver, agent, run.task, run.output, run.monitor ? run.offset : run.start_offset, state.contract?.workers.model, run.monitor),
      adopted: true,
      resumed: run.resumed,
      skip,
      ...(attestedEv?.type === "agent.attested" ? { attested: attestedEv.payload.ok } : run.attested !== undefined ? { attested: run.attested } : {}),
    };
    this.workers.set(agent, t);
    if (registeredOnly) {
      // It started, but the runner died before agent.spawned was committed.
      await this.commit([{ type: "agent.spawned", source: this.source, payload: { agent, task: run.task, attempt: run.attempt, pid: run.pid, started: run.started, ...(driver.id === "claude-code" && { session_id: run.session_id }) } }]);
    }
    this.say(`adopted ${agent} on ${run.task} (pid ${run.pid}, attempt ${run.attempt}, from byte ${run.offset})`);
    if (t.attested === false) await this.attestationFailed(t, ["its attestation failed before the runner restarted"]);
  }

  /** The rest of a dead run's output (usage it reported) and its agent.exited {lost}. */
  private lostDrafts(agent: string, task: string | undefined, run: RunFile | null): AnyEventDraft[] {
    if (run && task !== undefined && run.task === task) {
      const driver = this.drivers[run.driver] ?? this.driver();
      const spawnSeq = this.lastSeq((e) => e.type === "agent.spawned" && e.payload.agent === agent);
      const after = this.log.filter((e) => e.seq > spawnSeq);
      const t = {
        skip: {
          attested: after.some((e) => e.type === "agent.attested" && e.payload.agent === agent) || run.attested !== undefined,
          usage: after.some((e) => e.type === "budget.usage_recorded" && e.payload.source === "worker" && e.payload.agent === agent),
        },
      } as Tracked;
      const m = this.monitorFor(driver, agent, task, run.output, run.monitor ? run.offset : run.start_offset, undefined, run.monitor);
      return this.unseen(t, m.finish({ code: null, reason: "lost" }));
    }
    return [{ type: "agent.exited", source: this.source, payload: { agent, ...(task !== undefined && { task }), code: null, reason: "lost" } }];
  }

  /** A claimed task whose worker is gone: snapshot its WIP, record the loss, resume it interrupted. */
  private async recoverLost(agent: string, task: string, run: RunFile | null, wasRunning: boolean): Promise<void> {
    const state = await this.store.state();
    let wipCommit: string | undefined;
    let wipStat: string | undefined;
    const wt = taskWorktreePath(this.execution, task);
    const phase = own(state.tasks, task)?.state;
    if (existsSync(wt) && !["merging", "submitted", "checking"].includes(phase ?? "")) {
      try {
        const snap = await snapshotWip(wt, "rt: wip snapshot", leasesFor(state, task));
        if (snap.created) wipCommit = snap.commit;
        wipStat = (await taskDiffSummary(wt, integrationBranch(this.execution))).stat || undefined;
      } catch (e) {
        this.say(`WIP snapshot of ${task}: ${errText(e)}`);
      }
    }
    const pre = this.lostDrafts(agent, task, run);
    if (phase === "merging") { await this.commit(pre); return; }
    if (phase === "submitted" || phase === "checking") {
      pre.push({ type: "task.rejected", source: this.source, payload: {
        task, reasons: ["Submission checks were interrupted by process loss; submit again to rerun checks of the committed work."],
      } });
    }
    const stopWaiting = own(state.agents, agent)?.stop?.state === "requested";
    this.say(`${agent} on ${task} is gone${wipCommit ? ` (WIP saved as ${wipCommit.slice(0, 12)})` : ""}; ${stopWaiting ? "a stop for it is waiting, so it is not resumed" : "resuming it"}`);
    const why = wasRunning
      ? "The runner restarted and your worker process was gone. Your session is resumed."
      : "The runner restarted before your worker was started.";
    await this.startWorker(task, {
      claim: false,
      preDrafts: pre,
      reopen: phase === "submitted" || phase === "checking",
      immediate: interruptedContext({ why, ...(wipStat && { wipStat }), ...(wipCommit && { wipCommit }) }),
    });
  }

  // ==========================================================================
  // The sandbox (integration checks), visibility, the end of the run
  // ==========================================================================

  /** One backend for the runner's own checks, chosen once; sandbox.degraded is recorded when weaker than docker. */
  sandbox(): Promise<SandboxBackend> {
    if (this.opts.sandbox) return Promise.resolve(this.opts.sandbox);
    this.sandboxP ??= (async () => {
      const state = await this.store.state();
      const c = state.contract;
      const allowLocal = localSandboxAllowed() || this.started()?.sandbox === "local";
      const sel = await selectBackend({
        preferred: c?.sandbox.backend,
        allowLocal,
        docker: new DockerBackend({ executionTag: executionTag(this.execution), ...(c?.sandbox.image && { image: c.sandbox.image }) }),
        ...(allowLocal && { local: new LocalBackend({ env: { ...process.env, [SANDBOX_ENV.ALLOW_LOCAL]: "1" } }) }),
      });
      if (sel.degraded) await this.commit([{ type: "sandbox.degraded", source: this.source, payload: { backend: sel.backend.id, reason: scrubAndCap(sel.degraded, 2000) } }]);
      return sel.backend;
    })();
    this.sandboxP.catch(() => {
      this.sandboxP = undefined;
    });
    return this.sandboxP;
  }

  /** Command ids run on the integration branch after each merge: the option, ROUNDTABLE_SMOKE_CHECKS, else validation.final. */
  integrationCheckIds(state: Readonly<BlackboardState>): string[] {
    const known = new Set((state.contract?.validation.commands ?? []).map((c) => c.id));
    const env = process.env.ROUNDTABLE_SMOKE_CHECKS;
    const ids = this.opts.integrationChecks ?? (env !== undefined ? env.split(",").map((s) => s.trim()).filter(Boolean) : state.contract?.validation.final ?? []);
    return ids.filter((id) => known.has(id));
  }

  private visibility(): Visibility | undefined {
    return this.started()?.visibility;
  }

  private async startVisibility(): Promise<void> {
    const v = this.visibility();
    if (v?.dashboard) {
      try {
        this.dashboard = await startDashboard(this.execution, { store: this.store, onStopRequested: () => this.wakeNow() });
        this.say("dashboard started (its URL is in dashboard.json)");
      } catch (e) {
        this.say(`dashboard: ${errText(e)}`);
      }
    }
    if (v?.github?.repo) {
      const g = v.github;
      this.github = new GitHubSync({
        executionId: this.execution,
        repo: g.repo,
        store: this.store,
        ...(g.project_owner && { projectOwner: g.project_owner }),
        ...(g.project_number !== undefined && { projectNumber: g.project_number }),
        ...(g.create_project !== undefined && { createProject: g.create_project }),
        ...(g.pr !== undefined && { pr: g.pr }),
      });
      const sync = () => {
        void this.github!.syncOnce().then((r) => {
          if (!r.ok && r.degraded) this.say(`GitHub sync degraded: ${(r.errors ?? []).slice(0, 2).join("; ")}`);
        });
      };
      sync();
      this.githubTimer = setInterval(sync, this.opts.githubSyncMs);
    }
  }

  githubSettings(): Visibility["github"] | undefined {
    return this.visibility()?.github;
  }

  /**
   * execution.failed when a task failed and nothing is left that could still change that: no open
   * escalation (WS10 decides on those), no live or starting worker, nothing ready or in flight.
   */
  private async checkFailure(state: Readonly<BlackboardState>): Promise<void> {
    if (state.status !== "running" && state.status !== "paused") return;
    const failed = Object.values(state.tasks).filter((rt) => rt.state === "failed");
    if (!failed.length) return;
    if (Object.values(state.escalations).some((e) => OPEN_ESCALATION.has(e.status))) return;
    if (this.workers.size || this.starting.size || this.merge.busy()) return;
    if (Object.values(state.tasks).some((rt) => rt.state === "ready" || rt.state === "merging" || ACTIVE_TASK.has(rt.state))) return;
    const why = failed.map((rt) => `${rt.spec.id}${rt.last_note ? ` (${rt.last_note.slice(0, 200)})` : ""}`).join("; ");
    await this.store.transact(({ state: s }) => {
      if (TERMINAL_RUN.has(s.status)) return { events: [] };
      return { events: [{ type: "execution.failed", source: this.source, payload: { reason: `Failed tasks with nothing left open: ${why}` } }] };
    });
    this.say(`the run failed: ${why}`);
  }

  /** The exit code of run(). */
  setExitCode(code: number): void {
    this.exitCode = code;
  }

  /** Track a background promise (merges, hooks) so shutdown can wait for it briefly. */
  background<T>(p: Promise<T>): Promise<T> {
    return this.track(p);
  }
}

// ============================================================================
// Entry point
// ============================================================================

/** Run the runner of an execution until it stops; resolves with the process exit code. */
export async function runRunner(execution: string, opts: RunnerOptions = {}): Promise<number> {
  const raw = process.env.ROUNDTABLE_EXECUTION_PROVIDER?.trim();
  const llm = raw && raw !== "auto" ? executionLLM() : undefined;
  // The health cache lives in this process: probe once so the runner does not route blind. Failure is not a refusal.
  if (opts.hooks === undefined && process.env.ROUNDTABLE_SKIP_EXECUTION_PREFLIGHT !== "1") {
    const failure = await seedExecutionProvider();
    if (failure) console.error(`agent-roundtable run: provider judgment found no healthy provider yet (${scrubAndCap(failure, 300)}); model calls will retry.`);
  }
  if (llm?.unknown) console.error(`agent-roundtable run: ROUNDTABLE_EXECUTION_PROVIDER ${JSON.stringify(llm.unknown.slice(0, 40))} is not a provider (${PROVIDER_IDS.join(", ")}); using ${llm.provider}`);
  // The real hooks: escalation routing, huddles, the lead fallback and goal review (WS10).
  const r = new Runner(execution, { ...opts, hooks: opts.hooks ?? createRunnerHooks(), signals: false });
  const onSignal = (sig: string) => r.stop(`signal ${sig}`);
  if (opts.signals) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  try {
    try {
      await r.start();
    } catch (e) {
      console.error(`agent-roundtable run: ${errText(e)}`);
      return e instanceof RunnerRefusal ? e.exitCode : 1;
    }
    return await r.run();
  } finally {
    if (opts.signals) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }
}
