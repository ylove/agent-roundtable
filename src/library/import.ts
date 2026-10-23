import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { stringify } from "yaml";
import { assertReadableFrontmatter, readFrontmatter } from "../agents.js";
import { assertFrontmatterRoundTrip, slugify } from "../agent-files.js";
import { LIBRARY_DIR } from "../config.js";
import { agentWarnings } from "./catalog.js";

export const MAX_AGENT_BYTES = 128 * 1024;
export const MAX_IMPORT_FILES = 200;
export interface ImportResult {
  key?: string;
  status: "imported" | "exists" | "refused";
  warnings: string[];
  error?: string;
}
export interface PathImportResult extends ImportResult { filename: string }

const refused = (error: string): ImportResult => ({ status: "refused", warnings: [], error });
const promptKeys = ["prompt", "instructions", "system_prompt", "body"];
const jsonKeys = new Set(["name", "description", "model", "provider", "tools", "skills", ...promptKeys]);
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|agent|subagent|constructor|prototype)$/;

/** Persona bytes are inert. Only a bounded slug determines the exclusive-create destination. */
export function importAgent(
  input: { filename: string; content: string },
  { dir = LIBRARY_DIR }: { dir?: string } = {},
): ImportResult {
  if (!input || typeof input.filename !== "string" || typeof input.content !== "string") return refused("Each file needs a filename and string content.");
  const { filename } = input;
  if (!filename || /[\\/\x00]/.test(filename) || filename === "." || filename === "..") return refused("The filename must be a basename, not a path.");
  if (Buffer.byteLength(input.content, "utf8") > MAX_AGENT_BYTES) return refused("Agent files must be at most 128 KiB.");
  const extension = extname(filename).toLowerCase();
  let content = input.content;
  let data: Record<string, unknown>;
  let body: string;
  if (extension === ".json") {
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { return refused("Invalid agent JSON."); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refused("Agent JSON must be an object.");
    const object = raw as Record<string, unknown>;
    if (Object.keys(object).some(key => !jsonKeys.has(key))) return refused("Unknown key in agent JSON.");
    if (typeof object.name !== "string" || !object.name.trim()) return refused("Agent JSON needs a name.");
    const prompts = promptKeys.filter(key => Object.hasOwn(object, key));
    if (prompts.length !== 1 || typeof object[prompts[0]] !== "string" || !(object[prompts[0]] as string).trim()) {
      return refused("Agent JSON needs exactly one non-empty string prompt: prompt, instructions, system_prompt or body.");
    }
    data = {};
    for (const key of ["name", "description", "model", "provider", "tools", "skills"]) {
      if (!Object.hasOwn(object, key)) continue;
      const value = object[key];
      const names = key === "tools" || key === "skills";
      if (typeof value !== "string" && !(names && Array.isArray(value) && value.every(v => typeof v === "string"))) {
        return refused(`Agent JSON ${key} must be ${names ? "a string or an array of strings" : "a string"}.`);
      }
      data[key] = value;
    }
    body = object[prompts[0]] as string;
    content = `---\n${stringify(data, { lineWidth: 0 })}---\n\n${body.trim()}\n`;
    try { assertFrontmatterRoundTrip(content, data); }
    catch { return refused("Agent frontmatter cannot round-trip safely."); }
  } else if (extension === ".md") {
    const frontmatter = readFrontmatter(content);
    try { assertReadableFrontmatter(frontmatter, filename); }
    catch { return refused("Agent frontmatter is unreadable or ambiguous; fix it before importing."); }
    data = frontmatter.data;
    body = frontmatter.body;
    if (Object.hasOwn(data, "name") && typeof data.name !== "string") return refused("Agent name must be a string.");
  } else return refused("Agent files must end in .md or .json.");
  if (!body.trim()) return refused("Agent prompt must not be empty.");
  const key = slugify(typeof data.name === "string" ? data.name : filename.slice(0, -extension.length));
  if (!key || reserved.test(key)) return refused("Agent name is empty or reserved.");
  if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) return refused("Agent files must be at most 128 KiB.");
  const warnings = agentWarnings(data);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) return { key, ...refused("The library must be a directory, not a symlink.") };
    writeFileSync(join(dir, `${key}.md`), content, { flag: "wx", mode: 0o600 });
    return { key, status: "imported", warnings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { key, status: "exists", warnings };
    return { key, status: "refused", warnings, error: "The agent could not be written." };
  }
}

/** A hard cap also applies when a file grows between stat and read. Never follow a file symlink. */
function readAgentFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Agent input must be a regular file.");
    if (stat.size > MAX_AGENT_BYTES) throw new Error("Agent files must be at most 128 KiB.");
    const buffer = Buffer.alloc(MAX_AGENT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_AGENT_BYTES) throw new Error("Agent files must be at most 128 KiB.");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/** One folder level, plus directory-style personas; no recursive traversal or symlinks. */
export function importAgentPath(absPath: string): PathImportResult[] {
  const results: PathImportResult[] = [];
  if (!isAbsolute(absPath)) return [{ filename: basename(absPath), ...refused("Import requires an absolute file or directory.") }];
  try {
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink()) return [];
    const files: Array<{ path: string; filename: string }> = [];
    if (stat.isFile()) files.push({ path: absPath, filename: basename(absPath) });
    else if (stat.isDirectory()) {
      for (const entry of readdirSync(absPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile() && /\.(?:md|json)$/i.test(entry.name)) files.push({ path: join(absPath, entry.name), filename: entry.name });
        else if (entry.isDirectory()) {
          const path = join(absPath, entry.name, "AGENT.md");
          try { if (lstatSync(path).isFile()) files.push({ path, filename: `${entry.name}.md` }); }
          catch { /* No directory-style persona. */ }
        }
        if (files.length > MAX_IMPORT_FILES) break;
      }
    } else return [{ filename: basename(absPath), ...refused("Agent input must be a regular file or directory.") }];
    for (const file of files.slice(0, MAX_IMPORT_FILES)) {
      try { results.push({ filename: file.filename, ...importAgent({ filename: file.filename, content: readAgentFile(file.path) }) }); }
      catch (error) {
        results.push({ filename: file.filename, ...refused(error instanceof Error && /^(Agent input|Agent files)/.test(error.message) ? error.message : "The agent file could not be read.") });
      }
    }
    if (files.length > MAX_IMPORT_FILES) results.push({ filename: basename(absPath), ...refused("Import accepts at most 200 files at a time.") });
    return results;
  } catch { return [{ filename: basename(absPath), ...refused("The import path could not be read.") }]; }
}
