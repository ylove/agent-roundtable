// ============================================================================
// Ultraplan: specialist input, independent reviews and final sign-offs
// ============================================================================

import { DEFAULT_MODELS, PARALLEL_TURNS, type LLMProvider } from "../config.js";
import { agentKey, loadAgentPromptWithPath } from "../agents.js";
import { recordActivity } from "../activity.js";
import { callLLM } from "../providers/index.js";
import { publicLabel } from "../publishers/index.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";
import { mapLimit, notFoundError, parseVerdict, truncate } from "./workshop.js";

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
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  status: UltraplanStatus;
  versions: Array<{ version: number; plan: string; author: string; timestamp: Date }>;
  entries: UltraplanEntry[];
  startedAt: Date;
  publicChannel?: PublicChannel;
}

type Input = { agent: string; content: string };
type Verdict = Input & { verdict: string };
type PlanVersion = Ultraplan["versions"][number];

export interface UltraplanStepResult {
  ultraplanId: string;
  status: "awaiting_plan" | "awaiting_revision";
  phase: "input" | "review";
  version?: number;
  input?: Input[];
  reviews?: Verdict[];
  tally?: Record<string, number>;
  next: string;
  public?: { url: string | null; topic: string };
  error?: string;
  /** Latest planner text, provided only when an autonomous run stops early. */
  plan?: string;
}

export interface UltraplanFinalResult {
  ultraplanId: string;
  status: "finalized";
  signedOff: boolean;
  version: number | null;
  finalPlan: string;
  signoffs: Verdict[];
  tally: Record<string, number>;
  publicBlock?: string;
}

export const ultraplans = new Map<string, Ultraplan>();
const busy = new Set<string>();
let ultraplanCounter = 0;

export const NEXT_AFTER_INPUT = "Write plan v1 that incorporates this input. Tag each step with the agents whose input shaped it, e.g. [cfo]. Then call submit_plan; pass final: true to go straight to sign-off.";
export const NEXT_AFTER_REVIEW = "Revise the plan to address the amendments (say which you rejected and why), then call submit_plan again, or submit_plan with final: true to collect sign-offs and close.";

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

export function buildSignoffPrompt(task: string, plan: string, version: number, ownInput?: string): string {
  return taskBlock(task) + `**Final plan v${version}:**\n${plan}\n\n` +
    (ownInput !== undefined ? `**Your input before the draft:**\n${ownInput}\n\n` : "") +
    "The first line must be EXACTLY one of:\nSign-off: APPROVE | APPROVE WITH RESERVATIONS | OBJECT\n\n" +
    "Reflected from my input: 1-3 bullets or \"Nothing specific\".\n" +
    "Still missing or disagree: or \"None\".\nWatch: one thing to monitor during execution.\n\nBrief.";
}

export function buildPlannerDraftPrompt(
  task: string, context: string | undefined, participants: string[], inputs: Input[]
): string {
  return taskBlock(task, context) + `**Participants:** ${participants.join(", ")}\n\n` +
    inputs.map((input) => `### ${input.agent}\n${input.content}\n\n`).join("") +
    "Write plan v1: numbered steps with owner/role, sequencing and dependencies, acceptance criteria, " +
    "risks with mitigations, open questions. Tag each step with contributing participants like [a, b]. " +
    "Output the plan only.";
}

export function buildPlannerRevisePrompt(task: string, plan: string, version: number, reviews: Verdict[]): string {
  return taskBlock(task) + `**Current plan v${version}:**\n${plan}\n\n` +
    reviews.map((review) => `### ${review.agent} (${review.verdict})\n${review.content}\n\n`).join("") +
    `Write plan v${version + 1}: for each amendment accept, modify or reject. Output the full revised plan, ` +
    `then a section \"## Changes from v${version}\" listing each amendment by reviewer and what was done, ` +
    "with a one-line reason for each rejection.";
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

export function renderUltraplanDocument(u: Ultraplan, signoffs: Verdict[], signedOff: boolean): string {
  const firstLine = u.task.trim().split(/\r?\n/)[0];
  const title = firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
  const latest = u.versions.at(-1);
  const tally = tallyVerdicts(signoffs.map((s) => s.verdict), SIGNOFF_VERDICTS);
  const blocks = [
    `# Ultraplan: ${title}`,
    `Planner: ${u.planner ? label(u, u.planner.name) : "orchestrator"} · Participants: ${u.agents.map((a) => label(u, a.name)).join(", ")} · Plan versions: ${u.versions.length} · ` +
      (signedOff ? `Sign-off: ${signoffCounts(tally)}` : "Not signed off"),
    latest ? `## ${signedOff ? "Final" : "Latest"} plan (v${latest.version})${signedOff ? "" : " — not signed off"}\n\n${latest.plan}`
      : "## Plan\n\nNo plan was submitted.",
    "## Sign-offs",
    ...(signedOff ? signoffs.map((s) => `### ${label(u, s.agent)} — ${s.verdict}\n${s.content}`)
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
    const reviews = u.entries.filter((e) => e.phase === "review" && e.version === v.version);
    return prefix + (reviews.length ? `reviews: ${reviews.map((e) => `${label(u, e.speaker)} ${e.verdict}`).join(", ")}` : "not reviewed");
  }).join("\n") : "(no plan versions)");
  return blocks.join("\n\n");
}

// ----------------------------------------------------------------------------
// Phase computation and atomic commits
// ----------------------------------------------------------------------------

function ask(u: Ultraplan, systemPrompt: string, prompt: string): Promise<string> {
  return callLLM(systemPrompt, [{ role: "user", content: prompt }], { provider: u.provider, model: u.model, baseUrl: u.baseUrl });
}

function ownEntry(u: Ultraplan, phase: "input" | "review", index: number): string | undefined {
  for (let i = u.entries.length - 1; i >= 0; i--) {
    const entry = u.entries[i];
    if (entry.phase === phase && entry.agentIndex === index) return entry.content;
  }
  return undefined;
}

async function computePhase(u: Ultraplan, phase: "input" | "review" | "signoff", v?: PlanVersion): Promise<UltraplanEntry[]> {
  return mapLimit(u.agents, PARALLEL_TURNS, async (agent, agentIndex) => {
    const ownInput = ownEntry(u, "input", agentIndex);
    const prompt = phase === "input" ? buildInputPrompt(u.task, u.agents.map((a) => label(u, a.name)), u.context)
      : phase === "review" ? buildReviewPrompt(u.task, u.context, v!.plan, v!.version, label(u, v!.author), ownInput, ownEntry(u, "review", agentIndex))
        : buildSignoffPrompt(u.task, v!.plan, v!.version, ownInput);
    const content = await ask(u, agent.systemPrompt, prompt);
    return {
      phase, agentIndex, speaker: agent.name, content, timestamp: new Date(),
      ...(v && { version: v.version }),
      ...(phase !== "input" && { verdict: parseVerdict(content, phase === "review" ? "Verdict" : "Sign-off", phase === "review" ? REVIEW_VERDICTS : SIGNOFF_VERDICTS) }),
    };
  });
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

function stepResult(u: Ultraplan): UltraplanStepResult {
  const v = u.versions.at(-1);
  const reviews = v ? verdictsFor(u, u.entries.filter((e) => e.phase === "review" && e.version === v.version)) : [];
  return {
    ultraplanId: u.id,
    ...(v ? { status: "awaiting_revision", phase: "review", version: v.version, reviews,
      tally: tallyVerdicts(reviews.map((r) => r.verdict), REVIEW_VERDICTS), next: NEXT_AFTER_REVIEW } as const
      : { status: "awaiting_plan", phase: "input", input: inputsFor(u), next: NEXT_AFTER_INPUT } as const),
    ...(u.publicChannel && { public: { url: u.publicChannel.url, topic: u.publicChannel.topic } }),
  };
}

async function authorPlan(u: Ultraplan, prompt: string): Promise<void> {
  // Providers already reject empty replies with an actionable error (finish reason, max_tokens hint);
  // keep that message. This guard only covers a provider that lets whitespace through.
  const content = await ask(u, u.planner!.systemPrompt, prompt);
  if (!content.trim()) throw new Error("Planner returned an empty plan");
  commitPlan(u, nextVersion(u, content, u.planner!.name));
}

async function finalize(u: Ultraplan, signoffs: Verdict[], signedOff: boolean): Promise<UltraplanFinalResult> {
  const version = u.versions.at(-1)?.version ?? null;
  const tally = tallyVerdicts(signoffs.map((s) => s.verdict), SIGNOFF_VERDICTS);
  const document = renderUltraplanDocument(u, signoffs, signedOff);
  u.status = "finalized";
  recordActivity({
    session: u.id, kind: "ultraplan", mode: u.planner ? "planner" : "orchestrator",
    agents: [...new Set([...u.agents.map((a) => a.key), ...(u.planner ? [u.planner.key] : [])])],
    topic: u.task, public: !!u.publicChannel,
    outcome: signedOff ? `signed off v${version}: ${signoffCounts(tally)}`
      : version !== null ? `ended without sign-off at v${version}` : "ended without a plan",
  });
  ultraplans.delete(u.id);
  const publicBlock = u.publicChannel ? formatPublicBlock(u.publicChannel, await u.publicChannel.finalize({ summary: document })) : undefined;
  return { ultraplanId: u.id, status: "finalized", signedOff, version, finalPlan: document, signoffs, tally,
    ...(publicBlock !== undefined && { publicBlock }) };
}

function available(id: string): Ultraplan {
  const u = ultraplans.get(id);
  if (!u) throw notFoundError("Ultraplan", id, [...ultraplans.keys()]);
  if (busy.has(id)) throw new Error(`Ultraplan ${id} is busy: a phase is still running. Wait for it to finish, then retry.`);
  return u;
}

// ----------------------------------------------------------------------------
// Public API: caller-owned or autonomous planner flow
// ----------------------------------------------------------------------------

export async function startUltraplan(
  agents: string[], task: string,
  opts: { context?: string; draftPlan?: string; planner?: string; revisionRounds?: number; public?: boolean;
    provider?: LLMProvider; model?: string; baseUrl?: string } = {}
): Promise<UltraplanStepResult | UltraplanFinalResult> {
  if (!Array.isArray(agents) || agents.length < 1) throw new Error("Ultraplan requires at least 1 agent");
  if (typeof task !== "string" || !task.trim()) throw new Error("task is required: describe what the plan is for");
  const suffix = opts.public ? publicDirectiveSuffix() : "";
  async function load(name: string, directive: string): Promise<Ultraplan["agents"][number]> {
    const { path, content } = await loadAgentPromptWithPath(name);
    return { name, key: agentKey(path), systemPrompt: content + directive + suffix };
  }
  const participants = [];
  for (const name of agents) participants.push(await load(name, buildUltraplanParticipantDirective()));
  const planner = opts.planner !== undefined ? await load(opts.planner, buildUltraplanPlannerDirective()) : undefined;
  const id = `ultraplan-${++ultraplanCounter}`;
  const publicChannel = opts.public ? openPublicChannel(id, {
    mode: "ultraplan", participants: [...participants.map((a) => publicLabel(a.name)),
      planner ? `planner: ${publicLabel(planner.name)}` : "planner: orchestrator"], topic: task,
  }) : undefined;
  const provider = opts.provider || "anthropic";
  const u: Ultraplan = {
    id, task, context: opts.context, agents: participants, planner, provider, model: opts.model || DEFAULT_MODELS[provider],
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }), status: "awaiting_plan",
    versions: [], entries: [], startedAt: new Date(), ...(publicChannel && { publicChannel }),
  };
  ultraplans.set(id, u);
  busy.add(id);
  let step = "input";
  try {
    const draft = opts.draftPlan?.trim();
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
      await authorPlan(u, buildPlannerDraftPrompt(task, u.context, participants.map((a) => label(u, a.name)), inputsFor(u)));
    }
    const rounds = Math.min(3, Math.max(1, Math.floor(Number(opts.revisionRounds)) || 1));
    for (let round = 0; round < rounds; round++) {
      const v = round === 0 && draft ? nextVersion(u, draft, "orchestrator") : u.versions.at(-1)!;
      step = `review of v${v.version}`;
      const entries = await computePhase(u, "review", v);
      if (round === 0 && draft) commitPlan(u, v);
      commitPhase(u, entries);
      step = `revision to v${v.version + 1}`;
      await authorPlan(u, buildPlannerRevisePrompt(task, v.plan, v.version, verdictsFor(u, entries)));
    }
    step = "sign-off";
    const entries = await computePhase(u, "signoff", u.versions.at(-1)!);
    commitPhase(u, entries);
    return await finalize(u, verdictsFor(u, entries), true);
  } catch (e) {
    if (!u.entries.length) {
      ultraplans.delete(id);
      if (publicChannel) void publicChannel.finalize();
      throw e;
    }
    if (!planner) throw e;
    return {
      ...stepResult(u), ...(u.versions.length && { plan: u.versions.at(-1)!.plan }),
      error: `Planner run stopped during ${step}: ${e instanceof Error ? e.message : String(e)}. The session is open: continue with submit_plan or close with end_ultraplan.`,
    };
  } finally {
    busy.delete(id);
  }
}

export async function submitPlan(id: string, plan: string, final = false): Promise<UltraplanStepResult | UltraplanFinalResult> {
  const u = available(id);
  if (typeof plan !== "string" || !plan.trim()) throw new Error("plan is required: pass the full text of the next plan version");
  busy.add(id);
  try {
    const v = nextVersion(u, plan, "orchestrator");
    const entries = await computePhase(u, final ? "signoff" : "review", v);
    commitPlan(u, v);
    commitPhase(u, entries);
    return final ? await finalize(u, verdictsFor(u, entries), true) : stepResult(u);
  } finally {
    busy.delete(id);
  }
}

export async function endUltraplan(id: string): Promise<UltraplanFinalResult> {
  const u = available(id);
  busy.add(id);
  try {
    return await finalize(u, [], false);
  } finally {
    busy.delete(id);
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
