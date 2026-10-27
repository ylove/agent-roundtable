import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { validatePath, type PrototypeFile } from "../prototypes/parse.js";
import { isDuelId } from "../sessions/duel-import.js";
import type { ChosenArtifact } from "./events.js";
import { DUEL_MAX_BYTES } from "./prompts.js";

function privateTree(root: string, parts: string[]): string {
  mkdirPrivate(root);
  for (const part of parts) { root = join(root, part); mkdirPrivate(root); }
  return root;
}
export function saveChosenArtifact(id: string, team: "A" | "B", version: number, files: PrototypeFile[]): ChosenArtifact {
  if (!isDuelId(id)) throw new Error("Invalid duel id.");
  for (const file of files) if (validatePath(file.path)) throw new Error("Invalid chosen artifact path.");
  const dir = `duels/${id}/chosen`;
  const root = privateTree(ROUNDTABLE_HOME, ["duels", id, "chosen"]);
  for (const file of files) {
    const parts = file.path.split("/");
    const parent = privateTree(root, parts.slice(0, -1));
    writeFileAtomic(join(parent, parts.at(-1)!), file.content, 0o600);
  }
  return { team, version, dir, files: files.map(f => f.path) };
}

/** Read-only preflight; the check is repeated when exporting after the duel. */
export function validateDuelOutputDir(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length) throw new Error("--out requires a nonexistent path or an empty real directory; symlinks and overwrites are refused.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Publish a complete private tree atomically. A nonempty directory or a symlink cannot be replaced by this directory rename. */
export function exportChosenArtifact(chosen: ChosenArtifact, path: string): void {
  if (validatePath(chosen.dir) || chosen.files.some(p => validatePath(p))) throw new Error("Invalid chosen artifact path.");
  const source = chosen.dir.split("/").reduce((parent, segment) => {
    const next = join(parent, segment), stat = lstatSync(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Chosen artifact directory is not a real directory.");
    return next;
  }, ROUNDTABLE_HOME);
  const files = chosen.files.map(name => {
    let parent = source;
    for (const segment of name.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid chosen artifact directory.");
    }
    const fd = openSync(join(source, name), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > DUEL_MAX_BYTES) throw new Error("Invalid chosen artifact file.");
      return { path: name, content: readFileSync(fd) };
    } finally { closeSync(fd); }
  });
  if (files.reduce((n, f) => n + f.content.length, 0) > DUEL_MAX_BYTES) throw new Error("Chosen artifact exceeds 40 KB.");
  const dest = resolve(path);
  validateDuelOutputDir(dest);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(dest), ".roundtable-export-"));
  try {
    for (const file of files) {
      const parent = privateTree(staging, file.path.split("/").slice(0, -1));
      writeFileAtomic(join(parent, file.path.split("/").at(-1)!), file.content, 0o600);
    }
    validateDuelOutputDir(dest);
    // On this filesystem rename replaces only an empty directory, and refuses files,
    // symlinks, and directories populated since the last check.
    renameSync(staging, dest);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
