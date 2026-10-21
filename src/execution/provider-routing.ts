import { executionLLM as explicitExecutionLLM, type LLMProvider } from "../config.js";
import { routeProvider, type RoutingInputs } from "../providers/router.js";
import { prepareSeats } from "../table/seats.js";

/** Runtimes remain worker-driver choices; only API providers are eligible for persona calls. */
export function executionLLM(inputs: RoutingInputs = {}): { provider: LLMProvider; model: string; baseUrl?: string; unknown?: string; reason?: string } {
  const raw = process.env.ROUNDTABLE_EXECUTION_PROVIDER?.trim();
  if (raw && raw !== "auto") return explicitExecutionLLM();
  return routeProvider({ ...inputs, tier: "judge", model: process.env.ROUNDTABLE_EXECUTION_MODEL?.trim() || undefined });
}

/** The execute preflight and runner entry use the same candidate probes and judge tier. */
export async function prepareExecutionProvider(inputs: RoutingInputs = {}): Promise<ReturnType<typeof executionLLM>> {
  const raw = process.env.ROUNDTABLE_EXECUTION_PROVIDER?.trim();
  if (raw && raw !== "auto") return explicitExecutionLLM();
  const seats = await prepareSeats({ agents: ["execution"], routing: inputs, tier: "judge", model: process.env.ROUNDTABLE_EXECUTION_MODEL?.trim() || undefined,
    load: async () => ({ frontmatter: {} }) });
  const seat = seats.get("execution")!;
  return { provider: seat.provider as LLMProvider, model: seat.model, reason: seat.reason };
}
