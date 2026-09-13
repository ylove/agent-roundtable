// --- Anthropic (raw Messages API) ---
import type { ProviderCall } from "./shared.js";
import { assertNonEmpty } from "./shared.js";
import { requireEnv } from "../config.js";

export const callAnthropic: ProviderCall = async (messages, o) => {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", "the anthropic provider");
  const systemMessage = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: o.model,
      max_tokens: o.maxTokens,
      ...(systemMessage && { system: systemMessage.content }),
      messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
      // temperature is deliberately omitted: current Claude models reject sampling params
    }),
    signal: o.signal,
  });

  const result = (await response.json()) as {
    error?: { type?: string; message: string };
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };

  if (!response.ok || result.error) {
    throw new Error(
      `Anthropic API error (${response.status}${result.error?.type ? ` ${result.error.type}` : ""}): ${
        result.error?.message || response.statusText
      }`
    );
  }

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
