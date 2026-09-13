// ============================================================================
// Shared provider types and helpers
// ============================================================================

export interface LLMCompletionResult {
  content: string;
  model: string;
  provider: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
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

/** Some open-weight reasoning models emit their reasoning inline as <think>...</think>. */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}
