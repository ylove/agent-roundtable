import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";

const DAY_MS = 86_400_000;
/** Remove casting archives older than the session retention window; returns the file names removed. */
export function pruneCastingArchives(retentionDays: number, now = Date.now(), dir = join(ROUNDTABLE_HOME, "casting")): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (!/^cast-[\w-]+\.json$/.test(name) && name !== "latest.json") continue;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile() || now - stat.mtimeMs <= retentionDays * DAY_MS) continue;
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch { /* Leave anything unreadable. */ }
  }
  return removed;
}
