// ============================================================================
// Sandbox for commands and checks: backend selection and the run core
//
// During heads-down runs, workers have no Bash. run_command, task checks and integration checks
// all come through runSandboxed / runCommandSpec, with structured argv only. Docker is the
// default backend; the local backend needs ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1 and reports itself as
// degraded where it is weaker.
// ============================================================================

import { createHash } from "node:crypto";
import type { CommandSpec, SandboxBackend, SandboxBackendId, SandboxResult, SandboxRunRequest } from "../execution/types.js";
import {
  MAX_TIMEOUT_MS,
  SandboxRequestError,
  TOOL_TAIL_BYTES,
  capText,
  clampOutputBytes,
  clampTimeout,
  isShellCommand,
  localSandboxAllowed,
  tailText,
  validateArgv,
} from "./common.js";
import { DockerBackend } from "./docker.js";
import { LocalBackend } from "./local.js";
import { sandboxShuttingDown } from "./process.js";
import { scrubSecrets } from "../security/secrets.js";

export {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROXY_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SANDBOX_ENV,
  SandboxRequestError,
  TOOL_TAIL_BYTES,
  capText,
  isShellCommand,
  validateArgv,
} from "./common.js";
export { DockerBackend, buildDockerRunArgs, dockerLimitsFromEnv, DEFAULT_DOCKER_LIMITS } from "./docker.js";
export type { DockerBackendOptions, DockerLimits, DockerRunOptions } from "./docker.js";
export { LocalBackend, buildSeatbeltProfile } from "./local.js";
export type { LocalBackendOptions, LocalIsolation } from "./local.js";
export { ensureEgressNetwork, sweepEgress, decideConnect, decideAddresses, hostAllowed, isBlockedAddress } from "./egress-proxy.js";
export type { EgressNetwork, EgressOptions } from "./egress-proxy.js";
export { failureSignature, normalizeOutput } from "./signature.js";
export { killAllSandboxed, sandboxedInFlight } from "./process.js";

// ============================================================================
// Backend selection
// ============================================================================

/** Neither backend can run commands. The reasons go to the human (awaiting_human). */
export class SandboxUnavailableError extends Error {
  constructor(readonly reasons: string[]) {
    super(`No sandbox is available: ${reasons.join("; ")}`);
    this.name = "SandboxUnavailableError";
  }
}

export interface SelectBackendOptions {
  /** contract.sandbox.backend; default "docker". */
  preferred?: SandboxBackendId;
  /** Whether the local backend may be used at all; default ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1. */
  allowLocal?: boolean;
  /** Prebuilt backends (an execution tag for Docker, or fakes in tests). */
  docker?: SandboxBackend;
  local?: SandboxBackend;
}

/**
 * Pick a backend: Docker first (or local first when preferred and allowed), falling back to local
 * only when it is allowed. `degraded` is set when the choice is weaker than Docker for a reason
 * the run should record as sandbox.degraded. Throws SandboxUnavailableError when nothing works.
 */
export async function selectBackend(opts: SelectBackendOptions = {}): Promise<{ backend: SandboxBackend; degraded?: string }> {
  const allowLocal = opts.allowLocal ?? localSandboxAllowed();
  const docker = opts.docker ?? new DockerBackend();
  const local = allowLocal ? (opts.local ?? new LocalBackend()) : undefined;
  const reasons: string[] = [];

  const tryLocal = async (why?: string) => {
    if (!local) {
      reasons.push("the local sandbox is not allowed (set ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1)");
      return null;
    }
    const a = await local.available();
    if (!a.ok) {
      reasons.push(a.reason ?? "the local sandbox is unavailable");
      return null;
    }
    const parts = [why, a.degraded].filter(Boolean) as string[];
    return { backend: local, degraded: parts.length ? parts.join("; ") : undefined };
  };
  const tryDocker = async () => {
    const a = await docker.available();
    if (a.ok) return { backend: docker, degraded: a.degraded };
    reasons.push(a.reason ?? "docker is unavailable");
    return null;
  };

  if (opts.preferred === "local") {
    const l = await tryLocal();
    if (l) return l;
    const d = await tryDocker();
    if (d) return d;
  } else {
    const d = await tryDocker();
    if (d) return d;
    const l = await tryLocal(`docker unavailable (${reasons[0]}); using the local backend`);
    if (l) return l;
  }
  throw new SandboxUnavailableError(reasons);
}

// ============================================================================
// Run core
// ============================================================================

/** Grace after the timeout before the run core aborts a backend that ignored it, and again before giving up on it. */
const BACKSTOP_GRACE_MS = 15_000;

export interface RunSandboxedOptions {
  /** Ceiling for timeoutMs (default 15 minutes). */
  maxTimeoutMs?: number;
  /** Backstop grace (default 15 s); tests shorten it. */
  backstopGraceMs?: number;
}

/**
 * Run one request: validate argv (shell -c refused on local, warned on Docker), clamp the timeout
 * (default 600 s, at most 15 min) and the output cap (default 2 MB, head + tail), scrub secrets,
 * and return the backend's result. Invalid requests throw SandboxRequestError; failures to run
 * (Docker down, missing program) come back as a result with exit null.
 */
export async function runSandboxed(backend: SandboxBackend, req: SandboxRunRequest, opts: RunSandboxedOptions = {}): Promise<SandboxResult> {
  const argv = validateArgv(req.argv);
  if (isShellCommand(argv)) {
    if (backend.id === "local") {
      throw new SandboxRequestError("shell -c commands are refused on the local backend; pass the program and its arguments as argv");
    }
    console.error(`[Sandbox] warning: ${argv[0]} -c runs a shell string inside the container; prefer structured argv`);
  }
  const timeoutMs = clampTimeout(req.timeoutMs, Math.min(opts.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const maxOutputBytes = clampOutputBytes(req.maxOutputBytes);
  const grace = opts.backstopGraceMs ?? BACKSTOP_GRACE_MS;
  const started = Date.now();
  if (sandboxShuttingDown()) {
    return { exit: null, timedOut: false, durationMs: 0, output: "sandbox is shutting down", truncated: false, backend: backend.id };
  }

  // Our own controller: the caller's signal aborts it, and so does the backstop below. Our
  // backends enforce timeoutMs themselves; the backstop covers one that does not, aborting it a
  // little after the deadline and giving up on it a little after that.
  const ac = new AbortController();
  const onAbort = () => ac.abort(req.signal?.reason);
  if (req.signal?.aborted) ac.abort(req.signal.reason);
  else req.signal?.addEventListener("abort", onAbort, { once: true });
  let backstopFired = false;
  let abortTimer: NodeJS.Timeout | undefined;
  let giveUpTimer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<SandboxResult>((resolve) => {
    abortTimer = setTimeout(() => {
      backstopFired = true;
      ac.abort(new Error("sandbox timeout backstop"));
      giveUpTimer = setTimeout(
        () =>
          resolve({
            exit: null,
            signal: "SIGKILL",
            timedOut: true,
            durationMs: Date.now() - started,
            output: `the ${backend.id} backend did not stop after its ${timeoutMs} ms timeout`,
            truncated: false,
            backend: backend.id,
          }),
        grace
      );
    }, timeoutMs + grace);
  });

  try {
    const r = await Promise.race([backend.run({ ...req, argv, timeoutMs, maxOutputBytes, signal: ac.signal }), giveUp]);
    const scrubbed = scrubSecrets(r.output ?? "").text;
    const capped = capText(scrubbed, maxOutputBytes);
    return {
      ...r,
      timedOut: r.timedOut || backstopFired,
      durationMs: r.durationMs ?? Date.now() - started,
      output: capped.text,
      truncated: r.truncated || capped.truncated,
      backend: r.backend ?? backend.id,
    };
  } catch (e) {
    if (e instanceof SandboxRequestError) throw e;
    // A backend bug or a refused start: report it like a failed run, scrubbed.
    const msg = scrubSecrets(e instanceof Error ? e.message : String(e)).text;
    return { exit: null, timedOut: backstopFired, durationMs: Date.now() - started, output: msg, truncated: false, backend: backend.id };
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(giveUpTimer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

export interface RunCommandSpecOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** contract.sandbox.image. */
  image?: string;
  /** Hosts for the egress proxy (only for install steps). */
  egress?: string[];
  /** Ceiling for spec.timeout_s, e.g. the time left of submit_work's 15 minutes. */
  maxTimeoutMs?: number;
}

/** The SandboxRunRequest for a contract CommandSpec run in `workdir`. */
export function commandSpecRequest(spec: CommandSpec, workdir: string, opts: RunCommandSpecOptions = {}): SandboxRunRequest {
  if (!spec || typeof spec.id !== "string" || !spec.id.trim()) throw new SandboxRequestError("command spec needs an id");
  const timeoutS = Number(spec.timeout_s);
  return {
    argv: validateArgv(spec.argv),
    workdir,
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: Number.isFinite(timeoutS) && timeoutS > 0 ? Math.round(timeoutS * 1000) : 0,
    image: opts.image,
    egress: opts.egress,
    maxOutputBytes: opts.maxOutputBytes,
    signal: opts.signal,
  };
}

/** Run a contract CommandSpec (a check or a named command) in `workdir`. */
export function runCommandSpec(backend: SandboxBackend, spec: CommandSpec, workdir: string, opts: RunCommandSpecOptions = {}): Promise<SandboxResult> {
  return runSandboxed(backend, commandSpecRequest(spec, workdir, opts), { maxTimeoutMs: opts.maxTimeoutMs });
}

/** The last ~8 KB of output for a tool response, starting on a line boundary when one is near. */
export function tailForTool(output: string, maxBytes = TOOL_TAIL_BYTES): string {
  return tailText(output, maxBytes);
}

/** A stable command id for ad-hoc argv (run_command without command_id), for failure signatures. */
export function adhocCommandId(argv: readonly string[]): string {
  return `argv:${createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 16)}`;
}
