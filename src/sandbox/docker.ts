// ============================================================================
// Docker sandbox backend (the default)
//
// Each command runs in a throwaway container: no network (or only the egress proxy), read-only
// root, a small tmpfs for /tmp and HOME, every capability dropped, no-new-privileges, pid, memory
// (no swap) and CPU limits, a non-root uid, no container log on the Docker host, and an
// environment holding only HOME, the proxy variables and the caller's validated non-secret
// variables. The worktree is the only host path mounted, and its .git is mounted read-only over
// itself: host-side git later runs in this worktree, so a writable .git (a swapped gitfile, a
// config with core.fsmonitor or hooks) would let a command run code on the host.
// ============================================================================

import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SandboxBackend, SandboxResult, SandboxRunRequest } from "../execution/types.js";
import { randomBase32 } from "../ids.js";
import { childEnv } from "../security/child-env.js";
import { isContained } from "../security/fs-safe.js";
import {
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_ENV,
  SandboxRequestError,
  canonicalWorkdir,
  clampOutputBytes,
  clampTimeout,
  resolveCwd,
  validateArgv,
  validateEnv,
  validateWorkdir,
} from "./common.js";
import { EGRESS_TAG_RE, ensureEgressNetwork, normalizeAllowlist, type EgressNetwork } from "./egress-proxy.js";
import { registerInflight, runQuiet, sandboxShuttingDown, spawnCaptured } from "./process.js";

// ============================================================================
// Limits and validation
// ============================================================================

export interface DockerLimits {
  /** docker --memory, e.g. "2g". */
  memory: string;
  /** docker --cpus, e.g. "2" or "1.5". */
  cpus: string;
  /** docker --pids-limit. */
  pids: number;
}

export const DEFAULT_DOCKER_LIMITS: DockerLimits = { memory: "2g", cpus: "2", pids: 512 };

const MEMORY_RE = /^\d+(?:\.\d+)?[bkmg]?$/i;
const CPUS_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
/** Variables the sandbox sets itself (compared case-insensitively). */
const RESERVED_ENV = ["HOME", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
/** Both spellings: npm and pip read either, curl only the lower-case http_proxy. */
const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];

function validMemory(v: string): boolean {
  return MEMORY_RE.test(v) && parseFloat(v) > 0;
}

function validCpus(v: string): boolean {
  return CPUS_RE.test(v) && parseFloat(v) > 0;
}

function validPids(n: number): boolean {
  return Number.isInteger(n) && n >= 16 && n <= 1_000_000;
}

/** Limits from ROUNDTABLE_SANDBOX_MEMORY / _CPUS / _PIDS; invalid values fall back to the defaults with a warning. */
export function dockerLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): DockerLimits {
  const limits = { ...DEFAULT_DOCKER_LIMITS };
  const memory = (env[SANDBOX_ENV.MEMORY] ?? "").trim();
  const cpus = (env[SANDBOX_ENV.CPUS] ?? "").trim();
  const pids = (env[SANDBOX_ENV.PIDS] ?? "").trim();
  if (memory) {
    if (validMemory(memory)) limits.memory = memory;
    else console.error(`[Sandbox] ignoring ${SANDBOX_ENV.MEMORY}=${memory}: expected e.g. 2g or 512m`);
  }
  if (cpus) {
    if (validCpus(cpus)) limits.cpus = cpus;
    else console.error(`[Sandbox] ignoring ${SANDBOX_ENV.CPUS}=${cpus}: expected a positive number`);
  }
  if (pids) {
    const n = Number(pids);
    if (/^\d+$/.test(pids) && validPids(n)) limits.pids = n;
    else console.error(`[Sandbox] ignoring ${SANDBOX_ENV.PIDS}=${pids}: expected an integer from 16 to 1000000`);
  }
  return limits;
}

export function defaultSandboxImage(env: NodeJS.ProcessEnv = process.env): string {
  return (env[SANDBOX_ENV.IMAGE] ?? "").trim() || DEFAULT_SANDBOX_IMAGE;
}

/** The container user: this process's uid:gid (so worktree files stay ours), never root. */
export function containerUser(): { uid: number; gid: number } {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  if (uid === 0) return { uid: 65534, gid: 65534 };
  return { uid, gid };
}

// ============================================================================
// Pure argv builder
// ============================================================================

export interface DockerRunOptions {
  /** Container name (run() uses rt-cmd-<random>); `docker kill` targets it on timeout. */
  name: string;
  uid: number;
  gid: number;
  /** Used when req.image is unset. */
  image: string;
  limits: DockerLimits;
  /** Required when req.egress is non-empty: the network and proxy from ensureEgressNetwork. */
  egress?: Pick<EgressNetwork, "network" | "proxyUrl">;
}

/**
 * The `docker run` argv for one request. Pure; throws SandboxRequestError for an invalid argv,
 * env (secret-shaped or reserved names), cwd (absolute or escaping), workdir, image, name or limit.
 * `req.workdir` must already be canonical (run() resolves it with canonicalWorkdir) and must hold
 * a .git, which is mounted read-only over itself.
 */
export function buildDockerRunArgs(req: SandboxRunRequest, opts: DockerRunOptions): string[] {
  const argv = validateArgv(req.argv);
  const workdir = validateWorkdir(req.workdir);
  const cwd = resolveCwd(req.cwd);
  const env = validateEnv(req.env, RESERVED_ENV);
  const image = req.image ?? opts.image;
  if (typeof image !== "string" || !IMAGE_RE.test(image)) throw new SandboxRequestError(`invalid image reference ${JSON.stringify(image)}`);
  if (!CONTAINER_NAME_RE.test(opts.name)) throw new SandboxRequestError(`invalid container name ${JSON.stringify(opts.name)}`);
  for (const id of [opts.uid, opts.gid]) {
    if (!Number.isInteger(id) || id < 0) throw new SandboxRequestError("uid and gid must be non-negative integers");
  }
  if (opts.uid === 0) throw new SandboxRequestError("the sandbox never runs commands as root");
  const { memory, cpus, pids } = opts.limits;
  if (!validMemory(memory) || !validCpus(cpus) || !validPids(pids)) throw new SandboxRequestError("invalid docker resource limits");
  const wantsEgress = Array.isArray(req.egress) && req.egress.length > 0;
  if (wantsEgress && !opts.egress) throw new SandboxRequestError("egress was requested but no egress network was prepared");
  const egress = wantsEgress ? opts.egress : undefined;

  const args = [
    "run", "--rm", "--init",
    "--log-driver", "none",
    "--name", opts.name,
    "--label", "roundtable.sandbox=1",
    "--label", `roundtable.owner-pid=${process.pid}`,
    "--label", `roundtable.owner-host=${hostname()}`,
    "--network", egress ? egress.network : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(pids),
    "--memory", memory,
    "--memory-swap", memory,
    "--cpus", cpus,
    "--user", `${opts.uid}:${opts.gid}`,
    "-e", "HOME=/tmp",
  ];
  if (egress) for (const k of PROXY_VARS) args.push("-e", `${k}=${egress.proxyUrl}`);
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(
    "--mount", `type=bind,src=${workdir},dst=/work`,
    "--mount", `type=bind,src=${join(workdir, ".git")},dst=/work/.git,readonly`,
    "-w", cwd ? `/work/${cwd}` : "/work",
    image,
    ...argv
  );
  return args;
}

// ============================================================================
// Backend
// ============================================================================

export interface DockerBackendOptions {
  /** Names and labels egress networks (rt-egress-<tag>-<id>); random when unset. */
  executionTag?: string;
  /** Default image; otherwise ROUNDTABLE_SANDBOX_IMAGE or node:22-bookworm-slim. */
  image?: string;
  limits?: Partial<DockerLimits>;
  /** The docker CLI (default "docker" on PATH). Tests point this at a fake. */
  dockerPath?: string;
  /** Source of the ROUNDTABLE_SANDBOX_* settings; default process.env. */
  env?: NodeJS.ProcessEnv;
}

const INFO_TIMEOUT_MS = 5_000;
const INSPECT_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 600_000;
const KILL_TIMEOUT_MS = 10_000;
/** A tag can be re-pushed; re-read the digest at least this often. */
const DIGEST_TTL_MS = 10 * 60_000;

const CLEANUP_TIMEOUT_MS = 3_000;
interface CleanupTarget {
  docker: string;
  name: string;
  pending: boolean;
  unregister: () => void;
  cleaning?: Promise<void>;
}
// Failed removals stay registered for shutdown and are retried by the next sandbox call.
const cleanupTargets = new Set<CleanupTarget>();

function removeContainer(target: CleanupTarget): Promise<void> {
  if (target.cleaning) return target.cleaning;
  target.cleaning = (async () => {
    const r = await runQuiet(target.docker, ["rm", "-f", target.name], childEnv("docker"), CLEANUP_TIMEOUT_MS);
    if (r.ok || /No such container/i.test(r.output)) {
      cleanupTargets.delete(target);
      target.unregister();
    } else target.pending = true;
  })().finally(() => { target.cleaning = undefined; });
  return target.cleaning;
}

function trackContainer(docker: string, name: string): CleanupTarget {
  const target: CleanupTarget = { docker, name, pending: false, unregister: () => {} };
  cleanupTargets.add(target);
  target.unregister = registerInflight({ label: `container ${name}`, stop: () => removeContainer(target) });
  return target;
}

/** Sweep only this host's labelled containers whose recorded owner demonstrably no longer exists. */
async function reconcileContainers(docker: string): Promise<void> {
  await Promise.all([...cleanupTargets].filter(t => t.pending).map(removeContainer));
  const r = await runQuiet(docker, ["ps", "-a", "--filter", "label=roundtable.sandbox=1", "--format",
    '{{.ID}} {{.Label "roundtable.owner-pid"}} {{.Label "roundtable.owner-host"}}'], childEnv("docker"), CLEANUP_TIMEOUT_MS);
  if (!r.ok) return;
  for (const line of r.output.split("\n")) {
    const [id, owner, host] = line.trim().split(/\s+/);
    const pid = Number(owner);
    if (!/^[a-f0-9]{12,64}$/.test(id) || host !== hostname() || !Number.isSafeInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, 0); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") await removeContainer(trackContainer(docker, id));
    }
  }
}

export class DockerBackend implements SandboxBackend {
  readonly id = "docker" as const;
  private readonly docker: string;
  private readonly image: string;
  private readonly limits: DockerLimits;
  private readonly tag: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Digest per image reference, with when it was read. */
  private readonly digests = new Map<string, { digest: string; at: number }>();

  constructor(opts: DockerBackendOptions = {}) {
    this.env = opts.env ?? process.env;
    this.docker = opts.dockerPath ?? "docker";
    this.image = opts.image ?? defaultSandboxImage(this.env);
    this.limits = { ...dockerLimitsFromEnv(this.env), ...opts.limits };
    this.tag = (opts.executionTag ?? randomBase32(6)).toLowerCase();
    if (!EGRESS_TAG_RE.test(this.tag)) throw new SandboxRequestError(`execution tag ${JSON.stringify(opts.executionTag)} must be 1-32 lowercase letters or digits`);
  }

  async available(): Promise<{ ok: boolean; reason?: string; degraded?: string }> {
    const r = await runQuiet(this.docker, ["info", "--format", "{{.ServerVersion}}"], childEnv("docker"), INFO_TIMEOUT_MS);
    if (r.ok && r.output) return { ok: true };
    const detail = r.output.split("\n").find((l) => l.trim()) ?? (r.exit === null ? "timed out or not installed" : `exit ${r.exit}`);
    return { ok: false, reason: `docker is not available: ${detail.slice(0, 300)}` };
  }

  /**
   * Make sure the image is present and return its digest (best effort). Call it at preflight: a
   * pull inside run() counts toward that request's timeout.
   */
  async prepare(image = this.image, signal?: AbortSignal, timeoutMs = PULL_TIMEOUT_MS): Promise<{ ok: true; digest?: string } | { ok: false; error: string }> {
    if (!IMAGE_RE.test(image)) return { ok: false, error: `invalid image reference ${JSON.stringify(image)}` };
    const hit = this.digests.get(image);
    if (hit && Date.now() - hit.at < DIGEST_TTL_MS) return { ok: true, digest: hit.digest };
    const env = childEnv("docker");
    const inspect = (format: string) =>
      runQuiet(this.docker, ["image", "inspect", "--format", format, image], env, Math.min(INSPECT_TIMEOUT_MS, timeoutMs), signal);
    const present = await inspect("{{.Id}}");
    if (!present.ok) {
      if (signal?.aborted) return { ok: false, error: `preparing ${image} was interrupted` };
      const pulled = await runQuiet(this.docker, ["pull", image], env, Math.min(PULL_TIMEOUT_MS, timeoutMs), signal);
      if (!pulled.ok) return { ok: false, error: `could not pull ${image}: ${pulled.output.slice(-1000)}` };
    }
    // Best effort: the registry digest, else the local image id (locally built images have none).
    const repo = await inspect("{{index .RepoDigests 0}}");
    const id = repo.ok && repo.output ? null : await inspect("{{.Id}}");
    const digest = repo.ok && repo.output ? repo.output : id?.ok && id.output ? id.output : undefined;
    if (digest) this.digests.set(image, { digest, at: Date.now() });
    return { ok: true, digest };
  }

  /**
   * Run one request. timeoutMs bounds the whole request: pulling a missing image and starting an
   * egress proxy count toward it, and the container gets what is left.
   */
  async run(req: SandboxRunRequest): Promise<SandboxResult> {
    const started = Date.now();
    const timeoutMs = clampTimeout(req.timeoutMs);
    const maxOutputBytes = clampOutputBytes(req.maxOutputBytes);
    const image = req.image ?? this.image;
    const name = `rt-cmd-${randomBase32(12)}`;
    const user = containerUser();
    const base = { name, ...user, image, limits: this.limits };
    const wantsEgress = Array.isArray(req.egress) && req.egress.length > 0;
    // Validate everything before touching Docker (a placeholder stands in for the egress network).
    const placeholder = { network: "rt-egress-check", proxyUrl: "http://rt-proxy-check:3128" };
    buildDockerRunArgs(req, wantsEgress ? { ...base, egress: placeholder } : base);
    if (wantsEgress) normalizeAllowlist(req.egress!);
    // Resolve the workdir once (a symlinked workdir is refused) and use only that path from here.
    const wd = canonicalWorkdir(req.workdir);
    if (wd.git === "absent") {
      throw new SandboxRequestError("the workdir has no .git; the docker backend runs only in git worktrees, whose .git it mounts read-only");
    }
    const canonical: SandboxRunRequest = { ...req, workdir: wd.path };
    buildDockerRunArgs(canonical, wantsEgress ? { ...base, egress: placeholder } : base);
    // The cwd must already exist inside the worktree: Docker would otherwise create it, root-owned,
    // in the bind mount (and a symlinked cwd may not lead outside).
    let target: string;
    try {
      target = realpathSync(join(wd.path, resolveCwd(req.cwd)));
    } catch (e) {
      if (e instanceof SandboxRequestError) throw e;
      throw new SandboxRequestError(`cwd does not exist: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isContained(wd.path, target)) throw new SandboxRequestError("cwd resolves outside the workdir");
    if (!statSync(target).isDirectory()) throw new SandboxRequestError("cwd is not a directory");

    const deadline = AbortSignal.timeout(timeoutMs);
    const setupSignal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    const remaining = () => Math.max(1, started + timeoutMs - Date.now());
    const failure = (output: string): SandboxResult => ({
      exit: null,
      signal: deadline.aborted ? "SIGKILL" : undefined,
      timedOut: deadline.aborted,
      durationMs: Date.now() - started,
      output: deadline.aborted ? `timed out before the command started: ${output}` : output,
      truncated: false,
      backend: "docker",
    });
    if (sandboxShuttingDown()) return failure("sandbox is shutting down");

    await reconcileContainers(this.docker);
    if (sandboxShuttingDown()) return failure("sandbox is shutting down");
    const prepared = await this.prepare(image, setupSignal, remaining());
    if (!prepared.ok) return failure(prepared.error);
    if (setupSignal.aborted) return { ...failure("interrupted"), imageDigest: prepared.digest };

    let egress: EgressNetwork | undefined;
    if (wantsEgress) {
      try {
        egress = await ensureEgressNetwork({
          executionTag: this.tag,
          allowlist: req.egress!,
          dockerPath: this.docker,
          env: this.env,
          signal: setupSignal,
        });
      } catch (e) {
        if (e instanceof SandboxRequestError) throw e;
        return { ...failure(e instanceof Error ? e.message : String(e)), imageDigest: prepared.digest };
      }
    }

    const cleanup = trackContainer(this.docker, name);
    try {
      if (setupSignal.aborted) return { ...failure("interrupted"), imageDigest: prepared.digest };
      const args = buildDockerRunArgs(canonical, egress ? { ...base, egress } : base);
      const docker = this.docker;
      const r = await spawnCaptured(docker, args, {
        env: childEnv("docker"),
        timeoutMs: remaining(),
        maxOutputBytes,
        signal: req.signal,
        label: name,
        // The client dying does not stop the container: kill it by name first.
        beforeKill: async () => {
          await runQuiet(docker, ["kill", name], childEnv("docker"), KILL_TIMEOUT_MS);
        },
      });
      return {
        exit: r.exit,
        signal: r.signal,
        timedOut: r.timedOut,
        durationMs: Date.now() - started,
        output: r.output,
        truncated: r.truncated,
        backend: "docker",
        imageDigest: prepared.digest,
      };
    } finally {
      // Await removal even when attach fails or no egress network exists.
      await removeContainer(cleanup);
      if (egress) await egress.teardown();
    }
  }
}
