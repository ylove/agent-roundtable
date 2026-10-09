// ============================================================================
// Configuration (reads process.env only; imports no local modules)
// ============================================================================

import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Version (also reported by debug_env and the startup banner)
export const VERSION = "0.3.0";

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
const activityLog = process.env.ROUNDTABLE_ACTIVITY_LOG;
export const ACTIVITY_LOG_PATH: string | null = !activityLog
  ? join(homedir(), ".agent-roundtable", "activity.jsonl")
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
// Built from the home directory at runtime so no literal home path appears in source.
export const TRANSCRIPTS_DIR =
  process.env.ROUNDTABLE_TRANSCRIPTS_DIR || join(homedir(), ".agent-roundtable", "transcripts");
export const PUBLISH_FLUSH_TIMEOUT_MS = parseInt(
  process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS || "30000",
  10
);
