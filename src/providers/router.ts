import { statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS, resolveAnthropicModel, ROUNDTABLE_HOME, MAX_TOKENS } from "../config.js";
import { PROVIDER_IDS, type LLMProvider } from "../provider-ids.js";
import { readUserConfig, type RoutingConfig, type RoutingTier } from "../user-config.js";
import { estimateUsd, type PricingTable } from "../execution/pricing.js";
import { day, readTableLines, tableWrites, type TableLine } from "../usage/table.js";
import { availableProviders, credentialFingerprint, endpointFingerprint, providerHealth, trustedRoutingEndpoint, type ProviderHealthCache } from "./health.js";
import { PROVIDER_MAX_TOKENS } from "./limits.js";

export type { RoutingTier };
export interface RoutingChoice { provider: LLMProvider; model: string; reason: string; maxOutputTokens: number }
export interface RoutingInputs {
  tier?: RoutingTier; env?: NodeJS.ProcessEnv; config?: RoutingConfig;
  health?: ProviderHealthCache; history?: readonly TableLine[]; now?: number;
  excludeProviders?: readonly LLMProvider[]; used?: readonly string[]; costBias?: boolean;
  remainingBudgetUsd?: number; inputTokens?: number; outputTokens?: number; pricing?: PricingTable;
  /** The seat belongs to a duel team: reasoning models are penalised by half a seat, so teams still spread. */
  teamSeat?: boolean;
  /** A model supplied without a provider remains a pin across candidates. */
  model?: string;
}
export function routingModels(provider: LLMProvider, tier: RoutingTier, config: RoutingConfig = {}): { model: string; reasoning: boolean; maxOutputTokens: number } {
  const override = config[provider]?.[tier];
  const model = override?.model ?? (provider === "anthropic" && tier === "judge" ? "claude-haiku-5-5" : DEFAULT_MODELS[provider]);
  return { model, reasoning: /glm|(?:^|\/)deepseek-r|^o[134](?:-|$)/i.test(model) || override?.reasoning === true,
    maxOutputTokens: Math.min(PROVIDER_MAX_TOKENS[provider], override?.maxOutputTokens ?? Infinity) };
}

/** Outcomes older than this no longer count: a provider that failed hours ago has had time to recover. */
export const FAILURE_WINDOW_MS = 6 * 3_600_000;

/**
 * Last 50 outcome-bearing calls for this pair within the window, with a stable, numeric median. Rows recorded
 * under another endpoint, or under a different credential hash once the key has changed, are ignored.
 */
export function recentPerformance(lines: readonly TableLine[], provider: string, model: string, endpoint?: string, cred?: string, now = Date.now()): { failures: number; rate: number; medianMs: number } {
  const recent = lines.filter(l => l.provider === provider && l.model === model && l.outcome !== undefined && l.endpoint === endpoint &&
    (l.cred === undefined || cred === undefined || l.cred === cred) && now - Date.parse(l.at) <= FAILURE_WINDOW_MS).slice(-50);
  const failures = recent.filter(l => l.outcome !== "ok").length;
  const times = recent.flatMap(l => l.latency_ms === undefined ? [] : [l.latency_ms]).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return { failures, rate: recent.length ? failures / recent.length : 0,
    medianMs: times.length ? times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2 : 0 };
}

export function recentRoutingHistory(now = Date.now(), home = ROUNDTABLE_HOME): TableLine[] {
  return readTableLines(Array.from({ length: 7 }, (_, i) => day(now - (6 - i) * 86_400_000)), home);
}

/** Routing runs once per hook or seat; the ledger and config are re-read only when they could have changed. */
const MEMO_MS = 5_000;
let historyMemo: { key: string; at: number; lines: TableLine[] } | undefined;
function memoHistory(now: number | undefined): TableLine[] {
  const t = Date.now(), key = `${ROUNDTABLE_HOME}:${now === undefined ? day(t) : now}:${tableWrites}`;
  if (historyMemo && historyMemo.key === key && t - historyMemo.at < MEMO_MS && t >= historyMemo.at) return historyMemo.lines;
  const lines = recentRoutingHistory(now);
  historyMemo = { key, at: t, lines };
  return lines;
}
const configMemo = new Map<string, { stamp: string; routing: RoutingConfig }>();
function memoRoutingConfig(home: string): RoutingConfig {
  let stamp = "none";
  try { const s = statSync(join(home, "config.json")); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* No config file. */ }
  const hit = configMemo.get(home);
  if (hit && hit.stamp === stamp) return hit.routing;
  const routing = readUserConfig(home).routing ?? {};
  configMemo.set(home, { stamp, routing });
  return routing;
}

/** Which provider namespaces can serve a model id given with no provider. Unknown shapes may go anywhere that is not a closed namespace. */
export function modelFitsProvider(provider: LLMProvider, model: string): boolean {
  if (/^(claude[-.\w]*|opus|sonnet|haiku)$/i.test(model)) return provider === "anthropic";
  if (/^(gpt-|chatgpt|o[134](-|$))/i.test(model)) return provider === "openai";
  return provider !== "anthropic" && provider !== "openai";
}

function validateTokenBounds(inputs: RoutingInputs): void {
  if ((inputs.inputTokens !== undefined && (!Number.isSafeInteger(inputs.inputTokens) || inputs.inputTokens < 0)) ||
      (inputs.outputTokens !== undefined && (!Number.isSafeInteger(inputs.outputTokens) || inputs.outputTokens < 1))) {
    throw new Error("Routing token bounds must be nonnegative input and positive output integers.");
  }
}

/** Conservative USD per million tokens assumed for a model with no known price (frontier-class ceiling). */
export const ESTIMATED_RATE_PER_MTOK = { input: 15, output: 75 } as const;

/**
 * Cost of one bounded call for the budget gate. A known price (price table or config override) is used as is;
 * an unpriced model is counted at a conservative token estimate and labelled estimated, never excluded outright.
 */
export function budgetEstimate(provider: string, model: string, tokens: { inputTokens: number; outputTokens: number }, pricing?: PricingTable): { usd: number; estimated: boolean } {
  const known = estimateUsd(model, tokens, { provider, table: pricing });
  if (!known.estimated) return known;
  return { usd: Math.round((tokens.inputTokens * ESTIMATED_RATE_PER_MTOK.input + tokens.outputTokens * ESTIMATED_RATE_PER_MTOK.output) / 1e6 * 1e9) / 1e9, estimated: true };
}

/** Budget is a hard gate, including pinned models and providers. Unpriced providers stay eligible on an estimated cost. */
export function assertRoutingBudget(provider: string, model: string, inputs: RoutingInputs): void {
  if (inputs.remainingBudgetUsd === undefined) return;
  validateTokenBounds(inputs);
  const cap = PROVIDER_MAX_TOKENS[provider];
  const outputTokens = inputs.outputTokens ?? (inputs.tier === "builder" ? cap : MAX_TOKENS);
  const estimate = budgetEstimate(provider, model, { inputTokens: inputs.inputTokens ?? 4096, outputTokens: Math.min(outputTokens, cap ?? MAX_TOKENS) }, inputs.pricing);
  if (!Number.isFinite(inputs.remainingBudgetUsd) || inputs.remainingBudgetUsd < 0 || estimate.usd > inputs.remainingBudgetUsd) {
    throw new Error(`${provider}/${model}: exceeds remaining budget (${estimate.estimated ? "estimated " : ""}$${estimate.usd.toFixed(4)} > $${Math.max(0, inputs.remainingBudgetUsd).toFixed(4)}).`);
  }
}

/** Pure deterministic selection given configuration, health, history and budget inputs. No model call. */
export function routeProvider(inputs: RoutingInputs = {}): RoutingChoice {
  validateTokenBounds(inputs);
  const env = inputs.env ?? process.env, tier = inputs.tier ?? "balanced";
  const config = inputs.config ?? memoRoutingConfig(env.ROUNDTABLE_HOME ?? ROUNDTABLE_HOME);
  const health = inputs.health ?? providerHealth;
  const history = inputs.history ?? memoHistory(inputs.now);
  const now = inputs.now ?? Date.now();
  const available = availableProviders(env), excluded: string[] = [];
  const candidates: Array<RoutingChoice & { failureRate: number; failures: number; latency: number; reasoning: boolean; cost: number; priced: boolean; spread: number }> = [];
  for (const provider of PROVIDER_IDS) {
    const capability = routingModels(provider, tier, config);
    const model = inputs.model ? (provider === "anthropic" ? resolveAnthropicModel(inputs.model) : inputs.model) : capability.model;
    const label = `${provider}/${model}`;
    if (inputs.model && !modelFitsProvider(provider, model)) { excluded.push(`${label}: model namespace`); continue; }
    const cached = health.get(provider, env);
    const reject = !available.includes(provider) ? "not configured" : !trustedRoutingEndpoint(provider, env) ? "untrusted base URL"
      : cached && !cached.ok ? cached.reason ?? "failed health check" : inputs.excludeProviders?.includes(provider) ? "failed preflight" : undefined;
    if (reject) { excluded.push(`${label}: ${reject}`); continue; }
    const outputTokens = Math.min(inputs.outputTokens ?? (tier === "builder" ? capability.maxOutputTokens : MAX_TOKENS), capability.maxOutputTokens);
    const estimate = budgetEstimate(provider, model, { inputTokens: inputs.inputTokens ?? 4096, outputTokens }, inputs.pricing);
    if (inputs.remainingBudgetUsd !== undefined && (!Number.isFinite(inputs.remainingBudgetUsd) || inputs.remainingBudgetUsd < 0 || estimate.usd > inputs.remainingBudgetUsd)) {
      excluded.push(`${label}: exceeds remaining budget${estimate.estimated ? " (estimated cost)" : ""}`); continue;
    }
    const performance = recentPerformance(history, provider, model, endpointFingerprint(provider, env), credentialFingerprint(provider, env), now);
    candidates.push({ provider, model, reason: "", maxOutputTokens: capability.maxOutputTokens, failures: performance.failures,
      failureRate: performance.rate, latency: performance.medianMs, reasoning: capability.reasoning || /glm/i.test(model),
      cost: estimate.usd, priced: !estimate.estimated, spread: inputs.used?.filter(p => p === provider).length ?? 0 });
  }
  if (tier === "builder" && candidates.some(c => !c.reasoning)) {
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].reasoning) {
      excluded.push(`${candidates[i].provider}/${candidates[i].model} excluded for build (reasoning model)`); candidates.splice(i, 1);
    }
  }
  // Unknown prices are their own rank (after every priced candidate), never the conservative budget estimate.
  const byCost = (x: typeof candidates[number], y: typeof candidates[number]): number =>
    x.priced === y.priced ? (x.priced ? x.cost - y.cost : 0) : x.priced ? -1 : 1;
  // A reasoning model is slow for live seats, so it ranks behind every non-reasoning provider (a penalty, not an
  // exclusion: it is still used when it is the only healthy choice). In a duel it counts as half a seat already used
  // instead, so the two teams still sit on different providers.
  const load = (c: typeof candidates[number]): number => c.spread + (tier !== "builder" && c.reasoning ? (inputs.teamSeat ? 0.5 : 1e6) : 0);
  const bySpread = (x: typeof candidates[number], y: typeof candidates[number]): number => load(x) - load(y);
  const mix = !!inputs.costBias;
  candidates.sort((x, y) => x.failureRate - y.failureRate ||
    (mix ? bySpread(x, y) || byCost(x, y) : tier === "judge" ? byCost(x, y) || bySpread(x, y) : bySpread(x, y)) ||
    (tier === "builder" ? y.maxOutputTokens - x.maxOutputTokens : 0) ||
    x.latency - y.latency || PROVIDER_IDS.indexOf(x.provider) - PROVIDER_IDS.indexOf(y.provider));
  const chosen = candidates[0];
  if (!chosen) throw new Error(`No healthy provider found (legacy fallback anthropic unavailable). Tried ${excluded.join("; ")}.`);
  const exclusions = excluded.filter(s => !/: (not configured|model namespace)$/.test(s));
  return { provider: chosen.provider, model: chosen.model, maxOutputTokens: chosen.maxOutputTokens,
    reason: `${exclusions.length ? exclusions.join("; ") + "; " : ""}${chosen.provider}/${chosen.model} chosen: ${health.get(chosen.provider, env)?.ok ? "healthy" : "configured, awaiting preflight"}, ${chosen.reasoning ? "reasoning" : "non-reasoning"}, ${chosen.failures} recent failures${chosen.priced ? "" : ", price estimated"}` };
}
