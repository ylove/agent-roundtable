// ============================================================================
// Stopping one agent from the CLI or the usage tool: find it, then ask its owner (usage-visibility.md §6)
//
// An agent name can be in more than one place (a persona may sit at the table and work in a run), so a
// stop names its scope when the name is ambiguous. Heads-down, the request is an event the runner
// acts on; at the table, it is a file the owning orchestrator server picks up within a second (or,
// when the usage tool runs in that very server, a direct stop).
// ============================================================================

import { openExecutionStore } from "../execution/store.js";
import { appendAudit } from "../security/audit.js";
import { scrub } from "../security/secrets.js";
import { collectUsage } from "./model.js";
import { requestAgentStop, StopRefusal, stopper, type StopSurface } from "./stop.js";
import { readLiveServers, writeStopRequest } from "./table.js";
import type { UsageAgent, UsageView } from "./types.js";

export interface StopScope {
  execution?: string;
  session?: string;
}

export type StopTarget =
  | { where: "heads-down"; agent: string; execution: string }
  | { where: "at-the-table"; agent: string; session: string };

const place = (a: UsageAgent): string => (a.where === "heads-down" ? `--execution ${a.scope}` : `--session ${a.scope}`);

/** The one running agent a stop means, or a StopRefusal saying what to do instead. */
export function resolveStopTarget(view: UsageView, agent: string, scope: StopScope = {}): StopTarget {
  const named = view.agents.filter(
    (a) => a.where !== "host" && !a.label && a.id === agent && (!scope.execution || a.scope === scope.execution) && (!scope.session || a.scope === scope.session)
  );
  if (!named.length) {
    const running = view.agents.filter((a) => a.stoppable).map((a) => a.id);
    throw new StopRefusal(
      `No agent named ${JSON.stringify(scrub(agent).slice(0, 64))}${scope.execution || scope.session ? " in that scope" : ""} is known.` +
        (running.length ? ` Agents that can be stopped: ${[...new Set(running)].slice(0, 12).join(", ")}.` : " Nothing is running that can be stopped right now.")
    );
  }
  const stoppable = named.filter((a) => a.stoppable);
  if (!stoppable.length) {
    const a = named[0];
    throw new StopRefusal(
      a.provider === "external"
        ? `${agent} is an external worker: the roundtable does not run its process, so it cannot stop it. Tell it to stop through its inbox: control_execution(action: "steer", targets: ["${agent}"], message: "…").`
        : a.stopping
          ? `A stop for ${agent} is already on its way.`
          : `${agent} is not running right now (it is ${a.state}), so there is nothing to stop.`
    );
  }
  if (stoppable.length > 1) {
    throw new StopRefusal(`${agent} is running in more than one place; say which: ${stoppable.map(place).join(" or ")}.`);
  }
  const a = stoppable[0];
  return a.where === "heads-down" ? { where: "heads-down", agent: a.id, execution: a.scope } : { where: "at-the-table", agent: a.id, session: a.scope };
}

export interface StopOutcome {
  status: "requested" | "stopped";
  where: StopTarget["where"];
  agent: string;
  /** The run or the session. */
  scope: string;
  task?: string;
  /** A request for this agent was already waiting. */
  already?: true;
  runner?: string;
  warnings: string[];
  /** One sentence for a person: what happens now. */
  message: string;
}

export interface StopCallOptions {
  surface: StopSurface;
  by?: string;
  reason?: string;
  /** Make sure a runner is there to apply a heads-down stop (default: ensureRunner; tests and the tools pass their own). */
  ensureRunner?: (execution: string) => Promise<{ status: string }>;
}

/** Ask for the stop of a resolved target. */
export async function performStop(target: StopTarget, o: StopCallOptions): Promise<StopOutcome> {
  const by = o.by ?? stopper(o.surface);
  const warnings: string[] = [];
  if (target.where === "heads-down") {
    const store = await openExecutionStore(target.execution);
    const r = await requestAgentStop(store, { agent: target.agent, by, surface: o.surface, ...(o.reason && { reason: o.reason }) });
    warnings.push(...r.warnings);
    let runner: string | undefined;
    try {
      const ensure = o.ensureRunner ?? (await import("../execution/runner-launch.js")).ensureRunner;
      runner = (await ensure(target.execution)).status;
    } catch (e) {
      warnings.push(`the runner could not be checked: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      status: "requested",
      where: "heads-down",
      agent: target.agent,
      scope: target.execution,
      ...(r.task !== undefined && { task: r.task }),
      ...(r.already && { already: true as const }),
      ...(runner && { runner }),
      warnings,
      message: r.already
        ? `A stop for ${target.agent} is already waiting; the runner applies it on its next tick.`
        : `Stop requested for ${target.agent}. The runner stops it on its next tick (a second or two), keeps its work, and asks the orchestrator to rework around it or write a handoff.`,
    };
  }

  // At the table. The usage tool runs inside the server that may own the session: stop it directly.
  if (o.surface === "tool") {
    const { findSession, stopSession } = await import("./table-service.js");
    if (findSession(target.session)) {
      await appendAudit({ actor: by, action: "agent.stop_requested", target: target.session, details: { surface: o.surface, agent: target.agent, scope: target.session, ...(o.reason && { reason: o.reason }) } }).catch((e) =>
        warnings.push(`the audit entry could not be written: ${e instanceof Error ? e.message : String(e)}`)
      );
      const r = await stopSession({ session: target.session, by, surface: o.surface, agent: target.agent, ...(o.reason && { reason: o.reason }) });
      return {
        status: "stopped",
        where: "at-the-table",
        agent: target.agent,
        scope: target.session,
        warnings,
        message: r.status === "stopped" ? `${target.agent}'s session ${target.session} was stopped and ended.` : `Session ${target.session} had already ended.`,
      };
    }
  }
  const owner = readLiveServers().find((s) => s.sessions.some((x) => x.id === target.session));
  if (!owner) throw new StopRefusal(`The orchestrator server that ran session ${target.session} is no longer there, so there is nothing to stop.`);
  writeStopRequest(owner.server, { session: target.session, agent: target.agent, by, surface: o.surface, ...(o.reason && { reason: o.reason }) });
  await appendAudit({ actor: by, action: "agent.stop_requested", target: target.session, details: { surface: o.surface, agent: target.agent, scope: target.session, ...(o.reason && { reason: o.reason }) } }).catch((e) =>
    warnings.push(`the audit entry could not be written: ${e instanceof Error ? e.message : String(e)}`)
  );
  return {
    status: "requested",
    where: "at-the-table",
    agent: target.agent,
    scope: target.session,
    warnings,
    message: `Stop requested for ${target.agent} (session ${target.session}). Its server aborts the turn in flight and ends the session within a second or two.`,
  };
}

/** Find the agent among everything running, then stop it. */
export async function stopAgent(agent: string, scope: StopScope, o: StopCallOptions): Promise<StopOutcome> {
  const view = await collectUsage({ table: true });
  return performStop(resolveStopTarget(view, agent, scope), o);
}

export { StopRefusal };
