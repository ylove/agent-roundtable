import { PROVIDER_IDS, type LLMProvider } from "../config.js";
import { callLLM, type CallLLMOptions } from "../providers/index.js";
import { activeAbortSignal, reportUsage } from "../providers/usage.js";
import { getRuntime } from "../runtimes/registry.js";
import { runRuntime } from "../runtimes/runner.js";

/** The shared dispatch for every participant at the table with a seat assignment. */
export async function callSeat(system: string, messages: Parameters<typeof callLLM>[1], options: Omit<CallLLMOptions, "provider"> & { provider: string }): Promise<string> {
  if ((PROVIDER_IDS as readonly string[]).includes(options.provider)) return callLLM(system, messages, { ...options, provider: options.provider as LLMProvider });
  const spec = getRuntime(options.provider);
  if (!spec) throw new Error("Unknown seat runtime.");
  const prompt = `${system}\n\n${messages.map(m => `${m.role}:\n${m.content}`).join("\n\n")}`;
  try {
    const result = await runRuntime(spec, prompt, { ...(options.model && { model: options.model }), signal: activeAbortSignal() });
    reportUsage({ provider: options.provider, model: options.model || "default", usage: result.usage, tokensProvenance: "reported", usd: result.costUsd, chars: { input: prompt.length, output: result.text.length } });
    return result.text;
  } catch (error) {
    if (options.estimateUsageOnFailure) reportUsage({ provider: options.provider, model: options.model || "default", chars: { input: prompt.length, output: 0 } });
    throw error;
  }
}
