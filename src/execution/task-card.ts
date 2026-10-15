// ============================================================================
// Task cards: the first message a worker gets (on stdin for spawned workers, in join_execution
// and claim_task for external ones). heads-down.md §9.
//
// A card holds the ultimate goal and the verbatim original prompt (both capped), the task with its
// acceptance criteria, write scope and checks, summaries of its dependencies, the interfaces and
// decisions in force, the immediate context of this run (a resolution, failing output, conflict
// files, a design artifact), and the protocol. It is built from the blackboard only, so every
// process renders the same card for the same state. Repository content never reaches it except
// through what workers themselves reported (notes, interface descriptions), and all of it is
// scrubbed.
// ============================================================================

import { scrub } from "../security/secrets.js";
import { preview } from "./events.js";
import type { BlackboardState, Decision, TaskRuntime } from "./types.js";

export type ImmediateKind = "resolution" | "failure" | "conflict" | "artifact" | "interrupted" | "rejected" | "note";

export interface TaskCardOptions {
  /** Why this run starts now, for a resumed or re-run worker. */
  immediate?: string | { kind: ImmediateKind; text: string; title?: string };
  /** External workers get their own protocol notes (agent_token on every call, leases checked at submit). */
  external?: boolean;
  /** The worktree path, when the reader needs it (external workers). */
  worktree?: string;
}

export const CARD_LIMITS = {
  goal: 2000,
  originalPrompt: 6000,
  dependency: 600,
  interface: 400,
  decision: 400,
  immediate: 8000,
  listItems: 30,
  total: 32 * 1024,
} as const;

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

function cap(text: string | undefined, max: number): string {
  const t = scrub((text ?? "").trim());
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}… [truncated]`;
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

function inScope(d: Decision, rt: TaskRuntime, taskId: string): boolean {
  return d.scope === "contract" || d.scope === taskId || (rt.spec.team !== undefined && d.scope === rt.spec.team);
}

function protocol(external: boolean): string {
  const lines = [
    "Do not message other agents; read the blackboard instead (`read_blackboard`, for example `query: \"is the nav done?\"`).",
    "Request a lease before you edit a path (`lease(action: \"request\", paths)`); if it is held, `escalate(with: \"path_owner\")`.",
    "Report progress with `post_update(kind: \"progress\", percent, text)`; publish interfaces you own with `post_update(kind: \"interface\")`.",
    "When you are blocked or a requirement is unclear, `escalate` instead of guessing. After a blocking escalation, end your turn.",
    "Make targeted edits; do not rewrite whole files.",
    "Run builds and tests only with `run_command` (a contract `command_id`, or an `argv`); there is no shell.",
    "Finish with `submit_work(summary, ready: true)`, which commits your leased changes and runs the checks; fix what fails and submit again.",
    "Stay within your budget: escalate rather than retrying the same failing approach.",
  ];
  if (external) {
    lines.unshift(
      "Pass `execution_id` and your `agent_token` to every worker tool. Work only inside your worktree, and claim the task (`claim_task`) before editing.",
      "No hook stops an edit outside your leases: they are checked when you submit, and a submission that changed unleased paths is rejected."
    );
  }
  return bullets(lines);
}

/** The task card for `taskId` as markdown. Throws for an unknown task. */
export function buildTaskCard(state: Readonly<BlackboardState>, taskId: string, opts: TaskCardOptions = {}): string {
  const rt = own(state.tasks, taskId);
  if (!rt) throw new Error(`Unknown task ${preview(taskId)}`);
  const spec = rt.spec;
  const c = state.contract;
  const goal = state.goal ?? c?.goal;
  const out: string[] = [];

  out.push(`# Task ${spec.id}: ${cap(spec.title, 300)}`);
  const facts = [
    `Execution: ${state.execution}${c ? ` (contract ${c.id} v${c.version})` : ""}`,
    `Kind: ${spec.kind}${spec.team ? `, team ${spec.team}` : ""}${spec.effort ? `, effort ${spec.effort}` : ""}`,
    `State: ${rt.state}${rt.attempt ? `, attempt ${rt.attempt}` : ""}`,
  ];
  const budget = spec.budget_usd ?? c?.budget.per_task_usd;
  if (budget !== undefined) facts.push(`Budget for this task: $${budget}`);
  if (opts.worktree) facts.push(`Worktree: ${opts.worktree}`);
  out.push(bullets(facts));

  if (goal) {
    out.push(`## Ultimate goal\n\n${cap(goal.ultimate, CARD_LIMITS.goal)}`);
    if (goal.original_prompt?.trim()) {
      out.push(`## The original request (verbatim)\n\n${fence(cap(goal.original_prompt, CARD_LIMITS.originalPrompt))}`);
    }
  }

  const scope = [`Write: ${spec.paths.write.length ? spec.paths.write.map((p) => `\`${p}\``).join(", ") : "(nothing)"}`];
  if (spec.paths.read?.length) scope.push(`Read: ${spec.paths.read.map((p) => `\`${p}\``).join(", ")}`);
  out.push(`## Your task\n\n${cap(spec.title, 1000)}\n\n### Acceptance criteria\n\n${spec.acceptance.length ? bullets(spec.acceptance.map((a) => cap(a, 500))) : "- (none listed)"}\n\n### Write scope\n\n${bullets(scope)}`);

  const commands = c?.validation.commands ?? [];
  if (spec.checks.length) {
    out.push(
      `### Checks (run by submit_work)\n\n${bullets(
        spec.checks.map((id) => {
          const cmd = commands.find((x) => x.id === id);
          return cmd ? `\`${id}\`: \`${cap(cmd.argv.join(" "), 200)}\`${cmd.cwd ? ` in \`${cmd.cwd}\`` : ""}` : `\`${id}\``;
        })
      )}`
    );
  }
  if (spec.context?.length) {
    out.push(`### Context\n\n${bullets(spec.context.slice(0, CARD_LIMITS.listItems).map((a) => `${a.kind}: ${cap(a.title ? `${a.title} (${a.ref})` : a.ref, 300)}`))}`);
  }

  if (spec.depends_on.length) {
    const deps = spec.depends_on.slice(0, CARD_LIMITS.listItems).map((d) => {
      const drt = own(state.tasks, d);
      if (!drt) return `\`${d}\`: unknown`;
      const files = Object.entries(state.files).filter(([, f]) => f.task === d).map(([p]) => p);
      const diff = own(state.diffs, d);
      const parts = [`\`${d}\` (${drt.state}): ${cap(drt.spec.title, 200)}`];
      if (drt.last_note) parts.push(`  Last note: ${cap(drt.last_note, CARD_LIMITS.dependency)}`);
      if (diff?.stat) parts.push(`  Changes: ${cap(diff.stat, 200)}`);
      if (files.length) parts.push(`  Files: ${files.slice(0, 15).join(", ")}${files.length > 15 ? `, … (+${files.length - 15})` : ""}`);
      return parts.join("\n");
    });
    out.push(`## Dependencies\n\n${bullets(deps)}`);
  }

  const ifaces = Object.entries(state.interfaces).slice(0, CARD_LIMITS.listItems).map(([name, i]) => {
    const role = i.spec?.owner === taskId ? "you own it" : i.spec?.consumers?.includes(taskId) ? "you consume it" : undefined;
    const head = `\`${name}\`${i.spec ? ` (${i.spec.kind}, owner ${i.spec.owner})` : ""}, version ${i.version}${role ? `: ${role}` : ""}`;
    const extra = [i.spec?.description ? cap(i.spec.description, CARD_LIMITS.interface) : "", i.path ? `path \`${i.path}\`` : "", i.blob ? `published as ${i.blob}` : ""].filter(Boolean);
    return extra.length ? `${head}\n  ${extra.join("; ")}` : head;
  });
  if (ifaces.length) out.push(`## Interfaces in force\n\n${bullets(ifaces)}`);

  const decisions = state.decisions.filter((d) => inScope(d, rt, taskId)).slice(-CARD_LIMITS.listItems);
  if (decisions.length) {
    out.push(`## Decisions in force\n\n${bullets(decisions.map((d) => `${cap(d.text, CARD_LIMITS.decision)}${d.rationale ? ` (why: ${cap(d.rationale, 200)})` : ""} [${d.id}, ${d.scope}]`))}`);
  }

  if (opts.immediate) {
    const im = typeof opts.immediate === "string" ? { kind: "note" as const, text: opts.immediate } : opts.immediate;
    const title = im.title ?? {
      resolution: "Resolution of your escalation",
      failure: "What failed",
      conflict: "Merge conflicts to resolve",
      artifact: "Design artifact",
      interrupted: "You were interrupted",
      rejected: "Your submission was rejected",
      note: "Before you start",
    }[im.kind];
    out.push(`## ${title}\n\n${fence(cap(im.text, CARD_LIMITS.immediate))}`);
  }

  // The protocol always survives the cap: it is cut from the body, never from the protocol.
  const tail = `\n\n## Protocol\n\n${protocol(opts.external === true)}\n`;
  let body = out.join("\n\n");
  const room = CARD_LIMITS.total - tail.length;
  if (body.length > room) body = `${body.slice(0, room - 32).trimEnd()}\n\n… [task card truncated]`;
  return body + tail;
}
