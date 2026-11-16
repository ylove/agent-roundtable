import { budgetEstimate } from "../providers/router.js";

export interface SessionCostCall {
  /** Optional seat identity, so seats sharing a model can be reported separately. */
  seat?: string;
  provider: string;
  /** A per-call endpoint (base_url). It never receives the operator's free price, and is not echoed in lines. */
  baseUrl?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionCostLine extends Omit<SessionCostCall, "baseUrl"> {
  calls: number;
  usd: number;
  estimated: boolean;
}

export interface SessionCostEstimate {
  usd: number;
  calls: number;
  perSeat: SessionCostLine[];
  estimated: boolean;
}

/** Price bounded calls with the router's conservative allowance for unknown prices. */
export function estimateSessionCost({ calls }: { calls: SessionCostCall[] }): SessionCostEstimate {
  const lines = new Map<string, SessionCostLine>();
  for (const call of calls) {
    if (![call.inputTokens, call.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error("Session cost token bounds must be nonnegative integers.");
    }
    const { baseUrl, ...identity } = call;
    const key = JSON.stringify([call.seat, call.provider, call.model]);
    const line = lines.get(key) ?? { ...identity, inputTokens: 0, outputTokens: 0, calls: 0, usd: 0, estimated: false };
    const cost = budgetEstimate(call.provider, call.model, call, undefined, { baseUrl });
    line.calls++;
    line.inputTokens += call.inputTokens;
    line.outputTokens += call.outputTokens;
    line.usd += cost.usd;
    line.estimated ||= cost.estimated;
    lines.set(key, line);
  }
  const perSeat = [...lines.values()].map(line => ({ ...line, usd: Math.round(line.usd * 1e9) / 1e9 }));
  return {
    usd: Math.round(perSeat.reduce((total, line) => total + line.usd, 0) * 1e9) / 1e9,
    calls: calls.length,
    perSeat,
    estimated: perSeat.some(line => line.estimated),
  };
}
