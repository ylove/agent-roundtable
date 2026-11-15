// ============================================================================
// Minimal private check-in messages: never send run prompts or access URLs
// ============================================================================

import { homedir } from "node:os";
import { executionTag } from "../ids.js";
import { scrub } from "../security/secrets.js";
import { redact } from "../publishers/redact.js";
import { budgetOf, completion } from "../dashboard/render.js";
import { wakeFor } from "../execution/watch.js";
import type { AnyEvent, BlackboardState } from "../execution/types.js";
import { NOTIFY_EVENTS, type NotifyKind } from "./config.js";

export interface CheckIn { v: 1; kind: NotifyKind | "test" | "updates"; execution: string; tag: string; title: string; body: string; seq: number; at: string }

// Path-shaped text only: /x…, ~/x… or C:\x… at the start or after whitespace, a quote, "(", "=", ":", "," or ";".
// "50/50", "and/or" and "a/b testing" are not paths.
const PATH_SHAPED = /(^|[\s"'(\]=:,;])(?:[A-Za-z]:[\\/]|~[\\/]|\/)(?=[^\s<>"'])[^\s<>"']*/g;

export function privateText(raw: string, max = 300, forbidden: string[] = []): string {
  let text = raw;
  for (const value of [...forbidden, process.env.ROUNDTABLE_HOME, homedir()].filter((v): v is string => !!v)) text = text.split(value).join("[private]");
  text = redact(scrub(text)).text
    .replace(/(?:https?:\/\/|secret:\/\/|www\.)[^\s<>"']+/gi, "[private URL]")
    .replace(PATH_SHAPED, "$1[private path]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[private token]")
    .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}

/** Use exactly the watcher's current-state rules, then select private check-in kinds. */
export function checkInKind(state: BlackboardState, event: AnyEvent): NotifyKind | null {
  const wake = wakeFor(state, event, "");
  return wake && (NOTIFY_EVENTS as readonly string[]).includes(wake.reason) ? wake.reason as NotifyKind : null;
}

export function buildCheckIn(state: BlackboardState, kind: NotifyKind, seq: number, summary = "", at = new Date().toISOString()): CheckIn {
  const tag = executionTag(state.execution).replace(/[^a-z0-9]/g, "");
  const labels: Record<NotifyKind, string> = {
    awaiting_human: "needs a decision", budget: "needs a budget check", completed: "completed", failed: "failed",
    aborted: "aborted", postmortem_ready: "has a postmortem ready", runner_keeps_dying: "runner keeps dying",
  };
  const forbidden = [state.goal?.original_prompt ?? "", ...Object.values(state.tasks).map(task => task.spec.persona)];
  const budget = budgetOf(state);
  const end = privateText(`Answer it from your chat, or run: roundtable status ${tag}`);
  const detail = kind === "awaiting_human" ? summary : `${completion(state).percent}% complete; spent $${budget.spent.toFixed(2)}${budget.limit !== undefined ? ` of $${budget.limit.toFixed(2)}` : ""}.`;
  return { v: 1, kind, execution: state.execution, tag, title: privateText(`Run ${tag} ${labels[kind]}`), body: `${privateText(detail, 299 - end.length, forbidden)} ${end}`, seq, at };
}
