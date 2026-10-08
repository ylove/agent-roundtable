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
  return readFrontmatter(text).body;
}

/** Recognize the same fences as stripFrontmatter; invalid YAML still has its fences stripped. */
export function readFrontmatter(text: string): { data: Record<string, unknown>; body: string; hasFrontmatter: boolean } {
  const unchanged = { data: {}, body: text, hasFrontmatter: false };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return unchanged;
  let sawKey = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      if (!sawKey) return unchanged;
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = parse(lines.slice(1, i).join("\n"), { logLevel: "error" });
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        // Keep the persona usable even if its metadata needs repair.
      }
      return { data, body: lines.slice(next).join("\n"), hasFrontmatter: true };
    }
    if (/^[A-Za-z_][\w-]*\s*:/.test(lines[i])) sawKey = true;
  }
  return unchanged;
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

export async function loadSkills(names: string[], skillsDir: string = SKILLS_DIR): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  for (const ref of names) {
    const name = ref.trim();
    if (name.includes(":")) continue;
    const candidates = [join(skillsDir, name, "SKILL.md"), join(homedir(), ".claude", "skills", name, "SKILL.md")];
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
          // Try the user-level fallback before warning.
        }
      }
    }
    if (!loaded) console.error(`[Agents] Skill "${name}" not found or unreadable. Add ${name}/SKILL.md to the skills directory.`);
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
      const skills = await loadSkills(skillNames(frontmatter.skills));
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
      agents.push({ key: agentKey(path), path, ...(typeof data.name === "string" && { name: data.name }), ...metadataDescription(data) });
    } catch (e) {
      console.error(`[Agents] Cannot read agent "${entry}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return agents;
}

export function listSkills(skillsDir: string = SKILLS_DIR): Array<{ name: string; description?: string; path: string }> {
  const skills: Array<{ name: string; description?: string; path: string }> = [];
  for (const name of directoryEntries(skillsDir)) {
    const path = resolve(skillsDir, name, "SKILL.md");
    if (!isFile(path)) continue;
    try {
      const { data } = readFrontmatter(readFileSync(path, "utf-8"));
      skills.push({ name, path, ...metadataDescription(data) });
    } catch (e) {
      console.error(`[Agents] Cannot read skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return skills;
}
