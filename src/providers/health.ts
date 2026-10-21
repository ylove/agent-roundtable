import { createHash } from "node:crypto";
import { PROVIDER_IDS, type LLMProvider } from "../provider-ids.js";

export const HEALTH_TTL_MS = 10 * 60_000;
export const PROVIDER_KEYS: Partial<Record<LLMProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", together: "TOGETHER_API_KEY", replicate: "REPLICATE_API_TOKEN",
};
export function availableProviders(env: NodeJS.ProcessEnv = process.env): LLMProvider[] {
  return PROVIDER_IDS.filter(p => {
    const key = PROVIDER_KEYS[p];
    return key ? !!env[key]?.trim() : p === "openai_compatible" ? !!env.OPENAI_COMPATIBLE_BASE_URL?.trim() : !!env.OLLAMA_URL?.trim();
  });
}

/** Only the operator-configured endpoint is eligible for automatic routing. No per-call URL enters it. */
export function trustedRoutingEndpoint(provider: LLMProvider, env: NodeJS.ProcessEnv): boolean {
  if (provider !== "openai_compatible" && provider !== "ollama") return true;
  try {
    const u = new URL((provider === "ollama" ? env.OLLAMA_URL : env.OPENAI_COMPATIBLE_BASE_URL) ?? "");
    return !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  } catch { return false; }
}

export interface ProviderHealth { ok: boolean; at: number; reason?: string }
/** No persistence: tool arguments and ledger rows can never create a trusted health entry. */
export class ProviderHealthCache {
  private entries = new Map<string, ProviderHealth>();
  private models = new Map<string, number>();
  constructor(private clock: () => number = () => Date.now(), private ttl = HEALTH_TTL_MS) {}
  private key(provider: LLMProvider, env: NodeJS.ProcessEnv, baseUrl?: string): string {
    const rawEndpoint = baseUrl ?? (provider === "openai_compatible" ? env.OPENAI_COMPATIBLE_BASE_URL : provider === "ollama" ? env.OLLAMA_URL : provider);
    let endpoint = rawEndpoint;
    try { endpoint = new URL(rawEndpoint ?? "").href.replace(/\/+$/, ""); } catch { /* Fixed provider identifier. */ }
    const credential = env[PROVIDER_KEYS[provider] ?? (provider === "openai_compatible" ? "OPENAI_COMPATIBLE_API_KEY" : "")];
    return createHash("sha256").update(JSON.stringify([provider, endpoint, credential])).digest("hex");
  }
  get(provider: LLMProvider, env: NodeJS.ProcessEnv = process.env): ProviderHealth | undefined {
    const key = this.key(provider, env), value = this.entries.get(key);
    if (value && this.clock() - value.at >= 0 && this.clock() - value.at < this.ttl) return value;
    this.entries.delete(key);
    return undefined;
  }
  /** Internal call boundary only. Never invoke this with caller-supplied health claims. */
  recordCall(provider: LLMProvider, ok: boolean, reason?: string, env: NodeJS.ProcessEnv = process.env, baseUrl?: string, model?: string): void {
    if (ok && model) this.models.set(`${this.key(provider, env, baseUrl)}:${model}`, this.clock());
    this.entries.set(this.key(provider, env, baseUrl), { ok, at: this.clock(), ...(reason && { reason }) });
  }
  passed(provider: LLMProvider, model: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const at = this.models.get(`${this.key(provider, env)}:${model}`);
    return this.get(provider, env)?.ok === true && at !== undefined && this.clock() >= at && this.clock() - at < this.ttl;
  }
  clear(): void { this.entries.clear(); this.models.clear(); }
}
export const providerHealth = new ProviderHealthCache();
