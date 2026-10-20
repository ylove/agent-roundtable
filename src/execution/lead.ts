// ============================================================================
// Lead fallback (#85): the contract's lead decides an escalation the orchestrator did not answer
//
// The watchdog issues lead_fallback when an escalation routed to an orchestrator whose watcher is
// not alive stays unresolved for leadGraceMs; it has re-routed the escalation to the lead first.
// The lead (contract.authority.lead) gets one persona call with the context bundle and its
// authority, and must answer `Action: decide | retry | reassign | amend | dismiss | await_human`
// and `Decision:`; reassign adds `Persona:`, amend a fenced JSON merge patch. An action outside
// authority.may, an AuthorityError from the amendment, or any other failure to apply it becomes
// await_human. Every decision is audited. Idempotent: a resolved escalation is left alone.
// ============================================================================

import { appendAudit } from "../security/audit.js";
import { remainingUsd } from "./budget.js";
import { readDiagnostics, buildContextBundle } from "./context-bundle.js";
import {
  UsageMeter,
  actorSource,
  askPersona,
  awaitHuman,
  cap,
  directiveField,
  directiveOf,
  errText,
  fencedJson,
  own,
  recordDrafts,
  resolveEscalation,
  type EscalationOptions,
  type HookCtx,
  type ProcessOp,
  type ResolveOptions,
} from "./escalation.js";
import type { AuthorityAction, Contract, ResolutionAction } from "./types.js";

export const LEAD_ACTIONS = ["decide", "retry", "reassign", "amend", "dismiss", "await_human"] as const;
export type LeadAction = (typeof LEAD_ACTIONS)[number];

/** What each action needs in authority.may (amendments are checked field by field by amendContract). */
const NEEDS: Readonly<Record<LeadAction, AuthorityAction | null>> = {
  decide: null, dismiss: null, await_human: null, amend: null, retry: "retry", reassign: "reassign",
};

const LEAD_DIRECTIVE =
  "\n\n## Lead fallback\n" +
  "You are the lead of this heads-down run. The orchestrator is not available, so you decide this escalation alone, in one answer, " +
  "within your authority. Workers act on your decision as written.";

const AUTHORITY_TEXT: Readonly<Record<AuthorityAction, string>> = {
  retry: "retry a task (a fresh attempt)",
  reassign: "reassign a task to another persona",
  split_task: "split a task (by amendment)",
  add_task: "add tasks (by amendment)",
  amend_interfaces: "change interfaces (by amendment)",
  extend_budget: "raise budgets within the extension limit (by amendment)",
  resolve_merge: "resolve merge conflicts",
};

export function buildLeadPrompt(c: Contract, bundle: string): string {
  const may = c.authority.may.map((a) => `- ${a}: ${AUTHORITY_TEXT[a] ?? a}`).join("\n") || "- nothing beyond deciding and dismissing";
  return `${bundle}\n\n## Your authority\n\n${may}\n` +
    (c.authority.may.includes("extend_budget") ? `Budget extensions up to ${c.authority.budget_extension_pct}% above the budget first frozen.\n` : "") +
    "\nAnswer with exactly these lines first:\n" +
    "Action: decide | retry | reassign | amend | dismiss | await_human\n" +
    "Decision: <what the worker does now, or why the human is needed>\n\n" +
    "- decide: answer the question; the worker continues with your decision.\n" +
    "- retry / reassign: only within your authority. For reassign add a line `Persona: <the persona that takes the task over>`.\n" +
    "- amend: add a fenced ```json block with an RFC 7396 merge patch of the contract (only what your authority covers; arrays such as tasks are replaced whole).\n" +
    "- dismiss: the escalation needs no answer.\n" +
    "- await_human: money, credentials, anything outside your authority or the contract, or a call only the human can make.";
}

const inFlight = new Set<string>();

/**
 * The lead's one decision on an escalation. Returns the runner's operations (a resume, a retry).
 * A second call while one runs for the same escalation, or after it is resolved, does nothing.
 */
export async function leadFallback(ctx: HookCtx, id: string, opts: EscalationOptions = {}): Promise<ProcessOp[]> {
  const key = `${ctx.store.id}\0${id}`;
  if (inFlight.has(key)) return [];
  inFlight.add(key);
  try {
    return await decide(ctx, id, opts);
  } finally {
    inFlight.delete(key);
  }
}

async function decide(ctx: HookCtx, id: string, opts: EscalationOptions): Promise<ProcessOp[]> {
  const state = await ctx.store.state();
  const esc = own(state.escalations, id);
  const c = state.contract;
  if (!esc || !c || esc.status === "resolved" || esc.status === "withdrawn" || esc.status === "awaiting_human") return [];
  const lead = c.authority.lead;
  const actor = { kind: "lead" as const, id: lead };
  const source = actorSource(actor);
  if (esc.dissent_id && remainingUsd(state, { agent: lead }) <= 0) {
    await awaitHuman(ctx, id, { actor, class: "money", message: "No budget remains for the lead to resolve this dissent." });
    return [];
  }
  const meter = new UsageMeter("lead", undefined, lead);
  const bundle = buildContextBundle(state, esc, { diagnostics: await readDiagnostics(ctx.store, esc) });

  let answer: string;
  try {
    answer = await askPersona(meter, ctx.llm, lead, LEAD_DIRECTIVE, buildLeadPrompt(c, bundle));
  } catch (e) {
    // No decision this time; the watchdog issues the fallback again after leadRetryMs.
    console.error(`[Lead] ${id}: the lead call failed: ${errText(e)}`);
    return [];
  } finally {
    await recordDrafts(ctx.store, meter.take(source, id));
  }

  // Only the lead's own directive lines count: the escalation it quotes is agent-written.
  const proposed = directiveOf(answer, "Action", LEAD_ACTIONS);
  const decision = directiveField(answer, "Decision");
  let applied: ResolutionAction = "await_human";
  let reason: string | undefined;
  let ops: ProcessOp[] = [];

  if (proposed === "UNCLEAR") reason = "the lead's answer had no Action line";
  else if (proposed === "CONFLICT") reason = "the lead's answer had conflicting Action lines";
  else if (NEEDS[proposed] && !c.authority.may.includes(NEEDS[proposed]!)) reason = `${proposed} needs "${NEEDS[proposed]}", which authority.may does not grant`;
  else if (proposed !== "await_human" && proposed !== "dismiss" && !decision) reason = "the lead's answer had no Decision line";
  else if (proposed !== "await_human") {
    const r: ResolveOptions = { action: proposed, resolved_by: lead, as: "lead", ...(decision && { decision }) };
    if (proposed === "amend") {
      const patch = fencedJson(answer);
      if (!patch) reason = "amend without a fenced JSON merge patch";
      else r.amendment = patch;
    }
    if (proposed === "reassign") {
      const persona = directiveField(answer, "Persona", 300)?.split(/\s/)[0]?.replace(/^[`"']+|[`"'.,]+$/g, "");
      if (!persona) reason = "reassign without a Persona line";
      else r.persona = persona;
    }
    if (!reason) {
      try {
        const res = await resolveEscalation(ctx, id, r, opts);
        ops = res.ops;
        applied = res.applied ?? proposed;
        if (res.noop) reason = "the escalation changed meanwhile";
      } catch (e) {
        reason = `${e instanceof Error && e.name === "AuthorityError" ? "outside the lead's authority" : "could not be applied"}: ${errText(e).split("\n").slice(0, 4).join(" ")}`;
        applied = "await_human";
      }
    }
  }
  if (applied === "await_human") {
    const message = cap(
      [`The lead (${lead}) could not resolve escalation ${id}${reason ? `: ${reason}` : ""}.`, decision ? `The lead's view: ${decision}` : "", `Escalation: ${esc.summary}`].filter(Boolean).join(" "),
      2000
    );
    await awaitHuman(ctx, id, { actor, message });
  }
  try {
    await appendAudit({
      actor: lead,
      action: "escalation.lead_decision",
      target: id,
      details: { execution: ctx.store.id, proposed, applied, ...(decision && { decision: cap(decision, 500) }), ...(reason && { reason: cap(reason, 500) }) },
    });
  } catch (e) {
    console.error(`[Lead] audit of ${id} failed: ${errText(e)}`);
  }
  return ops;
}
