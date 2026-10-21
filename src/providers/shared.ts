// ============================================================================
// Shared provider types and helpers
// ============================================================================

import { describeUrl } from "../security/url-guard.js";

export interface LLMCompletionResult {
  content: string;
  model: string;
  provider: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Prompt-cache reads and writes, when the provider reports them (Anthropic). */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderCallOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  /** Only honoured by the openai_compatible provider: overrides OPENAI_COMPATIBLE_BASE_URL. */
  baseUrl?: string;
}

export type ProviderCall = (
  messages: LLMMessage[],
  options: ProviderCallOptions
) => Promise<LLMCompletionResult>;

/**
 * A silent empty reply is worse than a loud error in a meeting transcript.
 */
export function assertNonEmpty(label: string, content: string, finishReason?: string): string {
  if (content.trim()) return content;
  const hint =
    finishReason === "max_tokens" || finishReason === "length"
      ? " Thinking/reasoning tokens count against max_tokens; raise max_tokens or ROUNDTABLE_MAX_TOKENS."
      : "";
  throw new Error(
    `${label} returned no text${finishReason ? ` (finish reason: ${finishReason})` : ""}.${hint}`
  );
}

export const PROVIDER_BODY_LIMIT = 8 * 1024 * 1024;
class ResponseBodyLimitError extends Error {}

/** Read response bytes incrementally and cancel the stream when the limit is exceeded. */
export async function readBoundedText(response: Response, limit = PROVIDER_BODY_LIMIT): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        throw new ResponseBodyLimitError(`Response body exceeds ${limit} byte limit`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Success bodies are parsed strictly (a truncated or non-JSON 200 must reject). Error bodies are
 * best effort: a 502 HTML page is still an HTTP error, reported by its status rather than a parse error.
 */
export async function readProviderJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (response.ok || error instanceof ResponseBodyLimitError) throw error;
    return {};
  }
  if (response.ok) return JSON.parse(text) as Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Credentialed requests use redirect: "manual", so a redirect never carries a key (or a guarded
 * request) to another host. A 3xx is an error; only the target's origin is reported.
 */
export function assertNotRedirect(label: string, response: Response, requestUrl: string): void {
  if (response.status < 300 || response.status >= 400) return;
  void response.body?.cancel().catch(() => {});
  const location = response.headers.get("location");
  let target = "";
  if (location) {
    try {
      target = ` to ${describeUrl(new URL(location, requestUrl))}`;
    } catch {
      /* unparseable Location: say nothing about it */
    }
  }
  throw new Error(`${label} API error (${response.status}): refusing to follow a redirect${target}`);
}

/** Some open-weight reasoning models emit their reasoning inline as <think>...</think>. */
export function stripThinkTags(text: string): string {
  const chunks: string[] = [];
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<think>", pos);
    if (start < 0) break;
    const end = text.indexOf("</think>", start + 7);
    if (end < 0) break;
    chunks.push(text.slice(pos, start));
    pos = end + 8;
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  }
  chunks.push(text.slice(pos));
  return chunks.join("");
}
