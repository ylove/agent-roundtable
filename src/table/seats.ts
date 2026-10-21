import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentKey, loadAgent, parseAgentFrontmatter } from "../agents.js";
import { DEFAULT_MODELS, PROVIDER_IDS, resolveAnthropicModel, type LLMProvider } from "../config.js";
import { callLLM, withAbortSignal } from "../providers/index.js";
import { ProviderHttpError } from "../providers/retry.js";
import { parseSeat, type Seat, type SeatSpec } from "./events.js";

export class SeatUsageError extends Error { readonly exitCode = 2; }
export const PROVIDER_KEYS: Partial<Record<LLMProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", together: "TOGETHER_API_KEY", replicate: "REPLICATE_API_TOKEN",
};
export function availableProviders(env: NodeJS.ProcessEnv = process.env): LLMProvider[] {
  return PROVIDER_IDS.filter(provider => {
    const key = PROVIDER_KEYS[provider];
    return key ? !!env[key]?.trim() : provider === "openai_compatible" ? !!env.OPENAI_COMPATIBLE_BASE_URL?.trim() : !!env.OLLAMA_URL?.trim();
  });
}
export function assertSeatCredentials(seats: Iterable<Seat>, env: NodeJS.ProcessEnv = process.env): void {
  for (const seat of seats) {
    const key = PROVIDER_KEYS[seat.provider];
    if (key && !env[key]?.trim()) throw new SeatUsageError(`Missing ${key} for seat ${seat.id}.`);
    if (seat.provider === "openai_compatible" && !env.OPENAI_COMPATIBLE_BASE_URL?.trim()) throw new SeatUsageError("Missing OPENAI_COMPATIBLE_BASE_URL.");
  }
}
export interface ResolveSeatsOptions {
  agents?: string[]; teamA?: string[]; teamB?: string[]; judges?: string[];
  seats?: string | Record<string, SeatSpec>; seat?: string; mix?: "auto" | "cheap";
  provider?: LLMProvider; model?: string; agentsDir?: string;
  env?: NodeJS.ProcessEnv;
  excludeProviders?: readonly LLMProvider[];
  /** A metadata reader can be supplied without changing process-wide agent lookup. */
  load?: (id: string) => Promise<{ frontmatter: Record<string, unknown> }>;
}

export function validateSeatSpecs(raw: Record<string, SeatSpec>): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SeatUsageError("Invalid seat assignments.");
  for (const [id, spec] of Object.entries(raw)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec) ||
        Object.keys(spec).some(key => !["agent", "provider", "model"].includes(key)) ||
        (spec.agent !== undefined && spec.agent !== id) ||
        (spec.provider !== undefined && !PROVIDER_IDS.includes(spec.provider)) ||
        (spec.model !== undefined && (typeof spec.model !== "string" || !spec.model.trim()))) {
      throw new SeatUsageError("Invalid seat assignment.");
    }
  }
}

async function metadataAt(id: string, dir?: string): Promise<{ frontmatter: Record<string, unknown> }> {
  if (!dir) return loadAgent(id);
  if (!isAbsolute(dir)) throw new SeatUsageError("--agents-dir requires an absolute directory.");
  const root = await realpath(dir);
  const candidates = /[\\/]|\.md$/i.test(id) ? [resolve(root, id)] : [join(root, `${id}.md`), join(root, `subagent-${id}.md`), join(root, id, "AGENT.md")];
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      return { frontmatter: parseAgentFrontmatter(await readFile(path, "utf8")).data };
    } catch { /* Try the next supported persona layout. */ }
  }
  throw new SeatUsageError(`Agent prompt not found for seat ${agentKey(id)}.`);
}

/** A persona's own model, unless it is unset, "inherit", or a Claude name aimed at another provider. */
function frontmatterModel(frontmatter: Record<string, unknown>, provider: LLMProvider): string | undefined {
  const value = frontmatter.model;
  if (typeof value !== "string" || !value.trim() || value.trim().toLowerCase() === "inherit") return undefined;
  if (provider !== "anthropic" && /^(opus|sonnet|haiku|claude-)/i.test(value.trim())) return undefined;
  return value.trim();
}

/**
 * Models that came from a persona's frontmatter (agent, provider, model). Only these fall back to the
 * provider's default when the provider says the model does not exist; --seat and `seats` models never do.
 * (An explicit assignment that names the very same agent, provider and model is indistinguishable.)
 */
const frontmatterPins = new Set<string>();
const pinKey = (agent: string, provider: string, model: string): string => JSON.stringify([agentKey(agent), provider, model]);
export const isFrontmatterModel = (agent: string, provider: string, model: string): boolean => frontmatterPins.has(pinKey(agent, provider, model));
export const clearFrontmatterModels = (): void => frontmatterPins.clear();
const defaultModelFor = (provider: LLMProvider): string => provider === "anthropic" ? resolveAnthropicModel(DEFAULT_MODELS[provider]) : DEFAULT_MODELS[provider];

/** The provider says the model itself is unknown: HTTP 404, or a 400 whose text says the model does not exist. */
export function isUnknownModelError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  return error.status === 404 || (error.status === 400 && /model/i.test(error.message) && /(not[ _-]?found|does not exist|unknown model|no such model|not available)/i.test(error.message));
}

/**
 * Run a provider call for a seat. When the seat's model came from persona frontmatter and the provider
 * rejects it as unknown, switch the seat (in place) to the provider's default model with a one-line
 * warning and retry once. Any other failure, and any explicitly assigned model, throws as before.
 */
export async function callWithFrontmatterFallback<T>(
  target: { provider: LLMProvider; model: string }, agent: string, call: () => Promise<T>,
  warn: (line: string) => void = line => { process.stderr.write(`${line}\n`); },
): Promise<T> {
  try { return await call(); }
  catch (error) {
    const fallback = defaultModelFor(target.provider);
    if (!isUnknownModelError(error) || !isFrontmatterModel(agent, target.provider, target.model) || fallback === target.model) throw error;
    frontmatterPins.delete(pinKey(agent, target.provider, target.model));
    warn(`persona ${agentKey(agent)}: model ${target.model} not available; using ${fallback}`);
    target.model = fallback;
    return call();
  }
}

/** Resolve the complete roster before any provider call. Higher precedence replaces a whole assignment. */
export async function resolveSeats(opts: ResolveSeatsOptions): Promise<Map<string, Seat>> {
  if (opts.mix !== undefined && opts.mix !== "auto" && opts.mix !== "cheap") throw new SeatUsageError("--mix must be auto or cheap.");
  const roster: { id: string; team?: Seat["team"]; index: number }[] = [];
  for (const [team, ids] of [["A", opts.teamA], ["B", opts.teamB], ["judge", opts.judges], [undefined, opts.agents]] as const) {
    ids?.forEach((id, index) => roster.push({ id, team, index }));
  }
  if (!roster.length) throw new SeatUsageError("Specify agents for the table.");
  if (new Set(roster.map(s => s.id)).size !== roster.length) throw new SeatUsageError("Each agent must have a unique seat.");
  const overrides = new Map<string, SeatSpec>();
  const raw = opts.seat ?? opts.seats;
  if (typeof raw === "string") {
    for (const value of raw.split(",")) {
      let spec: SeatSpec;
      try { spec = parseSeat(value); } catch { throw new SeatUsageError("Invalid --seat assignment; use agent=provider:model."); }
      if (!spec.provider) throw new SeatUsageError("--seat requires agent=provider:model or agent=provider.");
      if (overrides.has(spec.agent)) throw new SeatUsageError("Repeated seat assignment.");
      overrides.set(spec.agent, spec);
    }
  } else if (raw !== undefined) {
    validateSeatSpecs(raw);
    for (const [id, spec] of Object.entries(raw)) overrides.set(id, spec);
  }
  for (const id of overrides.keys()) if (!roster.some(s => s.id === id)) throw new SeatUsageError("Seat override names an agent outside the roster.");
  const available = availableProviders(opts.env).filter(provider => !opts.excludeProviders?.includes(provider));
  if (opts.mix && !available.length) throw new SeatUsageError("--mix requires at least one configured provider.");
  const out = new Map<string, Seat>();
  for (const { id, team, index } of roster) {
    const { frontmatter } = await (opts.load ?? (id => metadataAt(id, opts.agentsDir)))(id);
    const override = overrides.get(id);
    const mixed = opts.mix ? available[(index + (team === "B" ? 1 : team === "judge" ? 2 : 0)) % available.length] : undefined;
    const provider = override?.provider ?? mixed ?? (Object.hasOwn(frontmatter, "provider") ? frontmatter.provider : opts.provider ?? "anthropic");
    if (!PROVIDER_IDS.includes(provider as LLMProvider)) throw new SeatUsageError("Invalid seat provider.");
    const p = provider as LLMProvider;
    const fromFrontmatter = override?.model === undefined && !override?.provider && !mixed ? frontmatterModel(frontmatter, p) : undefined;
    const model = override?.model ?? (override?.provider || mixed ? DEFAULT_MODELS[p] : fromFrontmatter ?? (p === (opts.provider ?? "anthropic") ? opts.model : undefined) ?? DEFAULT_MODELS[p]);
    if (typeof model !== "string" || !model.trim()) throw new SeatUsageError("Seat model must be a non-empty string.");
    if (!/^[\x21-\x7e]{1,200}$/.test(model.trim())) throw new SeatUsageError("Seat model must be 1 to 200 printable ASCII characters with no whitespace.");
    const finalModel = p === "anthropic" ? resolveAnthropicModel(model.trim()) : model.trim();
    if (fromFrontmatter !== undefined && model === fromFrontmatter) frontmatterPins.add(pinKey(id, p, finalModel));
    out.set(id, { id, name: agentKey(id), ...(team && { team }), provider: p, model: finalModel, ...(typeof frontmatter.role === "string" && { role: frontmatter.role }) });
  }
  return out;
}

export interface SeatPreflightResult {
  provider: LLMProvider;
  model: string;
  ok: boolean;
  reason?: "auth failed" | "model not found" | "missing credentials" | "request timed out" | "request failed";
}

/** Check every pair even after failures; return only local, credential-free diagnostics. */
export async function preflightSeats(
  seats: Iterable<Seat>, signal?: AbortSignal, report?: (result: SeatPreflightResult) => void,
): Promise<SeatPreflightResult[]> {
  const results: SeatPreflightResult[] = [];
  const seen = new Set<string>();
  for (const seat of seats) {
    signal?.throwIfAborted();
    const key = JSON.stringify([seat.provider, seat.model]);
    if (seen.has(key)) continue;
    seen.add(key);
    const timeout = AbortSignal.timeout(30_000);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const result: SeatPreflightResult = { provider: seat.provider, model: seat.model, ok: true };
    try {
      assertSeatCredentials([seat]);
      await withAbortSignal(stop, () => callLLM("Reply briefly.", [{ role: "user", content: "Reply OK." }], { provider: seat.provider, model: seat.model, maxTokens: 64 }));
    } catch (error) {
      signal?.throwIfAborted();
      result.ok = false;
      result.reason = error instanceof ProviderHttpError && [401, 403].includes(error.status) ? "auth failed"
        : error instanceof SeatUsageError ? "missing credentials"
        : isUnknownModelError(error) ? "model not found"
        : stop.aborted ? "request timed out" : "request failed";
    }
    results.push(result);
    report?.(result);
  }
  return results;
}

/** Preflight mixes by default, then allocate again using only surviving providers. */
export async function prepareSeats(opts: ResolveSeatsOptions, options: {
  preflight?: boolean; signal?: AbortSignal; report?: (message: string) => void;
} = {}): Promise<Map<string, Seat>> {
  let seats = await resolveSeats(opts);
  if (!(options.preflight ?? !!opts.mix)) {
    assertSeatCredentials(seats.values(), opts.env);
    return seats;
  }
  const probes = [...seats.values()];
  if (opts.mix) {
    // Include configured providers that the initial roster did not reach, so fallback is checked too.
    for (const provider of availableProviders(opts.env)) {
      if (!opts.excludeProviders?.includes(provider)) probes.push({ id: provider, name: provider, provider, model: DEFAULT_MODELS[provider] });
    }
  }
  const results = await preflightSeats(probes, options.signal, result => {
    options.report?.(`${result.provider}/${result.model}: ${result.ok ? "pass" : `fail (${result.reason})`}`);
  });
  // A frontmatter model the provider does not know falls back once to the provider's default; an assigned one fails.
  if (results.some(r => r.reason === "model not found")) {
    const replaced = new Map(seats);
    for (const [id, seat] of seats) {
      if (!results.some(r => r.reason === "model not found" && r.provider === seat.provider && r.model === seat.model)) continue;
      if (!isFrontmatterModel(id, seat.provider, seat.model) || defaultModelFor(seat.provider) === seat.model) {
        throw new SeatUsageError(`Seat ${seat.name} (${seat.provider}): model ${seat.model} not available.`);
      }
      const model = defaultModelFor(seat.provider);
      options.report?.(`persona ${seat.name}: model ${seat.model} not available; using ${model}`);
      frontmatterPins.delete(pinKey(id, seat.provider, seat.model));
      replaced.set(id, { ...seat, model });
    }
    seats = replaced;
    const rerun = await preflightSeats(seats.values(), options.signal, result => {
      if (!results.some(r => r.provider === result.provider && r.model === result.model)) options.report?.(`${result.provider}/${result.model}: ${result.ok ? "pass" : `fail (${result.reason})`}`);
    });
    results.push(...rerun.filter(r => !results.some(o => o.provider === r.provider && o.model === r.model)));
  }
  const failed = new Map<LLMProvider, SeatPreflightResult>();
  for (const result of results) {
    if (!result.ok && result.reason !== "model not found" && (!failed.has(result.provider) || result.reason === "auth failed")) failed.set(result.provider, result);
  }
  const raw = opts.seat ?? opts.seats;
  const explicit = new Set(typeof raw === "string" ? raw.split(",").map(value => parseSeat(value).agent) : Object.keys(raw ?? {}));
  for (const seat of seats.values()) {
    const failure = failed.get(seat.provider);
    if (failure && (explicit.has(seat.id) || !opts.mix)) {
      throw new SeatUsageError(`Seat ${seat.name} (${seat.provider}): preflight ${failure.reason}.`);
    }
  }
  if (opts.mix && failed.size) {
    for (const [provider, result] of failed) options.report?.(`${provider}: ${result.reason}, excluded from mix`);
    if (!availableProviders(opts.env).some(provider => !failed.has(provider) && !opts.excludeProviders?.includes(provider))) {
      throw new SeatUsageError("No providers passed preflight for --mix.");
    }
    seats = await resolveSeats({ ...opts, excludeProviders: [...(opts.excludeProviders ?? []), ...failed.keys()] });
  }
  assertSeatCredentials(seats.values(), opts.env);
  return seats;
}
