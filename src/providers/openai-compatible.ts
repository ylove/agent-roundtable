// --- OpenAI-compatible chat completions (OpenAI, Together AI, any /v1/chat/completions server) ---
import type { LLMCompletionResult, ProviderCall } from "./shared.js";
import { assertNonEmpty, assertNotRedirect, readProviderJson, stripThinkTags } from "./shared.js";
import { providerHttpError, withRetry } from "./retry.js";
import type { LLMProvider } from "../config.js";
import { openAICompatibleTrustedOrigins, requireEnv } from "../config.js";
import { scrubAndCap } from "../security/secrets.js";
import { guardedDispatcher } from "../security/url-guard.js";

export interface ChatCompletionsResponse {
  error?: { message?: string } | string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function parseChatCompletions(
  label: string,
  provider: LLMProvider,
  response: Response,
  result: ChatCompletionsResponse,
  requestedModel: string,
  allowToolCalls = false
): LLMCompletionResult {
  if (!response.ok || result.error) {
    const message = typeof result.error === "string" ? result.error : result.error?.message;
    // The body comes from the remote server: redact anything secret-shaped and keep it short.
    const text = `${label} API error (${response.status}): ${scrubAndCap(String(message || response.statusText), 300)}`;
    throw response.ok ? new Error(text) : providerHttpError(text, response);
  }
  const choice = result.choices?.[0];
  const text = stripThinkTags(choice?.message?.content ?? "");
  const rawCalls = allowToolCalls ? (choice?.message?.tool_calls ?? []).filter((c) => typeof c.id === "string" && typeof c.function?.name === "string") : [];
  const toolCalls = rawCalls.map((c) => {
    let input: unknown = null;
    try { input = JSON.parse(c.function?.arguments || "{}"); } catch { /* the loop reports the bad arguments to the model */ }
    return { id: c.id!, name: c.function!.name!, input };
  });
  return {
    content: toolCalls.length ? text : assertNonEmpty(label, text, choice?.finish_reason),
    ...(toolCalls.length > 0 && { toolCalls, assistantTurn: { role: "assistant", content: choice?.message?.content ?? null, tool_calls: rawCalls } }),
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

const badTrustedOrigins = new Set<string>();

/** Origins trusted with the key: the configured base URL's, plus ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS. */
function trustedOrigins(configured: string | undefined): Set<string> {
  const origins = new Set<string>();
  const own = originOf(configured);
  if (own) origins.add(own);
  for (const [i, entry] of openAICompatibleTrustedOrigins().entries()) {
    const origin = originOf(entry);
    if (origin) origins.add(origin);
    else if (!badTrustedOrigins.has(entry)) {
      badTrustedOrigins.add(entry);
      // By position, not value: a mistyped entry may hold something that should not reach a log.
      console.error(`[Providers] ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS: ignoring entry ${i + 1} (not an origin such as https://host:port)`);
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
    let guardOverride = false;
    if (override !== undefined) {
      // A per-call base_url on an operator-configured origin is trusted like the configured URL. Any
      // other origin comes from a tool call (so possibly from injected text): guard it, and bind the
      // key to the configured origins so it never travels there.
      const origin = originOf(override);
      if (!origin || !trustedOrigins(configured).has(origin)) {
        guardOverride = true;
        apiKey = undefined;
      }
    }
    const url = `${base.replace(/\/+$/, "")}/chat/completions`;
    // Local servers (LM Studio, vLLM, llama.cpp) need no auth: omit the header rather than send a fake token.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body = JSON.stringify({
      model: o.model,
      messages: o.toolRound ? [...messages, ...o.toolRound.turns] : messages, // system messages are accepted inline by every OpenAI-compatible server
      ...(o.toolRound && {
        tools: o.toolRound.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        ...(o.toolRound.forbid && { tool_choice: "none" }),
      }),
      [spec.tokenParam]: o.maxTokens,
      ...(o.temperature !== undefined && { temperature: o.temperature }),
    });
    return withRetry(async () => {
      const dispatcher = guardOverride ? await guardedDispatcher(url, { label: "base_url" }) : undefined;
      let response: Response | undefined;
      try {
        response = await globalThis.fetch(url, { ...(dispatcher && { dispatcher }), method: "POST", headers, body, signal: o.signal, redirect: "manual" });
        assertNotRedirect(spec.label, response, url);
        const result = (await readProviderJson(response)) as ChatCompletionsResponse;
        return parseChatCompletions(spec.label, spec.provider, response, result, o.model, !!o.toolRound);
      } finally {
        await response?.body?.cancel().catch(() => {});
        await dispatcher?.close();
      }
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
