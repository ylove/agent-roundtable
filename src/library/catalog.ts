import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { listAgents, readFrontmatter } from "../agents.js";
import { AGENTS_DIR, LIBRARY_DIR } from "../config.js";

export interface LibraryAgent {
  key: string;
  name?: string;
  description?: string;
  source: "agents-dir" | "library";
  file: string;
  model?: string;
  provider?: string;
  tools: string[];
  skills: string[];
  warnings: string[];
  shadowed?: true;
}

export function metadataNames(value: unknown): string[] {
  const values = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return values.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(Boolean);
}

/** Imports keep the requested tools and model; the human sees what those choices mean. */
export function agentWarnings(data: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const tools = metadataNames(data.tools).filter(tool => !["Read", "Grep", "Glob"].includes(tool));
  if (tools.length) warnings.push(`requests ${tools.join(", ")}: a heads-down worker using this persona gets them`);
  if (typeof data.model === "string" && /-\d{8}$/.test(data.model)) {
    warnings.push("dated model pin may be unavailable; falls back to the provider default");
  }
  if (typeof data.description !== "string" || !data.description.trim()) {
    warnings.push("no description: Casting Call and the library show a blank role");
  }
  return warnings;
}

/** Discovery shares the loader's realpath policy. Public entries never contain full paths. */
export function listLibrary(): LibraryAgent[] {
  const entries: LibraryAgent[] = [];
  const configured = new Set<string>();
  for (const [dir, source] of [[AGENTS_DIR, "agents-dir"], [LIBRARY_DIR, "library"]] as const) {
    for (const agent of listAgents(dir)) {
      try {
        const { data } = readFrontmatter(readFileSync(agent.path, "utf8"));
        entries.push({
          key: agent.key, ...(agent.name && { name: agent.name }),
          ...(agent.description !== undefined && { description: agent.description }),
          source, file: basename(agent.path),
          ...(typeof data.model === "string" && { model: data.model }),
          ...(typeof data.provider === "string" && { provider: data.provider }),
          tools: metadataNames(data.tools), skills: metadataNames(data.skills), warnings: agentWarnings(data),
          ...(source === "library" && configured.has(agent.key) && { shadowed: true as const }),
        });
        if (source === "agents-dir") configured.add(agent.key);
      } catch { /* An agent removed during discovery is omitted. */ }
    }
  }
  return entries;
}
