// ============================================================================
// Live duels: in-process control plus a private registry for the local index
// ============================================================================

import { registerLiveSessionSource } from "../usage/live-limit.js";
import { setCapObserver, sessionCapView, clearSessionCap } from "../usage/session-caps.js";
import { scrub } from "../security/secrets.js";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { ID_RE } from "../execution/events.js";
import { processReused, processStart } from "../execution/lock.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";

/** Duels and casting calls running in this process, so the usage view can list them and a stop can reach them. */
export interface LiveDuel { id: string; kind?: "duel" | "casting"; agents: string[]; started: string; maxUsd?: number; spentUsd?: number; reached?: boolean; stopped?: { by: string; at: string; reason?: string } }
const live = new Map<string, LiveDuel>();
registerLiveSessionSource("duels", () => live.keys());
const registry = join(ROUNDTABLE_HOME, "live-duels");
export const registerDuel = (duel: LiveDuel): void => {
  Object.assign(duel, sessionCapView(duel.id));
  duel.agents = duel.agents.map(a => scrub(a));
  live.set(duel.id, duel);
  setCapObserver(duel.id, () => registerDuel(duel));
  if (!ID_RE.test(duel.id)) return;
  try {
    mkdirPrivate(registry);
    writeFileAtomic(join(registry, `${duel.id}.json`), JSON.stringify({ ...duel, pid: process.pid, host: hostname(), processStarted: processStart(process.pid) }));
  } catch { console.error("[Duels] cannot update live registry"); }
};
export const unregisterDuel = (id: string): void => {
  live.delete(id);
  clearSessionCap(id);
  if (ID_RE.test(id)) try { rmSync(join(registry, `${id}.json`), { force: true }); } catch { /* best effort */ }
};
export const liveDuels = (): LiveDuel[] => [...live.values()];

/** Read-only cross-process listing; dead local entries are omitted. */
export function persistedLiveDuels(home = ROUNDTABLE_HOME): Array<LiveDuel & { host: string }> {
  const registry = join(home, "live-duels");
  const out: Array<LiveDuel & { host: string }> = [];
  let names: string[];
  try { names = readdirSync(registry); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json") || !ID_RE.test(name.slice(0, -5))) continue;
    try {
      const d = JSON.parse(readFileSync(join(registry, name), "utf8"));
      if (d.id !== name.slice(0, -5) || typeof d.host !== "string" || typeof d.started !== "string" || !Array.isArray(d.agents)) continue;
      if (d.host === hostname() && (!Number.isSafeInteger(d.pid) || d.pid <= 1 || !pidAlive(d.pid) || processReused(d.pid, typeof d.processStarted === "string" ? d.processStarted : undefined))) continue;
      out.push({ id: d.id, ...(d.kind === "casting" && { kind: "casting" as const }),
        agents: d.agents.filter((a: unknown): a is string => typeof a === "string").map((a: string) => scrub(a)), started: scrub(d.started), host: scrub(d.host),
        ...(typeof d.maxUsd === "number" && Number.isFinite(d.maxUsd) && d.maxUsd > 0 && typeof d.spentUsd === "number" && Number.isFinite(d.spentUsd) && d.spentUsd >= 0 && { maxUsd: d.maxUsd, spentUsd: d.spentUsd, reached: d.reached === true }) });
    } catch { /* interrupted or unreadable */ }
  }
  return out;
}
