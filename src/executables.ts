// ============================================================================
// Executable lookup on PATH (no shell, no `which`)
// ============================================================================

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** A regular file this process may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of the first of `names` found on PATH, or null. Each name is tried in every
 * directory before the next name. Names are bare program names; anything containing a slash is skipped.
 */
export function findExecutable(names: string | readonly string[], searchPath: string = process.env.PATH || ""): string | null {
  const dirs = searchPath.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const name of typeof names === "string" ? [names] : names) {
    if (!name || /[\\/]/.test(name)) continue;
    for (const d of dirs) {
      for (const e of exts) {
        const p = join(d, name + e);
        if (isExecutableFile(p)) return p;
      }
    }
  }
  return null;
}
