// --- Ollama (native /api/chat; optional, only when reachable) ---
import type { ProviderCall } from "./shared.js";
import { assertNonEmpty, assertNotRedirect, readProviderJson, stripThinkTags } from "./shared.js";
import { providerHttpError, withRetry } from "./retry.js";
import { OLLAMA_URL } from "../config.js";
import { describeUrl } from "../security/url-guard.js";
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
      redirect: "manual",
      signal: controller.signal,
    });
    assertNotRedirect("Ollama", response, OLLAMA_URL);
    await response.body?.cancel().catch(() => {});
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
      `Ollama is not reachable at ${describeUrl(OLLAMA_URL)} (GET /api/tags did not answer within 1s). ` +
        `Set OLLAMA_URL in the MCP server .env or choose another provider.`
    );
  }
  // Tool rounds add Ollama's documented `tools` field; the reply carries `message.tool_calls`.
  const body = JSON.stringify({
    model: o.model,
    messages: o.toolRound ? [...messages, ...o.toolRound.turns] : messages,
    stream: false,
    ...(o.toolRound && !o.toolRound.forbid && {
      tools: o.toolRound.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }),
    options: { num_predict: o.maxTokens, temperature: o.temperature ?? 0.7 },
  });
  const result = await withRetry(async () => {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body,
      signal: o.signal,
    });
    assertNotRedirect("Ollama", response, OLLAMA_URL);
    const parsed = (await readProviderJson(response)) as {
      error?: string;
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> };
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
  // Ollama gives no call ids and sends arguments as an object; ids are made up here so results pair up by position.
  const rawCalls = o.toolRound ? (result.message?.tool_calls ?? []).filter((c) => typeof c.function?.name === "string") : [];
  const toolCalls = rawCalls.map((c, i) => {
    const args = c.function!.arguments;
    let input: unknown = null;
    if (args && typeof args === "object") input = args;
    else if (typeof args === "string") { try { input = JSON.parse(args || "{}"); } catch { /* the loop reports the bad arguments to the model */ } }
    else if (args === undefined) input = {};
    return { id: `call_${i}`, name: c.function!.name as string, input };
  });
  return {
    content: toolCalls.length ? text : assertNonEmpty("Ollama", text, result.done_reason),
    ...(toolCalls.length > 0 && { toolCalls, assistantTurn: { role: "assistant", content: result.message?.content ?? "", tool_calls: rawCalls } }),
    model: result.model || o.model,
    provider: "ollama",
    usage:
      result.prompt_eval_count !== undefined && result.eval_count !== undefined
        ? { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count }
        : undefined,
  };
};
