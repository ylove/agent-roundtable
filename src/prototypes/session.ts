// PrototypeTracker: one per prototype-mode session. Parses every turn for prototype blocks, verdicts
// and decisions; materializes, serves and destroys artifacts; keeps the board and the agent-facing
// and public views of the transcript in step. Never throws into a session.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROTOTYPE_DIR, PROTOTYPE_OPEN, PROTOTYPE_SCREENSHOTS, PROTOTYPE_TTL_MS } from "../config.js";
import { publicLabel } from "../publishers/index.js";
import { redact } from "../publishers/redact.js";
import { PrototypeBoard, openInBrowser, type BoardPrototype } from "./board.js";
import {
  parseDecisionFor,
  parsePrototypeBlock,
  parseVerdictFor,
  replacePrototypeBlock,
  type ParsedPrototype,
} from "./parse.js";
import { renderOutcomesMarkdown, renderPublicPrototype, renderStub } from "./render.js";
import { registerTracker, unregisterTracker } from "./registry.js";
import {
  createSessionDir,
  ensurePrototypeRoot,
  materializeFiles,
  removeDir,
  removeDirSync,
  sweepStaleSessionDirs,
} from "./sandbox.js";
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, captureScreenshots, findChrome } from "./screenshot.js";
import type { Decision, PrototypeFile, PrototypeKind, PrototypeRecord, PrototypeStatus, Verdict } from "./types.js";

export type { Decision, PrototypeKind, PrototypeStatus, Verdict } from "./types.js";

/** Speaker index for the meeting caller (the orchestrator). */
export const CALLER = -1;

export interface PrototypeAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
  caption: string;
}

export interface TurnResult {
  created?: { id: string; version: number; label: string; kind: PrototypeKind; title: string; url: string };
  /** Validation error for a block this turn (no prototype created). */
  rejected?: string;
  /** Labels destroyed during this turn. */
  destroyed: string[];
  /** Public sessions only: screenshots to post after the turn. */
  attachments: PrototypeAttachment[];
}

export interface TrackerOptions {
  sessionId: string;
  mode: string;
  /** Display names by speaker index (0..n-1). */
  participants: string[];
  /** Meetings: true (the caller assesses the persona's prototypes). */
  assessorIsCaller: boolean;
  /** Redact before materializing, take screenshots, render public views. */
  public: boolean;
  topic?: string;
  ttlMs?: number;
  root?: string;
  screenshots?: boolean;
  openBrowser?: boolean;
  now?: () => number;
}

export const NOTICE =
  "Show the human the board URL. Prototypes exist only until the other participants finish assessing them. " +
  "Do not relay the human's feedback on prototypes into this session until it ends.";

interface Proto extends PrototypeRecord {
  num: number;
  proposerIndex: number;
  assessors: number[];
  assessed: Set<number>;
  verdictMap: Map<number, { verdict: Verdict; reason: string }>;
  turnKey: number;
  createdAt: number;
  /** <sessionDir>/<key> while the artifact exists. */
  dir?: string;
  /** Where the files are (inside dir). */
  appDir?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sweptRoots = new Set<string>();

export class PrototypeTracker {
  private readonly protos: Proto[] = [];
  private readonly byTurn = new Map<number, { key?: string; rejected?: string }>();
  private readonly lastError = new Map<number, string>();
  private destroyedSinceCall: string[] = [];
  private nextNum = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private isClosed = false;
  private readonly ttlMs: number;
  private readonly screenshots: boolean;
  private readonly now: () => number;

  private constructor(
    private readonly opts: TrackerOptions,
    readonly sessionDir: string,
    private readonly board: PrototypeBoard
  ) {
    this.ttlMs = Math.max(1, opts.ttlMs ?? PROTOTYPE_TTL_MS);
    this.screenshots = opts.screenshots ?? PROTOTYPE_SCREENSHOTS;
    this.now = opts.now ?? Date.now;
  }

  /** Ensure the root, create the session dir, start the board, register for shutdown, maybe open a browser. */
  static async create(opts: TrackerOptions): Promise<PrototypeTracker> {
    const root = await ensurePrototypeRoot(opts.root ?? PROTOTYPE_DIR);
    if (!sweptRoots.has(root)) {
      sweptRoots.add(root);
      await sweepStaleSessionDirs(root);
    }
    const sessionDir = await createSessionDir(root, opts.sessionId);
    let board: PrototypeBoard;
    try {
      board = await PrototypeBoard.start({
        sessionId: opts.sessionId,
        mode: opts.mode,
        participants: [...opts.participants],
        ...(opts.topic !== undefined && { topic: opts.topic }),
      });
    } catch (e) {
      await removeDir(sessionDir);
      throw new Error(`Cannot start the prototype board: ${errText(e)}`);
    }
    const tracker = new PrototypeTracker(opts, sessionDir, board);
    registerTracker(tracker);
    tracker.pushBoard();
    if (opts.openBrowser ?? PROTOTYPE_OPEN) openInBrowser(board.url);
    return tracker;
  }

  get boardUrl(): string {
    return this.board.url;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  // --------------------------------------------------------------------------
  // Turns
  // --------------------------------------------------------------------------

  /** Call for EVERY turn, in order, BEFORE recording it publicly. turnKey = the session's message index of this turn. */
  onTurn(speakerIndex: number, text: string, turnKey: number): Promise<TurnResult> {
    const run = this.chain.then(() => this.processTurn(speakerIndex, String(text ?? ""), turnKey));
    this.chain = run.catch(() => undefined);
    return run.catch((e): TurnResult => {
      console.error(`[Prototype] turn processing failed: ${errText(e)}`);
      return { destroyed: [], attachments: [] };
    });
  }

  private async processTurn(s: number, text: string, turnKey: number): Promise<TurnResult> {
    const result: TurnResult = { destroyed: [], attachments: [] };
    if (this.isClosed) return result;
    const isCaller = s === CALLER;
    if (!isCaller && !(Number.isInteger(s) && s >= 0 && s < this.opts.participants.length)) return result;
    this.lastError.delete(s);

    // (1) verdicts and (2) "has taken a turn" for every live prototype this speaker assesses
    for (const p of this.protos) {
      if (p.status !== "live" || !p.assessors.includes(s)) continue;
      const v = parseVerdictFor(text, p.id, p.version);
      if (!p.assessed.has(s)) {
        p.assessed.add(s);
        p.verdictMap.set(s, v);
      } else if (v.verdict !== "UNCLEAR") {
        p.verdictMap.set(s, v);
      }
    }

    // (3) fully assessed: destroy now
    for (const p of this.protos) {
      if (p.status === "live" && p.assessors.every((a) => p.assessed.has(a))) {
        await this.destroy(p, "awaiting_decision");
        result.destroyed.push(p.label);
      }
    }

    // (4) the proposer's decisions on its assessed prototypes
    const pendingRevise: Proto[] = [];
    if (!isCaller) {
      for (const p of this.protos) {
        if (p.proposerIndex !== s || p.status !== "awaiting_decision") continue;
        const d = parseDecisionFor(text, p.id, p.version);
        if (!d) continue;
        p.decision = d;
        if (d.decision === "SHORTLIST") p.status = "shortlisted";
        else if (d.decision === "SCRAP") {
          p.status = "scrapped";
          p.files = [];
        } else pendingRevise.push(p);
      }
    }

    // (5) a new prototype (or a new version)
    if (!isCaller) {
      const parsed = parsePrototypeBlock(text);
      if (parsed.found && !parsed.ok) {
        this.reject(result, s, turnKey, parsed.error);
      } else if (parsed.found && parsed.ok) {
        const target = parsed.prototype.revises ?? (pendingRevise.length === 1 ? pendingRevise[0].id : undefined);
        let base: Proto | undefined;
        let error: string | undefined;
        if (target) {
          base = this.latest(target);
          if (!base) error = `revises="${target}": there is no prototype ${target}`;
          else if (base.proposerIndex !== s) {
            error = `${target} was proposed by ${this.nameOf(base.proposerIndex)}; you can only revise your own prototypes (propose a new one without revises=)`;
          } else if (base.status === "live") error = `${target} is still under assessment; wait for the verdicts before revising it`;
        }
        if (error) this.reject(result, s, turnKey, error);
        else {
          try {
            await this.materialize(parsed.prototype, s, turnKey, base, result);
          } catch (e) {
            // Filesystem errors carry absolute sandbox paths: never show those to agents or the public.
            const code = (e as NodeJS.ErrnoException)?.code;
            console.error(`[Prototype] materialize failed: ${errText(e)}`);
            this.reject(result, s, turnKey, `the prototype could not be prepared: ${code ? `file system error ${code}` : errText(e)}`);
          }
        }
      }
      for (const p of pendingRevise) {
        if (p.status !== "awaiting_decision") continue;
        p.decision = undefined;
        const why = result.rejected ? `: ${result.rejected}` : "";
        this.lastError.set(
          s,
          `You decided REVISE on ${p.id} but your turn had no valid <prototype revises="${p.id}"> block${why}. ` +
            `Include the revised prototype, or decide SCRAP or SHORTLIST.`
        );
      }
    }

    this.pushBoard();
    return result;
  }

  private reject(result: TurnResult, s: number, turnKey: number, error: string): void {
    result.rejected = error;
    this.lastError.set(s, error);
    this.byTurn.set(turnKey, { rejected: error });
  }

  private latest(id: string): Proto | undefined {
    let best: Proto | undefined;
    for (const p of this.protos) if (p.id === id && (!best || p.version > best.version)) best = p;
    return best;
  }

  private async materialize(
    parsed: ParsedPrototype,
    s: number,
    turnKey: number,
    base: Proto | undefined,
    result: TurnResult
  ): Promise<void> {
    const num = base ? base.num : this.nextNum;
    const version = base ? base.version + 1 : 1;
    const id = `P${num}`;
    const key = `${id}v${version}`;
    const label = `${id} v${version}`;
    const dir = join(this.sessionDir, key);
    // Non-recursive: if the session directory is gone (closed meanwhile), this fails instead of recreating it.
    await mkdir(dir, { mode: 0o700 });
    const appDir = join(dir, "files");
    let files: PrototypeFile[];
    try {
      await mkdir(appDir, { mode: 0o700 });
      files = await materializeFiles(appDir, parsed.files, { redactContent: this.opts.public });
    } catch (e) {
      await removeDir(dir);
      throw e;
    }
    if (!base) this.nextNum++;
    const pub = this.opts.public;
    const p: Proto = {
      id,
      version,
      label,
      key,
      num,
      title: pub ? redact(parsed.title).text : parsed.title,
      kind: parsed.kind,
      proposer: this.nameOf(s),
      proposerIndex: s,
      files,
      fileCount: files.length,
      ...(parsed.entry !== undefined && { entry: parsed.entry }),
      demo: pub ? redact(parsed.demo).text : parsed.demo,
      status: "live",
      verdicts: [],
      assessors: this.assessorsFor(s),
      assessed: new Set(),
      verdictMap: new Map(),
      turnKey,
      createdAt: this.now(),
      dir,
      appDir,
    };
    if (base) {
      base.status = "revised";
      base.supersededBy = label;
      base.files = [];
      if (base.decision?.decision !== "REVISE") base.decision = { decision: "REVISE", reason: "" };
    }
    this.protos.push(p);
    this.byTurn.set(turnKey, { key });
    this.pushBoard();

    // Screenshots (public sessions): read into memory before anything can destroy the directory.
    if (pub && this.screenshots && (p.kind === "web" || p.kind === "diagram")) {
      const chrome = findChrome();
      if (chrome) {
        try {
          const shotsDir = join(dir, "shots");
          await mkdir(shotsDir, { mode: 0o700 });
          const url =
            p.kind === "web"
              ? `${this.board.url}p/${key}/app/${(p.entry ?? "index.html").split("/").map(encodeURIComponent).join("/")}`
              : `${this.board.url}p/${key}/render`;
          const viewports = p.kind === "web" ? [DESKTOP_VIEWPORT, MOBILE_VIEWPORT] : [DESKTOP_VIEWPORT];
          const shots = await captureScreenshots(url, shotsDir, viewports, { chromePath: chrome });
          for (const shot of shots) {
            try {
              result.attachments.push({
                filename: `${key}-${shot.name}.png`,
                contentType: "image/png",
                bytes: await readFile(shot.path),
                caption: `${label} screenshot (${shot.name})`,
              });
            } catch {
              /* the directory may have been destroyed meanwhile */
            }
          }
        } catch (e) {
          console.error(`[Prototype] screenshots for ${label} failed: ${errText(e)}`);
        }
      }
    }

    result.created = { id, version, label, kind: p.kind, title: p.title, url: `${this.board.url}p/${key}/` };
    if (this.isClosed || p.status !== "live") return;
    p.timer = setTimeout(() => {
      void this.serial(() => this.expire(p));
    }, this.ttlMs);
    p.timer.unref?.();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run.catch((e) => {
      console.error(`[Prototype] ${errText(e)}`);
      return undefined;
    });
  }

  private async expire(p: Proto): Promise<void> {
    if (this.isClosed || p.status !== "live") return;
    await this.destroy(p, "expired");
  }

  /** Take the artifact off the board, then remove it from disk. Metadata stays. */
  private async destroy(p: Proto, status: PrototypeStatus): Promise<void> {
    if (p.timer) clearTimeout(p.timer);
    p.timer = undefined;
    p.status = status;
    const dir = p.dir;
    p.dir = undefined;
    p.appDir = undefined;
    // Only an assessed prototype awaiting its proposer's decision may still be shortlisted: keep its source.
    if (status !== "awaiting_decision") p.files = [];
    this.destroyedSinceCall.push(p.label);
    this.pushBoard();
    if (dir) await removeDir(dir);
  }

  private assessorsFor(s: number): number[] {
    const n = this.opts.participants.length;
    if (this.opts.assessorIsCaller || n < 2) return [CALLER];
    return Array.from({ length: n }, (_, i) => i).filter((i) => i !== s);
  }

  private nameOf(i: number): string {
    if (i === CALLER) return "caller";
    return this.opts.participants[i] ?? `participant ${i + 1}`;
  }

  // --------------------------------------------------------------------------
  // Views
  // --------------------------------------------------------------------------

  private toRecord(p: Proto, forPublic = false): PrototypeRecord {
    const label = (name: string) => (forPublic ? publicLabel(name) : name);
    return {
      id: p.id,
      version: p.version,
      label: p.label,
      key: p.key,
      title: p.title,
      kind: p.kind,
      proposer: label(p.proposer),
      files: p.files,
      fileCount: p.fileCount,
      ...(p.entry !== undefined && { entry: p.entry }),
      demo: p.demo,
      status: p.status,
      verdicts: p.assessors
        .filter((a) => p.verdictMap.has(a))
        .map((a) => ({ assessor: label(this.nameOf(a)), ...p.verdictMap.get(a)! })),
      ...(p.decision && { decision: p.decision }),
      ...(p.supersededBy && { supersededBy: p.supersededBy }),
    };
  }

  private awaitingNames(p: Proto): string[] {
    return p.status === "live" ? p.assessors.filter((a) => !p.assessed.has(a)).map((a) => this.nameOf(a)) : [];
  }

  private pushBoard(): void {
    const prototypes: BoardPrototype[] = this.protos.map((p) => {
      const { files: _files, ...rec } = this.toRecord(p);
      return {
        ...rec,
        awaiting: this.awaitingNames(p),
        createdAt: new Date(p.createdAt).toISOString(),
        ...(p.status === "live" && !!p.appDir && {
          live: { dir: p.appDir, files: p.files, ...(p.entry !== undefined && { entry: p.entry }) },
        }),
      };
    });
    try {
      this.board.update({ prototypes });
    } catch (e) {
      console.error(`[Prototype] board update failed: ${errText(e)}`);
    }
  }

  /**
   * Text to append to the speaker's prompt: prototypes awaiting their verdict (with the exact line
   * format), their own prototypes awaiting their decision (with all verdicts and reasons), their own
   * prototypes still under assessment, and their last validation error. "" when nothing applies.
   */
  statusPromptFor(speakerIndex: number): string {
    const lines: string[] = [];
    const toVerdict = this.protos.filter(
      (p) => p.status === "live" && p.assessors.includes(speakerIndex) && !p.assessed.has(speakerIndex)
    );
    if (toVerdict.length) {
      lines.push("Awaiting your verdict (judge the artifact itself and its demo, shown in full above):");
      for (const p of toVerdict) {
        lines.push(
          `- ${p.label} "${p.title}" (${p.kind}) by ${p.proposer}. Give a line: ` +
            `Verdict on ${p.id}: APPROVE|REVISE|REJECT — reason`
        );
      }
    }
    if (speakerIndex !== CALLER) {
      const toDecide = this.protos.filter((p) => p.proposerIndex === speakerIndex && p.status === "awaiting_decision");
      for (const p of toDecide) {
        const rec = this.toRecord(p);
        lines.push(`Your prototype ${p.label} "${p.title}" has been assessed and destroyed. Verdicts:`);
        if (rec.verdicts.length === 0) lines.push("- (none)");
        for (const v of rec.verdicts) lines.push(`- ${v.assessor}: ${v.verdict}${v.reason ? ` — ${v.reason}` : ""}`);
        lines.push(
          `Decide now with a line: Decision on ${p.id}: REVISE|SCRAP|SHORTLIST — reason. ` +
            `REVISE must include a new <prototype revises="${p.id}"> block in this same turn; SHORTLIST means it is shown to the human.`
        );
      }
      const own = this.protos.filter((p) => p.proposerIndex === speakerIndex && p.status === "live");
      for (const p of own) {
        lines.push(
          `Your prototype ${p.label} is still under assessment (awaiting verdicts from ${this.awaitingNames(p).join(", ")}); do not decide on it yet.`
        );
      }
    }
    const err = this.lastError.get(speakerIndex);
    if (err) lines.push(`Your last prototype block was rejected: ${err}. Fix it and emit the block again.`);
    return lines.length ? `\n\n## Prototype status\n${lines.join("\n")}` : "";
  }

  /** Agent-facing history: resolved prototypes become one-line stubs; live and undecided ones stay in full. */
  historyView(text: string, turnKey: number): string {
    const rec = this.byTurn.get(turnKey);
    if (!rec) return text;
    if (rec.rejected !== undefined) {
      return replacePrototypeBlock(text, `[Prototype block rejected: ${rec.rejected}]`, "[extra prototype block ignored]");
    }
    const p = this.protos.find((x) => x.key === rec.key);
    if (!p || p.status === "live" || p.status === "awaiting_decision") return text;
    return replacePrototypeBlock(text, renderStub(this.toRecord(p)), "[extra prototype block ignored]");
  }

  /** Public mirror text: any block becomes a Markdown reference (redacted source); board URLs are removed. */
  publicView(text: string, turnKey: number): string {
    let out = text;
    const rec = this.byTurn.get(turnKey);
    if (rec?.key) {
      const p = this.protos.find((x) => x.key === rec.key);
      if (p) out = replacePrototypeBlock(out, renderPublicPrototype(this.toRecord(p, true)), "_[extra prototype block omitted]_");
    } else if (rec?.rejected !== undefined) {
      out = replacePrototypeBlock(out, `_[prototype block rejected: ${rec.rejected}]_`, "_[extra prototype block omitted]_");
    }
    return this.scrubBoardUrl(out);
  }

  private scrubBoardUrl(s: string): string {
    const port = /:(\d+)\/$/.exec(this.board.url)?.[1];
    if (!port) return s;
    const re = new RegExp(String.raw`(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):${port}\b[^\s)"'\x60<>\]]*`, "gi");
    return s.replace(re, "[local prototype board]");
  }

  /** True while any prototype is live (under assessment). */
  hasLiveUnderAssessment(): boolean {
    return this.protos.some((p) => p.status === "live");
  }

  /** Summary for tool results; drains the "destroyed since last call" list. */
  takeCallSummary(): {
    board_url: string;
    live: Array<{ label: string; title: string; kind: PrototypeKind; proposer: string; url: string; awaiting_verdicts_from: string[] }>;
    destroyed_this_call: string[];
    notice: string;
  } {
    const destroyed = this.destroyedSinceCall;
    this.destroyedSinceCall = [];
    return {
      board_url: this.board.url,
      live: this.protos
        .filter((p) => p.status === "live")
        .map((p) => ({
          label: p.label,
          title: p.title,
          kind: p.kind,
          proposer: p.proposer,
          url: `${this.board.url}p/${p.key}/`,
          awaiting_verdicts_from: this.awaitingNames(p),
        })),
      destroyed_this_call: destroyed,
      notice: NOTICE,
    };
  }

  /** Outcomes of every version plus the shortlist (full source of shortlisted versions). */
  outcomesMarkdown(): string {
    const all = [...this.protos].sort((a, b) => a.num - b.num || a.version - b.version);
    const records = all.map((p) => this.toRecord(p));
    return renderOutcomesMarkdown(records, records.filter((r) => r.status === "shortlisted"));
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  /** Destroy every live artifact (status -> closed unless terminal), stop the board, remove the session dir. Idempotent. */
  close(reason: "ended" | "completed" | "shutdown"): Promise<void> {
    if (!this.closing) this.closing = this.doClose(reason);
    return this.closing;
  }

  private async doClose(_reason: "ended" | "completed" | "shutdown"): Promise<void> {
    this.isClosed = true;
    unregisterTracker(this);
    const dirs: string[] = [];
    for (const p of this.protos) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = undefined;
      if (p.status === "live" || p.status === "awaiting_decision") {
        if (p.status === "live") this.destroyedSinceCall.push(p.label);
        p.status = "closed";
        p.files = [];
      }
      if (p.dir) dirs.push(p.dir);
      p.dir = undefined;
      p.appDir = undefined;
    }
    this.pushBoard();
    await this.board.close().catch(() => undefined);
    for (const d of dirs) await removeDir(d);
    await removeDir(this.sessionDir);
    // A turn still in flight (e.g. a screenshot) could write after this point: clean again once it settles.
    void this.chain.then(() => removeDir(this.sessionDir));
  }

  /** Synchronous close for process 'exit'. */
  closeSync(): void {
    this.isClosed = true;
    unregisterTracker(this);
    for (const p of this.protos) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = undefined;
      if (p.status === "live" || p.status === "awaiting_decision") {
        p.status = "closed";
        p.files = [];
      }
      p.dir = undefined;
      p.appDir = undefined;
    }
    this.board.closeNow();
    removeDirSync(this.sessionDir);
  }
}
