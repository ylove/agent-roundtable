import { providerHealth, endpointFingerprint } from "./health.js";
import { ProviderHttpError } from "./retry.js";
import { appendTableLine, newServerId } from "../usage/table.js";

let outcomeServer: string | undefined;
function recordOutcome(provider: LLMProvider, model: string, started: number, outcome: ProviderOutcome["outcome"], reportsUsage: boolean, baseUrl?: string): ProviderOutcome {
  const endpoint = endpointFingerprint(provider, process.env, baseUrl);
  const result: ProviderOutcome = { provider, model, outcome, latency_ms: Math.max(0, Date.now() - started), ...(endpoint !== undefined && { endpoint }) };
  // A session or execution sink already owns this call. Never create a second table row for it.
  if (activeUsageSink()) {
    if (!reportsUsage) reportProviderFailure(result);
  } else {
    try { appendTableLine({ at: new Date(Date.now()).toISOString(), server: outcomeServer ??= newServerId(), session: "provider-calls", kind: "provider-call", agent: "provider", ...result }); }
    catch { /* Health must work when the usage directory is read-only. */ }
  }
  return result;
}
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
import { activeAbortSignal, activeUsageSink, reportUsage, StoppedError, withProviderOutcome, reportProviderFailure, type ProviderOutcome } from "./usage.js";

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
  /** Postmortems retain a text-length estimate for a dispatched call that fails without usage. */
  estimateUsageOnFailure?: boolean;
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
  let dispatched = false;
  const started = Date.now();
  let failedOutcome: ProviderOutcome | undefined;
  try {
    stop?.throwIfAborted();
    const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
    dispatched = true;
    const result = await call(messages, {
      model,
      maxTokens: options.maxTokens || MAX_TOKENS,
      temperature: options.temperature,
      signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    });
    providerHealth.recordCall(provider, true, undefined, process.env, options.baseUrl, model);
    const outcome = recordOutcome(provider, model, started, "ok", true, options.baseUrl);
    // Every completion (engines via callLLM, and the chat_completion tool) reaches the active usage sink.
    withProviderOutcome(outcome, () => reportUsage({
      provider: result.provider,
      model: result.model,
      ...(result.usage && { usage: result.usage }),
      chars: { input: messages.reduce((n, m) => n + m.content.length, 0), output: result.content.length },
    }));
    return result;
  } catch (error) {
    if (dispatched && !stop?.aborted) {
      const status = error instanceof ProviderHttpError ? error.status : undefined;
      const outcome = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : error instanceof Error && /timeout|timed out|abort/i.test(error.name + error.message) ? "timeout" : "error";
      // Unknown persona models are handled by the existing model fallback, not provider exclusion.
      if (outcome === "auth" || outcome === "timeout" || outcome === "rate_limit") providerHealth.recordCall(provider, false, outcome === "auth" ? "auth failed" : outcome === "timeout" ? "request timed out" : "rate limited", process.env, options.baseUrl);
      failedOutcome = recordOutcome(provider, model, started, outcome, options.estimateUsageOnFailure === true, options.baseUrl);
    }
    if (dispatched && options.estimateUsageOnFailure) {
      const report = () => reportUsage({ provider, model, chars: { input: messages.reduce((n, m) => n + m.content.length, 0), output: 0 } });
      if (failedOutcome) withProviderOutcome(failedOutcome, report); else report();
    }
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
  estimateUsageOnFailure?: boolean;
}

/**
 * Call any LLM provider for meetings/collaborations and return the whole result (content, model,
 * usage). Routes to chatCompletion(), which reports { provider, model, usage } to the active usage sink.
 */
export async function callLLMDetailed(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  { provider, model, maxTokens = MAX_TOKENS, baseUrl, estimateUsageOnFailure }: CallLLMOptions
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
    estimateUsageOnFailure,
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
