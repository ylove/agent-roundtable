// ============================================================================
// PreToolUse lease hook: `agent-roundtable hook pre-tool-use`
//
// Claude Code runs it before every Read, Glob, Grep, Edit, Write, NotebookEdit or MultiEdit of a claude-code worker
// (settings.json), with the hook JSON on stdin and the worker's environment, which carries
// ROUNDTABLE_EXECUTION_ID, ROUNDTABLE_AGENT_ID and ROUNDTABLE_HOME. Authority comes from the agent's
// leases.json; paths are inspected on disk. The hook never opens the event log or uses the network.
//
// A write is refused when its path (resolved through symlinks) leaves the task worktree, has a .git
// segment at any depth, names .gitmodules, looks like a secret, or is not covered by a live lease
// (pathCovered, so .git* metadata needs a lease that names it). A refusal exits 2 with the reason
// on stderr, and also prints the structured deny on stdout; Claude Code shows the reason to the
// model. Anything unexpected (no leases file, unreadable input, a crash) refuses: exit 1 would let
// the write through. An allowed write exits 0 silently, so the permission rules still apply.
// ============================================================================

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXECUTION_ID_RE } from "../ids.js";
import { ID_RE } from "../execution/events.js";
import { hasDotGitSegment, pathCovered } from "../execution/leases.js";
import { isContained } from "../security/fs-safe.js";

/** Tools whose target the hook checks; any other tool that reaches it is left to the permission rules. */
export const GATED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "Read", "Glob", "Grep"]);

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** .env*, *.pem, *.key, SSH keys (id_rsa, id_ed25519.pub, …), .npmrc, .netrc. */
const SECRET_NAME_RE = /^(?:\.env.*|.*\.pem|.*\.key|id_[A-Za-z0-9_-]+(?:\.pub)?|\.npmrc|\.netrc)$/i;

export type HookDecision = { allow: true; path?: string } | { allow: false; reason: string; path?: string };

const deny = (reason: string, path?: string): HookDecision => ({ allow: false, reason, ...(path !== undefined && { path }) });

export function noLeaseMessage(path: string): string {
  return `No lease for ${path}: call lease(request) or escalate(with: path_owner)`;
}

interface LeasesFile {
  execution: string;
  agent: string;
  task?: string;
  leases: Array<{ task: string; paths: string[]; excludes?: string[] }>;
}

function readLeases(path: string): LeasesFile | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) return null;
    const f = JSON.parse(readFileSync(path, "utf8")) as LeasesFile;
    if (!f || typeof f !== "object" || !Array.isArray(f.leases)) return null;
    return f;
  } catch {
    return null;
  }
}

const toPosix = (p: string) => p.split(sep).join("/");

/**
 * The worktree-relative path a write would really change, or a refusal. The deepest existing
 * ancestor is resolved with realpath (so a symlinked directory is followed and judged by where it
 * leads); a target that is itself a symlink, or a path with "..", is refused.
 */
export function resolveTarget(worktree: string, raw: unknown, allowRoot = false): { rel: string } | { reason: string } {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return { reason: "Refused: the tool call names no file path" };
  if (raw.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.includes("\\")) return { reason: `Refused: ${raw} must be a relative or absolute path inside your worktree` };
  if (raw.split(/[\\/]/).includes("..")) return { reason: `Refused: ${raw} contains "..": pass a path inside your worktree` };
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(worktree, raw);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    let exists = true;
    try {
      lstatSync(cur);
    } catch {
      exists = false;
    }
    if (exists) break;
    const up = dirname(cur);
    if (up === cur) return { reason: `Refused: ${raw} is outside your task worktree` };
    rest.unshift(basename(cur));
    cur = up;
  }
  if (!rest.length && lstatSync(cur).isSymbolicLink()) return { reason: `Refused: ${raw} is a symlink; edit the file it points to` };
  let real: string;
  try {
    real = join(realpathSync(cur), ...rest);
  } catch {
    return { reason: `Refused: cannot resolve ${raw}` };
  }
  if (!isContained(worktree, real)) return { reason: `Refused: ${raw} is outside your task worktree` };
  const rel = toPosix(relative(worktree, real));
  if (!rel && !allowRoot) return { reason: "Refused: that is the worktree itself" };
  return { rel };
}

/** The decision for one PreToolUse input in an environment (pure apart from reading the leases file and lstat). */
export function decidePreToolUse(input: unknown, env: NodeJS.ProcessEnv = process.env): HookDecision {
  if (!input || typeof input !== "object") return deny("Refused: the lease hook could not read the tool call");
  const { tool_name: tool, tool_input: args } = input as { tool_name?: unknown; tool_input?: Record<string, unknown> };
  if (typeof tool !== "string") return deny("Refused: the lease hook could not read the tool call");
  if (!GATED_TOOLS.has(tool)) return { allow: true };

  const exe = env.ROUNDTABLE_EXECUTION_ID ?? "";
  const agent = env.ROUNDTABLE_AGENT_ID ?? "";
  if (!EXECUTION_ID_RE.test(exe) || !ID_RE.test(agent)) {
    return deny("Refused: this worker has no ROUNDTABLE_EXECUTION_ID / ROUNDTABLE_AGENT_ID, so its leases are unknown");
  }
  const home = env.ROUNDTABLE_HOME || join(homedir(), ".agent-roundtable");
  const leases = readLeases(join(home, "executions", exe, "agents", agent, "leases.json"));
  if (!leases || leases.execution !== exe || leases.agent !== agent) {
    return deny("Refused: no leases file for this worker; call lease(request) or escalate(with: orchestrator)");
  }
  const task = leases.task;
  if (typeof task !== "string" || !ID_RE.test(task)) return deny("Refused: you hold no task; call claim_task or escalate(with: orchestrator)");
  const wtPath = join(home, "worktrees", exe, task);
  if (!existsSync(wtPath)) return deny(`Refused: the worktree of task ${task} does not exist`);
  let worktree: string;
  try {
    if (lstatSync(wtPath).isSymbolicLink()) return deny(`Refused: the worktree of task ${task} is a symlink`);
    worktree = realpathSync(wtPath);
  } catch {
    return deny(`Refused: cannot resolve the worktree of task ${task}`);
  }

  const reading = tool === "Read" || tool === "Glob" || tool === "Grep";
  const raw = args && typeof args === "object" ? (args.file_path ?? args.notebook_path ?? args.path ?? (reading ? "." : undefined)) : undefined;
  if (tool === "Read" && (!args || typeof args.file_path !== "string")) return deny("Refused: the tool call names no file path");
  if (tool === "Glob") {
    if (typeof args?.pattern !== "string") return deny("Refused: Glob names no pattern");
    const pattern = args.pattern;
    if (pattern.startsWith("~") || isAbsolute(pattern) || pattern.includes("\\") || pattern.includes("..") || /[{}()~]/.test(pattern) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(pattern)) {
      return deny("Refused: Glob needs a relative pattern inside your worktree");
    }
  }
  const target = resolveTarget(worktree, raw, reading);
  if ("reason" in target) return deny(target.reason, typeof raw === "string" ? raw : undefined);
  const rel = target.rel;
  const segments = rel.split("/");
  if (hasDotGitSegment(rel)) return deny(`Refused: ${rel} is inside a .git directory, which is never writable`, rel);
  if (segments.some((s) => s.toLowerCase() === ".gitmodules")) return deny(`Refused: ${rel} (.gitmodules) is never writable by a worker`, rel);
  if (rel.split("/").some((s) => SECRET_NAME_RE.test(s))) return deny(`Refused: ${rel} looks like a secret file; workers never access secrets`, rel);
  if (reading) {
    // Searches may recurse or follow links: validate the whole reachable subtree before allowing them.
    const seen = new Set<string>();
    const inspect = (path: string): string | undefined => {
      if (SECRET_NAME_RE.test(basename(path))) return `Refused: ${path} looks like a secret file`;
      const real = realpathSync(path);
      if (!isContained(worktree, real)) return `Refused: ${path} is outside your task worktree`;
      const parts = toPosix(relative(worktree, real)).split("/");
      if (parts.some((s) => SECRET_NAME_RE.test(s))) return `Refused: ${path} looks like a secret file`;
      if (parts.some((s) => s.toLowerCase() === ".git")) return `Refused: ${path} is inside a .git directory`;
      if (seen.has(real)) return undefined;
      seen.add(real);
      if (lstatSync(real).isDirectory()) {
        for (const name of readdirSync(real)) {
          // A worktree's gitfile is a pointer, not a directory a search can traverse.
          if (name === ".git" && lstatSync(join(real, name)).isFile()) continue;
          const reason = inspect(join(real, name));
          if (reason) return reason;
        }
      }
      return undefined;
    };
    try {
      const reason = inspect(join(worktree, rel));
      if (reason) return deny(reason, rel);
    } catch {
      return deny(`Refused: cannot inspect ${rel || "."}`, rel);
    }
    return { allow: true, path: rel };
  }
  const mine = leases.leases.filter((l) => l && l.task === task && Array.isArray(l.paths));
  if (!pathCovered(rel, mine)) return deny(noLeaseMessage(rel), rel);
  return { allow: true, path: rel };
}

/** The structured deny Claude Code also accepts on stdout (with exit 2, stderr carries the same reason). */
export function denyOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += b.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("hook input too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The CLI entry: returns the exit code (0 allow, 2 deny) after writing the deny to stdout and stderr. */
export async function runPreToolUseHook(
  stdin: NodeJS.ReadableStream = process.stdin,
  out: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let decision: HookDecision;
  try {
    decision = decidePreToolUse(JSON.parse(await readStdin(stdin)), env);
  } catch (e) {
    decision = deny(`Refused: the lease hook failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (decision.allow) return 0;
  out.stdout(denyOutput(decision.reason) + "\n");
  out.stderr(decision.reason + "\n");
  return 2;
}
