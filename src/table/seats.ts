import { PROVIDER_MAX_TOKENS } from "../providers/limits.js";
import { PROVIDER_KEYS, availableProviders, providerHealth, trustedRoutingEndpoint } from "../providers/health.js";
import { routeProvider, assertRoutingBudget, recentRoutingHistory, type RoutingInputs } from "../providers/router.js";
import { readUserConfig } from "../user-config.js";
import { ROUNDTABLE_HOME, MAX_TOKENS } from "../config.js";
import { getRuntime } from "../runtimes/registry.js";
import { RUNTIME_MODEL } from "../runtimes/spec.js";
import { detectRuntime } from "../runtimes/runner.js";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentKey, loadAgent, parseAgentFrontmatter } from "../agents.js";
import { DEFAULT_MODELS, PROVIDER_IDS, resolveAnthropicModel, type LLMProvider } from "../config.js";
import { callLLM, withAbortSignal } from "../providers/index.js";
import { ProviderHttpError } from "../providers/retry.js";
import { parseSeat, type Seat, type SeatSpec } from "./events.js";

export class SeatUsageError extends Error { readonly exitCode = 2; }
export { PROVIDER_KEYS, availableProviders } from "../providers/health.js";
export function assertSeatCredentials(seats: Iterable<Seat>, env: NodeJS.ProcessEnv = process.env): void {
  for (const seat of seats) {
    const key = Object.hasOwn(PROVIDER_KEYS, seat.provider) ? PROVIDER_KEYS[seat.provider as LLMProvider] : undefined;
    if (key && !env[key]?.trim()) throw new SeatUsageError(`Missing ${key} for seat ${seat.id}.`);
    if (seat.provider === "openai_compatible" && !env.OPENAI_COMPATIBLE_BASE_URL?.trim()) throw new SeatUsageError("Missing OPENAI_COMPATIBLE_BASE_URL.");
  }
}
export interface ResolveSeatsOptions {
  agents?: string[]; teamA?: string[]; teamB?: string[]; judges?: string[];
  seats?: string | Record<string, SeatSpec>; seat?: string; mix?: "auto" | "cheap";
  provider?: LLMProvider | "auto"; model?: string; agentsDir?: string;
  env?: NodeJS.ProcessEnv;
  routing?: RoutingInputs;
  tier?: RoutingInputs["tier"];
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
        (spec.provider !== undefined && !(PROVIDER_IDS as readonly string[]).includes(spec.provider) && !getRuntime(spec.provider)) ||
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
export const forgetFrontmatterModel = (agent: string, provider: string, model: string): void => { frontmatterPins.delete(pinKey(agent, provider, model)); };
export const defaultModelFor = (provider: LLMProvider): string => provider === "anthropic" ? resolveAnthropicModel(DEFAULT_MODELS[provider]) : DEFAULT_MODELS[provider];

/** The provider says the model itself is unknown: HTTP 404, or a 400 whose text says the model does not exist. */
export function isUnknownModelError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  return error.status === 404 || (error.status === 400 && /model/i.test(error.message) && /(not[ _-]?found|does not exist|unknown model|no such model|not available)/i.test(error.message));
}

function routingTier(opts: ResolveSeatsOptions, seat: Pick<Seat, "id" | "team" | "role">): NonNullable<RoutingInputs["tier"]> {
  return opts.tier ?? (seat.team === "judge" ? "judge" :
    (seat.team === "A" || seat.team === "B") && (seat.team === "A" ? opts.teamA : opts.teamB)?.at(-1) === seat.id ? "builder" :
    /judge|critic|review/i.test(seat.role ?? "") ? "judge" : "balanced");
}

/** Resolve the roster deterministically; explicit assignments and healthy persona pins precede judgment. */
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
      try { spec = parseSeat(value); } catch { throw new SeatUsageError("Invalid --seat assignment; use agent=provider[:model] or agent=runtime[:model]."); }
      if (!spec.provider) throw new SeatUsageError("--seat requires agent=provider[:model] or agent=runtime[:model].");
      if (overrides.has(spec.agent)) throw new SeatUsageError("Repeated seat assignment.");
      overrides.set(spec.agent, spec);
    }
  } else if (raw !== undefined) {
    validateSeatSpecs(raw);
    for (const [id, spec] of Object.entries(raw)) overrides.set(id, spec);
  }
  for (const id of overrides.keys()) if (!roster.some(s => s.id === id)) throw new SeatUsageError("Seat override names an agent outside the roster.");
  const available = availableProviders(opts.env).filter(provider => !opts.excludeProviders?.includes(provider));

  if (opts.mix && !available.length) {
    try { routeProvider({ ...opts.routing, env: opts.env, excludeProviders: opts.excludeProviders }); }
    catch (error) { throw new SeatUsageError(`--mix requires at least one configured provider. ${error instanceof Error ? error.message : ""}`); }
  }
  const out = new Map<string, Seat>();
  const env = opts.env ?? process.env;
  const config = opts.routing?.config ?? readUserConfig(env.ROUNDTABLE_HOME ?? ROUNDTABLE_HOME).routing ?? {};
  const history = opts.routing?.history ?? recentRoutingHistory(opts.routing?.now);
  for (const { id, team, index } of roster) {
    const { frontmatter } = await (opts.load ?? (id => metadataAt(id, opts.agentsDir)))(id);
    const override = overrides.get(id);
    const explicit = override?.provider ?? (opts.provider !== "auto" ? opts.provider : undefined);
    const persona = frontmatter.provider;
    if (!explicit && persona !== undefined && !(PROVIDER_IDS as readonly unknown[]).includes(persona)) throw new SeatUsageError("Invalid seat provider.");
    const healthyPersona = typeof persona === "string" && available.includes(persona as LLMProvider) &&
      trustedRoutingEndpoint(persona as LLMProvider, env) && (opts.routing?.health ?? providerHealth).get(persona as LLMProvider, env)?.ok !== false;
    const tier = routingTier(opts, { id, team, role: typeof frontmatter.role === "string" ? frontmatter.role : undefined });
    const choose = () => {
      try { return routeProvider({ ...opts.routing, tier, env, config, history, model: override?.model ?? opts.model,
        excludeProviders: opts.excludeProviders, costBias: !!opts.mix, teamSeat: team === "A" || team === "B", used: [...out.values()].map(s => s.provider) }); }
      catch (error) { throw new SeatUsageError(error instanceof Error ? error.message : "Unable to route providers."); }
    };
    const choice = !explicit && !healthyPersona ? choose() : undefined;
    const provider = explicit ?? (healthyPersona ? persona : choice!.provider);
    const runtime = override?.provider ? getRuntime(override.provider) : undefined;
    if (runtime) {
      const model = override?.model ?? "";
      if (model && (!RUNTIME_MODEL.test(model) || !runtime.modelFlag)) throw new SeatUsageError("Invalid runtime model override.");
      assertRoutingBudget(override!.provider!, model, { ...opts.routing, tier });
      out.set(id, { id, name: agentKey(id), ...(team && { team }), provider: override!.provider!, model, reason: "explicit runtime" });
      continue;
    }
    if (!PROVIDER_IDS.includes(provider as LLMProvider)) throw new SeatUsageError("Invalid seat provider.");
    const p = provider as LLMProvider;
    const fromFrontmatter = override?.model === undefined && opts.model === undefined && !explicit && (healthyPersona || persona === undefined) ? frontmatterModel(frontmatter, p) : undefined;
    const model = override?.model ?? (!override?.provider ? opts.model : undefined) ?? (explicit ? DEFAULT_MODELS[p] : fromFrontmatter ?? choice?.model ?? DEFAULT_MODELS[p]);
    if (typeof model !== "string" || !model.trim()) throw new SeatUsageError("Seat model must be a non-empty string.");
    if (!/^[\x21-\x7e]{1,200}$/.test(model.trim())) throw new SeatUsageError("Seat model must be 1 to 200 printable ASCII characters with no whitespace.");
    const finalModel = p === "anthropic" ? resolveAnthropicModel(model.trim()) : model.trim();
    assertRoutingBudget(p, finalModel, { ...opts.routing, tier });
    if (fromFrontmatter !== undefined && model === fromFrontmatter) frontmatterPins.add(pinKey(id, p, finalModel));
    out.set(id, { id, name: agentKey(id), ...(team && { team }), provider: p, model: finalModel, ...(choice && { maxOutputTokens: choice.maxOutputTokens }), reason: choice?.reason.replace(`${p}/${choice.model}`, `${p}/${finalModel}`) ?? (explicit ? "explicit provider/model" : "healthy persona provider/model"), ...(typeof frontmatter.role === "string" && { role: frontmatter.role }) });
  }
  return out;
}

export interface SeatPreflightResult {
  provider: string;
  model: string;
  ok: boolean;
  reason?: "auth failed" | "model not found" | "missing credentials" | "request timed out" | "request failed" | "runtime unavailable";
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
      const runtime = getRuntime(seat.provider);
      if (runtime) {
        const detected = await detectRuntime(runtime, { signal: stop });
        if (!detected.ok) { result.ok = false; result.reason = "runtime unavailable"; }
      } else {
        assertSeatCredentials([seat]);
        await withAbortSignal(stop, () => callLLM("Reply briefly.", [{ role: "user", content: "Reply OK." }], { provider: seat.provider as LLMProvider, model: seat.model, maxTokens: 64 }));
      }
    } catch (error) {
      signal?.throwIfAborted();
      result.ok = false;
      result.reason = error instanceof ProviderHttpError && [401, 403].includes(error.status) ? "auth failed"
        : error instanceof SeatUsageError ? "missing credentials"
        : isUnknownModelError(error) ? "model not found"
        : stop.aborted ? "request timed out" : "request failed";
    }
    if ((PROVIDER_IDS as string[]).includes(result.provider) && result.reason !== "missing credentials" && result.reason !== "model not found") {
      providerHealth.recordCall(result.provider as LLMProvider, result.ok, result.reason, process.env, undefined, result.ok ? result.model : undefined);
    }
    results.push(result);
    report?.(result);
  }
  return results;
}

/** Preflight automatic choices, then route again after failures. Explicit assignments never fall back. */
export async function prepareSeats(opts: ResolveSeatsOptions, options: {
  preflight?: boolean; signal?: AbortSignal; report?: (message: string) => void;
} = {}): Promise<Map<string, Seat>> {
  const env = opts.env ?? process.env;
  const failed = new Set(opts.excludeProviders ?? []);
  const attempted = new Map<string, SeatPreflightResult>();
  for (let pass = 0; pass <= PROVIDER_IDS.length; pass++) {
    let seats: Map<string, Seat>;
    try { seats = await resolveSeats({ ...opts, excludeProviders: [...failed] }); }
    catch (error) {
      if (error instanceof SeatUsageError) throw error;
      throw new SeatUsageError(error instanceof Error ? error.message : "Unable to route providers.");
    }
    const automatic = [...seats.values()].some(s => !s.reason?.startsWith("explicit"));
    if (!(options.preflight ?? (automatic || !!opts.mix))) { assertSeatCredentials(seats.values(), env); return seats; }
    const probes = [...seats.values()].filter(s => {
      if (options.preflight !== true && !opts.mix && s.reason?.startsWith("explicit")) return false;
      if (s.reason?.startsWith("explicit")) return true;
      return !(PROVIDER_IDS as string[]).includes(s.provider) || !providerHealth.passed(s.provider as LLMProvider, s.model, env);
    });
    const results = await preflightSeats(probes, options.signal, result => {
      attempted.set(`${result.provider}/${result.model}`, result);
      options.report?.(`${result.provider}/${result.model || "default"}: ${result.ok ? "pass" : `fail (${result.reason})`}`);
    });
    let reroute = false;
    for (const result of results.filter(r => !r.ok)) {
      for (const [id, seat] of seats) {
        if (seat.provider !== result.provider || seat.model !== result.model) continue;
        const explicit = seat.reason?.startsWith("explicit");
        if (result.reason === "model not found" && !explicit && isFrontmatterModel(id, seat.provider, seat.model) && defaultModelFor(seat.provider as LLMProvider) !== seat.model) {
          const model = defaultModelFor(seat.provider as LLMProvider);
          const tier = routingTier(opts, seat);
          const outputTokens = Math.min(opts.routing?.outputTokens ?? (tier === "builder" ? PROVIDER_MAX_TOKENS[seat.provider] : MAX_TOKENS), seat.maxOutputTokens ?? Infinity);
          assertRoutingBudget(seat.provider, model, { ...opts.routing, tier, outputTokens });
          const message = `persona ${seat.name}: model ${seat.model} not available; using ${model}`;
          if (options.report) options.report(message); else process.stderr.write(`${message}\n`);
          forgetFrontmatterModel(id, seat.provider, seat.model);
          const [replacement] = await preflightSeats([{ ...seat, model }], options.signal);
          if (replacement.ok) { seats.set(id, { ...seat, model }); continue; }
          throw new SeatUsageError(`Seat ${seat.name} (${seat.provider}): ${replacement.reason === "model not found" ? `model ${model} not available` : `preflight ${replacement.reason}`}.`);
        }
        if (explicit || result.reason === "model not found") throw new SeatUsageError(`Seat ${seat.name} (${seat.provider}): ${result.reason === "model not found" ? `model ${seat.model} not available` : `preflight ${result.reason}`}.`);
        failed.add(result.provider as LLMProvider);
        options.report?.(`${result.provider}: ${result.reason}, excluded from routing`);
        reroute = true;
      }
    }
    if (reroute) continue;
    for (const [id, seat] of seats) {
      if (seat.reason && !seat.reason.startsWith("explicit")) seats.set(id, { ...seat, reason: seat.reason.replace("configured, awaiting preflight", "healthy") });
    }
    assertSeatCredentials(seats.values(), env);
    return seats;
  }
  throw new SeatUsageError(`No healthy provider found. Tried ${[...attempted.values()].map(r => `${r.provider}: ${r.reason ?? "pass"}`).join("; ")}.`);
}
