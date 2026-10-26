// ============================================================================
// Preview manager: start, list, stop and sweep dev-server previews
//
// startPreview snapshots a task worktree or a prototype directory into a tar file, installs the
// dependencies inside a container when the snapshot has none (only the npm registry is reachable,
// lifecycle scripts are off), then runs `npm run <dev|start|preview>` in a locked-down container
// whose one port is published on 127.0.0.1. The container never sees the host source: the tar
// arrives on stdin and is unpacked into a tmpfs. Once the server answers HTTP (and the page check
// passes, unless page checks are off) a record is written to ROUNDTABLE_HOME/previews.
//
// Lifecycle: an idle TTL, a cap on concurrent previews, stop on request, when the run ends and when
// serve stops, and a sweep that removes labelled containers nobody owns. Docker, the clock, the
// readiness probe and the page check are injectable so the lifecycle is tested without Docker.
// ============================================================================

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { PROTOTYPE_DIR } from "../config.js";
import { EXECUTION_ID_RE, newId } from "../ids.js";
import { openExecutionStore } from "../execution/store.js";
import { taskWorktreePath } from "../execution/worktrees.js";
import { checkPage, pageCheckRecord, pageChecksOff, type PageCheck } from "../prototypes/page-check.js";
import { containerUser, DEFAULT_DOCKER_LIMITS, dockerLimitsFromEnv, defaultSandboxImage, DockerBackend, type DockerLimits } from "../sandbox/docker.js";
import { ensureEgressNetwork, type EgressNetwork } from "../sandbox/egress-proxy.js";
import { childEnv } from "../security/child-env.js";
import { isContained, mkdirPrivate } from "../security/fs-safe.js";
import { scrubAndCap } from "../security/secrets.js";
import { buildForwarderCreateArgs, buildForwarderNetworkCreateArgs, buildInstallRunArgs, buildNetworkCreateArgs, buildPreviewRunArgs, forwarderName, forwarderNetworkName, installContainerName, PREVIEW_HOST_LABEL, PREVIEW_ID_RE, PREVIEW_LABEL, PREVIEW_NET_LABEL, previewContainerName, previewNetworkName } from "./args.js";
import { realDocker, type PreviewDocker } from "./docker-io.js";
import { defaultPort, parsePackageJson, pickScript, PreviewError, viteHostFlag, type PackageLike } from "./scripts.js";
import { previewsDir, readRecord, readRecords, removeRecord, touchRecord, writeRecord, type PreviewRecord, type PreviewSource } from "./store.js";

const execFileP = promisify(execFile);

// ============================================================================
// Configuration
// ============================================================================

export const PREVIEW_ENV = {
  TTL_MIN: "ROUNDTABLE_PREVIEW_TTL_MIN",
  MAX: "ROUNDTABLE_PREVIEW_MAX",
  READY_TIMEOUT_SEC: "ROUNDTABLE_PREVIEW_READY_TIMEOUT_SEC",
} as const;
export const DEFAULT_TTL_MIN = 30;
export const DEFAULT_MAX_PREVIEWS = 3;
export const DEFAULT_READY_TIMEOUT_SEC = 120;
/** Largest source snapshot, and largest tree an install may produce. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_INSTALLED_BYTES = 1024 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 600_000;
const PORT_TIMEOUT_MS = 60_000;
const NPM_REGISTRY_HOST = "registry.npmjs.org";
const TASK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (/^\d+$/.test(raw) && n >= min && n <= max) return n;
  console.error(`[Preview] ignoring ${name}=${raw.slice(0, 20)}: expected an integer from ${min} to ${max}`);
  return fallback;
}

export interface PreviewSettings {
  ttlMs: number;
  maxPreviews: number;
  readyTimeoutMs: number;
}

export function previewSettings(env: NodeJS.ProcessEnv = process.env): PreviewSettings {
  return {
    ttlMs: intFromEnv(env, PREVIEW_ENV.TTL_MIN, DEFAULT_TTL_MIN, 1, 24 * 60) * 60_000,
    maxPreviews: intFromEnv(env, PREVIEW_ENV.MAX, DEFAULT_MAX_PREVIEWS, 1, 20),
    readyTimeoutMs: intFromEnv(env, PREVIEW_ENV.READY_TIMEOUT_SEC, DEFAULT_READY_TIMEOUT_SEC, 5, 1800) * 1000,
  };
}

// ============================================================================
// Sources
// ============================================================================

export interface StartInput {
  /** A heads-down task's worktree. */
  execution?: string;
  task?: string;
  /** A prototype directory under the prototype root (a duel team's version, for example). */
  prototype?: string;
  /** dev, start or preview (default: the first the package defines). */
  script?: string;
  /** Container port (default: the usual port of the package's dev server). */
  port?: number;
}

export interface ResolvedSource {
  dir: string;
  source: PreviewSource;
}

/** The directory to preview and how to name it; throws PreviewError. Symlinks and paths outside their root are refused. */
export function resolveSource(input: StartInput, prototypeRoot = PROTOTYPE_DIR, taskPath: (exe: string, task: string) => string = taskWorktreePath): ResolvedSource {
  const hasTask = input.execution !== undefined || input.task !== undefined;
  if (hasTask === (input.prototype !== undefined)) throw new PreviewError("give either execution and task, or prototype");
  if (hasTask) {
    if (typeof input.execution !== "string" || !EXECUTION_ID_RE.test(input.execution)) throw new PreviewError("execution must be an exe-… id");
    if (typeof input.task !== "string" || !TASK_RE.test(input.task)) throw new PreviewError("task must be a task id");
    const dir = taskPath(input.execution, input.task);
    plainDirectory(dir, "the task's worktree");
    return { dir, source: { kind: "task", execution: input.execution, task: input.task } };
  }
  const given = input.prototype!;
  if (typeof given !== "string" || !given || given.includes("\0")) throw new PreviewError("prototype must be a directory");
  if (!isAbsolute(given)) throw new PreviewError("prototype must be an absolute directory");
  const dir = plainDirectory(given, "the prototype directory");
  let root: string;
  try { root = realpathSync(prototypeRoot); } catch { throw new PreviewError("there is no prototype directory yet"); }
  if (dir === root || !isContained(root, dir)) throw new PreviewError("the prototype directory must be inside the prototype root");
  const name = dir.slice(root.length + 1).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  if (!name) throw new PreviewError("the prototype directory has no usable name");
  // A duel's prototypes live in <duel id>-<random>/submission-N under the root: carry the duel id.
  const duel = /^(duel-[A-Za-z0-9_-]{1,35})-[A-Za-z0-9]{6}(?:\/|$)/.exec(dir.slice(root.length + 1))?.[1];
  return { dir, source: { kind: "prototype", prototype: name, ...(duel && { duel }) } };
}

/** The real path of a directory that is not itself a symlink. */
function plainDirectory(path: string, what: string): string {
  let st;
  try { st = lstatSync(path); } catch { throw new PreviewError(`${what} does not exist`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PreviewError(`${what} is not a plain directory`);
  return realpathSync(path);
}

function readPackage(dir: string): PackageLike {
  const path = join(dir, "package.json");
  let st;
  try { st = lstatSync(path); } catch { throw new PreviewError("the source has no package.json"); }
  if (!st.isFile() || st.size > 1024 * 1024) throw new PreviewError("package.json is not a plain file of at most 1 MB");
  return parsePackageJson(readFileSync(path, "utf8"));
}

/** True when the source already holds an installed node_modules directory (not a symlink, not empty). */
function hasNodeModules(dir: string): boolean {
  try {
    const p = join(dir, "node_modules");
    return lstatSync(p).isDirectory() && readdirSync(p).length > 0;
  } catch { return false; }
}

// ============================================================================
// Dependencies (injectable)
// ============================================================================

export interface PreviewDeps {
  docker: PreviewDocker;
  settings: PreviewSettings;
  limits: DockerLimits;
  image: string;
  user: { uid: number; gid: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** An HTTP GET to the published port; any response counts as ready. */
  probe: (url: string) => Promise<boolean>;
  /** The WS26a page check against the preview. */
  pageCheck: (url: string) => Promise<PageCheck>;
  ensureImage: (image: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  egress: () => Promise<Pick<EgressNetwork, "network" | "proxyUrl" | "teardown">>;
  /** Write the tar of `dir` to `out` (never .git or .env files; node_modules only when `modules`). */
  snapshot: (dir: string, out: string, modules: boolean) => Promise<void>;
  /** Whether the run a task preview belongs to is over (or gone). */
  ownerGone: (record: PreviewRecord) => Promise<boolean>;
  tmpDir: () => Promise<string>;
}

async function defaultSnapshot(dir: string, out: string, modules: boolean): Promise<void> {
  const args = ["-cf", out, "--exclude", ".git", "--exclude", ".env", "--exclude", ".env.*", "--exclude", ".npmrc", "--exclude", ".netrc"];
  if (!modules) args.push("--exclude", "node_modules");
  args.push("-C", dir, ".");
  await execFileP("tar", args, { env: { ...childEnv("git"), COPYFILE_DISABLE: "1" }, timeout: 120_000 });
}

async function defaultOwnerGone(record: PreviewRecord): Promise<boolean> {
  const exe = record.source.execution;
  if (record.source.kind !== "task" || !exe) return false;
  try {
    const status = (await (await openExecutionStore(exe)).state()).status;
    return status === "completed" || status === "failed" || status === "aborted";
  } catch (e) {
    // A purged run has no store; any other read problem leaves the preview alone.
    return /not found|no such|ENOENT/i.test(e instanceof Error ? e.message : String(e));
  }
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): PreviewDeps {
  const docker = realDocker();
  const image = defaultSandboxImage(env);
  return {
    docker,
    settings: previewSettings(env),
    limits: { ...DEFAULT_DOCKER_LIMITS, ...dockerLimitsFromEnv(env) },
    image,
    user: containerUser(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    probe: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
        await res.body?.cancel();
        return true;
      } catch { return false; }
    },
    pageCheck: async (url) => {
      if (pageChecksOff()) return { loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "disabled" };
      return pageCheckRecord(await checkPage(url, { preview: true, timeoutMs: 20_000 }));
    },
    ensureImage: async (img) => new DockerBackend({ image: img, env }).prepare(img),
    egress: () => ensureEgressNetwork({ executionTag: `pv${Math.random().toString(36).slice(2, 8)}`, allowlist: [NPM_REGISTRY_HOST], env }),
    snapshot: defaultSnapshot,
    ownerGone: defaultOwnerGone,
    tmpDir: async () => { mkdirPrivate(previewsDir()); return mkdtemp(join(previewsDir(), "tmp-")); },
  };
}

// ============================================================================
// Docker helpers
// ============================================================================

/** The host port from `docker port` output (lines like `127.0.0.1:49153`); only a 127.0.0.1 binding counts. */
export function parsePublishedPort(output: string): number | undefined {
  for (const line of output.split("\n")) {
    const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 65_535) return Number(m[1]);
  }
  return undefined;
}

/** The preview's own networks: the internal one nothing can leave, and the forwarder's, where the loopback port is published. */
export async function createPreviewNetwork(docker: PreviewDocker, id: string): Promise<void> {
  for (const args of [buildNetworkCreateArgs(id), buildForwarderNetworkCreateArgs(id)]) {
    const made = await docker.quiet(args);
    if (!made.ok && !/already exists/i.test(made.output)) throw new PreviewError(`cannot create the preview network: ${scrubAndCap(made.output, 300)}`);
  }
}

/** Remove a preview's networks (idempotent; the containers must be gone first). */
async function removePreviewNetworks(docker: PreviewDocker, id: string): Promise<void> {
  for (const net of [previewNetworkName(id), forwarderNetworkName(id)]) await docker.quiet(["network", "rm", net], 15_000);
}

/** Remove a preview's containers and then its network (all idempotent). */
async function removePreviewParts(docker: PreviewDocker, id: string): Promise<void> {
  await removeContainers(docker, [forwarderName(id), previewContainerName(id), installContainerName(id)]);
  await removePreviewNetworks(docker, id);
}

async function removeContainers(docker: PreviewDocker, names: string[]): Promise<void> {
  for (const name of names) await docker.quiet(["rm", "-f", name], 15_000);
}

// ============================================================================
// Start
// ============================================================================

export async function startPreview(input: StartInput, deps: PreviewDeps = defaultDeps()): Promise<PreviewRecord> {
  const { dir, source } = resolveSource(input);
  const pkg = readPackage(dir);
  const script = pickScript(pkg, input.script);
  const port = defaultPort(pkg, input.port);
  const hostFlag = viteHostFlag(pkg, script);

  const avail = await deps.docker.info();
  if (!avail.ok) throw new PreviewError(`Docker is not available (${avail.reason ?? "unknown"}). Start Docker Desktop or the docker daemon, then try again.`);
  await sweepPreviews(deps);
  const { maxPreviews, ttlMs, readyTimeoutMs } = deps.settings;
  if (readRecords().length >= maxPreviews) {
    throw new PreviewError(`${maxPreviews} previews are already running (the cap; ${PREVIEW_ENV.MAX} changes it). Stop one with preview stop <id>.`);
  }
  const image = await deps.ensureImage(deps.image);
  if (!image.ok) throw new PreviewError(image.error);

  const id = newId("prv");
  const container = previewContainerName(id);
  const work = await deps.tmpDir();
  let egress: Pick<EgressNetwork, "teardown"> | undefined;
  let client: ReturnType<PreviewDocker["start"]> | undefined;
  try {
    const snapshot = join(work, "source.tar");
    const modules = hasNodeModules(dir);
    await deps.snapshot(dir, snapshot, modules);
    if (statSync(snapshot).size > MAX_SNAPSHOT_BYTES) throw new PreviewError("the source is larger than the 256 MB snapshot limit");
    let stdin = snapshot;

    const common = { id, ...deps.user, image: deps.image, limits: deps.limits };
    if (!modules) {
      egress = await deps.egress();
      const installed = join(work, "installed.tar");
      const lock = existsSync(join(dir, "package-lock.json"));
      const net = egress as EgressNetwork;
      const r = await deps.docker.runToFile(
        buildInstallRunArgs({ ...common, network: net.network, proxyUrl: net.proxyUrl, command: lock ? "ci" : "install" }),
        snapshot, installed, { maxBytes: MAX_INSTALLED_BYTES, timeoutMs: INSTALL_TIMEOUT_MS });
      if (!r.ok) {
        const why = r.tooBig ? "the installed tree is larger than 1 GB" : r.timedOut ? "the install timed out" : `npm exited ${r.code}: ${r.tail}`;
        throw new PreviewError(`dependency install failed: ${scrubAndCap(why, 600)}`);
      }
      stdin = installed;
    }

    await createPreviewNetwork(deps.docker, id);
    client = deps.docker.start(buildPreviewRunArgs({ ...common, script, port, hostFlag, labels: { execution: source.execution, task: source.task, prototype: source.prototype, duel: source.duel } }), stdin);
    let early: { code: number | null; tail: string } | undefined;
    void client.exited.then((e) => { early = e; });

    // The forwarder carries the one published port, bound to loopback; it reaches the server over the internal network.
    for (const step of [buildForwarderCreateArgs({ ...common, port }), ["network", "connect", previewNetworkName(id), forwarderName(id)], ["start", forwarderName(id)]]) {
      const r = await deps.docker.quiet(step, 60_000);
      if (!r.ok) throw new PreviewError(`cannot start the preview forwarder: ${scrubAndCap(r.output, 400)}`);
    }
    let hostPort: number | undefined;
    for (const t0 = deps.now(); !hostPort && !early && deps.now() - t0 < PORT_TIMEOUT_MS;) {
      const r = await deps.docker.quiet(["port", forwarderName(id), `${port}/tcp`], 10_000);
      hostPort = r.ok ? parsePublishedPort(r.output) : undefined;
      if (!hostPort) await deps.sleep(300);
    }
    if (!hostPort) throw new PreviewError(early ? `the container exited (${early.code}): ${scrubAndCap(early.tail, 600)}` : "Docker did not publish the port in time");

    // Readiness: any HTTP response on the published port.
    const url = `http://127.0.0.1:${hostPort}/`;
    let ready = false;
    for (const t0 = deps.now(); !ready && !early && deps.now() - t0 < readyTimeoutMs;) {
      ready = await deps.probe(url);
      if (!ready) await deps.sleep(500);
    }
    if (!ready) {
      throw new PreviewError(early
        ? `the dev server stopped before it answered (exit ${early.code}): ${scrubAndCap(early.tail, 600)}`
        : `the dev server did not answer on port ${port} within ${Math.round(readyTimeoutMs / 1000)}s (it must listen on 0.0.0.0 and honour PORT)`);
    }

    const check = await deps.pageCheck(url).catch((): PageCheck => ({ loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "page check unavailable" }));
    const stamp = new Date(deps.now()).toISOString();
    const record: PreviewRecord = {
      id, container, origin: `http://127.0.0.1:${hostPort}`, host_port: hostPort, container_port: port, script,
      source, started_at: stamp, last_seen: stamp, ttl_ms: ttlMs, host: hostname(), check,
    };
    writeRecord(record);
    return record;
  } catch (e) {
    await removePreviewParts(deps.docker, id);
    removeRecord(id);
    throw e;
  } finally {
    client?.detach();
    await egress?.teardown().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

// ============================================================================
// List, stop, sweep
// ============================================================================

export const listPreviews = (): PreviewRecord[] => readRecords();

/** Sweep what expired or lost its owner, then list; asking counts as using, so it restarts the idle time. */
export async function refreshPreviews(deps: PreviewDeps = defaultDeps()): Promise<PreviewRecord[]> {
  await sweepPreviews(deps);
  const records = readRecords();
  for (const r of records) touchRecord(r.id, deps.now());
  return readRecords();
}

/** Stop one preview: remove its container, then its record. Returns false when there is no such preview. */
export async function stopPreview(id: string, deps: Pick<PreviewDeps, "docker"> = defaultDeps()): Promise<boolean> {
  if (!PREVIEW_ID_RE.test(id)) throw new PreviewError("not a preview id (prv-…)");
  const record = readRecord(id);
  if (!record) return false;
  const r = await deps.docker.quiet(["rm", "-f", forwarderName(id), record.container], 20_000);
  if (!r.ok && !/No such container/i.test(r.output)) throw new PreviewError(`could not remove the container: ${scrubAndCap(r.output, 300)}`);
  await removePreviewNetworks(deps.docker, id);
  removeRecord(id);
  return true;
}

/**
 * Stop every preview that belongs to a run (called when the run ends). Best effort: a failure on one
 * preview does not stop the others, and the sweep retries what is left. Touches Docker only when the
 * run has previews. Returns how many were stopped.
 */
export async function stopExecutionPreviews(execution: string, deps?: Pick<PreviewDeps, "docker">): Promise<number> {
  const mine = readRecords().filter((r) => r.source.execution === execution);
  if (!mine.length) return 0;
  const d = deps ?? { docker: defaultDeps().docker };
  let n = 0;
  for (const r of mine) { try { if (await stopPreview(r.id, d)) n++; } catch { /* the sweep retries */ } }
  return n;
}

export async function stopAllPreviews(deps: Pick<PreviewDeps, "docker"> = defaultDeps()): Promise<number> {
  let n = 0;
  for (const r of readRecords()) { try { if (await stopPreview(r.id, deps)) n++; } catch { /* the next sweep retries */ } }
  return n;
}

/** True when a preview start has a work directory younger than 15 minutes. */
function startInProgress(now: number): boolean {
  try {
    let fresh = false;
    for (const n of readdirSync(previewsDir())) {
      if (!n.startsWith("tmp-")) continue;
      try {
        if (now - statSync(join(previewsDir(), n)).mtimeMs < 15 * 60_000) fresh = true;
        else rmSync(join(previewsDir(), n), { recursive: true, force: true }); // left by a crashed start
      } catch { /* gone already */ }
    }
    return fresh;
  } catch { return false; }
}

export interface SweepResult {
  expired: string[];
  ownerGone: string[];
  orphanRecords: string[];
  orphanContainers: string[];
}

/**
 * Remove what nobody can use: previews idle past their TTL, previews whose run ended, records whose
 * container is gone, and labelled containers of this host with no record. Never throws.
 */
export async function sweepPreviews(deps: Pick<PreviewDeps, "docker" | "now" | "ownerGone">): Promise<SweepResult> {
  const result: SweepResult = { expired: [], ownerGone: [], orphanRecords: [], orphanContainers: [] };
  try {
    const listed = await deps.docker.quiet(["ps", "-a", "--filter", `label=${PREVIEW_HOST_LABEL}=${hostname()}`, "--format",
      `{{.Names}} {{.Label "${PREVIEW_LABEL}"}} {{.State}}`], 20_000);
    if (!listed.ok) return result; // Docker is down: leave everything for the next sweep
    const live = new Map<string, string>();
    for (const line of listed.output.split("\n")) {
      const [name, id] = line.trim().split(/\s+/);
      if (name && id && PREVIEW_ID_RE.test(id)) live.set(name, id);
    }
    const records = readRecords();
    const known = new Set(records.map((r) => r.id));
    for (const r of records) {
      if (!live.has(r.container)) { removeRecord(r.id); result.orphanRecords.push(r.id); continue; }
      const idle = deps.now() - Date.parse(r.last_seen);
      if (idle > r.ttl_ms) {
        if (await stopPreview(r.id, deps).catch(() => false)) result.expired.push(r.id);
      } else if (await deps.ownerGone(r).catch(() => false)) {
        if (await stopPreview(r.id, deps).catch(() => false)) result.ownerGone.push(r.id);
      }
    }
    // A start in another process has a container before it has a record: its work directory marks it.
    if (!startInProgress(deps.now())) {
      const strayIds = [...new Set([...live.values()].filter((id) => !known.has(id)))];
      for (const id of strayIds) await removePreviewParts(deps.docker, id);
      result.orphanContainers.push(...[...live].filter(([, id]) => strayIds.includes(id)).map(([name]) => name));
      // Networks left by a start that died before it had containers.
      const nets = await deps.docker.quiet(["network", "ls", "--filter", `label=${PREVIEW_NET_LABEL}`, "--format", `{{.Name}} {{.Label "${PREVIEW_NET_LABEL}"}}`], 20_000);
      if (nets.ok) {
        for (const line of nets.output.split("\n")) {
          const [name, id] = line.trim().split(/\s+/);
          if (name && id && PREVIEW_ID_RE.test(id) && !known.has(id) && !strayIds.includes(id) && (name === previewNetworkName(id) || name === forwarderNetworkName(id))) await deps.docker.quiet(["network", "rm", name], 15_000);
        }
      }
    }
  } catch { /* a failed sweep only delays the next one */ }
  return result;
}

export { touchRecord };
