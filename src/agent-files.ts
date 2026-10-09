// ============================================================================
// Safe agent definitions, rendering and filesystem plans (no provider calls)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { stringify } from "yaml";
import { agentKey, assertReadableFrontmatter, listAgents, readFrontmatter } from "./agents.js";

export const MODEL_CHOICES = ["opus", "sonnet", "haiku", "inherit"] as const;
export const TOOL_ALLOWLIST = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] as const;
export const RESERVED_SKILL_NAMES = ["synced", "anthropic-skills"];

/** A reusable procedure, either newly authored or attached by its existing name. */
export interface SkillSpec {
  name: string;
  description: string;
  instructions?: string;
  contributed_by: string[];
}

/** Validated agent definition containing only managed fields from the architect. */
export interface AgentSpec {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  system_prompt: string;
  skills: SkillSpec[];
  contributions: Array<{
    agent: string;
    summary: string;
  }>;
  open_questions?: string[];
  changes?: string[];
}

/** Convert a name to a bounded lowercase slug, removing diacritics and edge dashes. */
export function slugify(s: string, max = 64): string {
  return s.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(0, max))
    .replace(/-+$/, "");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function line(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value.filter((s): s is string => typeof s === "string").map(s => s.trim()).filter(Boolean);
  return [...new Set(names)];
}

function omitted(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/** Reject unusable output; normalize every recoverable field without accepting extra keys. */
export function validateAgentSpec(
  raw: unknown,
  ctx: { existingSkills: string[]; mode: "create" | "improve" },
): { spec: AgentSpec; warnings: string[] } {
  if (!object(raw)) {
    throw new Error("Agent definition must be a plain object.");
  }
  const warnings: string[] = [];
  const cap = (text: string, max: number, field: string): string => {
    if (text.length > max) {
      warnings.push(`${field} truncated to ${max} characters.`);
    }
    return text.slice(0, max);
  };
  const name = typeof raw.name === "string" ? slugify(raw.name) : "";
  if (!name) {
    throw new Error("name must be a non-empty string that can become a slug.");
  }
  if (name !== (raw.name as string).trim()) {
    warnings.push(`name normalized to "${name}".`);
  }
  const description = line(raw.description);
  if (!description) {
    throw new Error("description must be a non-empty string.");
  }
  const prompt = typeof raw.system_prompt === "string" ? raw.system_prompt.trim() : "";
  if (!prompt) {
    throw new Error("system_prompt must be a non-empty string.");
  }
  const spec: AgentSpec = {
    name,
    description: cap(description, 1000, "description"),
    system_prompt: cap(prompt, 40_000, "system_prompt"),
    skills: [],
    contributions: []
  };
  if (!omitted(raw.model)) {
    const model = typeof raw.model === "string" ? raw.model.trim().toLowerCase() : "";
    if (MODEL_CHOICES.some(choice => choice === model)) {
      spec.model = model;
    } else {
      warnings.push("Invalid model dropped; omit model to inherit.");
    }
  }
  const toolsError = (): Error => new Error(
    `tools must list tool names from: ${TOOL_ALLOWLIST.join(", ")} ` +
      `(or be omitted to inherit all tools); got: ${typeof raw.tools === "string" ? raw.tools : inspect(raw.tools)}`,
  );
  if (!omitted(raw.tools)) {
    if (typeof raw.tools !== "string" && !Array.isArray(raw.tools)) {
      throw toolsError();
    }
    const input = typeof raw.tools === "string"
      ? raw.tools.split(",")
      : Array.isArray(raw.tools) ? raw.tools : [raw.tools];
    const tools: string[] = [];
    const unknown: string[] = [];
    for (const value of input) {
      if (typeof raw.tools === "string" && typeof value === "string" && !value.trim()) {
        continue;
      }
      const canonical = typeof value === "string"
        ? TOOL_ALLOWLIST.find(tool => tool.toLowerCase() === value.trim().toLowerCase())
        : undefined;
      if (canonical) {
        if (!tools.includes(canonical)) {
          tools.push(canonical);
        }
      } else {
        unknown.push(String(value));
      }
    }
    if (input.length && !tools.length && unknown.length) {
      throw toolsError();
    }
    if (unknown.length) {
      warnings.push(`Unknown tools dropped: ${unknown.join(", ")}.`);
    }
    if (tools.length) {
      spec.tools = tools;
    }
  }
  if (!spec.tools && ctx.mode === "create") {
    warnings.push("tools omitted: the agent inherits all tools");
  }
  if (raw.skills !== undefined && !Array.isArray(raw.skills)) {
    warnings.push("skills must be an array; ignored.");
  }
  const merged = new Map<string, SkillSpec>();
  for (const entry of Array.isArray(raw.skills) ? raw.skills : []) {
    if (!object(entry)) {
      warnings.push("Non-object skill dropped.");
      continue;
    }
    let skillName = typeof entry.name === "string" ? slugify(entry.name) : "";
    if (!skillName) {
      warnings.push("Skill with empty name dropped.");
      continue;
    }
    if (skillName !== (entry.name as string).trim()) {
      warnings.push(`Skill name normalized to "${skillName}".`);
    }
    if (RESERVED_SKILL_NAMES.includes(skillName)) {
      skillName += "-skill";
      warnings.push(`Reserved skill name changed to "${skillName}".`);
    }
    const instructions = typeof entry.instructions === "string" ? entry.instructions.trim() : "";
    const skill: SkillSpec = {
      name: skillName,
      description: line(entry.description),
      ...(instructions && { instructions }),
      contributed_by: strings(entry.contributed_by)
    };
    const previous = merged.get(skillName);
    if (previous) {
      previous.contributed_by = [...new Set([...previous.contributed_by, ...skill.contributed_by])];
      previous.description ||= skill.description;
      previous.instructions ||= skill.instructions;
      warnings.push(`Duplicate skill "${skillName}" merged.`);
    } else {
      merged.set(skillName, skill);
    }
  }
  for (const skill of merged.values()) {
    const existing = ctx.existingSkills.find(name => name === skill.name)
      ?? ctx.existingSkills.find(name => name.toLowerCase() === skill.name.toLowerCase());
    if (existing !== undefined) {
      skill.name = existing;
      if (skill.instructions) {
        warnings.push(`Skill "${existing}": instructions ignored; existing skills are never overwritten.`);
      }
      delete skill.instructions;
    } else {
      if (!skill.instructions) {
        warnings.push(`New skill "${skill.name}" dropped: provide non-empty instructions.`);
        continue;
      }
      skill.instructions = cap(skill.instructions, 20_000, `Skill "${skill.name}" instructions`);
      if (!skill.description) {
        skill.description = skill.instructions.split(/\r?\n|(?<=[.!?])\s/)[0].slice(0, 200);
        warnings.push(`Skill "${skill.name}" description derived from instructions.`);
      }
    }
    skill.description = cap(skill.description, 1000, `Skill "${skill.name}" description`);
    spec.skills.push(skill);
  }
  if (spec.skills.length > 6) {
    warnings.push(`Extra skills dropped: ${spec.skills.slice(6).map(s => s.name).join(", ")}.`);
    spec.skills = spec.skills.slice(0, 6);
  }
  if (raw.contributions !== undefined) {
    let invalid = !Array.isArray(raw.contributions);
    for (const entry of Array.isArray(raw.contributions) ? raw.contributions : []) {
      if (!object(entry) || typeof entry.agent !== "string" || !entry.agent.trim() || !line(entry.summary)) {
        invalid = true;
        continue;
      }
      spec.contributions.push({ agent: entry.agent.trim().slice(0, 100), summary: line(entry.summary).slice(0, 500) });
    }
    if (invalid) {
      warnings.push("Invalid contributions dropped; provide non-empty agent and summary strings.");
    }
  }
  const questions = strings(raw.open_questions).slice(0, 10);
  if (questions.length) {
    spec.open_questions = questions;
  }
  const changes = ctx.mode === "improve" ? strings(raw.changes).slice(0, 30) : [];
  if (changes.length) {
    spec.changes = changes;
  }
  return { spec, warnings };
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function skillNames(value: unknown): string[] {
  return typeof value === "string" ? strings(value.split(",")) : strings(value);
}

function credits(names: string[]): string {
  return names.map(n => n.replace(/--|>/g, "")).join(", ");
}

/** Render safe YAML metadata and one provenance footer, preserving unmanaged original keys. */
export function renderAgentFile(
  spec: AgentSpec,
  opts: {
    createdFrom: string[];
    date: string;
    preserveFrontmatter?: Record<string, unknown>;
    identityName?: string;
  },
): string {
  const original = opts.preserveFrontmatter ?? {};
  const data: Record<string, unknown> = { name: opts.identityName ?? spec.name, description: spec.description };
  const model = spec.model ?? original.model;
  if (model !== undefined) {
    data.model = model;
  }
  const tools = spec.tools ? spec.tools.join(", ") : original.tools;
  if (tools !== undefined) {
    data.tools = tools;
  }
  const skills = [...new Set([...skillNames(original.skills), ...spec.skills.map(s => s.name)])];
  if (skills.length) {
    data.skills = skills;
  }
  for (const [key, value] of Object.entries(original)) {
    if (!["name", "description", "model", "tools", "skills"].includes(key)) {
      data[key] = value;
    }
  }
  const body = spec.system_prompt.replace(/^\s*<!-- Created by agent-roundtable [^\r\n]*-->[ \t]*$/gm, "").trim();
  const tool = opts.preserveFrontmatter !== undefined ? "improve_agent" : "create_agent";
  const footer = `<!-- Created by agent-roundtable ${tool} on ${opts.date} ` +
    `with input from: ${credits(opts.createdFrom)}. -->`;
  return `---\n${stringify(data, { lineWidth: 0 })}---\n\n${body}\n\n${footer}\n`;
}

/** Render a new skill's YAML metadata, instructions, title and contributor credits. */
export function renderSkillFile(skill: SkillSpec, opts: { date: string }): string {
  const title = skill.name.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
  const frontmatter = stringify({ name: skill.name, description: skill.description }, { lineWidth: 0 });
  const footer = `<!-- Created by agent-roundtable on ${opts.date}; ` +
    `contributed by: ${credits(skill.contributed_by) || "(unknown)"}. -->`;
  return `---\n${frontmatter}---\n\n# ${title}\n\n${skill.instructions?.trim() ?? ""}\n\n${footer}\n`;
}

/** Render the definition as readable Markdown for specialist reviews and public summaries. */
export function renderSpecMarkdown(spec: AgentSpec, opts?: { reusedSkills?: string[] }): string {
  const sections = [
    `# ${spec.name}`,
    `**Description:** ${spec.description}`,
    `**Model:** ${spec.model ?? "inherit (not set)"}`,
    `**Tools:** ${spec.tools?.join(", ") ?? "all tools (inherited)"}`,
    `## System prompt\n\n${spec.system_prompt}`,
    "## Skills"
  ];
  for (const skill of spec.skills) {
    const reused = !skill.instructions || opts?.reusedSkills?.includes(skill.name);
    const label = reused ? "existing skill, reused" : "new";
    let section = `### ${skill.name} (${label})\n\n${skill.description}`;
    if (!reused) {
      section += "\n\n" + skill.instructions;
    }
    sections.push(section);
  }
  sections.push("## Contributions\n\n" + spec.contributions.map(c => `- **${c.agent}:** ${c.summary}`).join("\n"));
  if (spec.open_questions?.length) {
    sections.push("## Open questions\n\n" + spec.open_questions.map(q => `- ${q}`).join("\n"));
  }
  if (spec.changes?.length) {
    sections.push("## Changes\n\n" + spec.changes.map(c => `- ${c}`).join("\n"));
  }
  return sections.join("\n\n");
}

/** Format a UTC date as YYYYMMDD-HHMMSS for agent backups. */
export function formatBackupTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/[-:T]/g, (s) => s === "T" ? "-" : "");
}

// ----------------------------------------------------------------------------
// Shared planner: reads only, with exclusive creation in the writers below
// ----------------------------------------------------------------------------

/** Final agent identity and skill statuses after an agent write. */
export interface WriteResult {
  agentPath: string;
  agentName: string;
  skills: Array<{
    name: string;
    path: string;
    status: "created" | "reused";
  }>;
  backupPath?: string;
  proposedPath?: string;
  warnings: string[];
}

/** Inputs for planning a new definition or a replacement with a backup. */
export type AgentFilePlanOptions = { searchDirs?: string[] } & ({
  mode: "create";
  agentsDir: string;
  skillsDir: string;
  createdFrom: string[];
  date: string;
} | {
  mode: "improve";
  targetPath: string;
  skillsDir: string;
  createdFrom: string[];
  date: string;
  timestamp: string;
  originalContent?: string;
});

/** Read-only plan containing skill files first and the agent file last. */
export interface AgentFilePlan extends WriteResult {
  files: Array<{
    path: string;
    content: string;
    kind: "agent" | "skill";
  }>;
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (code(e) === "ENOENT") {
      return [];
    }
    throw e;
  }
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** Use the subagent prefix only when a strict majority of Markdown files already use it. */
export function detectAgentFilePrefix(agentsDir: string): "" | "subagent-" {
  const files = entries(agentsDir).filter(e => e.isFile() && /\.md$/i.test(e.name));
  return files.filter(e => e.name.toLowerCase().startsWith("subagent-")).length > files.length / 2 ? "subagent-" : "";
}

function physical(p: string): string {
  if (fs.existsSync(p)) {
    return fs.realpathSync(p);
  }
  // lstat also detects dangling links, which must not be followed during a write.
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new Error(`Unsafe dangling symbolic link: ${p}`);
    }
  } catch (e) {
    if (code(e) !== "ENOENT") {
      throw e;
    }
  }
  return path.join(physical(path.dirname(p)), path.basename(p));
}

function inside(base: string, candidate: string): void {
  const contained = (b: string, p: string) => {
    const r = path.relative(b, p);
    return r !== "" && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
  };
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  if (!contained(resolvedBase, resolvedCandidate) ||
      !contained(physical(resolvedBase), physical(resolvedCandidate))) {
    throw new Error(`Unsafe file path outside its base directory: ${candidate}`);
  }
}

function backupName(target: string, timestamp: string, kind = "bak"): string {
  const base = `${target}.${kind}-${timestamp}`;
  let candidate = base;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${n++}`;
  }
  inside(path.dirname(target), candidate);
  return candidate;
}

/** Read the filesystem and plan exactly which files a writer would create or replace. */
export function planAgentFiles(spec: AgentSpec, opts: AgentFilePlanOptions): AgentFilePlan {
  const skillsDir = path.resolve(opts.skillsDir);
  const warnings: string[] = [];
  const files: AgentFilePlan["files"] = [];
  const skills: WriteResult["skills"] = [];
  let agentPath: string;
  let agentName: string;
  let backupPath: string | undefined;
  let content: string;
  if (opts.mode === "create") {
    const dir = path.resolve(opts.agentsDir);
    const prefix = detectAgentFilePrefix(dir);
    const taken = new Set<string>();
    for (const e of entries(dir)) {
      if (e.isDirectory()) {
        taken.add(e.name.toLowerCase());
      } else if (/\.md$/i.test(e.name)) {
        taken.add(e.name.replace(/\.md$/i, "").toLowerCase());
        taken.add(agentKey(e.name));
      }
    }
    for (const a of listAgents(dir)) {
      taken.add(a.key.toLowerCase());
      if (a.name) {
        taken.add(a.name.toLowerCase());
      }
    }
    agentName = spec.name;
    let n = 2;
    while (taken.has(agentName.toLowerCase())) {
      const suffix = `-${n++}`;
      agentName = spec.name.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
    }
    if (agentName !== spec.name) {
      warnings.push(`An agent named "${spec.name}" already exists; using "${agentName}"`);
    }
    agentPath = path.join(dir, `${prefix}${agentName}.md`);
    inside(dir, agentPath);
    content = renderAgentFile({ ...spec, name: agentName }, opts);
  } else {
    agentPath = path.resolve(opts.targetPath);
    if (!/\.md$/i.test(agentPath) || !fs.existsSync(agentPath) || !fs.statSync(agentPath).isFile()) {
      throw new Error(`improve target must be an existing .md agent file: ${agentPath}`);
    }
    if (!/^[0-9A-Za-z-]+$/.test(opts.timestamp)) {
      throw new Error("Invalid backup timestamp; use letters, digits and hyphens only.");
    }
    if (fs.lstatSync(agentPath).isSymbolicLink()) {
      const realPath = fs.realpathSync(agentPath);
      throw new Error(
        `improve_agent will not edit ${agentPath}: it is a symbolic link to ${realPath}. ` +
          `Pass the real file instead (agent: "${realPath}").`,
      );
    }
    inside(path.dirname(agentPath), agentPath);
    const frontmatter = readFrontmatter(opts.originalContent ?? fs.readFileSync(agentPath, "utf8"));
    assertReadableFrontmatter(frontmatter, agentPath);
    const { data } = frontmatter;
    if (frontmatter.lenient) {
      warnings.push(`Original frontmatter of ${agentPath} is not strict YAML; it was read leniently and rewritten as valid YAML`);
    }
    if (!spec.tools && data.tools == null) {
      warnings.push("tools omitted: the agent inherits all tools");
    }
    agentName = (typeof data.name === "string" || typeof data.name === "number") && String(data.name).trim()
      ? String(data.name).trim() : agentKey(agentPath);
    backupPath = backupName(agentPath, opts.timestamp);
    content = renderAgentFile(spec, { ...opts, preserveFrontmatter: data, identityName: agentName });
  }
  for (const skill of spec.skills) {
    const p = path.resolve(skillsDir, skill.name, "SKILL.md");
    inside(skillsDir, p);
    // A skill name is a single directory component, including reused exact names.
    if (!skill.name || /[\\/]/.test(skill.name) || skill.name === "." || skill.name === "..") {
      throw new Error(`Unsafe skill name: ${skill.name}`);
    }
    const existingPath = (opts.searchDirs ?? [skillsDir])
      .map(dir => path.resolve(dir, skill.name, "SKILL.md"))
      .find(candidate => fs.existsSync(candidate));
    const reused = !skill.instructions || existingPath !== undefined;
    if (skill.instructions && reused) {
      warnings.push(`Skill "${skill.name}" already exists; reused without overwriting.`);
    }
    skills.push({ name: skill.name, path: existingPath ?? p, status: reused ? "reused" : "created" });
    if (!reused) {
      files.push({ path: p, content: renderSkillFile(skill, opts), kind: "skill" });
    }
  }
  files.push({ path: agentPath, content, kind: "agent" });
  return { agentPath, agentName, files, skills, ...(backupPath && { backupPath }), warnings };
}

/** Return planned paths and contents without creating directories, files or backups. */
export function previewFiles(spec: AgentSpec, opts: AgentFilePlanOptions): Array<{ path: string; content: string }> {
  return planAgentFiles(spec, opts).files.map(({ path, content }) => ({ path, content }));
}

function writeSkills(plan: AgentFilePlan, skillsDir: string): void {
  const existed = fs.existsSync(skillsDir);
  for (const file of plan.files.filter(f => f.kind === "skill")) {
    inside(skillsDir, file.path);
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    try {
      fs.writeFileSync(file.path, file.content, { flag: "wx" });
    } catch (e) {
      if (code(e) !== "EEXIST") {
        throw e;
      }
      plan.skills.find(s => s.path === file.path)!.status = "reused";
      const name = path.basename(path.dirname(file.path));
      plan.warnings.push(`Skill "${name}" already exists; reused without overwriting.`);
    }
  }
  if (!existed && plan.skills.some(s => s.status === "created")) {
    plan.warnings.push(
      "Claude Code only watches skill directories that existed when the session started; " +
        "restart it to pick this one up",
    );
  }
}

function result(plan: AgentFilePlan): WriteResult {
  const { files: _files, ...rest } = plan;
  return rest;
}

type CreateWriteOptions = Omit<Extract<AgentFilePlanOptions, { mode: "create" }>, "mode">;
type ImproveWriteOptions = Omit<Extract<AgentFilePlanOptions, { mode: "improve" }>, "mode">;

/** Create skills and a collision-free agent exclusively, retrying filename races without overwrites. */
export function writeNewAgent(spec: AgentSpec, opts: CreateWriteOptions): WriteResult {
  const existed = fs.existsSync(opts.agentsDir);
  const plan = planAgentFiles(spec, { ...opts, mode: "create" });
  writeSkills(plan, opts.skillsDir);
  fs.mkdirSync(path.resolve(opts.agentsDir), { recursive: true });
  for (let tries = 0; tries < 50; tries++) {
    inside(opts.agentsDir, plan.agentPath);
    try {
      fs.writeFileSync(plan.agentPath, plan.files[plan.files.length - 1].content, { flag: "wx" });
      if (!existed) {
        plan.warnings.push(
          "Claude Code only watches agent directories that existed when the session started; " +
            "restart it to pick this one up",
        );
      }
      return result(plan);
    } catch (e) {
      if (code(e) !== "EEXIST") {
        throw e;
      }
      const retry = planAgentFiles(spec, { ...opts, mode: "create" });
      plan.agentPath = retry.agentPath;
      plan.agentName = retry.agentName;
      plan.files[plan.files.length - 1] = retry.files[retry.files.length - 1];
      plan.warnings = plan.warnings.filter(warning => !warning.startsWith("An agent named "));
      if (retry.agentName !== spec.name) {
        plan.warnings.push(`An agent named "${spec.name}" already exists; using "${retry.agentName}"`);
      }
      plan.warnings = [...new Set(plan.warnings)];
    }
  }
  throw new Error("Could not create the agent after 50 filename collisions; retry with a different name.");
}

let tempCounter = 0;

/** Replace only after a complete, flushed temporary file is ready beside the target. */
function atomicReplace(target: string, content: string, mode: number): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${++tempCounter}`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    created = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode & 0o7777);
    fs.renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Preserve the original failure. */ }
    }
    if (created) {
      try { fs.unlinkSync(tmp); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

/** Preserve concurrent edits as a proposal; otherwise back up and atomically replace. */
export function writeImprovedAgent(spec: AgentSpec, opts: ImproveWriteOptions): WriteResult {
  const plan = planAgentFiles(spec, { ...opts, mode: "improve" });
  writeSkills(plan, opts.skillsDir);
  const content = plan.files[plan.files.length - 1].content;
  const current = fs.readFileSync(plan.agentPath, "utf8");
  if (opts.originalContent !== undefined && current !== opts.originalContent) {
    for (;;) {
      const proposedPath = backupName(plan.agentPath, opts.timestamp, "proposed");
      try {
        fs.writeFileSync(proposedPath, content, { flag: "wx" });
        plan.proposedPath = proposedPath;
        delete plan.backupPath;
        plan.warnings.push(`${plan.agentPath} changed while improve_agent was running, so it was not overwritten; the proposed definition is at ${proposedPath}`);
        return result(plan);
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
    }
  }
  const mode = fs.statSync(plan.agentPath).mode;
  for (;;) {
    inside(path.dirname(plan.agentPath), plan.backupPath!);
    try {
      fs.copyFileSync(plan.agentPath, plan.backupPath!, fs.constants.COPYFILE_EXCL);
      break;
    } catch (e) {
      if (code(e) !== "EEXIST") {
        throw e;
      }
      plan.backupPath = backupName(plan.agentPath, opts.timestamp);
    }
  }
  inside(path.dirname(plan.agentPath), plan.agentPath);
  atomicReplace(plan.agentPath, content, mode);
  return result(plan);
}
