// ============================================================================
// PreToolUse lease hook: `agent-roundtable hook pre-tool-use`
//
// Claude Code runs it before every Edit, Write, NotebookEdit or MultiEdit of a claude-code worker
// (settings.json), with the hook JSON on stdin and the worker's environment, which carries
// ROUNDTABLE_EXECUTION_ID, ROUNDTABLE_AGENT_ID and ROUNDTABLE_HOME. It reads only the agent's
// leases.json: it never opens the event log and never touches the network, so it is fast.
//
// A write is refused when its path (resolved through symlinks) leaves the task worktree, has a .git
// segment at any depth, names .gitmodules, looks like a secret, or is not covered by a live lease
// (pathCovered, so .git* metadata needs a lease that names it). A refusal exits 2 with the reason
// on stderr, and also prints the structured deny on stdout; Claude Code shows the reason to the
// model. Anything unexpected (no leases file, unreadable input, a crash) refuses: exit 1 would let
// the write through. An allowed write exits 0 silently, so the permission rules still apply.
// ============================================================================

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXECUTION_ID_RE } from "../ids.js";
import { ID_RE } from "../execution/events.js";
import { hasDotGitSegment, pathCovered } from "../execution/leases.js";
import { isContained } from "../security/fs-safe.js";

/** Tools whose target the hook checks; any other tool that reaches it is left to the permission rules. */
export const GATED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

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
  leases: Array<{ task: string; paths: string[] }>;
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
export function resolveTarget(worktree: string, raw: unknown): { rel: string } | { reason: string } {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return { reason: "Refused: the tool call names no file path" };
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
  if (!rel) return { reason: "Refused: that is the worktree itself" };
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

  const raw = args && typeof args === "object" ? (args.file_path ?? args.notebook_path ?? args.path) : undefined;
  const target = resolveTarget(worktree, raw);
  if ("reason" in target) return deny(target.reason, typeof raw === "string" ? raw : undefined);
  const rel = target.rel;
  const segments = rel.split("/");
  if (hasDotGitSegment(rel)) return deny(`Refused: ${rel} is inside a .git directory, which is never writable`, rel);
  if (segments.some((s) => s.toLowerCase() === ".gitmodules")) return deny(`Refused: ${rel} (.gitmodules) is never writable by a worker`, rel);
  if (SECRET_NAME_RE.test(basename(rel))) return deny(`Refused: ${rel} looks like a secret file; workers never write secrets`, rel);
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
