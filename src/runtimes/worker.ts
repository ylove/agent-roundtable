// ============================================================================
// Runtime profiles as heads-down workers (opt-in with ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1)
//
// A contract (or `execute`) names one as the worker driver: `workers.driver: "runtime:gemini"`. The
// profile's own argv, output mode and usage paths are reused (src/runtimes/registry.ts); this module
// adds what a worker needs on top: whether the runtime takes the roundtable worker MCP server, the
// flags it gets for its own sandbox and approvals, and which API-key variables ROUNDTABLE_WORKER_AUTH
// may pass. The driver itself is src/workers/runtime.ts.
//
// The codex profile is not offered here: the codex worker driver (worker_driver: "codex") is the
// full integration for it (permissions profile, resume, thread ids).
// ============================================================================

import { RUNTIME_WORKER_API_KEYS } from "../security/child-env.js";
import { getRuntime } from "./registry.js";
import { RUNTIME_MODEL, RUNTIME_NAME, type RuntimeSpec } from "./spec.js";
import type { RuntimeDriverId } from "../execution/types.js";

export const ALLOW_RUNTIME_WORKERS_ENV = "ROUNDTABLE_ALLOW_RUNTIME_WORKERS";
export const RUNTIME_DRIVER_PREFIX = "runtime:";

export function runtimeWorkersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[ALLOW_RUNTIME_WORKERS_ENV] ?? "").trim() === "1";
}

export const RUNTIME_WORKERS_NOT_ALLOWED =
  `${ALLOW_RUNTIME_WORKERS_ENV}=1 (runtime workers are opt-in: unless the runtime has its own sandbox, its commands run with the user's permissions inside the task worktree)`;

export function isRuntimeDriver(id: unknown): id is RuntimeDriverId {
  return typeof id === "string" && id.startsWith(RUNTIME_DRIVER_PREFIX) && RUNTIME_NAME.test(id.slice(RUNTIME_DRIVER_PREFIX.length));
}

/** The runtime profile name of a `runtime:<name>` driver id. */
export function runtimeDriverName(id: RuntimeDriverId): string {
  return id.slice(RUNTIME_DRIVER_PREFIX.length);
}

/**
 * Why `id` cannot be a worker driver on this machine, or undefined when it can: a malformed id, an
 * unknown runtime, codex (it has its own driver), or the opt-in missing. Contract validation calls
 * this, so a bad choice fails at freeze and `execute`, never at launch.
 */
export function runtimeDriverProblem(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isRuntimeDriver(id)) return `${JSON.stringify(id)} is not a runtime worker driver (use runtime:<name>, for example runtime:gemini)`;
  const name = runtimeDriverName(id);
  if (name === "codex") return 'runtime:codex is not offered; use the codex driver (workers.driver "codex") for Codex workers';
  let spec: RuntimeSpec | undefined;
  try {
    spec = getRuntime(name);
  } catch (e) {
    return `the runtimes configuration is invalid: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!spec) return `unknown runtime ${JSON.stringify(name)}; run \`roundtable runtimes\` to list the profiles, or add one under "runtimes" in config.json`;
  if (!runtimeWorkersAllowed(env)) return `runtime workers need ${RUNTIME_WORKERS_NOT_ALLOWED}`;
  return undefined;
}

export interface RuntimeWorkerProfile {
  /** The runtime takes the roundtable worker MCP server in non-interactive mode, so it calls submit_work itself. */
  mcp: boolean;
  /** Flags placed right after the binary (approvals, the runtime's own sandbox, MCP server selection). */
  args: string[];
  /** The runtime confines its commands with its own sandbox flag (named in `args`). */
  sandboxed: boolean;
  /** Env names ROUNDTABLE_WORKER_AUTH=api_key may pass; none by default (the CLI's own login is used). */
  apiKeyEnv: string[];
}

const PLAIN: RuntimeWorkerProfile = { mcp: false, args: [], sandboxed: false, apiKeyEnv: [] };

/** Per built-in profile; a configured runtime without an entry gets PLAIN (driver-side submit, no sandbox flag). */
export const WORKER_PROFILES: Readonly<Record<string, RuntimeWorkerProfile>> = {
  hermes: PLAIN,
  openclaw: PLAIN,
  gemini: {
    mcp: true,
    // auto_edit approves file edits; shell commands stay unapproved in non-interactive mode, so builds and
    // checks go through the roundtable server's run_command. --sandbox is gemini's own sandbox flag.
    args: ["--approval-mode", "auto_edit", "--sandbox", "--allowed-mcp-server-names", "roundtable"],
    sandboxed: true,
    apiKeyEnv: [...RUNTIME_WORKER_API_KEYS],
  },
};

export function workerProfile(name: string): RuntimeWorkerProfile {
  return Object.hasOwn(WORKER_PROFILES, name) ? WORKER_PROFILES[name] : PLAIN;
}

/** The env var gemini reads its system-level settings file from (it overrides user and workspace settings). */
export const GEMINI_SETTINGS_ENV = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/**
 * The runtime's argv for a worker, prompt still the `{prompt}` placeholder (the wrapper fills it
 * from stdin so it is never on the launcher's argv): the binary, the profile's worker flags, the
 * spec's own arguments and the model flag. Pure.
 */
export function buildRuntimeWorkerArgv(spec: RuntimeSpec, profile: RuntimeWorkerProfile, model?: string): string[] {
  const [binary, ...rest] = spec.argv;
  const args = [...profile.args, ...rest];
  if (model !== undefined) {
    if (!RUNTIME_MODEL.test(model)) throw new Error("Invalid runtime model; use a model identifier beginning with a letter or digit.");
    if (!spec.modelFlag) throw new Error("This runtime does not support a model override.");
    // Option/value pairs stay together; stdin's positional marker stays last.
    args.splice(args.at(-1) === "-" && !spec.argv.includes("{prompt}") ? args.length - 1 : args.length, 0, spec.modelFlag, model);
  }
  return [binary, ...args];
}
