// ============================================================================
// Contract tools (heads-down): propose, amend and freeze the contract a run executes
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LLMProvider } from "../config.js";
import { amendContract, fileDissent, freezeContract, proposeContract, type ContractResult } from "../execution/contract-lifecycle.js";
import { openContractStore, describeConsent, orchestratorSource } from "../execution/contract-state.js";
import { renderContractMarkdown } from "../execution/contract.js";
import { truncate } from "../sessions/workshop.js";
import { AMEND_CONTRACT, FILE_DISSENT, FREEZE_CONTRACT, PROPOSE_CONTRACT, SCORE_DISSENT } from "./names.js";
import { ORCHESTRATOR_ONLY, PROVIDER_PROPS, validateProviderOptions, type ToolArgs, type ToolCallContext, type ToolDefinition } from "./shared.js";
import { resolveWorkerActor } from "./worker.js";

/** Contract markdown in a tool result is capped; CONTRACT.md always has all of it. */
export const CONTRACT_MARKDOWN_LIMIT = 12_000;

const CONTRACT_ID = { type: "string", description: "The contract id (ctr-<6 characters>-<n>) from propose_contract." } as const;
const ORCHESTRATOR = {
  type: "string",
  description: "Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it.",
  "x-nonblank": true,
  "x-hint": "name yourself, e.g. main",
} as const;

function checkProviderArgs(args: Record<string, unknown>): void {
  validateProviderOptions(args.provider as LLMProvider | undefined, args.base_url as string | undefined);
}

const DISSENT_PROPS = {
  contract_id: CONTRACT_ID,
  dissent: {
    type: "object", additionalProperties: false,
    description: "Structured concern. Omit tripwire only for a draft. With excuse_reason, pass just {id}. by is bound to an authenticated agent; orchestrators specify a participant.",
    properties: {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      by: { type: "string" },
      source: { type: "object", additionalProperties: false, required: ["kind"], properties: {
        kind: { type: "string", enum: ["ultraplan", "consent", "debate", "waffle_house", "manual"] }, ref: { type: "string" },
      } },
      claim: { type: "string", maxLength: 500 },
      predicted_failure: { type: "string", maxLength: 500 },
      tripwire: { type: "object", additionalProperties: false, required: ["kind"], properties: {
        kind: { type: "string", enum: ["check_failed", "path_touched", "task_state"] },
        check: { type: "string" }, task: { type: "string" },
        paths: { type: "array", items: { type: "string" }, maxItems: 64 },
        state: { type: "string", enum: ["rejected", "blocked"] },
      } },
      on_fire: { type: "string", enum: ["notify", "huddle", "pause_and_huddle"], description: "Default huddle." },
    }, required: ["id"],
  },
  resolve_objection: { type: "boolean", description: "The objector explicitly consents to the new version with how: dissented, retaining this dissent. Other participants must re-consent." },
  excuse_reason: { type: "string", "x-nonblank": true, description: "Orchestrator only: explicitly excuse this dissent by id. Its concern and this reason remain in version history and the audit log. Creates a new draft requiring re-consent." },
} as const;

export const contractTools: ToolDefinition[] = [
  {
    name: SCORE_DISSENT,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Score dissent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Record or revise an advisory dissent outcome on a frozen contract. Only its orchestrator may score. Scores are display-only and never weight votes or consent.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        contract_id: CONTRACT_ID, orchestrator: ORCHESTRATOR,
        dissent_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        outcome: { type: "string", enum: ["vindicated", "refuted", "untested"] },
      },
      required: ["contract_id", "orchestrator", "dissent_id", "outcome"],
    },
  },
  {
    name: FILE_DISSENT,
    modes: ["orchestrator", "worker"],
    annotations: { title: "File dissent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "File or update a structured dissent on a draft contract, creating a new version. Tripwires are data only. An agent files as its authenticated identity; an orchestrator may file for any participant. A dissent needs a tripwire before freeze or explicit excusal with a reason. Frozen contracts require amend_contract and consent.",
    inputSchema: { type: "object", additionalProperties: false, properties: DISSENT_PROPS, required: ["contract_id", "dissent"] },
    inputSchemaByMode: { orchestrator: {
      type: "object", additionalProperties: false, required: ["contract_id", "dissent"],
      properties: { ...DISSENT_PROPS, orchestrator: ORCHESTRATOR,
        execution_id: { type: "string", description: "With agent_token: the agent's execution." },
        agent_token: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Authenticate as an agent instead of an orchestrator." },
      },
    } },
  },
  {
    name: PROPOSE_CONTRACT,
    modes: ORCHESTRATOR_ONLY,
    precheck: (args) => {
      checkProviderArgs(args);
      if ((args.parent_contract === undefined || args.parent_contract === null) !== (args.parent_task === undefined || args.parent_task === null)) {
        throw new Error("propose_contract: parent_contract and parent_task go together");
      }
    },
    annotations: { title: "Propose contract", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Turn an agreed plan into a heads-down contract: a draft v1 in a new execution, which workers build in parallel once every participant consents and you freeze it. " +
      "The structure comes from, in order: contract (an explicit object with tasks: the most reliable route), the last ```roundtable-tasks JSON block in plan or in the archived from_session " +
      "(an ultraplan started with execution_ready: true ends with one), or a structuring call on the plan text (one retry quoting the validation errors). " +
      "A contract object without tasks overlays the structure (budget, sandbox, workers, authority, scope.paths, ...). " +
      "original_prompt is the human's request, verbatim (default: the session's task). repo_dir (default the workspace) resolves to its git top level and base_ref (default HEAD) to a commit. " +
      "Participants default to the session's agents plus every task persona. consent: true asks each participant for `Consent: AGREE | OBJECT` (an unclear answer is re-asked once, then counts as an objection). " +
      "Nothing is written to the repository: the contract lives under ROUNDTABLE_HOME/executions. Returns the contract as markdown and a JSON summary (contract_id, version, status, warnings, consent, next). " +
      "Show the contract to the human before freezing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string", description: "The ultimate goal the contract delivers.", "x-nonblank": true, "x-hint": "state the ultimate goal the contract delivers" },
        orchestrator: ORCHESTRATOR,
        title: { type: "string", description: "Short title; default the goal's first line." },
        original_prompt: { type: "string", description: "The human's request, verbatim (default: from_session's task or topic). Workers see it on every task card." },
        artifacts: { type: "array", items: { type: "string" }, description: "Repository paths or URLs the goal refers to." },
        from_session: { type: "string", description: "Id of an archived session (an ultraplan, collaboration or meeting that has ended) whose roundtable-tasks block or plan to build from." },
        plan: { type: "string", description: "Plan text: its last roundtable-tasks block is used, else a structuring call turns it into tasks." },
        contract: { type: "object", description: "An explicit contract (roundtable.contract/1 fields: title, scope.paths, participants, teams, tasks, interfaces, decisions, dissents, validation {commands, final}, budget, authority, sandbox, workers). id, version, status and consent are set for you." },
        parent_contract: { type: "string", description: "For a child contract: the parent contract id (with parent_task, a subcontract task of it)." },
        parent_task: { type: "string", description: "For a child contract: the parent's subcontract task this contract carries out." },
        participants: { type: "array", items: { type: "string" }, description: "Agents who must consent (names or .md paths); task personas are always added." },
        repo_dir: { type: "string", description: "A directory inside the repository to build in; default ROUNDTABLE_WORKSPACE_DIR." },
        base_ref: { type: "string", description: "The commit or ref the run starts from; default HEAD. Stored as the resolved sha." },
        consent: { type: "boolean", description: "Default false. True: ask every participant for consent right away." },
        ...PROVIDER_PROPS,
      },
      required: ["goal", "orchestrator"],
    },
  },
  {
    name: AMEND_CONTRACT,
    modes: ORCHESTRATOR_ONLY,
    precheck: checkProviderArgs,
    annotations: { title: "Amend contract", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      "Amend a contract with an RFC 7396 merge patch (objects merge, arrays replace, null deletes) to produce v(N+1). Only its orchestrator may. " +
      "A draft gets a new proposal; a frozen contract is amended in force: removed tasks are cancelled and the agents of affected tasks get a directive to re-read it. " +
      "from_session (an archived replan or ultraplan) first replaces the structure with that session's roundtable-tasks block (pass patch: {}). " +
      "id, version, status, consent, frozen, the scope's orchestrator, repository, base commit and parent, and the goal's original_prompt cannot change. " +
      "Consent counts only for the version it was given on. A draft amendment needs every participant's consent again before a freeze: consent: true asks them all, and an objector who now agrees has the objection resolved by the amendment. " +
      "On a frozen contract, a run-wide change (budget, scope, sandbox, authority, validation, workers, goal, dissents) needs consent: true (everyone is asked about it first, and it applies only if all agree) or override_consent: true (audited); " +
      "other changes apply at once, and consent: true then asks the personas of affected tasks. patch: {} with consent: true just asks everyone without an agreement on the current version. " +
      "Returns the affected tasks, the consent outcome and the contract markdown.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contract_id: CONTRACT_ID,
        patch: { type: "object", description: "RFC 7396 merge patch over the latest version, e.g. {\"budget\": {\"usd\": 40}} or {\"tasks\": [...the full new task list...]}." },
        reason: { type: "string", description: "Why the contract changes; recorded and sent to affected agents.", "x-nonblank": true, "x-hint": "say why the contract changes" },
        orchestrator: ORCHESTRATOR,
        from_session: { type: "string", description: "Id of an archived replan or ultraplan whose roundtable-tasks block replaces the tasks, commands and interfaces." },
        consent: { type: "boolean", description: "Default false. True: ask participants about the new version: everyone for a draft or a run-wide change, the personas of affected tasks otherwise." },
        override_consent: { type: "boolean", description: "Frozen contracts only, default false: apply a run-wide change (budget, scope, sandbox, authority, validation, workers, goal) without everyone's consent. Audited." },
        ...PROVIDER_PROPS,
      },
      required: ["contract_id", "patch", "reason", "orchestrator"],
    },
  },
  {
    name: FREEZE_CONTRACT,
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Freeze contract", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Freeze a contract so it can be executed. Only its orchestrator can, and only once every participant has agreed to its current version. " +
      "Refuses, listing every reason, while an objection or UNCLEAR answer is unresolved, a participant has not answered about the current version, a consent round is in flight (abandon_round declares a dead one abandoned), the source session is busy, " +
      "or, for a child contract, while the parent is not frozen or the caller is neither the parent task's persona nor the parent's orchestrator. " +
      "excuse sets objections aside, each with a reason; excusals and the frozen sha256 go to the audit log. Freezing starts nothing: the run starts with execute, when the human asks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contract_id: CONTRACT_ID,
        orchestrator: ORCHESTRATOR,
        abandon_round: {
          type: "boolean",
          description: "Default false. True: declare an unfinished consent round abandoned (its process died or hangs): its missing answers are recorded as unclear, which still need excusing, and the abandonment is audited.",
        },
        excuse: {
          type: "array",
          maxItems: 50,
          description: "Objections (or missing answers) to set aside: [{agent, reason}]. Each is recorded and audited.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              agent: { type: "string", description: "The participant whose objection is excused.", "x-nonblank": true },
              reason: { type: "string", description: "Why the run may go ahead despite it.", "x-nonblank": true },
            },
            required: ["agent", "reason"],
          },
        },
      },
      required: ["contract_id", "orchestrator"],
    },
  },
];

/** The contract markdown (capped), a status header, and a fenced JSON summary. */
export function formatContractResult(r: ContractResult): string {
  const lines = [`## Contract ${r.contractId} v${r.version} (${r.status})`, "", `Consent: ${describeConsent(r.consent)}`];
  if (r.hash) lines.push(`Frozen sha256: ${r.hash}`);
  if (r.affected) lines.push(`Affected tasks: ${r.affected.all.join(", ") || "none"}`);
  if (r.warnings.length) lines.push("", "Warnings:", ...r.warnings.map((w) => `- ${w}`));
  lines.push("", `Next: ${r.next}`);
  const summary = {
    contract_id: r.contractId, execution_id: r.executionId, version: r.version, status: r.status,
    ...(r.source !== undefined && { source: r.source }), ...(r.hash !== undefined && { hash: r.hash }),
    warnings: r.warnings, consent: r.consent,
    ...(r.affected && { affected_tasks: r.affected }), ...(r.asked && { asked: r.asked }),
    ...(r.postmortemLessons && { postmortem_lessons: r.postmortemLessons }),
    files: r.paths, next: r.next,
  };
  return lines.join("\n") + "\n\n" + truncate(renderContractMarkdown(r.contract), CONTRACT_MARKDOWN_LIMIT) +
    "\n```json\n" + JSON.stringify(summary, null, 2) + "\n```";
}

const llmOf = (a: Record<string, unknown>) => ({
  provider: a.provider as LLMProvider | undefined, model: a.model as string | undefined, baseUrl: a.base_url as string | undefined,
});

/** Dispatch one contract tool. Errors are thrown to handleToolCall, which formats them. */
export async function handleContractTool(name: string, args: ToolArgs, ctx: ToolCallContext = { mode: "orchestrator" }): Promise<CallToolResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  let result: ContractResult;
  switch (name) {
    case SCORE_DISSENT: {
      if (ctx.mode !== "orchestrator") throw new Error("only an orchestrator may score a dissent");
      const store = await openContractStore(a.contract_id as string);
      await store.transact(({ state }) => {
        const c = state.contract;
        if (!c || c.id !== a.contract_id || c.status !== "frozen") throw new Error("scoring requires a frozen contract");
        if (c.scope.orchestrator !== a.orchestrator) throw new Error("only the contract's orchestrator may score a dissent");
        if (!(c.dissents ?? []).some((d) => d.id === a.dissent_id)) throw new Error("unknown dissent id");
        return { events: [{ type: "dissent.scored", source: orchestratorSource(a.orchestrator as string),
          payload: { dissent_id: a.dissent_id as string, outcome: a.outcome as "vindicated" | "refuted" | "untested" } }] };
      });
      return { content: [{ type: "text", text: JSON.stringify({ dissent_id: a.dissent_id, outcome: a.outcome, advisory: true }) }] };
    }
    case FILE_DISSENT: {
      const id = a.contract_id as string;
      const asAgent = ctx.mode === "worker" || a.agent_token !== undefined || a.execution_id !== undefined;
      if (asAgent && a.orchestrator !== undefined) throw new Error("choose agent authentication or orchestrator, not both");
      const actor = asAgent ? await resolveWorkerActor(a, ctx.mode) : undefined;
      const store = actor?.store ?? await openContractStore(id);
      result = await fileDissent(store, a.dissent as Record<string, unknown>, {
        by: actor?.agent ?? a.orchestrator as string, contractId: id,
        ...(actor && { source: { kind: "agent", id: actor.agent, pid: process.pid } }),
        resolveObjection: a.resolve_objection === true, excuseReason: a.excuse_reason as string | undefined,
      });
      break;
    }
    case PROPOSE_CONTRACT:
      result = await proposeContract({
        goal: a.goal as string, orchestrator: a.orchestrator as string,
        title: a.title as string | undefined, originalPrompt: a.original_prompt as string | undefined,
        artifacts: a.artifacts as string[] | undefined, fromSession: a.from_session as string | undefined,
        plan: a.plan as string | undefined, contract: a.contract as Record<string, unknown> | undefined,
        parentContract: a.parent_contract as string | undefined, parentTask: a.parent_task as string | undefined,
        participants: a.participants as string[] | undefined, repoDir: a.repo_dir as string | undefined,
        baseRef: a.base_ref as string | undefined, consent: a.consent === true, llm: llmOf(a),
      });
      break;
    case AMEND_CONTRACT: {
      const id = a.contract_id as string;
      result = await amendContract(await openContractStore(id), a.patch as Record<string, unknown>, {
        by: a.orchestrator as string, reason: a.reason as string, contractId: id,
        fromSession: a.from_session as string | undefined, consent: a.consent === true ? llmOf(a) : false,
        overrideConsent: a.override_consent === true,
      });
      break;
    }
    case FREEZE_CONTRACT:
      result = await freezeContract(a.contract_id as string, {
        orchestrator: a.orchestrator as string, excuse: a.excuse as Array<{ agent: string; reason: string }> | undefined,
        abandonRound: a.abandon_round === true,
      });
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: formatContractResult(result) }] };
}
