// ============================================================================
// Deadlock detection: cycles in the wait-for graph between unfinished tasks
//
// Edges (from → to means "from cannot finish until to does"):
//  - depends_on: a task's contract dependency that is not accepted yet;
//  - blocked_on: a blocked task's blocked_by.deps (task ids, or interface names → their owner);
//  - lease:      a queued lease request → the task holding each lease in its blocking set;
//  - need:       an open dependency.requested → the target task, or the interface's owner.
// Strongly connected components are found with Tarjan's algorithm over sorted nodes and edges,
// so the same blackboard always yields the same cycles in the same order.
// ============================================================================

import type { BlackboardState, EventPayloads } from "./types.js";
import { TERMINAL_TASK_STATES, draft, escalationAction, own, sortedKeys, type WatchdogAction } from "./watchdog-actions.js";

export type DependencyNeed = Pick<EventPayloads["dependency.requested"], "task" | "need">;

export interface WaitEdge {
  from: string;
  to: string;
  via: "depends_on" | "blocked_on" | "lease" | "need";
  /** The lease id, interface name or task id behind the edge. */
  ref: string;
}

/** A published interface or artifact satisfies a need; otherwise the edge goes to its owner. */
function interfaceOwner(state: BlackboardState, name: string): string | undefined {
  const i = own(state.interfaces, name);
  if (i && i.version >= 1) return undefined;
  return i?.spec?.owner ?? state.contract?.interfaces.find((x) => x.name === name)?.owner;
}

export function waitForGraph(state: BlackboardState, needs: readonly DependencyNeed[] = []): WaitEdge[] {
  const edges: WaitEdge[] = [];
  const waiting = (t: string): boolean => {
    const rt = own(state.tasks, t);
    return rt !== undefined && !TERMINAL_TASK_STATES.has(rt.state);
  };
  const add = (from: string, to: string | undefined, via: WaitEdge["via"], ref: string) => {
    if (to === undefined || to === from || own(state.tasks, to) === undefined) return;
    if (own(state.tasks, to)!.state === "accepted") return;
    edges.push({ from, to, via, ref });
  };
  const taskOrOwner = (from: string, ref: string, via: WaitEdge["via"]) => {
    if (own(state.tasks, ref)) add(from, ref, via, ref);
    else add(from, interfaceOwner(state, ref), via, ref);
  };

  for (const t of sortedKeys(state.tasks)) {
    if (!waiting(t)) continue;
    const rt = state.tasks[t];
    for (const d of rt.spec.depends_on) add(t, d, "depends_on", d);
    if (rt.state === "blocked") for (const d of rt.blocked_by?.deps ?? []) taskOrOwner(t, d, "blocked_on");
  }
  for (const req of state.lease_queue) {
    if (!waiting(req.task)) continue;
    for (const id of req.blocking) add(req.task, own(state.leases, id)?.task, "lease", id);
  }
  for (const n of needs) {
    if (!waiting(n.task)) continue;
    if (n.need.kind === "task") add(n.task, n.need.ref, "need", n.need.ref);
    else add(n.task, interfaceOwner(state, n.need.ref), "need", n.need.ref);
  }
  return edges;
}

/** Tarjan's strongly connected components; nodes and successors are visited in sorted order. */
export function stronglyConnected(adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  const nodes = [...new Set([...adjacency.keys(), ...[...adjacency.values()].flat()])].sort();
  const succ = (v: string) => [...new Set(adjacency.get(v) ?? [])].sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;

  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of succ(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return out;
}

/** The shortest cycle through the component's smallest node (BFS over sorted successors). */
function cycleThrough(comp: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): string[] {
  const inComp = new Set(comp);
  const start = comp[0];
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of [...new Set(adjacency.get(v) ?? [])].sort()) {
      if (!inComp.has(w)) continue;
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(prev.get(path[0])!);
        return path;
      }
      if (!seen.has(w)) {
        seen.add(w);
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [...comp];
}

export interface Deadlock {
  /** Tasks in cycle order, starting at the smallest id; each waits on the next, the last on the first. */
  cycle: string[];
  /** Every task in the strongly connected component (sorted). */
  members: string[];
  edges: WaitEdge[];
}

export function findDeadlocks(state: BlackboardState, needs: readonly DependencyNeed[] = []): Deadlock[] {
  const edges = waitForGraph(state, needs);
  const adjacency = new Map<string, string[]>();
  for (const e of edges) (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
  return stronglyConnected(adjacency)
    .filter((comp) => comp.length > 1)
    .map((members) => {
      const cycle = cycleThrough(members, adjacency);
      const inCycle = new Set(cycle);
      return {
        cycle,
        members,
        edges: edges.filter((e) => inCycle.has(e.from) && inCycle.has(e.to) && cycle[(cycle.indexOf(e.from) + 1) % cycle.length] === e.to),
      };
    })
    .sort((a, b) => a.cycle.join("\0").localeCompare(b.cycle.join("\0")));
}

const cycleKey = (cycle: readonly string[]): string => [...cycle].sort().join(",");

function describeEdge(e: WaitEdge): string {
  switch (e.via) {
    case "depends_on":
      return `${e.from} depends on ${e.to}`;
    case "blocked_on":
      return `${e.from} is blocked on ${e.ref === e.to ? e.to : `${e.ref} (owned by ${e.to})`}`;
    case "lease":
      return `${e.from} waits for lease ${e.ref} held by ${e.to}`;
    case "need":
      return `${e.from} needs ${e.ref === e.to ? e.to : `${e.ref} from ${e.to}`}`;
  }
}

/**
 * watchdog.deadlock_detected {cycle} plus a blocker escalation to the contract's orchestrator,
 * once per distinct cycle (by its set of tasks: a cycle already in watchdog.deadlocks, or already
 * escalated, is not reported again).
 */
export function deadlockRules(state: BlackboardState, needs: readonly DependencyNeed[] = []): WatchdogAction[] {
  const seen = new Set(state.watchdog.deadlocks.map(cycleKey));
  const out: WatchdogAction[] = [];
  for (const d of findDeadlocks(state, needs)) {
    const key = cycleKey(d.cycle);
    if (seen.has(key)) continue;
    seen.add(key);
    const chain = d.cycle.map((from, i) => {
      const to = d.cycle[(i + 1) % d.cycle.length];
      const e = d.edges.find((x) => x.from === from && x.to === to);
      return e ? describeEdge(e) : `${from} waits on ${to}`;
    });
    const extra = d.members.length > d.cycle.length ? ` The stuck group also includes ${d.members.filter((m) => !d.cycle.includes(m)).join(", ")}.` : "";
    const esc = escalationAction(state, "deadlock", {
      key: `deadlock:${key}`,
      task: d.cycle[0],
      kind: "blocker",
      with: "orchestrator",
      target: state.contract?.scope.orchestrator,
      summary: `Deadlock between ${d.cycle.join(", ")}: ${chain.join("; ")}.${extra}`,
      options: ["Revoke a lease", "Reorder or split a task", "Amend the interface ownership"],
      diagnostics: { notes: chain.join("\n") },
      before: [draft("watchdog.deadlock_detected", { cycle: [...d.cycle] })],
    });
    if (esc) out.push(esc);
  }
  return out;
}
