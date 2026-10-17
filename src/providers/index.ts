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
import { activeAbortSignal, reportUsage, StoppedError } from "./usage.js";

export type { LLMMessage, LLMCompletionResult, ProviderCall, ProviderCallOptions } from "./shared.js";
export { isOllamaAvailable };
export {
  withUsageSink,
  reportUsage,
  activeUsageSink,
  withAbortSignal,
  activeAbortSignal,
  StoppedError,
  type UsageReport,
  type UsageSink,
} from "./usage.js";

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
  // Own-property check: "constructor", "toString", "__proto__" must not resolve via Object.prototype.
  const call = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
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

  const stop = activeAbortSignal();
  try {
    stop?.throwIfAborted();
    const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
    const result = await call(messages, {
      model,
      maxTokens: options.maxTokens || MAX_TOKENS,
      temperature: options.temperature,
      signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    });
    // Every completion (engines via callLLM, and the chat_completion tool) reaches the active usage sink.
    reportUsage({
      provider: result.provider,
      model: result.model,
      ...(result.usage && { usage: result.usage }),
      chars: { input: messages.reduce((n, m) => n + m.content.length, 0), output: result.content.length },
    });
    return result;
  } catch (error) {
    if (stop?.aborted) throw new StoppedError();
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
 * Call any LLM provider for meetings/collaborations and return the whole result (content, model,
 * usage). Routes to chatCompletion(), which reports { provider, model, usage } to the active usage sink.
 */
export async function callLLMDetailed(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  { provider, model, maxTokens = MAX_TOKENS, baseUrl }: CallLLMOptions
): Promise<LLMCompletionResult> {
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
  return result;
}

/**
 * Unified helper to call any LLM provider for meetings/collaborations: callLLMDetailed's content.
 * Usage still reaches the active sink.
 */
export async function callLLM(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: CallLLMOptions
): Promise<string> {
  return (await callLLMDetailed(systemPrompt, messages, options)).content;
}
