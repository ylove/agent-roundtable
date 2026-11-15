// Provider identifiers only: safe to import before environment bootstrap.
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "together"
  | "replicate"
  | "ollama"
  | "openai_compatible";
export const PROVIDER_IDS: LLMProvider[] = [
  "anthropic",
  "openai",
  "together",
  "replicate",
  "ollama",
  "openai_compatible",
];
