// ============================================================================
// LLM Completion Functions (provider table + routing)
// ============================================================================

import type { LLMMessage, LLMCompletionResult, ProviderCall } from "./shared.js";
import type { LLMProvider } from "../config.js";
import {
  DEFAULT_MODELS,
  LLM_TIMEOUT_MS,
  MAX_TOKENS,
  PROVIDER_IDS,
  resolveAnthropicModel,
} from "../config.js";
import { callAnthropic } from "./anthropic.js";
import { callOpenAI, callTogether, callOpenAICompatible } from "./openai-compatible.js";
import { callReplicate } from "./replicate.js";
import { callOllama, isOllamaAvailable } from "./ollama.js";

export type { LLMMessage, LLMCompletionResult, ProviderCall, ProviderCallOptions } from "./shared.js";
export { isOllamaAvailable };

export const PROVIDERS: Record<LLMProvider, ProviderCall> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  together: callTogether,
  replicate: callReplicate,
  ollama: callOllama,
  openai_compatible: callOpenAICompatible,
};

export interface ChatCompletionOptions {
  provider?: LLMProvider;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Only with provider "openai_compatible": overrides OPENAI_COMPATIBLE_BASE_URL. */
  baseUrl?: string;
}

export async function chatCompletion(
  messages: LLMMessage[],
  options: ChatCompletionOptions = {}
): Promise<LLMCompletionResult> {
  const provider = options.provider || "openai";
  const call = PROVIDERS[provider];
  if (!call) {
    throw new Error(
      `Unknown provider "${provider}". Valid providers: ${PROVIDER_IDS.join(", ")}`
    );
  }
  if (options.baseUrl && provider !== "openai_compatible") {
    throw new Error(
      `base_url is only supported with provider "openai_compatible" (got "${provider}")`
    );
  }

  const model =
    provider === "anthropic"
      ? resolveAnthropicModel(options.model || DEFAULT_MODELS.anthropic)
      : options.model || DEFAULT_MODELS[provider];

  try {
    return await call(messages, {
      model,
      maxTokens: options.maxTokens || MAX_TOKENS,
      temperature: options.temperature,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(
        `${provider} request timed out after ${Math.round(LLM_TIMEOUT_MS / 1000)}s (ROUNDTABLE_LLM_TIMEOUT_MS)`
      );
    }
    throw error;
  }
}

export interface CallLLMOptions {
  provider: LLMProvider;
  model: string;
  maxTokens?: number;
  baseUrl?: string;
}

/**
 * Unified helper to call any LLM provider for meetings/collaborations.
 * Routes to chatCompletion() with the appropriate provider and model.
 */
export async function callLLM(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  { provider, model, maxTokens = MAX_TOKENS, baseUrl }: CallLLMOptions
): Promise<string> {
  const llmMessages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
  ];

  const result = await chatCompletion(llmMessages, {
    provider,
    model,
    maxTokens,
    baseUrl,
  });

  return result.content;
}
