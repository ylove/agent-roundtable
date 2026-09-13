// --- Ollama (native /api/chat; optional, only when reachable) ---
import type { ProviderCall } from "./shared.js";
import { assertNonEmpty, stripThinkTags } from "./shared.js";
import { OLLAMA_URL } from "../config.js";

/**
 * Check whether the configured Ollama server is reachable (GET /api/tags).
 */
export async function isOllamaAvailable(timeoutMs: number = 1000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export const callOllama: ProviderCall = async (messages, o) => {
  if (!(await isOllamaAvailable())) {
    throw new Error(
      `Ollama is not reachable at ${OLLAMA_URL} (GET /api/tags did not answer within 1s). ` +
        `Set OLLAMA_URL in the MCP server .env or choose another provider.`
    );
  }
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages,
      stream: false,
      options: { num_predict: o.maxTokens, temperature: o.temperature ?? 0.7 },
    }),
    signal: o.signal,
  });
  const result = (await response.json()) as {
    error?: string;
    message?: { content?: string };
    model?: string;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  if (!response.ok || result.error) {
    throw new Error(`Ollama API error (${response.status}): ${result.error || response.statusText}`);
  }
  const text = stripThinkTags(result.message?.content ?? "");
  return {
    content: assertNonEmpty("Ollama", text, result.done_reason),
    model: result.model || o.model,
    provider: "ollama",
    usage:
      result.prompt_eval_count !== undefined && result.eval_count !== undefined
        ? { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count }
        : undefined,
  };
};
