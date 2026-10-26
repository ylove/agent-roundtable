// ============================================================================
// Live duels: in-process control plus a private registry for the local index
// ============================================================================

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { ID_RE } from "../execution/events.js";
import { processReused, processStart } from "../execution/lock.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";

/** Duels and casting calls running in this process, so the usage view can list them and a stop can reach them. */
export interface LiveDuel { id: string; kind?: "duel" | "casting"; agents: string[]; started: string; stopped?: { by: string; at: string; reason?: string } }
const live = new Map<string, LiveDuel>();
const registry = join(ROUNDTABLE_HOME, "live-duels");
export const registerDuel = (duel: LiveDuel): void => {
  live.set(duel.id, duel);
  if (!ID_RE.test(duel.id)) return;
  try {
    mkdirPrivate(registry);
    writeFileAtomic(join(registry, `${duel.id}.json`), JSON.stringify({ ...duel, pid: process.pid, host: hostname(), processStarted: processStart(process.pid) }));
  } catch { console.error("[Duels] cannot update live registry"); }
};
export const unregisterDuel = (id: string): void => {
  live.delete(id);
  if (ID_RE.test(id)) try { rmSync(join(registry, `${id}.json`), { force: true }); } catch { /* best effort */ }
};
export const liveDuels = (): LiveDuel[] => [...live.values()];

/** Read-only cross-process listing; dead local entries are omitted. */
export function persistedLiveDuels(): Array<LiveDuel & { host: string }> {
  const out: Array<LiveDuel & { host: string }> = [];
  let names: string[];
  try { names = readdirSync(registry); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json") || !ID_RE.test(name.slice(0, -5))) continue;
    try {
      const d = JSON.parse(readFileSync(join(registry, name), "utf8"));
      if (d.id !== name.slice(0, -5) || typeof d.host !== "string" || typeof d.started !== "string" || !Array.isArray(d.agents)) continue;
      if (d.host === hostname() && (!Number.isSafeInteger(d.pid) || d.pid <= 1 || !pidAlive(d.pid) || processReused(d.pid, typeof d.processStarted === "string" ? d.processStarted : undefined))) continue;
      out.push(d);
    } catch { /* interrupted or unreadable */ }
  }
  return out;
}
