// --- Ollama (native /api/chat; optional, only when reachable) ---
import type { ProviderCall } from "./shared.js";
import { assertNonEmpty, readProviderJson, stripThinkTags } from "./shared.js";
import { providerHttpError, withRetry } from "./retry.js";
import { OLLAMA_URL } from "../config.js";
import { scrubAndCap } from "../security/secrets.js";

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
  const body = JSON.stringify({
    model: o.model,
    messages,
    stream: false,
    options: { num_predict: o.maxTokens, temperature: o.temperature ?? 0.7 },
  });
  const result = await withRetry(async () => {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: o.signal,
    });
    const parsed = (await readProviderJson(response)) as {
      error?: string;
      message?: { content?: string };
      model?: string;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    if (!response.ok || parsed.error) {
      const text = `Ollama API error (${response.status}): ${scrubAndCap(String(parsed.error || response.statusText), 300)}`;
      throw response.ok ? new Error(text) : providerHttpError(text, response);
    }
    return parsed;
  }, { signal: o.signal, label: "Ollama" });
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
