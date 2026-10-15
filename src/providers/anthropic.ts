// --- Anthropic (raw Messages API) ---
import type { ProviderCall } from "./shared.js";
import { assertNonEmpty, assertNotRedirect, readProviderJson } from "./shared.js";
import { providerHttpError, withRetry } from "./retry.js";
import { requireEnv } from "../config.js";
import { scrubAndCap } from "../security/secrets.js";

interface MessagesResponse {
  error?: { type?: string; message: string };
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export const callAnthropic: ProviderCall = async (messages, o) => {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", "the anthropic provider");
  const systemMessage = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const url = "https://api.anthropic.com/v1/messages";
  const body = JSON.stringify({
    model: o.model,
    max_tokens: o.maxTokens,
    ...(systemMessage && { system: systemMessage.content }),
    messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
    // temperature is deliberately omitted: current Claude models reject sampling params
  });

  // 429, 529 (overloaded) and other transient failures are retried inside the caller's signal.
  const result = await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: o.signal,
      redirect: "manual",
    });
    assertNotRedirect("Anthropic", response, url);
    const parsed = (await readProviderJson(response)) as MessagesResponse;
    if (!response.ok || parsed.error) {
      // The body comes from the remote server: redact anything secret-shaped and keep it short.
      const text =
        `Anthropic API error (${response.status}${parsed.error?.type ? ` ${scrubAndCap(String(parsed.error.type), 60)}` : ""}): ` +
        scrubAndCap(String(parsed.error?.message || response.statusText), 300);
      throw response.ok ? new Error(text) : providerHttpError(text, response);
    }
    return parsed;
  }, { signal: o.signal, label: "Anthropic" });

  // Join ALL text blocks: with adaptive thinking the first block may be a "thinking" block.
  const text = (result.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return {
    content: assertNonEmpty("Anthropic", text, result.stop_reason),
    model: result.model || o.model,
    provider: "anthropic",
    usage: result.usage
      ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
      : undefined,
  };
};
