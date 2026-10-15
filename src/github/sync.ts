// ============================================================================
// GitHub Projects/Issues sync for one heads-down run
//
// The runner calls syncOnce() in its own loop. Each call reads the events since its cursor and
// mirrors the run onto GitHub, through the hardened gh runner (gh.ts):
//
//   execution.started         a parent issue (contract summary), then one issue per task carrying
//                             <!-- roundtable:<exe>:<task> -->, linked as sub-issues (addSubIssue,
//                             GraphQL) and added to the project (gh project item-add)
//   task state changes        the project's Status field (Todo / In Progress / Done, or a
//                             "Roundtable Status" field it creates), coalesced: only the latest
//                             state of each task is written
//   task.failed / cancelled   a comment (the status is Done)
//   escalation.awaiting_human a comment and the needs-human label (removed when it is resolved)
//   task.progress             at most one comment per task per 10 minutes (the latest note)
//   execution.completed       a comment on the parent linking the PR, then every issue closed
//
// State lives in executions/<exe>/github.json (atomic): the cursor, issue numbers and node ids,
// project ids and an outbox of comments, labels and closes. Idempotency: an issue is recorded the
// moment gh reports it created, and a fresh or lost github.json is rebuilt from a search for the
// body markers before anything is created. Comments carry an event marker, so a rebuilt sync (or a
// post that timed out) does not repeat them. Markers are public, so only issues and comments
// authored by the gh account the sync runs as (GraphQL viewer), and issues labelled roundtable,
// are trusted: a stranger's issue or comment carrying a copied marker is ignored.
//
// Limits: 20 creates and 60 other calls per minute (token buckets); a rate-limit answer backs
// off 60 s plus jitter. syncOnce never throws: failures go into its report, which turns
// degraded after three failing rounds in a row. Everything posted is redacted (secrets and
// personal data); diffs, command output and blobs are never read, let alone posted.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openExecutionStore } from "../execution/store.js";
import type { AnyEvent, BlackboardState, ExecutionStore, TaskState } from "../execution/types.js";
import { redact } from "../publishers/redact.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { GhError, ghGraphql, isOwnerName, isRepoName, parseGhJson, runGh, withBodyFile, type GhRunner } from "./gh.js";

export interface GitHubSyncOptions {
  executionId: string;
  /** "owner/name" */
  repo: string;
  /** Project owner login (default: the repository owner). */
  projectOwner?: string;
  projectNumber?: number;
  /** Create a project when no projectNumber is given. */
  createProject?: boolean;
  /** The run opens a pull request at the end (the runner does that); the sync links it when the completion names one. */
  pr?: boolean;
  /** The store to read (default: openExecutionStore(executionId)). */
  store?: ExecutionStore;
  /** How gh is called (default: runGh). */
  gh?: GhRunner;
  /** Clock and jitter source (tests). */
  now?: () => number;
  random?: () => number;
}

export interface SyncReport {
  /** This round finished without a failure (rate-limit deferrals are not failures). */
  ok: boolean;
  /** Three or more failing rounds in a row: GitHub is not being kept up to date. */
  degraded: boolean;
  /** Seq of the last event processed. */
  cursor: number;
  /** Events read this round. */
  processed: number;
  /** gh calls made this round. */
  calls: number;
  /** Issues (and a project or field) created this round. */
  created: number;
  /** Status field edits this round. */
  updated: number;
  comments: number;
  closed: number;
  /** Work left for later rounds: issues to create or link, statuses, outbox items, notes. */
  pending: number;
  /** A bucket ran dry or GitHub asked to slow down; the rest waits for a later round. */
  rateLimited: boolean;
  backoffUntil?: string;
  /** Redacted, capped messages of this round's failures. */
  errors: string[];
}

type StatusKey = "todo" | "in_progress" | "done";

interface IssueRef {
  number: number;
  url: string;
  /** Node id (GraphQL); fetched after the create, so missing until then. */
  id?: string;
  /** Project item id, once added. */
  item?: string;
  /** Linked to the parent as a sub-issue. */
  sub?: boolean;
  /** Last status written to the project. */
  status?: StatusKey;
  closed?: boolean;
}

type OutboxItem =
  | { kind: "comment"; target: string; body: string; marker: string; seq: number; attempts: number; check?: boolean }
  | { kind: "label" | "unlabel"; target: string; label: string; attempts: number }
  | { kind: "close_all"; pr_url?: string; attempts: number }
  | { kind: "close"; target: string; reason: "completed" | "not planned"; comment: string; attempts: number };

interface SyncFile {
  schema: 1;
  execution: string;
  repo: string;
  cursor: number;
  started: boolean;
  completed: boolean;
  labels_ready: boolean;
  project?: { owner: string; number: number; id: string; field?: { id: string; name: string; options: Record<StatusKey, string> } };
  /** By key: PARENT or a task id. */
  issues: Record<string, IssueRef>;
  /** Keys whose create was started but not recorded (a crash in between): ms timestamps. */
  creating: Record<string, number>;
  outbox: OutboxItem[];
  notes: Record<string, { last_at?: number; pending?: { text: string; seq: number; check?: boolean } }>;
  /** Escalation id → issue key flagged needs-human for it. */
  flagged: Record<string, string>;
  /** Comments from events up to this seq may already be on GitHub (the mapping was rebuilt). */
  recover_seq: number;
  backoff_until?: number;
  failed_rounds: number;
}

const PARENT = "@parent";
const ROUNDTABLE_LABEL = "roundtable";
const NEEDS_HUMAN_LABEL = "needs-human";
const LABELS: Record<string, { color: string; description: string }> = {
  [ROUNDTABLE_LABEL]: { color: "5319e7", description: "Mirrored from an agent-roundtable heads-down run" },
  [NEEDS_HUMAN_LABEL]: { color: "d93f0b", description: "The roundtable run is waiting for a human decision" },
};
const CREATES_PER_MIN = 20;
const OTHERS_PER_MIN = 60;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_JITTER_MS = 15_000;
const NOTE_INTERVAL_MS = 10 * 60_000;
/** How long a create that may have happened waits for search to show it before creating again. */
const CREATE_SETTLE_MS = 5 * 60_000;
const DEGRADED_AFTER_ROUNDS = 3;
const MAX_ATTEMPTS = 5;
const SUB_ISSUE_HEADER = "GraphQL-Features: sub_issues";

const ADD_SUB_ISSUE = "mutation($parent: ID!, $child: ID!) { addSubIssue(input: {issueId: $parent, subIssueId: $child}) { subIssue { id } } }";

const STATUS_NAMES: Record<StatusKey, string[]> = { todo: ["todo", "to do"], in_progress: ["in progress"], done: ["done"] };
const STATUS_LABELS: Record<StatusKey, string> = { todo: "Todo", in_progress: "In Progress", done: "Done" };
const CUSTOM_FIELD = "Roundtable Status";

/** Task state → project status (heads-down.md §14). */
export function statusFor(state: TaskState): StatusKey {
  switch (state) {
    case "pending":
    case "ready":
      return "todo";
    case "accepted":
    case "failed":
    case "cancelled":
      return "done";
    default:
      return "in_progress";
  }
}

// ---------------------------------------------------------------------------
// Text for GitHub
// ---------------------------------------------------------------------------

const ZWSP = "\u200b";

/**
 * Redacted markdown-safe text: no HTML (so no forged markers), and nothing GitHub turns into a
 * reference that would notify someone or backlink another issue from the user's account: a zero-width
 * space breaks @mentions, #123 and owner/repo#123, GH-123, and github.com URLs.
 */
export function ghText(s: unknown, max = 4000): string {
  let out = redact(String(s ?? "")).text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  out = out
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/\bGH-(?=\d)/gi, (m) => `${m}${ZWSP}`)
    .replace(/github\.com/gi, (m) => m.replace(".", `${ZWSP}.`));
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** A redacted single line (titles). */
function ghLine(s: unknown, max = 200): string {
  const out = redact(String(s ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** A redacted code span. Entities do not decode inside one, so angle brackets and backticks are replaced instead. */
function ghCode(s: unknown, max = 200): string {
  return "`" + ghLine(s, max).replace(/[<>`]/g, "?") + "`";
}

export const issueMarker =(exe: string, key: string) => (key === PARENT ? `<!-- roundtable:${exe} -->` : `<!-- roundtable:${exe}:${key} -->`);
const commentMarker = (exe: string, key: string, seq: number) => `<!-- roundtable:${exe}:${key}:e${seq} -->`;

const MARKER_RE = /<!-- roundtable:(exe-[0-9a-z]{16})(?::([a-z0-9][a-z0-9._-]{0,63}))? -->/g;

// ---------------------------------------------------------------------------

class Deferred extends Error {
  constructor() {
    super("rate limited: deferred to a later round");
  }
}

class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMinute: number,
    now: number
  ) {
    this.tokens = perMinute;
    this.last = now;
  }
  take(now: number): boolean {
    // A clock that goes backwards refills nothing (and takes nothing away).
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed * this.perMinute) / 60_000);
    this.last = Math.max(this.last, now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const errText = (e: unknown) => ghLine(e instanceof Error ? e.message : String(e), 400);

export class GitHubSync {
  readonly executionId: string;
  readonly repo: string;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly random: () => number;
  private store?: ExecutionStore;
  private file?: SyncFile;
  private readonly creates: Bucket;
  private readonly others: Bucket;
  private running?: Promise<SyncReport>;
  private report!: SyncReport;
  /** Comment markers already on each issue (filled only while recovering). */
  private readonly seenMarkers = new Map<number, Set<string>>();
  private searched = false;
  private login?: string;

  constructor(private readonly opts: GitHubSyncOptions) {
    this.executionId = opts.executionId;
    this.repo = opts.repo;
    this.gh = opts.gh ?? runGh;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.store = opts.store;
    this.creates = new Bucket(CREATES_PER_MIN, this.now());
    this.others = new Bucket(OTHERS_PER_MIN, this.now());
  }

  /**
   * One round: read new events, then bring GitHub up to date as far as the limits allow. Never
   * throws. Concurrent calls share the round in flight. Run one GitHubSync per execution (the
   * runner's): github.json has a single writer.
   */
  syncOnce(): Promise<SyncReport> {
    this.running ??= this.round()
      .catch((e): SyncReport => ({
        ok: false, degraded: true, cursor: this.file?.cursor ?? 0, processed: 0, calls: 0, created: 0, updated: 0, comments: 0, closed: 0,
        pending: 0, rateLimited: false, errors: [errText(e)],
      }))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  // --------------------------------------------------------------------------

  private get path(): string {
    return join(this.store!.dir, "github.json");
  }

  private load(): SyncFile {
    const fresh: SyncFile = {
      schema: 1, execution: this.executionId, repo: this.repo, cursor: 0, started: false, completed: false, labels_ready: false,
      issues: {}, creating: {}, outbox: [], notes: {}, flagged: {}, recover_seq: 0, failed_rounds: 0,
    };
    let raw: Partial<SyncFile>;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return fresh;
    }
    if (!raw || raw.schema !== 1 || raw.execution !== this.executionId || raw.repo !== this.repo) return fresh;
    return { ...fresh, ...raw } as SyncFile;
  }

  private save(): void {
    writeFileAtomic(this.path, JSON.stringify(this.file, null, 2) + "\n");
  }

  private async round(): Promise<SyncReport> {
    const r: SyncReport = (this.report = {
      ok: true, degraded: false, cursor: 0, processed: 0, calls: 0, created: 0, updated: 0, comments: 0, closed: 0, pending: 0,
      rateLimited: false, errors: [],
    });
    let state: BlackboardState | undefined;
    try {
      if (!isRepoName(this.repo)) throw new Error(`not a repository name: ${JSON.stringify(this.repo.slice(0, 80))}`);
      if (this.opts.projectOwner !== undefined && !isOwnerName(this.opts.projectOwner)) throw new Error("projectOwner is not a GitHub login");
      this.store ??= await openExecutionStore(this.executionId);
      this.file ??= this.load();
      const f = this.file;
      r.cursor = f.cursor;
      const now = this.now();
      if (f.backoff_until && f.backoff_until > now) {
        r.rateLimited = true;
        r.backoffUntil = new Date(f.backoff_until).toISOString();
        return this.finish(r, undefined);
      }
      // Events first, then the state (at least as new as they are).
      const events = await this.store.events({ sinceSeq: f.cursor });
      state = await this.store.state();
      for (const ev of events) {
        this.ingest(ev, state);
        f.cursor = ev.seq;
        r.processed++;
      }
      r.cursor = f.cursor;
      this.save();
      if (!f.started) return this.finish(r, state);
      await this.ensureLabels();
      await this.ensureProject(state);
      await this.recover(state);
      await this.ensureIssue(PARENT, state);
      for (const id of Object.keys(state.tasks).sort()) await this.ensureIssue(id, state);
      await this.syncStatuses(state);
      await this.drainOutbox(state);
      await this.postNotes();
      f.failed_rounds = 0;
    } catch (e) {
      if (e instanceof Deferred) {
        r.rateLimited = true;
      } else {
        r.ok = false;
        r.errors.push(errText(e));
        if (this.file) {
          this.file.failed_rounds++;
          if (e instanceof GhError && e.kind === "rate_limit") {
            r.rateLimited = true;
            this.file.backoff_until = this.now() + RATE_LIMIT_BACKOFF_MS + Math.floor(this.random() * RATE_LIMIT_JITTER_MS);
          }
        }
      }
    }
    return this.finish(r, state);
  }

  private finish(r: SyncReport, state: BlackboardState | undefined): SyncReport {
    const f = this.file;
    if (f) {
      try {
        this.save();
      } catch (e) {
        r.ok = false;
        r.errors.push(`cannot save github.json: ${errText(e)}`);
      }
      r.degraded = f.failed_rounds >= DEGRADED_AFTER_ROUNDS;
      if (f.backoff_until && f.backoff_until > this.now()) r.backoffUntil = new Date(f.backoff_until).toISOString();
      r.pending = this.pendingWork(state);
    } else {
      r.degraded = true;
    }
    if (r.errors.length) console.error(`[GitHub] ${this.executionId}: ${r.errors.join("; ")}`);
    return r;
  }

  private pendingWork(state: BlackboardState | undefined): number {
    const f = this.file!;
    if (!f.started) return 0;
    let n = f.outbox.length + Object.values(f.notes).filter((x) => x.pending).length;
    if (!f.issues[PARENT]) n++;
    for (const [id, rt] of Object.entries(state?.tasks ?? {})) {
      const ref = Object.hasOwn(f.issues, id) ? f.issues[id] : undefined;
      if (!ref) {
        if (rt.state !== "cancelled" && !f.completed) n++;
        continue;
      }
      if (!ref.sub) n++;
      if (f.project && (!ref.item || ref.status !== statusFor(rt.state))) n++;
    }
    return n;
  }

  // --------------------------------------------------------------------------
  // Events → intents
  // --------------------------------------------------------------------------

  private comment(target: string, seq: number, body: string): void {
    const marker = commentMarker(this.executionId, target, seq);
    this.file!.outbox.push({ kind: "comment", target, seq, marker, body: `${body}\n\n${marker}`, attempts: 0 });
  }

  private ingest(ev: AnyEvent, state: BlackboardState): void {
    const f = this.file!;
    switch (ev.type) {
      case "execution.started":
        f.started = true;
        break;
      case "task.progress": {
        if (f.completed) break;
        const p = ev.payload;
        const pct = typeof p.percent === "number" && Number.isFinite(p.percent) ? ` (${Math.round(Math.min(100, Math.max(0, p.percent)))}%)` : "";
        (f.notes[p.task] ??= {}).pending = { text: `**Progress${pct}:** ${ghText(p.note, 1500)}`, seq: ev.seq };
        break;
      }
      case "task.failed":
        this.comment(ev.payload.task, ev.seq, `**Task failed:** ${ghText(ev.payload.why, 2000)}`);
        break;
      case "task.cancelled":
        this.comment(ev.payload.task, ev.seq, `**Task cancelled:** ${ghText(ev.payload.why, 2000)}`);
        break;
      case "escalation.awaiting_human": {
        const p = ev.payload;
        const esc = Object.hasOwn(state.escalations, p.id) ? state.escalations[p.id] : undefined;
        const target = esc?.task && Object.hasOwn(state.tasks, esc.task) ? esc.task : PARENT;
        const lines = [
          `**A human is needed** (${ghText(p.class)}): ${ghText(p.message, 2000)}`,
          ...(esc?.question ? ["", `Question: ${ghText(esc.question, 1500)}`] : []),
          ...(p.alternatives?.length ? ["", "Alternatives:", ...p.alternatives.slice(0, 10).map((a) => `- ${ghText(a, 300)}`)] : []),
          "",
          `Escalation ${ghCode(p.id, 80)}. Answer it in the orchestrator's chat (resolve_escalation).`,
        ];
        this.comment(target, ev.seq, lines.join("\n"));
        f.outbox.push({ kind: "label", target, label: NEEDS_HUMAN_LABEL, attempts: 0 });
        f.flagged[p.id] = target;
        break;
      }
      case "escalation.resolved":
      case "escalation.withdrawn":
      case "escalation.auto_resolved": {
        const id = ev.payload.id;
        if (!Object.hasOwn(f.flagged, id)) break;
        const target = f.flagged[id];
        delete f.flagged[id];
        if (!Object.values(f.flagged).includes(target)) f.outbox.push({ kind: "unlabel", target, label: NEEDS_HUMAN_LABEL, attempts: 0 });
        break;
      }
      case "execution.completed": {
        f.completed = true;
        const pr = ev.payload.pr_url ? ghLine(ev.payload.pr_url, 300) : undefined;
        const prOk = pr && /^https:\/\/[^\s]+$/.test(pr) ? pr : undefined;
        this.comment(PARENT, ev.seq, prOk ? `**The run completed.** Pull request: ${prOk}` : "**The run completed.**");
        f.outbox.push({ kind: "close_all", ...(prOk && { pr_url: prOk }), attempts: 0 });
        f.notes = {};
        break;
      }
      case "execution.failed":
      case "execution.aborted":
        this.comment(PARENT, ev.seq, `**The run ${ev.type === "execution.failed" ? "failed" : "was aborted"}:** ${ghText(ev.payload.reason, 2000)}`);
        break;
    }
  }

  // --------------------------------------------------------------------------
  // gh calls (rate limited)
  // --------------------------------------------------------------------------

  /** One gh call, charged to a bucket ("reserved": the caller already took a create token). */
  private async call(args: string[], kind: "create" | "other" | "reserved" = "other"): Promise<string> {
    if (kind !== "reserved" && !(kind === "create" ? this.creates : this.others).take(this.now())) throw new Deferred();
    this.report.calls++;
    return (await this.gh(args)).stdout;
  }

  private async callJson<T>(args: string[], kind: "create" | "other" = "other"): Promise<T> {
    return parseGhJson<T>(await this.call(args, kind), `gh ${args.slice(0, 2).join(" ")}`);
  }

  private repoArgs(): string[] {
    return ["--repo", this.repo];
  }

  private owner(): string {
    return this.opts.projectOwner ?? this.repo.split("/")[0];
  }

  private wantsProject(): boolean {
    return this.opts.projectNumber !== undefined || this.opts.createProject === true;
  }

  // --------------------------------------------------------------------------
  // Phases
  // --------------------------------------------------------------------------

  private async ensureLabels(): Promise<void> {
    const f = this.file!;
    if (f.labels_ready) return;
    const have = await this.callJson<Array<{ name: string }>>(["label", "list", ...this.repoArgs(), "--json", "name", "--limit", "500"]);
    const names = new Set(have.map((l) => l.name.toLowerCase()));
    for (const [name, spec] of Object.entries(LABELS)) {
      if (names.has(name)) continue;
      try {
        await this.call(["label", "create", name, ...this.repoArgs(), "--color", spec.color, "--description", spec.description], "create");
      } catch (e) {
        if (!(e instanceof GhError && /already exists/i.test(e.message))) throw e;
      }
    }
    f.labels_ready = true;
    this.save();
  }

  /**
   * Once per instance, rebuild the issue mapping from GitHub when it may be incomplete: every
   * issue whose body carries this run's marker. When the mapping was lost, comments from the
   * events seen so far may already be posted: recover_seq makes the outbox check before posting.
   */
  private async recover(state: BlackboardState): Promise<void> {
    const f = this.file!;
    if (this.searched) return;
    const keys = [PARENT, ...Object.keys(state.tasks)];
    if (keys.every((k) => Object.hasOwn(f.issues, k)) && Object.keys(f.creating).length === 0) {
      this.searched = true;
      return;
    }
    const lost = Object.keys(f.issues).length === 0;
    const found = await this.searchMarkers(`"roundtable:${this.executionId}"`);
    for (const [key, ref] of found) if (!Object.hasOwn(f.issues, key)) f.issues[key] = ref;
    if (lost && found.size > 0) f.recover_seq = Math.max(f.recover_seq, f.cursor);
    this.searched = true;
    this.save();
  }

  /** The login gh acts as (GraphQL viewer), lowercased; asked once per instance. */
  private async viewer(): Promise<string> {
    if (!this.login) {
      const data = await ghGraphql<{ viewer?: { login?: string } }>(this.callAsRunner(), "query { viewer { login } }", {});
      const login = data.viewer?.login;
      if (!login) throw new GhError("gh api graphql: no viewer login", "output");
      this.login = login.toLowerCase();
    }
    return this.login;
  }

  /**
   * Issues this sync created, found by a search, by the key of the marker in their body (exact
   * match only). Anyone can file an issue carrying a marker, so only issues authored by the gh
   * account this sync runs as and labelled roundtable are trusted, on the search side and again here.
   */
  private async searchMarkers(phrase: string): Promise<Map<string, IssueRef>> {
    const me = await this.viewer();
    const list = await this.callJson<
      Array<{ number: number; url: string; id: string; body?: string; state?: string; author?: { login?: string }; labels?: Array<{ name?: string }> }>
    >([
      "issue", "list", ...this.repoArgs(), "--search", `${phrase} in:body author:@me label:${ROUNDTABLE_LABEL}`, "--state", "all",
      "--json", "number,url,id,body,state,author,labels", "--limit", "1000",
    ]);
    const out = new Map<string, IssueRef>();
    for (const it of list) {
      if ((it.author?.login ?? "").toLowerCase() !== me) continue;
      if (!(it.labels ?? []).some((l) => l.name === ROUNDTABLE_LABEL)) continue;
      for (const m of (it.body ?? "").matchAll(MARKER_RE)) {
        if (m[1] !== this.executionId) continue;
        const key = m[2] ?? PARENT;
        if (!out.has(key) || out.get(key)!.number > it.number) {
          out.set(key, { number: it.number, url: it.url, id: it.id, ...(it.state === "CLOSED" && { closed: true }) });
        }
      }
    }
    return out;
  }

  private issueTitle(key: string, state: BlackboardState): string {
    const title = state.contract?.title ?? this.executionId;
    if (key === PARENT) return `Roundtable: ${ghLine(title, 180)}`;
    return ghLine(`${key}: ${state.tasks[key].spec.title}`, 200);
  }

  private issueBody(key: string, state: BlackboardState): string {
    const c = state.contract;
    const lines: string[] = [];
    if (key === PARENT) {
      lines.push(
        `Heads-down run \`${this.executionId}\`${c ? `, contract ${ghCode(c.id, 80)} v${c.version}` : ""}.`,
        "",
        "## Goal",
        "",
        ghText(c?.goal?.ultimate ?? "", 3000),
        "",
        "## Tasks",
        "",
        ...Object.values(state.tasks)
          .sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1))
          .map((rt) => `- \`${rt.spec.id}\`: ${ghText(rt.spec.title, 200)}${rt.spec.depends_on.length ? ` (after ${rt.spec.depends_on.map((d) => `\`${d}\``).join(", ")})` : ""}`),
        ""
      );
      if (c?.budget) lines.push(`Budget: $${c.budget.usd.toFixed(2)}. Each task is a sub-issue; their status follows the run.`, "");
    } else {
      const spec = state.tasks[key].spec;
      const parent = this.file!.issues[PARENT];
      lines.push(
        `Task \`${key}\` of heads-down run \`${this.executionId}\`${parent ? ` (#${parent.number})` : ""}.`,
        "",
        `**${ghText(spec.title, 300)}**`,
        "",
        `- Kind: ${ghText(spec.kind)}; persona: ${ghText(spec.persona, 100)}${spec.team ? `; team: ${ghText(spec.team, 100)}` : ""}`,
        `- Depends on: ${spec.depends_on.length ? spec.depends_on.map((d) => `\`${d}\``).join(", ") : "nothing"}`,
        `- Writes: ${spec.paths.write.slice(0, 20).map((p) => ghCode(p, 200)).join(", ")}`,
        "",
        "## Acceptance",
        "",
        ...(spec.acceptance.length ? spec.acceptance.slice(0, 30).map((a) => `- ${ghText(a, 500)}`) : ["- (none listed)"]),
        ""
      );
    }
    lines.push("_Mirrored by agent-roundtable. Comments here are not read by the run._", "", issueMarker(this.executionId, key));
    return lines.join("\n");
  }

  /** Create the issue for `key` unless it exists (mapping, or found by its marker), then link it and add it to the project. */
  private async ensureIssue(key: string, state: BlackboardState): Promise<void> {
    const f = this.file!;
    let ref = Object.hasOwn(f.issues, key) ? f.issues[key] : undefined;
    if (!ref) {
      if (key !== PARENT && (f.completed || state.tasks[key].state === "cancelled")) return;
      if (Object.hasOwn(f.creating, key)) {
        // A create may have gone through before a crash: look for it before creating again.
        const found = (await this.searchMarkers(`"${issueMarker(this.executionId, key).slice(5, -4)}"`)).get(key);
        if (found) {
          f.issues[key] = ref = found;
          delete f.creating[key];
          this.save();
        } else if (this.now() - f.creating[key] < CREATE_SETTLE_MS) {
          throw new Deferred(); // search can lag behind a fresh issue
        }
      }
      if (!ref) {
        // Take the token first: a deferral must not leave a create marked as possibly done.
        if (!this.creates.take(this.now())) throw new Deferred();
        f.creating[key] = this.now();
        this.save();
        let url: string;
        try {
          url = (
            await withBodyFile(this.issueBody(key, state), (path) =>
              this.call(["issue", "create", ...this.repoArgs(), "--title", this.issueTitle(key, state), "--body-file", path, "--label", ROUNDTABLE_LABEL], "reserved")
            )
          ).trim();
        } catch (e) {
          // GitHub said no (rate limit, auth, not found): nothing was created. A timeout or an
          // unknown failure may have created it, so the mark stays and the next round searches.
          const labelGone = e instanceof GhError && /could not add label|label.*not found/i.test(e.message);
          if (labelGone) f.labels_ready = false; // deleted on GitHub: create it again next round
          if (e instanceof GhError && (labelGone || ["rate_limit", "auth", "not_found", "missing"].includes(e.kind))) {
            delete f.creating[key];
            this.save();
          }
          throw e;
        }
        const m = /^https:\/\/\S+\/issues\/(\d+)$/.exec(url);
        if (!m) throw new GhError("gh issue create: no issue URL in its output", "output");
        // Recorded at once: the node id comes from a later call, which may be deferred or fail.
        f.issues[key] = ref = { number: Number(m[1]), url };
        delete f.creating[key];
        this.report.created++;
        this.save();
      }
    }
    if (!ref.id) {
      const view = await this.callJson<{ id: string; number: number; url: string }>(["issue", "view", String(ref.number), ...this.repoArgs(), "--json", "id,number,url"]);
      ref.id = view.id;
      ref.url = view.url;
      this.save();
    }
    if (key !== PARENT && !ref.sub) {
      const parent = f.issues[PARENT];
      if (!parent?.id) throw new Error("the parent issue has no node id yet");
      try {
        await ghGraphql(this.callAsRunner(), ADD_SUB_ISSUE, { parent: parent.id, child: ref.id }, [SUB_ISSUE_HEADER]);
      } catch (e) {
        if (!(e instanceof GhError && /already|duplicate|only have one parent/i.test(e.message))) throw e;
      }
      ref.sub = true;
      this.save();
    }
    if (f.project && !ref.item) {
      const item = await this.callJson<{ id: string }>([
        "project", "item-add", String(f.project.number), "--owner", f.project.owner, "--url", ref.url, "--format", "json",
      ]);
      ref.item = item.id;
      this.save();
    }
  }

  /** The rate-limited call, shaped as a GhRunner (for ghGraphql). */
  private callAsRunner(): GhRunner {
    return async (args) => ({ stdout: await this.call(args), stderr: "" });
  }

  private async ensureProject(state: BlackboardState): Promise<void> {
    const f = this.file!;
    if (!this.wantsProject() || f.project?.field) return;
    if (!f.project) {
      const owner = this.owner();
      if (this.opts.projectNumber !== undefined) {
        const n = this.opts.projectNumber;
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error("projectNumber is not a positive integer");
        const p = await this.callJson<{ id: string; number: number }>(["project", "view", String(n), "--owner", owner, "--format", "json"]);
        f.project = { owner, number: n, id: p.id };
      } else {
        const p = await this.callJson<{ id: string; number: number }>(
          ["project", "create", "--owner", owner, "--title", `Roundtable: ${ghLine(state.contract?.title ?? this.executionId, 100)}`, "--format", "json"],
          "create"
        );
        this.report.created++;
        f.project = { owner, number: p.number, id: p.id };
      }
      this.save();
    }
    const project = f.project;
    const fields = await this.fieldList();
    let field = pickStatusField(fields, "Status") ?? pickStatusField(fields, CUSTOM_FIELD);
    if (!field) {
      if (!fields.some((x) => x.name === CUSTOM_FIELD)) {
        await this.call(
          ["project", "field-create", String(project.number), "--owner", project.owner, "--name", CUSTOM_FIELD, "--data-type", "SINGLE_SELECT",
            "--single-select-options", Object.values(STATUS_LABELS).join(","), "--format", "json"],
          "create"
        );
        this.report.created++;
        field = pickStatusField(await this.fieldList(), CUSTOM_FIELD);
      }
      if (!field) throw new Error(`project ${project.owner}/${project.number}: no Status field with Todo, In Progress and Done options`);
    }
    project.field = field;
    this.save();
  }

  private async fieldList(): Promise<ProjectField[]> {
    const p = this.file!.project!;
    const res = await this.callJson<{ fields?: ProjectField[] }>(["project", "field-list", String(p.number), "--owner", p.owner, "--format", "json", "--limit", "100"]);
    return res.fields ?? [];
  }

  private desiredStatus(key: string, state: BlackboardState): StatusKey {
    if (key === PARENT) return state.status === "completed" || state.status === "failed" || state.status === "aborted" ? "done" : "in_progress";
    return statusFor(state.tasks[key].state);
  }

  /** Write the latest status of every issue whose project status is behind (coalesced: one edit per issue). */
  private async syncStatuses(state: BlackboardState): Promise<void> {
    const f = this.file!;
    const field = f.project?.field;
    if (!f.project || !field) return;
    for (const [key, ref] of Object.entries(f.issues)) {
      if (!ref.item || (key !== PARENT && !Object.hasOwn(state.tasks, key))) continue;
      const want = this.desiredStatus(key, state);
      if (ref.status === want) continue;
      await this.call([
        "project", "item-edit", "--id", ref.item, "--project-id", f.project.id, "--field-id", field.id, "--single-select-option-id", field.options[want],
      ]);
      ref.status = want;
      this.report.updated++;
      this.save();
    }
  }

  private issueFor(target: string): IssueRef | undefined {
    const f = this.file!;
    return Object.hasOwn(f.issues, target) ? f.issues[target] : undefined;
  }

  /**
   * Has this marker already been posted on the issue? Asked while recovering, and after a post
   * whose outcome is unknown (`fresh` re-reads the comments). Only comments by the gh account this
   * sync runs as count: anyone can paste a marker into a comment to suppress a real post.
   */
  private async alreadyPosted(ref: IssueRef, marker: string, fresh = false): Promise<boolean> {
    let seen = fresh ? undefined : this.seenMarkers.get(ref.number);
    if (!seen) {
      const me = await this.viewer();
      const view = await this.callJson<{ comments?: Array<{ body?: string; author?: { login?: string } }> }>([
        "issue", "view", String(ref.number), ...this.repoArgs(), "--json", "comments",
      ]);
      seen = new Set(
        (view.comments ?? [])
          .filter((c) => (c.author?.login ?? "").toLowerCase() === me)
          .flatMap((c) => (c.body ?? "").match(/<!-- roundtable:[^>]* -->/g) ?? [])
      );
      this.seenMarkers.set(ref.number, seen);
    }
    return seen.has(marker);
  }

  /** Post a comment (redacted body in a 0600 temp file). */
  private async postComment(ref: IssueRef, body: string): Promise<void> {
    await withBodyFile(body, (path) => this.call(["issue", "comment", String(ref.number), ...this.repoArgs(), "--body-file", path]));
    this.report.comments++;
  }

  /** After this failure, may the comment have been posted all the same? */
  private static unsure(e: unknown): boolean {
    return e instanceof GhError && (e.kind === "timeout" || e.kind === "other" || e.kind === "output");
  }

  /** Comments, labels and closes, in order. A failing item is retried on later rounds, then dropped. */
  private async drainOutbox(state: BlackboardState): Promise<void> {
    const f = this.file!;
    while (f.outbox.length) {
      const item = f.outbox[0];
      if (item.kind === "close_all") {
        // Expand into one close per issue: tasks first, the parent last.
        const comment = item.pr_url ? `The run completed. Pull request: ${item.pr_url}` : "The run completed.";
        const keys = [...Object.keys(f.issues).filter((k) => k !== PARENT).sort(), ...(f.issues[PARENT] ? [PARENT] : [])];
        const closes: OutboxItem[] = keys.map((k) => {
          const st = k === PARENT ? undefined : state.tasks[k]?.state;
          return { kind: "close", target: k, reason: st === "failed" || st === "cancelled" ? "not planned" : "completed", comment, attempts: 0 };
        });
        f.outbox.splice(0, 1, ...closes);
        this.save();
        continue;
      }
      const ref = this.issueFor(item.target);
      if (!ref) {
        f.outbox.shift(); // no issue for it (a task cancelled before it got one): nothing to update
        this.save();
        continue;
      }
      try {
        if (item.kind === "comment") {
          const check = item.seq <= f.recover_seq || item.check === true;
          if (!(check && (await this.alreadyPosted(ref, item.marker, item.check === true)))) {
            try {
              await this.postComment(ref, item.body);
            } catch (e) {
              if (GitHubSync.unsure(e)) item.check = true; // look before posting it again
              throw e;
            }
          }
        } else if (item.kind !== "close") {
          await this.call(["issue", "edit", String(ref.number), ...this.repoArgs(), item.kind === "label" ? "--add-label" : "--remove-label", item.label]);
        } else if (!ref.closed) {
          await this.call(["issue", "close", String(ref.number), ...this.repoArgs(), "--reason", item.reason, "--comment", item.comment]);
          ref.closed = true;
          this.report.closed++;
        }
      } catch (e) {
        if (e instanceof Deferred || (e instanceof GhError && e.kind === "rate_limit")) throw e;
        if (++item.attempts >= MAX_ATTEMPTS) {
          f.outbox.shift();
          this.report.errors.push(`dropped a ${item.kind} for ${item.target === PARENT ? "the parent issue" : `task ${item.target}`} after ${MAX_ATTEMPTS} attempts`);
        }
        this.save();
        throw e;
      }
      f.outbox.shift();
      this.save();
    }
  }

  /** The latest progress note of each task, at most once per 10 minutes per task. */
  private async postNotes(): Promise<void> {
    const f = this.file!;
    for (const [task, n] of Object.entries(f.notes).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!n.pending) continue;
      const ref = this.issueFor(task);
      if (!ref || ref.closed) {
        if (!ref && f.completed) delete n.pending;
        continue;
      }
      if (n.last_at !== undefined && this.now() - n.last_at < NOTE_INTERVAL_MS) continue;
      const pending = n.pending;
      const marker = commentMarker(this.executionId, task, pending.seq);
      const check = pending.seq <= f.recover_seq || pending.check === true;
      if (!(check && (await this.alreadyPosted(ref, marker, pending.check === true)))) {
        try {
          await this.postComment(ref, `${pending.text}\n\n${marker}`);
        } catch (e) {
          if (GitHubSync.unsure(e)) {
            pending.check = true;
            this.save();
          }
          throw e;
        }
      }
      n.last_at = this.now();
      delete n.pending;
      this.save();
    }
  }
}

interface ProjectField {
  id: string;
  name: string;
  type?: string;
  options?: Array<{ id: string; name: string }>;
}

/** A single-select field named `name` with options for Todo, In Progress and Done (case-insensitive). */
function pickStatusField(fields: ProjectField[], name: string): { id: string; name: string; options: Record<StatusKey, string> } | undefined {
  const field = fields.find((x) => x.name.toLowerCase() === name.toLowerCase() && Array.isArray(x.options));
  if (!field) return undefined;
  const options = {} as Record<StatusKey, string>;
  for (const key of Object.keys(STATUS_NAMES) as StatusKey[]) {
    const opt = field.options!.find((o) => STATUS_NAMES[key].includes(o.name.trim().toLowerCase()));
    if (!opt) return undefined;
    options[key] = opt.id;
  }
  return { id: field.id, name: field.name, options };
}

export { checkGhReady, type GhReadiness } from "./gh.js";
