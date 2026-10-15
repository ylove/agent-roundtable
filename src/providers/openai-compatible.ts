// --- OpenAI-compatible chat completions (OpenAI, Together AI, any /v1/chat/completions server) ---
import type { LLMCompletionResult, ProviderCall } from "./shared.js";
import { assertNonEmpty, assertNotRedirect, readProviderJson, stripThinkTags } from "./shared.js";
import { providerHttpError, withRetry } from "./retry.js";
import type { LLMProvider } from "../config.js";
import { openAICompatibleKeyOrigins, requireEnv } from "../config.js";
import { scrubAndCap } from "../security/secrets.js";
import { guardUrl } from "../security/url-guard.js";

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
    // The body comes from the remote server: redact anything secret-shaped and keep it short.
    const text = `${label} API error (${response.status}): ${scrubAndCap(String(message || response.statusText), 300)}`;
    throw response.ok ? new Error(text) : providerHttpError(text, response);
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

export interface OpenAICompatibleSpec {
  provider: LLMProvider;
  /** Human label used in error messages ("OpenAI", "Together", ...). */
  label: string;
  /** OpenAI's newer models only accept max_completion_tokens; everyone else speaks max_tokens. */
  tokenParam: "max_tokens" | "max_completion_tokens";
  /** Fixed base URL, or a thunk read at call time (so env changes are picked up). */
  baseUrl: string | (() => string | undefined);
  /** Returns the bearer token, or undefined to send no Authorization header at all. */
  apiKey: () => string | undefined;
  /**
   * When true, options.baseUrl (the tool's base_url argument) wins over spec.baseUrl. A per-call URL on
   * another origin than the configured one is checked by the URL guard and never receives the key.
   */
  allowBaseUrlOverride?: boolean;
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

const badKeyOrigins = new Set<string>();

/** Origins trusted with the key: the configured base URL's, plus ROUNDTABLE_OPENAI_COMPATIBLE_KEY_ORIGINS. */
function keyOrigins(configured: string | undefined): Set<string> {
  const origins = new Set<string>();
  const own = originOf(configured);
  if (own) origins.add(own);
  for (const entry of openAICompatibleKeyOrigins()) {
    const origin = originOf(entry);
    if (origin) origins.add(origin);
    else if (!badKeyOrigins.has(entry)) {
      badKeyOrigins.add(entry);
      console.error(`[Providers] ROUNDTABLE_OPENAI_COMPATIBLE_KEY_ORIGINS: ignoring "${entry}" (not an origin such as https://host:port)`);
    }
  }
  return origins;
}

/**
 * One factory, three instances: the request shape is identical for every /v1/chat/completions
 * server; only the base URL, the auth header and the token-limit parameter name differ.
 */
export function createOpenAICompatibleCall(spec: OpenAICompatibleSpec): ProviderCall {
  return async (messages, o) => {
    const configured = typeof spec.baseUrl === "function" ? spec.baseUrl() : spec.baseUrl;
    const override = o.baseUrl && spec.allowBaseUrlOverride ? o.baseUrl : undefined;
    const base = override ?? configured;
    if (!base) {
      throw new Error(
        "OPENAI_COMPATIBLE_BASE_URL not configured and no base_url argument given " +
          "(required for the openai_compatible provider). Set it in the MCP server .env file or pass base_url."
      );
    }
    let apiKey = spec.apiKey();
    if (override !== undefined) {
      // A per-call base_url on an operator-configured origin is trusted like the configured URL. Any
      // other origin comes from a tool call (so possibly from injected text): guard it, and bind the
      // key to the configured origins so it never travels there.
      const origin = originOf(override);
      if (!origin || !keyOrigins(configured).has(origin)) {
        await guardUrl(override, { label: "base_url" });
        apiKey = undefined;
      }
    }
    const url = `${base.replace(/\/+$/, "")}/chat/completions`;
    // Local servers (LM Studio, vLLM, llama.cpp) need no auth: omit the header rather than send a fake token.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body = JSON.stringify({
      model: o.model,
      messages, // system messages are accepted inline by every OpenAI-compatible server
      [spec.tokenParam]: o.maxTokens,
      ...(o.temperature !== undefined && { temperature: o.temperature }),
    });
    return withRetry(async () => {
      const response = await fetch(url, { method: "POST", headers, body, signal: o.signal, redirect: "manual" });
      assertNotRedirect(spec.label, response, url);
      const result = (await readProviderJson(response)) as ChatCompletionsResponse;
      return parseChatCompletions(spec.label, spec.provider, response, result, o.model);
    }, { signal: o.signal, label: spec.label });
  };
}

export const callOpenAI: ProviderCall = createOpenAICompatibleCall({
  provider: "openai",
  label: "OpenAI",
  tokenParam: "max_completion_tokens",
  baseUrl: "https://api.openai.com/v1",
  apiKey: () => requireEnv("OPENAI_API_KEY", "the openai provider"),
});

export const callTogether: ProviderCall = createOpenAICompatibleCall({
  provider: "together",
  label: "Together",
  tokenParam: "max_tokens",
  baseUrl: "https://api.together.xyz/v1",
  apiKey: () => requireEnv("TOGETHER_API_KEY", "the together provider (Together AI)"),
});

export const callOpenAICompatible: ProviderCall = createOpenAICompatibleCall({
  provider: "openai_compatible",
  label: "OpenAI-compatible",
  tokenParam: "max_tokens",
  baseUrl: () => process.env.OPENAI_COMPATIBLE_BASE_URL,
  apiKey: () => process.env.OPENAI_COMPATIBLE_API_KEY || undefined,
  allowBaseUrlOverride: true,
});
