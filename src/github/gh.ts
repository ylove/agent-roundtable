// ============================================================================
// Hardened `gh` runner for GitHub sync and the execute preflight
//
//   - argv only (no shell), the absolute path of gh found on PATH, cwd a neutral directory
//   - childEnv("gh"): only gh's own credentials and settings reach the child, prompts disabled
//   - 30 s timeout (SIGTERM, then SIGKILL), stdout and stderr capped
//   - bodies go through --body-file temp files (mode 0600, in a private 0700 directory, removed
//     afterwards) or stdin, never on argv
//   - errors are scrubbed of secrets, capped and classified (rate limits, auth, not found, ...)
//
// Only gh subcommands and `gh api graphql` are used: never a REST path.
// ============================================================================

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../executables.js";
import { childEnv } from "../security/child-env.js";
import { scrubAndCap } from "../security/secrets.js";

export const GH_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;

export type GhErrorKind = "missing" | "timeout" | "rate_limit" | "auth" | "not_found" | "output" | "other";

export class GhError extends Error {
  constructor(
    message: string,
    readonly kind: GhErrorKind,
    readonly code: number | null = null
  ) {
    super(message);
    this.name = "GhError";
  }
}

export interface GhRunOptions {
  /** Written to the child's stdin (for --body-file - or --input -). */
  input?: string;
  timeoutMs?: number;
}

export interface GhResult {
  stdout: string;
  stderr: string;
}

/** How gh calls are made; GitHubSync takes one so tests can count or replace calls. */
export type GhRunner = (args: string[], opts?: GhRunOptions) => Promise<GhResult>;

/** Sort a failed call's stderr into a kind the caller can act on. */
export function classifyGhError(stderr: string): GhErrorKind {
  if (/secondary rate limit|rate limit exceeded|was submitted too quickly|abuse detection|RATE_LIMITED|API rate limit/i.test(stderr)) return "rate_limit";
  if (/HTTP 401|authentication|not logged in|gh auth login|bad credentials|requires authentication/i.test(stderr)) return "auth";
  if (/HTTP 404|not found|could not resolve to/i.test(stderr)) return "not_found";
  return "other";
}

/** Short, scrubbed description of a gh call for errors: the subcommand only, never bodies or values. */
function label(args: string[]): string {
  const words = args.filter((a) => !a.startsWith("-")).slice(0, 2);
  return `gh ${words.join(" ")}`;
}

/**
 * Run gh with argv only. Resolves with its output on exit 0; rejects with a GhError otherwise
 * (gh missing, timeout, oversized output, or a non-zero exit, classified from stderr).
 */
export const runGh: GhRunner = (args, opts = {}) => {
  const gh = findExecutable("gh");
  if (!gh) return Promise.reject(new GhError("gh is not installed or not on PATH", "missing"));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(gh, args, {
        cwd: tmpdir(),
        env: childEnv("gh"),
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      return reject(new GhError(`${label(args)}: cannot start gh: ${scrubAndCap(String((e as Error).message), 300)}`, "missing"));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let oversized = false;
    let timedOut = false;
    let settled = false;
    const kill = (sig: NodeJS.Signals) => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs ?? GH_TIMEOUT_MS);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > STDOUT_CAP) {
        if (!oversized) kill("SIGKILL");
        oversized = true;
      } else out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (errBytes < STDERR_CAP) err.push(d.subarray(0, STDERR_CAP - errBytes));
      errBytes += d.length;
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.input);
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on("error", (e) => finish(() => reject(new GhError(`${label(args)}: ${scrubAndCap(e.message, 300)}`, "missing"))));
    child.on("close", (code) =>
      finish(() => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        if (timedOut) return reject(new GhError(`${label(args)}: timed out after ${Math.round((opts.timeoutMs ?? GH_TIMEOUT_MS) / 1000)} s`, "timeout"));
        if (oversized) return reject(new GhError(`${label(args)}: output larger than ${STDOUT_CAP} bytes`, "output"));
        if (code !== 0) {
          const detail = scrubAndCap((stderr || stdout).trim().replace(/\s+/g, " "), 400);
          return reject(new GhError(`${label(args)} failed (exit ${code}): ${detail}`, classifyGhError(stderr || stdout), code));
        }
        resolve({ stdout, stderr });
      })
    );
  });
};

/** Parse gh's JSON output; a GhError of kind "output" when it is not JSON. */
export function parseGhJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GhError(`${what}: gh did not return JSON`, "output");
  }
}

/** Run gh and parse its JSON output. */
export async function ghJson<T>(run: GhRunner, args: string[], opts?: GhRunOptions): Promise<T> {
  return parseGhJson<T>((await run(args, opts)).stdout, label(args));
}

/**
 * Call fn with the path of a temp file holding `body` (mode 0600, in a fresh 0700 directory),
 * for gh's --body-file. The file is removed when fn settles.
 */
export async function withBodyFile<T>(body: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rt-gh-"));
  const path = join(dir, "body.md");
  try {
    writeFileSync(path, body, { mode: 0o600, flag: "wx" });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `gh api graphql` with a constant query and string variables (-f: always strings, never @file). */
export async function ghGraphql<T>(run: GhRunner, query: string, vars: Record<string, string>, headers: string[] = []): Promise<T> {
  const args = ["api", "graphql", ...headers.flatMap((h) => ["-H", h]), "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  const res = await ghJson<{ data?: T; errors?: Array<{ message?: string; type?: string }> }>(run, args);
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message ?? e.type ?? "error").join("; ");
    throw new GhError(`gh api graphql: ${scrubAndCap(msg, 400)}`, classifyGhError(`${msg} ${res.errors.map((e) => e.type ?? "").join(" ")}`));
  }
  if (!res.data) throw new GhError("gh api graphql: no data in the response", "output");
  return res.data;
}

// ---------------------------------------------------------------------------
// Preflight (execute, WS11)
// ---------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const OWNER_RE = /^(?:@me|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;

export function isRepoName(repo: string): boolean {
  return typeof repo === "string" && REPO_RE.test(repo) && !repo.endsWith(".git");
}

export function isOwnerName(owner: string): boolean {
  return typeof owner === "string" && OWNER_RE.test(owner);
}

/** Scopes of the active gh account on github.com (JSON status first, then the text form of older gh). */
async function tokenScopes(run: GhRunner): Promise<string[] | null> {
  const parse = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
  try {
    const st = await ghJson<{ hosts?: Record<string, Array<{ active?: boolean; state?: string; scopes?: string }>> }>(run, [
      "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts",
    ]);
    const acct = (st.hosts?.["github.com"] ?? []).find((a) => a.active !== false);
    if (!acct || acct.state !== "success") return null;
    return parse(acct.scopes ?? "");
  } catch (e) {
    if (e instanceof GhError && (e.kind === "missing" || e.kind === "auth" || e.kind === "timeout")) throw e;
  }
  // Older gh: no --json on auth status; it prints "Token scopes: 'repo', 'project'".
  const r = await run(["auth", "status", "--hostname", "github.com"]);
  const m = /Token scopes:\s*(.*)/i.exec(`${r.stdout}\n${r.stderr}`);
  return m ? parse(m[1]) : [];
}

export interface GhReadiness {
  ok: boolean;
  /** What is missing, in words the human can act on. */
  missing: string[];
}

/**
 * Can GitHub sync run? gh must be installed and logged in to github.com with the `repo` and
 * `project` scopes (`project` only when a project is wanted), and must be able to write issues
 * in `repo`; a project given by number must be readable. Never throws.
 */
export async function checkGhReady(
  opts: { repo: string; project?: boolean | { owner?: string; number?: number } },
  run: GhRunner = runGh
): Promise<GhReadiness> {
  const missing: string[] = [];
  if (!isRepoName(opts.repo)) return { ok: false, missing: [`a valid repository name ("owner/name"), not ${JSON.stringify(String(opts.repo).slice(0, 80))}`] };
  const wantProject = opts.project !== undefined && opts.project !== false;
  let scopes: string[] | null;
  try {
    scopes = await tokenScopes(run);
  } catch (e) {
    const kind = e instanceof GhError ? e.kind : "other";
    if (kind === "missing") return { ok: false, missing: ["the gh CLI (install it from https://cli.github.com)"] };
    return { ok: false, missing: ["a gh login for github.com (run: gh auth login --scopes repo,project)"] };
  }
  if (scopes === null) return { ok: false, missing: ["a gh login for github.com (run: gh auth login --scopes repo,project)"] };
  // Fine-grained tokens list no scopes: their permissions are checked by the calls below.
  if (scopes.length) {
    if (!scopes.includes("repo")) missing.push("the gh token scope `repo` (run: gh auth refresh --scopes repo)");
    if (wantProject && !scopes.includes("project")) missing.push("the gh token scope `project` (run: gh auth refresh --scopes project)");
  }
  try {
    const repo = await ghJson<{ viewerPermission?: string; hasIssuesEnabled?: boolean }>(run, [
      "repo", "view", opts.repo, "--json", "viewerPermission,hasIssuesEnabled",
    ]);
    if (!["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(repo.viewerPermission ?? "")) {
      missing.push(`write access to ${opts.repo} (the gh account has ${repo.viewerPermission ?? "no"} permission)`);
    }
    if (repo.hasIssuesEnabled === false) missing.push(`issues enabled on ${opts.repo}`);
  } catch (e) {
    missing.push(`access to ${opts.repo} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (wantProject && typeof opts.project === "object" && opts.project.number !== undefined) {
    const owner = opts.project.owner ?? opts.repo.split("/")[0];
    if (!isOwnerName(owner) || !Number.isSafeInteger(opts.project.number) || opts.project.number <= 0) {
      missing.push("a valid project owner and number");
    } else {
      try {
        await ghJson(run, ["project", "view", String(opts.project.number), "--owner", owner, "--format", "json"]);
      } catch (e) {
        missing.push(`access to project ${owner}/${opts.project.number} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
