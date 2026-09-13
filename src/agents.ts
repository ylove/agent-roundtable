// ============================================================================
// Agent Loading
// ============================================================================

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS_DIR } from "./config.js";

/**
 * Strip a leading YAML frontmatter block ("---" ... "---") from an agent prompt file.
 * Rule: if the text (after an optional BOM) starts with "---" as its first line and a later line
 * matches /^---\s*$/ (CRLF tolerant), drop everything through that closing line plus any blank
 * lines that follow it. Otherwise the text is returned unchanged.
 */
export function stripFrontmatter(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return text;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      return lines.slice(next).join("\n");
    }
  }
  return text;
}

export async function loadAgentPrompt(agent: string): Promise<string> {
  const result = await loadAgentPromptWithPath(agent);
  return result.content;
}

export async function loadAgentPromptWithPath(agent: string): Promise<{ path: string; content: string }> {
  const candidates = [
    agent,
    join(AGENTS_DIR, `${agent}.md`),
    join(AGENTS_DIR, `subagent-${agent}.md`),
    join(AGENTS_DIR, agent, "AGENT.md"),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      const content = await readFile(resolved, "utf-8");
      return { path: resolved, content: stripFrontmatter(content) };
    }
  }

  throw new Error(
    `Agent prompt not found for "${agent}". Searched:\n${candidates.map((c) => `  - ${resolve(c)}`).join("\n")}`
  );
}
