// --- OpenAI-compatible chat completions (OpenAI, Together AI) ---
import type { LLMCompletionResult, ProviderCall } from "./shared.js";
import { assertNonEmpty, stripThinkTags } from "./shared.js";
import type { LLMProvider } from "../config.js";
import { requireEnv } from "../config.js";

export interface ChatCompletionsResponse {
  error?: { message?: string } | string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function parseChatCompletions(
  label: string,
  provider: LLMProvider,
  response: Response,
  result: ChatCompletionsResponse,
  requestedModel: string
): LLMCompletionResult {
  if (!response.ok || result.error) {
    const message = typeof result.error === "string" ? result.error : result.error?.message;
    throw new Error(`${label} API error (${response.status}): ${message || response.statusText}`);
  }
  const choice = result.choices?.[0];
  const text = stripThinkTags(choice?.message?.content ?? "");
  return {
    content: assertNonEmpty(label, text, choice?.finish_reason),
    model: result.model || requestedModel,
    provider,
    usage: result.usage
      ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens }
      : undefined,
  };
}

export const callOpenAI: ProviderCall = async (messages, o) => {
  const apiKey = requireEnv("OPENAI_API_KEY", "the openai provider");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages,
      max_completion_tokens: o.maxTokens,
      ...(o.temperature !== undefined && { temperature: o.temperature }),
    }),
    signal: o.signal,
  });
  const result = (await response.json()) as ChatCompletionsResponse;
  return parseChatCompletions("OpenAI", "openai", response, result, o.model);
};

export function createTogetherCall(provider: "glm" | "qwen"): ProviderCall {
  return async (messages, o) => {
    const apiKey = requireEnv("TOGETHER_API_KEY", `the ${provider} provider (Together AI)`);
    const response = await fetch("https://api.together.xyz/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        messages, // Together accepts system messages inline
        max_tokens: o.maxTokens,
        ...(o.temperature !== undefined && { temperature: o.temperature }),
      }),
      signal: o.signal,
    });
    const result = (await response.json()) as ChatCompletionsResponse;
    return parseChatCompletions("Together", provider, response, result, o.model);
  };
}
