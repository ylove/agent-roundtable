// ============================================================================
// Pricing: USD per million tokens by model id, overridable with ROUNDTABLE_PRICING_FILE
//
// The built-in table holds Anthropic first-party API list prices from the claude-api skill's model
// table (2026-10-06), cross-checked against the platform pricing page (2026-10-15): base input,
// output, cache hits, and 5-minute cache writes. Where the two differ the skill's figure stands
// (Sonnet 5.5 cache hits: $0.20 in the skill, $0.10 on the page); it is the higher, so budgets err
// on the safe side. 1-hour
// cache writes (2x input) are not distinguished, because TokenUsage has one cacheWriteTokens
// count. A null price is unknown: tokens of that class make the estimate `estimated: true`.
// Partner platforms (Bedrock, Vertex AI) price separately; override the table for them.
// ============================================================================

import { closeSync } from "node:fs";
import { openRegularFile, readDescriptor, RegularFileError } from "../security/fs-safe.js";
import type { TokenUsage } from "./types.js";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface PriceRates {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

export interface ModelPrice extends PriceRates {
  /** Rates for a request whose prompt (input + cache reads + cache writes) exceeds above_tokens. */
  long?: PriceRates & { above_tokens: number };
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

const rates = (input: number, output: number, cache_read: number, cache_write: number): ModelPrice => ({
  input,
  output,
  cache_read,
  cache_write,
});

const UNKNOWN: ModelPrice = { input: null, output: null, cache_read: null, cache_write: null };

const OPUS_4X = rates(5, 25, 0.5, 6.25);
const OPUS_4_LEGACY = rates(15, 75, 1.5, 18.75);
const SONNET_4X = rates(3, 15, 0.3, 3.75);

export const BUILTIN_PRICING: PricingTable = Object.freeze({
  "claude-fable-5-1": rates(10, 50, 0.25, 12.5),
  "claude-mythos-5-1": rates(10, 50, 0.25, 12.5),
  "claude-fable-5": rates(10, 50, 1, 12.5),
  "claude-mythos-5": rates(10, 50, 1, 12.5),
  "claude-opus-5-5": rates(4, 20, 0.2, 5),
  "claude-opus-5": rates(5, 25, 0.5, 6.25),
  "claude-opus-4-8": OPUS_4X,
  "claude-opus-4-7": OPUS_4X,
  "claude-opus-4-6": OPUS_4X,
  "claude-opus-4-5": OPUS_4X,
  "claude-opus-4-1": OPUS_4_LEGACY,
  "claude-opus-4-0": OPUS_4_LEGACY,
  "claude-opus-4": OPUS_4_LEGACY,
  "claude-sonnet-5-5": rates(2, 10, 0.2, 2.5),
  "claude-sonnet-5": rates(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": SONNET_4X,
  "claude-sonnet-4-5": SONNET_4X,
  "claude-sonnet-4-0": SONNET_4X,
  "claude-sonnet-4": SONNET_4X,
  "claude-haiku-5-5": { ...rates(0.1, 0.5, 0.01, 0.125), long: { above_tokens: 100_000, ...rates(0.5, 2.5, 0.05, 0.625) } },
  "claude-haiku-4-5": rates(1, 5, 0.1, 1.25),
  "claude-3-5-haiku": rates(0.8, 4, 0.08, 1),
  // Default models of the other providers (src/config.ts): no published price is recorded here.
  "gpt-5.6-luna": UNKNOWN,
  "zai-org/GLM-5.3": UNKNOWN,
  "qwen/qwen3-235b-a22b-instruct-2507": UNKNOWN,
  "qwen3:14b": UNKNOWN,
});

/** Providers that bill nothing per token (local inference). */
const FREE_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export function isFreeProvider(provider: string | undefined): boolean {
  return provider !== undefined && FREE_PROVIDERS.has(provider);
}

// ---------------------------------------------------------------------------
// Override file
// ---------------------------------------------------------------------------

export const PRICING_FILE_ENV = "ROUNDTABLE_PRICING_FILE";
const MAX_PRICING_FILE_BYTES = 1024 * 1024;
const RATE_KEYS = ["input", "output", "cache_read", "cache_write"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRates(where: string, v: Record<string, unknown>, extra: readonly string[]): PriceRates {
  for (const k of Object.keys(v)) {
    if (!(RATE_KEYS as readonly string[]).includes(k) && !extra.includes(k)) throw new Error(`${where}: unknown field "${k}"`);
  }
  const out = { ...UNKNOWN };
  for (const k of RATE_KEYS) {
    const r = v[k];
    if (r === undefined || r === null) {
      if ((k === "input" || k === "output") && r === undefined) throw new Error(`${where}: "${k}" is required (a number or null)`);
      continue;
    }
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0) throw new Error(`${where}.${k}: must be a non-negative number or null`);
    out[k] = r;
  }
  return out;
}

/**
 * Validate a pricing file: `{"<model id>": {"input": n|null, "output": n|null, "cache_read"?: n|null,
 * "cache_write"?: n|null, "long"?: {"above_tokens": n, ...rates}}}`, USD per million tokens.
 */
export function parsePricing(text: string, source = PRICING_FILE_ENV): Record<string, ModelPrice> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: invalid JSON (${(err as Error).message})`);
  }
  if (!isRecord(data)) throw new Error(`${source}: expected an object of model id → prices`);
  const out: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(data)) {
    const where = `${source}: ${JSON.stringify(model)}`;
    if (!model.trim() || model.length > 200) throw new Error(`${where}: model ids must be 1-200 characters`);
    if (!isRecord(v)) throw new Error(`${where}: expected an object of prices`);
    const price: ModelPrice = parseRates(where, v, ["long"]);
    if (v.long !== undefined) {
      if (!isRecord(v.long)) throw new Error(`${where}.long: expected an object`);
      const above = v.long.above_tokens;
      if (typeof above !== "number" || !Number.isInteger(above) || above <= 0) {
        throw new Error(`${where}.long.above_tokens: must be a positive integer`);
      }
      price.long = { above_tokens: above, ...parseRates(`${where}.long`, v.long, ["above_tokens"]) };
    }
    Object.defineProperty(out, model, { value: price, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

let cache: { key: string; table: PricingTable } | undefined;

/** The built-in table with ROUNDTABLE_PRICING_FILE merged over it (re-read when the file changes); throws on an invalid file. */
export function loadPricing(env: NodeJS.ProcessEnv = process.env): PricingTable {
  const file = env[PRICING_FILE_ENV]?.trim();
  if (!file) return BUILTIN_PRICING;
  // One descriptor: the type, size and contents checked are those of the same open file.
  let opened;
  try {
    opened = openRegularFile(file, { maxBytes: MAX_PRICING_FILE_BYTES });
  } catch (err) {
    if (err instanceof RegularFileError) {
      throw new Error(`${PRICING_FILE_ENV} ${file}: ${err.code === "ENOTREG" ? "not a regular file" : "larger than 1 MB"}`);
    }
    throw new Error(`${PRICING_FILE_ENV} ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  try {
    const { fd, stat: st } = opened;
    const key = `${file}\0${st.mtimeMs}\0${st.size}`;
    if (cache?.key === key) return cache.table;
    const table = Object.freeze({ ...BUILTIN_PRICING, ...parsePricing(readDescriptor(fd, MAX_PRICING_FILE_BYTES).toString("utf8"), `${PRICING_FILE_ENV} ${file}`) });
    cache = { key, table };
    return table;
  } finally {
    closeSync(opened.fd);
  }
}

// ---------------------------------------------------------------------------
// Lookup and estimate
// ---------------------------------------------------------------------------

/** Candidate table keys for a model id: as given, then without platform prefixes, version and date suffixes. */
function candidates(model: string): string[] {
  const out = [model];
  let m = model.trim().toLowerCase();
  out.push(m);
  m = m.replace(/\[1m\]$/, "");
  m = m.replace(/^(?:[a-z]{2,6}\.)?anthropic[./]/, ""); // anthropic/…, anthropic.…, us.anthropic.…, global.anthropic.…
  m = m.replace(/-v\d+(?::\d+)?$/, ""); // Bedrock -v1:0
  m = m.replace(/[@-]\d{8}$/, ""); // dated snapshots: -20250929, Vertex @20250929
  out.push(m);
  return [...new Set(out)];
}

export function priceFor(model: string, table: PricingTable = loadPricing()): ModelPrice | undefined {
  for (const c of candidates(model)) if (Object.hasOwn(table, c)) return table[c];
  return undefined;
}

export interface UsdEstimate {
  usd: number;
  /** True when the model, or the price of a token class that was used, is unknown (usd then covers only the known part). */
  estimated: boolean;
}

/**
 * Cost of one call from its token counts. inputTokens is the uncached input (Anthropic usage
 * semantics); cache reads and writes are counted separately. Rounded to 1e-9 USD.
 */
export function estimateUsd(
  model: string,
  tokens: TokenUsage,
  opts: { provider?: string; table?: PricingTable } = {}
): UsdEstimate {
  if (opts.provider !== undefined && FREE_PROVIDERS.has(opts.provider)) return { usd: 0, estimated: false };
  const price = priceFor(model, opts.table ?? loadPricing());
  const counts: Record<(typeof RATE_KEYS)[number], number> = {
    input: tokens.inputTokens || 0,
    output: tokens.outputTokens || 0,
    cache_read: tokens.cacheReadTokens || 0,
    cache_write: tokens.cacheWriteTokens || 0,
  };
  if (!price) return { usd: 0, estimated: Object.values(counts).some((n) => n > 0) };
  const prompt = counts.input + counts.cache_read + counts.cache_write;
  const r: PriceRates = price.long && prompt > price.long.above_tokens ? price.long : price;
  let usd = 0;
  let estimated = false;
  for (const k of RATE_KEYS) {
    if (counts[k] <= 0) continue;
    const rate = r[k];
    if (rate === null) estimated = true;
    else usd += (counts[k] * rate) / 1_000_000;
  }
  return { usd: Math.round(usd * 1e9) / 1e9, estimated };
}
