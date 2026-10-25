// ============================================================================
// Worker tools (heads-down): read_blackboard, claim_task, lease, post_update, run_command,
// submit_work, escalate, spawn_subtasks and await_subtasks, plus join_execution (orchestrator server only)
//
// On a worker server the worker tools are bound to the identity its token proved at startup
// (bindWorkerIdentity). On the orchestrator server they take execution_id and agent_token, the
// token join_execution returned once. Either way every event is stamped
// source {kind: "agent", id, task, team, pid}, every call renews the agent's heartbeat, and every
// response carries the agent's new inbox items (directives and decisions) since its cursor.
//
// Decisions are taken inside store.transact against fresh state; slow work (git, the sandbox)
// happens outside it. Nothing here merges: the runner owns the merge queue.
// ============================================================================

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTION_ID_RE, executionTag, newId } from "../ids.js";
import { scrubbedJSON } from "../execution/blobs.js";
import { ID_RE, preview } from "../execution/events.js";
import { integrationBranch } from "../execution/git.js";
import {
  capPathList,
  globsOverlap,
  decideLeaseRequest,
  leaseDrafts,
  leasesFor,
  matchGlob,
  normalizeGlob,
  normalizeLeasePaths,
  releaseLeases,
  staticPrefix,
  type LeaseDecision,
} from "../execution/leases.js";
import { estimateUsd } from "../execution/pricing.js";
import { REPORT_MAX_TOKENS, REPORT_MAX_USD } from "../usage/types.js";
import { openExecutionStore, type FileExecutionStore } from "../execution/store.js";
import { buildTaskCard } from "../execution/task-card.js";
import { cardLessons } from "../postmortem/lessons.js";
import type {
  AnyEvent,
  AnyEventDraft,
  BlackboardState,
  CommandSpec,
  Escalation,
  EventPayloads,
  EventSource,
  SandboxBackend,
} from "../execution/types.js";
import {
  checkLeaseCoverage,
  CommitRefusedError,
  commitLeasedPaths,
  diffForTask,
  ensureTaskWorktree,
  taskDiffSummary,
  taskStartPoint,
  taskWorktreePath,
  withCommitCheckout,
} from "../execution/worktrees.js";
import {
  adhocCommandId,
  DockerBackend,
  failureSignature,
  LocalBackend,
  runCommandSpec,
  runSandboxed,
  SANDBOX_ENV,
  selectBackend,
  tailForTool,
} from "../sandbox/index.js";
import { localSandboxAllowed } from "../sandbox/common.js";
import { batchChildren, openSubtasks, spawnSpecs, workerTasks, SUBTASK_TERMINAL, type SubtaskInput } from "../execution/swarms.js";
import { taskHeld } from "../execution/task-holds.js";
import { appendAudit } from "../security/audit.js";
import { normalizeRelPath, writeFileAtomic } from "../security/fs-safe.js";
import { scrub } from "../security/secrets.js";
import { agentTask, ensureAgentDir, newAgentToken, tokenSha256, writeAgentLeases } from "../workers/files.js";
import { sameDigest } from "../workers/token.js";
import {
  AWAIT_SUBTASKS,
  SPAWN_SUBTASKS,
  CLAIM_TASK,
  ESCALATE,
  JOIN_EXECUTION,
  LEASE,
  POST_UPDATE,
  READ_BLACKBOARD,
  RUN_COMMAND,
  SUBMIT_WORK,
} from "./names.js";
import { ORCHESTRATOR_ONLY, READ_ONLY_LOCAL, type ToolArgs, type ToolCallContext, type ToolDefinition, type ToolMode } from "./shared.js";
import type { JsonSchema } from "../validate.js";

// ============================================================================
// Schemas
// ============================================================================

const ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const EXECUTION_PATTERN = "^exe-[0-9a-hjkmnp-tv-z]{16}$";

/** Worker-tool annotations: local state only, never the open world. */
const WORKER_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const AUTH_PROPS: Record<string, JsonSchema> = {
  execution_id: { type: "string", pattern: EXECUTION_PATTERN, description: "The heads-down run (exe-…)." },
  agent_token: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The agent token join_execution returned (once)." },
};

type Schema = JsonSchema & { type: "object" };

/** A worker tool: listed on both servers; the orchestrator's copy also requires execution_id and agent_token. */
function workerTool(def: Omit<ToolDefinition, "modes" | "inputSchemaByMode">): ToolDefinition {
  const base = def.inputSchema;
  const orchestrator: Schema = {
    ...base,
    properties: { ...AUTH_PROPS, ...base.properties },
    required: ["execution_id", "agent_token", ...(base.required ?? [])],
  };
  return {
    ...def,
    description: def.description,
    modes: ["worker", "orchestrator"],
    inputSchemaByMode: { orchestrator },
  };
}

export const BLACKBOARD_SECTIONS = [
  "summary", "goal", "contract", "tasks", "task", "interfaces", "decisions", "leases", "claims", "files",
  "diffs", "checks", "escalations", "notes", "inbox", "budget", "agents", "teams", "events", "blob", "query",
] as const;

const POST_KINDS = ["progress", "note", "interface", "need", "ack", "usage"] as const;
/** Most one usage report may claim (usage-visibility.md §9): larger values are clamped and labelled as such. */
export const USAGE_REPORT_MAX_USD = REPORT_MAX_USD;
export const USAGE_REPORT_MAX_TOKENS = REPORT_MAX_TOKENS;
const ESCALATION_KINDS = ["blocker", "ambiguity", "resource", "conflict", "assistance", "emergency"] as const;
const ESCALATION_WITH = ["orchestrator", "management", "team", "agent", "path_owner"] as const;
const EMERGENCIES = ["money", "credentials", "scope", "human_action"] as const;

export const workerTools: ToolDefinition[] = [
  workerTool({
    name: READ_BLACKBOARD,
    description:
      "Read the shared blackboard of this heads-down run: what every task, team and agent is doing. section: summary (default), goal, contract, tasks, task (task_id, default yours), " +
      "interfaces, decisions, leases, claims, files, diffs, checks, escalations, notes, inbox, budget, agents, teams, events (filters: since_seq, limit, task_id, query = event type prefix), " +
      "blob (ref: a sha256:… ref from an event; redacted, at most 16 KB), or query: fuzzy matching over tasks, teams, paths and interfaces (\"is the nav done?\").",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        section: { type: "string", enum: [...BLACKBOARD_SECTIONS], description: "Default summary (query when only query is given, blob when only ref is)." },
        query: { type: "string", maxLength: 500, description: "Free text for section query or tasks/files filters; an event type prefix for events." },
        task_id: { type: "string", pattern: ID_PATTERN, description: "A task (task, checks, diffs, escalations and events filter on it)." },
        ref: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "Blob ref for section blob." },
        since_seq: { type: "integer", minimum: 0, description: "events and notes: only after this seq." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
      },
    },
    annotations: { title: "Read blackboard", ...READ_ONLY_LOCAL },
  }),
  workerTool({
    name: CLAIM_TASK,
    description:
      "External agents only: claim a ready task (all dependencies accepted, nobody holding it) or, with release: true, give yours back (its leases are released; the work stays in the worktree). " +
      "Without task_id, the first ready task (your team's first) is claimed. Returns the task card and the worktree to work in. External workers' claims expire after 15 minutes without a tool call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", pattern: ID_PATTERN },
        release: { type: "boolean", description: "Release your claim instead." },
        note: { type: "string", maxLength: 2000, description: "Why you release it (recorded)." },
      },
    },
    annotations: { title: "Claim task", ...WORKER_WRITE },
  }),
  workerTool({
    name: LEASE,
    description:
      "Request or release leases on repository paths (globs: **, * and ?; no braces). You may edit only what your leases cover; .git* metadata needs a lease that names it. " +
      "A request that conflicts with another agent's lease is queued (FIFO), and the response names the holders: then escalate(with: \"path_owner\"). release takes lease ids or globs (\"**\" releases all of yours).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "paths"],
      properties: {
        action: { type: "string", enum: ["request", "release"] },
        paths: { type: "array", items: { type: "string", maxLength: 512 }, maxItems: 64 },
        mode: { type: "string", enum: ["exclusive", "shared"], description: "Default exclusive. Shared leases conflict only with exclusive ones." },
        reason: { type: "string", maxLength: 500 },
      },
    },
    annotations: { title: "Lease paths", ...WORKER_WRITE },
  }),
  workerTool({
    name: POST_UPDATE,
    description:
      "Post to the blackboard. kind progress: percent and text. note: a broadcast note (topic, refs). interface: publish an interface you own (name, text = its definition, path), which unblocks tasks waiting on it. " +
      "need: say you are waiting for a task, interface or artifact (name; topic = task | interface | artifact), which blocks your task until it arrives. ack: acknowledge a directive (directive_id). " +
      "usage (external workers only): report what you have used since your last report (tokens, usd, model); it is recorded as reported, not measured, and counts toward the budget.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: [...POST_KINDS] },
        text: { type: "string", maxLength: 16000, description: "Required for every kind except usage." },
        tokens: {
          type: "object",
          additionalProperties: false,
          description: "usage: tokens used since your last report.",
          properties: {
            input: { type: "integer", minimum: 0 },
            output: { type: "integer", minimum: 0 },
            cache_read: { type: "integer", minimum: 0 },
            cache_write: { type: "integer", minimum: 0 },
          },
        },
        usd: { type: "number", minimum: 0, description: "usage: the cost in US dollars since your last report, if you know it (else it is priced from the table)." },
        model: { type: "string", maxLength: 200, description: "usage: the model that did the work." },
        percent: { type: "number", minimum: 0, maximum: 100 },
        topic: { type: "string", maxLength: 100 },
        name: { type: "string", maxLength: 200, description: "interface: its name; need: the task, interface or artifact you wait for." },
        owner: { type: "string", pattern: ID_PATTERN, description: "need: expected publishing task." },
        path: { type: "string", maxLength: 512, description: "interface: where it lives in the repository." },
        refs: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 20 },
        directive_id: { type: "string", maxLength: 100 },
      },
    },
    precheck: (a) => {
      if (a.kind !== "usage" && typeof a.text !== "string") throw new Error(`${POST_UPDATE}: kind ${String(a.kind)} needs "text"`);
      if (a.kind === "usage" && a.tokens === undefined && a.usd === undefined) throw new Error(`${POST_UPDATE}: kind usage needs "tokens" or "usd"`);
      if ((a.kind === "interface" || a.kind === "need") && typeof a.name !== "string") throw new Error(`${POST_UPDATE}: kind ${a.kind} needs "name"`);
      if (a.kind === "ack" && typeof a.directive_id !== "string") throw new Error(`${POST_UPDATE}: kind ack needs "directive_id"`);
    },
    annotations: { title: "Post update", ...WORKER_WRITE },
  }),
  workerTool({
    name: RUN_COMMAND,
    description:
      "Run a command in the sandbox, in your task worktree (there is no shell). command_id runs a contract command (recorded as a check of your task); argv runs an ad-hoc program with its arguments. " +
      "Returns the exit code, a failure signature and the last ~8 KB of output; the full output is stored as a blob (read_blackboard section blob).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command_id: { type: "string", pattern: ID_PATTERN, description: "A contract validation command." },
        argv: { type: "array", items: { type: "string", maxLength: 4096 }, maxItems: 256, description: "Program and arguments (no shell strings)." },
        timeout_s: { type: "number", minimum: 1, maximum: 900, description: "Default the command's own timeout, or 600 s for argv." },
      },
    },
    precheck: (a) => {
      if ((a.command_id === undefined) === (a.argv === undefined)) throw new Error(`${RUN_COMMAND}: pass exactly one of "command_id" and "argv"`);
      if (Array.isArray(a.argv) && a.argv.length === 0) throw new Error(`${RUN_COMMAND}: "argv" must not be empty`);
    },
    annotations: { title: "Run command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }),
  workerTool({
    name: SUBMIT_WORK,
    description:
      "Commit your leased changes and submit them. ready: true submits the task: the diff is recorded and your task's checks run in the sandbox (at most 15 minutes); " +
      "if they pass, the runner merges it; if one fails, fix it and submit again. Changes outside your leases reject the submission. ready: false only saves a checkpoint commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "ready"],
      properties: {
        summary: { type: "string", maxLength: 16000, description: "What you did: the commit message and the submission note." },
        ready: { type: "boolean" },
      },
    },
    annotations: { title: "Submit work", ...WORKER_WRITE },
  }),
  workerTool({
    name: ESCALATE,
    description:
      "Raise an escalation when you are blocked or something is unclear. kind: blocker, ambiguity, resource, conflict, assistance or emergency; with: orchestrator, management, team, agent or path_owner (target: the agent or path). " +
      "blocking: true blocks your task: end your turn with a one-line summary and you will be resumed with the resolution. emergency: money, credentials, scope or human_action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "with", "summary"],
      properties: {
        kind: { type: "string", enum: [...ESCALATION_KINDS] },
        with: { type: "string", enum: [...ESCALATION_WITH] },
        summary: { type: "string", maxLength: 4000 },
        target: { type: "string", maxLength: 200 },
        question: { type: "string", maxLength: 4000 },
        options: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 10 },
        diagnostics: {
          type: "object",
          additionalProperties: false,
          properties: {
            error_output: { type: "string", maxLength: 64000 },
            command_id: { type: "string", maxLength: 100 },
            files: { type: "array", items: { type: "string", maxLength: 512 }, maxItems: 200 },
            notes: { type: "string", maxLength: 8000 },
          },
        },
        blocking: { type: "boolean", description: "Default false." },
        emergency: { type: "string", enum: [...EMERGENCIES] },
      },
    },
    annotations: { title: "Escalate", ...WORKER_WRITE },
  }),
  workerTool({
    name: SPAWN_SUBTASKS,
    description: "Delegate 1–8 subtasks through the runner when the frozen contract enables swarms. Child ids are namespaced under yours. Paths must be within your current leases and must not overlap siblings. Children inherit your checks; only siblings in this call may be dependencies. Delegated paths are unavailable to you until the children finish. Subtasks cannot delegate.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["subtasks"],
      properties: {
        subtasks: {
          type: "array", minItems: 1, maxItems: 8,
          items: {
            type: "object", additionalProperties: false, required: ["id", "title", "instructions", "paths"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
              title: { type: "string", minLength: 1, maxLength: 200 },
              instructions: { type: "string", minLength: 1, maxLength: 4000 },
              paths: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 512 } },
              depends_on: { type: "array", maxItems: 8, items: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" } },
            },
          },
        },
      },
    },
    annotations: { title: "Spawn subtasks", ...WORKER_WRITE },
  }),
  workerTool({
    name: AWAIT_SUBTASKS,
    description: "Wait for your latest subtask batch (default 30 seconds, at most 120). Returns child states, scrubbed summaries, changed files and merge status. ready: true means every child merged and the runner brought integration into your worktree. When children are still running, call again. Failed or cancelled children are reported for you to retry with new ids or escalate.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { timeout_s: { type: "number", minimum: 0, maximum: 120 } },
    },
    annotations: { title: "Await subtasks", ...WORKER_WRITE },
  }),
  {
    name: JOIN_EXECUTION,
    description:
      "Register an external worker (for example this chat, or another host) in a heads-down run. Returns an agent_token ONCE: pass it with execution_id to every worker tool " +
      "(read_blackboard, claim_task, lease, post_update, run_command, submit_work, escalate, spawn_subtasks, await_subtasks). With task_id, the task's worktree is created (or reused) and its task card returned. " +
      "External workers are not sandboxed: their leases are checked when they submit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["execution_id", "agent"],
      properties: {
        execution_id: { type: "string", pattern: EXECUTION_PATTERN },
        agent: { type: "string", pattern: ID_PATTERN, description: "Your agent id in the run." },
        team: { type: "string", maxLength: 64, description: "An existing team of the contract." },
        task_id: { type: "string", pattern: ID_PATTERN },
      },
    },
    modes: ORCHESTRATOR_ONLY,
    annotations: { title: "Join execution", ...WORKER_WRITE },
  },
];

// ============================================================================
// Identity
// ============================================================================

interface Actor {
  store: FileExecutionStore;
  execution: string;
  agent: string;
}

let bound: (Actor & { tokenSha256: string }) | undefined;

/** Bind this process's worker tools to the identity a worker token proved (the worker server, at startup). */
export function bindWorkerIdentity(identity: { store: FileExecutionStore; execution: string; agent: string; tokenSha256: string }): void {
  bound = { ...identity };
}

const stores = new Map<string, Promise<FileExecutionStore>>();
const sandboxes = new Map<string, Promise<{ backend: SandboxBackend; degraded?: string }>>();

/** Forget the binding and caches (tests). */
export function resetWorkerTools(): void {
  bound = undefined;
  stores.clear();
  sandboxes.clear();
}

function storeFor(execution: string): Promise<FileExecutionStore> {
  if (bound?.execution === execution) return Promise.resolve(bound.store);
  let p = stores.get(execution);
  if (!p) {
    p = openExecutionStore(execution);
    stores.set(execution, p);
    p.catch(() => stores.delete(execution));
  }
  return p;
}

const own = <T>(rec: Record<string, T>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

async function resolveActor(args: Record<string, unknown>, mode: ToolMode): Promise<Actor> {
  if (mode === "worker") {
    if (!bound) throw new Error("This worker server has no identity");
    const rec = own((await bound.store.state()).agents, bound.agent);
    if (!rec || rec.status === "left") throw new Error(`Agent ${bound.agent} is no longer part of ${bound.execution}`);
    if (!sameDigest(rec.token_sha256, bound.tokenSha256)) {
      throw new Error(`Agent ${bound.agent} was registered again since this worker started; this worker must stop`);
    }
    return bound;
  }
  const execution = String(args.execution_id);
  if (!EXECUTION_ID_RE.test(execution)) throw new Error(`Not an execution id: ${preview(execution)}`);
  const store = await storeFor(execution);
  const sha = tokenSha256(String(args.agent_token));
  for (const rec of Object.values((await store.state()).agents)) {
    if (!sameDigest(rec.token_sha256, sha)) continue;
    if (rec.status === "left") throw new Error(`Agent ${rec.id} has left ${execution}`);
    return { store, execution, agent: rec.id };
  }
  throw new Error(`agent_token does not belong to any agent of ${execution}`);
}

/** Reuse the token-bound identity for draft contract tools; never accept a caller-supplied agent id. */
export { resolveActor as resolveWorkerActor };

function sourceOf(state: Readonly<BlackboardState>, a: Actor, task?: string): EventSource {
  const team = own(state.agents, a.agent)?.team ?? own(state.tasks, task)?.spec.team;
  return { kind: "agent", id: a.agent, ...(team !== undefined && { team }), ...(task !== undefined && { task }), pid: process.pid };
}

class Refusal extends Error {}

function requireTask(state: Readonly<BlackboardState>, a: Actor): string {
  const task = agentTask(state, a.agent);
  if (!task || !own(state.tasks, task)) throw new Refusal("You hold no task: claim one with claim_task");
  return task;
}

const TERMINAL_RUN = new Set(["completed", "failed", "aborted"]);

function requireActive(state: Readonly<BlackboardState>, task?: string): void {
  if (TERMINAL_RUN.has(state.status)) throw new Refusal(`The run is ${state.status}`);
  if (state.status === "paused") throw new Refusal("The run is paused; wait for it to resume");
  if (task && state.paused_tasks.includes(task)) throw new Refusal(`Task ${task} is paused; wait for it to resume`);
  if (taskHeld(state, task, true)) throw new Refusal(`Task ${task} is held by an escalation; wait for resolution`);
}

// ============================================================================
// Responses, heartbeat and the inbox
// ============================================================================

type Json = Record<string, unknown>;

function cap(text: unknown, max: number): string {
  const t = scrub(typeof text === "string" ? text : String(text ?? ""));
  return t.length <= max ? t : `${t.slice(0, max)}… [truncated]`;
}

const RESPONSE_MAX = 96 * 1024;

function render(body: Json, isError = false): CallToolResult {
  const { inbox, ...sections } = body;
  const response: Json = inbox === undefined ? {} : { inbox };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  for (const [key, value] of Object.entries(sections)) {
    if (size({ ...response, [key]: value }) <= RESPONSE_MAX - 128) {
      response[key] = value;
      continue;
    }
    response.truncated = "Narrow the other sections with limit, task_id or query";
    if (Array.isArray(value)) {
      const kept: unknown[] = [];
      response[key] = kept;
      for (const item of value) {
        kept.push(item);
        if (size(response) > RESPONSE_MAX - 128) { kept.pop(); break; }
      }
    }
  }
  if (Array.isArray(response.events) && response.events.length && "next_since_seq" in response) {
    response.next_since_seq = (response.events.at(-1) as Json).seq;
  }
  const text = JSON.stringify(response);
  return { content: [{ type: "text", text: isError ? `Error: ${text}` : text }], ...(isError && { isError: true }) };
}

function heartbeat(a: Actor): void {
  try {
    writeFileAtomic(join(ensureAgentDir(a.execution, a.agent), "heartbeat"), new Date().toISOString() + "\n");
  } catch (e) {
    console.error(`[Worker] heartbeat for ${a.agent} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface InboxDelivery {
  inbox: Json;
  delivered: () => void;
}

/** Build a bounded oldest-first page. The cursor is committed only after rendering succeeds. */
async function takeInbox(a: Actor): Promise<InboxDelivery | undefined> {
  const state = await a.store.state();
  const items = own(state.inbox, a.agent) ?? [];
  if (!items.length) return undefined;
  const path = join(ensureAgentDir(a.execution, a.agent), "inbox.cursor");
  let cursor = 0;
  try {
    cursor = Number.parseInt(readFileSync(path, "utf8"), 10) || 0;
  } catch {
    /* first delivery */
  }
  const fresh = items.filter((i) => i.seq > cursor).sort((x, y) => x.seq - y.seq);
  const awaiting = items.filter((i) => i.kind === "directive" && i.requires_ack);
  if (!fresh.length && !awaiting.length) return undefined;
  const inbox: Json = {};
  const page: unknown[] = [];
  for (const item of fresh) {
    page.push(item);
    if (Buffer.byteLength(JSON.stringify(page)) > RESPONSE_MAX / 2) { page.pop(); break; }
    cursor = item.seq;
  }
  if (page.length) inbox.new = page;
  if (page.length < fresh.length) inbox.more = true;
  const acks: unknown[] = [];
  for (const item of awaiting) {
    acks.push({ id: item.id, text: item.text });
    if (Buffer.byteLength(JSON.stringify(acks)) > RESPONSE_MAX / 4) { acks.pop(); break; }
  }
  if (acks.length) inbox.awaiting_ack = acks;
  if (acks.length < awaiting.length) inbox.more_awaiting_ack = true;
  return {
    inbox,
    delivered: () => {
      if (!page.length) return;
      let previous = 0;
      try { previous = Number.parseInt(readFileSync(path, "utf8"), 10) || 0; } catch { /* first delivery */ }
      writeFileAtomic(path, `${Math.max(previous, cursor)}\n`);
    },
  };
}

// ============================================================================
// Sandbox
// ============================================================================

/** One backend per execution and process, chosen once; sandbox.degraded is emitted when the choice is weaker than docker. */
async function sandboxFor(a: Actor): Promise<SandboxBackend> {
  let p = sandboxes.get(a.execution);
  if (!p) {
    p = (async () => {
      const state = await a.store.state();
      const c = state.contract;
      // execute records the human's opt-in to the local sandbox; the worker server has no .env to read it from.
      const started = (await a.store.events({ types: ["execution.started"], limit: 1 }))[0];
      const optedIn = started?.type === "execution.started" && started.payload.sandbox === "local";
      const allowLocal = localSandboxAllowed() || optedIn;
      const sel = await selectBackend({
        preferred: c?.sandbox.backend,
        allowLocal,
        docker: new DockerBackend({ executionTag: executionTag(a.execution), ...(c?.sandbox.image && { image: c.sandbox.image }) }),
        ...(allowLocal && { local: new LocalBackend({ env: { ...process.env, [SANDBOX_ENV.ALLOW_LOCAL]: "1" } }) }),
      });
      if (sel.degraded) {
        await a.store.transact(({ state: s }) => ({
          events: [{ type: "sandbox.degraded", source: sourceOf(s, a, agentTask(s, a.agent)), payload: { backend: sel.backend.id, reason: cap(sel.degraded, 2000) } }],
        }));
      }
      return sel;
    })();
    sandboxes.set(a.execution, p);
    p.catch(() => sandboxes.delete(a.execution));
  }
  return (await p).backend;
}

function worktreeOf(a: Actor, task: string): string {
  const wt = taskWorktreePath(a.execution, task);
  if (!existsSync(wt)) throw new Refusal(`The worktree of ${task} does not exist yet`);
  return wt;
}

interface CheckOutcome {
  command_id: string;
  /** The submitted commit a submission check ran on (run_command checks run in the worktree). */
  commit?: string;
  status: "passed" | "failed" | "timed_out";
  exit: number | null;
  duration_ms: number;
  signature?: string;
  output_blob: string;
  output_tail: string;
}

/** The submission a check belongs to: its task.submitted seq and commit. */
interface CheckBinding {
  submitted_seq: number;
  commit: string;
}

/**
 * Run one contract command as a check of `task`: check.started, then check.passed / failed /
 * timed_out. No sandbox is not a failed check: it throws before anything is recorded. A
 * submission's checks run in `workdir` (the checkout of its commit) and their events carry the
 * binding; run_command's run in the worktree.
 */
async function runCheck(
  a: Actor,
  task: string,
  spec: CommandSpec | undefined,
  commandId: string,
  opts: { maxTimeoutMs: number; signal?: AbortSignal; image?: string; workdir?: string; bind?: CheckBinding }
): Promise<CheckOutcome> {
  const backend = await sandboxFor(a);
  const workdir = opts.workdir ?? worktreeOf(a, task);
  const bind = opts.bind ?? {};
  const at = opts.bind ? { commit: opts.bind.commit } : {};
  const emit = (draft: (s: EventSource) => AnyEventDraft) => a.store.transact(({ state }) => ({ events: [draft(sourceOf(state, a, task))] }));
  await emit((source) => ({ type: "check.started", source, payload: { command_id: commandId, scope: "task", task, ...bind } }));
  let output: string;
  let exit: number | null;
  let timedOut = false;
  let duration = 0;
  if (!spec) {
    output = `The contract defines no command ${commandId}`;
    exit = null;
  } else {
    try {
      const r = await runCommandSpec(backend, spec, workdir, { maxTimeoutMs: opts.maxTimeoutMs, signal: opts.signal, image: opts.image });
      ({ output, exit, timedOut, durationMs: duration } = r);
    } catch (e) {
      output = scrub(e instanceof Error ? e.message : String(e));
      exit = null;
    }
  }
  const blob = await a.store.putBlob(output || "(no output)");
  const tail = tailForTool(output);
  if (timedOut) {
    await emit((source) => ({ type: "check.timed_out", source, payload: { command_id: commandId, scope: "task", task, ...bind } }));
    return { command_id: commandId, ...at, status: "timed_out", exit, duration_ms: duration, output_blob: blob, output_tail: tail };
  }
  if (exit === 0) {
    await emit((source) => ({ type: "check.passed", source, payload: { command_id: commandId, scope: "task", task, duration_ms: duration, ...bind } }));
    return { command_id: commandId, ...at, status: "passed", exit, duration_ms: duration, output_blob: blob, output_tail: tail };
  }
  const signature = failureSignature(commandId, output);
  await emit((source) => ({ type: "check.failed", source, payload: { command_id: commandId, scope: "task", task, exit, signature, output_blob: blob, ...bind } }));
  return { command_id: commandId, ...at, status: "failed", exit, duration_ms: duration, signature, output_blob: blob, output_tail: tail };
}

// ============================================================================
// read_blackboard
// ============================================================================

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "of", "to", "in", "on", "for", "and", "or", "it", "its", "done", "yet",
  "status", "what", "whats", "how", "about", "with", "has", "have", "did", "does", "do", "ready", "finished", "complete", "completed",
  "progress", "there", "any", "which", "who", "task", "tasks", "team", "where", "when", "we", "our", "my", "me", "can", "will", "still",
]);

const words = (s: string | undefined) => (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const queryTokens = (q: string) => {
  const all = words(q).filter((t) => t.length >= 2);
  const meaningful = all.filter((t) => !STOP_WORDS.has(t));
  return meaningful.length ? meaningful : all;
};

function score(tokens: string[], vocab: string[]): number {
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const w of vocab) {
      if (w === t) best = Math.max(best, 3);
      else if (t.length >= 3 && w.length >= 3 && (w.startsWith(t) || t.startsWith(w))) best = Math.max(best, 2);
      else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 1);
    }
    total += best;
  }
  return total;
}

const globWords = (globs: readonly string[]) => globs.flatMap((g) => words(g.replace(/\*+|\?/g, " ")));

function fuzzyQuery(state: Readonly<BlackboardState>, q: string, limit: number): Json {
  const tokens = queryTokens(q);
  if (!tokens.length) return { query: q, matches: [], note: "No searchable words in the query" };
  const hits: Array<{ score: number; item: Json }> = [];
  for (const rt of Object.values(state.tasks)) {
    const s = score(tokens, [...words(rt.spec.id), ...words(rt.spec.title), ...words(rt.spec.team), ...globWords(rt.spec.paths.write)]);
    if (s > 0) {
      hits.push({
        score: s,
        item: {
          kind: "task", id: rt.spec.id, title: cap(rt.spec.title, 200), team: rt.spec.team, state: rt.state,
          done: rt.state === "accepted", percent: rt.percent, agent: rt.agent, last_note: rt.last_note ? cap(rt.last_note, 300) : undefined,
        },
      });
    }
  }
  for (const [name, i] of Object.entries(state.interfaces)) {
    const s = score(tokens, [...words(name), ...words(i.spec?.description), ...words(i.spec?.owner), ...words(i.path)]);
    if (s > 0) {
      const owner = i.spec?.owner ?? i.task;
      hits.push({ score: s, item: { kind: "interface", name, owner, version: i.version, published: i.version > 0, owner_state: own(state.tasks, owner)?.state, path: i.path } });
    }
  }
  for (const [id, t] of Object.entries(state.teams)) {
    const s = score(tokens, [...words(id), ...t.members.flatMap(words)]);
    if (s > 0) {
      const tasks = Object.values(state.tasks).filter((rt) => rt.spec.team === id).map((rt) => ({ id: rt.spec.id, state: rt.state }));
      hits.push({ score: s, item: { kind: "team", id, lead: t.lead, members: t.members, tasks, done: tasks.length > 0 && tasks.every((x) => x.state === "accepted") } });
    }
  }
  hits.sort((x, y) => y.score - x.score);
  const matches = hits.slice(0, Math.min(limit, 20)).map((h) => ({ ...h.item, score: h.score }));
  const best = matches[0] as Json | undefined;
  let answer: string | undefined;
  if (best?.kind === "task") answer = `Task ${best.id} is ${best.state}${typeof best.percent === "number" && best.state !== "accepted" ? ` (${best.percent}%)` : ""}.`;
  else if (best?.kind === "interface") answer = `Interface ${best.name} is ${best.published ? `published (version ${best.version})` : "not published yet"}.`;
  else if (best?.kind === "team") answer = `Team ${best.id}: ${(best.tasks as Json[]).map((t) => `${t.id} ${t.state}`).join(", ") || "no tasks"}.`;
  return { query: q, tokens, ...(answer && { answer }), matches };
}

function compactEvent(e: AnyEvent): Json {
  const p = { ...e.payload } as Json;
  if (e.type === "agent.registered") delete p.token_sha256;
  let payload: unknown = p;
  const text = JSON.stringify(p);
  if (text.length > 1500) payload = { truncated: `${text.slice(0, 1500)}…` };
  return { seq: e.seq, ts: e.ts, type: e.type, source: `${e.source.kind}:${e.source.id}`, task: (p.task as string | undefined) ?? e.source.task, payload };
}

function taskView(state: Readonly<BlackboardState>, id: string): Json {
  const rt = own(state.tasks, id);
  if (!rt) throw new Refusal(`Unknown task ${preview(id)}`);
  const checks = Object.fromEntries(Object.entries(state.checks.task).filter(([k]) => k.startsWith(`${id}/`)));
  return {
    id,
    spec: rt.spec,
    children: Object.values(state.tasks).filter((child) => child.spec.parent === id).map((child) => ({ id: child.spec.id, state: child.state })),
    state: rt.state,
    attempt: rt.attempt,
    agent: rt.agent,
    percent: rt.percent,
    last_note: rt.last_note,
    blocked_by: rt.blocked_by,
    last_commit: rt.last_commit,
    claim: own(state.claims, id),
    leases: leasesFor(state, id).map((l) => ({ id: l.id, agent: l.agent, paths: l.paths, ...(l.excludes && { excludes: l.excludes }), mode: l.mode })),
    diff: own(state.diffs, id),
    checks,
    files: Object.entries(state.files).filter(([, f]) => f.task === id).map(([p]) => p).slice(0, 200),
  };
}

async function readBlackboard(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const state = await a.store.state();
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const q = typeof args.query === "string" ? args.query : undefined;
  const taskFilter = typeof args.task_id === "string" ? args.task_id : undefined;
  const section = (args.section as string | undefined) ?? (q ? "query" : args.ref ? "blob" : "summary");
  const mine = agentTask(state, a.agent);
  const c = state.contract;
  const matches = (s: string | undefined) => !q || (s ?? "").toLowerCase().includes(q.toLowerCase());

  switch (section) {
    case "summary": {
      const counts: Record<string, number> = {};
      for (const rt of Object.values(state.tasks)) counts[rt.state] = (counts[rt.state] ?? 0) + 1;
      const mineRt = own(state.tasks, mine);
      return {
        section,
        execution: state.execution,
        status: state.status,
        seq: state.seq,
        goal: state.goal ? cap(state.goal.ultimate, 1000) : undefined,
        you: {
          agent: a.agent,
          task: mine,
          state: mineRt?.state,
          percent: mineRt?.percent,
          leases: mine ? leasesFor(state, mine, a.agent).map((l) => ({ id: l.id, paths: l.paths, ...(l.excludes && { excludes: l.excludes }), mode: l.mode })) : [],
        },
        tasks: {
          counts,
          list: Object.values(state.tasks).slice(0, limit).map((rt) => ({ id: rt.spec.id, title: cap(rt.spec.title, 120), team: rt.spec.team, state: rt.state, percent: rt.percent, agent: rt.agent })),
        },
        open_escalations: Object.values(state.escalations).filter((e) => !["resolved", "withdrawn"].includes(e.status)).length,
        budget: { spent_usd: state.budget.spent_usd, budget_usd: c?.budget.usd },
      };
    }
    case "goal":
      return { section, goal: state.goal ? { ...state.goal, ultimate: cap(state.goal.ultimate, 4000), original_prompt: cap(state.goal.original_prompt, 8000) } : null };
    case "contract":
      if (!c) return { section, contract: null };
      return {
        section,
        contract: {
          id: c.id, version: c.version, status: c.status, title: c.title, orchestrator: c.scope.orchestrator, scope_paths: c.scope.paths,
          teams: c.teams, tasks: c.tasks.map((t) => ({ id: t.id, title: t.title, team: t.team, kind: t.kind, depends_on: t.depends_on, write: t.paths.write, checks: t.checks })),
          interfaces: c.interfaces, decisions: c.decisions, commands: c.validation.commands.map((x) => ({ id: x.id, argv: x.argv, cwd: x.cwd, timeout_s: x.timeout_s })),
          final_checks: c.validation.final, budget: c.budget, authority: c.authority,
        },
      };
    case "tasks":
      return {
        section,
        tasks: Object.values(state.tasks)
          .filter((rt) => matches(`${rt.spec.id} ${rt.spec.title} ${rt.spec.team ?? ""}`))
          .slice(0, limit)
          .map((rt) => ({ id: rt.spec.id, title: cap(rt.spec.title, 200), team: rt.spec.team, state: rt.state, percent: rt.percent, agent: rt.agent, depends_on: rt.spec.depends_on, last_note: rt.last_note ? cap(rt.last_note, 300) : undefined })),
      };
    case "task": {
      const id = taskFilter ?? mine;
      if (!id) throw new Refusal("Pass task_id (you hold no task)");
      return { section, task: taskView(state, id) };
    }
    case "interfaces":
      return { section, interfaces: Object.entries(state.interfaces).filter(([n]) => matches(n)).slice(0, limit).map(([name, i]) => ({ name, ...i })) };
    case "decisions":
      return { section, decisions: state.decisions.slice(-limit) };
    case "leases":
      return { section, leases: Object.values(state.tasks).flatMap((rt) => leasesFor(state, rt.spec.id)).filter((l) => !taskFilter || l.task === taskFilter).slice(0, limit), queue: state.lease_queue.slice(0, limit) };
    case "claims":
      return { section, claims: Object.values(state.claims).slice(0, limit) };
    case "files":
      return { section, files: Object.entries(state.files).filter(([p, f]) => matches(p) && (!taskFilter || f.task === taskFilter)).slice(0, limit).map(([path, f]) => ({ path, ...f })) };
    case "diffs":
      return { section, diffs: Object.entries(state.diffs).filter(([t]) => !taskFilter || t === taskFilter).slice(0, limit).map(([task, d]) => ({ task, ...d })) };
    case "checks":
      return {
        section,
        task: Object.fromEntries(Object.entries(state.checks.task).filter(([k]) => !taskFilter || k.startsWith(`${taskFilter}/`)).slice(0, limit)),
        integration: state.checks.integration,
      };
    case "escalations":
      return {
        section,
        escalations: Object.values(state.escalations)
          .filter((e) => !taskFilter || e.task === taskFilter)
          .sort((x, y) => Number(["resolved", "withdrawn"].includes(x.status)) - Number(["resolved", "withdrawn"].includes(y.status)) || y.raised_seq - x.raised_seq)
          .slice(0, limit),
      };
    case "notes": {
      const since = typeof args.since_seq === "number" ? args.since_seq : 0;
      return { section, notes: state.notes.filter((n) => n.seq > since && matches(`${n.topic} ${n.text}`)).slice(-limit) };
    }
    case "inbox":
      return { section, items: (own(state.inbox, a.agent) ?? []).slice(-limit) };
    case "budget":
      return { section, budget: state.budget, contract_budget: c?.budget };
    case "agents":
      return { section, agents: Object.values(state.agents).slice(0, limit).map(({ token_sha256: _t, ...rest }) => rest) };
    case "teams":
      return { section, teams: state.teams };
    case "events": {
      const since = typeof args.since_seq === "number" ? args.since_seq : Math.max(0, state.seq - 1000);
      const all = await a.store.events({ sinceSeq: since });
      const picked = all.filter((e) => (!q || e.type.startsWith(q)) && (!taskFilter || (e.payload as Json).task === taskFilter || e.source.task === taskFilter));
      const page = typeof args.since_seq === "number" ? picked.slice(0, limit) : picked.slice(-limit);
      return { section, events: page.map(compactEvent), ...(page.length && { next_since_seq: page[page.length - 1].seq }) };
    }
    case "blob": {
      if (typeof args.ref !== "string") throw new Refusal("Pass ref (a sha256:… blob ref)");
      const buf = await a.store.getBlob(args.ref);
      const text = scrub(buf.toString("utf8"));
      const max = 16 * 1024;
      return { section, ref: args.ref, bytes: buf.length, truncated: text.length > max, text: text.length > max ? text.slice(0, max) : text };
    }
    case "query":
      if (!q) throw new Refusal("Pass query");
      return { section, ...fuzzyQuery(state, q, limit) };
    default:
      throw new Refusal(`Unknown section ${preview(section)}`);
  }
}

// ============================================================================
// claim_task
// ============================================================================

const depsAccepted = (state: Readonly<BlackboardState>, task: string) =>
  (own(state.tasks, task)?.spec.depends_on ?? []).every((d) => own(state.tasks, d)?.state === "accepted");

function claimProblem(state: Readonly<BlackboardState>, task: string): string | null {
  const rt = own(state.tasks, task);
  if (!rt) return `Unknown task ${preview(task)}`;
  if (own(state.claims, task)) return `Task ${task} is already claimed by ${state.claims[task].agent}`;
  if (rt.state !== "ready") return `Task ${task} is ${rt.state}, not ready`;
  if (!depsAccepted(state, task)) return `Task ${task} still waits on dependencies`;
  if (state.contract?.budget.max_agents !== undefined && workerTasks(state).size >= state.contract.budget.max_agents) return "max_agents workers already run";
  if (state.paused_tasks.includes(task)) return `Task ${task} is paused`;
  return null;
}

async function claimTask(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const state = await a.store.state();
  const rec = own(state.agents, a.agent);
  const externalOnly = (s: Readonly<BlackboardState>) => {
    if (!own(s.agents, a.agent)?.external) throw new Refusal("The runner manages your assignment; only external agents may claim or release tasks");
  };
  externalOnly(state);
  if (args.release === true) {
    const task = agentTask(state, a.agent);
    if (task && openSubtasks(state, task)) throw new Refusal("Your task has open subtasks; await_subtasks before releasing it");
    if (!task || own(state.claims, task)?.agent !== a.agent) throw new Refusal("You hold no claim to release");
    const r = await a.store.transact(({ state: s }) => {
      externalOnly(s);
      if (own(s.claims, task)?.agent !== a.agent) throw new Refusal(`You no longer hold ${task}`);
      const source = sourceOf(s, a, task);
      const note = typeof args.note === "string" && args.note.trim() ? { note: cap(args.note, 2000) } : {};
      return { events: [{ type: "task.released", source, payload: { task, agent: a.agent, ...note } }, ...releaseLeases(s, { agent: a.agent, task }, source)] };
    });
    await refreshLeaseFiles(a, r.events);
    return { released: task, note: "Your work stays in the worktree; the task is ready for someone else." };
  }
  requireActive(state);
  if (state.status !== "running") throw new Refusal(`The run is ${state.status}; tasks can be claimed once it is running`);
  const held = agentTask(state, a.agent);
  if (held) throw new Refusal(`You already hold ${held}; finish it or release it first`);
  let task = typeof args.task_id === "string" ? args.task_id : undefined;
  if (!task) {
    const ready = Object.values(state.tasks).filter((rt) => claimProblem(state, rt.spec.id) === null);
    task = (ready.find((rt) => rec?.team !== undefined && rt.spec.team === rec.team) ?? ready[0])?.spec.id;
    if (!task) throw new Refusal("No task is ready to claim");
  }
  const problem = claimProblem(state, task);
  if (problem) throw new Refusal(problem);
  const wt = await ensureTaskWorktree(a.store.header(), task, taskStartPoint(state, task));
  const claimedTask = task;
  await a.store.transact(({ state: s }) => {
    externalOnly(s);
    requireActive(s, claimedTask);
    if (s.status !== "running") throw new Refusal(`The run is ${s.status}`);
    const held = agentTask(s, a.agent);
    if (held) throw new Refusal(`You already hold ${held}; finish it or release it first`);
    const p = claimProblem(s, claimedTask);
    if (p) throw new Refusal(p);
    const rt = s.tasks[claimedTask];
    return {
      events: [{ type: "task.claimed", source: sourceOf(s, a, claimedTask), payload: { task: claimedTask, agent: a.agent, attempt: Math.max(1, rt.attempt), ttl_s: 900 } }],
    };
  });
  await writeAgentLeases(a.store, a.agent, { task: claimedTask });
  const after = await a.store.state();
  return {
    claimed: claimedTask,
    worktree: wt.path,
    branch: wt.branch,
    task_card: buildTaskCard(after, claimedTask, { external: own(after.agents, a.agent)?.external !== false, worktree: wt.path, ...cardLessons(after, claimedTask) }),
  };
}

// ============================================================================
// lease
// ============================================================================

/**
 * Whether every path a lease glob can match lies inside a scope glob. Conservative: the same glob,
 * anything under a `dir/**` scope, or a literal path the scope glob matches.
 */
export function globWithin(glob: string, scopeGlob: string): boolean {
  const s = normalizeGlob(scopeGlob);
  const g = normalizeGlob(glob);
  if (!s || !g) return false;
  if (s === g || s === "**") return true;
  const sp = staticPrefix(s);
  if (sp && s === `${sp}/**`) return g.startsWith(`${sp}/`);
  return !/[*?]/.test(g) && matchGlob(s, g);
}

const withinAny = (glob: string, scope: readonly string[]) => scope.some((s) => globWithin(glob, s));

/** Rewrite leases.json for the caller and for every agent these events granted a lease to. */
async function refreshLeaseFiles(a: Actor, events: readonly AnyEvent[]): Promise<void> {
  const agents = new Set<string>([a.agent]);
  for (const e of events) if (e.type === "lease.granted") agents.add(e.payload.lease.agent);
  for (const agent of agents) {
    if (!ID_RE.test(agent)) continue;
    try {
      await writeAgentLeases(a.store, agent);
    } catch (e) {
      console.error(`[Worker] could not write leases.json for ${agent}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function lease(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const state = await a.store.state();
  const task = requireTask(state, a);
  const paths = (args.paths as string[]).map((p) => p.trim());
  if (args.action === "release") {
    const all = paths.includes("**") || paths.includes("*");
    const ids = new Set(paths.filter((p) => p.startsWith("lease-")));
    const globs = new Set(paths.map((p) => normalizeGlob(p)).filter((g): g is string => !!g));
    const r = await a.store.transact(({ state: s }) => {
      const pick = (x: { id: string; paths: readonly string[] }) => all || ids.has(x.id) || x.paths.some((p) => globs.has(p));
      const chosen = [
        ...leasesFor(s, task, a.agent).filter(pick).map((l) => l.id),
        ...s.lease_queue.filter((q) => q.agent === a.agent && q.task === task).filter(pick).map((q) => q.id),
      ];
      if (!chosen.length) return { events: [], result: [] as string[] };
      const delegated = batchChildren(s, task).filter((rt) => !SUBTASK_TERMINAL.has(rt.state)).flatMap((rt) => rt.spec.paths.write);
      if (leasesFor(s, task, a.agent).filter((l) => chosen.includes(l.id)).some((l) => l.paths.some((p) => delegated.some((g) => globsOverlap(p, g))))) throw new Refusal("Your leases reserve delegated paths until the subtasks finish; await_subtasks before releasing them");
      return { events: releaseLeases(s, { agent: a.agent, task, ids: chosen }, sourceOf(s, a, task)), result: chosen };
    });
    await refreshLeaseFiles(a, r.events);
    const granted = r.events.filter((e) => e.type === "lease.granted").map((e) => (e as AnyEvent & { type: "lease.granted" }).payload.lease.id);
    return { released: r.result ?? [], ...(granted.length && { granted_to_waiting: granted }) };
  }

  requireActive(state, task);
  let normalized: string[];
  try {
    normalized = normalizeLeasePaths(paths);
  } catch (e) {
    throw new Refusal((e as Error).message);
  }
  const modules = normalized.filter((g) => g.split("/").some((s) => s.toLowerCase() === ".gitmodules"));
  if (modules.length) throw new Refusal(`${modules.join(", ")}: .gitmodules is never writable by a worker (submodules are not supported)`);
  const c = state.contract;
  const scope = c?.scope.paths ?? [];
  const outside = scope.length ? normalized.filter((g) => !withinAny(g, scope)) : [];
  if (outside.length) {
    throw new Refusal(`${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the contract's scope (${scope.join(", ")}); escalate(with: "orchestrator") if you need ${outside.length === 1 ? "it" : "them"}`);
  }
  const write = own(state.tasks, task)?.spec.paths.write ?? [];
  const beyondTask = normalized.filter((g) => !withinAny(g, write));
  const mode = (args.mode as "exclusive" | "shared" | undefined) ?? "exclusive";
  const reason = typeof args.reason === "string" ? cap(args.reason, 500) : "";
  const r = await a.store.transact<LeaseDecision>(({ state: s }) => {
    let d: LeaseDecision;
    try { d = decideLeaseRequest(s, { agent: a.agent, task, paths: normalized, mode, reason }); }
    catch (e) { throw new Refusal((e as Error).message); }
    const source = sourceOf(s, a, task);
    const events: AnyEventDraft[] = "grant" in d ? (d.existing ? [] : [leaseDrafts.granted(d.grant, source)]) : [leaseDrafts.queued(d.queue, source)];
    return { events, result: d };
  });
  await refreshLeaseFiles(a, r.events);
  const d = r.result!;
  const warn = beyondTask.length ? { warning: `${beyondTask.join(", ")} ${beyondTask.length === 1 ? "is" : "are"} outside your task's write scope; keep such changes minimal` } : {};
  if ("grant" in d) return { granted: true, lease: { id: d.grant.id, paths: d.grant.paths, mode: d.grant.mode }, ...(d.existing && { existing: true }), ...warn };
  return {
    granted: false,
    queued: true,
    request_id: d.queue.id,
    holders: d.holders,
    suggestion: `Wait, or escalate(kind: "conflict", with: "path_owner", target: "${d.holders[0]?.agent ?? ""}", summary: what you need and why). You get the lease when the holders release theirs.`,
    ...warn,
  };
}

// ============================================================================
// post_update
// ============================================================================

function publicationAvailable(state: Readonly<BlackboardState>, name: string, expectedOwner?: string): boolean {
  const cur = own(state.interfaces, name);
  const owner = cur?.spec?.owner ?? cur?.task;
  return !!cur && cur.version > 0 && !!owner && cur.task === owner && (!expectedOwner || expectedOwner === owner);
}

const SATISFYING_KINDS: Record<string, ReadonlySet<string>> = {
  interface: new Set(["interface", "artifact"]),
};

/** Open dependency.requested events (not yet satisfied) whose need this ref and kind meet. */
async function waitingOn(a: Actor, ref: string, kinds: ReadonlySet<string>): Promise<Array<EventPayloads["dependency.requested"]>> {
  const events = await a.store.events({ types: ["dependency.requested", "dependency.satisfied"] });
  const open = new Map<string, EventPayloads["dependency.requested"]>();
  for (const e of events) {
    if (e.type === "dependency.requested" && e.payload.need.ref === ref && kinds.has(e.payload.need.kind)) open.set(`${e.payload.task}\0${e.payload.need.kind}`, e.payload);
    if (e.type === "dependency.satisfied" && e.payload.need.ref === ref) open.delete(`${e.payload.task}\0${e.payload.need.kind}`);
  }
  return [...open.values()];
}

/** A non-negative finite number no larger than `max`, and whether it had to be cut. */
function clampReport(v: unknown, max: number): { value: number; clamped: boolean } {
  const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  return n > max ? { value: max, clamped: true } : { value: n, clamped: false };
}

/** post_update kind usage: an external worker reports its own spend (reported, never measured). */
async function postUsage(a: Actor, state: Readonly<BlackboardState>, args: Record<string, unknown>): Promise<Json> {
  const rec = own(state.agents, a.agent);
  if (!rec?.external) {
    throw new Refusal("Only external workers report their own usage: the runner measures the usage of the workers it starts");
  }
  const task = agentTask(state, a.agent);
  const raw = (args.tokens ?? {}) as Record<string, unknown>;
  const clamps = [
    clampReport(raw.input, USAGE_REPORT_MAX_TOKENS),
    clampReport(raw.output, USAGE_REPORT_MAX_TOKENS),
    clampReport(raw.cache_read, USAGE_REPORT_MAX_TOKENS),
    clampReport(raw.cache_write, USAGE_REPORT_MAX_TOKENS),
  ];
  const [input, output, cacheRead, cacheWrite] = clamps.map((c) => Math.floor(c.value));
  const tokens = { inputTokens: input, outputTokens: output, ...(cacheRead > 0 && { cacheReadTokens: cacheRead }), ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }) };
  const model = cap(typeof args.model === "string" && args.model.trim() ? args.model : "unreported", 200);
  const given = args.usd === undefined ? undefined : clampReport(args.usd, USAGE_REPORT_MAX_USD);
  const usd = given ? given.value : estimateUsd(model, tokens).usd;
  const clamped = clamps.some((c) => c.clamped) || given?.clamped === true;
  const r = await a.store.transact(({ state: s }) => {
    requireActive(s, task);
    return {
      events: [{
        type: "budget.usage_recorded" as const,
        source: sourceOf(s, a, task),
        payload: {
          source: "worker" as const,
          agent: a.agent,
          ...(task !== undefined && { task }),
          provider: "external",
          model,
          tokens,
          usd,
          estimated: false,
          provenance: { tokens: "reported" as const, usd: given ? ("reported" as const) : ("estimated" as const) },
        },
      }],
    };
  });
  return {
    posted: "usage",
    seq: r.events[0]?.seq,
    tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite },
    usd,
    provenance: { tokens: "reported", usd: given ? "reported" : "estimated" },
    ...(clamped && { clamped: true, note: `A report is cut to at most $${USAGE_REPORT_MAX_USD} and ${USAGE_REPORT_MAX_TOKENS} tokens per class.` }),
  };
}

async function postUpdate(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const state = await a.store.state();
  const kind = args.kind as (typeof POST_KINDS)[number];
  if (kind === "usage") return postUsage(a, state, args);
  const text = String(args.text);
  if (kind !== "ack") requireActive(state, agentTask(state, a.agent));

  if (kind === "note") {
    const task = agentTask(state, a.agent);
    const refs = ((args.refs as string[] | undefined) ?? []).map((r) => r.trim()).filter(Boolean);
    const topic = cap(typeof args.topic === "string" && args.topic.trim() ? args.topic : (task ?? "general"), 100);
    const r = await a.store.transact(({ state: s }) => {
      requireActive(s, task);
      return { events: [{ type: "note.posted", source: sourceOf(s, a, task), payload: { topic, text: cap(text, 4000), refs } }] };
    });
    return { posted: "note", seq: r.events[0]?.seq };
  }

  if (kind === "ack") {
    const id = String(args.directive_id);
    const item = (own(state.inbox, a.agent) ?? []).find((i) => i.kind === "directive" && i.id === id);
    if (!item) throw new Refusal(`No directive ${preview(id)} in your inbox`);
    if (!item.requires_ack) return { acknowledged: id, already: true };
    await a.store.transact(({ state: s }) => ({
      events: [{ type: "directive.acknowledged", source: sourceOf(s, a, agentTask(s, a.agent)), payload: { id, agent: a.agent } }],
    }));
    return { acknowledged: id };
  }

  const task = requireTask(state, a);
  if (kind === "progress") {
    const percent = typeof args.percent === "number" ? Math.round(Math.min(100, Math.max(0, args.percent))) : undefined;
    await a.store.transact(({ state: s }) => {
      requireActive(s, task);
      return { events: [{ type: "task.progress", source: sourceOf(s, a, task), payload: { task, note: cap(text, 4000), ...(percent !== undefined && { percent }) } }] };
    });
    return { posted: "progress", task, ...(percent !== undefined && { percent }) };
  }

  const name = String(args.name).trim();
  if (!name) throw new Refusal(`kind ${kind} needs a name`);

  if (kind === "interface") {
    const cur = own(state.interfaces, name);
    const owner = cur?.spec?.owner ?? cur?.task;
    if (owner && owner !== task) throw new Refusal(`Interface ${name} is owned by task ${owner}; escalate if it must change`);
    let path: string | undefined;
    if (typeof args.path === "string" && args.path.trim()) {
      path = normalizeRelPath(args.path.trim()) ?? undefined;
      if (!path) throw new Refusal(`Not a repository path: ${preview(args.path)}`);
    }
    const blob = await a.store.putBlob(text);
    const published = await a.store.transact(({ state: s }) => {
      requireActive(s, task);
      const cur = own(s.interfaces, name);
      const owner = cur?.spec?.owner ?? cur?.task;
      if (owner && owner !== task) throw new Refusal(`Interface ${name} is owned by task ${owner}; escalate if it must change`);
      return { events: [{ type: "artifact.published", source: sourceOf(s, a, task), payload: { name, kind: "interface", task, blob, ...(path && { path }) } }] };
    });
    const by = published.events[0];
    const waiting = await waitingOn(a, name, SATISFYING_KINDS.interface);
    const satisfied = waiting.length
      ? await a.store.transact(({ state: s }) => {
          requireActive(s, task);
          const met = waiting.filter((w) => {
            const rt = own(s.tasks, w.task);
            return rt && !["accepted", "failed", "cancelled"].includes(rt.state) && !s.paused_tasks.includes(w.task)
              && publicationAvailable(s, name, w.need.owner) && own(s.interfaces, name)?.task === task;
          });
          const source = sourceOf(s, a, task);
          const events: AnyEventDraft[] = met.map((w) => ({ type: "dependency.satisfied" as const, source, payload: { task: w.task, need: w.need, by_event: by.id } }));
          // A blocked task whose last open need this was, with no deps or blocking escalation, resumes now.
          for (const waiter of new Set(met.map((w) => w.task))) {
            const rt = s.tasks[waiter];
            const why = rt.blocked_by;
            if (rt.state !== "blocked" || why?.escalation !== undefined || why?.deps?.length) continue;
            const open = (why?.needs ?? []).filter((n) => !met.some((w) => w.task === waiter && w.need.kind === n.kind && w.need.ref === n.ref));
            if (!open.length) events.push({ type: "task.unblocked", source, payload: { task: waiter } });
          }
          return { events };
        })
      : { events: [] };
    const after = await a.store.state();
    return {
      published: name,
      version: own(after.interfaces, name)?.version,
      blob,
      satisfied: satisfied.events.flatMap((e) => (e.type === "dependency.satisfied" ? [e.payload.task] : [])),
      ...(satisfied.events.some((e) => e.type === "task.unblocked") && {
        unblocked: satisfied.events.flatMap((e) => (e.type === "task.unblocked" ? [e.payload.task] : [])),
      }),
    };
  }

  // need
  const topic = typeof args.topic === "string" ? args.topic.trim() : "";
  const needKind: "task" | "interface" | "artifact" =
    topic === "task" || topic === "interface" || topic === "artifact"
      ? topic
      : own(state.tasks, name) ? "task" : own(state.interfaces, name) ? "interface" : "artifact";
  if (needKind === "task" && !ID_RE.test(name)) throw new Refusal(`Not a task id: ${preview(name)}`);
  const available =
    needKind === "task" ? own(state.tasks, name)?.state === "accepted" : publicationAvailable(state, name, typeof args.owner === "string" ? args.owner : undefined);
  if (available) {
    return { need: name, kind: needKind, available: true, note: needKind === "task" ? `Task ${name} is accepted and merged.` : `${name} is published; read it with read_blackboard(section: "interfaces").` };
  }
  await a.store.transact(({ state: s }) => {
    requireActive(s, task);
    const source = sourceOf(s, a, task);
    return {
      events: [
        { type: "dependency.requested", source, payload: { task, need: { kind: needKind, ref: name, ...(typeof args.owner === "string" && { owner: args.owner }) } } },
        { type: "task.blocked", source, payload: { task, ...(needKind === "task" && { deps: [name] }) } },
      ],
    };
  });
  return { need: name, kind: needKind, blocked: task, note: "Your task is blocked until it arrives; you can keep working on parts that do not depend on it." };
}

// ============================================================================
// run_command
// ============================================================================

const ADHOC_TIMEOUT_S = 600;

async function runCommand(a: Actor, args: Record<string, unknown>, ctx: ToolCallContext): Promise<Json> {
  const state = await a.store.state();
  const task = requireTask(state, a);
  requireActive(state, task);
  const c = state.contract;
  const limitS = typeof args.timeout_s === "number" ? args.timeout_s : undefined;
  if (typeof args.command_id === "string") {
    const spec = c?.validation.commands.find((x) => x.id === args.command_id);
    if (!spec) throw new Refusal(`Unknown command_id ${args.command_id}; the contract defines: ${(c?.validation.commands ?? []).map((x) => x.id).join(", ") || "none"}`);
    const timeoutS = Math.min(spec.timeout_s, limitS ?? Infinity);
    const r = await runCheck(a, task, spec, spec.id, { maxTimeoutMs: Math.round(timeoutS * 1000), signal: ctx.signal, image: c?.sandbox.image || undefined });
    return { ...r, timed_out: r.status === "timed_out" };
  }
  const argv = (args.argv as string[]).map(String);
  const wt = worktreeOf(a, task);
  const backend = await sandboxFor(a);
  const r = await runSandboxed(backend, { argv, workdir: wt, timeoutMs: Math.round((limitS ?? ADHOC_TIMEOUT_S) * 1000), image: c?.sandbox.image || undefined, signal: ctx.signal });
  const blob = await a.store.putBlob(r.output || "(no output)");
  const signature = failureSignature(adhocCommandId(argv), r.output);
  await a.store.transact(({ state: s }) => ({
    events: [{
      type: "command.completed",
      source: sourceOf(s, a, task),
      payload: { task, argv: argv.slice(0, 64).map((x) => cap(x, 300)), exit: r.exit, duration_ms: r.durationMs, signature, output_blob: blob },
    }],
  }));
  return {
    argv,
    exit: r.exit,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    signature,
    output_blob: blob,
    truncated: r.truncated,
    backend: r.backend,
    ...(r.degraded && { degraded: r.degraded }),
    output_tail: tailForTool(r.output),
  };
}

// ============================================================================
// submit_work
// ============================================================================

const SUBMIT_CHECKS_MS = 15 * 60_000;

async function rejectSubmission(a: Actor, task: string, reasons: string[], violations: string[]): Promise<void> {
  await a.store.transact(({ state: s }) => {
    const source = sourceOf(s, a, task);
    const events: AnyEventDraft[] = [];
    if (violations.length) events.push(leaseDrafts.violation(task, a.agent, violations, source));
    events.push({ type: "task.rejected", source, payload: { task, reasons: reasons.map((r) => cap(r, 500)), ...(violations.length && { violations: capPathList(violations, 3000) }) } });
    return { events };
  });
}

/** Tasks with a submit_work in flight in this process (execution and task): one at a time per task. */
const submitting = new Set<string>();

/** One recorded submission and the ownership it was made under. */
interface Submission extends CheckBinding {
  attempt: number;
  token_sha256: string;
}

/**
 * Why `sub` may no longer pass or fail its task, or null while it is the live one: the task's
 * latest task.submitted, still submitted or checking, claimed by the same agent in the same attempt
 * under the same token. Another process (or a reassignment) can change any of these during checks.
 */
function staleSubmission(s: Readonly<BlackboardState>, a: Actor, task: string, sub: Submission): string | null {
  const rt = own(s.tasks, task);
  if (!rt || rt.submitted_seq !== sub.submitted_seq || rt.last_commit !== sub.commit) return `a newer submission of ${task} was recorded`;
  const claim = own(s.claims, task);
  if (!claim || claim.agent !== a.agent || claim.attempt !== sub.attempt) return `${task} is no longer claimed by ${a.agent} in attempt ${sub.attempt}`;
  const rec = own(s.agents, a.agent);
  if (!rec || rec.status === "left" || !sameDigest(rec.token_sha256, sub.token_sha256)) return `${a.agent} was registered again or left`;
  if (rt.state !== "submitted" && rt.state !== "checking") return `${task} is ${rt.state}`;
  return null;
}

async function spawnSubtasks(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const r = await a.store.transact<string[]>(({ state }) => {
    const task = requireTask(state, a);
    requireActive(state, task);
    if (submitting.has(`${a.execution}\0${task}`)) throw new Refusal(`A submission of ${task} is already in progress`);
    let into;
    try { into = spawnSpecs(state, task, a.agent, args.subtasks as SubtaskInput[]); }
    catch (e) { throw new Refusal((e as Error).message); }
    return { events: [{ type: "task.spawned", source: sourceOf(state, a, task), payload: { task, by: a.agent, into } }], result: into.map((t) => t.id) };
  });
  // A successful response must not leave the parent with a stale write hook.
  await writeAgentLeases(a.store, a.agent);
  return { children: r.result };
}

async function awaitSubtasks(a: Actor, args: Record<string, unknown>, ctx: ToolCallContext): Promise<Json> {
  const timeout = args.timeout_s === undefined ? 30 : Number(args.timeout_s);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120) throw new Refusal("timeout_s must be between 0 and 120");
  const deadline = Date.now() + timeout * 1000;
  const task = requireTask(await a.store.state(), a);
  await a.store.transact(({ state }) => {
    requireActive(state, task);
    if (requireTask(state, a) !== task) throw new Refusal("Your task claim changed");
    return { events: state.tasks[task].subtasks_waiting || state.tasks[task].subtasks_joined || !state.tasks[task].subtasks?.length ? [] : [{ type: "task.subtasks_awaited", source: sourceOf(state, a, task), payload: { task } }] };
  });
  for (;;) {
    const state = await a.store.state();
    const batch = batchChildren(state, task);
    const done = batch.every((rt) => SUBTASK_TERMINAL.has(rt.state));
    const joined = !batch.length || !!state.tasks[task].subtasks_joined;
    const ready = joined && batch.every((rt) => rt.state === "accepted");
    if (ready || (done && (!batch.some((rt) => rt.state === "accepted") || joined)) || Date.now() >= deadline || ctx.signal?.aborted || TERMINAL_RUN.has(state.status) || SUBTASK_TERMINAL.has(state.tasks[task].state)) {
      const events = await a.store.events({ types: ["task.submitted", "task.merged"] });
      const children = batch.map((rt) => {
        const submission = [...events].reverse().find((e) => e.type === "task.submitted" && e.payload.task === rt.spec.id);
        return {
          id: rt.spec.id, status: rt.state,
          ...(SUBTASK_TERMINAL.has(rt.state) && { summary: cap(rt.last_note ?? "", 500) }),
          files: submission?.type === "task.submitted" ? submission.payload.files : [],
          merged: events.some((e) => e.type === "task.merged" && e.payload.task === rt.spec.id),
        };
      });
      return { ready, still_running: !done || (done && !joined && batch.some((rt) => rt.state === "accepted")), children };
    }
    heartbeat(a);
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); ctx.signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, Math.min(100, Math.max(0, deadline - Date.now())));
      ctx.signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

async function submitWork(a: Actor, args: Record<string, unknown>, ctx: ToolCallContext): Promise<Json> {
  const state = await a.store.state();
  const task = requireTask(state, a);
  requireActive(state, task);
  if (openSubtasks(state, task)) throw new Refusal(`Task ${task} has open subtasks; await_subtasks before submitting`);
  if (batchChildren(state, task).some((rt) => rt.state === "accepted") && !state.tasks[task].subtasks_joined) throw new Refusal(`Task ${task} must await_subtasks to bring its children's work into the worktree`);
  const key = `${a.execution}\0${task}`;
  if (submitting.has(key)) throw new Refusal(`A submission of ${task} is already in progress; wait for its result before you submit again`);
  submitting.add(key);
  try {
    return await submitLocked(a, args, ctx, state, task);
  } finally {
    submitting.delete(key);
  }
}

async function submitLocked(a: Actor, args: Record<string, unknown>, ctx: ToolCallContext, state: Readonly<BlackboardState>, task: string): Promise<Json> {
  const rt = state.tasks[task];
  const ready = args.ready === true;
  if (rt.state === "merging") throw new Refusal(`Task ${task} passed its checks and is being merged; end your turn`);
  const summary = String(args.summary);
  const leases = leasesFor(state, task, a.agent);
  const wt = worktreeOf(a, task);
  const integration = integrationBranch(a.execution);
  const token = own(state.agents, a.agent)?.token_sha256;

  // 1. Commit what the leases cover; anything else stays in the worktree, uncommitted.
  let commit;
  try {
    commit = await commitLeasedPaths(wt, leases, { message: summary, trailers: { execution: a.execution, task, agent: a.agent }, summaryBase: integration });
  } catch (e) {
    if (e instanceof CommitRefusedError) throw new Refusal(`${e.message}. Nothing was committed.`);
    throw e;
  }
  const outside = [...commit.uncovered, ...commit.rejected.map((r) => r.path)];

  if (!ready) {
    await a.store.transact(({ state: s }) => ({
      events: [{ type: "task.progress", source: sourceOf(s, a, task), payload: { task, note: cap(`Checkpoint: ${summary}`, 4000) } }],
    }));
    return {
      checkpoint: commit.commit,
      committed: commit.created,
      ...(commit.created && { stat: commit.stat }),
      ...(outside.length && { not_committed: outside, warning: "These paths are outside your leases and stay uncommitted; lease them or revert them before you submit." }),
    };
  }

  if (outside.length) {
    const reasons = [`Changed paths outside the leases: ${outside.slice(0, 20).join(", ")}${outside.length > 20 ? ", …" : ""}`, ...commit.rejected.map((r) => `${r.path}: ${r.reason}`)];
    await rejectSubmission(a, task, reasons, outside);
    throw new Refusal(`Submission rejected: ${reasons.join("; ")}. Lease these paths (lease request) or revert them, then submit again.`);
  }

  // 2. Everything the commit changed since its merge base with the integration branch must be
  // leased. From here on everything is measured at that commit, never at a HEAD that may move.
  const head = commit.commit;
  const cov = await checkLeaseCoverage(wt, integration, leases, head);
  if (!cov.ok) {
    const reasons = cov.details.slice(0, 20).map((d) => `${d.path}: ${d.reason}`);
    await rejectSubmission(a, task, reasons, cov.violations);
    throw new Refusal(`Submission rejected: ${reasons.join("; ")}. Lease these paths or revert them on your branch, then submit again.`);
  }

  // 3. The submission: diff blob, stat and files of the whole task (the sandbox is checked first,
  // so a run without one never leaves a submission whose checks cannot start). It is recorded only
  // while the agent still holds the claim under the token it started with.
  if (rt.spec.checks.length) await sandboxFor(a);
  const diff = await diffForTask(wt, integration, undefined, head);
  const diffBlob = await a.store.putBlob(diff || "(no changes)\n");
  const sum = await taskDiffSummary(wt, integration, head);
  let attempt = 0;
  const recorded = await a.store.transact(({ state: s }) => {
    requireActive(s, task);
    const claim = own(s.claims, task);
    if (!claim || claim.agent !== a.agent) throw new Refusal(`You no longer hold the claim on ${task}; nothing was submitted`);
    const rec = own(s.agents, a.agent);
    if (!rec || !token || !sameDigest(rec.token_sha256, token)) throw new Refusal(`${a.agent} was registered again; nothing was submitted`);
    attempt = claim.attempt;
    return {
      events: [{
        type: "task.submitted",
        source: sourceOf(s, a, task),
        payload: { task, commit: head, diff_blob: diffBlob, stat: sum.stat, files: capPathList(sum.files, 4500), rewrites: capPathList(sum.rewrites, 1500), summary: cap(summary, 500) },
      }],
    };
  });
  const sub: Submission = { submitted_seq: recorded.events[0].seq, commit: head, attempt, token_sha256: token! };
  const bind: CheckBinding = { submitted_seq: sub.submitted_seq, commit: head };

  // 4. The task's checks, within 15 minutes in all, in a fresh checkout of the submitted commit
  // that no worker tool can reach (so nothing done to the worktree meanwhile changes what is checked).
  const c = state.contract;
  const ids = rt.spec.checks;
  const deadline = Date.now() + SUBMIT_CHECKS_MS;
  const runAll = async (dir: string): Promise<CheckOutcome[]> => {
    const results: CheckOutcome[] = [];
    for (const [i, id] of ids.entries()) {
      ctx.progress?.(i, ids.length, `check ${id}`);
      const left = deadline - Date.now();
      if (left < 1000) {
        await a.store.transact(({ state: s }) => ({ events: [{ type: "check.timed_out", source: sourceOf(s, a, task), payload: { command_id: id, scope: "task", task, ...bind } }] }));
        results.push({ command_id: id, commit: head, status: "timed_out", exit: null, duration_ms: 0, output_blob: "", output_tail: "submit_work's 15 minutes ran out before this check started" });
        continue;
      }
      results.push(await runCheck(a, task, c?.validation.commands.find((x) => x.id === id), id, { maxTimeoutMs: left, signal: ctx.signal, image: c?.sandbox.image || undefined, workdir: dir, bind }));
    }
    return results;
  };
  const results = ids.length ? await withCommitCheckout(a.store.header(), task, head, runAll) : [];
  ctx.progress?.(ids.length, ids.length, "checks done");
  const failed = results.filter((r) => r.status !== "passed");
  const view = results.map(({ output_tail, ...r }) => (r.status === "passed" ? r : { ...r, output_tail }));

  // 5. The outcome, recorded only for the live submission (staleSubmission), so a slow check can
  // never pass or fail a newer submission or a task that changed hands.
  const outcome = (draft: (s: Readonly<BlackboardState>) => AnyEventDraft) =>
    a.store.transact(({ state: s }) => {
      const why = staleSubmission(s, a, task, sub);
      if (why) throw new Refusal(`This submission (${head.slice(0, 12)}) is out of date: ${why}. Nothing was recorded for it; read_blackboard shows where ${task} stands.`);
      return { events: [draft(s)] };
    });
  if (!failed.length) {
    await outcome((s) => ({ type: "task.checks_passed", source: sourceOf(s, a, task), payload: { task, commands: [...ids], ...bind } }));
    return {
      submitted: task,
      commit: head,
      stat: sum.stat,
      checks: view,
      next: "Your checks passed and the runner will merge your work. End your turn now with a one-line summary.",
    };
  }
  await outcome((s) => ({
    type: "task.rejected",
    source: sourceOf(s, a, task),
    payload: { task, reasons: failed.map((f) => cap(`check ${f.command_id} ${f.status === "timed_out" ? "timed out" : `failed (exit ${f.exit ?? "none"})`}`, 300)) },
  }));
  return {
    submitted: task,
    commit: head,
    checks_passed: false,
    checks: view,
    next: "Fix what failed (the output tails are above; read_blackboard(section: \"blob\", ref) has the full output) and call submit_work again.",
  };
}

// ============================================================================
// escalate
// ============================================================================

async function escalate(a: Actor, args: Record<string, unknown>): Promise<Json> {
  const state = await a.store.state();
  const task = agentTask(state, a.agent);
  const blocking = args.blocking === true && task !== undefined;
  let diagnosticsBlob: string | undefined;
  if (args.diagnostics && typeof args.diagnostics === "object" && Object.keys(args.diagnostics).length) {
    diagnosticsBlob = await a.store.putBlob(scrubbedJSON(args.diagnostics), { redact: false });
  }
  const id = newId("esc");
  const esc: Escalation = {
    id,
    agent: a.agent,
    kind: args.kind as Escalation["kind"],
    with: args.with as Escalation["with"],
    summary: cap(args.summary, 2000),
    blocking,
    status: "open",
    raised_seq: 0,
    ...(task !== undefined && { task }),
    ...(typeof args.target === "string" && args.target.trim() && { target: cap(args.target.trim(), 200) }),
    ...(typeof args.question === "string" && args.question.trim() && { question: cap(args.question, 1500) }),
    ...(Array.isArray(args.options) && args.options.length && { options: (args.options as string[]).slice(0, 10).map((o) => cap(o, 200)) }),
    ...(diagnosticsBlob && { diagnostics_blob: diagnosticsBlob }),
    ...(typeof args.emergency === "string" && { emergency: args.emergency as Escalation["emergency"] }),
  };
  await a.store.transact(({ state: s }) => {
    const source = sourceOf(s, a, task);
    const events: AnyEventDraft[] = [{ type: "escalation.raised", source, payload: { escalation: esc } }];
    if (blocking && task) events.push({ type: "task.blocked", source, payload: { task, escalation: id } });
    return { events };
  });
  return {
    escalation_id: id,
    blocking,
    ...(blocking
      ? { instruction: "end your turn now with a one-line summary; you will be resumed with the resolution" }
      : { note: "Recorded. Keep working; a resolution arrives in your inbox." }),
  };
}

// ============================================================================
// join_execution (orchestrator server)
// ============================================================================

async function joinExecution(args: Record<string, unknown>): Promise<Json> {
  const execution = String(args.execution_id);
  const agent = String(args.agent);
  const store = await storeFor(execution);
  const state = await store.state();
  if (!state.contract) throw new Refusal(`Execution ${execution} has no frozen contract yet`);
  if (TERMINAL_RUN.has(state.status)) throw new Refusal(`Execution ${execution} is ${state.status}`);
  const existing = own(state.agents, agent);
  if (existing && !existing.external) throw new Refusal(`Agent ${agent} is a worker the runner manages; pick another id`);
  const team = typeof args.team === "string" && args.team.trim() ? args.team.trim() : undefined;
  if (team && !own(state.teams, team)) throw new Refusal(`Unknown team ${preview(team)}; teams: ${Object.keys(state.teams).join(", ") || "none"}`);
  const taskId = typeof args.task_id === "string" ? args.task_id : undefined;
  if (taskId) {
    const rt = own(state.tasks, taskId);
    if (!rt) throw new Refusal(`Unknown task ${preview(taskId)}`);
    if (["accepted", "failed", "cancelled"].includes(rt.state)) throw new Refusal(`Task ${taskId} is ${rt.state}`);
  }
  const wt = taskId ? await ensureTaskWorktree(store.header(), taskId, taskStartPoint(state, taskId)) : undefined;
  const { token, sha256 } = newAgentToken();
  const orchestrator = state.contract.scope.orchestrator || "orchestrator";
  await store.transact(({ state: s }) => {
    const cur = own(s.agents, agent);
    if (cur && !cur.external) throw new Refusal(`Agent ${agent} is a worker the runner manages; pick another id`);
    return {
      events: [{
        type: "agent.registered",
        source: { kind: "orchestrator", id: orchestrator, pid: process.pid },
        payload: { agent, persona: agent, driver: "external", token_sha256: sha256, external: true, ...(team && { team }) },
      }],
    };
  });
  ensureAgentDir(execution, agent);
  await appendAudit({ actor: orchestrator, action: "agent.joined", target: execution, details: { agent, external: true, ...(taskId && { task: taskId }), ...(existing && { rejoined: true }) } });
  const after = await store.state();
  const readyTasks = Object.values(after.tasks).filter((rt) => claimProblem(after, rt.spec.id) === null).map((rt) => ({ id: rt.spec.id, title: cap(rt.spec.title, 200), team: rt.spec.team }));
  return {
    execution_id: execution,
    agent,
    agent_token: token,
    token_note: "Shown once: keep it for this run and pass it as agent_token with execution_id to every worker tool. Joining again issues a new token and voids this one.",
    ...(wt && { worktree: wt.path, branch: wt.branch }),
    ...(taskId && { task_card: buildTaskCard(after, taskId, { external: true, ...(wt && { worktree: wt.path }), ...cardLessons(after, taskId) }) }),
    ...(!taskId && { ready_tasks: readyTasks }),
    next: taskId ? `Call claim_task(task_id: "${taskId}") before you edit anything.` : "Pick a ready task and call claim_task(task_id).",
  };
}

// ============================================================================
// Dispatch
// ============================================================================

type Handler = (a: Actor, args: Record<string, unknown>, ctx: ToolCallContext) => Promise<Json>;

const HANDLERS: Record<string, Handler> = {
  [READ_BLACKBOARD]: (a, args) => readBlackboard(a, args),
  [CLAIM_TASK]: (a, args) => claimTask(a, args),
  [LEASE]: (a, args) => lease(a, args),
  [POST_UPDATE]: (a, args) => postUpdate(a, args),
  [RUN_COMMAND]: (a, args, ctx) => runCommand(a, args, ctx),
  [SUBMIT_WORK]: (a, args, ctx) => submitWork(a, args, ctx),
  [ESCALATE]: (a, args) => escalate(a, args),
  [SPAWN_SUBTASKS]: (a, args) => spawnSubtasks(a, args),
  [AWAIT_SUBTASKS]: (a, args, ctx) => awaitSubtasks(a, args, ctx),
};

export async function handleWorkerTool(name: string, args: ToolArgs, ctx: ToolCallContext = { mode: "orchestrator" }): Promise<CallToolResult> {
  const a = args ?? {};
  if (name === JOIN_EXECUTION) {
    try {
      return render(await joinExecution(a));
    } catch (e) {
      if (e instanceof Refusal) throw new Error(e.message);
      throw e;
    }
  }
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const actor = await resolveActor(a, ctx.mode);
  heartbeat(actor);
  let body: Json;
  let failed = false;
  try {
    body = await handler(actor, a, ctx);
  } catch (e) {
    failed = true;
    body = { error: scrub(e instanceof Error ? e.message : String(e)) };
    if (!(e instanceof Refusal)) console.error(`[Worker] ${name} failed for ${actor.agent}: ${body.error}`);
  }
  const inbox = await takeInbox(actor).catch(() => undefined);
  const result = render(inbox ? { inbox: inbox.inbox, ...body } : body, failed);
  inbox?.delivered();
  return result;
}
