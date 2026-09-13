// ============================================================================
// Configuration (reads process.env only; imports nothing local)
// ============================================================================

// Version (also reported by debug_env and the startup banner)
export const VERSION = "0.1.0";

// Agent meetings
export const AGENTS_DIR = process.env.ROUNDTABLE_AGENTS_DIR || ".claude/agents";
export const MAX_TOKENS = parseInt(process.env.ROUNDTABLE_MAX_TOKENS || "8192", 10);
export const LLM_TIMEOUT_MS = parseInt(process.env.ROUNDTABLE_LLM_TIMEOUT_MS || "600000", 10);
export const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");

// Text LLM providers
export type LLMProvider = "anthropic" | "openai" | "glm" | "qwen" | "ollama";
export const PROVIDER_IDS: LLMProvider[] = ["anthropic", "openai", "glm", "qwen", "ollama"];

// Anthropic: both current models are first-class; short aliases are accepted wherever a model is given
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
};
export function resolveAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

// Default models per provider
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: resolveAnthropicModel(process.env.ROUNDTABLE_ANTHROPIC_MODEL || "claude-opus-5"),
  openai: "gpt-5.6-luna",
  glm: "zai-org/GLM-5.3",
  qwen: "Qwen/Qwen3.8-2.4T-A95B",
  ollama: "qwen3:14b",
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
export const MODEL_PARAM_DESCRIPTION = `Model id. Defaults: ${PROVIDER_IDS.map((p) => `${DEFAULT_MODELS[p]} (${p})`).join(", ")}. Anthropic also accepts the aliases "opus" (claude-opus-5) and "sonnet" (claude-sonnet-5).`;
