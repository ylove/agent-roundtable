// ============================================================================
// Configuration (reads process.env only; imports no local modules)
// ============================================================================

import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Version (also reported by debug_env and the startup banner)
export const VERSION = "0.4.0";

// Agent meetings
// The default is relative to the server process's cwd (whatever directory the MCP host launched it
// from), which is why README and .env.example ask for an absolute ROUNDTABLE_AGENTS_DIR.
export const AGENTS_DIR = process.env.ROUNDTABLE_AGENTS_DIR || ".claude/agents";
export const SKILLS_DIR = process.env.ROUNDTABLE_SKILLS_DIR || join(dirname(AGENTS_DIR), "skills");

/** Use the project containing .claude/agents, or the process cwd for a custom agent directory. */
export function defaultWorkspaceDir(): string {
  const a = resolve(AGENTS_DIR);
  return basename(a) === "agents" && basename(dirname(a)) === ".claude"
    ? dirname(dirname(a))
    : process.cwd();
}

export const WORKSPACE_DIR = process.env.ROUNDTABLE_WORKSPACE_DIR || defaultWorkspaceDir();

// Local state root (built from the home directory at runtime so no literal home path appears in source).
// Archived sessions, heads-down runs, task worktrees and the audit log live under it.
export const ROUNDTABLE_HOME = process.env.ROUNDTABLE_HOME || join(homedir(), ".agent-roundtable");
export const SESSIONS_DIR = join(ROUNDTABLE_HOME, "sessions");
export const EXECUTIONS_DIR = join(ROUNDTABLE_HOME, "executions");
export const WORKTREES_DIR = join(ROUNDTABLE_HOME, "worktrees");
export const AUDIT_DIR = join(ROUNDTABLE_HOME, "audit");

const activityLog = process.env.ROUNDTABLE_ACTIVITY_LOG;
export const ACTIVITY_LOG_PATH: string | null = !activityLog
  ? join(ROUNDTABLE_HOME, "activity.jsonl")
  : /^(off|false|0|no)$/i.test(activityLog) ? null : activityLog;
export const ACTIVITY_LOG_MAX_ENTRIES = 500;
export const PARALLEL_TURNS = Math.max(1, parseInt(process.env.ROUNDTABLE_PARALLEL_TURNS || "4", 10) || 4);
export const MAX_TOKENS = parseInt(process.env.ROUNDTABLE_MAX_TOKENS || "8192", 10);
export const LLM_TIMEOUT_MS = parseInt(process.env.ROUNDTABLE_LLM_TIMEOUT_MS || "600000", 10);
export const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");

// Text LLM providers
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "together"
  | "replicate"
  | "ollama"
  | "openai_compatible";
export const PROVIDER_IDS: LLMProvider[] = [
  "anthropic",
  "openai",
  "together",
  "replicate",
  "ollama",
  "openai_compatible",
];

// Anthropic: both current models are first-class; short aliases are accepted wherever a model is given
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
};
export function resolveAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

// Default models per provider (each overridable from the environment)
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: resolveAnthropicModel(process.env.ROUNDTABLE_ANTHROPIC_MODEL || "claude-opus-5"),
  openai: process.env.ROUNDTABLE_OPENAI_MODEL || "gpt-5.6-luna",
  together: process.env.ROUNDTABLE_TOGETHER_MODEL || "zai-org/GLM-5.3",
  replicate: process.env.ROUNDTABLE_REPLICATE_MODEL || "qwen/qwen3-235b-a22b-instruct-2507",
  ollama: process.env.ROUNDTABLE_OLLAMA_MODEL || "qwen3:14b",
  openai_compatible: process.env.OPENAI_COMPATIBLE_MODEL || "default",
};

export function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} not configured (required for ${purpose}). Set it in the MCP server .env file.`
    );
  }
  return value;
}

// Shared description for every tool's optional `model` parameter
export const MODEL_PARAM_DESCRIPTION =
  `Model id. Defaults: ${PROVIDER_IDS.map((p) => `${DEFAULT_MODELS[p]} (${p})`).join(", ")}. ` +
  `Anthropic also accepts the aliases "opus" (claude-opus-5) and "sonnet" (claude-sonnet-5). ` +
  `Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL.`;

// Public sessions: publishing a session's turns to a world-readable channel (see src/publishers/)
// ROUNDTABLE_PUBLISHER selects the backend; it is validated when a public channel is created, not at startup.
export const PUBLISHER_KIND = (process.env.ROUNDTABLE_PUBLISHER || "ntfy").trim().toLowerCase();
export const NTFY_URL = (process.env.ROUNDTABLE_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
export const NTFY_TOKEN = process.env.ROUNDTABLE_NTFY_TOKEN || "";
export const NTFY_USER = process.env.ROUNDTABLE_NTFY_USER || "";
export const NTFY_PASSWORD = process.env.ROUNDTABLE_NTFY_PASSWORD || "";
export const WEBHOOK_URL = process.env.ROUNDTABLE_WEBHOOK_URL || "";
export const WEBHOOK_VIEW_URL = process.env.ROUNDTABLE_WEBHOOK_VIEW_URL || "";
export const WEBHOOK_AUTH_HEADER = process.env.ROUNDTABLE_WEBHOOK_AUTH_HEADER || "";
export const PUBLIC_TOPIC_PREFIX = process.env.ROUNDTABLE_PUBLIC_TOPIC_PREFIX || "roundtable";
export const TRANSCRIPTS_DIR = process.env.ROUNDTABLE_TRANSCRIPTS_DIR || join(ROUNDTABLE_HOME, "transcripts");
export const PUBLISH_FLUSH_TIMEOUT_MS = parseInt(
  process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS || "30000",
  10
);

// Prototype mode: ephemeral artifacts agents propose, served read-only on 127.0.0.1 (see src/prototypes/)
// Sandbox root; must be outside any git work tree (checked when a prototype session starts).
export const PROTOTYPE_DIR =
  process.env.ROUNDTABLE_PROTOTYPE_DIR || join(tmpdir(), "agent-roundtable-prototypes");
export const PROTOTYPE_TTL_DEFAULT_MS = 1_800_000;
export const PROTOTYPE_TTL_MIN_MS = 60_000;
/** setTimeout's ceiling: a longer delay would fire after 1 ms. */
export const PROTOTYPE_TTL_MAX_MS = 2_147_483_647;

/** ROUNDTABLE_PROTOTYPE_TTL_MS, clamped to [1 min, ~24.8 days]; warns once on stderr (stdout is the MCP channel). */
function prototypeTtlMs(raw: string): number {
  const v = raw.trim();
  if (!v) return PROTOTYPE_TTL_DEFAULT_MS;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) {
    console.error(
      `[Prototype] ROUNDTABLE_PROTOTYPE_TTL_MS is not a whole number of milliseconds; using the default ${PROTOTYPE_TTL_DEFAULT_MS} ms.`
    );
    return PROTOTYPE_TTL_DEFAULT_MS;
  }
  if (n < PROTOTYPE_TTL_MIN_MS) {
    console.error(`[Prototype] ROUNDTABLE_PROTOTYPE_TTL_MS=${n} is below the minimum; using ${PROTOTYPE_TTL_MIN_MS} ms.`);
    return PROTOTYPE_TTL_MIN_MS;
  }
  if (n > PROTOTYPE_TTL_MAX_MS) {
    console.error(`[Prototype] ROUNDTABLE_PROTOTYPE_TTL_MS=${n} is above the maximum; using ${PROTOTYPE_TTL_MAX_MS} ms.`);
    return PROTOTYPE_TTL_MAX_MS;
  }
  return n;
}

/** Safety cap: a prototype still live after this long is destroyed (at least one minute). */
export const PROTOTYPE_TTL_MS = prototypeTtlMs(process.env.ROUNDTABLE_PROTOTYPE_TTL_MS || "");
/** Open the prototype board in the default browser when a session starts (opt-in). */
export const PROTOTYPE_OPEN = /^(1|true|yes|on)$/i.test((process.env.ROUNDTABLE_PROTOTYPE_OPEN || "").trim());
/** Chrome/Chromium binary for public-session screenshots; empty means auto-detect. */
export const CHROME_PATH_OVERRIDE = process.env.ROUNDTABLE_CHROME_PATH || "";
/** Screenshots of web prototypes in public sessions (on unless switched off). */
export const PROTOTYPE_SCREENSHOTS = !/^(0|false|no|off)$/i.test(
  (process.env.ROUNDTABLE_PROTOTYPE_SCREENSHOTS || "").trim()
);

// Security controls (1.0). Read at call time, so a changed environment applies without a restart.
// Two more are read elsewhere, because they act before this module is evaluated or inside a child:
//   ROUNDTABLE_DOTENV=off      skip loading .env entirely (src/env.ts; worker MCP servers start keyless)
//   ROUNDTABLE_WORKER_AUTH     "api_key" passes ANTHROPIC_API_KEY / OPENAI_API_KEY to claude and codex
//                              children; otherwise they use their own login (src/security/child-env.ts)
const PATH_LIST_DELIMITER = process.platform === "win32" ? ";" : ":";
const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v || "").trim());

export const LOCAL_TIMEOUT_DEFAULT_MS = 300_000;

/** One `claude -p` call of a local meeting; its process group is killed when it runs over. */
export function localTimeoutMs(): number {
  const n = Number((process.env.ROUNDTABLE_LOCAL_TIMEOUT_MS || "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : LOCAL_TIMEOUT_DEFAULT_MS;
}

/** A per-call base_url may reach private, CGNAT, link-local and ULA addresses (metadata stays blocked). */
export function allowPrivateBaseUrls(): boolean {
  return truthy(process.env.ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS);
}

/** Origins besides OPENAI_COMPATIBLE_BASE_URL's that may receive OPENAI_COMPATIBLE_API_KEY (comma-separated). */
export function openAICompatibleTrustedOrigins(): string[] {
  return (process.env.ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Directories besides the agents directories that path-like agent refs may resolve into. */
export function agentPaths(): string[] {
  return (process.env.ROUNDTABLE_AGENT_PATHS || "").split(PATH_LIST_DELIMITER).map((s) => s.trim()).filter(Boolean);
}

export const PROVIDER_RETRIES_DEFAULT = 2;

/** Provider retries after the first attempt (408/409/429/5xx and network errors); 0 disables, at most 5. */
export function providerRetries(): number {
  const raw = (process.env.ROUNDTABLE_PROVIDER_RETRIES || "").trim();
  return Math.min(5, /^\d+$/.test(raw) ? Number(raw) : PROVIDER_RETRIES_DEFAULT);
}

// Heads-down runs (1.0). Read at call time, like the security controls above.

/**
 * ROUNDTABLE_DEFAULT_VISIBILITY: how execute shows a run when the call names no channel. A comma
 * list of dashboard, chat_only and github:<owner/name>; "" when unset. Parsed by execute.
 */
export function defaultVisibility(): string {
  return (process.env.ROUNDTABLE_DEFAULT_VISIBILITY || "").trim();
}

/** ROUNDTABLE_DEFAULT_BUDGET_USD: the run budget execute uses when neither the call nor the contract sets one. */
export function defaultBudgetUsd(): number | undefined {
  const raw = (process.env.ROUNDTABLE_DEFAULT_BUDGET_USD || "").trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The provider, model and base URL of the runner's persona calls (micro-huddles, the lead
 * fallback, goal review): ROUNDTABLE_EXECUTION_PROVIDER, ROUNDTABLE_EXECUTION_MODEL and
 * ROUNDTABLE_EXECUTION_BASE_URL. Like the tools, anthropic and the provider's default model when
 * unset; `unknown` names a provider that is not one of PROVIDER_IDS (then anthropic is used).
 */
export function executionLLM(): { provider: LLMProvider; model: string; baseUrl?: string; unknown?: string } {
  const raw = (process.env.ROUNDTABLE_EXECUTION_PROVIDER || "").trim();
  const known = (PROVIDER_IDS as string[]).includes(raw);
  const provider: LLMProvider = known ? (raw as LLMProvider) : "anthropic";
  const model = (process.env.ROUNDTABLE_EXECUTION_MODEL || "").trim() || DEFAULT_MODELS[provider];
  const baseUrl = (process.env.ROUNDTABLE_EXECUTION_BASE_URL || "").trim();
  return { provider, model, ...(baseUrl && { baseUrl }), ...(raw && !known && { unknown: raw }) };
}

export const EXECUTION_RETENTION_DEFAULT_DAYS = 30;
export const SESSION_RETENTION_DEFAULT_DAYS = 30;
export const AUDIT_RETENTION_DEFAULT_DAYS = 365;

/** Whole days from `name`: null (keep everything) for 0 or off, the default when unset or not a whole number. */
function retentionDays(name: string, fallback: number): number | null {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (raw === "off" || /^0+$/.test(raw)) return null;
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
}

/** Days a completed, failed or aborted run is kept (worktrees, branches and log); null keeps them all. */
export function executionRetentionDays(): number | null {
  return retentionDays("ROUNDTABLE_EXECUTION_RETENTION_DAYS", EXECUTION_RETENTION_DEFAULT_DAYS);
}

/** Days an archived at-the-table session is kept after it ended; null keeps them all. */
export function sessionRetentionDays(): number | null {
  return retentionDays("ROUNDTABLE_SESSION_RETENTION_DAYS", SESSION_RETENTION_DEFAULT_DAYS);
}

/** Days the audit log keeps a month file after its month ended; null keeps them all. */
export function auditRetentionDays(): number | null {
  return retentionDays("ROUNDTABLE_AUDIT_RETENTION_DAYS", AUDIT_RETENTION_DEFAULT_DAYS);
}
