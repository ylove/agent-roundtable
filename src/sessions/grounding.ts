// ============================================================================
// Private conversation context: project, agent memory, and recent activity
// ============================================================================

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LoadedAgent } from "../agents.js";
import { recentActivityFor } from "../activity.js";
import { WORKSPACE_DIR } from "../config.js";
import { truncate } from "./workshop.js";

export interface Grounding {
  text: string;
  sources: Array<"workspace" | "memory" | "activity">;
}

interface GroundingOptions {
  workspaceDir?: string;
  homeDir?: string;
  activityPath?: string | null;
}

const snapshots = new Map<string, { at: number; text: string | undefined }>();

// truncate() adds a marker beyond its requested length; enforce the packet's hard caps here.
function capped(text: string, max: number): string {
  return truncate(text, max).slice(0, max);
}

/** Read only a bounded prefix, with one extra byte to detect truncation. */
export function readHead(path: string, maxBytes = 64 * 1024): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    return { text: buffer.subarray(0, Math.min(count, maxBytes)).toString("utf-8"), truncated: count > maxBytes };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readText(path: string): string | undefined {
  const text = readHead(path)?.text;
  return text?.trim() ? text : undefined;
}

// ----------------------------------------------------------------------------
// Workspace snapshot (synchronous API, cached for 60 seconds)
// ----------------------------------------------------------------------------

export function workspaceSnapshot(dir: string = WORKSPACE_DIR): string | undefined {
  const root = resolve(dir);
  const cached = snapshots.get(root);
  if (cached && Date.now() - cached.at < 60_000) return cached.text;
  const parts: string[] = [];
  try {
    const head = readHead(join(root, "package.json"));
    const pkg = head && !head.truncated ? JSON.parse(head.text) : undefined;
    const fields = ["name", "description"].flatMap((key) =>
      typeof pkg?.[key] === "string" && pkg[key].trim() ? [`${key}: ${pkg[key]}`] : []);
    if (fields.length) parts.push(fields.join("\n"));
  } catch {
    // Missing or malformed package metadata does not hide the other project context.
  }
  const instructions = readText(join(root, "CLAUDE.md")) ?? readText(join(root, "AGENTS.md"));
  if (instructions) parts.push("Project instructions:\n" + capped(instructions, 2500));
  const readme = readText(join(root, "README.md"));
  if (readme) parts.push("README:\n" + capped(readme, 2500));
  for (const [label, args] of [
    ["Git branch", ["branch", "--show-current"]],
    ["Recent commits", ["log", "-12", "--format=%s (%cr)"]],
  ] as const) {
    try {
      const output = execFileSync("git", ["-C", root, ...args], {
        timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (output) parts.push(`${label}:\n${output}`);
    } catch {
      // Non-git workspaces and failed git commands are ordinary missing context.
    }
  }
  const text = parts.join("\n\n") || undefined;
  snapshots.set(root, { at: Date.now(), text });
  return text;
}

// ----------------------------------------------------------------------------
// Agent-specific memory and session history
// ----------------------------------------------------------------------------

export function agentMemory(
  key: string,
  frontmatterName?: string,
  opts: { workspaceDir?: string; homeDir?: string } = {}
): string | undefined {
  const slug = frontmatterName?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const names = [...new Set([key, frontmatterName, slug])].filter((name): name is string =>
    !!name && name !== "." && name !== ".." && !/[\\/]/.test(name));
  const workspace = opts.workspaceDir ?? WORKSPACE_DIR;
  const scopes = [
    join(workspace, ".claude", "agent-memory"),
    join(workspace, ".claude", "agent-memory-local"),
    join(opts.homeDir ?? homedir(), ".claude", "agent-memory"),
  ];
  const excerpts: string[] = [];
  const paths = new Set<string>();
  for (const scope of [...new Set(scopes)]) {
    for (const name of names) {
      let path: string;
      try {
        path = fs.realpathSync.native(join(scope, name, "MEMORY.md"));
      } catch {
        continue;
      }
      if (paths.has(path)) continue;
      paths.add(path);
      const text = readText(path);
      const excerpt = text?.split(/\r?\n/).slice(0, 200).join("\n");
      if (excerpt?.trim()) {
        const bounded = capped(excerpt, 3000);
        if (!excerpts.includes(bounded)) excerpts.push(bounded);
      }
    }
  }
  return excerpts.join("\n\n") || undefined;
}

export function recentActivityText(key: string, opts: { activityPath?: string | null } = {}): string | undefined {
  const lines = recentActivityFor(key, 5, opts.activityPath).map((entry) => {
    const others = entry.agents.filter((agent) => agent !== key);
    return `- ${entry.at.slice(0, 10)} ${entry.kind}${entry.mode ? ` (${entry.mode})` : ""}` +
      ` with ${others.join(", ") || "no other agents"} on "${entry.topic}"` +
      (entry.outcome ? ` — ${entry.outcome}` : "");
  });
  return lines.join("\n") || undefined;
}

export async function buildGrounding(
  agent: LoadedAgent | { key: string; frontmatter?: Record<string, unknown> },
  opts: GroundingOptions = {}
): Promise<Grounding> {
  const name = agent.frontmatter?.name;
  const sections: Array<[Grounding["sources"][number], string, string | undefined]> = [
    ["workspace", "The project you work on", workspaceSnapshot(opts.workspaceDir)],
    ["memory", "Your notes (agent memory)", agentMemory(agent.key, typeof name === "string" ? name : undefined, opts)],
    ["activity", "Your recent roundtable sessions", recentActivityText(agent.key, opts)],
  ];
  let text = "";
  const sources: Grounding["sources"] = [];
  for (const [source, title, content] of sections) {
    if (!content) continue;
    const prefix = text ? "" : "## Your context\n\nThis is background you already know. Bring it up naturally; don't dump or quote it.\n";
    const heading = `\n### ${title}\n\n`;
    const room = 8000 - text.length - prefix.length - heading.length;
    if (room <= 0) break;
    text += prefix + heading + capped(content, room);
    sources.push(source);
  }
  return { text, sources };
}
