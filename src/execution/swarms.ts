// Bounded worker fan-out. The caller appends task.spawned under the events lock.
import { findCycle, globWithin } from "./contract.js";
import { remainingUsd } from "./budget.js";
import { ID_RE } from "./events.js";
import { globsOverlap, leasesFor, normalizeLeasePaths, pathCovered } from "./leases.js";
import type { BlackboardState, TaskRuntime, TaskSpec } from "./types.js";

export const SUBTASK_TERMINAL = new Set(["accepted", "failed", "cancelled"]);

export interface SubtaskInput {
  id: string;
  title: string;
  instructions: string;
  paths: string[];
  depends_on?: string[];
}

/** Occupied workers, including external claims and workers still exiting after a merge. */
export function workerTasks(state: Readonly<BlackboardState>): Set<string> {
  return new Set([
    ...Object.keys(state.claims),
    ...Object.values(state.agents).filter((a) => a.status === "running" && a.task).map((a) => a.task!),
  ]);
}

export function batchChildren(state: Readonly<BlackboardState>, task: string): TaskRuntime[] {
  return (state.tasks[task]?.subtasks ?? []).map((id) => state.tasks[id]);
}

export function openSubtasks(state: Readonly<BlackboardState>, task: string): boolean {
  return batchChildren(state, task).some((rt) => !SUBTASK_TERMINAL.has(rt.state));
}

export function spawnSpecs(state: Readonly<BlackboardState>, task: string, agent: string, input: SubtaskInput[], checkCapacity = true): TaskSpec[] {
  if (state.status !== "running") throw new Error(`The run is ${state.status}; subtasks need a running execution`);
  const parent = state.tasks[task];
  const budget = state.contract?.budget;
  if (state.contract?.status !== "frozen" || (budget?.max_agents ?? 0) < 2) throw new Error("Swarms are not enabled: freeze a contract with budget.max_agents >= 2");
  if (parent?.spec.parent) throw new Error("A subtask cannot spawn subtasks: swarm depth is limited to 1");
  if (!parent || state.claims[task]?.agent !== agent || !["claimed", "in_progress"].includes(parent.state)) throw new Error(`Task ${task} must be claimed and in progress to spawn subtasks`);
  if (checkCapacity && workerTasks(state).size >= budget!.max_agents!) throw new Error("Cannot spawn subtasks: max_agents workers already run; at least one free worker slot is needed for a child");
  const children = batchChildren(state, task);
  if (openSubtasks(state, task)) throw new Error(`Task ${task} already has open subtasks`);
  if (children.some((rt) => rt.state === "accepted") && !parent.subtasks_joined) throw new Error(`Task ${task} must await_subtasks before spawning again`);
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new Error("spawn_subtasks needs 1–8 subtasks per call");
  const total = Object.values(state.tasks).filter((rt) => rt.spec.parent).length;
  if (total + input.length > (budget?.max_subtasks ?? 16)) throw new Error(`Spawning exceeds budget.max_subtasks (${budget?.max_subtasks ?? 16})`);
  if (remainingUsd(state, { task, agent }) < 0.01) throw new Error(`Task ${task} has no budget left for another worker`);
  if (remainingUsd(state) < budget!.per_task_usd) throw new Error("The remaining execution budget is below one worker's per-task budget");
  const ids = new Set<string>();
  for (const sub of input) {
    if (!sub || typeof sub.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(sub.id) || !ID_RE.test(`${task}.${sub.id}`)) throw new Error(`Not a subtask slug: ${JSON.stringify(sub?.id)}`);
    if (ids.has(sub.id) || Object.hasOwn(state.tasks, `${task}.${sub.id}`)) throw new Error(`Subtask ${task}.${sub.id} already exists`);
    ids.add(sub.id);
  }
  const leases = leasesFor(state, task, agent);
  const into = input.map((sub): TaskSpec => {
    if (typeof sub.title !== "string" || !sub.title.trim() || sub.title.length > 200) throw new Error(`Subtask ${sub.id} needs a title of at most 200 characters`);
    if (typeof sub.instructions !== "string" || !sub.instructions.trim() || sub.instructions.length > 4000) throw new Error(`Subtask ${sub.id} needs instructions of at most 4000 characters`);
    const paths = normalizeLeasePaths(sub.paths);
    for (const path of paths) {
      if (!leases.some((l) => l.paths.some((g) => globWithin(path, g))) || !pathCovered(path, leases)) throw new Error(`Subtask ${sub.id} path ${path} is outside the parent's leases`);
    }
    const deps = sub.depends_on ?? [];
    if (!Array.isArray(deps) || deps.some((d) => d === sub.id || !ids.has(d))) throw new Error(`Subtask ${sub.id} depends_on must name other siblings in this call`);
    return {
      id: `${task}.${sub.id}`, parent: task, title: sub.title, instructions: sub.instructions,
      persona: parent.spec.persona, kind: "build", ...(parent.spec.team && { team: parent.spec.team }),
      depends_on: [...new Set(deps)].map((d) => `${task}.${d}`),
      paths: { write: paths, ...(parent.spec.paths.read && { read: [...parent.spec.paths.read] }) },
      acceptance: [...parent.spec.acceptance], checks: [...parent.spec.checks],
      ...(parent.spec.effort && { effort: parent.spec.effort }),
    };
  });
  for (let i = 0; i < into.length; i++) {
    for (let j = 0; j < i; j++) {
      if (into[i].paths.write.some((p) => into[j].paths.write.some((q) => globsOverlap(p, q)))) throw new Error(`Subtask paths overlap: ${into[j].id} and ${into[i].id}`);
    }
  }
  const cycle = findCycle(into);
  if (cycle) throw new Error(`Subtask depends_on has a cycle: ${cycle.join(" → ")}`);
  return into;
}
