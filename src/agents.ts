// ============================================================================
// Agent Loading
// ============================================================================

import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { AGENTS_DIR, SKILLS_DIR } from "./config.js";

/** Canonical, path-free agent name, including directory-style AGENT.md personas. */
export function agentKey(ref: string): string {
  const normalized = ref.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = /^AGENT\.md$/i.test(basename(normalized))
    ? basename(dirname(normalized))
    : basename(normalized);
  return name.replace(/\.md$/i, "").replace(/^subagent-/i, "").toLowerCase();
}

/**
 * Strip a leading YAML frontmatter block ("---" ... "---") from an agent prompt file.
 * Rule: if the text (after an optional BOM) starts with "---" as its first line, a later line
 * matches /^---\s*$/ (CRLF tolerant), and at least one line between the fences looks like a YAML
 * key ("name: ..."), drop everything through that closing line plus any blank lines that follow
 * it. Otherwise the text is returned unchanged — so a persona whose body opens with a markdown
 * horizontal rule and contains a second one is never truncated.
 */
export function stripFrontmatter(text: string): string {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return text;
  let sawKey = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      if (!sawKey) return text;
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      return lines.slice(next).join("\n");
    }
    if (/^[A-Za-z_][\w-]*\s*:/.test(lines[i])) sawKey = true;
  }
  return text;
}

export interface AgentFrontmatter {
  data: Record<string, unknown>;
  hasFrontmatter: boolean;
  parseError?: string;
  /** Offset after the Claude-compatible closing fence, in the original text. */
  blockEnd: number;
  fenceMismatch: boolean;
}

export interface Frontmatter extends AgentFrontmatter {
  body: string;
}

function metadataObject(parsed: unknown): Record<string, unknown> {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {};
}

/** Read metadata using Claude Code 2.1.x's fence and single YAML recovery pass. */
export function parseAgentFrontmatter(text: string): AgentFrontmatter {
  const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const source = text.slice(bomLength);
  const match = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(source);
  if (!match) return { data: {}, hasFrontmatter: false, blockEnd: 0, fenceMismatch: false };
  const openingEnd = /^---\s*\n/.exec(source)![0].length;
  const fenceStart = openingEnd + match[1].length;
  // Body extraction still uses a whole closing line; metadata ends at any triple dash.
  const lineFence = /^---[^\S\r\n]*\r?$/gm;
  lineFence.lastIndex = openingEnd;
  const closingLine = lineFence.exec(source);
  const result = {
    hasFrontmatter: true,
    blockEnd: bomLength + match[0].length,
    fenceMismatch: closingLine !== null && fenceStart < closingLine.index,
  };
  try {
    return { ...result, data: metadataObject(parse(match[1], { logLevel: "error" })) };
  } catch {
    const rewritten = match[1].split("\n").map(line => {
      const scalar = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line);
      if (!scalar) return line;
      const [, key, value] = scalar;
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) return line;
      if (value.startsWith("[") && value.endsWith("]")) {
        try {
          if (Array.isArray(parse(value, { logLevel: "error" }))) return line;
        } catch { /* A malformed flow value may still be recovered as a string. */ }
      }
      if (!/[{}\[\]*&#!|>%@`]|: /.test(value)) return line;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    }).join("\n").replace(/^\t+/gm, tabs => "  ".repeat(tabs.length));
    try {
      return { ...result, data: metadataObject(parse(rewritten, { logLevel: "error" })) };
    } catch (error) {
      return { ...result, data: {}, parseError: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Metadata uses Claude Code's view; persona body extraction keeps the existing line fences. */
export function readFrontmatter(text: string): Frontmatter {
  return { ...parseAgentFrontmatter(text), body: stripFrontmatter(text) };
}

/** Refuse an improvement that could revive dormant keys or discard ambiguous metadata. */
export function assertReadableFrontmatter(frontmatter: AgentFrontmatter, file: string): void {
  if (frontmatter.fenceMismatch) {
    throw new Error(
      `${file} has '---' inside its frontmatter; Claude Code ends the frontmatter there, ` +
        "so the file's keys are ambiguous; fix it first",
    );
  }
  if (frontmatter.hasFrontmatter && frontmatter.parseError) {
    throw new Error(
      `Claude Code cannot parse the frontmatter of ${file} (${frontmatter.parseError}), ` +
        "so it does not load this agent today; fix the frontmatter first",
    );
  }
}

// ----------------------------------------------------------------------------
// Skills
// ----------------------------------------------------------------------------

export interface LoadedSkill {
  name: string;
  description?: string;
  path: string;
  body: string;
}

/** The skill directory beside a directly contained .claude/agents definition. */
export function projectSkillsDir(agentPath: string): string | undefined {
  const dir = dirname(resolve(agentPath));
  return basename(dir) === "agents" && basename(dirname(dir)) === ".claude"
    ? join(dirname(dir), "skills") : undefined;
}

/** Claude Code precedence: personal skills, target project, configured project. */
export function skillSearchDirs(agentPath?: string): string[] {
  const project = agentPath ? projectSkillsDir(agentPath) : undefined;
  return [...new Set([
    join(homedir(), ".claude", "skills"),
    ...(project ? [project] : []),
    SKILLS_DIR,
  ].map(dir => resolve(dir)))];
}

export async function loadSkills(
  names: string[],
  dirs: string | readonly string[] = skillSearchDirs(),
): Promise<LoadedSkill[]> {
  const searchDirs = typeof dirs === "string" ? [dirs] : dirs;
  const skills: LoadedSkill[] = [];
  for (const ref of names) {
    const name = ref.trim();
    if (name.includes(":")) continue;
    const candidates = searchDirs.map(dir => join(dir, name, "SKILL.md"));
    let loaded = false;
    // Names are directory names, never paths supplied by a persona.
    if (name && name !== "." && name !== ".." && !/[\\/]/.test(name)) {
      for (const candidate of candidates) {
        try {
          const { data, body } = readFrontmatter(await readFile(candidate, "utf-8"));
          skills.push({ name, path: resolve(candidate), body, ...metadataDescription(data) });
          loaded = true;
          break;
        } catch {
          // Try the next location before warning.
        }
      }
    }
    if (!loaded) {
      console.error(`[Agents] Skill "${name}" not found or unreadable. Add ${name}/SKILL.md to one of the searched directories: ${searchDirs.map(dir => resolve(dir)).join(", ")}.`);
    }
  }
  return skills;
}

function capSkillText(text: string, max: number): string {
  const note = "\n…[truncated]";
  return text.length <= max ? text : text.slice(0, max - note.length) + note;
}

export function renderSkillsSection(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const sections = skills.map((skill) => capSkillText(
    `### Skill: ${skill.name}\n\n${skill.description ? skill.description + "\n\n" : ""}${skill.body}`,
    12_000
  ));
  return capSkillText("\n\n## Skills\n\n" + sections.join("\n\n"), 40_000);
}

function skillNames(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((name) => name.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function metadataDescription(data: Record<string, unknown>): { description?: string } {
  return typeof data.description === "string" ? { description: data.description } : {};
}

// ----------------------------------------------------------------------------
// Persona loading and discovery
// ----------------------------------------------------------------------------

export interface LoadedAgent {
  ref: string;
  key: string;
  path: string;
  raw: string;
  body: string;
  frontmatter: Record<string, unknown>;
  skills: LoadedSkill[];
}

export async function loadAgent(ref: string): Promise<LoadedAgent> {
  const candidates = [
    ref,
    join(AGENTS_DIR, `${ref}.md`),
    join(AGENTS_DIR, `subagent-${ref}.md`),
    join(AGENTS_DIR, ref, "AGENT.md"),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (isFile(resolved)) {
      const raw = await readFile(resolved, "utf-8");
      const { data: frontmatter, body } = readFrontmatter(raw);
      const skills = await loadSkills(skillNames(frontmatter.skills), skillSearchDirs(resolved));
      return { ref, key: agentKey(resolved), path: resolved, raw, body, frontmatter, skills };
    }
  }

  throw new Error(
    `Agent prompt not found for "${ref}". Searched:\n${candidates.map((c) => `  - ${resolve(c)}`).join("\n")}`
  );
}

export async function loadAgentPrompt(agent: string): Promise<string> {
  const result = await loadAgentPromptWithPath(agent);
  return result.content;
}

export async function loadAgentPromptWithPath(agent: string): Promise<{ path: string; content: string }> {
  const loaded = await loadAgent(agent);
  return { path: loaded.path, content: loaded.body + renderSkillsSection(loaded.skills) };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function directoryEntries(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

export function listAgents(agentsDir: string = AGENTS_DIR): Array<{ key: string; name?: string; description?: string; path: string }> {
  const agents: Array<{ key: string; name?: string; description?: string; path: string }> = [];
  for (const entry of directoryEntries(agentsDir)) {
    const candidate = resolve(agentsDir, entry);
    const path = /\.md$/i.test(entry) && isFile(candidate) ? candidate : join(candidate, "AGENT.md");
    if (!isFile(path)) continue;
    try {
      const { data } = readFrontmatter(readFileSync(path, "utf-8"));
      agents.push({ key: agentKey(path), path, ...((typeof data.name === "string" || typeof data.name === "number") && String(data.name).trim() && { name: String(data.name).trim() }), ...metadataDescription(data) });
    } catch (e) {
      console.error(`[Agents] Cannot read agent "${entry}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return agents;
}

export function listSkills(
  dirs: string | readonly string[] = skillSearchDirs(),
): Array<{ name: string; description?: string; path: string }> {
  const skills: Array<{ name: string; description?: string; path: string }> = [];
  const seen = new Set<string>();
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    for (const name of directoryEntries(dir)) {
      if (seen.has(name)) continue;
      const path = resolve(dir, name, "SKILL.md");
      if (!isFile(path)) continue;
      try {
        const { data } = readFrontmatter(readFileSync(path, "utf-8"));
        skills.push({ name, path, ...metadataDescription(data) });
        seen.add(name);
      } catch (e) {
        console.error(`[Agents] Cannot read skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return skills;
}
