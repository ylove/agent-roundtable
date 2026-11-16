// ============================================================================
// Ultraplan: specialist input, independent reviews and final sign-offs
// ============================================================================

import { validateSessionCap, setSessionCap, clearSessionCap, sessionCapView, sessionSpend } from "../usage/session-caps.js";
import { prepareSeats } from "../table/seats.js";
import { callSeat } from "../table/dispatch.js";
import { checkSeatConnectorArgs, startSeatConnectors, withSeatConnectors, type SeatConnectorMap, type SeatConnectorSession } from "../table/seat-connectors.js";
import type { Seat } from "../table/events.js";
import { DEFAULT_MODELS, MAX_TOKENS, PARALLEL_TURNS, PROVIDER_IDS, resolveAnthropicModel, type LLMProvider } from "../config.js";
import { agentKey, loadAgentPromptWithPath } from "../agents.js";
import { recordActivity } from "../activity.js";
import { newId } from "../ids.js";
import { SessionBusyError, isSessionBusy, lockSession, sessionBusyMessage } from "./lock.js";
import { archiveUltraplan } from "./archive.js";
import { callLLM } from "../providers/index.js";
import { lineFor, metered, stoppedOutcome, type StoppedInfo } from "../usage/session-scope.js";
import { activeUsageSink, withUsageSink } from "../providers/usage.js";
import { isFreeProvider } from "../execution/pricing.js";
import { estimateSessionCost, type SessionCostCall, type SessionCostEstimate } from "../usage/estimate.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";
import { mapLimit, notFoundError, runVerdictRound, truncate } from "./workshop.js";
import { TASK_BLOCK_NEXT, TASK_BLOCK_SIGNOFF_CHECK, buildTaskBlockInstructions } from "../execution/contract-parse.js";

export type UltraplanStatus = "awaiting_plan" | "awaiting_revision" | "finalized";
export const REVIEW_VERDICTS = ["APPROVE", "APPROVE WITH CHANGES", "OBJECT"] as const;
export const SIGNOFF_VERDICTS = ["APPROVE", "APPROVE WITH RESERVATIONS", "OBJECT"] as const;

export interface UltraplanEntry {
  phase: "input" | "plan" | "review" | "signoff";
  version?: number;
  agentIndex?: number;
  speaker: string;
  content: string;
  verdict?: string;
  timestamp: Date;
}

export interface Ultraplan {
  id: string;
  task: string;
  context?: string;
  agents: Array<{ name: string; key: string; systemPrompt: string }>;
  planner?: { name: string; key: string; systemPrompt: string };
  routing?: Seat[];
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  status: UltraplanStatus;
  versions: Array<{ version: number; plan: string; author: string; timestamp: Date }>;
  entries: UltraplanEntry[];
  startedAt: Date;
  publicChannel?: PublicChannel;
  /** Plans end with a roundtable-tasks block that propose_contract can build a contract from. */
  executionReady?: boolean;
  /** Who it runs for, e.g. a heads-down huddle; tags its activity entry and archive record. */
  origin?: string;
  /** Set when a person stopped the ultraplan (usage visibility): it then ends as it stands. */
  stopped?: StoppedInfo;
  /** MCP connectors the agents may call as tools; started once for the ultraplan and closed when it ends. */
  connectors?: SeatConnectorSession;
  /** One line per connector call or notice. */
  toolNotes?: string[];
  estimate?: SessionCostEstimate;
  estimateNote?: string;
  usage?: UltraplanUsage;
}

export interface UltraplanUsage {
  spent_usd: number;
  max_usd?: number;
  cap_reached?: boolean;
  estimated?: true;
}

export function formatUltraplanUsage(usage: UltraplanUsage): string {
  return `Usage: ${usage.max_usd === undefined ? `$${usage.spent_usd.toFixed(4)}`
    : `spent $${usage.spent_usd.toFixed(4)} of $${usage.max_usd} cap${usage.cap_reached ? " (stopped by spend cap)" : ""}`}${usage.estimated ? " (estimated)" : ""}`;
}

export function formatUltraplanEstimate(estimate: SessionCostEstimate): string {
  // Round upwards so the displayed upper bound never understates the calculated amount.
  const dollars = (usd: number) => (Math.ceil(usd * 100) / 100).toFixed(2);
  const seats = estimate.perSeat.map(line => `${line.seat ? `${line.seat}: ` : ""}${line.provider}/${line.model} $${dollars(line.usd)}${line.estimated ? " (estimated)" : ""}`);
  return `Estimated cost: up to $${dollars(estimate.usd)} (${estimate.calls} agent calls; ${seats.join(", ")})`;
}

function usageFor(u: Ultraplan): UltraplanUsage {
  const cap = sessionCapView(u.id);
  return { spent_usd: cap?.spentUsd ?? u.usage?.spent_usd ?? 0,
    ...(cap && { max_usd: cap.maxUsd, cap_reached: cap.reached }),
    ...(u.usage?.estimated && { estimated: true }) };
}

type Input = { agent: string; content: string };
type Verdict = Input & { verdict: string };
type PlanVersion = Ultraplan["versions"][number];

export interface UltraplanStepResult {
  estimate?: SessionCostEstimate;
  estimateNote?: string;
  usage: UltraplanUsage;
  routing?: Seat[];
  ultraplanId: string;
  status: "awaiting_plan" | "awaiting_revision";
  phase: "input" | "review" | "plan";
  version?: number;
  input?: Input[];
  reviews?: Verdict[];
  previousReviews?: { version: number; reviews: Verdict[] };
  tally?: Record<string, number>;
  next: string;
  public?: { url: string | null; topic: string };
  error?: string;
  /** Latest planner text, provided only when an autonomous run stops early. */
  plan?: string;
}

export interface UltraplanFinalResult {
  estimate?: SessionCostEstimate;
  estimateNote?: string;
  usage: UltraplanUsage;
  routing?: Seat[];
  ultraplanId: string;
  status: "finalized";
  /** True only when sign-offs were collected and none is OBJECT or UNCLEAR. */
  signedOff: boolean;
  /** Whether the session reached the archive (SESSIONS_DIR/<id>.json), so from_session can use it. */
  archived: boolean;
  version: number | null;
  finalPlan: string;
  signoffs: Verdict[];
  tally: Record<string, number>;
  publicBlock?: string;
  /** One line per connector call, when the ultraplan used connectors. */
  toolUses?: string[];
}

export interface UltraplanDryRunResult {
  status: "dry_run";
  dry_run: true;
  estimate: SessionCostEstimate;
  estimateNote: string;
  usage: UltraplanUsage;
  routing?: Seat[];
}

export const ultraplans = new Map<string, Ultraplan>();

function ultraplanBusy(id: string): string {
  return sessionBusyMessage("Ultraplan", id, "a phase");
}

export const NEXT_AFTER_INPUT = "Write plan v1 that incorporates this input. Tag each step with the agents whose input shaped it, e.g. [cfo]. Then call submit_plan; pass final: true to go straight to sign-off.";
export const NEXT_AFTER_REVIEW = "Revise the plan to address the amendments (say which you rejected and why), then call submit_plan again, or submit_plan with final: true to collect sign-offs and close.";

export function buildUnreviewedNext(version: number): string {
  return `Plan v${version} has not been reviewed yet. Call submit_plan without a plan to have v${version} reviewed as-is, ` +
    "with a revised plan, or with final: true (plan optional) to collect sign-offs.";
}

export function buildPlannerStoppedError(step: string, error: string): string {
  return `Planner run stopped during ${step}: ${error}. The session is open: continue with submit_plan or close with end_ultraplan.`;
}

// ----------------------------------------------------------------------------
// Pure prompt builders
// ----------------------------------------------------------------------------

export function buildUltraplanParticipantDirective(): string {
  return "\n\n## Ultraplan role: plan contributor\n" +
    "You are one of several specialists shaping a plan someone else (the planner) writes. " +
    "Improve it from your expertise. Be concrete: steps, owners, numbers, sequencing, dependencies, risks, acceptance criteria. " +
    "Propose targeted changes, never rewrite the whole plan. Say plainly when something is outside your expertise.";
}

export function buildUltraplanPlannerDirective(): string {
  return "\n\n## Ultraplan role: planner\n" +
    "You own the plan. Write it so someone can execute it. Incorporate specialists' input. " +
    "You may reject input but must say why.";
}

function taskBlock(task: string, context?: string): string {
  return `**Task:** ${task}\n\n` + (context?.trim() ? `**Context:**\n${context}\n\n` : "");
}

export function buildInputPrompt(task: string, participants: string[], context?: string): string {
  return "The plan has not been written yet. Give input from your expertise.\n\n" +
    taskBlock(task, context) + `**Participants:** ${participants.join(", ")}\n\n` +
    "Give input under exactly these headings:\n1. Must cover\n2. Recommended approach\n3. Risks and dependencies\n4. Would make me object\n\nBullets, no preamble.";
}

export function buildReviewPrompt(
  task: string, context: string | undefined, plan: string, version: number, author: string,
  ownInput?: string, ownPreviousReview?: string
): string {
  const check = [
    ...(ownInput !== undefined ? ["whether your earlier input was reflected"] : []),
    ...(ownPreviousReview !== undefined ? ["whether your previous review was addressed"] : []),
  ];
  return taskBlock(task, context) + `**Plan v${version} (by ${author}):**\n${plan}\n\n` +
    (ownInput !== undefined ? `**Your input before the draft:**\n${ownInput}\n\n` : "") +
    (ownPreviousReview !== undefined ? `**Your previous review:**\n${ownPreviousReview}\n\n` : "") +
    "The first line must be EXACTLY one of:\nVerdict: APPROVE | APPROVE WITH CHANGES | OBJECT\n\n" +
    "Then include:\nAmendments: numbered; each names the plan step and the concrete add/change/remove.\n" +
    "Blocking concerns: or \"None\".\n" +
    `Check: ${check.length ? check.join("; ") : "whether anything important is missing"}.\n\n` +
    "Don't rewrite the plan. Don't repeat points that are already handled.";
}

/** With executionReady, participants also check the plan's roundtable-tasks block. */
export function buildSignoffPrompt(task: string, plan: string, version: number, ownInput?: string, context?: string, executionReady = false): string {
  return taskBlock(task, context) + `**Final plan v${version}:**\n${plan}\n\n` +
    (ownInput !== undefined ? `**Your input before the draft:**\n${ownInput}\n\n` : "") +
    "The first line must be EXACTLY one of:\nSign-off: APPROVE | APPROVE WITH RESERVATIONS | OBJECT\n\n" +
    "Reflected from my input: 1-3 bullets or \"Nothing specific\".\n" +
    "Still missing or disagree: or \"None\".\nWatch: one thing to monitor during execution.\n\n" +
    (executionReady ? `${TASK_BLOCK_SIGNOFF_CHECK}\n\n` : "") + "Brief.";
}

/** With executionReady, the plan must end with a roundtable-tasks block. */
export function buildPlannerDraftPrompt(
  task: string, context: string | undefined, participants: string[], inputs: Input[], executionReady = false
): string {
  return taskBlock(task, context) + `**Participants:** ${participants.join(", ")}\n\n` +
    inputs.map((input) => `### ${input.agent}\n${input.content}\n\n`).join("") +
    "Write plan v1: numbered steps with owner/role, sequencing and dependencies, acceptance criteria, " +
    "risks with mitigations, open questions. Tag each step with contributing participants like [a, b]. " +
    "Output the plan only." + (executionReady ? `\n\n${buildTaskBlockInstructions()}` : "");
}

/** With executionReady, the revised plan must end with an updated roundtable-tasks block. */
export function buildPlannerRevisePrompt(task: string, plan: string, version: number, reviews: Verdict[], context?: string, executionReady = false): string {
  return taskBlock(task, context) + `**Current plan v${version}:**\n${plan}\n\n` +
    reviews.map((review) => `### ${review.agent} (${review.verdict})\n${review.content}\n\n`).join("") +
    `Write plan v${version + 1}: for each amendment accept, modify or reject. Output the full revised plan, ` +
    `then a section \"## Changes from v${version}\" listing each amendment by reviewer and what was done, ` +
    "with a one-line reason for each rejection." +
    (executionReady ? ` The roundtable-tasks block, updated to match, goes last, after that section.\n\n${buildTaskBlockInstructions()}` : "");
}

// ----------------------------------------------------------------------------
// Recording and display
// ----------------------------------------------------------------------------

function label(u: Ultraplan, name: string): string {
  return u.publicChannel ? publicLabel(name) : name;
}

/** The only entry append path; public failures cannot interrupt a committed phase. */
export function recordUltraplanEntry(u: Ultraplan, entry: UltraplanEntry): UltraplanEntry {
  u.entries.push(entry);
  if (u.publicChannel) {
    const name = publicLabel(entry.speaker);
    const suffix = entry.phase === "plan" ? `plan v${entry.version}`
      : entry.phase === "review" ? `review of v${entry.version}`
        : entry.phase === "signoff" ? "sign-off" : "input";
    try {
      u.publicChannel.record({
        turn: u.entries.length, speaker: `${name} · ${suffix}`, content: entry.content,
        kind: entry.phase === "plan" && entry.speaker === "orchestrator" ? "caller" : "turn",
      });
    } catch (e) {
      console.error(`[Ultraplan] public record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return entry;
}

export function tallyVerdicts(verdicts: string[], options: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = Object.fromEntries([...options, "UNCLEAR"].map((option) => [option, 0]));
  for (const verdict of verdicts) tally[options.includes(verdict) ? verdict : "UNCLEAR"]++;
  return tally;
}

function signoffCounts(tally: Record<string, number>): string {
  return `${tally.APPROVE} approve, ${tally["APPROVE WITH RESERVATIONS"]} approve with reservations, ${tally.OBJECT} object` +
    (tally.UNCLEAR > 0 ? `, ${tally.UNCLEAR} unclear` : "");
}

/** Signed off: sign-offs were collected and none is OBJECT or UNCLEAR. */
export function isSignedOff(signoffs: Array<{ verdict: string }>): boolean {
  return signoffs.length > 0 && signoffs.every((s) => s.verdict !== "OBJECT" && (SIGNOFF_VERDICTS as readonly string[]).includes(s.verdict));
}

/** `collected`: sign-offs were asked for (submit_plan final, planner runs); end_ultraplan collects none. */
export function renderUltraplanDocument(u: Ultraplan, signoffs: Verdict[], collected: boolean): string {
  const firstLine = u.task.trim().split(/\r?\n/)[0];
  const title = firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
  const latest = u.versions.at(-1);
  const tally = tallyVerdicts(signoffs.map((s) => s.verdict), SIGNOFF_VERDICTS);
  const signedOff = collected && isSignedOff(signoffs);
  const blocks = [
    `# Ultraplan: ${title}`,
    `Planner: ${u.planner ? label(u, u.planner.name) : "orchestrator"} · Participants: ${u.agents.map((a) => label(u, a.name)).join(", ")} · Plan versions: ${u.versions.length} · ` +
      (collected ? `Sign-off: ${signoffCounts(tally)}${signedOff ? "" : " — not signed off"}` : "Not signed off"),
    ...(u.estimate ? [formatUltraplanEstimate(u.estimate), u.estimateNote ?? ""] : []),
    formatUltraplanUsage(usageFor(u)),
    latest ? `## ${signedOff ? "Final" : "Latest"} plan (v${latest.version})${signedOff ? "" : " — not signed off"}\n\n${latest.plan}`
      : "## Plan\n\nNo plan was submitted.",
    "## Sign-offs",
    ...(collected ? signoffs.map((s) => `### ${label(u, s.agent)} — ${s.verdict}\n${s.content}`)
      : ["(none: the session was closed without sign-off)"]),
    "## Agent input",
  ];
  const inputs = u.entries.filter((e) => e.phase === "input");
  blocks.push(...(inputs.length ? inputs.map((e) => `### ${label(u, e.speaker)}\n${truncate(e.content, 6000)}`)
    : ["(no input phase: the session started from a draft)"]));
  blocks.push("## Revision history");
  blocks.push(u.versions.length ? u.versions.map((v) => {
    const prefix = `- v${v.version} by ${label(u, v.author)} — `;
    if (signedOff && v === latest) return prefix + "final, signed off";
    if (collected && v === latest) {
      const against = signoffs.filter((s) => s.verdict === "OBJECT" || !(SIGNOFF_VERDICTS as readonly string[]).includes(s.verdict));
      return prefix + `final, not signed off: ${against.map((s) => `${label(u, s.agent)} ${s.verdict}`).join(", ")}`;
    }
    const reviews = latestReviews(u, v.version);
    return prefix + (reviews.length ? `reviews: ${reviews.map((e) => `${label(u, e.speaker)} ${e.verdict}`).join(", ")}` : "not reviewed");
  }).join("\n") : "(no plan versions)");
  return blocks.join("\n\n");
}

// ----------------------------------------------------------------------------
// Phase computation and atomic commits
// ----------------------------------------------------------------------------

function dispatch(u: Ultraplan, agent: string, system: string, messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<string> {
  const seat = u.routing?.find(s => s.id === agent);
  // With connectors every agent turn goes through the seat dispatcher, which runs the tool loop.
  if (u.connectors) {
    return withSeatConnectors(u.connectors, () => callSeat(system, messages, {
      provider: seat?.provider ?? u.provider, model: seat?.model ?? u.model, baseUrl: u.baseUrl,
      ...(seat?.maxOutputTokens !== undefined && { maxTokens: Math.min(MAX_TOKENS, seat.maxOutputTokens) }),
    }, { agent, ...(seat && { onModelFallback: (model: string) => { seat.model = model; } }) }));
  }
  return seat ? callSeat(system, messages, { provider: seat.provider, model: seat.model, baseUrl: u.baseUrl, ...(seat.maxOutputTokens !== undefined && { maxTokens: Math.min(MAX_TOKENS, seat.maxOutputTokens) }) }, {
    agent, onModelFallback: model => { seat.model = model; },
  }) : callLLM(system, messages, { provider: u.provider, model: u.model, baseUrl: u.baseUrl });
}
/** Observe the same reports the ledger and cap receive, including under an outer execution sink. */
function observeUsage<T>(u: Ultraplan, agent: string, run: () => Promise<T>): Promise<T> {
  const ledger = activeUsageSink();
  return withUsageSink(report => {
    const line = lineFor({ session: u.id, kind: "ultraplan", agent }, report, "ultraplan");
    const usage = u.usage ??= { spent_usd: 0 };
    usage.spent_usd += sessionSpend(line);
    if (!isFreeProvider(line.provider) && (line.tokens_prov === "estimated" || line.usd_prov !== "reported")) usage.estimated = true;
    ledger?.(report);
  }, run);
}

function ask(u: Ultraplan, agent: string, systemPrompt: string, prompt: string): Promise<string> {
  return metered({ session: u.id, kind: "ultraplan", agent }, () => observeUsage(u, agent,
    () => dispatch(u, agent, systemPrompt, [{ role: "user", content: prompt }])));
}

function ownEntry(u: Ultraplan, phase: "input" | "review", index: number): string | undefined {
  for (let i = u.entries.length - 1; i >= 0; i--) {
    const entry = u.entries[i];
    if (entry.phase === phase && entry.agentIndex === index) return entry.content;
  }
  return undefined;
}

async function computePhase(u: Ultraplan, phase: "input" | "review" | "signoff", v?: PlanVersion): Promise<UltraplanEntry[]> {
  if (phase === "input") {
    return mapLimit(u.agents, PARALLEL_TURNS, async (agent, agentIndex) => {
      const content = await ask(u, agent.name, agent.systemPrompt, buildInputPrompt(u.task, u.agents.map((a) => label(u, a.name)), u.context));
      return { phase, agentIndex, speaker: agent.name, content, timestamp: new Date() };
    });
  }
  const review = phase === "review";
  const answers = await runVerdictRound(u.agents, (agent, agentIndex) => {
    const ownInput = ownEntry(u, "input", agentIndex);
    return review ? buildReviewPrompt(u.task, u.context, v!.plan, v!.version, label(u, v!.author), ownInput, ownEntry(u, "review", agentIndex))
      : buildSignoffPrompt(u.task, v!.plan, v!.version, ownInput, u.context, u.executionReady === true);
  }, review ? "Verdict" : "Sign-off", {
    verdicts: review ? REVIEW_VERDICTS : SIGNOFF_VERDICTS,
    llm: { provider: u.provider, model: u.model, baseUrl: u.baseUrl },
    ask: (agent, messages) => observeUsage(u, agent.name, () => dispatch(u, agent.name, agent.systemPrompt, messages)),
    limit: PARALLEL_TURNS,
    scope: (agent) => ({ session: u.id, kind: "ultraplan", agent: agent.name }),
  });
  return answers.map((a) => ({
    phase, agentIndex: a.index, speaker: a.agent.name, content: a.content, timestamp: a.at, version: v!.version, verdict: a.verdict,
  }));
}

function commitPhase(u: Ultraplan, entries: UltraplanEntry[]): void {
  for (const entry of entries) recordUltraplanEntry(u, entry);
  u.status = u.versions.length ? "awaiting_revision" : "awaiting_plan";
}

function nextVersion(u: Ultraplan, plan: string, author: string): PlanVersion {
  return { version: (u.versions.at(-1)?.version ?? 0) + 1, plan: plan.trim(), author, timestamp: new Date() };
}

function commitPlan(u: Ultraplan, v: PlanVersion): void {
  u.versions.push(v);
  recordUltraplanEntry(u, { phase: "plan", version: v.version, speaker: v.author, content: v.plan, timestamp: v.timestamp });
  u.status = "awaiting_revision";
}

function inputsFor(u: Ultraplan): Input[] {
  return u.entries.filter((e) => e.phase === "input").map((e) => ({ agent: label(u, e.speaker), content: e.content }));
}

function verdictsFor(u: Ultraplan, entries: UltraplanEntry[]): Verdict[] {
  return entries.map((e) => ({ agent: label(u, e.speaker), verdict: e.verdict ?? "UNCLEAR", content: e.content }));
}

/** Keep the last review per participant slot, in participant order. */
function latestReviews(u: Ultraplan, version: number): UltraplanEntry[] {
  const latest = new Map<number, UltraplanEntry>();
  for (const entry of u.entries) {
    if (entry.phase === "review" && entry.version === version && entry.agentIndex !== undefined) {
      latest.set(entry.agentIndex, entry);
    }
  }
  return [...latest.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
}

/** The next step, with the roundtable-tasks reminder when the ultraplan is execution_ready. */
function nextText(u: Ultraplan, text: string): string {
  return u.executionReady ? `${text} ${TASK_BLOCK_NEXT}` : text;
}

function stepResult(u: Ultraplan): UltraplanStepResult {
  const v = u.versions.at(-1);
  const reviews = v ? verdictsFor(u, latestReviews(u, v.version)) : [];
  const previous = v && !reviews.length
    ? [...u.versions].reverse().find((earlier) => earlier.version < v.version && latestReviews(u, earlier.version).length)
    : undefined;
  return {
    estimate: u.estimate, estimateNote: u.estimateNote, usage: usageFor(u),
    ultraplanId: u.id,
    ...(u.routing && { routing: u.routing }),
    ...(v ? {
      status: "awaiting_revision", version: v.version, reviews,
      ...(reviews.length
        ? { phase: "review", tally: tallyVerdicts(reviews.map((r) => r.verdict), REVIEW_VERDICTS), next: nextText(u, NEXT_AFTER_REVIEW) } as const
        : { phase: "plan", next: nextText(u, buildUnreviewedNext(v.version)),
          ...(previous && { previousReviews: { version: previous.version, reviews: verdictsFor(u, latestReviews(u, previous.version)) } }),
        } as const),
    } as const : { status: "awaiting_plan", phase: "input", input: inputsFor(u), next: nextText(u, NEXT_AFTER_INPUT) } as const),
    ...(u.publicChannel && { public: { url: u.publicChannel.url, topic: u.publicChannel.topic } }),
  };
}

async function authorPlan(u: Ultraplan, prompt: string): Promise<void> {
  // Providers already reject empty replies with an actionable error (finish reason, max_tokens hint);
  // keep that message. This guard only covers a provider that lets whitespace through.
  const content = await ask(u, u.planner!.name, u.planner!.systemPrompt, prompt);
  if (!content.trim()) throw new Error("Planner returned an empty plan");
  commitPlan(u, nextVersion(u, content, u.planner!.name));
}

/** `collected`: sign-offs were asked for; signedOff then means none is OBJECT or UNCLEAR. */
async function finalize(u: Ultraplan, signoffs: Verdict[], collected: boolean): Promise<UltraplanFinalResult> {
  const usage = usageFor(u);
  const version = u.versions.at(-1)?.version ?? null;
  const tally = tallyVerdicts(signoffs.map((s) => s.verdict), SIGNOFF_VERDICTS);
  const signedOff = collected && isSignedOff(signoffs);
  const document = renderUltraplanDocument(u, signoffs, collected);
  u.status = "finalized";
  const outcome = u.stopped ? `${stoppedOutcome(u.stopped)}${version !== null ? ` at v${version}` : ""}` : signedOff ? `signed off v${version}: ${signoffCounts(tally)}`
    : collected ? `not signed off at v${version}: ${signoffCounts(tally)}`
      : version !== null ? `ended without sign-off at v${version}` : "ended without a plan";
  recordActivity({
    session: u.id, kind: "ultraplan", mode: u.planner ? "planner" : "orchestrator",
    agents: [...new Set([...u.agents.map((a) => a.key), ...(u.planner ? [u.planner.key] : [])])],
    topic: u.task, public: !!u.publicChannel,
    outcome,
    ...(u.origin !== undefined && { origin: u.origin }),
  });
  // Archived before it leaves the live map, so the session is always either live or archived.
  const archived = archiveUltraplan(u, { markdown: document, signedOff, version, signoffs, tally, outcome, usage }) !== null;
  ultraplans.delete(u.id);
  await u.connectors?.close();
  const publicBlock = u.publicChannel ? formatPublicBlock(u.publicChannel, await u.publicChannel.finalize({ summary: document })) : undefined;
  return { ultraplanId: u.id, routing: u.routing, status: "finalized", signedOff, archived, version, finalPlan: document, signoffs, tally, usage, estimate: u.estimate, estimateNote: u.estimateNote,
    ...(publicBlock !== undefined && { publicBlock }), ...(u.toolNotes?.length && { toolUses: u.toolNotes }) };
}

function available(id: string): Ultraplan {
  const u = ultraplans.get(id);
  if (!u) throw notFoundError("Ultraplan", id, [...ultraplans.keys()]);
  if (isSessionBusy(id)) throw new SessionBusyError(id, ultraplanBusy(id));
  return u;
}

// ----------------------------------------------------------------------------
// Public API: caller-owned or autonomous planner flow
// ----------------------------------------------------------------------------

/** Same clamped review limit as the autonomous planner loop. */
function revisionLimit(requested?: number): number {
  return Math.min(3, Math.max(1, Math.floor(Number(requested)) || 1));
}

/**
 * Count every planned turn at its output ceiling. Known text uses one token per UTF-8 byte,
 * plus framing allowance; generated input/review/plan text uses the producing seat's token ceiling.
 * Caller-written future plans have a MAX_TOKENS allowance. Extra caller revisions and tool loops
 * are outside this bounded planning pass.
 */
function estimateUltraplan(u: Ultraplan, draft: string | undefined, rounds: number): SessionCostEstimate {
  const calls: SessionCostCall[] = [];
  const seatFor = (name: string) => u.routing?.find(seat => seat.id === name);
  const outputFor = (name: string) => Math.min(MAX_TOKENS, seatFor(name)?.maxOutputTokens ?? MAX_TOKENS);
  const add = (agent: Ultraplan["agents"][number], prompt: string, generatedTokens = 0) => {
    const seat = seatFor(agent.name);
    calls.push({ seat: agent.key, provider: seat?.provider ?? u.provider, model: seat?.model ?? u.model,
      inputTokens: Buffer.byteLength(agent.systemPrompt, "utf8") + Buffer.byteLength(prompt, "utf8") + 512 + generatedTokens,
      outputTokens: outputFor(agent.name) });
  };
  const names = u.agents.map(agent => label(u, agent.name));
  const planner = u.planner;
  const plannerIsApi = planner && (PROVIDER_IDS as readonly string[]).includes(seatFor(planner.name)?.provider ?? u.provider);
  let planTokens = draft ? Buffer.byteLength(draft, "utf8") : planner ? outputFor(planner.name) : MAX_TOKENS;
  if (!draft) {
    for (const agent of u.agents) add(agent, buildInputPrompt(u.task, names, u.context));
    if (plannerIsApi) add(planner, buildPlannerDraftPrompt(u.task, u.context, names,
      u.agents.map(agent => ({ agent: label(u, agent.name), content: "" })), u.executionReady),
    u.agents.reduce((total, agent) => total + outputFor(agent.name), 0));
  }
  for (let round = 0; round < rounds; round++) {
    for (const agent of u.agents) add(agent,
      buildReviewPrompt(u.task, u.context, "", round + 1, planner ? label(u, planner.name) : "orchestrator",
        draft ? undefined : "", round ? "" : undefined),
      planTokens + (draft ? 0 : outputFor(agent.name)) + (round ? outputFor(agent.name) : 0));
    if (plannerIsApi) add(planner, buildPlannerRevisePrompt(u.task, "", round + 1,
      u.agents.map(agent => ({ agent: label(u, agent.name), content: "", verdict: "APPROVE WITH CHANGES" })), u.context, u.executionReady),
    planTokens + u.agents.reduce((total, agent) => total + outputFor(agent.name), 0));
    planTokens = planner ? outputFor(planner.name) : Math.max(planTokens, MAX_TOKENS);
  }
  for (const agent of u.agents) add(agent,
    buildSignoffPrompt(u.task, "", rounds + 1, draft ? undefined : "", u.context, u.executionReady),
    planTokens + (draft ? 0 : outputFor(agent.name)));
  return estimateSessionCost({ calls });
}

export interface UltraplanOptions {
  maxUsd?: number; context?: string; draftPlan?: string; planner?: string; revisionRounds?: number; public?: boolean;
  provider?: LLMProvider | "auto"; model?: string; baseUrl?: string; executionReady?: boolean; origin?: string;
  /** Names of configured MCP connectors the agents may use as tools (see docs/connectors.md). */
  connectors?: string[];
  /** Limits an agent to some of those connectors (agent name to connector names). */
  seatConnectors?: SeatConnectorMap; signal?: AbortSignal;
  /** Resolve and estimate without provider calls or a live session. */
  dryRun?: boolean;
  /** Internal runners can display the estimate before dispatch without changing their lifecycle. */
  onEstimate?: (estimate: SessionCostEstimate) => void;
}

export function startUltraplan(agents: string[], task: string, opts: UltraplanOptions & { dryRun: true }): Promise<UltraplanDryRunResult>;
export function startUltraplan(agents: string[], task: string, opts?: UltraplanOptions & { dryRun?: false }): Promise<UltraplanStepResult | UltraplanFinalResult>;
export function startUltraplan(agents: string[], task: string, opts: UltraplanOptions): Promise<UltraplanStepResult | UltraplanFinalResult | UltraplanDryRunResult>;
export async function startUltraplan(
  agents: string[], task: string, opts: UltraplanOptions = {}
): Promise<UltraplanStepResult | UltraplanFinalResult | UltraplanDryRunResult> {
  validateSessionCap(opts.maxUsd);
  const id = newId("ultraplan");
  try {
    if ((opts.provider === undefined || opts.provider === "auto") && opts.baseUrl !== undefined) throw new Error("base_url requires explicit provider openai_compatible.");
    if (opts.provider !== undefined && opts.provider !== "auto" && !(PROVIDER_IDS as readonly string[]).includes(opts.provider)) {
      throw new Error(`Unknown provider "${opts.provider}". Valid providers: ${PROVIDER_IDS.join(", ")}`);
    }
    if (opts.baseUrl && opts.provider !== "openai_compatible") {
      throw new Error(`base_url is only supported with provider "openai_compatible" (got "${opts.provider}")`);
    }
    if (!Array.isArray(agents) || agents.length < 1) throw new Error("Ultraplan requires at least 1 agent");
    if (typeof task !== "string" || !task.trim()) throw new Error("task is required: describe what the plan is for");
    // An unknown connector fails here, before a session exists or any provider is called.
    const checked = checkSeatConnectorArgs(opts.connectors, opts.seatConnectors, [...agents, ...(opts.planner ? [opts.planner] : [])]);
    const suffix = opts.public ? publicDirectiveSuffix() : "";
    async function load(name: string, directive: string): Promise<Ultraplan["agents"][number]> {
      const { path, content } = await loadAgentPromptWithPath(name);
      return { name, key: agentKey(path), systemPrompt: content + directive + suffix };
    }
    const participants = [];
    for (const name of agents) participants.push(await load(name, buildUltraplanParticipantDirective()));
    const planner = opts.planner !== undefined ? await load(opts.planner, buildUltraplanPlannerDirective()) : undefined;
    const automatic = opts.provider === undefined || opts.provider === "auto";
    const seatOptions = { agents: [...new Set([...agents, ...(opts.planner ? [opts.planner] : [])])], model: opts.model, tier: "judge" as const };
    // Resolve locally first. Even a health preflight must come after the estimate.
    const seats = automatic ? await prepareSeats(seatOptions, { preflight: false }) : undefined;
    const provider = (seats?.values().next().value?.provider ?? opts.provider) as LLMProvider;
    const chosenModel = seats?.values().next().value?.model ?? opts.model ?? DEFAULT_MODELS[provider];
    const u: Ultraplan = {
      id, task, context: opts.context, agents: participants, planner, provider,
      model: provider === "anthropic" ? resolveAnthropicModel(chosenModel) : chosenModel,
      ...(seats && { routing: [...seats.values()] }),
      ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }), status: "awaiting_plan",
      versions: [], entries: [], startedAt: new Date(),
      ...(opts.executionReady === true && { executionReady: true }),
      ...(opts.origin !== undefined && { origin: opts.origin }),
    };
    const draft = opts.draftPlan?.trim() || undefined;
    const rounds = planner ? revisionLimit(opts.revisionRounds) : 1;
    const estimate = () => {
      u.estimate = estimateUltraplan(u, draft, rounds);
      u.estimateNote = `Upper bound for ${rounds} review round${rounds === 1 ? "" : "s"} and sign-off. Future caller plans allow ${MAX_TOKENS} tokens. Extra revisions, longer caller plans, tool loops, retries and health probes can add cost.` +
        (opts.maxUsd !== undefined && u.estimate.usd > opts.maxUsd
          ? ` The estimate exceeds the $${opts.maxUsd} cap. Starting is allowed; the cap still stops the session when reached.` : "");
      opts.onEstimate?.(u.estimate);
    };
    estimate();
    u.usage = { spent_usd: 0 };
    if (opts.dryRun) return {
      status: "dry_run", dry_run: true, estimate: u.estimate!, estimateNote: u.estimateNote!, routing: u.routing,
      usage: { spent_usd: 0, ...(opts.maxUsd !== undefined && { max_usd: opts.maxUsd, cap_reached: false }) },
    };
    if (automatic) {
      const prepared = await prepareSeats(seatOptions, { signal: opts.signal });
      u.routing = [...prepared.values()];
      u.provider = u.routing[0].provider as LLMProvider;
      u.model = u.routing[0].model;
      // Preflight can replace an unavailable provider or model.
      if (JSON.stringify(estimateUltraplan(u, draft, rounds)) !== JSON.stringify(u.estimate)) estimate();
    }
    const publicChannel = opts.public ? openPublicChannel(id, {
      mode: "ultraplan", participants: [...participants.map((a) => publicLabel(a.name)),
        planner ? `planner: ${publicLabel(planner.name)}` : "planner: orchestrator"], topic: task,
    }) : undefined;
    u.publicChannel = publicChannel;
    const toolNotes: string[] = [];
    try {
      u.connectors = checked.names.length ? await startSeatConnectors(checked.names, { signal: opts.signal, seatConnectors: checked.seatConnectors, onNote: use => toolNotes.push(use.note) }) : undefined;
      if (u.connectors) u.toolNotes = toolNotes;
    } catch (e) {
      if (publicChannel) void publicChannel.finalize();
      throw e;
    }
    setSessionCap(id, opts.maxUsd);
    ultraplans.set(id, u);
    return await beginUltraplan(u, draft, rounds);
  } finally {
    if (!ultraplans.has(id) && !sessionCapView(id)?.reached) clearSessionCap(id);
  }
}

async function beginUltraplan(u: Ultraplan, draft: string | undefined, rounds: number): Promise<UltraplanStepResult | UltraplanFinalResult> {
  const { id, planner, task, agents: participants, connectors, publicChannel } = u;
  const release = lockSession(id, ultraplanBusy(id));
  let step = "input";
  try {
    if (!draft) commitPhase(u, await computePhase(u, "input"));
    if (!planner) {
      if (draft) {
        step = "review of v1";
        const v = nextVersion(u, draft, "orchestrator");
        const entries = await computePhase(u, "review", v);
        commitPlan(u, v);
        commitPhase(u, entries);
      }
      return stepResult(u);
    }
    if (!draft) {
      step = "draft";
      await authorPlan(u, buildPlannerDraftPrompt(task, u.context, participants.map((a) => label(u, a.name)), inputsFor(u), u.executionReady === true));
    }
    for (let round = 0; round < rounds; round++) {
      const v = round === 0 && draft ? nextVersion(u, draft, "orchestrator") : u.versions.at(-1)!;
      step = `review of v${v.version}`;
      const entries = await computePhase(u, "review", v);
      if (round === 0 && draft) commitPlan(u, v);
      commitPhase(u, entries);
      step = `revision to v${v.version + 1}`;
      await authorPlan(u, buildPlannerRevisePrompt(task, v.plan, v.version, verdictsFor(u, entries), u.context, u.executionReady === true));
    }
    step = "sign-off";
    const entries = await computePhase(u, "signoff", u.versions.at(-1)!);
    commitPhase(u, entries);
    return await finalize(u, verdictsFor(u, entries), true);
  } catch (e) {
    if (!u.entries.length && !u.stopped) {
      ultraplans.delete(id);
      await connectors?.close();
      if (publicChannel) void publicChannel.finalize();
      throw e;
    }
    if (!planner) throw e;
    return {
      ...stepResult(u), ...(u.versions.length && { plan: u.versions.at(-1)!.plan }),
      error: buildPlannerStoppedError(step, e instanceof Error ? e.message : String(e)),
    };
  } finally {
    release();
  }
}

export async function submitPlan(id: string, plan?: string, final = false): Promise<UltraplanStepResult | UltraplanFinalResult> {
  const u = available(id);
  if (plan !== undefined && plan !== null && typeof plan !== "string") {
    throw new Error("plan must be a string: the full text of the next plan version");
  }
  const supplied = typeof plan === "string" && !!plan.trim();
  const v = supplied ? nextVersion(u, plan!, "orchestrator") : u.versions.at(-1);
  if (!v) throw new Error("No plan version exists yet; pass plan.");
  const release = lockSession(id, ultraplanBusy(id));
  try {
    const entries = await computePhase(u, final ? "signoff" : "review", v);
    if (supplied) commitPlan(u, v);
    commitPhase(u, entries);
    return final ? await finalize(u, verdictsFor(u, entries), true) : stepResult(u);
  } finally {
    release();
  }
}

export async function endUltraplan(id: string): Promise<UltraplanFinalResult> {
  const u = available(id);
  const release = lockSession(id, ultraplanBusy(id));
  try {
    return await finalize(u, [], false);
  } finally {
    release();
  }
}

export function listUltraplans(): Array<{ id: string; task: string; agents: string[]; planner: string; status: UltraplanStatus;
  versions: number; public: boolean; startedAt: string; provider: LLMProvider; model: string }> {
  return [...ultraplans.values()].map((u) => ({
    id: u.id, task: u.task, agents: u.agents.map((a) => a.name), planner: u.planner?.name ?? "orchestrator",
    status: u.status, versions: u.versions.length, public: !!u.publicChannel,
    startedAt: u.startedAt.toISOString(), provider: u.provider, model: u.model,
  }));
}
