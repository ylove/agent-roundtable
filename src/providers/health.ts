import { createHash } from "node:crypto";
import { PROVIDER_IDS, type LLMProvider } from "../provider-ids.js";
import { ollamaDiscoveryEnabled } from "../config.js";
import { DEFAULT_OLLAMA_URL, parseParameterSize, type OllamaDiscovery } from "./local-models.js";
import { readProviderJson } from "./shared.js";

export const HEALTH_TTL_MS = 10 * 60_000;
/** A timeout, rate limit or other transient failure excludes a provider briefly; only a rejected credential keeps the full TTL. */
export const TRANSIENT_HEALTH_TTL_MS = 60_000;
export const PROVIDER_KEYS: Partial<Record<LLMProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", together: "TOGETHER_API_KEY", replicate: "REPLICATE_API_TOKEN",
};
export function availableProviders(env: NodeJS.ProcessEnv = process.env, ollama?: OllamaDiscovery): LLMProvider[] {
  return PROVIDER_IDS.filter(p => {
    const key = PROVIDER_KEYS[p];
    return key ? !!env[key]?.trim() : p === "openai_compatible" ? !!env.OPENAI_COMPATIBLE_BASE_URL?.trim()
      : !!env.OLLAMA_URL?.trim() || (ollamaDiscoveryEnabled(env) && ollama?.reachable === true);
  });
}

/** Only the operator-configured endpoint is eligible for automatic routing. No per-call URL enters it. */
export function trustedRoutingEndpoint(provider: LLMProvider, env: NodeJS.ProcessEnv): boolean {
  if (provider !== "openai_compatible" && provider !== "ollama") return true;
  try {
    const u = new URL((provider === "ollama" ? env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL : env.OPENAI_COMPATIBLE_BASE_URL) ?? "");
    return !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  } catch { return false; }
}

/**
 * Short stable identity of the endpoint behind a provider call: a hash of origin and path only, so neither
 * URL credentials, query strings nor keys are ever stored. Only operator-pointable providers have one.
 */
export function endpointFingerprint(provider: string, env: NodeJS.ProcessEnv = process.env, baseUrl?: string): string | undefined {
  if (provider !== "openai_compatible" && provider !== "ollama") return undefined;
  const raw = provider === "openai_compatible" ? baseUrl ?? env.OPENAI_COMPATIBLE_BASE_URL : env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
  try {
    const u = new URL(raw ?? "");
    return createHash("sha256").update(`${u.origin}${u.pathname.replace(/\/+$/, "")}`).digest("hex").slice(0, 16);
  } catch { return "invalid"; }
}

/**
 * Hash of the credential a call used, so history recorded under a rotated key stops counting. Only this hash is ever
 * stored; the key itself never leaves the environment.
 */
export function credentialFingerprint(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = PROVIDER_KEYS[provider as LLMProvider] ?? (provider === "openai_compatible" ? "OPENAI_COMPATIBLE_API_KEY" : undefined);
  const value = name ? env[name]?.trim() : undefined;
  return value ? createHash("sha256").update(JSON.stringify(["credential", provider, value])).digest("hex").slice(0, 16) : undefined;
}

export interface ProviderHealth { ok: boolean; at: number; reason?: string; ttl?: number }
/** No persistence: tool arguments and ledger rows can never create a trusted health entry. */
export class ProviderHealthCache {
  private entries = new Map<string, ProviderHealth>();
  private models = new Map<string, number>();
  private ollama = new Map<string, { at: number; result: OllamaDiscovery }>();
  private ollamaPending = new Map<string, Promise<OllamaDiscovery>>();
  constructor(private clock: () => number = () => Date.now(), private ttl = HEALTH_TTL_MS) {}
  private key(provider: LLMProvider, env: NodeJS.ProcessEnv, baseUrl?: string): string {
    const rawEndpoint = baseUrl ?? (provider === "openai_compatible" ? env.OPENAI_COMPATIBLE_BASE_URL : provider === "ollama" ? env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL : provider);
    let endpoint = rawEndpoint;
    try { endpoint = new URL(rawEndpoint ?? "").href.replace(/\/+$/, ""); } catch { /* Fixed provider identifier. */ }
    const credential = env[PROVIDER_KEYS[provider] ?? (provider === "openai_compatible" ? "OPENAI_COMPATIBLE_API_KEY" : "")];
    return createHash("sha256").update(JSON.stringify([provider, endpoint, credential])).digest("hex");
  }
  get(provider: LLMProvider, env: NodeJS.ProcessEnv = process.env): ProviderHealth | undefined {
    const key = this.key(provider, env), value = this.entries.get(key);
    if (value && this.clock() - value.at >= 0 && this.clock() - value.at < (value.ttl ?? this.ttl)) return value;
    this.entries.delete(key);
    return undefined;
  }
  /** Internal call boundary only. Never invoke this with caller-supplied health claims. */
  recordCall(provider: LLMProvider, ok: boolean, reason?: string, env: NodeJS.ProcessEnv = process.env, baseUrl?: string, model?: string): void {
    if (ok && model) this.models.set(`${this.key(provider, env, baseUrl)}:${model}`, this.clock());
    const transient = !ok && reason !== "auth failed";
    this.entries.set(this.key(provider, env, baseUrl), { ok, at: this.clock(), ...(reason && { reason }), ...(transient && { ttl: Math.min(this.ttl, TRANSIENT_HEALTH_TTL_MS) }) });
  }
  passed(provider: LLMProvider, model: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const at = this.models.get(`${this.key(provider, env)}:${model}`);
    return this.get(provider, env)?.ok === true && at !== undefined && this.clock() >= at && this.clock() - at < this.ttl;
  }
  getOllama(env: NodeJS.ProcessEnv = process.env): OllamaDiscovery | undefined {
    if (!env.OLLAMA_URL?.trim() && !ollamaDiscoveryEnabled(env)) return undefined;
    const key = this.key("ollama", env), hit = this.ollama.get(key);
    const age = hit ? this.clock() - hit.at : -1;
    if (hit && age >= 0 && age < (hit.result.reachable ? this.ttl : Math.min(this.ttl, TRANSIENT_HEALTH_TTL_MS))) return hit.result;
    this.ollama.delete(key);
    return undefined;
  }
  /** One bounded tags request per endpoint and TTL, including failures and concurrent callers. */
  async discoverOllama(env: NodeJS.ProcessEnv = process.env, timeoutMs = 1000): Promise<OllamaDiscovery> {
    if (!env.OLLAMA_URL?.trim() && !ollamaDiscoveryEnabled(env)) return { reachable: false, models: [] };
    const cached = this.getOllama(env);
    if (cached) return cached;
    const key = this.key("ollama", env), pending = this.ollamaPending.get(key);
    if (pending) return pending;
    const probe = async (): Promise<OllamaDiscovery> => {
      let result: OllamaDiscovery = { reachable: false, models: [] };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // This is the operator's URL, as in the native provider. Automatic routing separately
        // applies trustedRoutingEndpoint; discovery must also work for explicitly pinned LAN servers.
        const url = env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
        const response = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { method: "GET", redirect: "manual", signal: controller.signal });
        if (response.ok) {
          const body = await readProviderJson(response) as { models?: Array<{ name?: unknown; details?: { parameter_size?: unknown } }> };
          if (Array.isArray(body?.models)) result = { reachable: true, models: body.models.flatMap(model =>
            model && typeof model.name === "string" ? [{ name: model.name, ...parseParameterSize(model.details?.parameter_size) }] : []) };
        } else await response.body?.cancel();
      } catch { /* Absence and invalid responses are cached too. */ }
      finally { clearTimeout(timer); }
      this.ollama.set(key, { at: this.clock(), result });
      return result;
    };
    const request = probe();
    this.ollamaPending.set(key, request);
    try { return await request; }
    finally { this.ollamaPending.delete(key); }
  }
  clear(): void { this.entries.clear(); this.models.clear(); this.ollama.clear(); this.ollamaPending.clear(); }
}
export const providerHealth = new ProviderHealthCache();
