// ============================================================================
// The orchestrator's run controls (heads-down.md §13): execute, control_execution, resolve_escalation
//
// execute    Preflight: visibility, budget, sandbox, the worker CLI, gh scopes, submodules (a dirty
//            main worktree only warns). Anything missing returns needs_input with plain-language
//            questions and changes nothing. Otherwise the settings the human gave are applied to the
//            frozen contract (one audited amendment with override_consent), execution.started records
//            the human's confirmation verbatim (and so does the audit log), and the runner starts.
//            A run that already started returns its current info.
// control    pause / resume, for the run or for tasks (to_table: true records execution.mode_changed,
//            to the table on pause and back on resume); steer (execution.steered + directive.issued);
//            abort (execution.aborted, the workers' process groups stopped, worktrees and the log
//            kept); purge (run-admin's purge: terminal runs only, confirm: true, audited).
// resolve    WS10's resolveEscalation in this process; its process operations go to the runner
//            through handoff.ts.
//
// Every tool that touches a live run calls ensureRunner. No provider call runs inside transact.
// Tests replace the pieces that reach outside the store (runner, sandbox probe, CLI detection, gh,
// process groups) with setOrchestratorDeps.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, defaultBudgetUsd, defaultVisibility, type LLMProvider } from "../config.js";
import { checkGhReady, isRepoName, type GhReadiness } from "../github/gh.js";
import { executionTag, newId } from "../ids.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { DockerBackend, LocalBackend, SANDBOX_ENV, SandboxUnavailableError, selectBackend } from "../sandbox/index.js";
import { localSandboxAllowed } from "../sandbox/common.js";
import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { ClaudeCodeDriver } from "../workers/claude-code.js";
import { CodexDriver } from "../workers/codex.js";
import { reconcileLaunch } from "../workers/launch-intent.js";
import { agentDir } from "../workers/files.js";
import { stopGroup } from "../workers/process.js";
import { amendContract } from "./contract-lifecycle.js";
import { openContractStore, orchestratorSource } from "./contract-state.js";
import { BUDGET_FALLBACK } from "./contract.js";
import { resolveEscalation, type HookCtx, type HuddleLLM } from "./escalation.js";
import { assertNoGitlinksInIndex, assertNoGitlinksInTree, openRepo, runGit, splitZ, SubmodulesUnsupportedError } from "./git.js";
import { processMatches } from "./lock.js";
import { writeHandoff } from "./handoff.js";
import { PurgeRefusal, purgeExecution } from "./run-admin.js";
import { ensureRunner, launchRunner, runnerLiveness, type EnsureRunnerResult } from "./runner-launch.js";
import { executionDir, openExecutionStore, type FileExecutionStore } from "./store.js";
import type {
  AnyEventDraft,
  BlackboardState,
  Contract,
  HuddleFormat,
  ResolutionAction,
  SandboxBackendId,
  Visibility,
  WorkerRecord,
} from "./types.js";
import { WATCH_DEFAULT_TIMEOUT_MIN } from "./watch.js";
import { executionWorktreesDir } from "./worktrees.js";

type Json = Record<string, unknown>;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const own = <V>(map: Readonly<Record<string, V>>, key: string | undefined): V | undefined =>
  key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

function cap(text: string | undefined, max: number): string {
  const t = scrub((text ?? "").trim());
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ============================================================================
// Seams
// ============================================================================

export interface SandboxProbe {
  preferred?: SandboxBackendId;
  allowLocal: boolean;
  executionTag: string;
  image?: string;
}

export type WorkerCli = "claude-code" | "codex";

export interface OrchestratorDeps {
  launchRunner(exe: string): { pid: number };
  ensureRunner(exe: string): Promise<EnsureRunnerResult>;
  /** The backend the runner would pick (throws SandboxUnavailableError when there is none). */
  selectSandbox(p: SandboxProbe): Promise<{ backend: SandboxBackendId; degraded?: string }>;
  detectDriver(id: WorkerCli): Promise<{ ok: boolean; missing: string[]; version?: string }>;
  checkGh(opts: Parameters<typeof checkGhReady>[0]): Promise<GhReadiness>;
  stopGroup(pgid: number, graceMs: number, started?: string): Promise<void>;
  /** How long execute waits for the runner's dashboard.json before answering without its URL. */
  dashboardWaitMs: number;
}

const DEFAULT_DEPS: OrchestratorDeps = {
  launchRunner: (exe) => launchRunner(exe),
  ensureRunner: (exe) => ensureRunner(exe),
  async selectSandbox(p) {
    const sel = await selectBackend({
      preferred: p.preferred,
      allowLocal: p.allowLocal,
      docker: new DockerBackend({ executionTag: p.executionTag, ...(p.image && { image: p.image }) }),
      ...(p.allowLocal && { local: new LocalBackend({ env: { ...process.env, [SANDBOX_ENV.ALLOW_LOCAL]: "1" } }) }),
    });
    return { backend: sel.backend.id, ...(sel.degraded && { degraded: sel.degraded }) };
  },
  detectDriver: (id) => (id === "codex" ? new CodexDriver() : new ClaudeCodeDriver()).detect(),
  checkGh: (opts) => checkGhReady(opts),
  stopGroup: (pgid, graceMs, started) => stopGroup(pgid, graceMs, started),
  dashboardWaitMs: 5_000,
};

let deps: OrchestratorDeps = { ...DEFAULT_DEPS };

/** Replace some of the pieces that reach outside the store (tests). Returns a function that restores them. */
export function setOrchestratorDeps(over: Partial<OrchestratorDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...over };
  return () => {
    deps = previous;
  };
}

/** The current seams (execution_status shares ensureRunner with these tools). */
export function orchestratorDeps(): OrchestratorDeps {
  return deps;
}

// ============================================================================
// The watcher command and the dashboard URL
// ============================================================================

const CLI_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** How the orchestrator waits for the run: `agent-roundtable watch <exe> --as <orchestrator>` as a background command. */
export function watchSpec(exe: string, orchestrator: string): { argv: string[]; command: string; instructions: string } {
  const argv = [process.execPath, CLI_PATH, "watch", exe, "--as", orchestrator];
  const command = argv.map(shellQuote).join(" ");
  return {
    argv,
    command,
    instructions:
      `Start the watcher now as a BACKGROUND shell command (in Claude Code: the Bash tool with run_in_background: true), exactly as given: ${command} ` +
      `(this is \`agent-roundtable watch ${exe} --as ${orchestrator}\`). It prints one JSON line and exits when you are needed: an escalation routed to you, ` +
      `something awaiting the human, the budget past 80%, the end of the run, or ${WATCH_DEFAULT_TIMEOUT_MIN} minutes without news. ` +
      "When it wakes you, handle the reason (execution_status, resolve_escalation, control_execution, or ask the human), then start the same command again in the background: " +
      "re-arm it after every wake until the run has ended. While it waits, answer the human's questions about progress with execution_status (focus: \"nav\" answers \"how close is the nav?\") " +
      "instead of reading files or logs, and keep talking with the human as usual.",
  };
}

/** dashboard.json's URL while the dashboard's process lives on, else undefined. */
export function dashboardUrl(exe: string): string | undefined {
  try {
    const d = JSON.parse(readFileSync(join(executionDir(exe), "dashboard.json"), "utf8")) as { url?: unknown; pid?: unknown };
    if (typeof d.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(d.url)) return undefined;
    if (typeof d.pid === "number" && !pidAlive(d.pid)) return undefined;
    return d.url;
  } catch {
    return undefined;
  }
}

async function waitForDashboard(exe: string, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const url = dashboardUrl(exe);
    if (url || Date.now() >= deadline) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ============================================================================
// execute
// ============================================================================

export interface VisibilityInput {
  dashboard?: boolean;
  chat_only?: boolean;
  github?: { repo: string; project_owner?: string; project_number?: number; create_project?: boolean; pr?: boolean };
}

export interface ExecuteInput {
  contract_id: string;
  confirmation: string;
  visibility?: VisibilityInput;
  budget_usd?: number;
  max_parallel?: number;
  lead?: string;
  sandbox?: SandboxBackendId;
  worker_driver?: WorkerCli;
  worker_model?: string;
}

export interface PreflightQuestion {
  topic: "visibility" | "budget" | "sandbox" | "workers" | "github" | "repository";
  /** Plain language, for the orchestrator to put to the human. */
  question: string;
  /** How the answer goes back into execute. */
  answer_with?: string;
}

function githubOf(g: VisibilityInput["github"]): Visibility["github"] | undefined {
  if (!g) return undefined;
  const repo = g.repo.trim();
  if (!isRepoName(repo)) throw new Error(`execute: "visibility.github.repo" must be a repository as owner/name, not ${JSON.stringify(repo.slice(0, 80))}`);
  return {
    repo,
    ...(typeof g.project_owner === "string" && g.project_owner.trim() && { project_owner: g.project_owner.trim() }),
    ...(typeof g.project_number === "number" && { project_number: g.project_number }),
    ...(typeof g.create_project === "boolean" && { create_project: g.create_project }),
    ...(typeof g.pr === "boolean" && { pr: g.pr }),
  };
}

/** ROUNDTABLE_DEFAULT_VISIBILITY: a comma list of dashboard, chat_only (or chat) and github:<owner/name>. */
export function parseVisibility(raw: string): { value?: Visibility; problem?: string } {
  const v: Visibility = { dashboard: false, chat_only: false };
  for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
    const t = token.toLowerCase();
    if (t === "dashboard") v.dashboard = true;
    else if (t === "chat_only" || t === "chat") v.chat_only = true;
    else if (t.startsWith("github:") && isRepoName(token.slice(7).trim())) v.github = { repo: token.slice(7).trim() };
    else return { problem: `unknown entry ${JSON.stringify(token.slice(0, 80))} (expected dashboard, chat_only or github:<owner/name>)` };
  }
  if (v.chat_only && (v.dashboard || v.github)) return { problem: "chat_only cannot be combined with dashboard or github" };
  return v.dashboard || v.chat_only || v.github ? { value: v } : {};
}

function resolveVisibility(arg: VisibilityInput | undefined, warnings: string[]): Visibility | undefined {
  if (arg) {
    const github = githubOf(arg.github);
    if (arg.chat_only === true && (arg.dashboard === true || github)) {
      throw new Error('execute: "visibility.chat_only" means no dashboard and no GitHub: pass chat_only alone, or the channels you want');
    }
    if (arg.dashboard === true || github || arg.chat_only === true) {
      return { dashboard: arg.dashboard === true, chat_only: arg.chat_only === true, ...(github && { github }) };
    }
  }
  const env = defaultVisibility();
  if (!env) return undefined;
  const parsed = parseVisibility(env);
  if (parsed.problem) warnings.push(`ROUNDTABLE_DEFAULT_VISIBILITY was ignored: ${parsed.problem}`);
  return parsed.value;
}

/**
 * Whether the contract's budget was set by someone. validateContract fills a missing budget.usd with
 * BUDGET_FALLBACK (and asks execute to confirm the cap), so an untouched fallback counts as unset.
 * A child contract's budget is bounded by its parent task and always counts as set.
 */
export function contractBudgetSet(c: Contract): boolean {
  if (c.scope.parent) return true;
  const b = c.budget;
  return !(b.usd === BUDGET_FALLBACK.usd && b.per_task_usd === BUDGET_FALLBACK.per_task_usd && b.wall_clock_min === BUDGET_FALLBACK.wall_clock_min);
}

const VISIBILITY_QUESTION: PreflightQuestion = {
  topic: "visibility",
  question:
    "How do you want to follow the run while it works? A live dashboard in your browser (local only), GitHub issues and a project board in a repository you name, " +
    "or nothing outside this chat (I keep you posted here)?",
  answer_with:
    'visibility: {dashboard: true}, {github: {repo: "owner/name", project_number?, create_project?, pr?}} (both are fine), or {chat_only: true}; ROUNDTABLE_DEFAULT_VISIBILITY sets a default',
};

async function probeSandbox(c: Contract, a: ExecuteInput, exe: string): Promise<{ backend?: SandboxBackendId; question?: PreflightQuestion; warning?: string }> {
  const allowLocal = localSandboxAllowed() || a.sandbox === "local";
  try {
    const sel = await deps.selectSandbox({
      preferred: a.sandbox ?? c.sandbox.backend,
      allowLocal,
      executionTag: executionTag(exe),
      ...(c.sandbox.image && { image: c.sandbox.image }),
    });
    return { backend: sel.backend, ...(sel.degraded && { warning: `Sandbox: ${sel.backend} (${sel.degraded})` }) };
  } catch (e) {
    const reasons = e instanceof SandboxUnavailableError ? e.reasons : [errText(e)];
    return {
      question: {
        topic: "sandbox",
        question:
          `Workers have no shell of their own: their commands and checks run in a sandbox, and none is available right now (${cap(reasons.join("; "), 600)}). ` +
          "Can you start Docker, or should the run use the local sandbox, which isolates less than a container?",
        answer_with: 'start Docker and call execute again, or pass sandbox: "local" (ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1 allows it for every run)',
      },
    };
  }
}

async function probeWorkers(driver: WorkerCli, explicit: WorkerCli | undefined): Promise<PreflightQuestion[]> {
  const out: PreflightQuestion[] = [];
  if (driver === "codex" && explicit !== "codex") {
    out.push({
      topic: "workers",
      question:
        "The contract asks for Codex workers. Codex keeps its own shell, so the roundtable checks its file leases only when it submits, and its cost is estimated. " +
        "Use Codex anyway, or Claude Code workers?",
      answer_with: 'worker_driver: "codex" to opt in, or worker_driver: "claude-code"',
    });
  }
  const d = await deps.detectDriver(driver).catch((e: unknown) => ({ ok: false, missing: [errText(e)] }));
  if (!d.ok) {
    const name = driver === "codex" ? "codex" : "Claude Code (claude)";
    out.push({
      topic: "workers",
      question: `The ${name} CLI that runs the workers is not ready: it needs ${cap(d.missing.join(", "), 600) || "a working install"}. Can you install or update it?`,
      answer_with: driver === "codex" ? 'install the codex CLI and call execute again, or pass worker_driver: "claude-code"' : "install or update Claude Code (claude --version), then call execute again",
    });
  }
  return out;
}

async function probeGitHub(v: Visibility | undefined): Promise<PreflightQuestion | undefined> {
  const g = v?.github;
  if (!g) return undefined;
  const project = g.project_number !== undefined
    ? { ...(g.project_owner && { owner: g.project_owner }), number: g.project_number }
    : g.create_project ? (g.project_owner ? { owner: g.project_owner } : true) : undefined;
  const r = await deps.checkGh({ repo: g.repo, ...(project !== undefined && { project }) }).catch((e: unknown) => ({ ok: false, missing: [errText(e)] }));
  if (r.ok) return undefined;
  return {
    topic: "github",
    question: `GitHub is not ready for ${g.repo}: the run needs ${cap(r.missing.join("; "), 800)}. Can you fix that, or should we follow the run another way?`,
    answer_with: "fix the gh setup and call execute again, or choose visibility: {dashboard: true} or {chat_only: true}",
  };
}

async function probeRepository(store: FileExecutionStore): Promise<{ question?: PreflightQuestion; warnings: string[] }> {
  const header = store.header();
  const warnings: string[] = [];
  try {
    const repo = await openRepo(header.repo_root);
    await assertNoGitlinksInIndex(repo);
    await assertNoGitlinksInTree(repo, header.base_sha);
  } catch (e) {
    if (e instanceof SubmodulesUnsupportedError) {
      return {
        question: {
          topic: "repository",
          question:
            `This repository uses git submodules, which heads-down runs do not support in 1.0 (${cap(e.message, 400)}). ` +
            "Should we do this work at the table instead, or will you propose the contract again for a repository without submodules?",
        },
        warnings,
      };
    }
    return { question: { topic: "repository", question: `The run's integration worktree could not be created: ${cap(errText(e), 600)}. Can you check the repository?` }, warnings };
  }
  try {
    const r = await runGit(await openRepo(header.repo_root), ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"]);
    const dirty = splitZ(r.stdout).filter((x) => x.length > 3).map((x) => x.slice(3));
    if (dirty.length) {
      warnings.push(
        `The main worktree (${header.repo_root}) has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}). ` +
          `The run builds from ${header.base_sha.slice(0, 12)}, so they are not part of it.`
      );
    }
  } catch (e) {
    warnings.push(`Could not check the main worktree for uncommitted changes: ${cap(errText(e), 300)}`);
  }
  return { warnings };
}

/** The settings the human gave that differ from the frozen contract, as a merge patch and a description. */
function settingsPatch(c: Contract, a: ExecuteInput, usd: number, driver: WorkerCli): { patch: Json; changes: string[] } {
  const patch: Json = {};
  const changes: string[] = [];
  const budget: Json = {};
  if (usd !== c.budget.usd) {
    budget.usd = usd;
    changes.push(`budget $${usd}`);
    if (c.budget.per_task_usd > usd) budget.per_task_usd = usd;
    if (c.budget.per_agent_usd !== undefined && c.budget.per_agent_usd > usd) budget.per_agent_usd = usd;
  }
  if (typeof a.max_parallel === "number" && a.max_parallel !== c.budget.max_parallel) {
    budget.max_parallel = a.max_parallel;
    changes.push(`max_parallel ${a.max_parallel}`);
  }
  if (Object.keys(budget).length) patch.budget = budget;
  const lead = a.lead?.trim();
  if (lead && lead !== c.authority.lead) {
    patch.authority = { lead };
    changes.push(`lead ${lead}`);
  }
  if (a.sandbox && a.sandbox !== c.sandbox.backend) {
    patch.sandbox = { backend: a.sandbox };
    changes.push(`sandbox ${a.sandbox}`);
  }
  const workers: Json = {};
  if (a.worker_driver && driver !== c.workers.driver) {
    workers.driver = driver;
    changes.push(`workers ${driver}`);
  }
  const model = a.worker_model?.trim();
  if (model && model !== c.workers.model) {
    workers.model = model;
    changes.push(`worker model ${model}`);
  }
  if (Object.keys(workers).length) patch.workers = workers;
  return { patch, changes };
}

/** A started (or finished) run: its current info, without preflight. ensureRunner keeps a live run held. */
async function startedInfo(store: FileExecutionStore, state: BlackboardState, warnings: string[]): Promise<Json> {
  const exe = store.id;
  const orchestrator = state.contract?.scope.orchestrator ?? "main";
  const terminal = TERMINAL.has(state.status);
  let runner: EnsureRunnerResult | undefined;
  if (!terminal) {
    try {
      runner = await deps.ensureRunner(exe);
    } catch (e) {
      warnings.push(`runner: ${errText(e)}`);
    }
  }
  const url = dashboardUrl(exe);
  return {
    status: "already_started",
    run_status: state.status,
    execution_id: exe,
    ...(state.contract && { contract_id: state.contract.id, contract_version: state.contract.version }),
    ...(runner?.pid !== undefined && { runner_pid: runner.pid }),
    ...(runner && { runner: runner.status }),
    ...(url && { dashboard_url: url }),
    ...(!terminal && { watch: watchSpec(exe, orchestrator) }),
    warnings,
    next: terminal
      ? `The run is ${state.status}: execution_status reports how it ended.`
      : "This run was already started; nothing was changed. Keep the watcher running (re-arm it if it is not) and use execution_status for progress.",
  };
}

/** execute: preflight, then start the run (heads-down.md §13). */
export async function execute(a: ExecuteInput): Promise<Json> {
  const contractId = a.contract_id.trim();
  const confirmation = a.confirmation.trim();
  if (!confirmation) throw new Error('execute: "confirmation" is required: quote the human\'s own words asking to execute');
  const warnings: string[] = [];
  const visibility = resolveVisibility(a.visibility, warnings); // argument mistakes first
  const store = await openContractStore(contractId);
  const exe = store.id;
  const state = await store.state();
  if (state.status !== "created") return startedInfo(store, state, warnings);
  const c = state.contract;
  if (!c || c.id !== contractId) {
    throw new Error(`Contract ${contractId} is not frozen: freeze_contract it once every participant agrees (only a frozen contract can be executed)`);
  }
  const orchestrator = c.scope.orchestrator;

  const questions: PreflightQuestion[] = [];
  if (!visibility) questions.push(VISIBILITY_QUESTION);
  const usd = a.budget_usd ?? (contractBudgetSet(c) ? c.budget.usd : defaultBudgetUsd());
  if (usd === undefined) {
    questions.push({
      topic: "budget",
      question: `How much may this run spend in total, in US dollars? The contract carries the default cap of $${BUDGET_FALLBACK.usd}, which nobody has confirmed.`,
      answer_with: "budget_usd: <dollars>; ROUNDTABLE_DEFAULT_BUDGET_USD sets a default",
    });
  }
  const driver: WorkerCli = a.worker_driver ?? (c.workers.driver === "codex" ? "codex" : "claude-code");
  const [sandbox, workerQuestions, github, repository] = await Promise.all([
    probeSandbox(c, a, exe),
    probeWorkers(driver, a.worker_driver),
    probeGitHub(visibility),
    probeRepository(store),
  ]);
  if (sandbox.question) questions.push(sandbox.question);
  if (sandbox.warning) warnings.push(sandbox.warning);
  questions.push(...workerQuestions);
  if (github) questions.push(github);
  if (repository.question) questions.push(repository.question);
  warnings.push(...repository.warnings);
  if (questions.length || !visibility || usd === undefined || !sandbox.backend) {
    return {
      status: "needs_input",
      execution_id: exe,
      contract_id: contractId,
      questions,
      warnings,
      next: "Nothing has started. Ask the human these questions in plain words, then call execute again with their answers (and their confirmation).",
    };
  }

  // The human's settings become part of the frozen contract the runner reads.
  const { patch, changes } = settingsPatch(c, a, usd, driver);
  let amended: { version: number; changes: string[] } | undefined;
  if (changes.length) {
    const r = await amendContract(store, patch, {
      by: orchestrator,
      reason: `Settings the human confirmed at execute: ${changes.join(", ")}`,
      contractId,
      overrideConsent: true,
    });
    warnings.push(...r.warnings);
    amended = { version: r.version, changes };
  }

  const started = await store.transact<Contract | null>(({ state: s }) => {
    if (s.status !== "created") return { events: [], result: null };
    const cur = s.contract;
    if (!cur || cur.id !== contractId) throw new Error(`Contract ${contractId} is not frozen`);
    const draft: AnyEventDraft = {
      type: "execution.started",
      source: orchestratorSource(orchestrator),
      payload: { confirmation, visibility, budget: { ...cur.budget }, lead: cur.authority.lead, sandbox: sandbox.backend!, drivers: [driver] },
    };
    return { events: [draft], result: cur };
  });
  const contract = started.result;
  if (!contract) return startedInfo(store, await store.state(), warnings);

  try {
    await appendAudit({
      actor: orchestrator,
      action: "execution.started",
      target: exe,
      details: {
        contract: contractId, version: contract.version, confirmation, visibility,
        budget_usd: contract.budget.usd, max_parallel: contract.budget.max_parallel, sandbox: sandbox.backend, driver,
        ...(amended && { amended: amended.changes }),
      },
    });
  } catch (e) {
    warnings.push(`the audit entry could not be written: ${errText(e)}`);
  }

  let runnerPid: number | undefined;
  try {
    const live = runnerLiveness(exe);
    runnerPid = live.state === "running" ? live.pid : deps.launchRunner(exe).pid;
  } catch (e) {
    warnings.push(`The runner did not start (${errText(e)}); execution_status or control_execution(action: "resume") starts it again.`);
  }
  const url = visibility.dashboard && runnerPid !== undefined ? await waitForDashboard(exe, deps.dashboardWaitMs) : undefined;
  if (visibility.dashboard && !url) warnings.push("The dashboard is still starting: execution_status reports its URL once it is up.");
  return {
    status: "started",
    execution_id: exe,
    contract_id: contractId,
    contract_version: contract.version,
    ...(runnerPid !== undefined && { runner_pid: runnerPid }),
    ...(url && { dashboard_url: url }),
    visibility,
    budget_usd: contract.budget.usd,
    max_parallel: contract.budget.max_parallel,
    sandbox: sandbox.backend,
    workers: { driver, ...(contract.workers.model && { model: contract.workers.model }) },
    ...(amended && { amended }),
    warnings,
    watch: watchSpec(exe, orchestrator),
    next:
      (url ? `Give the human the dashboard URL (${url}); it is a private capability, so do not post it anywhere public. ` : "") +
      "Start the watcher in the background now (watch.instructions), then tell the human the run has started and how to follow it.",
  };
}

// ============================================================================
// control_execution
// ============================================================================

export type ControlAction = "pause" | "resume" | "steer" | "abort" | "purge";

export interface ControlInput {
  execution_id: string;
  action: ControlAction;
  reason?: string;
  message?: string;
  task_ids?: string[];
  targets?: string[];
  confirm?: boolean;
  /** pause: going back to the table; resume: coming back from it. Records execution.mode_changed. */
  to_table?: boolean;
  /** With to_table: the at-the-table session (recorded on execution.mode_changed). */
  session?: string;
}

const ABORT_GRACE_MS = 5_000;

function taskScope(state: Readonly<BlackboardState>, ids: string[] | undefined): "all" | string[] {
  const list = [...new Set((ids ?? []).map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return "all";
  const unknown = list.filter((t) => !own(state.tasks, t));
  if (unknown.length) throw new Error(`Unknown task${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; tasks: ${Object.keys(state.tasks).join(", ") || "none"}`);
  return list;
}

const OPEN_ESCALATION: ReadonlySet<string> = new Set(["open", "routed", "in_huddle", "awaiting_human"]);

async function runnerNote(exe: string, warnings: string[]): Promise<Json | undefined> {
  try {
    const r = await deps.ensureRunner(exe);
    return { status: r.status, ...(r.pid !== undefined && { pid: r.pid }), ...(r.stale && { stale: true }) };
  } catch (e) {
    warnings.push(`runner: ${errText(e)}`);
    return undefined;
  }
}

/** control_execution (heads-down.md §13). */
export async function controlExecution(a: ControlInput): Promise<Json> {
  const exe = a.execution_id;
  if (!existsSync(join(executionDir(exe), "execution.json"))) throw new Error(`Execution ${exe} not found`);
  if (a.action === "purge") return purge(exe, a);
  const store = await openExecutionStore(exe);
  const state = await store.state();
  const c = state.contract;
  const orchestrator = c?.scope.orchestrator ?? "orchestrator";
  const source = orchestratorSource(orchestrator);
  if (TERMINAL.has(state.status)) throw new Error(`Execution ${exe} is ${state.status}: there is nothing to ${a.action}${a.action === "abort" ? "" : " (purge removes a finished run)"}`);
  const reason = a.reason?.trim() ? cap(a.reason, 1000) : undefined;
  const session = a.session?.trim() || undefined;
  const warnings: string[] = [];

  switch (a.action) {
    case "pause": {
      if (state.status === "created") throw new Error(`Execution ${exe} has not started: there is nothing to pause`);
      const scope = taskScope(state, a.task_ids);
      const why = reason ?? (a.to_table ? "back to the table" : `paused by ${orchestrator}`);
      const r = await store.transact<string[] | "all" | null>(({ state: s }) => {
        if (TERMINAL.has(s.status)) throw new Error(`Execution ${exe} is ${s.status}`);
        const events: AnyEventDraft[] = [];
        let paused: string[] | "all" | null = null;
        if (scope === "all") {
          if (s.status !== "paused") paused = "all";
        } else {
          const fresh = scope.filter((t) => !s.paused_tasks.includes(t));
          if (fresh.length) paused = fresh;
        }
        if (paused) events.push({ type: "execution.paused", source, payload: { scope: paused, reason: why } });
        if (a.to_table) events.push({ type: "execution.mode_changed", source, payload: { from: "execution", to: "deliberation", reason: why, ...(session && { session }) } });
        return { events, result: paused };
      });
      const runner = await runnerNote(exe, warnings);
      return {
        execution_id: exe,
        action: "pause",
        paused: r.result ?? [],
        ...(r.result === null && { note: scope === "all" ? "The run was already paused." : "Those tasks were already paused." }),
        ...(a.to_table && { mode: "deliberation" }),
        ...(runner && { runner }),
        warnings,
        next: a.to_table
          ? 'Workers start nothing new (running ones finish their turn). Get the context with execution_status(view: "context"), run the format at the table, then amend_contract(from_session) and control_execution(action: "resume", to_table: true).'
          : "Workers start nothing new while paused; running ones finish their current turn. control_execution(action: \"resume\") continues.",
      };
    }
    case "resume": {
      if (state.status === "created") throw new Error(`Execution ${exe} has not started: call execute`);
      const scope = taskScope(state, a.task_ids);
      const r = await store.transact<string[] | "all" | null>(({ state: s }) => {
        if (TERMINAL.has(s.status)) throw new Error(`Execution ${exe} is ${s.status}`);
        const events: AnyEventDraft[] = [];
        let resumed: string[] | "all" | null = null;
        if (scope === "all") {
          if (s.status === "paused" || s.paused_tasks.length) resumed = "all";
        } else {
          const held = scope.filter((t) => s.paused_tasks.includes(t));
          if (held.length) resumed = held;
        }
        if (resumed) events.push({ type: "execution.resumed", source, payload: { scope: resumed, ...(reason && { reason }) } });
        if (a.to_table) events.push({ type: "execution.mode_changed", source, payload: { from: "deliberation", to: "execution", reason: reason ?? "back from the table", ...(session && { session }) } });
        return { events, result: resumed };
      });
      const resumed = r.result;
      if (resumed) {
        const tasks = resumed === "all" ? state.paused_tasks : resumed;
        for (const esc of Object.values(state.escalations)) {
          if (OPEN_ESCALATION.has(esc.status) && (esc.emergency || esc.kind === "emergency") && esc.task && tasks.includes(esc.task)) {
            warnings.push(`Task ${esc.task} was paused for emergency ${esc.id} (${esc.status}), which is still open: resolve_escalation settles it.`);
          }
        }
      }
      const runner = await runnerNote(exe, warnings);
      return {
        execution_id: exe,
        action: "resume",
        resumed: resumed ?? [],
        ...(resumed === null && { note: "Nothing was paused." }),
        ...(a.to_table && { mode: "execution" }),
        ...(runner && { runner }),
        warnings,
      };
    }
    case "steer": {
      if (state.status === "created") throw new Error(`Execution ${exe} has not started: change the contract with amend_contract instead`);
      const message = a.message?.trim() ? cap(a.message, 4000) : "";
      if (!message) throw new Error('control_execution: "message" is required for steer: the directive the workers should follow');
      const targets = [...new Set((a.targets ?? []).map((t) => t.trim()).filter(Boolean))];
      const to: string[] = [];
      const unknown: string[] = [];
      for (const t of targets) {
        if (own(state.teams, t) || own(state.agents, t)) to.push(t);
        else if (own(state.tasks, t)) {
          const agent = state.tasks[t].agent ?? own(state.claims, t)?.agent;
          if (agent) to.push(agent);
          else warnings.push(`Task ${t} has no agent yet: the directive does not reach it`);
        } else unknown.push(t);
      }
      if (unknown.length) throw new Error(`Unknown target${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}: name agents, teams or tasks of the run`);
      if (!targets.length) to.push(...Object.values(state.agents).filter((x) => x.status !== "left").map((x) => x.id));
      const id = newId("dir");
      const recipients = [...new Set(to)];
      await store.transact(() => ({
        events: [
          { type: "execution.steered", source, payload: { message, targets } },
          ...(recipients.length ? [{ type: "directive.issued" as const, source, payload: { id, to: recipients, text: message, requires_ack: true } }] : []),
        ],
      }));
      if (!recipients.length) warnings.push("No agent is registered yet, so the directive reaches nobody; to change what workers will do, amend the contract.");
      const runner = await runnerNote(exe, warnings);
      return {
        execution_id: exe,
        action: "steer",
        ...(recipients.length && { directive_id: id }),
        to: recipients,
        ...(runner && { runner }),
        warnings,
        next: "Workers see the directive on their next tool call and acknowledge it; execution_status(view: \"events\") shows directive.acknowledged.",
      };
    }
    case "abort": {
      const why = reason ?? `aborted by ${orchestrator}`;
      const r = await store.transact<boolean>(({ state: s }) => {
        if (TERMINAL.has(s.status)) return { events: [], result: false };
        return { events: [{ type: "execution.aborted", source, payload: { reason: why } }], result: true };
      });
      if (!r.result) throw new Error(`Execution ${exe} already ended`);
      // The runner stops its workers when it sees the abort; stop them here too, for a runner that is gone.
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
      if (gone.length) await store.transact(() => ({ events: gone.map((x) => ({
        type: "agent.exited" as const, source, payload: { agent: x.id, ...(x.task && { task: x.task }), code: null, reason: "lost" as const },
      })) }));
      const stopped: string[] = [];
      await Promise.all(live.map(async (x) => {
        try {
          await deps.stopGroup(x.pid!, ABORT_GRACE_MS, x.started);
          stopped.push(x.id);
        } catch (e) {
          warnings.push(`could not stop ${x.id} (pid ${x.pid}): ${errText(e)}`);
        }
      }));
      try {
        await appendAudit({ actor: orchestrator, action: "execution.aborted", target: exe, details: { reason: why, stopped } });
      } catch (e) {
        warnings.push(`the audit entry could not be written: ${errText(e)}`);
      }
      return {
        execution_id: exe,
        action: "abort",
        status: "aborted",
        stopped: stopped.sort(),
        kept: { worktrees: executionWorktreesDir(exe), log: join(executionDir(exe), "events.jsonl") },
        warnings,
        next: 'The worktrees, branches and event log are kept for inspection. control_execution(action: "purge", confirm: true) removes them once the human agrees.',
      };
    }
    default:
      throw new Error(`Unknown action ${JSON.stringify(a.action)}`);
  }
}

async function purge(exe: string, a: ControlInput): Promise<Json> {
  if (a.confirm !== true) {
    throw new Error("control_execution: purge permanently deletes the run's worktrees, its rt/<tag>/* branches and its event log: ask the human, then pass confirm: true");
  }
  const store = await openExecutionStore(exe);
  const orchestrator = (await store.state()).contract?.scope.orchestrator ?? "orchestrator";
  try {
    const r = await purgeExecution(exe, { confirm: true, actor: orchestrator });
    return { execution_id: exe, action: "purge", status: r.status, worktrees: r.worktrees.length, branches: r.branches, removed: r.removedDir };
  } catch (e) {
    if (e instanceof PurgeRefusal) throw new Error(`Purge refused: ${e.message}`);
    throw e;
  }
}

// ============================================================================
// resolve_escalation
// ============================================================================

export interface ResolveInput {
  execution_id: string;
  escalation_id: string;
  action: ResolutionAction;
  decision?: string;
  format?: HuddleFormat;
  participants?: string[];
  amendment?: Record<string, unknown>;
  resolved_by?: string;
  provider?: LLMProvider;
  model?: string;
  base_url?: string;
}

/** resolve_escalation: WS10's resolver, run here, with its process operations handed to the runner. */
export async function resolveFromOrchestrator(a: ResolveInput): Promise<Json> {
  const exe = a.execution_id;
  if (!existsSync(join(executionDir(exe), "execution.json"))) throw new Error(`Execution ${exe} not found`);
  const store = await openExecutionStore(exe);
  const state = await store.state();
  if (!state.contract) throw new Error(`Execution ${exe} has no frozen contract`);
  const provider: LLMProvider = a.provider ?? "anthropic";
  const llm: HuddleLLM = { provider, model: a.model?.trim() || DEFAULT_MODELS[provider], ...(a.base_url && { baseUrl: a.base_url }) };
  const { readRunFile } = await import("./runner.js");
  const ctx: HookCtx = {
    store,
    state,
    header: store.header(),
    driver: new ClaudeCodeDriver(),
    worker: (agent: string): WorkerRecord | undefined => {
      const run = readRunFile(exe, agent);
      return run
        ? { agent: run.agent, task: run.task, attempt: run.attempt, pid: run.pid, pgid: run.pgid, sessionId: run.session_id, outputPath: run.output, startedAt: run.started_at, driver: run.driver, cwd: run.cwd }
        : undefined;
    },
    llm,
  };
  const by = a.resolved_by?.trim() || state.contract.scope.orchestrator;
  const participants = (a.participants ?? []).map((p) => p.trim()).filter(Boolean);
  const r = await resolveEscalation(ctx, a.escalation_id.trim(), {
    action: a.action,
    resolved_by: by,
    ...(typeof a.decision === "string" && { decision: a.decision }),
    ...(a.format && { format: a.format }),
    ...(participants.length && { participants }),
    ...(a.amendment && { amendment: a.amendment }),
  });
  const warnings = [...r.warnings];
  if (r.ops.length) {
    try {
      writeHandoff(exe, r.ops, by);
    } catch (e) {
      warnings.push(`the runner could not be handed ${r.ops.map((op) => op.type).join(", ")}: ${errText(e)}`);
    }
  }
  const after = await store.state();
  const runner = TERMINAL.has(after.status) ? undefined : await runnerNote(exe, warnings);
  const esc = r.escalation;
  return {
    execution_id: exe,
    escalation: {
      id: esc.id, status: esc.status, kind: esc.kind, ...(esc.task && { task: esc.task }),
      ...(esc.resolution && { resolution: { action: esc.resolution.action, decision: cap(esc.resolution.decision, 2000), by: esc.resolution.by } }),
    },
    noop: r.noop,
    ...(r.applied && { applied: r.applied }),
    ...(r.decision && { decision: r.decision }),
    ...(r.huddle && { huddle: r.huddle }),
    ...(r.amended && { amended: r.amended }),
    handed_to_runner: r.ops.map((op) => ({ type: op.type, ...("task" in op && { task: op.task }), ...("agent" in op && { agent: op.agent }) })),
    ...(runner && { runner }),
    warnings,
    ...(r.noop && { note: `Escalation ${esc.id} is ${esc.status}: nothing changed.` }),
  };
}
