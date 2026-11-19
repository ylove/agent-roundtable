import type { RunnerLiveness } from "../execution/runner-launch.js";
import type { BlackboardState, Contract } from "../execution/types.js";

/** Both a status report and a store projection can use this without reading or starting a runner. */
export interface DisplayStateInput {
  status: BlackboardState["status"];
  // Status reports contain only frozen contract summaries. Projections also carry lifecycle fields.
  contract?: { status?: Contract["status"]; frozen?: Contract["frozen"] } | { id: string; version: number; title: string };
}

export interface DisplayState {
  kind: "running" | "interrupted" | "draft" | "completed" | "failed" | "aborted" | "paused";
  label: string;
  detail: string;
}

/** Stored outcomes take precedence. A running/created record alone never proves a live runner. */
export function displayState(report: DisplayStateInput, liveness?: RunnerLiveness): DisplayState {
  switch (report.status) {
    case "completed": return { kind: "completed", label: "Completed", detail: "The run finished." };
    case "failed": return { kind: "failed", label: "Failed", detail: "The run ended with a failure." };
    case "aborted": return { kind: "aborted", label: "Aborted", detail: "The run was stopped before completion." };
    case "paused": return { kind: "paused", label: "Paused", detail: "The run is paused." };
  }
  const contract = report.contract;
  if (!contract || ("status" in contract && contract.status !== undefined && contract.status !== "frozen" && !contract.frozen)) {
    return { kind: "draft", label: "Draft", detail: "No frozen contract yet. This run has not started." };
  }
  if (liveness?.state === "running") {
    return { kind: "running", label: liveness.stale ? "Running, no heartbeat" : "Running",
      detail: liveness.stale ? "The runner is alive, but its heartbeat is stale." : "The runner is alive." };
  }
  return { kind: "interrupted", label: "Interrupted", detail: "The runner is not running." };
}
