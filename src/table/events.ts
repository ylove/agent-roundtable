import { PROVIDER_IDS, type LLMProvider as Provider } from "../config.js";

/** A participant and the model used for their turns at the table. */
export interface Seat {
  id: string;
  name: string;
  role?: string;
  team?: "A" | "B" | "judge";
  provider: Provider;
  model: string;
}

/** Events shared by duel runners, terminal renderers, and local web rooms. */
export type TableEvent =
  /** A duel begins; startedAt is an ISO 8601 timestamp. */
  | {
      type: "start";
      id: string;
      topic: string;
      mode: "duel";
      seats: Seat[];
      startedAt: string;
    }
  /** A participant speaks; ts is an ISO 8601 timestamp. */
  | { type: "turn"; round: string; seat: Seat; text: string; ts: string }
  /** A team submits prototype files or reports a failed attempt. */
  | {
      type: "prototype";
      team: "A" | "B";
      seat: Seat;
      title?: string;
      files: { path: string; bytes: number }[];
      ok: boolean;
      error?: string;
    }
  /** A judge assesses a team's submission. */
  | {
      type: "assessment";
      judge: Seat;
      team: "A" | "B";
      verdict: "APPROVE" | "REVISE" | "REJECT" | "UNCLEAR";
      reason: string;
    }
  /** A participant records a dissent, optionally concerning a team. */
  | { type: "dissent"; seat: Seat; text: string; team?: "A" | "B" }
  /** Token usage and cost totals for the duel. */
  | {
      type: "usage";
      perSeat: {
        seatId: string;
        inputTokens: number;
        outputTokens: number;
        /** Cost of the priced calls only; a model with no known price adds nothing here. */
        costUsd: number;
        /** Tokens from calls with no known price: shown as tokens with "no price", never as $0.00. */
        unpricedTokens?: number;
        /** True when any of the seat's token counts were estimated rather than reported by the provider. */
        estimated?: boolean;
      }[];
      totalCostUsd: number;
      totalUnpricedTokens?: number;
    }
  /** The final outcome, including an optional archive location. */
  | {
      type: "end";
      winner: "A" | "B" | "tie" | "none";
      tally: { A: number; B: number };
      aborted?: boolean;
      archivePath?: string;
    };

/** A consumer of table events; asynchronous consumers may finish before the next event. */
export interface TableObserver {
  onEvent(e: TableEvent): void | Promise<void>;
}

/** Deliver to every observer and await completion, swallowing each observer's errors. */
export function fanout(...observers: TableObserver[]): TableObserver {
  return {
    async onEvent(e) {
      await Promise.all(observers.map(async (observer) => {
        try {
          await observer.onEvent(e);
        } catch {
          // A failed renderer must not interrupt other consumers or the duel.
        }
      }));
    },
  };
}

/** An agent reference with optional provider and model overrides. */
export interface SeatSpec {
  agent: string;
  provider?: Provider;
  model?: string;
}

/** Parse agent, agent=provider, or agent=provider:model, preserving model colons and slashes. */
export function parseSeat(s: string): SeatSpec {
  const equals = s.indexOf("=");
  const agent = (equals === -1 ? s : s.slice(0, equals)).trim();
  if (!agent) throw new Error("Seat agent must not be empty.");
  if (equals === -1) return { agent };

  const override = s.slice(equals + 1);
  const colon = override.indexOf(":");
  const provider = (colon === -1 ? override : override.slice(0, colon)).trim() as Provider;
  if (!PROVIDER_IDS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Valid providers: ${PROVIDER_IDS.join(", ")}`);
  }
  if (colon === -1) return { agent, provider };

  const model = override.slice(colon + 1).trim();
  if (!model) throw new Error("Seat model must not be empty after ':'.");
  return { agent, provider, model };
}

/** Inputs for a two-team duel, with optional seat overrides and execution limits. */
export interface DuelOptions {
  topic: string;
  teamA: string[];
  teamB: string[];
  judges: string[];
  rounds?: 1 | 2;
  turnTimeoutMs?: number;
  maxSeconds?: number;
  seats?: Record<string, SeatSpec>;
  mix?: "auto" | "cheap";
  agentsDir?: string;
}

/** The outcome returned after a duel finishes or is aborted. */
export interface DuelResult {
  id: string;
  winner: "A" | "B" | "tie" | "none";
  tally: { A: number; B: number };
  archivePath?: string;
  aborted: boolean;
}

/** A cancellable duel runner that streams its progress to an observer. */
export type RunDuel = (opts: DuelOptions, obs: TableObserver, signal: AbortSignal) => Promise<DuelResult>;
