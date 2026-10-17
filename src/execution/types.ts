// ============================================================================
// Heads-down execution: frozen shared interfaces (WS03a)
//
// Every 1.0 workstream builds against these types. Change them only together with
// docs/design/heads-down.md, in the same pull request.
// ============================================================================

// ---------------------------------------------------------------------------
// Modes and sources
// ---------------------------------------------------------------------------

/** "deliberation" is the code name for at-the-table formats; "execution" for heads-down. */
export type Mode = "deliberation" | "execution";

export type SourceKind = "orchestrator" | "agent" | "runner" | "watchdog" | "human" | "system";

export interface EventSource {
  kind: SourceKind;
  /** Agent id, orchestrator name, or "runner" / "watchdog" / "system". */
  id: string;
  team?: string;
  task?: string;
  pid: number;
}

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** A reference to a stored blob (content-addressed, secrets already redacted). */
export interface BlobRef {
  blob: string; // "sha256:<hex>"
  bytes: number;
}

export interface ArtifactRef {
  /** "file" refers to a path in the repository; "blob" to the execution blob store; "text" is inline. */
  kind: "file" | "blob" | "text" | "url";
  ref: string;
  title?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type BudgetSource = "worker" | "huddle" | "consent" | "lead" | "structuring";

export interface UsageRecord {
  source: BudgetSource;
  agent?: string;
  task?: string;
  provider?: string;
  model: string;
  tokens: TokenUsage;
  usd: number;
  /** True when usd came from the pricing table (or is unknown) rather than a provider-reported cost. */
  estimated: boolean;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const CONTRACT_SCHEMA = "roundtable.contract/1";

export type ContractStatus = "draft" | "consenting" | "frozen" | "superseded" | "closed";
export type ConsentVerdict = "AGREE" | "OBJECT" | "UNCLEAR" | "EXCUSED";
export type AuthorityAction =
  | "retry"
  | "reassign"
  | "split_task"
  | "add_task"
  | "amend_interfaces"
  | "extend_budget"
  | "resolve_merge";

export interface CommandSpec {
  id: string;
  /** Structured argv; never a shell string. */
  argv: string[];
  /** Relative to the worktree root. */
  cwd?: string;
  timeout_s: number;
  /** Non-secret variables only (keys matching /KEY|TOKEN|SECRET|PASS/i are rejected). */
  env?: Record<string, string>;
}

export interface TaskSpec {
  id: string;
  title: string;
  team?: string;
  /** Persona ref resolved through loadAgent. */
  persona: string;
  kind: "build" | "subcontract" | "review";
  depends_on: string[];
  paths: { write: string[]; read?: string[] };
  acceptance: string[];
  /** CommandSpec ids from contract.validation.commands. */
  checks: string[];
  effort?: "low" | "medium" | "high";
  budget_usd?: number;
  context?: ArtifactRef[];
}

export interface InterfaceSpec {
  name: string;
  kind: "type" | "api" | "schema" | "design" | "doc" | "other";
  /** Owning task id. */
  owner: string;
  path?: string;
  description: string;
  consumers?: string[];
}

export interface Decision {
  id: string;
  scope: string; // "contract" | team id | task id
  text: string;
  rationale?: string;
  by: string;
  supersedes?: string;
}

export interface ContractBudget {
  usd: number;
  per_task_usd: number;
  per_agent_usd?: number;
  wall_clock_min: number;
  max_parallel: number;
  max_attempts: number;
}

/** Non-executing predicates over recorded execution state. */
export type DissentTripwire =
  | { kind: "check_failed"; check: string; task?: string }
  | { kind: "path_touched"; paths: string[]; task?: string }
  | { kind: "task_state"; task: string; state: "rejected" | "blocked" };

export interface Dissent {
  id: string;
  by: string;
  source: { kind: "ultraplan" | "consent" | "debate" | "waffle_house" | "manual"; ref?: string };
  claim: string;
  predicted_failure: string;
  /** May be absent only while drafting; freeze requires arming or explicit excusal. */
  tripwire?: DissentTripwire;
  on_fire: "notify" | "huddle" | "pause_and_huddle";
}

export interface Contract {
  schema: typeof CONTRACT_SCHEMA;
  id: string;
  version: number;
  status: ContractStatus;
  title: string;
  goal: { ultimate: string; original_prompt: string; artifacts: ArtifactRef[]; source_session?: string };
  scope: {
    orchestrator: string;
    parent?: { contract: string; task: string };
    repo_root: string;
    base_ref: string;
    /** Repository-relative globs the whole contract may write. */
    paths: string[];
  };
  participants: Array<{ agent: string; role?: string; team?: string }>;
  teams: Array<{ id: string; lead?: string; members: string[] }>;
  tasks: TaskSpec[];
  interfaces: InterfaceSpec[];
  decisions: Decision[];
  dissents: Dissent[];
  validation: { commands: CommandSpec[]; final: string[] };
  budget: ContractBudget;
  authority: { lead: string; may: AuthorityAction[]; budget_extension_pct: number };
  sandbox: { backend: SandboxBackendId; image: string; install?: { argv: string[]; egress: string[] } };
  workers: { driver: WorkerDriverId; model?: string; fallback_model?: string };
  consent: Array<{ agent: string; verdict: ConsentVerdict; reason?: string }>;
  frozen?: { by: string; at: string; hash: string };
}

export const CONTRACT_DEFAULTS = {
  max_parallel: 3,
  max_attempts: 3,
  budget_extension_pct: 0,
  authority_may: ["retry", "reassign", "resolve_merge"] as AuthorityAction[],
  max_subcontract_depth: 2,
} as const;

// ---------------------------------------------------------------------------
// Tasks, claims, leases
// ---------------------------------------------------------------------------

export type TaskState =
  | "pending"
  | "ready"
  | "claimed"
  | "in_progress"
  | "submitted"
  | "checking"
  | "merging"
  | "accepted"
  | "blocked"
  | "paused"
  | "failed"
  | "cancelled";

export interface Claim {
  task: string;
  agent: string;
  attempt: number;
  /** 0 for runner-spawned workers (alive while the pid lives); external claims default to 900. */
  ttl_s: number;
  granted_seq: number;
}

export type LeaseMode = "exclusive" | "shared";

export interface Lease {
  id: string;
  agent: string;
  task: string;
  /** Repository-relative globs: ** * ? (no braces). */
  paths: string[];
  mode: LeaseMode;
  branch: string;
  reason: string;
  granted_seq: number;
}

export interface LeaseRequest {
  id: string;
  agent: string;
  task: string;
  paths: string[];
  mode: LeaseMode;
  reason: string;
  requested_seq: number;
  /** Lease ids blocking this request. */
  blocking: string[];
}

export interface TaskRuntime {
  spec: TaskSpec;
  state: TaskState;
  attempt: number;
  agent?: string;
  branch?: string;
  worktree?: string;
  percent?: number;
  last_note?: string;
  last_commit?: string;
  submitted_seq?: number;
  accepted_seq?: number;
  /** Latest rejection, retained because rejection immediately returns the task to work. */
  rejected_seq?: number;
  blocked_seq?: number;
  /**
   * Why a blocked task waits. needs (added in WS07) are its open interface and artifact needs:
   * dependency.requested adds one, dependency.satisfied removes it. Task needs are in deps.
   */
  blocked_by?: { escalation?: string; escalations?: string[]; deps?: string[]; needs?: Array<{ kind: "interface" | "artifact"; ref: string }> };
  started_at?: string;
  finished_at?: string;
}

// ---------------------------------------------------------------------------
// Escalations and huddles
// ---------------------------------------------------------------------------

export type EscalationKind = "blocker" | "ambiguity" | "resource" | "conflict" | "assistance" | "emergency";
export type EscalationWith = "orchestrator" | "management" | "team" | "agent" | "path_owner";
export type EmergencyClass = "money" | "credentials" | "scope" | "human_action";
export type EscalationStatus = "open" | "routed" | "in_huddle" | "awaiting_human" | "resolved" | "withdrawn";
export type ResolutionAction = "decide" | "huddle" | "retry" | "reassign" | "amend" | "dismiss" | "await_human";
export type HuddleFormat =
  | "micro"
  | "meeting"
  | "collaborate"
  | "debate"
  | "waffle-house"
  | "conversation"
  | "replan"
  | "ultraplan";
export type HuddleOutcome = "AGREED" | "DISAGREED" | "NEEDS_ORCHESTRATOR" | "DECIDED" | "NO_OUTCOME";

export interface EscalationDiagnostics {
  error_output?: string;
  command_id?: string;
  files?: string[];
  notes?: string;
}

export interface Escalation {
  id: string;
  /** Dissent requester identity is independent of the affected task. */
  dissent_id?: string;
  task?: string;
  agent: string;
  kind: EscalationKind;
  with: EscalationWith;
  target?: string;
  summary: string;
  question?: string;
  options?: string[];
  diagnostics_blob?: string;
  blocking: boolean;
  emergency?: EmergencyClass;
  status: EscalationStatus;
  routed_to?: string;
  huddle?: string;
  resolution?: { action: ResolutionAction; decision: string; by: string };
  raised_seq: number;
}

// ---------------------------------------------------------------------------
// Event catalog
// ---------------------------------------------------------------------------

export interface EventPayloads {
  "execution.created": { repo_root: string; base_sha: string; contract: string; contract_version: number };
  "execution.started": {
    confirmation: string;
    visibility: Visibility;
    budget: ContractBudget;
    lead: string;
    sandbox: SandboxBackendId;
    drivers: WorkerDriverId[];
  };
  "execution.paused": { scope: "all" | string[]; reason: string };
  "execution.resumed": { scope: "all" | string[]; reason?: string };
  "execution.steered": { message: string; targets: string[] };
  "execution.mode_changed": { from: Mode; to: Mode; reason: string; session?: string };
  "execution.completed": { integration_sha: string; pr_url?: string };
  "execution.failed": { reason: string };
  "execution.aborted": { reason: string };

  /**
   * `reason` and `patch_blob` (added in WS04) are set when the version was made by amending a draft:
   * before a contract is frozen an amendment proposes v(N+1), since contract.amended marks it frozen.
   */
  "contract.proposed": { contract: string; version: number; source: string; blob: string; reason?: string; patch_blob?: string };
  /**
   * Added in WS04 (optional): `round` identifies the round its answers name, `hash` is the
   * contractHash of the version asked about, `host` (with source.pid) the process running it.
   */
  "contract.consent_requested": { contract: string; version: number; participants: string[]; round?: string; hash?: string; host?: string };
  /** `round` (WS04, optional): the round this answers; an answer to any other round is ignored. */
  "contract.consent_recorded": { contract: string; agent: string; verdict: ConsentVerdict; reason?: string; round?: string };
  "contract.objection_resolved": { contract: string; agent: string; how: "amended" | "withdrawn" | "excused" | "dissented"; reason: string; dissent_id?: string };
  /**
   * `blob` (added in WS03) is the full contract JSON at this version, stored with putBlob. The store
   * requires it at runtime: the blackboard reads the contract from it (heads-down.md §6). It is
   * optional here only to keep this frozen interface additive.
   */
  "contract.frozen": { contract: string; version: number; by: string; hash: string; blob?: string };
  /** `blob`: the full contract JSON at the new version (required at runtime, as for contract.frozen). */
  "contract.amended": {
    contract: string;
    version: number;
    patch_blob: string;
    reason: string;
    affected_tasks: string[];
    blob?: string;
  };
  "contract.superseded": { contract: string; by_contract: string };

  "runner.started": { pid: number; version: string };
  "runner.takeover": { previous_pid: number };
  "runner.stopped": { reason: string };

  "agent.registered": {
    agent: string;
    persona: string;
    team?: string;
    driver: WorkerDriverId;
    token_sha256: string;
    external: boolean;
    /** Worker allocation reserved atomically before launch. */
    budget_usd?: number;
  };
  "agent.spawned": { agent: string; task: string; attempt: number; pid: number; session_id?: string; started?: string };
  "agent.attested": { agent: string; tools: string[]; mcp_servers: string[]; ok: boolean };
  "agent.exited": {
    agent: string;
    task?: string;
    code: number | null;
    reason: "completed" | "error" | "killed" | "lost" | "stalled" | "budget" | "attestation";
    result_subtype?: string;
    usage?: TokenUsage;
    /**
     * Added in WS10: the pause the worker stopped for (the pausing escalation's id, or the pause's
     * reason) when its task or the run was paused. Such an exit does not count against max_attempts.
     */
    paused?: string;
  };
  "agent.left": { agent: string; reason: string };

  "task.ready": { task: string };
  "task.claimed": { task: string; agent: string; attempt: number; ttl_s: number };
  "task.released": { task: string; agent: string; note?: string };
  "task.progress": { task: string; percent?: number; note: string };
  "task.submitted": { task: string; commit: string; diff_blob: string; stat: string; files: string[]; rewrites: string[] };
  /**
   * commit and submitted_seq (added in WS07) bind the result to one submission: the task.submitted
   * seq and the commit its checks ran on. The runner merges exactly that commit.
   */
  "task.checks_passed": { task: string; commands: string[]; commit?: string; submitted_seq?: number };
  "task.rejected": { task: string; reasons: string[]; violations?: string[] };
  "task.merged": { task: string; integration_sha: string };
  "task.accepted": { task: string };
  "task.blocked": { task: string; escalation?: string; deps?: string[] };
  "task.unblocked": { task: string; escalation?: string };
  "task.retried": { task: string; attempt: number; why: string };
  "task.reassigned": { task: string; from: string; to: string };
  "task.split": { task: string; into: TaskSpec[] };
  "task.failed": { task: string; why: string };
  "task.cancelled": { task: string; why: string };

  "lease.granted": { lease: Lease };
  "lease.queued": { request: LeaseRequest };
  "lease.released": { lease_id: string };
  "lease.expired": { lease_id: string };
  "lease.revoked": { lease_id: string; by: string; reason: string };
  "lease.violation": { task: string; agent: string; paths: string[] };

  "artifact.published": { name: string; kind: "interface" | "design" | "doc"; path?: string; blob?: string; task: string };
  "artifact.changed": { name: string; version: number; consumers: string[] };

  "dependency.requested": { task: string; need: { kind: "task" | "interface" | "artifact"; ref: string; owner?: string } };
  "dependency.satisfied": { task: string; need: { kind: "task" | "interface" | "artifact"; ref: string; owner?: string }; by_event: string };

  /** A submission's checks carry its task.submitted seq and commit (WS07); run_command's carry neither. */
  "check.started": { command_id: string; scope: "task" | "integration"; task?: string; commit?: string; submitted_seq?: number };
  "check.passed": { command_id: string; scope: "task" | "integration"; task?: string; duration_ms: number; commit?: string; submitted_seq?: number };
  "check.failed": {
    command_id: string;
    scope: "task" | "integration";
    task?: string;
    exit: number | null;
    signature: string;
    output_blob?: string;
    commit?: string;
    submitted_seq?: number;
  };
  "check.timed_out": { command_id: string; scope: "task" | "integration"; task?: string; commit?: string; submitted_seq?: number };

  "command.completed": {
    task: string;
    argv: string[];
    exit: number | null;
    duration_ms: number;
    signature: string;
    output_blob?: string;
  };

  "merge.succeeded": { task: string; sha: string };
  "merge.conflicted": { task: string; files: string[] };

  "note.posted": { topic: string; text: string; refs: string[] };
  "decision.recorded": { decision: Decision };
  "directive.issued": { id: string; to: string[]; text: string; requires_ack: boolean };
  "directive.acknowledged": { id: string; agent: string };
  "dissent.tripwire_fired": { dissent_id: string; task?: string; tripped_by: string; evidence: string; generation?: number; notified?: string[]; orchestrator_woken?: boolean };
  "dissent.scored": { dissent_id: string; outcome: "vindicated" | "refuted" | "untested" };

  "escalation.raised": { escalation: Escalation };
  "escalation.routed": { id: string; to: string; format?: HuddleFormat; wake: boolean };
  "escalation.auto_resolved": { id: string; rule: string };
  "escalation.resolved": { id: string; action: ResolutionAction; decision: string; by: string };
  "escalation.awaiting_human": { id: string; class: EmergencyClass; message: string; alternatives?: string[] };
  "escalation.withdrawn": { id: string; reason: string };

  "huddle.started": { id: string; escalation: string; format: HuddleFormat; seats: string[]; session?: string };
  "huddle.turn": { id: string; seat: string; blob: string };
  "huddle.concluded": { id: string; outcome: HuddleOutcome; decision?: string };

  "budget.usage_recorded": UsageRecord;
  "budget.threshold_crossed": { pct: number; spent_usd: number; budget_usd: number };
  "budget.exhausted": { scope: "execution" | "task" | "agent"; ref?: string };
  "budget.extended": { by: string; usd: number };

  "watchdog.action": { rule: string; action: string; target: string };
  /** `opens` (added in WS09): consecutive opens since the circuit last closed, this one included. */
  "watchdog.circuit_opened": { driver: string; reason: string; until: string; opens?: number };
  "watchdog.circuit_closed": { driver: string };
  "watchdog.deadlock_detected": { cycle: string[] };
  "watchdog.stall_detected": { agent: string; task?: string };

  "sandbox.degraded": { backend: SandboxBackendId; reason: string };
}

export type EventType = keyof EventPayloads;

/** Every event type, in catalog order (used by validators, dashboards and docs). */
export const EVENT_TYPES = [
  "execution.created", "execution.started", "execution.paused", "execution.resumed", "execution.steered",
  "execution.mode_changed", "execution.completed", "execution.failed", "execution.aborted",
  "contract.proposed", "contract.consent_requested", "contract.consent_recorded", "contract.objection_resolved",
  "contract.frozen", "contract.amended", "contract.superseded",
  "runner.started", "runner.takeover", "runner.stopped",
  "agent.registered", "agent.spawned", "agent.attested", "agent.exited", "agent.left",
  "task.ready", "task.claimed", "task.released", "task.progress", "task.submitted", "task.checks_passed",
  "task.rejected", "task.merged", "task.accepted", "task.blocked", "task.unblocked", "task.retried",
  "task.reassigned", "task.split", "task.failed", "task.cancelled",
  "lease.granted", "lease.queued", "lease.released", "lease.expired", "lease.revoked", "lease.violation",
  "artifact.published", "artifact.changed",
  "dependency.requested", "dependency.satisfied",
  "check.started", "check.passed", "check.failed", "check.timed_out",
  "command.completed",
  "merge.succeeded", "merge.conflicted",
  "dissent.tripwire_fired", "dissent.scored",
  "note.posted", "decision.recorded", "directive.issued", "directive.acknowledged",
  "escalation.raised", "escalation.routed", "escalation.auto_resolved", "escalation.resolved",
  "escalation.awaiting_human", "escalation.withdrawn",
  "huddle.started", "huddle.turn", "huddle.concluded",
  "budget.usage_recorded", "budget.threshold_crossed", "budget.exhausted", "budget.extended",
  "watchdog.action", "watchdog.circuit_opened", "watchdog.circuit_closed", "watchdog.deadlock_detected",
  "watchdog.stall_detected",
  "sandbox.degraded",
] as const satisfies readonly EventType[];

// Compile-time check that EVENT_TYPES lists every key of EventPayloads.
type MissingEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>;
const _allEventTypesListed: MissingEventTypes extends never ? true : MissingEventTypes = true;
void _allEventTypesListed;

export interface EventEnvelope<T extends EventType = EventType> {
  v: 1;
  id: string;
  seq: number;
  ts: string;
  execution: string;
  contract?: string;
  contract_version?: number;
  mode: Mode;
  source: EventSource;
  type: T;
  payload: EventPayloads[T];
  causation?: string;
  correlation?: string;
  /**
   * Added in WS03; set by the store, never by drafts. Present on every event of a transaction
   * that appended more than one: the batch has n events and this is number i (0-based). Readers
   * apply a batch only once all n lines are complete, so a crash mid-append never exposes half.
   */
  batch?: { n: number; i: number };
  /** Hash of the previous event; GENESIS_HASH for seq 1. */
  prev: string;
  /** sha256(prev + canonicalJSON(envelope without hash)), lowercase hex. */
  hash: string;
}

export type AnyEvent = { [T in EventType]: EventEnvelope<T> }[EventType];

export const GENESIS_HASH = "0".repeat(64);

/** What a writer supplies; the store fills in v, id, seq, ts, execution, prev and hash. */
export interface EventDraft<T extends EventType = EventType> {
  type: T;
  payload: EventPayloads[T];
  source: EventSource;
  mode?: Mode;
  contract?: string;
  contract_version?: number;
  causation?: string;
  correlation?: string;
}

export type AnyEventDraft = { [T in EventType]: EventDraft<T> }[EventType];

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export interface Visibility {
  dashboard: boolean;
  chat_only: boolean;
  github?: { repo: string; project_owner?: string; project_number?: number; create_project?: boolean; pr?: boolean };
}

// ---------------------------------------------------------------------------
// Blackboard (event-sourced projection)
// ---------------------------------------------------------------------------

export interface CheckState {
  status: "running" | "passed" | "failed" | "timed_out";
  signature?: string;
  /** Consecutive failures with the same signature and no intervening patch. */
  streak: number;
  /** Seq of the last task.submitted or patch that reset the streak. */
  since_patch_seq: number;
  blob?: string;
  at_seq: number;
}

export interface AgentRecord {
  id: string;
  persona: string;
  team?: string;
  driver: WorkerDriverId;
  external: boolean;
  token_sha256: string;
  task?: string;
  pid?: number;
  started?: string;
  budget_reserved_usd?: number;
  session_id?: string;
  status: "registered" | "running" | "exited" | "left";
}

export interface BudgetLedger {
  spent_usd: number;
  estimated: boolean;
  by_agent: Record<string, number>;
  by_task: Record<string, number>;
  by_team: Record<string, number>;
  thresholds_crossed: number[];
  /**
   * Added in WS09: the execution budget (extensions included) that thresholds_crossed refers to.
   * A threshold crossed at another total starts a new epoch, so the warnings re-arm after an
   * extension.
   */
  thresholds_budget_usd?: number;
  extensions_usd: number;
}

export interface DissentRuntime {
  spec?: Dissent;
  /** New/changed predicates match only evidence recorded after this amendment sequence. */
  armed_seq?: number;
  /** Set when changing a predicate (or reintroducing an id with historical escalations). */
  generation?: number;
  /** Deterministic tripwire keys retain every firing, including across amendments. */
  fires: Record<string, EventPayloads["dissent.tripwire_fired"] & { seq: number }>;
  /** Advisory only; never an input to consent or vote weighting. */
  score?: EventPayloads["dissent.scored"]["outcome"];
  scored_seq?: number;
}

export interface BlackboardState {
  execution: string;
  seq: number;
  hash: string;
  status: "created" | "running" | "paused" | "completed" | "failed" | "aborted";
  paused_tasks: string[];
  contract?: Contract;
  goal?: Contract["goal"];
  interfaces: Record<string, { spec?: InterfaceSpec; version: number; path?: string; blob?: string; task?: string }>;
  decisions: Decision[];
  dissents: Record<string, DissentRuntime>;
  tasks: Record<string, TaskRuntime>;
  claims: Record<string, Claim>;
  leases: Record<string, Lease>;
  lease_queue: LeaseRequest[];
  files: Record<string, { task: string; agent: string; last_commit: string; merged: boolean; at_seq?: number }>;
  diffs: Record<string, { stat: string; blob: string; commit: string }>;
  checks: Record<"task" | "integration", Record<string, CheckState>>;
  escalations: Record<string, Escalation>;
  huddles: Record<string, { escalation: string; format: HuddleFormat; seats: string[]; outcome?: HuddleOutcome; decision?: string }>;
  agents: Record<string, AgentRecord>;
  teams: Record<string, { lead?: string; members: string[] }>;
  budget: BudgetLedger;
  notes: Array<{ seq: number; agent: string; topic: string; text: string; refs: string[] }>;
  inbox: Record<string, Array<{ seq: number; kind: "directive" | "decision"; id: string; text: string; requires_ack?: boolean }>>;
  /**
   * circuits[].opens (added in WS09): consecutive opens since the last close, for the backoff. On a
   * closed circuit, until is the end of its last open period.
   */
  watchdog: { circuits: Record<string, { open: boolean; until?: string; reason?: string; opens?: number }>; deadlocks: string[][] };
  /**
   * Added in WS03: split task id → the ids of its parts (task.split). When a contract version
   * is adopted, dependencies on a split task are rewritten to its parts.
   */
  splits?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

export interface ExecutionHeader {
  id: string;
  schema: 1;
  repo_root: string;
  base_sha: string;
  agents_dir: string;
  created: string;
}

export interface TransactContext {
  state: Readonly<BlackboardState>;
  header: Readonly<ExecutionHeader>;
}

export interface ExecutionStore {
  readonly id: string;
  readonly dir: string;
  header(): ExecutionHeader;
  /** Lock, catch up to the tail, run fn against fresh state, append its drafts, unlock. Returns appended events. */
  transact<R = void>(
    fn: (ctx: TransactContext) => { events: AnyEventDraft[]; result?: R } | Promise<{ events: AnyEventDraft[]; result?: R }>
  ): Promise<{ events: AnyEvent[]; result?: R }>;
  /** Lock-free read of the current projection. */
  state(): Promise<BlackboardState>;
  /** Lock-free tail read. */
  events(opts?: { sinceSeq?: number; types?: EventType[]; limit?: number }): Promise<AnyEvent[]>;
  putBlob(content: string | Buffer, opts?: { redact?: boolean }): Promise<string>;
  getBlob(ref: string): Promise<Buffer>;
  /** Full chain verification; returns the first bad seq, if any. */
  verify(): Promise<{ ok: boolean; seq: number; badSeq?: number; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export type WorkerDriverId = "claude-code" | "codex" | "external";

export interface WorkerLaunch {
  execution: string;
  agent: string;
  task: string;
  attempt: number;
  cwd: string;
  /** The task card, written to the child's stdin; never placed on argv. */
  prompt: string;
  appendPromptPath: string;
  mcpConfigPath: string;
  settingsPath: string;
  model?: string;
  fallbackModel?: string;
  effort?: string;
  budgetUsd: number;
  sessionId: string;
  outputPath: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface WorkerHandle {
  agent: string;
  task: string;
  attempt: number;
  pid: number;
  pgid?: number;
  started?: string;
  sessionId: string;
  outputPath: string;
  startedAt: string;
}

export interface WorkerRecord extends WorkerHandle {
  driver: WorkerDriverId;
  cwd: string;
}

export interface RunAccumulator {
  sessionId?: string;
  tools?: string[];
  mcpServers?: string[];
  usage?: TokenUsage;
  costUsd?: number;
  resultSubtype?: string;
  isError?: boolean;
  lastText?: string;
  done: boolean;
  lines: number;
}

export interface WorkerDriver {
  readonly id: WorkerDriverId;
  detect(): Promise<{ ok: boolean; version?: string; missing: string[] }>;
  launch(l: WorkerLaunch): Promise<WorkerHandle>;
  resume(rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle>;
  /** Parse one output line into the accumulator. */
  parse(line: string, acc: RunAccumulator): void;
  stop(h: WorkerHandle, reason: string): Promise<void>;
  /** Read-only answer from a live worker's context (micro-huddles). */
  answer?(rec: WorkerRecord, question: string, maxUsd: number, signal?: AbortSignal): Promise<{ text: string; usage?: UsageRecord }>;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type SandboxBackendId = "docker" | "local";

export interface SandboxRunRequest {
  argv: string[];
  /** Absolute host path mounted (docker) or used as cwd (local). */
  workdir: string;
  /** Relative to workdir. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  image?: string;
  /** Hosts allowed through the egress proxy; empty or undefined means no network. */
  egress?: string[];
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exit: number | null;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout+stderr, secret-redacted, capped at maxOutputBytes. */
  output: string;
  truncated: boolean;
  backend: SandboxBackendId;
  imageDigest?: string;
  degraded?: string;
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  available(): Promise<{ ok: boolean; reason?: string; degraded?: string }>;
  run(req: SandboxRunRequest): Promise<SandboxResult>;
}
