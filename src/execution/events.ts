// ============================================================================
// Event draft validation: one payload shape per event type
//
// Field types (a "?" suffix on the key marks it optional; "|" separates alternatives):
//   s     non-empty string (identifiers, refs, paths: stored as given)
//   t     string of free text: passed through scrub() before hashing
//   n     finite number            int   safe integer        b   boolean     null
//   s[]   array of s               t[]   array of t (each scrubbed)
//   'x'   the literal string x
// A nested object is a nested shape, and [shape] is an array of that shape. Unknown fields are
// rejected so nothing unscrubbed or unexpected reaches the log.
// ============================================================================

import { scrub } from "../security/secrets.js";
import { canonicalJSON } from "./chain.js";
import { EVENT_TYPES, type AnyEventDraft, type EventType } from "./types.js";

type Field = string | Shape | readonly [Shape];
export interface Shape {
  readonly [key: string]: Field;
}

/** Largest canonical payload the log accepts; anything bigger goes in a blob. */
export const PAYLOAD_LIMIT_BYTES = 8192;
/** Cap on everything in a draft except its payload (source, ids, correlation). */
const ENVELOPE_LIMIT_BYTES = 2048;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const MODE = "'deliberation'|'execution'";
const DRIVER = "'claude-code'|'codex'|'external'";
const SANDBOX = "'docker'|'local'";
const CHECK_SCOPE = "'task'|'integration'";
const LEASE_MODE = "'exclusive'|'shared'";
const VERDICT = "'AGREE'|'OBJECT'|'UNCLEAR'|'EXCUSED'";
const EMERGENCY = "'money'|'credentials'|'scope'|'human_action'";
const HUDDLE_FORMAT = "'micro'|'meeting'|'collaborate'|'debate'|'waffle-house'|'conversation'|'replan'|'ultraplan'";
const RESOLUTION = "'decide'|'huddle'|'retry'|'reassign'|'amend'|'dismiss'|'await_human'";

const SOURCE: Shape = {
  kind: "'orchestrator'|'agent'|'runner'|'watchdog'|'human'|'system'",
  id: "s",
  "team?": "s",
  "task?": "s",
  pid: "int",
};
const VISIBILITY: Shape = {
  dashboard: "b",
  chat_only: "b",
  "github?": { repo: "s", "project_owner?": "s", "project_number?": "int", "create_project?": "b", "pr?": "b" },
};
const BUDGET: Shape = {
  usd: "n",
  per_task_usd: "n",
  "per_agent_usd?": "n",
  wall_clock_min: "n",
  max_parallel: "int",
  max_attempts: "int",
};
const TOKENS: Shape = { inputTokens: "n", outputTokens: "n", "cacheReadTokens?": "n", "cacheWriteTokens?": "n" };
const ARTIFACT_REF: Shape = { kind: "'file'|'blob'|'text'|'url'", ref: "t", "title?": "t" };
const TASK_SPEC: Shape = {
  id: "s",
  title: "t",
  "team?": "s",
  persona: "s",
  kind: "'build'|'subcontract'|'review'",
  depends_on: "s[]",
  paths: { write: "s[]", "read?": "s[]" },
  acceptance: "t[]",
  checks: "s[]",
  "effort?": "'low'|'medium'|'high'",
  "budget_usd?": "n",
  "context?": [ARTIFACT_REF],
};
const LEASE: Shape = {
  id: "s",
  agent: "s",
  task: "s",
  paths: "s[]",
  mode: LEASE_MODE,
  branch: "s",
  reason: "t",
  granted_seq: "int",
};
const LEASE_REQUEST: Shape = {
  id: "s",
  agent: "s",
  task: "s",
  paths: "s[]",
  mode: LEASE_MODE,
  reason: "t",
  requested_seq: "int",
  blocking: "s[]",
};
const DECISION: Shape = { id: "s", scope: "s", text: "t", "rationale?": "t", by: "s", "supersedes?": "s" };
const ESCALATION: Shape = {
  id: "s",
  "task?": "s",
  agent: "s",
  kind: "'blocker'|'ambiguity'|'resource'|'conflict'|'assistance'|'emergency'",
  with: "'orchestrator'|'management'|'team'|'agent'|'path_owner'",
  "target?": "s",
  summary: "t",
  "question?": "t",
  "options?": "t[]",
  "diagnostics_blob?": "s",
  blocking: "b",
  "emergency?": EMERGENCY,
  status: "'open'|'routed'|'in_huddle'|'awaiting_human'|'resolved'|'withdrawn'",
  "routed_to?": "s",
  "huddle?": "s",
  "resolution?": { action: RESOLUTION, decision: "t", by: "s" },
  raised_seq: "int",
};
const NEED: Shape = { kind: "'task'|'interface'|'artifact'", ref: "s" };

// ---------------------------------------------------------------------------
// The catalog (docs/design/heads-down.md §5)
// ---------------------------------------------------------------------------

export const PAYLOAD_SPECS: { readonly [T in EventType]: Shape } = {
  "execution.created": { repo_root: "s", base_sha: "s", contract: "s", contract_version: "int" },
  "execution.started": {
    confirmation: "t",
    visibility: VISIBILITY,
    budget: BUDGET,
    lead: "s",
    sandbox: SANDBOX,
    drivers: "s[]",
  },
  "execution.paused": { scope: "'all'|s[]", reason: "t" },
  "execution.resumed": { scope: "'all'|s[]", "reason?": "t" },
  "execution.steered": { message: "t", targets: "s[]" },
  "execution.mode_changed": { from: MODE, to: MODE, reason: "t", "session?": "s" },
  "execution.completed": { integration_sha: "s", "pr_url?": "s" },
  "execution.failed": { reason: "t" },
  "execution.aborted": { reason: "t" },

  "contract.proposed": { contract: "s", version: "int", source: "s", blob: "s" },
  "contract.consent_requested": { contract: "s", version: "int", participants: "s[]" },
  "contract.consent_recorded": { contract: "s", agent: "s", verdict: VERDICT, "reason?": "t" },
  "contract.objection_resolved": { contract: "s", agent: "s", how: "'amended'|'withdrawn'|'excused'", reason: "t" },
  // `blob` (the full contract at this version) is optional in the type but required here: the
  // blackboard reads the contract from it (see blackboard.ts).
  "contract.frozen": { contract: "s", version: "int", by: "s", hash: "s", blob: "s" },
  "contract.amended": { contract: "s", version: "int", patch_blob: "s", reason: "t", affected_tasks: "s[]", blob: "s" },
  "contract.superseded": { contract: "s", by_contract: "s" },

  "runner.started": { pid: "int", version: "s" },
  "runner.takeover": { previous_pid: "int" },
  "runner.stopped": { reason: "t" },

  "agent.registered": { agent: "s", persona: "s", "team?": "s", driver: DRIVER, token_sha256: "s", external: "b" },
  "agent.spawned": { agent: "s", task: "s", attempt: "int", pid: "int", "session_id?": "s" },
  "agent.attested": { agent: "s", tools: "s[]", mcp_servers: "s[]", ok: "b" },
  "agent.exited": {
    agent: "s",
    "task?": "s",
    code: "int|null",
    reason: "'completed'|'error'|'killed'|'lost'|'stalled'|'budget'|'attestation'",
    "result_subtype?": "s",
    "usage?": TOKENS,
  },
  "agent.left": { agent: "s", reason: "t" },

  "task.ready": { task: "s" },
  "task.claimed": { task: "s", agent: "s", attempt: "int", ttl_s: "n" },
  "task.released": { task: "s", agent: "s", "note?": "t" },
  "task.progress": { task: "s", "percent?": "n", note: "t" },
  "task.submitted": { task: "s", commit: "s", diff_blob: "s", stat: "t", files: "s[]", rewrites: "s[]" },
  "task.checks_passed": { task: "s", commands: "s[]" },
  "task.rejected": { task: "s", reasons: "t[]", "violations?": "t[]" },
  "task.merged": { task: "s", integration_sha: "s" },
  "task.accepted": { task: "s" },
  "task.blocked": { task: "s", "escalation?": "s", "deps?": "s[]" },
  "task.unblocked": { task: "s" },
  "task.retried": { task: "s", attempt: "int", why: "t" },
  "task.reassigned": { task: "s", from: "s", to: "s" },
  "task.split": { task: "s", into: [TASK_SPEC] },
  "task.failed": { task: "s", why: "t" },
  "task.cancelled": { task: "s", why: "t" },

  "lease.granted": { lease: LEASE },
  "lease.queued": { request: LEASE_REQUEST },
  "lease.released": { lease_id: "s" },
  "lease.expired": { lease_id: "s" },
  "lease.revoked": { lease_id: "s", by: "s", reason: "t" },
  "lease.violation": { task: "s", agent: "s", paths: "s[]" },

  "artifact.published": { name: "s", kind: "'interface'|'design'|'doc'", "path?": "s", "blob?": "s", task: "s" },
  "artifact.changed": { name: "s", version: "int", consumers: "s[]" },

  "dependency.requested": { task: "s", need: NEED },
  "dependency.satisfied": { task: "s", need: NEED, by_event: "s" },

  "check.started": { command_id: "s", scope: CHECK_SCOPE, "task?": "s" },
  "check.passed": { command_id: "s", scope: CHECK_SCOPE, "task?": "s", duration_ms: "n" },
  "check.failed": {
    command_id: "s",
    scope: CHECK_SCOPE,
    "task?": "s",
    exit: "int|null",
    signature: "s",
    "output_blob?": "s",
  },
  "check.timed_out": { command_id: "s", scope: CHECK_SCOPE, "task?": "s" },

  "command.completed": {
    task: "s",
    argv: "t[]",
    exit: "int|null",
    duration_ms: "n",
    signature: "s",
    "output_blob?": "s",
  },

  "merge.succeeded": { task: "s", sha: "s" },
  "merge.conflicted": { task: "s", files: "s[]" },

  "note.posted": { topic: "t", text: "t", refs: "s[]" },
  "decision.recorded": { decision: DECISION },
  "directive.issued": { id: "s", to: "s[]", text: "t", requires_ack: "b" },
  "directive.acknowledged": { id: "s", agent: "s" },

  "escalation.raised": { escalation: ESCALATION },
  "escalation.routed": { id: "s", to: "s", "format?": HUDDLE_FORMAT, wake: "b" },
  "escalation.auto_resolved": { id: "s", rule: "s" },
  "escalation.resolved": { id: "s", action: RESOLUTION, decision: "t", by: "s" },
  "escalation.awaiting_human": { id: "s", class: EMERGENCY, message: "t", "alternatives?": "t[]" },
  "escalation.withdrawn": { id: "s", reason: "t" },

  "huddle.started": { id: "s", escalation: "s", format: HUDDLE_FORMAT, seats: "s[]", "session?": "s" },
  "huddle.turn": { id: "s", seat: "s", blob: "s" },
  "huddle.concluded": {
    id: "s",
    outcome: "'AGREED'|'DISAGREED'|'NEEDS_ORCHESTRATOR'|'DECIDED'|'NO_OUTCOME'",
    "decision?": "t",
  },

  "budget.usage_recorded": {
    source: "'worker'|'huddle'|'consent'|'lead'|'structuring'",
    "agent?": "s",
    "task?": "s",
    "provider?": "s",
    model: "s",
    tokens: TOKENS,
    usd: "n",
    estimated: "b",
  },
  "budget.threshold_crossed": { pct: "n", spent_usd: "n", budget_usd: "n" },
  "budget.exhausted": { scope: "'execution'|'task'|'agent'", "ref?": "s" },
  "budget.extended": { by: "s", usd: "n" },

  "watchdog.action": { rule: "s", action: "s", target: "s" },
  "watchdog.circuit_opened": { driver: "s", reason: "t", until: "s" },
  "watchdog.circuit_closed": { driver: "s" },
  "watchdog.deadlock_detected": { cycle: "s[]" },
  "watchdog.stall_detected": { agent: "s", "task?": "s" },

  "sandbox.degraded": { backend: SANDBOX, reason: "t" },
};

const DRAFT: Shape = {
  type: "s",
  source: SOURCE,
  "mode?": MODE,
  "contract?": "s",
  "contract_version?": "int",
  "causation?": "s",
  "correlation?": "s",
};

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

class Invalid extends Error {
  constructor(readonly path: string, readonly problem: string) {
    super(`${path} ${problem}`);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const NO = Symbol("no match");

function primitive(v: unknown, t: string): unknown {
  if (t.startsWith("'")) return v === t.slice(1, -1) ? v : NO;
  switch (t) {
    case "s":
      return typeof v === "string" && v.length > 0 ? v : NO;
    case "t":
      return typeof v === "string" ? scrub(v) : NO;
    case "n":
      return typeof v === "number" && Number.isFinite(v) ? v : NO;
    case "int":
      return Number.isSafeInteger(v) ? v : NO;
    case "b":
      return typeof v === "boolean" ? v : NO;
    case "null":
      return v === null ? v : NO;
    case "s[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0) ? [...v] : NO;
    case "t[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map((x: string) => scrub(x)) : NO;
    default:
      throw new Error(`events.ts: unknown field type ${t}`);
  }
}

const NAMES: Record<string, string> = {
  s: "a non-empty string",
  t: "a string",
  n: "a finite number",
  int: "an integer",
  b: "a boolean",
  null: "null",
  "s[]": "an array of non-empty strings",
  "t[]": "an array of strings",
};

function describe(field: string): string {
  return field.split("|").map((t) => (t.startsWith("'") ? JSON.stringify(t.slice(1, -1)) : NAMES[t] ?? t)).join(" or ");
}

function checkField(v: unknown, field: Field, path: string): unknown {
  if (typeof field !== "string") {
    if (!Array.isArray(field)) return checkShape(v, field as Shape, path);
    if (!Array.isArray(v)) throw new Invalid(path, "must be an array");
    return v.map((item, i) => checkShape(item, field[0], `${path}[${i}]`));
  }
  for (const alt of field.split("|")) {
    const out = primitive(v, alt);
    if (out !== NO) return out;
  }
  throw new Invalid(path, `must be ${describe(field)}`);
}

/** A copy of `value` holding only the shape's fields, text fields scrubbed. Undefined counts as absent. */
function checkShape(value: unknown, shape: Shape, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Invalid(path, "must be an object");
  const out: Record<string, unknown> = {};
  const known = new Set<string>();
  for (const [rawKey, field] of Object.entries(shape)) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    known.add(key);
    const v = Object.hasOwn(value, key) ? value[key] : undefined;
    if (v === undefined) {
      if (optional) continue;
      throw new Invalid(`${path}.${key}`, "is required");
    }
    out[key] = checkField(v, field, `${path}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!known.has(key) && value[key] !== undefined) throw new Invalid(`${path}.${key}`, "is not a known field");
  }
  return out;
}

export function isEventType(type: unknown): type is EventType {
  return typeof type === "string" && Object.hasOwn(PAYLOAD_SPECS, type);
}

/**
 * Validate a draft against its type's payload shape and return a sanitized copy: unknown fields
 * rejected, text fields scrubbed of secrets. Throws on an unknown type, a bad field, or a payload
 * whose canonical JSON exceeds PAYLOAD_LIMIT_BYTES.
 */
export function validateDraft(draft: AnyEventDraft): AnyEventDraft {
  const raw = draft as unknown;
  if (!isPlainObject(raw)) throw new Error("Invalid event draft: must be an object");
  const type = raw.type;
  if (!isEventType(type)) {
    throw new Error(`Unknown event type ${JSON.stringify(type)}; known types: ${EVENT_TYPES.join(", ")}`);
  }
  let out: Record<string, unknown>;
  try {
    const { payload, ...rest } = raw;
    out = checkShape(rest, DRAFT, "draft");
    out.payload = checkField(payload, PAYLOAD_SPECS[type], "payload");
  } catch (e) {
    if (e instanceof Invalid) throw new Error(`Invalid ${type} event: ${e.message}`);
    throw e;
  }
  const payloadBytes = Buffer.byteLength(canonicalJSON(out.payload));
  if (payloadBytes > PAYLOAD_LIMIT_BYTES) {
    throw new Error(
      `${type} payload is ${payloadBytes} bytes; the limit is ${PAYLOAD_LIMIT_BYTES}. ` +
        `Store large content with putBlob() and put the returned "sha256:…" ref in the payload instead.`
    );
  }
  const envelopeBytes = Buffer.byteLength(canonicalJSON({ ...out, payload: null }));
  if (envelopeBytes > ENVELOPE_LIMIT_BYTES) {
    throw new Error(`${type} draft fields outside the payload are ${envelopeBytes} bytes; the limit is ${ENVELOPE_LIMIT_BYTES}.`);
  }
  return out as unknown as AnyEventDraft;
}
