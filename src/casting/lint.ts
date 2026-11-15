import { scrubAndCap } from "../security/secrets.js";
import type { LoadedAgent } from "../agents.js";

export interface LintIssue { level: "warn" | "info"; code: string; message: string }

/** Local prompt checks; no provider or skill calls. */
export function lintAgent(agent: LoadedAgent, agents: LoadedAgent[] = [agent]): LintIssue[] {
  const issues: LintIssue[] = [];
  const warn = (code: string, message: string) => issues.push({ level: "warn", code, message: scrubAndCap(message, 1000) });
  if (typeof agent.frontmatter.description !== "string" || !agent.frontmatter.description.trim()) warn("no-description", "No description.");
  const words = agent.body.trim().split(/\s+/).filter(Boolean).length;
  if (!words) warn("empty-body", "Empty persona body.");
  else if (words < 40) warn("short-body", `Very short persona body (${words} words; fewer than 40).`);
  const tools = agent.frontmatter.tools;
  const names = typeof tools === "string" ? tools.split(/[\s,]+/).filter(Boolean) : Array.isArray(tools) ? tools.map(String) : [];
  const beyond = names.filter(tool => !["Read", "Grep", "Glob"].includes(tool));
  if (beyond.length) warn("broad-tools", `Tools beyond Read, Grep, Glob: ${beyond.join(", ")}.`);
  if (typeof agent.frontmatter.model === "string" && /-\d{8}$/.test(agent.frontmatter.model.trim())) {
    issues.push({ level: "info", code: "dated-model", message: "Dated model pin; check availability." });
  }
  const name = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name.trim().toLowerCase() : agent.key;
  if (agents.filter(other => (typeof other.frontmatter.name === "string" ? other.frontmatter.name.trim().toLowerCase() : other.key) === name).length > 1) warn("duplicate-name", "Duplicate name across the persona set.");
  return issues;
}
