// ============================================================================
// Stopping a heads-down agent (usage-visibility.md §6)
//
// A stop is a request with a durable record, applied by the process that owns the agent, then acted
// on by the orchestrator:
//   1. any surface (the dashboard, the CLI, the control_execution and usage tools) appends
//      agent.stop_requested {agent, by, surface, reason?} through store.transact. A plain refusal for
//      an unknown agent, a finished run, an agent with no live process, or an external agent (which
//      is told to stop through its inbox instead);
//   2. the runner applies it on its next tick, before scheduling, as it stops a superseded worker;
//   3. the worker's agent.exited carries reason "stopped"; the runner then records agent.stopped and,
//      for an agent that held a task, raises a blocking escalation to the orchestrator (the task is
//      not retried automatically, and its WIP branch and worktree are kept).
// Every stop is audited with its surface, agent, scope and `by`.
// ============================================================================

import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { orchestratorSource } from "../execution/contract-state.js";
import type { BlackboardState, EventSource, ExecutionStore } from "../execution/types.js";

export type StopSurface = "dashboard" | "cli" | "tool";

/** A stop that cannot be requested; the message is for a person. */
export class StopRefusal extends Error {}

export interface StopOptions {
  agent: string;
  /** Who asked, in words ("the human (dashboard)"). */
  by: string;
  surface: StopSurface;
  reason?: string;
}

export interface StopRequested {
  execution: string;
  agent: string;
  task?: string;
  /** The id of the agent.stop_requested event: what agent.stopped names. */
  request: string;
  seq: number;
  /** A request for this agent was already waiting; nothing new was recorded. */
  already?: true;
  warnings: string[];
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const own = <V>(map: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);
const clean = (s: string, max: number): string => scrub(s).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** How a stop's `by` reads for each surface. */
export function stopper(surface: StopSurface, orchestrator?: string): string {
  return surface === "dashboard" ? "the human (dashboard)" : surface === "cli" ? "the human (command line)" : `${orchestrator ?? "the orchestrator"} (for the human)`;
}

function sourceFor(o: StopOptions, orchestrator: string): EventSource {
  return o.surface === "tool" ? orchestratorSource(orchestrator) : { kind: "human", id: "human", pid: process.pid };
}

/** The refusal for `agent`, or null when it can be stopped. */
export function stopRefusal(state: Readonly<BlackboardState>, agent: string): string | null {
  const rec = own(state.agents, agent);
  if (!rec) {
    const known = Object.keys(state.agents).slice(0, 12).join(", ");
    return `There is no agent ${JSON.stringify(clean(agent, 64))} in this run${known ? ` (agents: ${known})` : ""}.`;
  }
  if (TERMINAL.has(state.status)) return `The run has ${state.status}: there is nothing left to stop.`;
  if (rec.external) {
    return `${agent} is an external worker: the roundtable does not run its process, so it cannot stop it. ` +
      `Tell it to stop through its inbox instead: control_execution(action: "steer", targets: ["${agent}"], message: "…") sends a directive it must acknowledge.`;
  }
  if (rec.status !== "running" || rec.pid === undefined) return `${agent} has no live process (it is ${rec.status}), so there is nothing to stop.`;
  return null;
}

/**
 * Record a stop request for a live, runner-managed agent. Idempotent: a request already waiting is
 * returned as it is. Throws StopRefusal (with a plain message) when the agent cannot be stopped.
 */
export async function requestAgentStop(store: ExecutionStore, o: StopOptions): Promise<StopRequested> {
  const orchestrator = (await store.state()).contract?.scope.orchestrator ?? "orchestrator";
  const reason = o.reason?.trim() ? clean(o.reason, 500) : undefined;
  const r = await store.transact<{ already: boolean; request?: string; task?: string; seq?: number }>(({ state }) => {
    const refusal = stopRefusal(state, o.agent);
    if (refusal) throw new StopRefusal(refusal);
    const rec = state.agents[o.agent];
    if (rec.stop?.state === "requested") return { events: [], result: { already: true, request: rec.stop.request, seq: rec.stop.seq, task: rec.task } };
    return {
      events: [{ type: "agent.stop_requested", source: sourceFor(o, orchestrator), payload: { agent: o.agent, by: clean(o.by, 100), surface: o.surface, ...(reason && { reason }) } }],
      result: { already: false, task: rec.task },
    };
  });
  const warnings: string[] = [];
  const ev = r.events[0];
  const request = r.result?.already ? r.result.request! : ev.id;
  if (!r.result?.already) {
    try {
      await appendAudit({
        actor: clean(o.by, 100),
        action: "agent.stop_requested",
        target: store.id,
        details: { surface: o.surface, agent: o.agent, scope: store.id, ...(reason && { reason }) },
      });
    } catch (e) {
      warnings.push(`the audit entry could not be written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    execution: store.id,
    agent: o.agent,
    ...(r.result?.task !== undefined && { task: r.result.task }),
    request,
    seq: r.result?.already ? r.result.seq! : ev.seq,
    ...(r.result?.already && { already: true as const }),
    warnings,
  };
}
