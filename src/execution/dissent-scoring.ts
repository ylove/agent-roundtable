// The explicit, advisory scoring path shared by score_dissent and postmortem acceptance.
import { canonicalJSON } from "./chain.js";
import { orchestratorSource } from "./contract-state.js";
import { ID_RE } from "./events.js";
import type { BlackboardState, DissentRuntime, EventPayloads, ExecutionStore } from "./types.js";

export type DissentOutcome = EventPayloads["dissent.scored"]["outcome"];
export const DISSENT_OUTCOMES: readonly DissentOutcome[] = ["vindicated", "refuted", "untested"];

export interface DissentScoreInput {
  contractId: string;
  orchestrator: string;
  dissentId: string;
  outcome: DissentOutcome;
  /** A durable operation identity, for retries after a postmortem write but before record persistence. */
  operationKey?: string;
  /** Postmortems score only the prediction and predicate generation they reviewed. */
  reviewed?: Pick<DissentRuntime, "spec" | "generation">;
}

export function validateDissentScore(state: Readonly<BlackboardState>, i: DissentScoreInput): void {
  const c = state.contract;
  if (!c || c.id !== i.contractId || c.status !== "frozen") throw new Error("scoring requires a frozen contract");
  if (c.scope.orchestrator !== i.orchestrator) throw new Error("only the contract's orchestrator may score a dissent");
  if (typeof i.dissentId !== "string" || !ID_RE.test(i.dissentId) || !(c.dissents ?? []).some((d) => d.id === i.dissentId)) throw new Error("unknown dissent id");
  if (!DISSENT_OUTCOMES.includes(i.outcome)) throw new Error("outcome must be vindicated, refuted or untested");
}

export async function scoreDissent(store: ExecutionStore, i: DissentScoreInput): Promise<void> {
  await store.transact(async ({ state }) => {
    validateDissentScore(state, i);
    if (i.operationKey) {
      const previous = (await store.events({ types: ["dissent.scored"] })).find((e) => e.correlation === i.operationKey);
      if (previous?.type === "dissent.scored") {
        if (previous.payload.dissent_id !== i.dissentId || previous.payload.outcome !== i.outcome || previous.source.id !== i.orchestrator) throw new Error("scoring operation identity was reused with different inputs");
        return { events: [] };
      }
    }
    if (i.reviewed) {
      const current = state.contract!.dissents.find((d) => d.id === i.dissentId)!;
      const fingerprint = (d: DissentRuntime["spec"]) => d ? canonicalJSON({ by: d.by, claim: d.claim, predicted_failure: d.predicted_failure, tripwire: d.tripwire ?? null }) : undefined;
      if (fingerprint(current) !== fingerprint(i.reviewed.spec) || state.dissents[i.dissentId]?.generation !== i.reviewed.generation) {
        throw new Error(`stale dissent assessment for ${i.dissentId}: the prediction or tripwire changed since review; review it again`);
      }
    }
    if (!i.operationKey && state.dissents[i.dissentId]?.score === i.outcome) return { events: [] };
    return { events: [{ type: "dissent.scored", source: orchestratorSource(i.orchestrator),
      ...(i.operationKey && { correlation: i.operationKey }),
      payload: { dissent_id: i.dissentId, outcome: i.outcome } }] };
  });
}
