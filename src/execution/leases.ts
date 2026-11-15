// ============================================================================
// Lease engine: path globs, overlap, conflicts and the FIFO queue (pure)
//
// A lease is a set of repository-relative globs one task may write. Globs support ** (any number
// of whole segments; a trailing /** needs at least one), * (any run of characters inside one
// segment, never crossing /) and ? (one character inside a segment). There are no braces and no
// character classes: [ and ] are literal. A glob ending in / means everything below it (dir/**).
//
// Nothing here reads the disk or appends events: decisions are computed from the blackboard state
// and returned as drafts, which the caller appends inside store.transact (so they are decided
// against fresh state, under the events lock).
//
// Git metadata (any path segment starting with ".git": .gitattributes, .gitmodules, .gitignore,
// .github/…) is covered only by a lease that names that segment literally, so a broad lease such
// as ** never lets a task change how git treats files or what CI runs. A ".git" segment itself is
// never covered.
// ============================================================================

import { globWithin } from "./contract.js";
import { newId } from "../ids.js";
import { normalizeRelPath } from "../security/fs-safe.js";
import { ID_RE, preview } from "./events.js";
import { taskBranch } from "./git.js";
import type {
  AnyEventDraft,
  BlackboardState,
  EventDraft,
  EventSource,
  Lease,
  LeaseMode,
  LeaseRequest,
  TaskState,
} from "./types.js";

// ============================================================================
// Globs
// ============================================================================

const WILDCARD_RE = /[*?]/;

/** A normalized glob, or null when it is not one (absolute, "..", NUL, braces, empty). */
export function normalizeGlob(glob: string): string | null {
  if (typeof glob !== "string" || /[{}]/.test(glob)) return null;
  const rel = normalizeRelPath(glob);
  if (rel === null) return null;
  return /[/\\]$/.test(glob) && !rel.endsWith("**") ? `${rel}/**` : rel;
}

/** One segment against a pattern of literal characters, * and ?. */
function segmentMatch(pat: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && (pat[p] === "?" || (pat[p] !== "*" && pat[p] === s[i]))) {
      p++;
      i++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p++;
      mark = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

function segmentsMatch(pat: string[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === pat.length) r = j === path.length;
    else if (pat[i] === "**") {
      if (i === pat.length - 1) r = j < path.length;
      else {
        r = false;
        for (let k = j; k <= path.length && !r; k++) r = go(i + 1, k);
      }
    } else r = j < path.length && segmentMatch(pat[i], path[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** True when `glob` matches the repository-relative `path` exactly (see the header for the syntax). */
export function matchGlob(glob: string, path: string): boolean {
  const g = normalizeGlob(glob);
  const p = normalizeRelPath(path);
  if (g === null || p === null) return false;
  return segmentsMatch(g.split("/"), p.split("/"));
}

/** The leading whole segments without a wildcard ("" when the first segment has one). */
export function staticPrefix(glob: string): string {
  const g = normalizeGlob(glob) ?? "";
  const out: string[] = [];
  for (const seg of g.split("/")) {
    if (!seg || WILDCARD_RE.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

/** a is b, or a whole-segment ancestor of b ("" is everyone's ancestor). */
function segmentPrefix(a: string, b: string): boolean {
  return a === "" || a === b || b.startsWith(`${a}/`);
}

/**
 * A name as a case-insensitive, normalization-insensitive filesystem (macOS by default) may see
 * it: NFC, then case folded through upper and lower case (so "ß" and "ss" fold together). Used
 * only for overlap, where folding can merely add false positives.
 */
function foldName(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Whether two globs may match a common path, on any filesystem. Conservative: they overlap when
 * one static prefix is a whole-segment prefix of the other, compared case-insensitively and
 * Unicode-normalized (SRC/** and src/** name the same files on macOS). That never misses a real
 * overlap, but it reports some that cannot happen (src/*.ts and src/*.css overlap; src/a.ts and
 * src/b.ts do not), so leases may queue unnecessarily, never collide silently. An invalid glob
 * overlaps everything. Coverage (pathCovered) stays exact: a path git reports in another case
 * is simply not covered, which fails closed.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (normalizeGlob(a) === null || normalizeGlob(b) === null) return true;
  const pa = foldName(staticPrefix(a));
  const pb = foldName(staticPrefix(b));
  return segmentPrefix(pa, pb) || segmentPrefix(pb, pa);
}

// ============================================================================
// Coverage
// ============================================================================

/** Anything with lease paths: Lease, LeaseRequest, or { paths } built from a task spec. */
export type LeaseLike = { readonly paths: readonly string[]; readonly excludes?: readonly string[] };

const isGitMeta = (seg: string) => /^\.git/i.test(seg);

/** True when a path has a segment starting with ".git" (metadata that needs an explicit lease). */
export function isGitMetadataPath(path: string): boolean {
  return (normalizeRelPath(path) ?? path).split("/").some(isGitMeta);
}

/** True when some segment is ".git" itself: never committable. */
export function hasDotGitSegment(path: string): boolean {
  return (normalizeRelPath(path) ?? path).split("/").some((s) => s.toLowerCase() === ".git");
}

/** A lease glob covers a metadata path only when it names each .git* segment literally. */
function explicitlyNames(glob: string, metaSegments: string[]): boolean {
  const segs = (normalizeGlob(glob) ?? "").toLowerCase().split("/");
  return metaSegments.every((m) => segs.includes(m.toLowerCase()));
}

/**
 * True when some lease covers `path`. A path with a ".git" segment is never covered; a path with
 * a .git* segment is covered only by a glob that names that segment literally.
 */
export function pathCovered(path: string, leases: readonly LeaseLike[]): boolean {
  const p = normalizeRelPath(path);
  if (p === null) return false;
  const segs = p.split("/");
  if (segs.some((s) => s.toLowerCase() === ".git")) return false;
  const meta = segs.filter(isGitMeta);
  for (const l of leases) {
    if (l.excludes?.some((g) => matchGlob(g, p))) continue;
    for (const g of l.paths) {
      if (matchGlob(g, p) && (!meta.length || explicitlyNames(g, meta))) return true;
    }
  }
  return false;
}

/** The paths no lease covers, in order, without duplicates. */
export function uncoveredPaths(paths: readonly string[], leases: readonly LeaseLike[]): string[] {
  return [...new Set(paths.filter((p) => !pathCovered(p, leases)))];
}

// ============================================================================
// Conflicts
// ============================================================================

type Holder = Pick<Lease, "agent" | "task" | "paths" | "mode">;

/**
 * Exclusive conflicts with everything that overlaps; shared conflicts only with an overlapping
 * exclusive one. The same agent on the same task never conflicts with itself.
 */
export function leasesConflict(a: Holder, b: Holder, state?: Readonly<BlackboardState>): boolean {
  if (state?.tasks[a.task]?.spec.parent === b.task || state?.tasks[b.task]?.spec.parent === a.task) return false;
  if (a.agent === b.agent && a.task === b.task) return false;
  if (a.mode === "shared" && b.mode === "shared") return false;
  return a.paths.some((p) => b.paths.some((q) => globsOverlap(p, q)));
}

// ============================================================================
// Event drafts
// ============================================================================

/** The longest prefix of `list` whose JSON fits in `maxBytes`, with a "…(+N more)" marker when cut. */
export function capPathList(list: readonly string[], maxBytes = 6000): string[] {
  const out: string[] = [];
  let bytes = 2;
  for (const p of list) {
    const b = Buffer.byteLength(JSON.stringify(p)) + 1;
    if (bytes + b > maxBytes - 32) {
      out.push(`…(+${list.length - out.length} more)`);
      return out;
    }
    out.push(p);
    bytes += b;
  }
  return out;
}

/** Builders for the lease.* events; the caller supplies the source and appends them in transact. */
export const leaseDrafts = {
  granted: (lease: Lease, source: EventSource): EventDraft<"lease.granted"> => ({
    type: "lease.granted",
    source,
    payload: { lease: { ...lease, paths: [...lease.paths] } },
  }),
  queued: (request: LeaseRequest, source: EventSource): EventDraft<"lease.queued"> => ({
    type: "lease.queued",
    source,
    payload: { request: { ...request, paths: [...request.paths], blocking: [...request.blocking] } },
  }),
  /** Also withdraws a queued request with this id. */
  released: (leaseId: string, source: EventSource): EventDraft<"lease.released"> => ({
    type: "lease.released",
    source,
    payload: { lease_id: leaseId },
  }),
  expired: (leaseId: string, source: EventSource): EventDraft<"lease.expired"> => ({
    type: "lease.expired",
    source,
    payload: { lease_id: leaseId },
  }),
  revoked: (leaseId: string, by: string, reason: string, source: EventSource): EventDraft<"lease.revoked"> => ({
    type: "lease.revoked",
    source,
    payload: { lease_id: leaseId, by, reason },
  }),
  /** `paths` is capped to fit the payload limit. */
  violation: (task: string, agent: string, paths: readonly string[], source: EventSource): EventDraft<"lease.violation"> => ({
    type: "lease.violation",
    source,
    payload: { task, agent, paths: capPathList(paths) },
  }),
};

// ============================================================================
// Requests, grants and releases
// ============================================================================

export interface LeaseRequestInput {
  /** Defaults to a fresh lease-… id; a granted request keeps its id as the lease id. */
  id?: string;
  agent: string;
  task: string;
  paths: readonly string[];
  /** Default exclusive. */
  mode?: LeaseMode;
  reason?: string;
}

export interface LeaseHolder {
  /** The blocking lease (or queued request) id. */
  lease: string;
  agent: string;
  task: string;
  /** The holder task's reported progress, when it has one. */
  percent?: number;
  paths: string[];
  mode: LeaseMode;
  /** True when the blocker is an earlier request still waiting in the queue (FIFO). */
  queued: boolean;
}

export type LeaseDecision =
  | { grant: Lease; /** An identical live lease of this agent and task already existed. */ existing?: true }
  | { queue: LeaseRequest; holders: LeaseHolder[] };

const MAX_LEASE_PATHS = 64;
const TERMINAL: ReadonlySet<TaskState> = new Set(["accepted", "failed", "cancelled"]);

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Normalized, de-duplicated lease globs; throws on anything that is not a valid write glob. */
export function normalizeLeasePaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("A lease needs at least one path");
  if (paths.length > MAX_LEASE_PATHS) throw new Error(`A lease may name at most ${MAX_LEASE_PATHS} paths`);
  const out: string[] = [];
  for (const p of paths) {
    const g = normalizeGlob(p);
    if (g === null) throw new Error(`Not a valid lease path: ${preview(p)} (relative globs with **, * and ?; no "..", braces or absolute paths)`);
    if (hasDotGitSegment(g)) throw new Error(`Lease path ${preview(p)} names .git, which is never writable`);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

function leaseFromRequest(executionId: string, r: Pick<LeaseRequest, "id" | "agent" | "task" | "paths" | "mode" | "reason">): Lease {
  return {
    id: r.id,
    agent: r.agent,
    task: r.task,
    paths: [...r.paths],
    mode: r.mode,
    branch: taskBranch(executionId, r.task),
    reason: r.reason,
    granted_seq: 0,
  };
}

/**
 * Decide a lease request against the live leases and the queue. It is granted when nothing live
 * and no earlier queued request conflicts with it (so a stream of compatible requests cannot
 * starve a waiting one); otherwise it is queued, blocked by those ids, and `holders` names who
 * holds them and how far along their tasks are. Append leaseDrafts.granted or .queued with the result.
 */
export function decideLeaseRequest(state: Readonly<BlackboardState>, request: LeaseRequestInput): LeaseDecision {
  const agent = request.agent;
  if (typeof agent !== "string" || !agent.trim()) throw new Error("A lease request needs an agent");
  if (typeof request.task !== "string" || !ID_RE.test(request.task)) throw new Error(`Not a task id: ${preview(request.task)}`);
  const mode: LeaseMode = request.mode ?? "exclusive";
  if (mode !== "exclusive" && mode !== "shared") throw new Error(`Lease mode must be exclusive or shared, not ${preview(mode)}`);
  const paths = normalizeLeasePaths(request.paths);
  const spec = state.tasks[request.task]?.spec;
  if (spec?.parent && paths.some((p) => !spec.paths.write.some((g) => globWithin(p, g)))) throw new Error("A subtask may lease only its delegated paths");
  if (Object.values(state.tasks).some((rt) => rt.spec.parent === request.task && !TERMINAL.has(rt.state) && paths.some((p) => rt.spec.paths.write.some((g) => globsOverlap(p, g))))) throw new Error("Those paths are delegated to open subtasks; await_subtasks before writing them");
  const reason = typeof request.reason === "string" ? request.reason : "";
  const id = request.id ?? newId("lease");
  if (typeof id !== "string" || !id.trim()) throw new Error("Lease ids must be non-empty strings");
  const me = { agent, task: request.task, paths, mode };

  for (const l of Object.values(state.leases)) {
    if (l.agent === agent && l.task === request.task && (l.mode === "exclusive" || mode === "shared") && paths.every((p) => l.paths.includes(p))) {
      return { grant: { ...l, paths: [...l.paths] }, existing: true };
    }
  }

  const holders: LeaseHolder[] = [];
  const percent = (task: string) => own(state.tasks, task)?.percent;
  for (const l of Object.values(state.leases)) {
    if (l.id !== id && leasesConflict(me, l, state)) {
      holders.push({ lease: l.id, agent: l.agent, task: l.task, percent: percent(l.task), paths: [...l.paths], mode: l.mode, queued: false });
    }
  }
  for (const r of state.lease_queue) {
    if (r.id !== id && leasesConflict(me, r, state)) {
      holders.push({ lease: r.id, agent: r.agent, task: r.task, percent: percent(r.task), paths: [...r.paths], mode: r.mode, queued: true });
    }
  }
  for (const h of holders) if (h.percent === undefined) delete h.percent;

  if (!holders.length) return { grant: leaseFromRequest(state.execution, { id, agent, task: request.task, paths, mode, reason }) };
  return {
    queue: { id, agent, task: request.task, paths, mode, reason, requested_seq: 0, blocking: holders.map((h) => h.lease) },
    holders,
  };
}

export interface NextGrantOptions {
  /** Lease and request ids to treat as gone (released earlier in the same transaction). */
  gone?: Iterable<string>;
}

/**
 * Grants for queued requests that nothing blocks any more, in queue order (FIFO): a request is
 * granted only when no live lease and no earlier still-waiting request conflicts with it. Requests
 * of finished tasks (accepted, failed or cancelled) are withdrawn instead.
 */
export function nextGrants(state: Readonly<BlackboardState>, source: EventSource, opts: NextGrantOptions = {}): AnyEventDraft[] {
  const gone = new Set(opts.gone ?? []);
  const live: Holder[] = Object.values(state.leases).filter((l) => !gone.has(l.id));
  const waiting: LeaseRequest[] = [];
  const drafts: AnyEventDraft[] = [];
  for (const r of state.lease_queue) {
    if (gone.has(r.id)) continue;
    const rt = own(state.tasks, r.task);
    if (rt && TERMINAL.has(rt.state)) {
      drafts.push(leaseDrafts.released(r.id, source));
      continue;
    }
    if (live.some((l) => leasesConflict(r, l, state)) || waiting.some((w) => leasesConflict(r, w, state))) {
      waiting.push(r);
      continue;
    }
    const lease = leaseFromRequest(state.execution, r);
    live.push(lease);
    drafts.push(leaseDrafts.granted(lease, source));
  }
  return drafts;
}

export interface ReleaseFilter {
  agent?: string;
  task?: string;
  ids?: readonly string[];
}

export interface ReleaseOptions {
  /** Which event ends the matching leases (default released). Queued requests are always withdrawn with lease.released. */
  kind?: "released" | "expired" | "revoked";
  /** For revoked: who revoked (default source.id) and why. */
  by?: string;
  reason?: string;
  /** Also grant the queue heads this unblocks (default true). */
  grantNext?: boolean;
}

/**
 * End every live lease matching the filter (all given fields must match), withdraw matching
 * queued requests, then (by default) grant what that unblocks. An empty filter is refused.
 */
export function releaseLeases(
  state: Readonly<BlackboardState>,
  filter: ReleaseFilter,
  source: EventSource,
  opts: ReleaseOptions = {}
): AnyEventDraft[] {
  if (filter.agent === undefined && filter.task === undefined && filter.ids === undefined) {
    throw new Error("releaseLeases needs an agent, a task or lease ids");
  }
  const match = (x: { id: string; agent: string; task: string }) =>
    (filter.ids === undefined || filter.ids.includes(x.id)) &&
    (filter.agent === undefined || x.agent === filter.agent) &&
    (filter.task === undefined || x.task === filter.task);
  const kind = opts.kind ?? "released";
  const drafts: AnyEventDraft[] = [];
  const gone: string[] = [];
  for (const l of Object.values(state.leases)) {
    if (!match(l)) continue;
    gone.push(l.id);
    if (kind === "expired") drafts.push(leaseDrafts.expired(l.id, source));
    else if (kind === "revoked") drafts.push(leaseDrafts.revoked(l.id, opts.by ?? source.id, opts.reason ?? "revoked", source));
    else drafts.push(leaseDrafts.released(l.id, source));
  }
  for (const r of state.lease_queue) {
    if (match(r) && !gone.includes(r.id)) {
      gone.push(r.id);
      drafts.push(leaseDrafts.released(r.id, source));
    }
  }
  if (opts.grantNext !== false && gone.length) drafts.push(...nextGrants(state, source, { gone }));
  return drafts;
}

/** The live leases of a task (optionally of one agent on it). */
export function leasesFor(state: Readonly<BlackboardState>, task: string, agent?: string): Lease[] {
  const excludes = Object.values(state.tasks)
    .filter((rt) => rt.spec.parent === task && !TERMINAL.has(rt.state))
    .flatMap((rt) => rt.spec.paths.write);
  return Object.values(state.leases).filter((l) => l.task === task && (agent === undefined || l.agent === agent))
    .map((l) => excludes.length ? { ...l, excludes } : l);
}
