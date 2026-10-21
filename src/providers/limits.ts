/** Shared output ceilings for provider calls and provider judgment. */
export const PROVIDER_MAX_TOKENS: Readonly<Record<string, number>> = {
  anthropic: 32_000, openai: 32_768, replicate: 16_384, together: 16_384, openai_compatible: 16_384, ollama: 8192,
};
