import type { BlackboardState, TaskRuntime } from "./types.js";

/** Each escalation owns its own blocking reason; the singular field reads older snapshots/logs. */
export function blockingIds(rt: TaskRuntime | undefined): string[] {
  return [...new Set([...(rt?.blocked_by?.escalations ?? []), ...(rt?.blocked_by?.escalation ? [rt.blocked_by.escalation] : [])])];
}

export function taskHeld(state: Readonly<BlackboardState>, task: string | undefined, dissentOnly = false): boolean {
  if (task === undefined || !Object.hasOwn(state.tasks, task)) return false;
  return blockingIds(state.tasks[task]).some((id) => {
    const e = Object.hasOwn(state.escalations, id) ? state.escalations[id] : undefined;
    return e?.blocking && (!dissentOnly || e.dissent_id !== undefined) && e.status !== "resolved" && e.status !== "withdrawn";
  });
}

export function tripwireKey(id: string, task?: string, generation?: number): string {
  return `tripwire:${id}:${task ?? ""}${generation === undefined ? "" : `@${generation}`}`;
}
