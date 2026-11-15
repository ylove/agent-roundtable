import type { LoadedAgent } from "../agents.js";

export interface Redundancy { keys: string[]; reason: string }
const STOP = new Set("a an and are as at be been but by can do for from has have how i if in into is it its may not of on or our own should that the their them there these they this to use was we what when which who will with would you your".split(" "));
const tokens = (agent: LoadedAgent): Set<string> => new Set(
  `${typeof agent.frontmatter.description === "string" ? agent.frontmatter.description : ""} ${agent.body.split(/\s+/).filter(Boolean).slice(0, 400).join(" ")}`
    .toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(word => !STOP.has(word)) ?? [],
);

/** Connected overlap pairs become one cluster, retaining input order. */
export function findSimilarity(agents: LoadedAgent[]): Redundancy[] {
  const sets = agents.map(tokens);
  const parent = agents.map((_, i) => i);
  const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]));
  const pairs: { a: number; b: number; score: number }[] = [];
  for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
    const common = [...sets[a]].filter(word => sets[b].has(word)).length;
    const union = sets[a].size + sets[b].size - common;
    const score = union ? common / union : 0;
    if (score >= 0.45) { parent[root(b)] = root(a); pairs.push({ a, b, score }); }
  }
  const clusters = new Map<number, number[]>();
  agents.forEach((_, i) => { const key = root(i); clusters.set(key, [...(clusters.get(key) ?? []), i]); });
  return [...clusters.values()].filter(ids => ids.length > 1).map(ids => ({
    keys: ids.map(i => agents[i].key),
    reason: `similar descriptions (${Math.max(...pairs.filter(pair => ids.includes(pair.a) && ids.includes(pair.b)).map(pair => pair.score)).toFixed(2)})`,
  }));
}
