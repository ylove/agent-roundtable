// ============================================================================
// Escalations: routing, resolution and the runner hooks (heads-down.md §12)
//
// routeEscalation runs after an escalation.raised is committed. In order:
//   1. emergencies (emergency set, or kind emergency) await the human; only the affected tasks
//      pause (the escalating task, its dependents, tasks on a failing driver), never the run;
//   2. what needs no decision resolves itself (escalation.auto_resolved): a dead leaseholder, a
//      dependency that only needs waiting, a transient rate limit. Where a watchdog rule already
//      acts (expiring an orphaned lease, unblocking on dependencies, the circuit breaker), the
//      resolution leaves the work to it;
//   3. peer escalations (agent, path_owner, team; conflict or assistance) go to a micro-huddle;
//   4. everything else is routed to the scope's orchestrator (wake: true), climbing to the parent
//      contract's orchestrator when the decision is outside a child contract's authority. The
//      watchdog's lead fallback takes over when that orchestrator's watcher is not alive.
//
// resolveEscalation applies an orchestrator's or the lead's choice (decide, huddle, retry,
// reassign, amend, dismiss, await_human). Every step is idempotent: a resolved or withdrawn
// escalation is left as it is, and every write re-checks the escalation under the store's lock.
// Provider calls never run inside transact: they run first, and their results (turns, decisions,
// budget.usage_recorded) are recorded afterwards.
// ============================================================================

import { createHash } from "node:crypto";
import { join } from "node:path";
import { executionLLM, type LLMProvider } from "../config.js";
import { loadAgent, renderSkillsSection } from "../agents.js";
import { newId } from "../ids.js";
import { callLLM, withUsageSink, type UsageReport } from "../providers/index.js";
import { scrub } from "../security/secrets.js";
import { parseVerdict } from "../sessions/workshop.js";
import { writeAgentLeases } from "../workers/files.js";
import { classifyFailure } from "./circuit.js";
import { AuthorityError, amendContract } from "./contract-lifecycle.js";
import { contractRecord, openContractStore, orchestratorSource } from "./contract-state.js";
import { leasesInQuestion, readDiagnostics, targetPaths, type Diagnostics } from "./context-bundle.js";
import { globWithin } from "./contract.js";
import { goalReview } from "./goal-review.js";
import { huddleAction, runFormatHuddle, runMicroHuddle } from "./huddle.js";
import { leadFallback } from "./lead.js";
import { cardLessons } from "../postmortem/lessons.js";
import { acquireLock } from "./lock.js";
import { normalizeGlob } from "./leases.js";
import { isFreeProvider, estimateUsd, priceFor } from "./pricing.js";
import { blockingIds, taskHeld } from "./task-holds.js";
import { buildTaskCard } from "./task-card.js";
import type { RunnerContext, RunnerHooks } from "./runner-hook-types.js";
export type { RunnerContext, RunnerHooks, GoalReviewInput, GoalReview } from "./runner-hook-types.js";
import type {
  AnyEventDraft,
  BlackboardState,
  BudgetSource,
  Decision,
  EmergencyClass,
  Escalation,
  EscalationStatus,
  EventPayloads,
  EventSource,
  EventType,
  ExecutionHeader,
  ExecutionStore,
  HuddleFormat,
  Lease,
  ResolutionAction,
  TaskState,
  TokenUsage,
  UsageRecord,
  WorkerDriver,
} from "./types.js";

// ============================================================================
// Hook context and process operations
// ============================================================================

export interface HuddleLLM {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
}

export interface HookCtx {
  store: ExecutionStore;
  /** The runner's latest state. Every hook reads the store again before it acts. */
  state: BlackboardState;
  header: ExecutionHeader;
  /** The claude-code driver: live workers answer micro-huddles through answer(). */
  driver?: WorkerDriver;
  worker?: RunnerContext["worker"];
  integrationSha?: string;
  /** Provider and model for persona calls (huddles, the lead, goal review). */
  llm: HuddleLLM;
}

interface OpBase {
  rule: "escalation" | "huddle" | "lead";
  /** Deterministic: the same resolution always yields the same key. */
  key: string;
  target: string;
}

/** What the runner does after a hook's events are committed. Idempotent for the runner. */
export type ProcessOp =
  /** Resume the task's worker (--resume) with `card` (an "immediate: resolution" task card) on stdin. */
  | (OpBase & { type: "resume_worker"; agent: string; task: string; why: string; card: string })
  /** Claim and spawn `attempt` (its task.retried is committed); the watchdog's op of the same name. */
  | (OpBase & { type: "spawn_retry"; task: string; attempt: number })
  /** Stop a worker whose task was retried or reassigned under it. */
  | (OpBase & { type: "kill_worker"; agent: string; reason: string });

export interface EscalationOptions {
  /** Whether a pid is alive on this host (default: signal 0). */
  alive?: (pid: number) => boolean;
}

/** Who acts: the runner (routing, micro-huddles), an orchestrator, or the contract's lead. */
export type Actor = { kind: "runner" } | { kind: "orchestrator"; id: string } | { kind: "lead"; id: string };

export function actorSource(a: Actor): EventSource {
  if (a.kind === "orchestrator") return orchestratorSource(a.id);
  if (a.kind === "lead") return { kind: "agent", id: a.id, pid: process.pid };
  return { kind: "runner", id: "runner", pid: process.pid };
}

export const actorName = (a: Actor): string => (a.kind === "runner" ? "runner" : a.id);

// ============================================================================
// Small helpers
// ============================================================================

export const own = <V>(map: Readonly<Record<string, V>> | undefined, key: string | undefined): V | undefined =>
  map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Scrubbed, trimmed and capped. */
export function cap(text: string | undefined, max: number): string {
  const t = scrub((text ?? "").trim());
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

export const oneLine = (text: string | undefined, max: number): string => cap((text ?? "").replace(/\s+/g, " "), max);

export const TERMINAL: ReadonlySet<TaskState> = new Set(["accepted", "failed", "cancelled"]);
/** Every status an escalation can still be resolved from. */
export const UNRESOLVED: readonly EscalationStatus[] = ["open", "routed", "in_huddle", "awaiting_human"];
const PEER_WITH = new Set(["agent", "path_owner", "team"]);
const PEER_KINDS = new Set(["conflict", "assistance"]);

export function isEmergency(esc: Escalation): boolean {
  return esc.kind === "emergency" || esc.emergency !== undefined;
}

export function isPeer(esc: Escalation): boolean {
  return PEER_WITH.has(esc.with) && PEER_KINDS.has(esc.kind);
}

export function defaultAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ev<T extends EventType>(type: T, payload: EventPayloads[T], source: EventSource, correlation: string): AnyEventDraft {
  return { type, payload, source, correlation } as unknown as AnyEventDraft;
}

/** The escalating task's agent(s) a directive reaches: the raiser when registered, else the task's agent. */
export function requesterAgents(state: Readonly<BlackboardState>, esc: Escalation): string[] {
  if (own(state.agents, esc.agent)) return [esc.agent];
  const a = own(state.tasks, esc.task)?.agent;
  return a && own(state.agents, a) ? [a] : [];
}

/** The task's transitive dependents (tasks whose depends_on reaches it), in task order. */
export function dependentsOf(state: Readonly<BlackboardState>, task: string): string[] {
  const out: string[] = [];
  const queue = [task];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [id, rt] of Object.entries(state.tasks)) {
      if (id !== task && !out.includes(id) && rt.spec.depends_on.includes(t)) {
        out.push(id);
        queue.push(id);
      }
    }
  }
  return out;
}

const blockedBy = (state: Readonly<BlackboardState>, esc: Escalation): boolean => {
  const rt = own(state.tasks, esc.task);
  return blockingIds(rt).includes(esc.id);
};

// ============================================================================
// Usage: every provider call made here becomes budget.usage_recorded
// ============================================================================

/** Conservative micro-huddle rates, including long-context and cache prompt charges. */
function microRates(model: string, provider?: string): { input: number; output: number } {
  if (provider === "ollama") return { input: 0, output: 0 };
  const p = priceFor(model);
  return {
    input: Math.max(p?.input ?? 20, p?.long?.input ?? 0, p?.cache_read ?? 0, p?.long?.cache_read ?? 0, p?.cache_write ?? 0, p?.long?.cache_write ?? 0),
    output: Math.max(p?.output ?? 100, p?.long?.output ?? 0),
  };
}

/**
 * Collects the usage of the calls run through it (withUsageSink), priced from the pricing table,
 * and of driver answers. take() turns what was collected into drafts, so usage spent by a call
 * that later failed is still recorded.
 */
interface MeterLifecycle {
  dissent_id?: string;
  huddle?: string;
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  persist?: (records: UsageRecord[]) => Promise<void>;
}

export class UsageMeter {
  private records: UsageRecord[] = [];
  private calls = 0;

  constructor(readonly source: BudgetSource, readonly task?: string, readonly agent?: string, readonly bounded = false, private readonly lifecycle: MeterLifecycle = {}) {}

  async run<T>(fn: () => Promise<T>, reservation?: { provider: string; model: string; usd: number }, usageOf?: (result: T) => UsageRecord | undefined): Promise<T> {
    const signal = this.lifecycle.signal;
    signal?.throwIfAborted();
    const callId = this.bounded ? this.lifecycle.huddle ? `${this.lifecycle.huddle}:${++this.calls}` : newId("call") : undefined;
    let current: UsageRecord | undefined;
    let finished = false;
    let dispatched = false;
    const accept = (record: UsageRecord) => {
      const u = { ...record, source: this.source,
        ...(this.task !== undefined && { task: this.task }), ...(this.agent !== undefined && { agent: this.agent }),
        ...(callId && { call_id: callId }), ...(this.lifecycle.dissent_id && { dissent_id: this.lifecycle.dissent_id }) };
      if (this.task === undefined) delete u.task;
      if (current) Object.assign(current, u);
      else { current = u; this.records.push(u); }
      // A stopped driver may report its final result after abort has already routed the huddle.
      // Replace the retained estimate without resuming discussion or holding up Stop.
      if (finished) void this.lifecycle.persist?.([{ ...current }]).catch((e) => console.error(`Micro-huddle usage settlement: ${errText(e)}`));
    };
    if (this.bounded && reservation && !isFreeProvider(reservation.provider)) {
      accept({ ...this.price({ provider: reservation.provider, model: reservation.model }, reservation.usd), reservation: true });
      // Durable before dispatch: readers and a restarted runner retain the conservative charge.
      await this.lifecycle.persist?.([current!]);
    }
    const sink = (r: UsageReport) => {
      if (finished && !this.bounded) return;
      const priced = this.price(r, reservation?.usd);
      if (this.bounded) accept({ ...priced, reservation: false });
      else this.records.push(priced);
    };
    let abort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      await this.lifecycle.beforeDispatch?.();
      signal?.throwIfAborted();
      const work = withUsageSink(sink, async () => {
        dispatched = true;
        const result = await fn();
        const u = usageOf?.(result);
        if (u) accept({ ...u, reservation: false, provenance: u.provenance ?? { tokens: "measured", usd: u.estimated ? "estimated" : "measured" },
          ...(u.estimated && u.usd === 0 && reservation && !isFreeProvider(reservation.provider) ? { usd: reservation.usd, provenance: { tokens: u.provenance?.tokens ?? "measured", usd: "estimated" } } : {}) });
        return result;
      });
      // A driver/provider that ignores abort must not leave the huddle hanging.
      return signal ? await Promise.race([work, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("Micro-huddle stopped"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]) : await work;
    } finally {
      finished = true;
      if (abort) signal?.removeEventListener("abort", abort);
      if (current) {
        if (!dispatched) current.usd = 0; // Stop won before dispatch: release the unused reservation.
        current.reservation = false;
        await this.lifecycle.persist?.([current]);
      }
    }
  }

  add(u: UsageRecord | undefined): void {
    if (u) this.records.push({ ...u, source: this.source, ...(this.task !== undefined && { task: this.task }), ...(this.agent !== undefined && { agent: this.agent }) });
  }

  private price(r: UsageReport, missingUsageUsd?: number): UsageRecord {
    const tokens: TokenUsage = { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
    if (r.usage?.cacheReadTokens !== undefined) tokens.cacheReadTokens = r.usage.cacheReadTokens;
    if (r.usage?.cacheWriteTokens !== undefined) tokens.cacheWriteTokens = r.usage.cacheWriteTokens;
    const model = r.model || "unknown";
    const estimate = estimateUsd(model, tokens, { provider: r.provider });
    const rates = this.bounded && estimate.estimated ? microRates(model, r.provider) : undefined;
    const reserved = this.bounded && r.usage === undefined && r.provider !== "ollama" ? missingUsageUsd : undefined;
    return {
      source: this.source,
      ...(this.task !== undefined && { task: this.task }),
      ...(this.agent !== undefined && { agent: this.agent }),
      ...(r.provider && { provider: r.provider }),
      model,
      tokens,
      usd: r.usd ?? reserved ?? (rates ? ((tokens.inputTokens + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0)) * rates.input + tokens.outputTokens * rates.output) / 1_000_000 : estimate.usd),
      estimated: r.usd === undefined,
      // Provider tokens are measured; dollar costs are estimated unless the driver measured them.
      provenance: { tokens: r.usage ? "measured" : "estimated", usd: r.usd === undefined ? "estimated" : "measured" },
    };
  }

  get pendingUsd(): number { return this.records.reduce((sum, r) => sum + r.usd, 0); }

  /** Drafts for everything collected since the last take. */
  take(source: EventSource, correlation: string): AnyEventDraft[] {
    const out = this.lifecycle.persist ? [] : this.records.map((u) => ev("budget.usage_recorded", u, source, correlation));
    this.records = [];
    return out;
  }
}

export function callOptions(llm: HuddleLLM): { provider: LLMProvider; model: string; baseUrl?: string } {
  return { provider: llm.provider, model: llm.model, ...(llm.baseUrl !== undefined && { baseUrl: llm.baseUrl }) };
}

/** One stateless persona call: the persona (body and skills) plus `directive` as the system prompt. */
export async function askPersona(meter: UsageMeter, llm: HuddleLLM, persona: string, directive: string, prompt: string, allowance?: number): Promise<string> {
  if (meter.bounded && allowance === undefined) throw new Error("A bounded persona call requires a budget allowance");
  const a = await loadAgent(persona);
  const system = a.body + renderSkillsSection(a.skills) + directive;
  let maxTokens: number | undefined;
  if (allowance !== undefined) {
    const { input: inputRate, output: outputRate } = microRates(llm.model, llm.provider);
    // UTF-8 bytes plus protocol overhead conservatively bound prompt tokens without a tokenizer.
    const inputCost = (Buffer.byteLength(system + prompt, "utf8") + 512) * inputRate / 1_000_000;
    const left = allowance - inputCost;
    if (left <= 0) throw new Error("Micro-huddle budget cannot cover the next prompt");
    maxTokens = outputRate ? Math.min(8192, Math.floor(left * 1_000_000 / outputRate)) : 8192;
    if (maxTokens < 1) throw new Error("Micro-huddle budget is exhausted");
  }
  return meter.run(() => callLLM(system, [{ role: "user", content: prompt }], { ...callOptions(llm), ...(maxTokens !== undefined && { maxTokens }) }),
    allowance === undefined ? undefined : { provider: llm.provider, model: llm.model, usd: allowance });
}

// ============================================================================
// Parsing answers
// ============================================================================

/**
 * parseVerdict for options that may contain underscores (NEEDS_ORCHESTRATOR, await_human):
 * parseVerdict drops markdown emphasis characters, underscores included, before matching.
 */
export function verdictOf<T extends string>(text: string, label: string, options: readonly T[]): T | "UNCLEAR" {
  const variants = new Map<string, T>();
  for (const o of options) for (const v of [o, o.replace(/_/g, ""), o.replace(/_/g, " ")]) if (!variants.has(v)) variants.set(v, o);
  const v = parseVerdict(text, label, [...variants.keys()]);
  return v === "UNCLEAR" ? "UNCLEAR" : variants.get(v) ?? "UNCLEAR";
}

const LABEL_LINE = /^\s*(?:#+\s*|>\s*)?(?:\*\*|__)?[A-Z][A-Za-z _-]{0,30}(?:\*\*|__)?\s*:/;

/**
 * The value of the first `Label:` line (the last with `last`) and the lines continuing it (up to
 * the next `Label:` line or a fence).
 */
export function parseField(text: string, label: string, max = 2000, last = false): string | undefined {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:#+\\s*|>\\s*|[-+]\\s+)?[*_\`]*${esc}[*_\`]*\\s*:(.*)$`, "i");
  const lines = text.split(/\r?\n/);
  const starts = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  const i = last ? starts.at(-1) : starts[0];
  if (i === undefined) return undefined;
  const out = [re.exec(lines[i])![1].replace(/^[\s*_`]+/, "")];
  for (let j = i + 1; j < lines.length && !/^\s*```/.test(lines[j]) && !LABEL_LINE.test(lines[j]); j++) out.push(lines[j]);
  const v = out.join("\n").trim();
  return v ? cap(v, max) : undefined;
}

/**
 * The answer's own lines: none inside a fenced block or a blockquote (`>`), where an answer
 * quotes the escalation and other agents' words. Agent-written text is untrusted: it can carry
 * lines that look like directives.
 */
export function ownLines(text: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === undefined) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence === undefined && !/^\s*>/.test(line)) out.push(line);
  }
  return out;
}

/**
 * The answer's own `Label: <option>` directive: verdictOf on each of its own lines (ownLines).
 * CONFLICT when its own lines name different options, which callers treat as no directive and
 * fail closed on; UNCLEAR when none does.
 */
export function directiveOf<T extends string>(text: string, label: string, options: readonly T[]): T | "UNCLEAR" | "CONFLICT" {
  const found = new Set<T>();
  for (const line of ownLines(text)) {
    const v = verdictOf(line, label, options);
    if (v !== "UNCLEAR") found.add(v);
  }
  return found.size > 1 ? "CONFLICT" : found.size === 1 ? [...found][0] : "UNCLEAR";
}

/** The last `Label:` field among the answer's own lines (ownLines): the answer's own, not one it quotes. */
export function directiveField(text: string, label: string, max = 2000): string | undefined {
  return parseField(ownLines(text).join("\n"), label, max, true);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The first fenced ```json (or untagged) block that parses to an object. */
export function fencedJson(text: string): Record<string, unknown> | undefined {
  for (const m of text.matchAll(/```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g)) {
    if (m[1] && m[1].toLowerCase() !== "json") continue;
    try {
      const v: unknown = JSON.parse(m[2]);
      if (isPlainObject(v)) return v;
    } catch {
      /* the next block */
    }
  }
  return undefined;
}

// ============================================================================
// Committing: every write re-checks the escalation under the lock
// ============================================================================

/** Resume only pauses owned by this escalation, preserving other emergencies and manual pauses. */
export async function pausedBy(store: ExecutionStore, state: Readonly<BlackboardState>, id: string, releasing: readonly string[] = [id]): Promise<string[]> {
  const owners = new Map<string, Set<string>>();
  for (const e of await store.events({ types: ["execution.paused", "execution.resumed"] })) {
    if (e.type === "execution.paused" && Array.isArray(e.payload.scope)) {
      for (const task of e.payload.scope) {
        const set = owners.get(task) ?? new Set<string>();
        set.add(e.correlation ?? `manual:${e.seq}`);
        owners.set(task, set);
      }
    } else if (e.type === "execution.resumed") {
      const scope = e.payload.scope === "all" ? [...owners.keys()] : e.payload.scope;
      for (const task of scope) {
        if (e.correlation) owners.get(task)?.delete(e.correlation);
        else owners.delete(task);
      }
    }
  }
  return state.paused_tasks.filter((task) => {
    const set = owners.get(task);
    if (!set?.has(id)) return false;
    return ![...set].some((other) => !releasing.includes(other) &&
      (other.startsWith("manual:") || UNRESOLVED.includes(own(state.escalations, other)?.status ?? "resolved")));
  });
}

async function hasPaused(store: ExecutionStore, id: string): Promise<boolean> {
  return (await store.events({ types: ["execution.paused"] })).some((e) => e.correlation === id);
}

/** Append drafts that do not depend on any escalation's status (usage, notes). */
export async function recordDrafts(store: ExecutionStore, drafts: AnyEventDraft[]): Promise<void> {
  if (drafts.length) await store.transact(() => ({ events: drafts }));
}

export interface CommitOptions {
  /** Statuses the escalation must be in (default UNRESOLVED). */
  expect?: readonly EscalationStatus[];
  /** A further condition on the fresh state. */
  guard?: (state: Readonly<BlackboardState>, esc: Escalation) => boolean;
  /** Recorded whatever the escalation's status: what already happened (huddle turns, usage). */
  always?: AnyEventDraft[];
}

/**
 * One transaction: `always`, plus then(state, esc) when the escalation still qualifies. Returns
 * whether then's events were written (false when it no longer qualifies or then had nothing to add).
 */
export async function commitIf(
  store: ExecutionStore,
  id: string,
  o: CommitOptions,
  then: (state: Readonly<BlackboardState>, esc: Escalation) => AnyEventDraft[] | Promise<AnyEventDraft[]>
): Promise<boolean> {
  const r = await store.transact<boolean>(async ({ state }) => {
    const esc = own(state.escalations, id);
    const ok = !!esc && (o.expect ?? UNRESOLVED).includes(esc.status) && (o.guard?.(state, esc) ?? true);
    const events = ok ? await then(state, esc!) : [];
    return { events: [...(o.always ?? []), ...events], result: events.length > 0 };
  });
  return r.result === true;
}

export interface ResolutionPlan {
  action: ResolutionAction;
  decision: string;
  /** escalation.resolved.by */
  by: string;
  source: EventSource;
  /** Recorded with decision.recorded (delivered to their scopes' inboxes). */
  decisions?: Decision[];
  /** A directive to the requester. */
  directive?: string;
  /** Before escalation.resolved (task.retried, huddle.concluded, …). */
  before?: AnyEventDraft[];
  /** task.unblocked for a task this escalation blocks (default true). */
  unblock?: boolean;
  /** The resolution text on the resumed worker's card (default: the decision); false for no resume. */
  resume?: string | false;
  /** Further operations once committed (kill, spawn_retry). */
  ops?: ProcessOp[];
  rule?: OpBase["rule"];
}

export interface Committed {
  applied: boolean;
  ops: ProcessOp[];
  state: BlackboardState;
}

const DECISION_MAX = 2000;

/**
 * Resolve the escalation in one batch: the plan's events, decision.recorded, escalation.resolved,
 * the directive, task.unblocked, and execution.resumed for the tasks it paused. The requester is
 * resumed when this escalation was what blocked its task.
 */
export async function commitResolution(store: ExecutionStore, id: string, plan: ResolutionPlan, o: CommitOptions = {}): Promise<Committed> {
  let wasBlocked = false;
  let esc: Escalation | undefined;
  const decision = cap(plan.decision, DECISION_MAX) || plan.action;
  const applied = await commitIf(store, id, o, async (state, e) => {
    esc = e;
    wasBlocked = blockedBy(state, e);
    const src = plan.source;
    const events: AnyEventDraft[] = [...(plan.before ?? [])];
    for (const d of plan.decisions ?? []) events.push(ev("decision.recorded", { decision: { ...d, text: cap(d.text, DECISION_MAX) } }, src, id));
    events.push(ev("escalation.resolved", { id, action: plan.action, decision, by: plan.by }, src, id));
    const to = requesterAgents(state, e);
    if (plan.directive && to.length) {
      events.push(ev("directive.issued", { id: newId("dir"), to, text: cap(plan.directive, DECISION_MAX + 500), requires_ack: false }, src, id));
    }
    if (plan.unblock !== false && wasBlocked) {
      events.push(ev("task.unblocked", { task: e.task!, escalation: e.id }, src, id));
    }
    const paused = await pausedBy(store, state, id);
    if (paused.length) events.push(ev("execution.resumed", { scope: paused, reason: `escalation ${id} was resolved` }, src, id));
    return events;
  });
  const state = await store.state();
  if (!applied || !esc) return { applied, ops: [], state };
  const ops = [...(wasBlocked && plan.resume !== false ? resumeOps(state, esc, plan.resume ?? decision, plan.rule ?? "escalation") : []), ...(plan.ops ?? [])];
  return { applied, ops, state };
}

/** Resume the escalating task's runner worker (not an external one) with the resolution on its card. */
export function resumeOps(state: Readonly<BlackboardState>, esc: Escalation, text: string, rule: OpBase["rule"]): ProcessOp[] {
  const task = esc.task;
  const rt = own(state.tasks, task);
  const claim = own(state.claims, task);
  if (!task || !rt || rt.state !== "in_progress" || !claim || taskHeld(state, task)) return [];
  const rec = own(state.agents, claim.agent);
  if (!rec || rec.external || rec.driver === "external") return [];
  const card = buildTaskCard(state, task, { immediate: { kind: "resolution", text: `Escalation ${esc.id}: ${text}` }, ...cardLessons(state, task) });
  return [{ type: "resume_worker", rule, key: `${esc.id}:resume`, target: claim.agent, agent: claim.agent, task, why: oneLine(`Resolution of escalation ${esc.id}: ${text}`, 300), card }];
}

// ============================================================================
// Routing to the orchestrator
// ============================================================================

/**
 * Whether a child contract's escalation is outside its authority: anything for management, a
 * resource (budget and time come from the parent's task), or a path outside the child's scope.
 */
export function outsideChildAuthority(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): boolean {
  const c = state.contract;
  if (!c?.scope.parent) return false;
  if (esc.with === "management" || esc.kind === "resource") return true;
  const scope = c.scope.paths.map((p) => normalizeGlob(p)).filter((p): p is string => p !== null);
  return targetPaths(state, esc, diag).some((p) => {
    const g = normalizeGlob(p);
    return g === null || !scope.some((s) => globWithin(g, s));
  });
}

/** contract.scope.orchestrator, or the parent contract's when the decision is outside a child contract's authority. */
export async function scopeOrchestrator(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "files">): Promise<string> {
  const c = state.contract;
  if (!c) throw new Error(`Execution ${state.execution} has no frozen contract`);
  const parent = c.scope.parent;
  if (parent && outsideChildAuthority(state, esc, diag)) {
    try {
      return (await contractRecord(await openContractStore(parent.contract), parent.contract)).contract.scope.orchestrator;
    } catch (e) {
      console.error(`[Escalation] ${esc.id}: the parent contract ${parent.contract} could not be read (${errText(e)}); routing to ${c.scope.orchestrator}`);
    }
  }
  return c.scope.orchestrator;
}

/** escalation.routed {to: the scope's orchestrator, wake: true}, while the escalation is in one of `expect`. */
export async function routeToOrchestrator(ctx: HookCtx, id: string, o: CommitOptions & { source?: EventSource } = {}): Promise<boolean> {
  const state = await ctx.store.state();
  const esc = own(state.escalations, id);
  if (!esc) return false;
  const to = await scopeOrchestrator(state, esc, await readDiagnostics(ctx.store, esc));
  const source = o.source ?? actorSource({ kind: "runner" });
  return commitIf(ctx.store, id, { expect: ["open"], ...o }, () => [ev("escalation.routed", { id, to, wake: true }, source, id)]);
}

// ============================================================================
// Emergencies: await the human, pausing only the affected tasks
// ============================================================================

/** The failing driver behind an emergency: named by the watchdog's diagnostics, or the raiser's driver while its circuit is open. */
export function emergencyDriver(state: Readonly<BlackboardState>, esc: Escalation, diag?: Pick<Diagnostics, "notes">): string | undefined {
  const named = /\bdriver ([a-z][a-z0-9-]*)/.exec(diag?.notes ?? "")?.[1];
  if (named && Object.values(state.agents).some((a) => a.driver === named)) return named;
  const rec = own(state.agents, esc.agent);
  return rec && own(state.watchdog.circuits, rec.driver)?.open ? rec.driver : undefined;
}

/**
 * The tasks an emergency pauses: the escalating task and its transitive dependents and, for
 * credentials or money failing on a driver, every task whose agent runs on that driver. Only
 * tasks that are not finished; overlapping pauses keep their separate owners.
 */
export function affectedByEmergency(state: Readonly<BlackboardState>, esc: Escalation, cls: EmergencyClass, driver?: string): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const rt = own(state.tasks, t);
    if (rt && !TERMINAL.has(rt.state) && !out.includes(t)) out.push(t);
  };
  if (esc.task) {
    add(esc.task);
    for (const d of dependentsOf(state, esc.task)) add(d);
  }
  if (driver && (cls === "credentials" || cls === "money")) {
    for (const t of Object.keys(state.tasks).sort()) {
      const a = state.tasks[t].agent ?? own(state.claims, t)?.agent;
      if (a && own(state.agents, a)?.driver === driver) add(t);
    }
  }
  return out;
}

export interface AwaitHumanOptions {
  actor: Actor;
  class?: EmergencyClass;
  message?: string;
  alternatives?: string[];
  /** Recorded first, whatever happens (usage of the call that led here). */
  always?: AnyEventDraft[];
}

/**
 * escalation.awaiting_human (unless the watchdog already recorded it), then execution.paused for
 * the affected tasks and a directive to their agents, once per escalation. Never pauses the run.
 */
export async function awaitHuman(ctx: HookCtx, id: string, o: AwaitHumanOptions): Promise<boolean> {
  const pre = await ctx.store.state();
  const esc0 = own(pre.escalations, id);
  if (!esc0) return false;
  const diag = await readDiagnostics(ctx.store, esc0);
  const driver = emergencyDriver(pre, esc0, diag);
  const source = actorSource(o.actor);
  return commitIf(ctx.store, id, { always: o.always }, async (state, esc) => {
    const events: AnyEventDraft[] = [];
    const cls = o.class ?? esc.emergency ?? "human_action";
    const message = cap(o.message ?? [esc.summary, esc.question].filter(Boolean).join("\n\n"), 2000) || `Escalation ${id} needs the human`;
    if (esc.status !== "awaiting_human") {
      const alternatives = (o.alternatives ?? esc.options ?? []).slice(0, 10).map((a) => oneLine(a, 300));
      events.push(ev("escalation.awaiting_human", { id, class: cls, message, ...(alternatives.length && { alternatives }) }, source, id));
    }
    if (await hasPaused(ctx.store, id)) return events;
    const affected = affectedByEmergency(state, esc, cls, driver);
    if (!affected.length) return events;
    events.push(ev("execution.paused", { scope: affected, reason: `escalation ${id} awaits the human (${cls})` }, source, id));
    const agents = [...new Set(affected.map((t) => state.tasks[t].agent).filter((a): a is string => !!a && !!own(state.agents, a)))];
    if (agents.length) {
      events.push(ev("directive.issued", {
        id: newId("dir"), to: agents, requires_ack: false,
        text: `Paused: escalation ${id} (${cls}) awaits the human: ${oneLine(message, 600)} Tasks paused: ${affected.join(", ")}. Stop, end your turn with a one-line summary, and wait to be resumed.`,
      }, source, id));
    }
    return events;
  });
}

// ============================================================================
// Automatic resolution
// ============================================================================

const HELD_FOR_MERGE: ReadonlySet<TaskState> = new Set(["submitted", "checking", "merging"]);

/**
 * Why a lease's holder no longer needs it: "orphan" when its task is finished (the watchdog
 * expires the lease), "gone" when nobody works the task any more (the agent left, its claim is
 * gone, or a runner worker exited or died). Undefined while the holder is alive, waiting on its
 * own escalation, paused, or its work is being checked or merged. External holders are left to the
 * watchdog's claim expiry.
 */
export function leaseHolderGone(state: Readonly<BlackboardState>, lease: Lease, alive: (pid: number) => boolean): "orphan" | "gone" | undefined {
  const rt = own(state.tasks, lease.task);
  if (!rt || TERMINAL.has(rt.state)) return "orphan";
  if (HELD_FOR_MERGE.has(rt.state) || rt.state === "blocked" || state.status === "paused" || state.paused_tasks.includes(lease.task)) return undefined;
  const rec = own(state.agents, lease.agent);
  if (!rec || rec.status === "left") return "gone";
  const claim = own(state.claims, lease.task);
  if (!claim || claim.agent !== lease.agent) return "gone";
  if (rec.external || claim.ttl_s > 0) return undefined;
  if (rec.status === "exited") return "gone";
  if (rec.status === "running" && rec.pid !== undefined && !alive(rec.pid)) return "gone";
  return undefined;
}

export interface AutoResolution {
  rule: "dead_leaseholder" | "lease_orphan" | "dependency_wait" | "dependency_satisfied" | "transient_rate_limit";
  /** Before escalation.auto_resolved. */
  events: (source: EventSource, id: string) => AnyEventDraft[];
  /** Unblock the task and resume its worker with this text; undefined leaves the task as the events set it. */
  resume?: string;
  /** A directive to the requester (for an escalation that did not block). */
  directive?: string;
  /** Agents whose leases were revoked (their leases.json is rewritten). */
  revoked: string[];
}

function deadLeaseholder(state: Readonly<BlackboardState>, esc: Escalation, diag: Diagnostics | undefined, alive: (pid: number) => boolean): AutoResolution | undefined {
  if (esc.with !== "path_owner" && esc.kind !== "conflict") return undefined;
  const leases = leasesInQuestion(state, esc, diag);
  if (!leases.length) return undefined;
  const why = leases.map((l) => leaseHolderGone(state, l, alive));
  if (why.some((w) => w === undefined)) return undefined;
  const gone = leases.filter((_, i) => why[i] === "gone");
  const paths = [...new Set(leases.flatMap((l) => l.paths))].slice(0, 8).join(", ");
  return {
    rule: gone.length ? "dead_leaseholder" : "lease_orphan",
    events: (source, id) => gone.map((l) => ev("lease.revoked", { lease_id: l.id, by: source.id, reason: `its holder ${l.agent} is gone (escalation ${id})` }, source, id)),
    resume: `The holder of ${paths} is gone: ${gone.length ? "its lease was revoked" : "its task has finished, so its lease expires"}. A queued request of yours is granted next; otherwise request the lease again with lease(action: "request").`,
    revoked: [...new Set(gone.map((l) => l.agent))],
  };
}

function dependencyWait(state: Readonly<BlackboardState>, esc: Escalation): AutoResolution | undefined {
  if (esc.kind !== "blocker" || !esc.task || !esc.target || esc.target === esc.task) return undefined;
  const t = esc.target;
  const iface = own(state.interfaces, t);
  const depTask = own(state.tasks, t) ? t : iface?.spec?.owner;
  if (!depTask || depTask === esc.task || !own(state.tasks, depTask)) return undefined;
  const dep = state.tasks[depTask];
  if (dep.state === "failed" || dep.state === "cancelled") return undefined;
  if (dependentsOf(state, esc.task).includes(depTask)) return undefined; // it waits on us: the orchestrator decides
  const label = own(state.tasks, t) ? `task ${t}` : `interface ${t} (task ${depTask})`;
  if (own(state.tasks, t) ? dep.state === "accepted" : (iface?.version ?? 0) >= 1) {
    return { rule: "dependency_satisfied", events: () => [], resume: `${label} is done: continue with it.`, revoked: [] };
  }
  const rt = state.tasks[esc.task];
  if (rt.state === "blocked" && rt.blocked_by?.escalation === esc.id) {
    // The watchdog unblocks a task blocked on dependencies once they are accepted or published. A
    // block keeps its escalation through a later task.blocked, so the task is unblocked first.
    return {
      rule: "dependency_wait",
      events: (source, id) => [ev("task.unblocked", { task: esc.task! }, source, id), ev("task.blocked", { task: esc.task!, deps: [t] }, source, id)],
      revoked: [],
    };
  }
  return { rule: "dependency_wait", events: () => [], directive: `${label} is ${dep.state}: wait for it (post_update kind "need" blocks your task until it is done).`, revoked: [] };
}

function transientRateLimit(state: Readonly<BlackboardState>, esc: Escalation): AutoResolution | undefined {
  if (!esc.task || (esc.kind !== "resource" && esc.kind !== "blocker")) return undefined;
  const rec = own(state.agents, esc.agent);
  const circuit = rec ? own(state.watchdog.circuits, rec.driver) : undefined;
  // The circuit breaker holds respawns on that driver until the limit passes; never classify command output.
  const byCircuit = !!circuit?.open && /rate limit/i.test(circuit.reason ?? "");
  const byText = classifyFailure([esc.summary, esc.question ?? ""].join("\n"), { source: "provider" }) === "rate_limit";
  if (!byCircuit && !byText) return undefined;
  return { rule: "transient_rate_limit", events: () => [], resume: "The rate limit was transient: continue where you stopped.", revoked: [] };
}

/** The automatic resolution of an agent's escalation, if one applies. Watchdog escalations never auto-resolve. */
export function autoResolution(state: Readonly<BlackboardState>, esc: Escalation, diag: Diagnostics | undefined, alive: (pid: number) => boolean): AutoResolution | undefined {
  if (esc.agent === "watchdog" || isEmergency(esc)) return undefined;
  return deadLeaseholder(state, esc, diag, alive) ?? dependencyWait(state, esc) ?? transientRateLimit(state, esc);
}

async function commitAuto(ctx: HookCtx, id: string, auto: AutoResolution): Promise<ProcessOp[]> {
  const source = actorSource({ kind: "runner" });
  let wasBlocked = false;
  let esc: Escalation | undefined;
  const applied = await commitIf(ctx.store, id, { expect: ["open"] }, (state, e) => {
    esc = e;
    wasBlocked = blockedBy(state, e);
    const events = [...auto.events(source, id), ev("escalation.auto_resolved", { id, rule: auto.rule }, source, id)];
    if (auto.directive && !wasBlocked) {
      const to = requesterAgents(state, e);
      if (to.length) events.push(ev("directive.issued", { id: newId("dir"), to, text: auto.directive, requires_ack: false }, source, id));
    }
    if (auto.resume !== undefined && wasBlocked) events.push(ev("task.unblocked", { task: e.task! }, source, id));
    return events;
  });
  if (!applied || !esc) return [];
  for (const agent of auto.revoked) {
    try {
      await writeAgentLeases(ctx.store, agent);
    } catch (e) {
      console.error(`[Escalation] ${id}: could not rewrite the leases of ${agent}: ${errText(e)}`);
    }
  }
  return auto.resume !== undefined && wasBlocked ? resumeOps(await ctx.store.state(), esc, auto.resume, "escalation") : [];
}

// ============================================================================
// Routing (#82)
// ============================================================================

/**
 * Route a newly raised escalation (see the header). Idempotent: an escalation that is no longer
 * open is left alone, except an emergency whose tasks are not paused yet (the watchdog records
 * awaiting_human but pauses nothing), a huddle that concluded but whose outcome was not applied
 * (finishConcludedHuddle), and a resolution whose resume has not started yet (owedResumeOps).
 */
export async function routeEscalation(ctx: HookCtx, id: string, opts: EscalationOptions = {}): Promise<ProcessOp[]> {
  const state = await ctx.store.state();
  const esc = own(state.escalations, id);
  if (!esc || !state.contract) return [];
  if (esc.status === "resolved") return owedResumeOps(ctx, id);
  if (isEmergency(esc)) {
    if (esc.status === "open" || esc.status === "awaiting_human") await awaitHuman(ctx, id, { actor: { kind: "runner" } });
    return [];
  }
  if (esc.status === "in_huddle") return finishConcludedHuddle(ctx, id, opts);
  if (esc.status !== "open") return [];
  const diag = await readDiagnostics(ctx.store, esc);
  const auto = autoResolution(state, esc, diag, opts.alive ?? defaultAlive);
  if (auto) return commitAuto(ctx, id, auto);
  if (isPeer(esc)) return runMicroHuddle(ctx, id, { ...opts, actor: { kind: "runner" }, expect: ["open"] });
  await routeToOrchestrator(ctx, id);
  return [];
}

// ============================================================================
// Resolution (#84)
// ============================================================================

export interface ResolveOptions {
  action: ResolutionAction;
  /** decide: required. The resolution text for every other action. */
  decision?: string;
  /** huddle: the format (default micro). */
  format?: HuddleFormat;
  /** huddle: the personas taking part (default: the requester's, the target's and the lead). */
  participants?: string[];
  /** amend: an RFC 7396 merge patch of the contract. */
  amendment?: Record<string, unknown>;
  /** reassign: the persona that takes the task over (default participants[0]). */
  persona?: string;
  /** Who resolves: the contract's orchestrator (or the one the escalation was routed to), or its lead. */
  resolved_by: string;
  /** Acting as the lead (within authority.may) or the orchestrator; inferred from resolved_by. */
  as?: "orchestrator" | "lead";
}

export interface ResolveResult {
  /** The escalation after the call. */
  escalation: Escalation;
  ops: ProcessOp[];
  /** Nothing changed: the escalation was already resolved or withdrawn, or changed meanwhile. */
  noop: boolean;
  /** What was applied (a huddle ends as decide, amend, retry or dismiss). */
  applied?: ResolutionAction;
  decision?: string;
  huddle?: string;
  amended?: { version: number; affected: string[] };
  warnings: string[];
}

const ACTIONS: readonly ResolutionAction[] = ["decide", "huddle", "retry", "reassign", "amend", "dismiss", "await_human"];

async function current(ctx: HookCtx, id: string, r: Omit<ResolveResult, "escalation">): Promise<ResolveResult> {
  const esc = own((await ctx.store.state()).escalations, id);
  if (!esc) throw new Error(`Unknown escalation ${id}`);
  return { escalation: esc, ...r };
}

function resolverActor(state: Readonly<BlackboardState>, esc: Escalation, opts: ResolveOptions): Actor {
  const c = state.contract!;
  const by = typeof opts.resolved_by === "string" ? opts.resolved_by.trim() : "";
  if (!by) throw new Error("resolved_by is required: the orchestrator's name, or the lead");
  const lead = opts.as ? opts.as === "lead" : by === c.authority.lead && by !== c.scope.orchestrator;
  if (lead) {
    if (by !== c.authority.lead) throw new Error(`Only the contract's lead (${c.authority.lead}) resolves within the lead's authority; ${by} cannot`);
    return { kind: "lead", id: by };
  }
  const allowed = [c.scope.orchestrator, ...(esc.routed_to && esc.routed_to !== c.authority.lead ? [esc.routed_to] : [])];
  if (!allowed.includes(by)) throw new Error(`Only ${[...new Set(allowed)].join(" or ")} can resolve ${esc.id}; ${by} cannot`);
  return { kind: "orchestrator", id: by };
}

function needAuthority(state: Readonly<BlackboardState>, actor: Actor, action: "retry" | "reassign"): void {
  const c = state.contract!;
  if (actor.kind === "lead" && !c.authority.may.includes(action)) throw new AuthorityError(c.id, [`${action === "retry" ? "retrying" : "reassigning"} a task needs "${action}"`]);
}

interface AppliedAmendment {
  version: number;
  affected?: { all: string[] };
}

/** amendContract as the actor: the lead within authority.may, the orchestrator without a limit. */
async function amendAs(ctx: HookCtx, actor: Actor, patch: Record<string, unknown>, reason: string, fromSession?: string, escalationId?: string): Promise<AppliedAmendment> {
  const marker = escalationId ? `Escalation ${escalationId} amendment: ` : undefined;
  if (marker) {
    const previous = (await ctx.store.events({ types: ["contract.amended"] }))
      .find((e) => e.type === "contract.amended" && e.payload.reason.startsWith(marker));
    if (previous?.type === "contract.amended") {
      return { version: previous.payload.version, affected: { all: previous.payload.affected_tasks } };
    }
  }
  const c = (await ctx.store.state()).contract!;
  return amendContract(ctx.store, patch, {
    by: actorName(actor),
    reason: (marker ?? "") + reason,
    ...(fromSession && { fromSession }),
    ...(actor.kind === "lead" && { authority: [...c.authority.may] }),
    source: actorSource(actor),
  });
}

/**
 * Resolve an escalation (the resolve_escalation tool, and the lead fallback). Idempotent: an
 * escalation already resolved or withdrawn is returned as it is. The lead's retry and reassign
 * need them in authority.may, and its amendments must stay within authorityNeeds (AuthorityError
 * otherwise). decide, dismiss and await_human change no contract and need no authority.
 */
export async function resolveEscalation(ctx: HookCtx, id: string, opts: ResolveOptions, x: EscalationOptions = {}): Promise<ResolveResult> {
  const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
  // This separate lock serializes resolvers, including engines, without holding events.lock.
  const release = await acquireLock(join(ctx.store.dir, `resolution-${key}.lock`), { staleMs: 10_000, timeoutMs: 30_000 });
  try {
    return await resolve(ctx, id, opts, x);
  } finally {
    await release();
  }
}

async function resolve(ctx: HookCtx, id: string, opts: ResolveOptions, x: EscalationOptions): Promise<ResolveResult> {
  if (!ACTIONS.includes(opts.action)) throw new Error(`Unknown action ${JSON.stringify(opts.action)}; expected one of ${ACTIONS.join(", ")}`);
  const state = await ctx.store.state();
  const esc = own(state.escalations, id);
  if (!esc) throw new Error(`Unknown escalation ${id}`);
  if (!state.contract) throw new Error(`Execution ${state.execution} has no frozen contract`);
  const warnings: string[] = [];
  if (!UNRESOLVED.includes(esc.status)) return { escalation: esc, ops: [], noop: true, warnings };
  const actor = resolverActor(state, esc, opts);
  const by = actorName(actor);
  const source = actorSource(actor);
  const decision = opts.decision?.trim() ? cap(opts.decision, DECISION_MAX) : undefined;
  const done = async (c: Committed, extra: Partial<ResolveResult> = {}): Promise<ResolveResult> =>
    current(ctx, id, { ops: c.ops, noop: !c.applied, ...(c.applied && { applied: extra.applied ?? opts.action }), ...(decision && { decision }), ...extra, warnings });

  switch (opts.action) {
    case "decide": {
      if (!decision) throw new Error("decide needs a decision");
      return done(await commitResolution(ctx.store, id, decidePlan(state, esc, decision, by, source)));
    }
    case "dismiss": {
      const text = decision ?? `Dismissed by ${by}: continue without an answer.`;
      return done(await commitResolution(ctx.store, id, { action: "dismiss", decision: text, by, source, directive: `Escalation ${id} was dismissed: ${text}` }));
    }
    case "await_human": {
      const applied = await awaitHuman(ctx, id, { actor, ...(decision && { message: decision }) });
      return current(ctx, id, { ops: [], noop: !applied, ...(applied && { applied: "await_human" as const }), ...(decision && { decision }), warnings });
    }
    case "retry": {
      needAuthority(state, actor, "retry");
      return done(await commitResolution(ctx.store, id, retryPlan(state, esc, decision ?? `Retried by ${by} after escalation ${id}`, by, source)));
    }
    case "reassign": {
      needAuthority(state, actor, "reassign");
      const persona = (opts.persona ?? opts.participants?.[0])?.trim();
      if (!persona) throw new Error("reassign needs the persona that takes the task over (persona, or participants[0])");
      const task = own(state.tasks, esc.task);
      if (!esc.task || !task) throw new Error(`Escalation ${id} names no task to reassign`);
      if (task.state === "accepted" || task.state === "cancelled") throw new Error(`Task ${esc.task} is ${task.state}: it cannot be reassigned`);
      const c = state.contract;
      const patch = { tasks: c.tasks.map((t) => (t.id === esc.task ? { ...t, persona } : t)) };
      const amended = await amendAs(ctx, actor, patch, `reassign ${esc.task} to ${persona} (escalation ${id})`, undefined, id);
      const after = await ctx.store.state();
      const text = decision ?? `Task ${esc.task} was reassigned to ${persona}.`;
      return done(await commitResolution(ctx.store, id, reassignPlan(after, esc, persona, text, by, source)), {
        amended: { version: amended.version, affected: amended.affected?.all ?? [] },
      });
    }
    case "amend": {
      if (!opts.amendment || typeof opts.amendment !== "object" || Array.isArray(opts.amendment)) throw new Error("amend needs an amendment (an RFC 7396 merge patch of the contract)");
      const amended = await amendAs(ctx, actor, opts.amendment, decision ?? `escalation ${id}`, undefined, id);
      const text = decision ?? `The contract was amended to v${amended.version}; re-read it before you continue.`;
      return done(await commitResolution(ctx.store, id, { action: "amend", decision: text, by, source, directive: `Escalation ${id}: ${text}` }), {
        amended: { version: amended.version, affected: amended.affected?.all ?? [] },
      });
    }
    case "huddle":
      return resolveByHuddle(ctx, id, opts, actor, warnings, x);
  }
}

function decidePlan(state: Readonly<BlackboardState>, esc: Escalation, decision: string, by: string, source: EventSource): ResolutionPlan {
  const scope = esc.task && own(state.tasks, esc.task) ? esc.task : "contract";
  return {
    action: "decide", decision, by, source,
    decisions: [{ id: newId("dec"), scope, text: decision, rationale: `resolution of escalation ${esc.id}`, by }],
    directive: `Escalation ${esc.id} is resolved: ${decision}`,
  };
}

function retryPlan(state: Readonly<BlackboardState>, esc: Escalation, text: string, by: string, source: EventSource): ResolutionPlan {
  const rt = own(state.tasks, esc.task);
  if (!esc.task || !rt) throw new Error(`Escalation ${esc.id} names no task to retry`);
  if (rt.state === "accepted" || rt.state === "cancelled") throw new Error(`Task ${esc.task} is ${rt.state}: it cannot be retried`);
  const attempt = rt.attempt + 1;
  const ops: ProcessOp[] = [];
  const agent = rt.agent ?? own(state.claims, esc.task)?.agent;
  if (agent && own(state.agents, agent)?.status === "running") {
    ops.push({ type: "kill_worker", rule: "escalation", key: `${esc.id}:kill`, target: agent, agent, reason: `Task ${esc.task} is retried (escalation ${esc.id})` });
  }
  ops.push({ type: "spawn_retry", rule: "escalation", key: `${esc.id}:retry:${attempt}`, target: esc.task, task: esc.task, attempt });
  return {
    action: "retry", decision: text, by, source, resume: false, ops,
    before: [ev("task.retried", { task: esc.task, attempt, why: cap(text, 1000) }, source, esc.id)],
  };
}

function reassignPlan(state: Readonly<BlackboardState>, esc: Escalation, persona: string, text: string, by: string, source: EventSource): ResolutionPlan {
  const task = esc.task!;
  const rt = state.tasks[task];
  const agent = rt.agent ?? own(state.claims, task)?.agent;
  const before: AnyEventDraft[] = [];
  const ops: ProcessOp[] = [];
  const started = rt.state !== "pending" && rt.state !== "ready";
  if (!TERMINAL.has(rt.state)) before.push(ev("task.reassigned", { task, from: agent ?? rt.spec.persona, to: persona }, source, esc.id));
  if (started) {
    // A fresh attempt: the runner spawns the new persona from the amended spec.
    const attempt = rt.attempt + 1;
    before.push(ev("task.retried", { task, attempt, why: cap(`reassigned to ${persona}: ${text}`, 1000) }, source, esc.id));
    if (agent && own(state.agents, agent)?.status === "running") {
      ops.push({ type: "kill_worker", rule: "escalation", key: `${esc.id}:kill`, target: agent, agent, reason: `Task ${task} was reassigned to ${persona}` });
    }
    ops.push({ type: "spawn_retry", rule: "escalation", key: `${esc.id}:reassign:${attempt}`, target: task, task, attempt });
  }
  return { action: "reassign", decision: text, by, source, resume: false, before, ops, directive: started ? `Task ${task} was reassigned to ${persona}: stop working on it.` : undefined };
}

/** The huddle action: a micro-huddle, or a format run through the engines and concluded by the lead. */
async function resolveByHuddle(ctx: HookCtx, id: string, opts: ResolveOptions, actor: Actor, warnings: string[], x: EscalationOptions): Promise<ResolveResult> {
  let format = opts.format ?? "micro";
  const state = await ctx.store.state();
  const esc = own(state.escalations, id)!;
  const previous = own(state.huddles, esc.huddle);
  if (esc.status === "in_huddle" && previous) format = previous.format;
  let h: Awaited<ReturnType<typeof runFormatHuddle>>;
  if (esc.status === "in_huddle" && previous?.outcome === "DECIDED" && previous.decision && esc.huddle) {
    // An engine concluded before a crash; apply its persisted result without running it again.
    let session: string | undefined;
    let action: "decide" | "retry" | "dismiss" = "decide";
    for (const e of (await ctx.store.events({ types: ["huddle.turn"] })).reverse()) {
      if (e.type !== "huddle.turn" || e.payload.id !== esc.huddle) continue;
      const text = (await ctx.store.getBlob(e.payload.blob)).toString("utf8");
      session = /^Session: ([a-z0-9-]+)\n/.exec(text)?.[1];
      if (session) {
        action = huddleAction(text);
        break;
      }
    }
    h = { huddle: esc.huddle, outcome: "DECIDED", decision: previous.decision, session, action };
  } else if (esc.status === "in_huddle" && previous?.outcome !== undefined && esc.huddle) {
    // It concluded without a usable decision before a crash: the fallback below still applies.
    h = { huddle: esc.huddle, outcome: previous.outcome, error: previous.decision ?? `the ${format} huddle reached no decision` };
  } else {
    if (esc.status === "in_huddle") {
      warnings.push(`${id} is already in huddle ${esc.huddle ?? ""}`.trim());
      return current(ctx, id, { ops: [], noop: true, warnings });
    }
    const expect: EscalationStatus[] = ["open", "routed", "awaiting_human"];
    if (format === "micro") {
      const ops = await runMicroHuddle(ctx, id, { ...x, actor, expect });
      const after = own((await ctx.store.state()).escalations, id)!;
      return { escalation: after, ops, noop: after.huddle === esc.huddle, ...(after.huddle && { huddle: after.huddle }), ...(after.resolution && { applied: after.resolution.action, decision: after.resolution.decision }), warnings };
    }
    h = await runFormatHuddle(ctx, id, { format, participants: opts.participants, actor, expect });
  }
  if (!h) return current(ctx, id, { ops: [], noop: true, warnings });
  const source = actorSource(actor);
  const by = actorName(actor);
  const fallback = async (why: string): Promise<ResolveResult> => {
    warnings.push(why);
    if (actor.kind === "lead") await awaitHuman(ctx, id, { actor, message: `The lead's ${format} huddle ${h.huddle} on ${id} reached no usable outcome: ${why}` });
    else await routeToOrchestrator(ctx, id, { expect: ["in_huddle", "open", "routed"], source });
    return current(ctx, id, { ops: [], noop: false, huddle: h.huddle, warnings });
  };
  if (h.outcome !== "DECIDED" || !h.decision) return fallback(h.error ?? `the ${format} huddle reached no decision`);
  const base = { expect: ["in_huddle", "open", "routed", "awaiting_human"] as EscalationStatus[] };
  if ((format === "replan" || format === "ultraplan") && h.session) {
    let amended: AppliedAmendment;
    try {
      amended = await amendAs(ctx, actor, {}, `re-plan of escalation ${id} (huddle ${h.huddle})`, h.session, id);
    } catch (e) {
      if (/changes nothing/.test(errText(e))) {
        warnings.push(`the re-plan in ${h.session} left the contract unchanged`);
        return finishHuddle(ctx, id, h.huddle, decidePlan(state, esc, h.decision, by, source), base, warnings);
      }
      return fallback(`the re-plan could not amend the contract: ${errText(e).split("\n").slice(0, 3).join(" ")}`);
    }
    const text = `${h.decision} (contract amended to v${amended.version})`;
    return finishHuddle(ctx, id, h.huddle, { action: "amend", decision: text, by, source, directive: `Escalation ${id}: ${text}. Re-read the contract before you continue.` }, base, warnings, {
      amended: { version: amended.version, affected: amended.affected?.all ?? [] },
    });
  }
  if (h.action === "retry" && (actor.kind !== "lead" || state.contract!.authority.may.includes("retry")) && esc.task) {
    return finishHuddle(ctx, id, h.huddle, retryPlan(await ctx.store.state(), esc, h.decision, by, source), base, warnings);
  }
  if (h.action === "dismiss") {
    return finishHuddle(ctx, id, h.huddle, { action: "dismiss", decision: h.decision, by, source, directive: `Escalation ${id} was dismissed: ${h.decision}` }, base, warnings);
  }
  return finishHuddle(ctx, id, h.huddle, decidePlan(state, esc, h.decision, by, source), base, warnings);
}

async function finishHuddle(ctx: HookCtx, id: string, huddle: string, plan: ResolutionPlan, o: CommitOptions, warnings: string[], extra: Partial<ResolveResult> = {}): Promise<ResolveResult> {
  const c = await commitResolution(ctx.store, id, { ...plan, rule: "huddle" }, o);
  return current(ctx, id, { ops: c.ops, noop: !c.applied, huddle, ...(c.applied && { applied: plan.action }), decision: plan.decision, ...extra, warnings });
}

// ============================================================================
// Recovery: what a resolution left undone (a failed or lost resume, an unapplied huddle)
// ============================================================================

/** The resume card of an automatic resolution, re-derived (its first card named the paths). */
const AUTO_RESUME: Readonly<Record<string, string>> = {
  dead_leaseholder: "The holder of the lease you waited on is gone and its lease was revoked. A queued request of yours is granted next; otherwise request the lease again with lease(action: \"request\").",
  lease_orphan: "The holder of the lease you waited on has finished, so its lease expires. A queued request of yours is granted next; otherwise request the lease again with lease(action: \"request\").",
  dependency_satisfied: "What you waited on is done: continue with it.",
  transient_rate_limit: "The rate limit was transient: continue where you stopped.",
};

/**
 * The resumes resolutions still owe: a task.unblocked a resolution wrote (correlated with its
 * escalation) that no agent.spawned or task.retried for the task has followed. The same
 * resume_worker op (same key) comes back on every call until one does, so a resume that failed
 * (the runner could not start it, the worker died) or was lost in a crash between the commit
 * and the op is issued again. A worker still running needs none: the directive reaches it.
 */
export async function owedResumeOps(ctx: HookCtx, only?: string): Promise<ProcessOp[]> {
  const owed = new Map<string, string>();
  for (const e of await ctx.store.events({ types: ["task.unblocked", "task.blocked", "agent.spawned", "task.retried"] })) {
    if (e.type === "task.unblocked") {
      if (e.correlation) owed.set(e.payload.task, e.correlation);
    } else if (e.type === "task.blocked" || e.type === "agent.spawned" || e.type === "task.retried") owed.delete(e.payload.task);
  }
  const state = await ctx.store.state();
  const ops: ProcessOp[] = [];
  for (const [task, id] of owed) {
    const esc = own(state.escalations, id);
    const r = esc?.resolution;
    if ((only !== undefined && id !== only) || !esc || !r || esc.status !== "resolved" || esc.task !== task) continue;
    if (r.action === "retry" || r.action === "reassign") continue; // a new attempt, not a resume
    if (own(state.agents, own(state.claims, task)?.agent)?.status === "running") continue;
    const text = (r.by === "runner" ? own(AUTO_RESUME, r.decision) : undefined) ?? r.decision;
    ops.push(...resumeOps(state, esc, text, r.action === "huddle" ? "huddle" : "escalation"));
  }
  return ops;
}

/**
 * A huddle that concluded while its escalation is still in_huddle: the process stopped between
 * recording huddle.concluded and applying it. Apply it now, once, as whoever started it: a
 * decision through resolveEscalation (which re-runs no engine and no model call), any other
 * outcome through its fallback (the orchestrator, or the human for the lead's huddle). The
 * micro-huddle records its conclusion with its outcome in one batch; one started by the runner
 * goes to the orchestrator.
 */
export async function finishConcludedHuddle(ctx: HookCtx, id: string, opts: EscalationOptions = {}): Promise<ProcessOp[]> {
  const state = await ctx.store.state();
  const esc = own(state.escalations, id);
  const c = state.contract;
  if (!esc || !c || esc.status !== "in_huddle" || own(state.huddles, esc.huddle)?.outcome === undefined) return [];
  const started = (await ctx.store.events({ types: ["huddle.started"] })).find((e) => e.type === "huddle.started" && e.payload.id === esc.huddle);
  const src = started?.source;
  const lead = src?.kind === "agent" && src.id === c.authority.lead;
  if (!src || (src.kind !== "orchestrator" && !lead)) {
    await routeToOrchestrator(ctx, id, { expect: ["in_huddle"] });
    return [];
  }
  return (await resolveEscalation(ctx, id, { action: "huddle", resolved_by: src.id, as: lead ? "lead" : "orchestrator" }, opts)).ops;
}

// ============================================================================
// Runner hooks (WS08 plugs these in)
// ============================================================================

export interface RunnerHookOptions extends EscalationOptions {
  /** Defaults to executionLLM(): ROUNDTABLE_EXECUTION_PROVIDER, _MODEL and _BASE_URL, else anthropic. */
  llm?: HuddleLLM;
}

/** The persona-call settings from the environment (config.executionLLM), read when a hook runs. */
export function executionHuddleLLM(): HuddleLLM {
  const { provider, model, baseUrl } = executionLLM();
  return { provider, model, ...(baseUrl !== undefined && { baseUrl }) };
}

/** Adapt the WS08 controls to the context shared by WS10 and WS11. */
export async function runnerHookContext(ctx: RunnerContext, opts: RunnerHookOptions = {}): Promise<HookCtx> {
  return {
    store: ctx.store, state: await ctx.store.state(), header: ctx.header,
    // The run's driver: a live claude-code worker answers a micro-huddle through driver.answer().
    driver: ctx.driver(), worker: (agent) => ctx.worker(agent),
    llm: opts.llm ?? executionHuddleLLM(),
  };
}

/**
 * WS10's hooks for the runner. Each returns the process operations of what it resolved (a resume,
 * a retry, a kill); the runner applies them once per key, stops before starts.
 */
export function createRunnerHooks(opts: RunnerHookOptions = {}): RunnerHooks {
  return {
    async escalationRouter(ctx, escalation) {
      return routeEscalation(await runnerHookContext(ctx, opts), escalation.id, opts);
    },
    async leadFallback(ctx, id) {
      return leadFallback(await runnerHookContext(ctx, opts), id, opts);
    },
    async escalationPass(ctx) {
      // No model call here: owed resumes, and concluded huddles applied from their records.
      const h = await runnerHookContext(ctx, opts);
      const ops = await owedResumeOps(h);
      for (const esc of Object.values(h.state.escalations)) {
        if (esc.status === "in_huddle" && own(h.state.huddles, esc.huddle)?.outcome !== undefined) ops.push(...await finishConcludedHuddle(h, esc.id, opts));
      }
      return ops;
    },
    async goalReview(ctx, input) {
      const r = await goalReview({ ...await runnerHookContext(ctx, opts), integrationSha: input.integrationSha });
      return { verdict: r.verdict, ...(r.gaps.length && { reason: r.gaps.join("; ") }) };
    },
  };
}
