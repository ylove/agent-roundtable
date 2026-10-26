// ============================================================================
// Tool loop: let a model call tools during one turn, with hard caps
//
// Pure of provider details: the caller supplies `complete` (one metered provider request) and `runTool`.
// At most MAX_TOOL_CALLS calls run per turn, each under a timeout and with a capped result; once the
// budget is spent the model is told to answer in text. Provider-native turns are built by the provider.
// ============================================================================

import type { LLMCompletionResult, ToolCallRequest, ToolRound, ToolSpec } from "./shared.js";
import { scrubAndCap } from "../security/secrets.js";

export const MAX_TOOL_CALLS = 6;
export const TOOL_CALL_TIMEOUT_MS = 30_000;
export const MAX_TOOL_RESULT_BYTES = 8 * 1024;

export interface ToolLoopLimits { maxCalls?: number; callTimeoutMs?: number; maxResultBytes?: number }
export interface ToolOutcome { text: string; isError?: boolean }
export type RunTool = (name: string, input: unknown, signal: AbortSignal) => Promise<ToolOutcome | string>;
export type ToolResultTurns = (calls: ToolCallRequest[], results: ToolOutcome[]) => unknown[];

export interface ToolLoopResult extends LLMCompletionResult { toolCalls?: undefined; toolCallCount: number }

/** Keep at most `max` bytes of UTF-8, never splitting a character. */
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > max - 3) end--;
  return `${text.slice(0, end)}...`;
}

/** Provider-native tool-result turns for the assistant turn the model produced. */
export function toolResultTurns(provider: "anthropic" | "openai" | "ollama", calls: ToolCallRequest[], results: ToolOutcome[]): unknown[] {
  if (provider === "anthropic") {
    return [{ role: "user", content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: results[i].text, ...(results[i].isError && { is_error: true }) })) }];
  }
  if (provider === "ollama") return calls.map((c, i) => ({ role: "tool", tool_name: c.name, content: results[i].text }));
  return calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: results[i].text }));
}

export async function runToolLoop(
  complete: (round: ToolRound) => Promise<LLMCompletionResult>,
  tools: ToolSpec[],
  runTool: RunTool,
  resultTurns: ToolResultTurns,
  signal: AbortSignal | undefined,
  limits: ToolLoopLimits = {},
): Promise<ToolLoopResult> {
  const maxCalls = limits.maxCalls ?? MAX_TOOL_CALLS, timeout = limits.callTimeoutMs ?? TOOL_CALL_TIMEOUT_MS, maxBytes = limits.maxResultBytes ?? MAX_TOOL_RESULT_BYTES;
  const turns: unknown[] = [];
  const total: NonNullable<LLMCompletionResult["usage"]> = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false, used = 0;
  // One extra request after the budget is spent, with tool use forbidden; a model that still asks for tools fails.
  for (let request = 0; request <= maxCalls + 1; request++) {
    signal?.throwIfAborted();
    const result = await complete({ tools, turns, ...(used >= maxCalls && { forbid: true }) });
    if (result.usage) {
      sawUsage = true;
      total.inputTokens += result.usage.inputTokens;
      total.outputTokens += result.usage.outputTokens;
      for (const k of ["cacheReadTokens", "cacheWriteTokens"] as const) if (result.usage[k] !== undefined) total[k] = (total[k] ?? 0) + result.usage[k]!;
    }
    const calls = result.toolCalls ?? [];
    if (!calls.length) {
      const { toolCalls: _calls, assistantTurn: _turn, ...rest } = result;
      return { ...rest, usage: sawUsage ? total : undefined, toolCallCount: used };
    }
    if (used >= maxCalls) throw new Error("The model kept requesting tools after the tool budget was spent.");
    turns.push(result.assistantTurn);
    const outcomes: ToolOutcome[] = [];
    for (const call of calls) {
      if (used >= maxCalls) { outcomes.push({ text: "Tool call limit reached for this turn; answer without further tools.", isError: true }); continue; }
      used++;
      outcomes.push(await runOne(call, runTool, timeout, maxBytes, signal));
    }
    turns.push(...resultTurns(calls, outcomes));
  }
  throw new Error("The tool loop did not finish.");
}

async function runOne(call: ToolCallRequest, runTool: RunTool, timeoutMs: number, maxBytes: number, stop: AbortSignal | undefined): Promise<ToolOutcome> {
  // A ref'd timer: a hung tool must still reach its timeout rather than let the process drain and exit.
  const limit = new AbortController();
  const handle = setTimeout(() => limit.abort(), timeoutMs);
  const timer = limit.signal;
  const signal = stop ? AbortSignal.any([stop, timer]) : timer;
  try {
    stop?.throwIfAborted();
    if (call.input === null || typeof call.input !== "object" || Array.isArray(call.input)) return { text: "Tool arguments were not a JSON object.", isError: true };
    const raw = await new Promise<ToolOutcome | string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      runTool(call.name, call.input, signal).then(resolve, reject);
    });
    const outcome = typeof raw === "string" ? { text: raw } : raw;
    return { ...outcome, text: capBytes(outcome.text, maxBytes) };
  } catch (error) {
    // A person stopping the session ends the whole turn; any other failure goes back to the model.
    if (stop?.aborted) throw error;
    const reason = timer.aborted ? "timed out" : "failed";
    return { text: capBytes(`Tool ${reason}: ${scrubAndCap(error instanceof Error ? error.message : "error", 200)}`, maxBytes), isError: true };
  } finally {
    clearTimeout(handle);
  }
}
