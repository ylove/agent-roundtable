// ============================================================================
// Agent Loading
// ============================================================================

import { readFile } from "node:fs/promises";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { AGENTS_DIR, SKILLS_DIR, WORKSPACE_DIR, agentPaths } from "./config.js";
import { isContained } from "./security/fs-safe.js";

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

/** Resolve every directory and symlink hop before reading skill text. Roots' parents are trusted. */
function containedSkillPath(candidate: string, dirs: readonly string[]): string {
  const roots = dirs.flatMap(dir => {
    try {
      // A repository cannot replace its entire skill root with an outside directory link.
      if (lstatSync(dir).isSymbolicLink()) return [];
      return [realpathSync.native(dir)];
    } catch { return []; }
  });
  let hops = 0;
  const secretName = (path: string) => /^(?:\.env.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?)$/i.test(basename(path));
  const walk = (path: string): string => {
    const root = roots.find(root => isContained(root, path));
    if (!root) throw new Error("Skill path escapes approved roots");
    let current = root;
    const parts = relative(root, path).split(sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (secretName(current)) throw new Error("Refusing secret-shaped skill target");
      const st = lstatSync(current); // also rejects dangling/cyclic intermediate paths
      if (st.isSymbolicLink()) {
        if (++hops > 40) throw new Error("Skill symlink chain exceeds 40 hops");
        const target = walk(resolve(dirname(current), readlinkSync(current)));
        return walk(join(target, ...parts.slice(i + 1)));
      }
    }
    return current;
  };
  // Canonicalize only the trusted parents, never the candidate's unvalidated directories.
  const dir = dirs.find(dir => isContained(resolve(dir), resolve(candidate)));
  if (!dir || lstatSync(dir).isSymbolicLink()) throw new Error("Unapproved skill root");
  const real = realpathSync.native(walk(join(realpathSync.native(dir), relative(resolve(dir), resolve(candidate)))));
  if (!roots.some(root => isContained(root, real)) || secretName(real)) throw new Error("Unapproved skill target");
  if (!statSync(real).isFile()) throw new Error("Skill is not a file");
  return real;
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
          const path = containedSkillPath(candidate, searchDirs);
          const { data, body } = readFrontmatter(await readFile(path, "utf-8"));
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

/** A ref with a path separator, or ending in .md, names a file; anything else is an agent name. */
export function isPathLikeRef(ref: string): boolean {
  return /[\\/]/.test(ref) || /\.md$/i.test(ref);
}

/**
 * Where a path-like ref may point: the agents directory, the workspace's and the user's
 * .claude/agents, and every directory in ROUNDTABLE_AGENT_PATHS.
 */
export function allowedAgentRoots(): string[] {
  const discovered = (dir: string, parent: string): string[] => {
    const location = (path: string): string => {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return join(location(dirname(path)), basename(path));
      }
      return realpathSync.native(path);
    };
    try {
      try { if (lstatSync(dir).isSymbolicLink()) return []; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return []; }
      if (!isContained(location(resolve(parent)), location(resolve(dir)))) return [];
      return [dir];
    } catch { return []; }
  };
  return [...new Set([
    ...(process.env.ROUNDTABLE_AGENTS_DIR ? [AGENTS_DIR] : discovered(AGENTS_DIR, process.cwd())),
    ...discovered(join(WORKSPACE_DIR, ".claude", "agents"), WORKSPACE_DIR),
    ...discovered(join(homedir(), ".claude", "agents"), homedir()),
    ...agentPaths(),
  ].map((dir) => resolve(dir)))];
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * Resolve a path-like ref, or throw. It must end in .md, sit (lexically) inside an allowed root
 * before anything is read, and its realpath must be inside a root's realpath (no symlink escapes).
 * Returns null when it is allowed but does not exist.
 */
function containedAgentPath(ref: string, r: AgentRoots): string | null {
  if (!/\.md$/i.test(ref)) throw refuseRef(ref, "is a path but not a .md file", r);
  const resolved = resolve(ref);
  if (![...r.roots, ...r.realRoots].some((root) => isContained(root, resolved))) {
    throw refuseRef(ref, "is outside the allowed agent directories", r);
  }
  if (!isFile(resolved)) return null;
  assertRealpathContained(ref, resolved, r);
  return resolved;
}

interface AgentRoots {
  roots: string[];
  realRoots: string[];
}

function agentRoots(): AgentRoots {
  const roots = allowedAgentRoots();
  return { roots, realRoots: roots.map(realpathOrNull).filter((root): root is string => root !== null) };
}

function refuseRef(ref: string, why: string, { roots }: AgentRoots): Error {
  return new Error(
    `Agent ref "${ref}" ${why}. Agent files must be .md files inside one of: ${roots.join(", ")}. ` +
      `Add directories to ROUNDTABLE_AGENT_PATHS (separated by "${delimiter}") to allow more.`,
  );
}

/** The file's realpath must be inside a root's realpath: a symlink may not lead out of the roots. */
function assertRealpathContained(ref: string, file: string, r: AgentRoots): void {
  const real = realpathOrNull(file);
  if (!real || !r.realRoots.some((root) => isContained(root, real))) {
    throw refuseRef(ref, "resolves (through a symlink) outside the allowed agent directories", r);
  }
}

export async function loadAgent(ref: string): Promise<LoadedAgent> {
  const r = agentRoots();
  let candidates: string[];
  if (isPathLikeRef(ref)) {
    const contained = containedAgentPath(ref, r);
    candidates = contained ? [contained] : [resolve(ref)];
  } else {
    // Agent names are looked up only inside the agents directory.
    candidates = ref === "." || ref === ".." ? [] : [
      join(AGENTS_DIR, `${ref}.md`),
      join(AGENTS_DIR, `subagent-${ref}.md`),
      join(AGENTS_DIR, ref, "AGENT.md"),
    ];
  }

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (isFile(resolved)) {
      // A name finds a file in the agents directory, but a symlink there may not lead out of the roots.
      assertRealpathContained(ref, resolved, r);
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
  const r = agentRoots();
  const root = resolve(agentsDir);
  // An explicit discovery directory is trusted; automatic locations use the shared root policy.
  const automatic = [AGENTS_DIR, join(WORKSPACE_DIR, ".claude", "agents"), join(homedir(), ".claude", "agents")]
    .some(dir => resolve(dir) === root);
  if (!r.roots.includes(root)) {
    if (automatic) return agents;
    const real = realpathOrNull(root);
    if (!real) return agents;
    r.roots.push(root);
    r.realRoots.push(real);
  }
  for (const entry of directoryEntries(agentsDir)) {
    const candidate = resolve(agentsDir, entry);
    const path = /\.md$/i.test(entry) && isFile(candidate) ? candidate : join(candidate, "AGENT.md");
    if (!isFile(path)) continue;
    try { assertRealpathContained(path, path, r); }
    catch { continue; }
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
        const safe = containedSkillPath(path, typeof dirs === "string" ? [dirs] : dirs);
        const { data } = readFrontmatter(readFileSync(safe, "utf-8"));
        skills.push({ name, path, ...metadataDescription(data) });
        seen.add(name);
      } catch (e) {
        console.error(`[Agents] Cannot read skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return skills;
}
