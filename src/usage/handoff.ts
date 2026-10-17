// ============================================================================
// Handoff documents (usage-visibility.md §6)
//
// When a person stops an agent, the orchestrator can rework around it or write a handoff: a plain
// document that lets someone else (or a later session) pick the work up.
//
//   heads-down    executions/<exe>/HANDOFF.md, generated from the blackboard only: the contract summary,
//                 the goal, every task with its state, owner, branch and last progress note, the stopped
//                 agents and why, the open escalations, the budget with its provenance split, and the
//                 exact commands to resume. It holds no confirmation, original prompt, diff or command
//                 output, and every string is scrubbed.
//   at the table  sessions/<id>.handoff.md, from the archived session's metadata and summary, scrubbed.
// ============================================================================

import { join } from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { executionBudgetUsd } from "../execution/budget.js";
import { taskBranch } from "../execution/git.js";
import { executionDir } from "../execution/store.js";
import type { BlackboardState } from "../execution/types.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { readArchivedSession, type ArchivedSession } from "../sessions/archive.js";
import { totalText, usd, usdBudget } from "./format.js";
import { addMoney, moneyTotal, tokenTotal, zeroMoney, zeroTokens } from "./types.js";

/** One line of plain text, scrubbed and capped: safe in a heading, a list item or a table cell. */
export function line(s: unknown, max = 300): string {
  const t = scrub(String(s ?? "")).replace(/\s+/g, " ").trim();
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t; // cut first: escaping after it cannot leave a lone escape
  // Backslash first, so the escapes added for | and ` are not themselves escaped again.
  return cut.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

const own = <V>(map: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

function spend(state: BlackboardState) {
  const money = zeroMoney();
  const tokens = zeroTokens();
  for (const u of Object.values(state.budget.by_agent_usage ?? {})) {
    for (const m of Object.values(u.models)) {
      tokens.input += m.tokens.input;
      tokens.output += m.tokens.output;
      tokens.cache_read += m.tokens.cache_read;
      tokens.cache_write += m.tokens.cache_write;
      for (const p of ["measured", "reported", "estimated"] as const) {
        addMoney(money, m.usd[p], p);
        tokens.by[p] += m.tokens_prov[p];
      }
    }
  }
  return { money, tokens };
}

/** HANDOFF.md for a run, from its blackboard alone. `now` only stamps the document. */
export function buildRunHandoff(state: BlackboardState, now = new Date()): string {
  const exe = state.execution;
  const c = state.contract;
  const orchestrator = c?.scope.orchestrator ?? "main";
  const out: string[] = [];
  out.push(`# Handoff: ${line(c?.title ?? "heads-down run", 120)} (${exe})`, "");
  out.push(
    `Written ${now.toISOString()} from the blackboard at event ${state.seq}. It holds no confirmation, original request, diff or command output; ` +
      `read the task branches and \`agent-roundtable status ${exe}\` for the rest.`,
    ""
  );

  out.push("## Where things stand", "");
  out.push(`- Run: **${state.status}**${state.paused_tasks.length ? `; paused tasks: ${state.paused_tasks.map((t) => `\`${line(t, 64)}\``).join(", ")}` : ""}`);
  if (c) out.push(`- Contract: \`${line(c.id, 64)}\` version ${c.version}, ${c.tasks.length} task${c.tasks.length === 1 ? "" : "s"}, ${c.teams.length} team${c.teams.length === 1 ? "" : "s"}`);
  if (state.goal) out.push(`- Goal: ${line(state.goal.ultimate, 600)}`);
  const { money, tokens } = spend(state);
  const budget = executionBudgetUsd(state);
  const used = moneyTotal(money) > 0 ? totalText(money) : tokenTotal(tokens) > 0 ? "no price known for the models used" : usd(0);
  out.push(`- Budget: ${used}${budget > 0 ? ` of ${usdBudget(budget)}` : ""}${state.budget.extensions_usd ? ` (including ${usd(state.budget.extensions_usd)} extended)` : ""}`);
  out.push("");

  out.push("## Tasks", "");
  const tasks = Object.values(state.tasks).sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1));
  if (tasks.length) {
    out.push("| Task | State | Owner | Branch | Last progress note |", "| --- | --- | --- | --- | --- |");
    for (const rt of tasks) {
      const owner = rt.agent ?? own(state.claims, rt.spec.id)?.agent;
      let branch = "";
      try {
        branch = taskBranch(exe, rt.spec.id);
      } catch {
        /* an id that cannot name a branch has none */
      }
      out.push(
        `| \`${line(rt.spec.id, 64)}\` ${line(rt.spec.title, 80)} | ${rt.state}${rt.percent !== undefined ? ` (${Math.round(rt.percent)}%)` : ""} | ${owner ? line(owner, 64) : "none"} | ${branch ? `\`${branch}\`` : ""} | ${line(rt.last_note ?? "", 240)} |`
      );
    }
  } else out.push("No tasks yet.");
  out.push("");

  const stopped = Object.values(state.agents).filter((a) => a.stop);
  out.push("## Stopped agents", "");
  if (stopped.length) {
    for (const a of stopped) {
      const s = a.stop!;
      out.push(
        `- **${line(a.id, 64)}** was stopped by ${line(s.by, 100)} at ${s.at}${s.reason ? ` (${line(s.reason, 300)})` : ""}${a.task ? ` while on task \`${line(a.task, 64)}\`` : ""}` +
          `${s.state === "requested" ? "; the runner has not applied it yet" : ""}. Its work-in-progress stays on the task branch and worktree.`
      );
    }
  } else out.push("No agent was stopped.");
  out.push("");

  const open = Object.values(state.escalations).filter((e) => ["open", "routed", "in_huddle", "awaiting_human"].includes(e.status));
  out.push("## Open escalations", "");
  if (open.length) {
    for (const e of open) {
      out.push(`- \`${line(e.id, 64)}\` (${e.kind}${e.task ? `, task \`${line(e.task, 64)}\`` : ""}, ${e.status}): ${line(e.summary, 400)}${e.question ? ` Question: ${line(e.question, 300)}` : ""}`);
    }
  } else out.push("None.");
  out.push("");

  out.push("## To resume", "");
  out.push("```sh", `agent-roundtable status ${exe}`, `agent-roundtable usage`, `agent-roundtable watch ${exe} --as ${line(orchestrator, 64)}`, "```", "");
  out.push(
    "In the orchestrator chat:",
    "",
    `- \`control_execution(execution_id: "${exe}", action: "resume")\` continues a paused run.`,
    ...open.map((e) => `- \`resolve_escalation(execution_id: "${exe}", escalation_id: "${line(e.id, 64)}", action: …)\` answers ${line(e.id, 64)} (reassign, retry, amend, decide, dismiss).`),
    `- \`usage(action: "report", execution_id: "${exe}")\` shows who used what.`,
    ""
  );
  return out.join("\n");
}

export interface WrittenHandoff {
  path: string;
  document: string;
}

/** Write executions/<exe>/HANDOFF.md (0600) and return it. */
export function writeRunHandoff(state: BlackboardState, now = new Date()): WrittenHandoff {
  const document = buildRunHandoff(state, now);
  const path = join(executionDir(state.execution), "HANDOFF.md");
  writeFileAtomic(path, document);
  return { path, document };
}

// ---------------------------------------------------------------------------
// At the table
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

/** The handoff of an archived session: who, what about, how it ended, its summary, how to carry on. */
export function buildSessionHandoff(a: ArchivedSession, now = new Date()): string {
  const out: string[] = [];
  out.push(`# Handoff: ${line(a.kind, 40)} ${line(a.id, 64)}`, "");
  out.push(`Written ${now.toISOString()} from the archived session. The full transcript is archived in \`sessions/${line(a.id, 64)}.json\`.`, "");
  out.push("## The session", "");
  out.push(`- Agents: ${a.agents.map((x) => line(x, 64)).join(", ") || "none"}`);
  out.push(`- Started ${a.started}, ended ${a.ended}; ${a.turns.length} turn${a.turns.length === 1 ? "" : "s"}`);
  if (a.stopped) out.push(`- Stopped by ${line(a.stopped.by, 100)} at ${a.stopped.at}${a.stopped.reason ? ` (${line(a.stopped.reason, 300)})` : ""}`);
  out.push("");
  out.push("## Summary", "");
  const summary = a.summary && !a.stopped ? scrub(a.summary).trim().slice(0, 4000) : "";
  out.push(summary || "No summary was written: the session was stopped before one was asked for. Start a new session with the same agents and refer to the archived transcript.", "");
  out.push("## To carry on", "");
  out.push(`- Start the same kind of session again with ${a.agents.map((x) => `\`${line(x, 64)}\``).join(", ") || "the same agents"}; \`propose_contract(from_session: "${line(a.id, 64)}")\` can build a contract from an ended ultraplan.`);
  out.push("- `usage(action: \"report\")` shows what the session used.", "");
  return out.join("\n");
}

/** Write sessions/<id>.handoff.md (0600) from the archived session. Throws a plain message when there is none. */
export function writeSessionHandoff(id: string, now = new Date()): WrittenHandoff {
  if (!SESSION_ID_RE.test(id)) throw new Error("Not a session id");
  const archived = readArchivedSession(id);
  if (!archived) {
    throw new Error(`Session ${id} is not archived (yet): a session that is still live is archived when it ends. Stop it first, or end it with its end_… tool.`);
  }
  const document = buildSessionHandoff(archived, now);
  mkdirPrivate(SESSIONS_DIR);
  const path = join(SESSIONS_DIR, `${id}.handoff.md`);
  writeFileAtomic(path, document);
  return { path, document };
}
