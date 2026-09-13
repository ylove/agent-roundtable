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
import { callOpenAI, createTogetherCall } from "./openai-compatible.js";
import { callOllama, isOllamaAvailable } from "./ollama.js";

export type { LLMMessage, LLMCompletionResult, ProviderCall, ProviderCallOptions } from "./shared.js";
export { isOllamaAvailable };

export const PROVIDERS: Record<LLMProvider, ProviderCall> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  glm: createTogetherCall("glm"),
  qwen: createTogetherCall("qwen"),
  ollama: callOllama,
};

export async function chatCompletion(
  messages: LLMMessage[],
  options: {
    provider?: LLMProvider;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<LLMCompletionResult> {
  const provider = options.provider || "openai";
  const call = PROVIDERS[provider];
  if (!call) {
    throw new Error(
      `Unknown provider "${provider}". Valid providers: ${PROVIDER_IDS.join(", ")}`
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

/**
 * Unified helper to call any LLM provider for meetings/collaborations.
 * Routes to chatCompletion() with the appropriate provider and model.
 */
export async function callLLM(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  provider: LLMProvider,
  model: string,
  maxTokens: number = MAX_TOKENS
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
  });

  return result.content;
}
