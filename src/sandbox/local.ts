// ============================================================================
// Local sandbox backend (opt-in: ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1)
//
// For machines without Docker. It is weaker than Docker and says so:
//   - macOS: sandbox-exec with a generated profile. No network (not even loopback), writes only to
//     the workdir, a per-run temp dir and /dev, but never to the workdir root itself (so it cannot
//     be swapped for a symlink) or to its .git (host-side git runs there later, so a swapped
//     gitfile or a config with core.fsmonitor would run code on the host). No reads of credential
//     stores under the home directory, the roundtable's state, or .env files outside the workdir,
//     no signals to processes outside the sandbox, and no keychain, LaunchServices, AppleEvents or
//     pasteboard services.
//   - Linux: `unshare -rn` (new user and network namespaces) when the kernel allows it. Only the
//     network is isolated (.git and the workdir root stay writable), so every result carries
//     `degraded`.
//   - Anything else: no isolation at all, reported as `degraded`.
// No backend here limits CPU, memory or process count, and reads outside the listed paths are
// allowed. Every run gets an empty HOME and TMPDIR and the sandbox-local env profile.
// ============================================================================

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import type { SandboxBackend, SandboxResult, SandboxRunRequest } from "../execution/types.js";
import { childEnv } from "../security/child-env.js";
import { isContained, mkdirPrivate } from "../security/fs-safe.js";
import {
  SANDBOX_ENV,
  SandboxRequestError,
  canonicalWorkdir,
  clampOutputBytes,
  clampTimeout,
  isShellCommand,
  localSandboxAllowed,
  resolveCwd,
  validateArgv,
  validateEnv,
} from "./common.js";
import { runQuiet, sandboxShuttingDown, spawnCaptured } from "./process.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 5_000;

/** Paths under each home directory that a sandboxed command may not read. */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".config/git/credentials",
  ".docker",
  ".kube",
  ".azure",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".codex",
  ".agent-roundtable",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Claude",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Safari",
];
/** Prefixes under each home directory (".claude" covers ~/.claude, ~/.claude.json and the like). */
export const SENSITIVE_HOME_PREFIXES: readonly string[] = [".claude"];

/** Mach services a command has no business reaching (keychain, app launching, AppleEvents, clipboard). */
const DENIED_MACH = [
  '(global-name "com.apple.SecurityServer")',
  '(global-name "com.apple.securityd")',
  '(global-name "com.apple.coreservices.launchservicesd")',
  '(global-name-prefix "com.apple.lsd.")',
  '(global-name "com.apple.coreservices.appleevents")',
  '(global-name-prefix "com.apple.pasteboard")',
];

/** Variables the local backend sets itself, plus loader hooks that could subvert the wrapper. */
const RESERVED_ENV = ["HOME", "TMPDIR", "TMP", "TEMP"];
const LOADER_ENV_RE = /^(LD_|DYLD_)/i;

// ============================================================================
// Seatbelt profile (pure)
// ============================================================================

export interface SeatbeltPaths {
  /** Real path of the workdir (read/write). */
  workdir: string;
  /** Real path of the per-run temp dir holding HOME and TMPDIR (read/write). */
  tmp: string;
  /** Real paths of the home directories whose credential stores are hidden. */
  homes: string[];
  /** Real path of the roundtable state directory (hidden, except a workdir inside it). */
  roundtableHome?: string;
  /** Further real paths to hide. */
  denyRead?: string[];
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = dirname(p);
  for (;;) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * The sandbox-exec profile and its `-D NAME=value` parameters. Paths only ever travel as
 * parameters, so no path needs quoting inside the profile. Later rules win, which is how the
 * workdir stays readable when it lives under a hidden directory (task worktrees live under
 * ROUNDTABLE_HOME), and why the workdir's ancestors get metadata access (realpath needs lstat).
 */
export function buildSeatbeltProfile(p: SeatbeltPaths): { profile: string; params: string[] } {
  const params: string[] = [];
  const param = (name: string, value: string) => {
    params.push("-D", `${name}=${value}`);
    return `(param "${name}")`;
  };
  const work = param("WORKDIR", p.workdir);
  const tmp = param("TMPDIR", p.tmp);
  const hidden: string[] = [];
  [...new Set(p.homes)].forEach((home, i) => {
    const h = param(`HOME_${i}`, home);
    for (const rel of SENSITIVE_HOME_PATHS) hidden.push(`(subpath (string-append ${h} "/${rel}"))`);
    for (const rel of SENSITIVE_HOME_PREFIXES) hidden.push(`(prefix (string-append ${h} "/${rel}"))`);
  });
  if (p.roundtableHome) hidden.push(`(subpath ${param("RT_HOME", p.roundtableHome)})`);
  (p.denyRead ?? []).forEach((d, i) => hidden.push(`(subpath ${param(`DENY_${i}`, d)})`));
  // Secrets in .env files anywhere outside the workdir (the roundtable's own .env included).
  hidden.push(String.raw`(regex #"/\.env[^/]*$")`);
  const meta = [...new Set([...ancestors(p.workdir), ...ancestors(p.tmp)])].map((a, i) => `(literal ${param(`ANC_${i}`, a)})`);

  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${work}) (subpath ${tmp}) (subpath "/dev"))`,
    // Files inside the workdir may be created and changed, but the root itself may not be removed
    // or replaced (a symlink in its place would widen every later run), and .git is untouchable.
    `(deny file-write* (literal ${work}) (literal (string-append ${work} "/.git")) (subpath (string-append ${work} "/.git")))`,
    `(deny file-read*\n  ${hidden.join("\n  ")})`,
    `(allow file-read* (subpath ${work}) (subpath ${tmp}))`,
    `(allow file-read-metadata ${meta.join(" ")})`,
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    `(deny mach-lookup ${DENIED_MACH.join(" ")})`,
    "",
  ].join("\n");
  return { profile, params };
}

// ============================================================================
// Isolation probe
// ============================================================================

export type LocalIsolation =
  | { kind: "sandbox-exec" }
  | { kind: "unshare"; path: string; degraded: string }
  | { kind: "none"; degraded: string };

function findOnPath(name: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  for (const d of ["/usr/bin", "/bin"]) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

const UNISOLATED = "commands run without isolation (network, files, the workdir's .git and the workdir itself are all reachable)";

async function probeIsolation(platform: NodeJS.Platform): Promise<LocalIsolation> {
  const env = childEnv("sandbox-local");
  if (platform === "darwin") {
    if (existsSync(SANDBOX_EXEC)) {
      const r = await runQuiet(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], env, PROBE_TIMEOUT_MS);
      if (r.ok) return { kind: "sandbox-exec" };
      return { kind: "none", degraded: `sandbox-exec failed (${r.output.slice(0, 200) || `exit ${r.exit}`}); ${UNISOLATED}` };
    }
    return { kind: "none", degraded: `sandbox-exec is missing; ${UNISOLATED}` };
  }
  if (platform === "linux") {
    const unshare = findOnPath("unshare");
    if (unshare) {
      const r = await runQuiet(unshare, ["-rn", "--", "true"], env, PROBE_TIMEOUT_MS);
      if (r.ok) {
        return {
          kind: "unshare",
          path: unshare,
          degraded: "unshare -rn isolates the network only; filesystem reads and writes are not restricted, including the workdir's .git and the workdir itself",
        };
      }
      return { kind: "none", degraded: `unshare -rn is not permitted here (${r.output.slice(0, 200) || `exit ${r.exit}`}); ${UNISOLATED}` };
    }
    return { kind: "none", degraded: `unshare is missing; ${UNISOLATED}` };
  }
  return { kind: "none", degraded: `no isolation is available on ${platform}; ${UNISOLATED}` };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function homeDirs(): string[] {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    /* no passwd entry */
  }
  return [...new Set(homes.filter(Boolean).map(realOrSelf))];
}

// ============================================================================
// Backend
// ============================================================================

export interface LocalBackendOptions {
  /** Source of ROUNDTABLE_ALLOW_LOCAL_SANDBOX; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override for tests. */
  platform?: NodeJS.Platform;
  /** Hidden from commands (default: ROUNDTABLE_HOME). */
  roundtableHome?: string;
  /** Further absolute paths commands may not read on macOS (e.g. the main checkout's secrets). */
  denyRead?: string[];
}

export class LocalBackend implements SandboxBackend {
  readonly id = "local" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly roundtableHome: string;
  private readonly denyRead: string[];
  private probe?: Promise<LocalIsolation>;

  constructor(opts: LocalBackendOptions = {}) {
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.roundtableHome = opts.roundtableHome ?? ROUNDTABLE_HOME;
    this.denyRead = opts.denyRead ?? [];
  }

  /** The isolation in use, probed once. */
  isolation(): Promise<LocalIsolation> {
    this.probe ??= probeIsolation(this.platform);
    return this.probe;
  }

  async available(): Promise<{ ok: boolean; reason?: string; degraded?: string }> {
    if (!localSandboxAllowed(this.env)) {
      return { ok: false, reason: `the local sandbox is disabled; set ${SANDBOX_ENV.ALLOW_LOCAL}=1 to allow it` };
    }
    const iso = await this.isolation();
    return iso.kind === "sandbox-exec" ? { ok: true } : { ok: true, degraded: iso.degraded };
  }

  async run(req: SandboxRunRequest): Promise<SandboxResult> {
    const started = Date.now();
    if (!localSandboxAllowed(this.env)) throw new SandboxRequestError(`the local sandbox is disabled; set ${SANDBOX_ENV.ALLOW_LOCAL}=1 to allow it`);
    const argv = validateArgv(req.argv);
    if (isShellCommand(argv)) {
      throw new SandboxRequestError("shell -c commands are refused on the local backend; pass the program and its arguments as argv");
    }
    const userEnv = validateEnv(req.env, RESERVED_ENV);
    for (const k of Object.keys(userEnv)) {
      if (LOADER_ENV_RE.test(k)) throw new SandboxRequestError(`env name ${k} is refused on the local backend (dynamic loader control)`);
    }
    if (Array.isArray(req.egress) && req.egress.length) {
      throw new SandboxRequestError("the local backend has no egress proxy; commands that need the network require the docker backend");
    }
    // Resolve the workdir once (a symlinked workdir is refused) and use only that path from here.
    const workdir = canonicalWorkdir(req.workdir).path;
    let cwd: string;
    try {
      cwd = realpathSync(join(workdir, resolveCwd(req.cwd)));
    } catch (e) {
      if (e instanceof SandboxRequestError) throw e;
      throw new SandboxRequestError(`cwd does not exist: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A symlinked cwd must not lead out of the workdir.
    if (!isContained(workdir, cwd)) throw new SandboxRequestError("cwd resolves outside the workdir");
    if (!statSync(cwd).isDirectory()) throw new SandboxRequestError("cwd is not a directory");

    const iso = await this.isolation();
    const degraded = iso.kind === "sandbox-exec" ? undefined : iso.degraded;
    if (sandboxShuttingDown()) {
      return { exit: null, timedOut: false, durationMs: Date.now() - started, output: "sandbox is shutting down", truncated: false, backend: "local", degraded };
    }

    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-sbx-")));
    try {
      const home = join(root, "home");
      const tmp = join(root, "tmp");
      mkdirPrivate(home);
      mkdirPrivate(tmp);
      const env = childEnv("sandbox-local", { ...userEnv, HOME: home, TMPDIR: tmp });

      let file: string;
      let args: string[];
      if (iso.kind === "sandbox-exec") {
        const rtHome = existsSync(this.roundtableHome) ? realOrSelf(this.roundtableHome) : this.roundtableHome;
        const { profile, params } = buildSeatbeltProfile({
          workdir,
          tmp: root,
          homes: homeDirs(),
          roundtableHome: rtHome,
          denyRead: this.denyRead.map(realOrSelf),
        });
        file = SANDBOX_EXEC;
        args = ["-p", profile, ...params, "--", ...argv];
      } else if (iso.kind === "unshare") {
        file = iso.path;
        args = ["-rn", "--", ...argv];
      } else {
        file = argv[0];
        args = argv.slice(1);
      }

      const r = await spawnCaptured(file, args, {
        env,
        cwd,
        timeoutMs: clampTimeout(req.timeoutMs),
        maxOutputBytes: clampOutputBytes(req.maxOutputBytes),
        signal: req.signal,
        label: `local:${basename(argv[0])}`,
      });
      return {
        exit: r.exit,
        signal: r.signal,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        output: r.output,
        truncated: r.truncated,
        backend: "local",
        degraded,
      };
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}
