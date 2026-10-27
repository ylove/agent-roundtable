import { PROVIDER_IDS, type LLMProvider } from "../config.js";
import { callLLM, callLLMWithTools, supportsTools, type CallLLMOptions } from "../providers/index.js";
import { activeSeatConnectors } from "./seat-connectors.js";
import { activeAbortSignal, reportUsage } from "../providers/usage.js";
import { getRuntime } from "../runtimes/registry.js";
import { runRuntime } from "../runtimes/runner.js";
import { defaultModelFor, forgetFrontmatterModel, isFrontmatterModel, isUnknownModelError } from "./seats.js";
import { agentKey } from "../agents.js";

export interface SeatCallContext {
  agent: string;
  /** Persist the replacement so subsequent turns use the same model. */
  onModelFallback?: (model: string) => void;
}

/** The shared dispatch for every participant at the table with a seat assignment. */
export async function callSeat(system: string, messages: Parameters<typeof callLLM>[1], options: Omit<CallLLMOptions, "provider"> & { provider: string }, context?: SeatCallContext): Promise<string> {
  if ((PROVIDER_IDS as readonly string[]).includes(options.provider)) {
    const provider = options.provider as LLMProvider;
    // Connectors apply per table session; a seat whose provider cannot call tools says so once and speaks without them.
    const connectors = activeSeatConnectors(), seatName = context?.agent ?? "seat";
    if (connectors && !supportsTools(provider)) connectors.unavailable(seatName);
    const toolTurn = connectors && supportsTools(provider) ? connectors.turn(seatName) : undefined;
    const call = toolTurn
      ? async () => (await callLLMWithTools(`${system}\n\n${toolTurn.instruction}`, messages, { ...options, provider }, toolTurn.tools, toolTurn.run)).content
      : () => callLLM(system, messages, { ...options, provider });
    try { return await call(); }
    catch (error) {
      const fallback = defaultModelFor(provider);
      if (!context || !options.model || !isUnknownModelError(error) ||
          !isFrontmatterModel(context.agent, provider, options.model) || fallback === options.model) throw error;
      forgetFrontmatterModel(context.agent, provider, options.model);
      process.stderr.write(`persona ${agentKey(context.agent)}: model ${options.model} not available; using ${fallback}\n`);
      options.model = fallback;
      context.onModelFallback?.(fallback);
      return call();
    }
  }
  const spec = getRuntime(options.provider);
  if (!spec) throw new Error("Unknown seat runtime.");
  activeSeatConnectors()?.unavailable(context?.agent ?? "seat");
  const prompt = `${system}\n\n${messages.map(m => `${m.role}:\n${m.content}`).join("\n\n")}`;
  try {
    const result = await runRuntime(spec, prompt, { ...(options.model && { model: options.model }), signal: activeAbortSignal(), runtimeName: options.provider });
    reportUsage({ provider: options.provider, model: options.model || "default", usage: result.usage, tokensProvenance: "reported", usd: result.costUsd, chars: { input: prompt.length, output: result.text.length } });
    return result.text;
  } catch (error) {
    if (options.estimateUsageOnFailure) reportUsage({ provider: options.provider, model: options.model || "default", chars: { input: prompt.length, output: 0 } });
    throw error;
  }
}
