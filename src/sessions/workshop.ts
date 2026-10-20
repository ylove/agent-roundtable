// ============================================================================
// Shared helpers for phase-based workshops
// ============================================================================

import { PARALLEL_TURNS } from "../config.js";
import { callLLM, type CallLLMOptions } from "../providers/index.js";
import { metered, type SessionScope } from "../usage/session-scope.js";

/** Settle every item before reporting the first failure in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const errors = new Map<number, unknown>();
  let next = 0;
  const concurrency = Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (e) {
        errors.set(index, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, () => worker()));
  for (let i = 0; i < items.length; i++) {
    if (errors.has(i)) throw errors.get(i);
  }
  return results;
}

export function extractJsonObject(text: string): unknown {
  const candidates = [text.trim()];
  for (const fence of text.matchAll(/```[^\r\n`]*\r?\n([\s\S]*?)```/g)) candidates.push(fence[1].trim());
  // Balanced top-level {...} spans. Quotes are tracked only inside a span, so prose apostrophes,
  // stray quotes and brackets around the object cannot hide it.
  const spans: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        spans.push(text.slice(start, end + 1));
        start = end;
        break;
      }
    }
    // An unclosed span does not hide objects starting later in the response.
  }
  candidates.push(...spans.sort((a, b) => b.length - a.length));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype) return value;
    } catch {
      // Try the next fenced or balanced candidate.
    }
  }
  throw new Error(text.includes("{")
    ? "Invalid JSON object. Return valid JSON with quoted keys and no trailing commas."
    : "No JSON object found. Return a complete JSON object.");
}

export function notFoundError(kind: string, id: string, activeIds: string[]): Error {
  return new Error(`${kind} not found: ${id}. Active ${kind.toLowerCase()}s: ${activeIds.join(", ") || "none"}`);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max)) + "\n…[truncated]";
}

/** Match the label at the start of a line and the longest canonical verdict at the start of its value. */
export function parseVerdict(text: string, label: string, options: readonly string[]): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?");
  const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)$`, "i");
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const line of text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 5)) {
    let normalized = line.replace(/[\u2010-\u2014\u2212]/g, "-").replace(/[*_`]/g, "");
    let previous: string;
    do {
      previous = normalized;
      normalized = normalized.replace(/^\s*(?:#+\s*|>\s*|[-+]\s+|\d+[.)]\s+)/, "");
    } while (normalized !== previous);
    const match = pattern.exec(normalized);
    if (!match) continue;
    const verdict = match[1].trim().toUpperCase();
    for (const option of sorted) {
      const canonical = option.toUpperCase();
      if (verdict.startsWith(canonical) && (verdict.length === canonical.length || /[\s.,;:!?—–(-]/.test(verdict[canonical.length]))) {
        return option;
      }
    }
  }
  return "UNCLEAR";
}

// ----------------------------------------------------------------------------
// Verdict rounds: ultraplan reviews and sign-offs, contract consent
// ----------------------------------------------------------------------------

export interface VerdictRoundOptions<A> {
  /** The canonical verdicts after `<label>:` (parseVerdict). */
  verdicts: readonly string[];
  llm: CallLLMOptions;
  /** Concurrent calls; default PARALLEL_TURNS. */
  limit?: number;
  /**
   * Asked once more, as a follow-up in the same conversation, when the first answer has no
   * verdict (UNCLEAR). The second answer replaces the first.
   */
  reask?: string | ((agent: A, index: number) => string);
  /**
   * Report a failed call as an UNCLEAR answer with `error` instead of failing the round. Without
   * it the round settles every call and then throws the first error in agent order (mapLimit).
   */
  catchErrors?: boolean;
  /** Meter each agent's calls under this usage scope (at-the-table sessions: usage/session-scope.ts). */
  scope?: (agent: A, index: number) => SessionScope;
}

export interface VerdictAnswer<A> {
  agent: A;
  index: number;
  content: string;
  verdict: string;
  /** True when the answer is the re-asked one. */
  reasked: boolean;
  /** When the answer arrived. */
  at: Date;
  /** catchErrors only: why there is no answer (content is then empty and verdict UNCLEAR). */
  error?: string;
}

/**
 * Ask every agent one stateless question (its system prompt, then buildPrompt's text) and parse
 * `<label>: <verdict>` from each answer. Answers come back in agent order.
 */
export async function runVerdictRound<A extends { systemPrompt: string }>(
  agents: readonly A[],
  buildPrompt: (agent: A, index: number) => string,
  label: string,
  options: VerdictRoundOptions<A>
): Promise<VerdictAnswer<A>[]> {
  return mapLimit([...agents], options.limit ?? PARALLEL_TURNS, async (agent, index) => {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: buildPrompt(agent, index) }];
    const call = <T>(fn: () => Promise<T>): Promise<T> => (options.scope ? metered(options.scope(agent, index), fn) : fn());
    try {
      let content = await call(() => callLLM(agent.systemPrompt, messages, options.llm));
      let verdict = parseVerdict(content, label, options.verdicts);
      let reasked = false;
      if (verdict === "UNCLEAR" && options.reask !== undefined) {
        const again = typeof options.reask === "function" ? options.reask(agent, index) : options.reask;
        content = await call(() => callLLM(agent.systemPrompt, [...messages, { role: "assistant", content }, { role: "user", content: again }], options.llm));
        verdict = parseVerdict(content, label, options.verdicts);
        reasked = true;
      }
      return { agent, index, content, verdict, reasked, at: new Date() };
    } catch (e) {
      if (!options.catchErrors) throw e;
      return { agent, index, content: "", verdict: "UNCLEAR", reasked: false, at: new Date(), error: e instanceof Error ? e.message : String(e) };
    }
  });
}
