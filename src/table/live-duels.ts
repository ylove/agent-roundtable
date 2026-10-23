/** Duels and casting calls running in this process, so the usage view can list them and a stop can reach them. */
export interface LiveDuel { id: string; kind?: "duel" | "casting"; agents: string[]; started: string; stopped?: { by: string; at: string; reason?: string } }
const live = new Map<string, LiveDuel>();
export const registerDuel = (duel: LiveDuel): void => void live.set(duel.id, duel);
export const unregisterDuel = (id: string): void => void live.delete(id);
export const liveDuels = (): LiveDuel[] => [...live.values()];
