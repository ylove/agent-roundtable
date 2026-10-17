// ============================================================================
// Automatic findings: what the runner records when testing sends work back (§4)
//
// In a heads-down run whose contract has postmortem mode on, one finding is appended when
//   - a task's submission is sent back after testing (task.rejected following a task.submitted,
//     with failed or timed-out task checks, or lease violations), or
//   - a check fails at integration scope after a merge.
// The summary is generated from the event (check ids, how many paths, the task), never from command
// output; the evidence is the event id and the output blob refs. A failure with the same signature
// for the same task gets the same finding id, so a repeat adds to `repeats` instead of a new
// finding. Each finding names the event that caused it (causation), so scanning the log again,
// after a restart, adds nothing. Fix transitions are the reducer's (postmortem-state.ts).
// ============================================================================

import { createHash } from "node:crypto";
import { agentKey } from "../agents.js";
import type { AnyEvent, AnyEventDraft, BlackboardState, EventSource, PostmortemCategory } from "../execution/types.js";

const MAX_BLOBS = 5;

const own = <V>(map: Record<string, V> | undefined, key: string | undefined): V | undefined =>
  map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

/** A stable finding id for a failure: the same task, check ids and signatures give the same id. */
function findingId(basis: string): string {
  return `pmf-${createHash("sha256").update(basis).digest("hex").slice(0, 12)}`;
}

interface Failure {
  command: string;
  signature?: string;
  timedOut: boolean;
  blob?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The findings the log's events call for, as drafts. `fromSeq`: events at or below it were scanned
 * before (the lookups still use them). Events whose id is already the causation of a finding are
 * skipped, so this is safe to run again over the same log.
 */
export function autoFindings(log: readonly AnyEvent[], state: Readonly<BlackboardState>, fromSeq: number, source: EventSource): AnyEventDraft[] {
  if (state.contract?.postmortem?.enabled !== true) return [];
  const caused = new Set<string>();
  for (const e of log) if (e.type === "postmortem.finding_recorded" && e.causation !== undefined) caused.add(e.causation);

  const out: AnyEventDraft[] = [];
  // finding id → how often it repeated, and whether it is still open (no meeting yet, fix pending).
  const known = new Map<string, { repeats: number; open: boolean }>();
  for (const [id, f] of Object.entries(state.postmortem?.findings ?? {})) known.set(id, { repeats: f.repeats ?? 0, open: f.pm === undefined && f.fix.status === "pending" });
  const submitted = new Set<string>();
  const failures = new Map<string, Failure[]>();
  let lastMerged: string | undefined;

  /**
   * A failure repeats the open finding of the same basis. When that finding is already settled or covered by a
   * meeting, the failure is new: a later epoch of the basis starts a finding of its own (reopening the question).
   */
  const emit = (e: AnyEvent, basis: string, f: { summary: string; detected_by: string; responsible: string[]; task?: string; category: PostmortemCategory; evidence: string[] }) => {
    let id = findingId(basis);
    for (let epoch = 1; known.get(id)?.open === false; epoch++) id = findingId(`${basis}|epoch ${epoch}`);
    const prior = known.get(id);
    const repeats = prior === undefined ? undefined : prior.repeats + 1;
    known.set(id, { repeats: repeats ?? 0, open: true });
    out.push({
      type: "postmortem.finding_recorded",
      source,
      causation: e.id,
      payload: {
        id, summary: f.summary, detected_by: f.detected_by, responsible: f.responsible, category: f.category,
        ...(f.task !== undefined && { task: f.task }), evidence: f.evidence,
        ...(repeats !== undefined && { repeats }),
      },
    });
  };
  const personaOf = (task: string | undefined): string => {
    const persona = own(state.tasks, task)?.spec.persona;
    return persona !== undefined ? agentKey(persona) : "orchestrator";
  };

  for (const e of log) {
    switch (e.type) {
      case "task.submitted":
        submitted.add(e.payload.task);
        failures.delete(e.payload.task);
        break;
      case "task.merged":
        lastMerged = e.payload.task;
        break;
      case "check.failed":
      case "check.timed_out": {
        const p = e.payload;
        if (p.scope === "task" && p.task !== undefined) {
          const list = failures.get(p.task) ?? [];
          list.push({ command: p.command_id, timedOut: e.type === "check.timed_out", ...(e.type === "check.failed" && { signature: e.payload.signature, ...(e.payload.output_blob && { blob: e.payload.output_blob }) }) });
          failures.set(p.task, list);
        } else if (e.type === "check.failed" && p.scope === "integration" && e.seq > fromSeq && !caused.has(e.id) && lastMerged !== undefined) {
          emit(e, `integration|${p.command_id}|${e.payload.signature}`, {
            summary: `Integration check ${p.command_id} failed after task ${lastMerged} was merged (signature ${e.payload.signature.slice(0, 16)}).`,
            detected_by: `integration check ${p.command_id}`,
            responsible: [personaOf(lastMerged)],
            category: "test_gap",
            evidence: [e.id, ...(e.payload.output_blob ? [e.payload.output_blob] : [])],
          });
        }
        break;
      }
      case "task.rejected": {
        const task = e.payload.task;
        const fails = failures.get(task) ?? [];
        const violations = e.payload.violations?.length ?? 0;
        if (!submitted.has(task) || (!fails.length && !violations) || e.seq <= fromSeq || caused.has(e.id)) break;
        const commands = [...new Set(fails.map((f) => f.command))].sort();
        const basis = [...new Set(fails.map((f) => `${f.command}:${f.signature ?? (f.timedOut ? "timed_out" : "")}`))].sort().join(",");
        const what = [
          ...(commands.length ? [`${commands.length === 1 ? "check" : "checks"} ${commands.join(", ")} ${fails.every((f) => f.timedOut) ? "timed out" : "failed"}`] : []),
          ...(violations ? [`${plural(violations, "path")} changed outside its leases`] : []),
        ].join("; ");
        emit(e, `${task}|${basis}|${violations ? "lease" : ""}`, {
          summary: `Task ${task} was sent back after testing: ${what}.`,
          detected_by: commands.length ? `check ${commands.join(", ")}` : "lease check",
          responsible: [personaOf(task)],
          task,
          category: commands.length ? "implementation" : "process",
          evidence: [e.id, ...[...new Set(fails.flatMap((f) => (f.blob ? [f.blob] : [])))].slice(0, MAX_BLOBS)],
        });
        break;
      }
    }
  }
  return out;
}
