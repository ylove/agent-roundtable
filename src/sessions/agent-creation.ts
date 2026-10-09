// ============================================================================
// One-call agent creation and refinement workshops
// ============================================================================

import fs from "node:fs";
import { AGENTS_DIR, SKILLS_DIR, DEFAULT_MODELS, PARALLEL_TURNS, type LLMProvider } from "../config.js";
import { agentKey, assertReadableFrontmatter, loadAgent, listAgents, listSkills, projectSkillsDir, readFrontmatter, renderSkillsSection, skillSearchDirs, type LoadedAgent } from "../agents.js";
import { recordActivity, recentActivityFor } from "../activity.js";
import { callLLM, type ChatCompletionOptions } from "../providers/index.js";
import { publicLabel } from "../publishers/index.js";
import {
  MODEL_CHOICES,
  TOOL_ALLOWLIST,
  slugify,
  validateAgentSpec,
  renderSpecMarkdown,
  planAgentFiles,
  writeNewAgent,
  writeImprovedAgent,
  formatBackupTimestamp,
  type AgentSpec,
  type AgentFilePlanOptions,
  type WriteResult,
} from "../agent-files.js";
import { mapLimit, extractJsonObject, truncate, parseVerdict } from "./workshop.js";
import { collaborations, ORCHESTRATOR } from "./collaborations.js";
import { meetings, startMeeting } from "./meetings.js";
import { openPublicChannel, publicDirectiveSuffix, formatPublicBlock, type PublicChannel } from "./public.js";

/** Inputs for designing a new agent with specialists and an architect. */
export interface CreateAgentOptions {
  agents?: string[];
  task?: string;
  context?: string;
  fromSession?: string;
  name?: string;
  rounds?: number;
  write?: boolean;
  performTask?: boolean;
  public?: boolean;
  provider?: LLMProvider;
  model?: string;
  baseUrl?: string;
}

/** Inputs for refining an existing agent while preserving its identity. */
export interface ImproveAgentOptions {
  agent: string;
  with?: string[];
  includeSelf?: boolean;
  focus?: string;
  context?: string;
  fromSession?: string;
  rounds?: number;
  write?: boolean;
  public?: boolean;
  provider?: LLMProvider;
  model?: string;
  baseUrl?: string;
}

/** Saved or previewed definition, review results, and instructions for continuing. */
export interface AgentWorkshopResult {
  mode: "create" | "improve";
  sessionId: string;
  agent: {
    name: string;
    path: string | null;
    description: string;
    model?: string;
    tools?: string[];
    skills: Array<{
      name: string;
      path: string | null;
      status: "created" | "reused" | "preview";
    }>;
  };
  backupPath?: string;
  proposedPath?: string;
  contributions: Array<{
    agent: string;
    summary: string;
  }>;
  reviews: Array<{
    agent: string;
    verdict: string;
  }>;
  changes?: string[];
  openQuestions?: string[];
  warnings: string[];
  files?: Array<{
    path: string;
    content: string;
  }>;
  meeting?: {
    meetingId: string;
    response: string;
  };
  next: string;
  publicBlock?: string;
}

interface Contribution {
  agent: string;
  content: string;
}

interface Entry extends Contribution {
  phase: "contribution" | "review";
}

interface Run {
  transcript: Entry[];
  channel?: PublicChannel;
}

interface PromptContext {
  context?: string;
  discussion?: string;
  participants: string[];
  existingAgents: string;
  existingSkills: string;
  contributions: Contribution[];
}

/** Private background and accumulated input for a creation contribution. */
export interface ContributionPromptOptions extends PromptContext {
  task: string;
  round?: number;
  rounds?: number;
}

/** Current definition and private background for a refinement contribution. */
export interface ImproveContributionPromptOptions extends PromptContext {
  target: string;
  focus?: string;
  description: string;
  systemPrompt: string;
  skills: Array<{ name: string; description?: string }>;
  activity?: string;
  isSelf: boolean;
  round?: number;
  rounds?: number;
}

/** Contract and specialist input for drafting a definition. */
export interface ArchitectPromptOptions extends PromptContext {
  mode: "create" | "improve";
  task: string;
  name?: string;
  identityName?: string;
  currentDefinition?: string;
  focus?: string;
}

/** Draft and the reviewer's own contributions for a spec review. */
export interface SpecReviewPromptOptions {
  task: string;
  draft: string;
  contributions: Contribution[];
}

/** Previous definition and reviews for an architect revision. */
export interface ArchitectRevisePromptOptions extends ArchitectPromptOptions {
  spec: AgentSpec;
  reviews: Contribution[];
}

interface Participant {
  key: string;
  label: string;
  system: string;
}

interface SourceSession {
  refs: string[];
  topic: string;
  discussion?: string;
}

interface PreparedWorkshop {
  mode: "create" | "improve";
  options: CreateAgentOptions | ImproveAgentOptions;
  isPublic: boolean;
  sessionId: string;
  task: string;
  target?: LoadedAgent;
  targetKey?: string;
  targetLabel: string;
  participants: Participant[];
  rounds: number;
  llmOptions: ChatCompletionOptions & { provider: LLMProvider; model: string };
  existingSkillNames: string[];
  common: PromptContext;
  architectOptions: ArchitectPromptOptions;
  ownContributions: Map<string, Contribution[]>;
  run: Run;
}

interface ParsedSpec {
  spec: AgentSpec;
  warnings: string[];
}

interface Review extends Contribution {
  verdict: string;
}

interface SavedDefinition {
  plan: WriteResult;
  written: boolean;
  files?: Array<{ path: string; content: string }>;
}

let createCounter = 0;
let improveCounter = 0;

// ----------------------------------------------------------------------------
// Prompt builders (pure)
// ----------------------------------------------------------------------------

function labeledInput(items: Contribution[], empty: string): string {
  if (!items.length) {
    return empty;
  }
  return items.map(entry => `**${entry.agent}:**\n${entry.content}`).join("\n\n");
}

function background(o: PromptContext, audience: "contributor" | "architect"): string {
  const sections: string[] = [];
  if (o.context) {
    sections.push(`## Context\n${o.context}`);
  }
  if (o.discussion) {
    sections.push(`## Discussion that led here\n${o.discussion}`);
  }
  sections.push(
    `## Participants\n${o.participants.join(", ")}`,
    `## Existing agents\n${o.existingAgents}`,
    `## Existing skills\n${o.existingSkills}`,
  );
  if (audience === "architect") {
    sections.push(
      "## Contributions from the participants\n" + labeledInput(o.contributions, "(no contributions)"),
    );
  } else {
    sections.push(
      "## Earlier contributions\n" + labeledInput(o.contributions, "(you are the first contributor)"),
    );
  }
  return sections.join("\n\n");
}

function roundText(o: { round?: number; rounds?: number }): string {
  return (o.rounds ?? 1) > 1 ? `\n\nRound ${o.round ?? 1} of ${o.rounds}.` : "";
}

/** Ask a specialist to contribute expertise, skills, guardrails and deliverables. */
export function buildContributionPrompt(o: ContributionPromptOptions): string {
  const framing =
    "You are one of several specialists designing a new Claude Code subagent for the task below. " +
    "An architect will turn every contribution into the final definition (system prompt, skills, tools). " +
    "Contribute from your own expertise; say plainly when something is outside it.";
  return [
    framing,
    "",
    `Design a new agent for this task:\n${o.task}${roundText(o)}`,
    "",
    background(o, "contributor"),
    "",
    "Contribute under these headings:",
    "1. Expertise",
    "2. Skills (name, purpose, key steps/checklist; reuse an existing skill by name when one fits)",
    "3. Guardrails (mistakes to avoid, when to escalate or stop)",
    "4. Deliverable (what good output looks like)",
    "",
    "Don't repeat what earlier contributors covered; build on it or correct it.",
  ].join("\n");
}

/** Ask a specialist to diagnose and correct an existing agent's instructions. */
export function buildImproveContributionPrompt(o: ImproveContributionPromptOptions): string {
  const lines = [
    `You are one of several specialists improving the existing Claude Code subagent ${o.target}. ` +
      "An architect will turn every contribution into the revised definition.",
    "",
    `Improve the agent ${o.target}.`,
  ];
  if (o.focus) {
    lines.push(`Focus: ${o.focus}`);
  }
  lines.push(
    roundText(o),
    "",
    `## Current description\n${o.description}`,
    "",
    `## Current system prompt\n${truncate(o.systemPrompt, 30_000)}`,
    "",
    "## Current skills",
    o.skills.map(skill => `- ${skill.name}: ${skill.description ?? ""}`).join("\n") || "(none)",
    "",
    `## Recent activity\n${o.activity ?? "(no recorded sessions)"}`,
    "",
    background(o, "contributor"),
    "",
  );
  if (o.isSelf) {
    lines.push(
      "You are the agent being improved. " +
        "Be candid about where your current instructions make you worse at your job.",
      "",
    );
  }
  lines.push(
    "Contribute under these headings:",
    "1. Gaps",
    "2. Corrections (quote the current text, give the replacement)",
    "3. Skills to add or attach",
    "4. Cuts",
    "",
    "Don't repeat what earlier contributors covered; build on it or correct it.",
  );
  return lines.join("\n");
}

/** Define the architect's neutral role and required second-person JSON output. */
export function buildArchitectSystemPrompt(): string {
  return [
    "You are a neutral agent architect.",
    "Turn specialists' contributions into a precise Claude Code subagent definition.",
    "Write second-person system prompts covering role and mission, scope, how to work step by step, " +
      "quality bar, guardrails and escalation, and output format.",
    "Put reusable procedures in skills, not the system prompt.",
    "Credit contributors accurately.",
    "Output only JSON.",
  ].join(" ");
}

/** Document the JSON contract and supply all private design input to the architect. */
export function buildArchitectPrompt(o: ArchitectPromptOptions): string {
  const lines = [`Design the final definition for: ${o.task}`, ""];
  if (o.name && slugify(o.name)) {
    lines.push(`Use exactly this name: ${slugify(o.name)}`, "");
  }
  lines.push(background(o, "architect"));
  if (o.mode === "improve") {
    lines.push("", `## Current definition\n${o.currentDefinition ?? ""}`);
    if (o.focus) {
      lines.push(`Focus: ${o.focus}`);
    }
    lines.push(
      "keep the agent's identity; preserve what works; fill `changes` with each change and its reason.",
    );
  }
  lines.push("", "JSON contract (only these fields):");
  if (o.mode === "improve") {
    lines.push(`- name: keep exactly: ${o.identityName ?? o.name ?? "the current identity"}.`);
  } else {
    lines.push("- name: lowercase letters, digits and hyphens, <= 64 characters.");
  }
  lines.push(
    "- description: one line, <= 1000 characters; when Claude Code should delegate to this agent.",
    `- model: optional; one of ${MODEL_CHOICES.join("|")}. ` +
      "Use opus for strategic or cognitively complex work, sonnet for execution, " +
      "haiku for simple high-volume work; omit to inherit.",
    `- tools: optional array from ${TOOL_ALLOWLIST.join(", ")}. ` +
      "Only what the agent needs; omit to inherit all.",
    "- system_prompt: second person, <= 40000 characters.",
    "- skills: <= 6; each { name, description, instructions, contributed_by }. " +
      "Names are slugs <= 64; descriptions one line <= 1000; new instructions non-empty <= 20000; " +
      "contributed_by is an array of contributor names. " +
      "Reuse an existing skill by giving only its exact name; its instructions are never overwritten. " +
      "Reserved names synced and anthropic-skills are not allowed.",
    "- contributions: [{ agent, summary }] crediting each participant accurately; " +
      "agent <= 100, summary one line <= 500 characters.",
    "- open_questions: optional array of non-empty strings, <= 10.",
  );
  if (o.mode === "improve") {
    lines.push("- changes: optional array of non-empty strings, <= 30; each change and its reason.");
  }
  lines.push("", "Return only the JSON object.");
  return lines.join("\n");
}

/** Request a verdict, quoted fixes, and an assessment of the reviewer's credit. */
export function buildSpecReviewPrompt(o: SpecReviewPromptOptions): string {
  return [
    `Review this definition for: ${o.task}`,
    "",
    o.draft,
    "",
    "## Your contributions in this run",
    labeledInput(o.contributions, "(you are the first contributor)"),
    "",
    "The first line must be EXACTLY Verdict: READY | NEEDS CHANGES (choose one). " +
      "Then give concrete fixes quoting the text you would change, " +
      "and say whether your contribution is represented accurately.",
  ].join("\n");
}

/** Supply the previous JSON and every review under the same drafting contract. */
export function buildArchitectRevisePrompt(o: ArchitectRevisePromptOptions): string {
  return [
    "Revise the definition.",
    "",
    "## Previous JSON",
    JSON.stringify(o.spec, null, 2),
    "",
    "## Reviews",
    labeledInput(o.reviews, "(no reviews)"),
    "",
    "Address each NEEDS CHANGES point or say in open_questions why not.",
    "",
    buildArchitectPrompt(o),
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Session input, private history and recording
// ----------------------------------------------------------------------------

function recentActivityLines(key: string): string | undefined {
  const entries = recentActivityFor(key, 5);
  if (!entries.length) {
    return undefined;
  }
  return entries.map(entry => {
    const others = entry.agents.filter(agent => agent !== key);
    let text = `- ${entry.at.slice(0, 10)} ${entry.kind}`;
    if (entry.mode) {
      text += ` (${entry.mode})`;
    }
    if (others.length) {
      text += ` with ${others.join(", ")}`;
    }
    text += ` on "${entry.topic}"`;
    if (entry.outcome) {
      text += ` — ${entry.outcome}`;
    }
    return text;
  }).join("\n");
}

function record(run: Run, entry: Entry): void {
  run.transcript.push(entry);
  run.channel?.record({
    turn: run.transcript.length,
    speaker: `${entry.agent} · ${entry.phase}`,
    content: entry.content,
    kind: "turn",
  });
}

function display(ref: string, isPublic: boolean): string {
  const key = agentKey(ref);
  return isPublic ? publicLabel(key) : key;
}

function sourceSession(id: string | undefined, isPublic: boolean): SourceSession {
  if (!id) {
    return { refs: [], topic: "" };
  }
  let refs: string[];
  let topic: string;
  let text: string;
  const collab = collaborations.get(id);
  const meeting = meetings.get(id);
  if (collab) {
    refs = collab.agents.map(agent => agent.name);
    topic = collab.topic.trim();
    text = collab.messages.map(message => {
      const speaker = message.agent === ORCHESTRATOR ? "orchestrator" : display(message.agent, isPublic);
      return `**${speaker}:** ${message.content}`;
    }).join("\n\n");
  } else if (meeting) {
    refs = [meeting.agent];
    topic = meeting.agenda?.trim() ?? "";
    text = meeting.messages.map(message => {
      const speaker = message.role === "user" ? "caller" : display(meeting.agent, isPublic);
      return `**${speaker}:** ${message.content}`;
    }).join("\n\n");
  } else {
    const activeIds = [...collaborations.keys(), ...meetings.keys()].join(", ") || "none";
    throw new Error(
      `from_session not found: ${id}. Pass the id of a live collaboration (collab-N) or meeting (meeting-N). ` +
        `Active sessions: ${activeIds}`,
    );
  }
  const discussion = text.length > 20_000
    ? "…[earlier discussion truncated]\n" + text.slice(-20_000)
    : text;
  return { refs, topic, discussion };
}

function fleet(items: Array<{ name: string; description?: string }>): string {
  const lines = items.slice(0, 60).map(agent => {
    const description = (agent.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return `- ${agent.name}: ${description}`;
  });
  if (items.length > 60) {
    lines.push(`- … and ${items.length - 60} more`);
  }
  return lines.join("\n") || "(none yet)";
}

function targetIdentity(target: LoadedAgent): string {
  const name = target.frontmatter.name;
  return (typeof name === "string" || typeof name === "number") && String(name).trim()
    ? String(name).trim() : target.key;
}

function currentDefinition(target: LoadedAgent, label: string, identity: string): string {
  return [
    `# ${label}`,
    "",
    `Name: ${identity}`,
    `Description: ${String(target.frontmatter.description ?? "")}`,
    `Model: ${String(target.frontmatter.model ?? "inherit")}`,
    `Tools: ${String(target.frontmatter.tools ?? "inherited")}`,
    `Skills: ${target.skills.map(skill => skill.name).join(", ")}`,
    "",
    truncate(target.body, 30_000),
  ].join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveParticipantRefs(
  mode: "create" | "improve",
  options: CreateAgentOptions | ImproveAgentOptions,
  source: SourceSession,
): string[] {
  const refs: string[] = [];
  if (mode === "create") {
    refs.push(...((options as CreateAgentOptions).agents ?? []));
  } else {
    const improve = options as ImproveAgentOptions;
    if (improve.includeSelf !== false) {
      refs.push(improve.agent);
    }
    refs.push(...(improve.with ?? []));
  }
  refs.push(...source.refs);
  const unique = new Map<string, string>();
  for (const ref of refs) {
    const key = agentKey(ref);
    if (!unique.has(key)) {
      unique.set(key, ref);
    }
  }
  if (!unique.size) {
    const message = mode === "create"
      ? "create_agent needs at least one participant: pass agents: [...] " +
        "or a from_session whose participants should design the agent."
      : "improve_agent needs at least one participant: pass with: [...] " +
        "(agents that will improve it) or leave include_self true.";
    throw new Error(message);
  }
  return [...unique.values()];
}

async function loadParticipants(refs: string[], isPublic: boolean): Promise<Participant[]> {
  const participants: Participant[] = [];
  for (const ref of refs) {
    const loaded = await loadAgent(ref);
    let system = loaded.body + renderSkillsSection(loaded.skills);
    if (isPublic) {
      system += publicDirectiveSuffix();
    }
    participants.push({ key: agentKey(ref), label: display(ref, isPublic), system });
  }
  return participants;
}

async function prepareWorkshop(
  mode: "create" | "improve",
  options: CreateAgentOptions | ImproveAgentOptions,
): Promise<PreparedWorkshop> {
  const create = options as CreateAgentOptions;
  const improve = options as ImproveAgentOptions;
  const isPublic = !!options.public;
  const source = sourceSession(options.fromSession, isPublic);
  const refs = resolveParticipantRefs(mode, options, source);
  const task = mode === "create" ? create.task?.trim() || source.topic : `improve ${agentKey(improve.agent)}`;
  if (!task) {
    throw new Error(
      "create_agent needs a task (what the new agent should do) " +
        "or a from_session whose topic describes it.",
    );
  }
  const target = mode === "improve" ? await loadAgent(improve.agent) : undefined;
  if (target && !/\.md$/i.test(target.path)) {
    throw new Error(
      `improve_agent can only edit a .md agent file; "${improve.agent}" resolved to ${target.path}.`,
    );
  }
  if (target) {
    assertReadableFrontmatter(readFrontmatter(target.raw), target.path);
  }
  const participants = await loadParticipants(refs, isPublic);
  const provider = options.provider || "anthropic";
  const model = options.model || DEFAULT_MODELS[provider];
  const rounds = Number.isNaN(options.rounds) ? 1 : Math.min(3, Math.max(1, Math.floor(options.rounds ?? 1)));
  const existingSkills = listSkills(skillSearchDirs(target?.path));
  const sessionId = mode === "create" ? `create-${++createCounter}` : `improve-${++improveCounter}`;
  const targetLabel = target ? display(improve.agent, isPublic) : "";
  const agents = listAgents().sort((a, b) => a.key.localeCompare(b.key));
  const common: PromptContext = {
    context: options.context,
    discussion: source.discussion,
    participants: participants.map(participant => participant.label),
    contributions: [],
    existingAgents: fleet(agents.map(agent => ({
      name: isPublic ? publicLabel(agent.name ?? agent.key) : agent.name ?? agent.key,
      description: agent.description,
    }))),
    existingSkills: fleet(existingSkills),
  };
  let identityName: string | undefined;
  if (target) {
    identityName = isPublic ? publicLabel(targetIdentity(target)) : targetIdentity(target);
  }
  const architectOptions: ArchitectPromptOptions = {
    ...common,
    mode,
    task: mode === "create" ? task : `improve ${targetLabel}`,
    name: mode === "create" ? create.name : undefined,
    identityName,
    currentDefinition: target && currentDefinition(target, targetLabel, identityName!),
    focus: mode === "improve" ? improve.focus : undefined,
  };
  return {
    mode,
    options,
    isPublic,
    sessionId,
    task,
    target,
    targetKey: target ? agentKey(improve.agent) : undefined,
    targetLabel,
    participants,
    rounds,
    llmOptions: { provider, model, baseUrl: options.baseUrl },
    existingSkillNames: existingSkills.map(skill => skill.name),
    common,
    architectOptions,
    // Associate review input with canonical keys, even if sanitized labels coincide.
    ownContributions: new Map(),
    run: { transcript: [] },
  };
}

// ----------------------------------------------------------------------------
// Contributions, architecture and reviews
// ----------------------------------------------------------------------------

function contributionPrompt(workshop: PreparedWorkshop, participant: Participant, round: number): string {
  const { common, target, rounds, targetLabel, targetKey } = workshop;
  if (!target) {
    return buildContributionPrompt({ ...common, task: workshop.task, round, rounds });
  }
  return buildImproveContributionPrompt({
    ...common,
    round,
    rounds,
    target: targetLabel,
    focus: (workshop.options as ImproveAgentOptions).focus,
    description: String(target.frontmatter.description ?? ""),
    systemPrompt: target.body,
    skills: target.skills,
    activity: recentActivityLines(targetKey!),
    isSelf: participant.key === targetKey,
  });
}

async function runContributions(workshop: PreparedWorkshop): Promise<void> {
  for (let round = 1; round <= workshop.rounds; round++) {
    for (const participant of workshop.participants) {
      const prompt = contributionPrompt(workshop, participant, round);
      const content = await callLLM(participant.system, [{ role: "user", content: prompt }], workshop.llmOptions);
      record(workshop.run, { phase: "contribution", agent: participant.label, content });
      const entry = { agent: participant.label, content };
      workshop.common.contributions.push(entry);
      const own = workshop.ownContributions.get(participant.key) ?? [];
      own.push(entry);
      workshop.ownContributions.set(participant.key, own);
    }
  }
}

function parseSpec(output: string, workshop: PreparedWorkshop): ParsedSpec {
  const raw = extractJsonObject(output);
  if (workshop.target && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const prototype = Object.getPrototypeOf(raw);
    const value = raw as Record<string, unknown>;
    if ((prototype === Object.prototype || prototype === null) &&
        (typeof value.name !== "string" || !value.name.trim())) {
      value.name = targetIdentity(workshop.target);
    }
  }
  const parsed = validateAgentSpec(raw, { mode: workshop.mode, existingSkills: workshop.existingSkillNames });
  const nameHint = (workshop.options as CreateAgentOptions).name;
  if (workshop.mode === "create" && nameHint && slugify(nameHint) && slugify(nameHint) !== parsed.spec.name) {
    parsed.spec.name = slugify(nameHint);
    parsed.warnings.push(`Name hint applied: "${parsed.spec.name}".`);
  }
  if (workshop.isPublic) {
    parsed.spec.contributions = parsed.spec.contributions.map(entry => ({ ...entry, agent: publicLabel(entry.agent) }));
    for (const skill of parsed.spec.skills) {
      skill.contributed_by = skill.contributed_by.map(publicLabel);
    }
  }
  return parsed;
}

async function runArchitect(workshop: PreparedWorkshop, prompt: string): Promise<ParsedSpec> {
  let system = buildArchitectSystemPrompt();
  if (workshop.isPublic) {
    system += publicDirectiveSuffix();
  }
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: prompt }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await callLLM(system, messages, workshop.llmOptions);
    try {
      return parseSpec(output, workshop);
    } catch (error) {
      if (attempt === 1) {
        throw new Error(
          `The architect did not return a usable agent definition after one retry: ${errorText(error)}`,
        );
      }
      messages.push(
        { role: "assistant", content: output },
        {
          role: "user",
          content: `Your output was not usable: ${errorText(error)}. Return only the corrected JSON object.`,
        },
      );
    }
  }
  throw new Error("Architect retry exhausted.");
}

async function runReviews(workshop: PreparedWorkshop, spec: AgentSpec): Promise<Review[]> {
  const draft = renderSpecMarkdown(spec);
  const reviews = await mapLimit(workshop.participants, PARALLEL_TURNS, async participant => {
    const prompt = buildSpecReviewPrompt({
      task: workshop.architectOptions.task,
      draft,
      contributions: workshop.ownContributions.get(participant.key) ?? [],
    });
    const content = await callLLM(participant.system, [{ role: "user", content: prompt }], workshop.llmOptions);
    return {
      agent: participant.label,
      content,
      verdict: parseVerdict(content, "Verdict", ["READY", "NEEDS CHANGES"]),
    };
  });
  for (const review of reviews) {
    record(workshop.run, { phase: "review", agent: review.agent, content: review.content });
  }
  return reviews;
}

// ----------------------------------------------------------------------------
// Files, activity, delegation and public completion
// ----------------------------------------------------------------------------

function saveDefinition(workshop: PreparedWorkshop, spec: AgentSpec): SavedDefinition {
  const date = new Date().toISOString().slice(0, 10);
  const createdFrom = workshop.participants.map(participant => participant.key);
  const opts: AgentFilePlanOptions = workshop.target
    ? {
      mode: "improve",
      targetPath: workshop.target.path,
      skillsDir: projectSkillsDir(workshop.target.path) ?? SKILLS_DIR,
      searchDirs: skillSearchDirs(workshop.target.path),
      originalContent: workshop.target.raw,
      createdFrom,
      date,
      timestamp: formatBackupTimestamp(new Date()),
    }
    : { mode: "create", agentsDir: AGENTS_DIR, skillsDir: SKILLS_DIR, searchDirs: skillSearchDirs(), createdFrom, date };
  if (workshop.options.write === false) {
    const plan = planAgentFiles(spec, opts);
    const files = plan.files.map(({ path, content }) => ({ path, content }));
    return { plan, files, written: false };
  }
  const plan = opts.mode === "create" ? writeNewAgent(spec, opts) : writeImprovedAgent(spec, opts);
  return { plan, written: true };
}

function effectiveTools(spec: AgentSpec, target?: LoadedAgent): string[] | undefined {
  if (spec.tools) {
    return spec.tools;
  }
  const tools = target?.frontmatter.tools;
  if (typeof tools === "string") {
    return tools.split(",").map(tool => tool.trim()).filter(Boolean);
  }
  if (Array.isArray(tools)) {
    return tools.filter((tool): tool is string => typeof tool === "string");
  }
  return undefined;
}

function nextStep(workshop: PreparedWorkshop, saved: SavedDefinition): string {
  if (!saved.written) {
    return "Nothing was written (write: false). Review `files`, then call again with write: true to save them.";
  }
  if (saved.plan.proposedPath) {
    return `${workshop.target!.path} changed while improve_agent was running, so it was not overwritten. ` +
      `The proposed definition is at ${saved.plan.proposedPath} (a non-.md file, never loaded as an agent): ` +
      "compare it with the current file and merge by hand, or run improve_agent again.";
  }
  if (workshop.target) {
    return `The improved definition is live; the previous version is at ${saved.plan.backupPath}.`;
  }
  const name = saved.plan.agentName;
  return `Delegate the task to it now: in Claude Code use the Agent tool with subagent_type "${name}" ` +
    "(new files in .claude/agents are picked up within seconds), " +
    `or on the roundtable call start_meeting with agent "${name}".`;
}

function recordWorkshopActivity(workshop: PreparedWorkshop, spec: AgentSpec, saved: SavedDefinition): void {
  const { written, plan } = saved;
  let outcome: string;
  if (plan.proposedPath) {
    outcome = `proposed changes to ${workshop.targetKey} (target changed during the run)`;
  } else if (workshop.target) {
    const verb = written ? "improved" : "drafted";
    outcome = `${verb} ${workshop.targetKey}: ${spec.changes?.length ?? 0} changes`;
  } else {
    const verb = written ? "created" : "drafted";
    const skills = spec.skills.length
      ? "(skills: " + spec.skills.map(skill => skill.name).join(", ") + ")"
      : "(no skills)";
    outcome = `${verb} ${plan.agentName} ${skills}`;
  }
  recordActivity({
    session: workshop.sessionId,
    kind: workshop.target ? "agent-refinement" : "agent-creation",
    agents: workshop.participants.map(participant => participant.key),
    topic: workshop.task,
    outcome: (written ? "" : "preview: ") + outcome,
    public: workshop.isPublic,
  });
}

async function performTask(
  workshop: PreparedWorkshop,
  saved: SavedDefinition,
  warnings: string[],
): Promise<AgentWorkshopResult["meeting"]> {
  const options = workshop.options as CreateAgentOptions;
  if (workshop.mode !== "create" || !options.performTask) {
    return undefined;
  }
  if (!saved.written) {
    warnings.push("perform_task was skipped because write is false.");
    return undefined;
  }
  const { provider, model, baseUrl } = workshop.llmOptions;
  try {
    const result = await startMeeting(saved.plan.agentPath, workshop.task, options.context, provider, model, baseUrl);
    return { meetingId: result.meetingId, response: result.response };
  } catch (error) {
    warnings.push(`perform_task failed: ${errorText(error)}`);
    return undefined;
  }
}

async function finishWorkshop(
  workshop: PreparedWorkshop,
  parsed: ParsedSpec,
  reviews: Review[],
): Promise<AgentWorkshopResult> {
  const { spec } = parsed;
  const saved = saveDefinition(workshop, spec);
  const { plan, written } = saved;
  const warnings = [...parsed.warnings, ...plan.warnings];
  recordWorkshopActivity(workshop, spec, saved);
  let next = nextStep(workshop, saved);
  const meeting = await performTask(workshop, saved, warnings);
  if (meeting) {
    next += ` The new agent has already started on the task in meeting ${meeting.meetingId}; ` +
      "continue it with continue_meeting.";
  }
  let publicBlock: string | undefined;
  if (workshop.run.channel) {
    const finalSpec = { ...spec, name: workshop.isPublic ? publicLabel(plan.agentName) : plan.agentName };
    const finalized = await workshop.run.channel.finalize({ summary: renderSpecMarkdown(finalSpec) });
    publicBlock = formatPublicBlock(workshop.run.channel, finalized);
  }
  const originalModel = workshop.target?.frontmatter.model;
  const model = spec.model ?? (typeof originalModel === "string" ? originalModel : undefined);
  const tools = effectiveTools(spec, workshop.target);
  return {
    mode: workshop.mode,
    sessionId: workshop.sessionId,
    agent: {
      name: plan.agentName,
      path: written && !plan.proposedPath ? plan.agentPath : null,
      description: spec.description,
      ...(model !== undefined && { model }),
      ...(tools !== undefined && { tools }),
      skills: plan.skills.map(skill => written
        ? skill
        : { name: skill.name, path: null, status: "preview" as const }),
    },
    ...(written && plan.backupPath && { backupPath: plan.backupPath }),
    ...(plan.proposedPath && { proposedPath: plan.proposedPath }),
    contributions: spec.contributions,
    reviews: reviews.map(({ agent, verdict }) => ({ agent, verdict })),
    ...(spec.changes && { changes: spec.changes }),
    ...(spec.open_questions && { openQuestions: spec.open_questions }),
    warnings,
    ...(saved.files && { files: saved.files }),
    ...(meeting && { meeting }),
    next,
    ...(publicBlock && { publicBlock }),
  };
}

// ----------------------------------------------------------------------------
// Public entry points and pipeline
// ----------------------------------------------------------------------------

/** Collaboratively design, review, and save or preview a new subagent. */
export async function createAgent(o: CreateAgentOptions): Promise<AgentWorkshopResult> {
  return workshop("create", o);
}

/** Collaboratively refine an existing subagent with a backup of its original definition. */
export async function improveAgent(o: ImproveAgentOptions): Promise<AgentWorkshopResult> {
  return workshop("improve", o);
}

const improveLocks = new Set<string>();

async function workshop(
  mode: "create" | "improve",
  options: CreateAgentOptions | ImproveAgentOptions,
): Promise<AgentWorkshopResult> {
  const prepared = await prepareWorkshop(mode, options);
  const lockPath = prepared.target ? fs.realpathSync(prepared.target.path) : undefined;
  if (lockPath) {
    if (improveLocks.has(lockPath)) {
      throw new Error(`improve_agent is already running for ${agentKey(prepared.target!.path)}; wait for it to finish`);
    }
    improveLocks.add(lockPath);
  }
  try {
    if (prepared.isPublic) {
      prepared.run.channel = openPublicChannel(prepared.sessionId, {
        mode: mode === "create" ? "agent-creation" : "agent-refinement",
        participants: prepared.participants.map(participant => participant.label),
        topic: mode === "create" ? prepared.task : `improve ${prepared.targetLabel}`,
      });
    }
    await runContributions(prepared);
    let parsed = await runArchitect(prepared, buildArchitectPrompt(prepared.architectOptions));
    const reviews = await runReviews(prepared, parsed.spec);
    if (reviews.some(review => review.verdict !== "READY")) {
      const prompt = buildArchitectRevisePrompt({ ...prepared.architectOptions, spec: parsed.spec, reviews });
      parsed = await runArchitect(prepared, prompt);
    }
    return await finishWorkshop(prepared, parsed, reviews);
  } catch (error) {
    if (prepared.run.channel) {
      void prepared.run.channel.finalize();
    }
    throw error;
  } finally {
    if (lockPath) improveLocks.delete(lockPath);
  }
}
