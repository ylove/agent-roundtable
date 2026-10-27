// ============================================================================
// Worker files: what the runner generates for one worker, under executions/<exe>/agents/<id>/
//
//   mcp.json        the worker server and opted-in connectors (temporary resolved credentials)
//   settings.json   permission denials and the PreToolUse lease hook
//   prompt.md       persona, skills and the worker protocol (--append-system-prompt-file)
//   token           32 random bytes as hex, single use: the worker server claims and unlinks it
//   token.used      sha256 of the last token a worker server consumed (refuses a replay)
//   leases.json     the agent's live leases, rewritten on every lease change (the hook reads it)
//   inbox.cursor    the last inbox seq delivered to the agent (inbox piggyback)
//   heartbeat       rewritten on every worker tool call (claims of external workers renew on it)
//   runs/<attempt>.jsonl  the worker's stdout and stderr, appended (a restarted runner tails it)
//
// Directories are 0700 and files 0600, written atomically. The hook command and the MCP command
// are absolute paths the runner controls; paths with characters a shell would interpret are refused.
// ============================================================================

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUNDTABLE_HOME } from "../config.js";
import { loadAgent, renderSkillsSection, type LoadedAgent } from "../agents.js";
import { leasesFor } from "../execution/leases.js";
import { ID_RE, preview } from "../execution/events.js";
import { executionDir } from "../execution/store.js";
import { taskWorktreePath } from "../execution/worktrees.js";
import type { BlackboardState, ExecutionStore, LeaseMode, RuntimeDriverId, WorkerDriverId } from "../execution/types.js";
import { isRuntimeDriver, runtimeDriverName, workerProfile } from "../runtimes/worker.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { childEnv } from "../security/child-env.js";
import { configuredSecretLiterals, registerSecretLiteral, SCRUB_LITERALS_ENV } from "../security/secrets.js";
import { readUserConfig } from "../user-config.js";
import { resolveSecrets } from "../secrets/broker.js";
import { isExecutableFile } from "../executables.js";

// ============================================================================
// Names and locations
// ============================================================================

/** The worker's own MCP server. Its tools appear as mcp__roundtable__<tool>. */
export const ROUNDTABLE_SERVER = "roundtable";
/** The settings file a runtime worker reads its MCP server from (written next to mcp.json by the runtime driver). */
export const RUNTIME_SETTINGS_FILE = "runtime-settings.json";

/** Agent ids name directories, so they follow the task id rule. */
export function assertAgentId(agent: string): string {
  if (typeof agent !== "string" || !ID_RE.test(agent)) {
    throw new Error(`Not an agent id: ${preview(agent)} (lowercase letters, digits, '.', '_' or '-'; at most 64)`);
  }
  return agent;
}

/** executions/<exe>/agents/<agent>, without creating it. */
export function agentDir(execution: string, agent: string): string {
  return join(executionDir(execution), "agents", assertAgentId(agent));
}

/** Create the agent directory (0700). Never recreates a purged execution: its header must exist. */
export function ensureAgentDir(execution: string, agent: string): string {
  const exe = executionDir(execution);
  if (!existsSync(join(exe, "execution.json"))) throw new Error(`Execution ${execution} not found`);
  mkdirPrivate(join(exe, "agents"));
  const dir = agentDir(execution, agent);
  mkdirPrivate(dir);
  return dir;
}

/** The built CLI (dist/index.js) that worker servers and hooks run. */
export function defaultCliPath(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

// ============================================================================
// Tokens
// ============================================================================

export const TOKEN_RE = /^[0-9a-f]{64}$/;

export function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 32 random bytes as hex, and the sha256 that agent.registered records. */
export function newAgentToken(): { token: string; sha256: string } {
  const token = randomBytes(32).toString("hex");
  return { token, sha256: tokenSha256(token) };
}

// ============================================================================
// mcp.json and settings.json (pure)
// ============================================================================

/** Characters a path may contain to be placed in a shell command (the hook) without surprises. */
const SAFE_PATH_RE = /^[A-Za-z0-9 _./@%+=:,~-]+$/;

/** A path in double quotes for `sh -c`; throws on anything a shell would interpret inside them. */
export function shellQuotePath(p: string): string {
  if (typeof p !== "string" || !isAbsolute(p) || !SAFE_PATH_RE.test(p)) {
    throw new Error(`Refusing to put ${preview(p, 120)} in a hook command: use an absolute path of letters, digits, spaces and _ . / @ % + = : , ~ -`);
  }
  return `"${p}"`;
}

export interface WorkerCommand {
  /** process.execPath of the runner (the node binary). */
  execPath: string;
  /** Absolute path of dist/index.js. */
  cli: string;
}

export interface McpConfigInput extends WorkerCommand {
  execution: string;
  agent: string;
  tokenFile: string;
  /** ROUNDTABLE_HOME for the worker server. */
  home: string;
  connectors?: string[];
}

export interface McpConfig {
  mcpServers: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }>;
}

/** The keyless worker server, plus any opted-in connectors resolved before launch. */
export function buildMcpConfig(i: McpConfigInput & { connectors: string[] }): Promise<McpConfig>;
export function buildMcpConfig(i: McpConfigInput): McpConfig | Promise<McpConfig>;
export function buildMcpConfig(i: McpConfigInput): McpConfig | Promise<McpConfig> {
  for (const [name, p] of [["execPath", i.execPath], ["cli", i.cli], ["tokenFile", i.tokenFile], ["home", i.home]] as const) {
    if (typeof p !== "string" || !isAbsolute(p)) throw new Error(`buildMcpConfig: ${name} must be an absolute path`);
  }
  const config: McpConfig = {
    mcpServers: {
      [ROUNDTABLE_SERVER]: {
        type: "stdio",
        command: i.execPath,
        args: [i.cli, "mcp", "--worker", "--execution", i.execution, "--agent", assertAgentId(i.agent), "--token-file", i.tokenFile],
        env: { ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME: i.home },
      },
    },
  };
  if (!i.connectors?.length) return i.connectors ? Promise.resolve(config) : config;
  return addConnectors(config, i.connectors, i.home, i.execPath);
}

async function addConnectors(config: McpConfig, names: string[], home: string, execPath: string): Promise<McpConfig> {
  const specs = readUserConfig(home).connectors ?? {};
  for (const name of names) {
    const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (!spec || !isExecutableFile(spec.command)) throw new Error(`Connector ${name} is unavailable.`);
    const env = childEnv("connector", await resolveSecrets(spec.env));
    config.mcpServers[name] = {
      type: "stdio", command: execPath,
      args: [fileURLToPath(new URL("./connector-host.js", import.meta.url)), JSON.stringify(Object.keys(env)), spec.command, ...spec.args], env,
    };
  }
  // The trusted worker server writes tool events directly; it needs the same exact redactions.
  config.mcpServers[ROUNDTABLE_SERVER].env[SCRUB_LITERALS_ENV] = JSON.stringify(configuredSecretLiterals(process.env));
  return config;
}

/** Re-register active connector credentials when a replacement runner adopts a worker. */
export function registerWorkerSecrets(execution: string, agent: string): void {
  try {
    const config = JSON.parse(readFileSync(join(agentDir(execution, agent), "mcp.json"), "utf8")) as McpConfig;
    for (const value of configuredSecretLiterals(config.mcpServers[ROUNDTABLE_SERVER].env)) registerSecretLiteral(value);
  } catch { /* A completed relay may already have removed the file. */ }
}

export function removeWorkerMcpConfig(execution: string, agent: string): void {
  rmSync(join(agentDir(execution, agent), "mcp.json"), { force: true });
  rmSync(join(agentDir(execution, agent), RUNTIME_SETTINGS_FILE), { force: true });
}

/** The file-writing tools the lease hook gates (an unanchored regex, as Claude Code reads matchers). */
export const HOOK_MATCHER = "Edit|Write|NotebookEdit|MultiEdit";
/** The file-reading tools the hook confines to the worktree (no lease is needed to read). */
export const READ_HOOK_MATCHER = "Read|Glob|Grep";

/** The PreToolUse hook command: `"<execPath>" "<cli>" hook pre-tool-use` (run by `sh -c`). */
export function hookCommand(c: WorkerCommand): string {
  return `${shellQuotePath(c.execPath)} ${shellQuotePath(c.cli)} hook pre-tool-use`;
}

export interface WorkerSettings {
  permissions: { deny: string[] };
  hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }> };
}

/**
 * Denials and the hooks. Claude Code consults Edit(...) path rules for every file-writing tool; it
 * accepts Write(...) path rules but never consults them, so the Write rules are only a declaration
 * of intent. A .git directory, or a worktree's .git file, is denied at any depth: a nested
 * repository's config can define filter drivers that host git would run. So is .gitmodules
 * anywhere. The write hook enforces leases and refuses the same paths; the read hook confines
 * Read, Glob and Grep to the worktree by realpath, so a symlink a command planted cannot lead out.
 */
export function buildWorkerSettings(c: WorkerCommand): WorkerSettings {
  return {
    permissions: {
      deny: [
        "Read(./.env*)",
        "Read(./**/.env*)",
        "Edit(./.git)",
        "Write(./.git)",
        "Edit(./.git/**)",
        "Write(./.git/**)",
        "Edit(./**/.git)",
        "Write(./**/.git)",
        "Edit(./**/.git/**)",
        "Write(./**/.git/**)",
        "Edit(./.gitmodules)",
        "Edit(./**/.gitmodules)",
        "Bash",
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: hookCommand(c), timeout: 30 }] },
        { matcher: READ_HOOK_MATCHER, hooks: [{ type: "command", command: hookCommand(c), timeout: 30 }] },
      ],
    },
  };
}

// ============================================================================
// prompt.md
// ============================================================================

/** Appended to every worker's system prompt (the task card arrives as the first user message). */
export function workerProtocol(task: string, driver: WorkerDriverId = "claude-code"): string {
  const codex = driver === "codex";
  if (isRuntimeDriver(driver)) return runtimeProtocol(task, driver);
  return [
    "## Heads-down worker protocol",
    "",
    `You are a worker in a heads-down run of the agent roundtable, assigned to task \`${task}\`. You work alone in your task's git worktree (your working directory). No human is watching this session.`,
    "",
    "- You never message other agents. Read what others did with `read_blackboard` (sections, a `query` such as \"is the nav done?\", events, blobs).",
    codex
      ? "- Edit only files your leases cover. Request them first with `lease(action: \"request\", paths: [...])`; leases are checked when you submit, and a submission that changed anything else is rejected. If someone else holds a path, use `escalate(with: \"path_owner\")`."
      : "- Edit only files your leases cover. Request them first with `lease(action: \"request\", paths: [...])`; an edit outside your leases is refused. If someone else holds a path, use `escalate(with: \"path_owner\")`.",
    "- Make targeted edits instead of rewriting whole files.",
    "- If the frozen contract enables swarms (budget.max_agents >= 2), delegate with spawn_subtasks, then await_subtasks until ready: true. Delegated paths belong to the children until they finish. Children cannot delegate. Never use Task or Agent tools. Report failures or retry with new ids within the contract limits.",
    codex
      ? "- Your shell is sandboxed to your worktree, with no network: use it to build and test. Contract checks run with `run_command(command_id)` and `submit_work`."
      : "- You have no shell. Run builds, tests and checks with `run_command` (a named `command_id`, or an `argv`), which runs in a sandbox.",
    "- Report progress with `post_update(kind: \"progress\", percent, text)`. Publish an interface you own with `post_update(kind: \"interface\", name, text)`; say what you are waiting for with `post_update(kind: \"need\", name, text)`; acknowledge a directive with `post_update(kind: \"ack\", directive_id)`.",
    "- When you are blocked or unsure, `escalate`. After a blocking escalation, end your turn with a one-line summary; you will be resumed with the resolution.",
    "- Finish with `submit_work(summary, ready: true)`: it commits your leased changes and runs your task's checks. `ready: false` saves a checkpoint.",
    "- Every tool response may carry an `inbox` of directives and decisions. Follow them; acknowledge directives that ask for it.",
    "- Stay within your budget: stop and escalate rather than retrying the same failing approach.",
    "- Never read or write secrets (.env files, keys, credentials), and never try to reach the network.",
  ].join("\n");
}

/**
 * The protocol for a runtime worker. One with the roundtable worker server (gemini) calls the tools
 * itself; one without cannot lease, post or submit: it edits the files its task owns and the driver
 * submits for it when it exits 0, with its final message as the summary.
 */
function runtimeProtocol(task: string, driver: RuntimeDriverId): string {
  const mcp = workerProfile(runtimeDriverName(driver)).mcp;
  const head = [
    "## Heads-down worker protocol",
    "",
    `You are a worker in a heads-down run of the agent roundtable, assigned to task \`${task}\`. You work alone in your task's git worktree (your working directory). No human is watching this session.`,
    "",
  ];
  const common = [
    "- Make targeted edits instead of rewriting whole files.",
    "- Edit only files your task owns (its write paths are in the task card); a submission that changed anything else is rejected.",
    "- Never read or write secrets (.env files, keys, credentials), and never try to reach the network.",
  ];
  if (!mcp) {
    return [
      ...head,
      "- You have no roundtable tools. Do the task by editing files in your worktree.",
      "- When you are finished, stop and answer with a short summary of what you changed (a few sentences). The roundtable commits your work and runs the task's checks for you.",
      "- If you cannot finish, say what blocked you in that final answer instead of guessing.",
      ...common,
    ].join("\n");
  }
  return [
    ...head,
    "- You never message other agents. Read what others did with `read_blackboard` (sections, a `query` such as \"is the nav done?\", events, blobs).",
    "- Request the files you edit first with `lease(action: \"request\", paths: [...])`; leases are checked when you submit. If someone else holds a path, use `escalate(with: \"path_owner\")`.",
    "- Run builds, tests and checks with `run_command` (a named `command_id`, or an `argv`), which runs in a sandbox.",
    "- Report progress with `post_update(kind: \"progress\", percent, text)`.",
    "- When you are blocked or unsure, `escalate`. After a blocking escalation, end your turn with a one-line summary; you will be resumed with the resolution.",
    "- Finish with `submit_work(summary, ready: true)`: it commits your leased changes and runs your task's checks. `ready: false` saves a checkpoint.",
    "- Every tool response may carry an `inbox` of directives and decisions. Follow them.",
    ...common,
  ].join("\n");
}

/** Persona body, its skills, then the protocol. */
export function buildWorkerPrompt(persona: Pick<LoadedAgent, "body" | "skills">, task: string, driver: WorkerDriverId = "claude-code"): string {
  return `${persona.body.trim()}${renderSkillsSection(persona.skills)}\n\n${workerProtocol(task, driver)}\n`;
}

// ============================================================================
// Writing the files
// ============================================================================

export interface PrepareWorkerFilesOptions {
  store: Pick<ExecutionStore, "id" | "state">;
  agent: string;
  /** A persona ref (resolved with loadAgent) or an already loaded persona. */
  persona: string | Pick<LoadedAgent, "body" | "skills">;
  task: string;
  /** Default process.execPath. */
  execPath?: string;
  /** Default dist/index.js of this package. */
  cliPath?: string;
  /** Default ROUNDTABLE_HOME. */
  home?: string;
  /** The driver the files are for: the protocol differs for codex, which has its own shell. Default claude-code. */
  driver?: WorkerDriverId;
}

export interface WorkerFiles {
  dir: string;
  mcpConfigPath: string;
  settingsPath: string;
  promptPath: string;
  tokenPath: string;
  leasesPath: string;
  runsDir: string;
  /** For agent.registered: emit it (with this hash) before the worker starts. The token itself never leaves the file. */
  token_sha256: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/**
 * Write mcp.json, settings.json, prompt.md, a fresh single-use token and leases.json for one
 * worker run. Call it again for every resume: the token rotates, so emit agent.registered with the
 * new token_sha256 before launching.
 */
export async function prepareWorkerFiles(opts: PrepareWorkerFilesOptions): Promise<WorkerFiles> {
  const { store } = opts;
  assertAgentId(opts.agent);
  if (typeof opts.task !== "string" || !ID_RE.test(opts.task)) throw new Error(`Not a task id: ${preview(opts.task)}`);
  const command: WorkerCommand = { execPath: opts.execPath ?? process.execPath, cli: opts.cliPath ?? defaultCliPath() };
  hookCommand(command); // refuse unusable paths before writing anything
  const home = opts.home ?? ROUNDTABLE_HOME;
  const state = await store.state();
  const connectors = state.contract?.connectors ?? [];
  const chosen = opts.driver ?? state.contract?.workers.driver;
  if (connectors.length && chosen === "codex") throw new Error("Connectors are not supported by codex workers; use claude-code.");
  if (connectors.length && isRuntimeDriver(chosen)) throw new Error("Connectors are not supported by runtime workers; use claude-code.");
  const persona = typeof opts.persona === "string" ? await loadAgent(opts.persona) : opts.persona;

  const dir = ensureAgentDir(store.id, opts.agent);
  const runsDir = join(dir, "runs");
  mkdirPrivate(runsDir);
  const files = {
    mcpConfigPath: join(dir, "mcp.json"),
    settingsPath: join(dir, "settings.json"),
    promptPath: join(dir, "prompt.md"),
    tokenPath: join(dir, "token"),
    leasesPath: join(dir, "leases.json"),
  };
  const mcp = await buildMcpConfig({ ...command, execution: store.id, agent: opts.agent, tokenFile: files.tokenPath, home, connectors });
  const { token, sha256 } = newAgentToken();
  writeFileAtomic(files.tokenPath, token + "\n");
  writeFileAtomic(files.mcpConfigPath, json(mcp));
  writeFileAtomic(files.settingsPath, json(buildWorkerSettings(command)));
  writeFileAtomic(files.promptPath, buildWorkerPrompt(persona, opts.task, opts.driver));
  await writeAgentLeases(store, opts.agent, { task: opts.task });
  return { dir, runsDir, ...files, token_sha256: sha256 };
}

// ============================================================================
// leases.json
// ============================================================================

export interface AgentLeasesFile {
  v: 1;
  execution: string;
  agent: string;
  /** The task whose worktree the agent works in (the hook resolves paths against it). */
  task?: string;
  worktree?: string;
  /** The blackboard seq this projection was taken at. */
  seq: number;
  leases: Array<{ id: string; task: string; paths: string[]; excludes?: string[]; mode: LeaseMode }>;
}

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The task an agent works on: its live claim, else the task the runner spawned it for (unless someone else claims it). */
export function agentTask(state: Readonly<BlackboardState>, agent: string): string | undefined {
  for (const c of Object.values(state.claims)) if (c.agent === agent) return c.task;
  const t = own(state.agents, agent)?.task;
  if (t === undefined) return undefined;
  const claim = own(state.claims, t);
  return !claim || claim.agent === agent ? t : undefined;
}

/** The agent's leases.json projection of a state. */
export function agentLeasesProjection(state: Readonly<BlackboardState>, execution: string, agent: string, fallbackTask?: string): AgentLeasesFile {
  const mine = Object.values(state.tasks).flatMap((rt) => leasesFor(state, rt.spec.id, agent));
  const task = agentTask(state, agent) ?? fallbackTask ?? mine[0]?.task;
  const out: AgentLeasesFile = {
    v: 1,
    execution,
    agent,
    seq: state.seq,
    leases: mine.map((l) => ({ id: l.id, task: l.task, paths: [...l.paths], ...(l.excludes && { excludes: [...l.excludes] }), mode: l.mode })),
  };
  if (task !== undefined) {
    out.task = task;
    out.worktree = taskWorktreePath(execution, task);
  }
  return out;
}

/**
 * Project the agent's live leases into agents/<id>/leases.json, atomically. The worker server calls
 * it after every lease change it makes; the runner after it grants or expires leases.
 */
export async function writeAgentLeases(
  store: Pick<ExecutionStore, "id" | "state">,
  agent: string,
  opts: { task?: string } = {}
): Promise<AgentLeasesFile> {
  const state = await store.state();
  const file = agentLeasesProjection(state, store.id, assertAgentId(agent), opts.task);
  const dir = ensureAgentDir(store.id, agent);
  writeFileAtomic(join(dir, "leases.json"), json(file));
  return file;
}

/** Read a leases.json (null when missing or malformed). */
export function readAgentLeases(path: string): AgentLeasesFile | null {
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as AgentLeasesFile;
    if (!f || f.v !== 1 || !Array.isArray(f.leases)) return null;
    return f;
  } catch {
    return null;
  }
}
