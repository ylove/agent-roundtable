import { agentKey } from "../agents.js";
import type { DuelOptions } from "./events.js";
import { DUEL_KINDS, MAX_CRITERIA } from "./prompts.js";

export const MAX_TEAM_SIZE = 4;
export const MAX_JUDGES = 5;
/** The caller's mistakes, caught before any provider call. Throws a plain, secret-free Error. */
export function validateDuelOptions(opts: Omit<DuelOptions, "judges"> & { judges?: string[] }): void {
  if (!opts.topic?.trim() || !opts.teamA?.length || !opts.teamB?.length || (!opts.humanJudge && !opts.judges?.length)) throw new Error("A duel needs a topic, two teams, and judges.");
  for (const [label, team] of [["Team A", opts.teamA], ["Team B", opts.teamB]] as const) {
    if (team.length > MAX_TEAM_SIZE) throw new Error(`${label} has ${team.length} members; a team may have 1 to ${MAX_TEAM_SIZE}.`);
  }
  if ((opts.judges?.length ?? 0) > MAX_JUDGES) throw new Error(`A duel has 1 to ${MAX_JUDGES} judges.`);
  const keys = [...opts.teamA, ...opts.teamB, ...(opts.judges ?? [])].map(ref => agentKey(ref));
  if (keys.some(key => !key)) throw new Error("Persona names must not be empty.");
  const dup = keys.find((key, i) => keys.indexOf(key) !== i);
  if (dup) throw new Error(`Persona "${dup}" appears more than once; each persona holds one seat across both teams and the judges.`);
  if (opts.kind !== undefined && !DUEL_KINDS.includes(opts.kind)) throw new Error(`kind must be one of ${DUEL_KINDS.join(", ")}.`);
  if (opts.stages !== undefined && (!Number.isInteger(opts.stages) || opts.stages < 1 || opts.stages > 4)) throw new Error("stages must be an integer from 1 to 4.");
  if (opts.connectors !== undefined && (!Array.isArray(opts.connectors) || opts.connectors.some(c => typeof c !== "string"))) throw new Error("connectors must be a list of connector names.");
  if (opts.seatConnectors !== undefined && (typeof opts.seatConnectors !== "object" || opts.seatConnectors === null || Array.isArray(opts.seatConnectors))) throw new Error("seat_connectors must map seat names to connector names.");
  if (opts.criteria !== undefined) {
    if (!Array.isArray(opts.criteria) || opts.criteria.some(c => typeof c !== "string" || !c.trim())) throw new Error("criteria must be a list of non-empty strings.");
    if (opts.criteria.length > MAX_CRITERIA) throw new Error(`Use at most ${MAX_CRITERIA} criteria.`);
  }
}

