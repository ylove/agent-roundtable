import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUNDTABLE_HOME } from "../config.js";
import { scrub } from "../security/secrets.js";
import type { Contract } from "../execution/types.js";

/** A duel id is `duel-<uuid>`: letters, digits and hyphens only, so no path or traversal can pass. */
export const DUEL_ID_RE = /^duel-[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const CLAIM_MAX = 500;
const PREDICTION_MAX = 500;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const clean = (v: string, max: number): string => {
  const t = scrub(v).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export const isDuelId = (id: unknown): id is string => typeof id === "string" && DUEL_ID_RE.test(id);

/** The winning artifact's facts: metadata only, never its source. */
export interface DuelArtifact {
  title: string;
  kind?: string;
  team: "A" | "B";
  brief: string;
  files: Array<{ path: string; bytes?: number }>;
  /** Persona refs of the winning team's seats, builders first. */
  members: string[];
  approvals: string[];
  /** The judges' REVISE and REJECT reasons for the winning team. */
  fixes: string[];
}

export interface DuelImport {
  id: string;
  topic: string;
  /** Persona names of the seats in the archive (teams and judges), for the participant list. */
  agents: string[];
  winner: "A" | "B" | "tie" | "none";
  /** The winning team's decision; absent for a tie, none, an aborted duel or a missing artifact. */
  decision?: Contract["decisions"][number];
  dissents: Contract["dissents"];
  /** What a drafted plan is built from; present only with a decision (a winner with an archived artifact). */
  artifact?: DuelArtifact;
  /** Machine-readable summary placed in the propose result. */
  summary: { id: string; winner: string; imported_decision: boolean; artifact_title?: string; artifact_kind?: string; team?: string; dissents: number; note?: string };
}

/** Read `ROUNDTABLE_HOME/duels/<id>.json`: a regular file of at most 10 MB, never followed through a link. */
function readDuelFile(id: string): string {
  const path = join(ROUNDTABLE_HOME, "duels", `${id}.json`);
  let fd: number | undefined;
  try {
    // O_NOFOLLOW refuses a symlink at the final component; fstat then confirms a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_ARCHIVE_BYTES) throw new Error("larger than 10 MB");
    return readFileSync(fd, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`from_session duel not found or unreadable: ${id}${code === "ENOENT" ? "" : ` (${e instanceof Error ? e.message : String(e)})`}`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Load a duel archive by id and shape what propose_contract imports from it. Tolerates archives that lack
 * newer optional fields (kind, criteria, teams). Artifact source is never read: only the title is used.
 */
export function importDuel(id: string): DuelImport {
  if (!isDuelId(id)) throw new Error("from_session is not a valid duel id: expected duel-<id> with letters, digits and hyphens only");
  let archive: unknown;
  try { archive = JSON.parse(readDuelFile(id)); } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`from_session duel archive is malformed: ${id}`);
    throw e;
  }
  const events = isObj(archive) && Array.isArray(archive.events) ? archive.events.filter(isObj) : undefined;
  if (!events) throw new Error(`from_session duel archive is malformed: ${id}`);

  const start = events.find((e) => e.type === "start");
  const seats = (Array.isArray(start?.seats) ? start.seats : []).filter(isObj);
  // The persona ref is the seat id without its "<A|B|judge>:" prefix; the display name is frontmatter and may not resolve.
  const refOf = (s: unknown): string | undefined => {
    const id = isObj(s) ? str(s.id) : undefined;
    const ref = id ? id.replace(/^(?:A|B|judge):/, "") : isObj(s) ? str(s.name) : undefined;
    return ref ? clean(ref, 80) || undefined : undefined;
  };
  const labelOf = (s: unknown): string | undefined => (isObj(s) ? clean(str(s.name) ?? "", 80) || refOf(s) : undefined);
  const nameOf = refOf;
  const agents = [...new Set(seats.map(nameOf).filter((n): n is string => !!n))];
  const topic = clean(str(start?.topic) ?? "", 2000);
  const end = [...events].reverse().find((e) => e.type === "end");
  const winner: DuelImport["winner"] = end?.winner === "A" || end?.winner === "B" || end?.winner === "tie" ? end.winner : "none";

  // Dissents: archived text is "<claim>\nPredicted failure: <prediction>", written by the duel runner.
  const seen = new Set<string>();
  const dissents: Contract["dissents"] = [];
  for (const e of events) {
    if (e.type !== "dissent") continue;
    const by = nameOf(e.seat);
    const text = str(e.text);
    if (!by || !text) continue;
    const [head, ...rest] = text.split(/\r?\n\s*Predicted failure:\s*/i);
    const claim = clean(head, CLAIM_MAX);
    const prediction = clean(rest.join(" "), PREDICTION_MAX) || claim;
    if (!claim) continue;
    const key = `${by}\0${claim}\0${prediction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dissents.push({ id: `duel-dissent-${dissents.length + 1}`, by, source: { kind: "duel", ref: id }, claim, predicted_failure: prediction, on_fire: "huddle" });
  }

  const base = { id, topic, agents, winner, dissents };
  const dissentCount = dissents.length;
  if (winner === "tie" || winner === "none" || end?.aborted === true) {
    const note = winner === "tie"
      ? "The duel ended in a tie: no decision was imported. The orchestrator must decide which approach to build."
      : "The duel has no winner (none, or it was stopped): no decision was imported. The orchestrator must decide which approach to build.";
    return { ...base, summary: { id, winner, imported_decision: false, dissents: dissentCount, note } };
  }

  const proto = [...events].reverse().find((e) => e.type === "prototype" && e.team === winner && e.ok !== false);
  const title = clean(str(proto?.title) ?? "", 120);
  const kind = clean(str(proto?.kind) ?? str(start?.kind) ?? (isObj(archive) ? str(archive.kind) : undefined) ?? "", 60);
  const members = seats.filter((s) => s.team === winner).map(labelOf).filter((n): n is string => !!n);
  const approvals = [...new Set(events
    .filter((e) => e.type === "assessment" && e.team === winner && e.verdict === "APPROVE")
    .map((e) => clean(str(e.reason) ?? "", 240)).filter(Boolean))];
  const files = (Array.isArray(proto?.files) ? proto.files : []).filter(isObj)
    .map((f) => ({ path: clean(str(f.path) ?? "", 120), ...(typeof f.bytes === "number" && { bytes: f.bytes }) })).filter((f) => f.path).slice(0, 20);
  const memberRefs = [...seats.filter((s) => s.team === winner)].sort((a, b) => Number(b.role === "builder") - Number(a.role === "builder"))
    .map(refOf).filter((n): n is string => !!n);
  const fixes = [...new Set(events
    .filter((e) => e.type === "assessment" && e.team === winner && (e.verdict === "REVISE" || e.verdict === "REJECT"))
    .map((e) => clean(str(e.reason) ?? "", 240)).filter(Boolean))];
  if (!title) {
    return { ...base, summary: { id, winner, imported_decision: false, dissents: dissentCount, note: `Team ${winner} won but archived no artifact: no decision was imported. The orchestrator must decide.` } };
  }
  const text = `Build on the winning duel artifact "${title}"${kind ? ` (kind: ${kind})` : ""} from team ${winner}${members.length ? ` (${members.join(", ")})` : ""}, duel ${id}. Artifact source is not part of the contract.`;
  const rationale = approvals.length ? `Why it won, from the judges' APPROVE reasons: ${approvals.join(" ")}`.slice(0, 900) : `Won duel ${id} on the judges' tally.`;
  return {
    ...base,
    decision: { id: "duel-winner", scope: "contract", text, rationale, by: `duel:${id}` },
    artifact: { title, ...(kind && { kind }), team: winner, brief: topic, files, members: memberRefs, approvals, fixes },
    summary: { id, winner, imported_decision: true, artifact_title: title, ...(kind && { artifact_kind: kind }), team: winner, dissents: dissentCount },
  };
}


/**
 * A deterministic task plan (a roundtable-tasks object, no model call) from the winning artifact, the judges'
 * reasons and the imported dissents. Tasks run in sequence on one persona pair so none writes in parallel.
 * Artifact source is never included: each task's context names the duel archive and the file list.
 */
export function draftDuelPlan(duel: DuelImport, personas: { build: string; review: string }): Record<string, unknown> | undefined {
  const a = duel.artifact;
  if (!a) return undefined;
  const fileList = a.files.length ? a.files.map((f) => `${f.path}${f.bytes !== undefined ? ` (${f.bytes} bytes)` : ""}`).join(", ") : "(no files archived)";
  const context = [{
    kind: "text", title: `Winning duel artifact "${a.title}"`,
    ref: `Duel ${duel.id}, team ${a.team}${a.kind ? `, kind ${a.kind}` : ""}. Files: ${fileList}. The source is in the archive ROUNDTABLE_HOME/duels/${duel.id}.json under "prototypes" (replay it with: roundtable duel --replay <archive> --open); it is not part of this contract.`,
  }];
  const write = ["**"];
  const tasks: Array<Record<string, unknown>> = [];
  const add = (id: string, title: string, persona: string, acceptance: string[]) => {
    tasks.push({ id, title: title.slice(0, 200), persona, depends_on: tasks.length ? [tasks.at(-1)!.id] : [], paths: { write }, acceptance: acceptance.map((x) => x.slice(0, 500)), checks: ["test"], context });
  };
  add("duel-build", `Build "${a.title}" from the winning duel artifact`.concat(a.kind ? ` (${a.kind})` : ""), personas.build, [
    `The repository contains a working version of "${a.title}", rebuilt from the archived artifact files in duel ${duel.id}`,
    `It meets the brief: ${a.brief || duel.topic}`.slice(0, 500),
    ...a.approvals.map((x) => `Keep what the judges approved: ${x}`),
  ]);
  for (const [i, fix] of a.fixes.entries()) add(`duel-fix-${i + 1}`, `Address judge feedback ${i + 1}: ${fix}`, personas.build, [`The judges' point is resolved in the code: ${fix}`]);
  add("duel-tests", `Add tests and acceptance checks for "${a.title}"`, personas.review, [
    "Automated tests cover the main flow of the artifact and every fix above",
    "The test command passes",
  ]);
  if (duel.dissents.length) {
    add("duel-risks", "Handle the dissents filed in the duel", personas.review, duel.dissents.map((d) => `Risk "${d.claim}" is handled or deliberately excused (predicted failure: ${d.predicted_failure})`.slice(0, 500)));
  }
  return { tasks, commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 300 }] };
}
