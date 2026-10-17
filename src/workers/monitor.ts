// ============================================================================
// RunMonitor: tail one worker run's output file and turn it into event drafts
//
// The runner (WS08) owns one monitor per live run. poll() reads the complete lines appended to
// runs/<attempt>.jsonl since the last poll, feeds them to the driver's parser, and returns drafts:
//   agent.attested         once, when system/init names the tools and MCP servers (claude-code)
//   budget.usage_recorded  when the run reports its result (source "worker"; estimated: false
//                          when the CLI reported a dollar cost, else priced from the pricing table;
//                          provenance: tokens measured, usd measured or estimated the same way)
// finish() reads what is left and adds agent.exited with its reason; a run that ended without a
// result line records the per-message usage it had seen, priced from the table (estimated).
// The caller appends the drafts in store.transact and kills the worker when attestation fails.
// ============================================================================

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { capPathList } from "../execution/leases.js";
import { estimateUsd } from "../execution/pricing.js";
import type { AnyEventDraft, EventPayloads, EventSource, RunAccumulator, TokenUsage } from "../execution/types.js";
import { attest, messageUsageTotal, newAccumulator, WORKER_ATTESTATION, type AttestationExpectation, type AttestationResult, type WorkerRunAccumulator } from "./claude-code.js";

export type ExitReason = EventPayloads["agent.exited"]["reason"];

export interface RunMonitorOptions {
  /** runs/<attempt>.jsonl of this run. */
  path: string;
  /** The driver's line parser (WorkerDriver.parse). */
  parse: (line: string, acc: RunAccumulator) => void;
  agent: string;
  task: string;
  /** Source stamped on the drafts (default: the runner). */
  source?: EventSource;
  /** Attestation expectation; null skips attestation (drivers without system/init, such as codex). */
  expected?: AttestationExpectation | null;
  /** The provider recorded on usage ("claude-code", "codex"). */
  provider?: string;
  /** The model to record when the stream names none. */
  model?: string;
  /** Start reading here (an adopted run resumes where the last runner stopped); default 0. */
  offset?: number;
  /** Parser state persisted by the runner after committing the corresponding drafts. */
  checkpoint?: MonitorCheckpoint;
}

export interface MonitorCheckpoint {
  acc: WorkerRunAccumulator;
  attestation?: AttestationResult;
  usageRecorded: boolean;
}

export interface MonitorPoll {
  drafts: AnyEventDraft[];
  /** Set on the poll that saw system/init. */
  attestation?: AttestationResult;
  /** A result line has been seen. */
  done: boolean;
  /** Bytes read by this poll (0 means no new output: input for stall detection). */
  bytes: number;
}

const CHUNK = 1 << 20;
/** Longer lines (a huge tool result) are skipped rather than buffered. */
const MAX_LINE_BYTES = 8 << 20;

export class RunMonitor {
  readonly acc: WorkerRunAccumulator = newAccumulator();
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  attestation?: AttestationResult;
  private readonly o: RunMonitorOptions;
  private readonly source: EventSource;
  private pending: Buffer = Buffer.alloc(0);
  private skipping = false;
  private usageRecorded = false;
  private finished = false;

  constructor(opts: RunMonitorOptions) {
    this.o = opts;
    this.offset = opts.offset ?? 0;
    this.source = opts.source ?? { kind: "runner", id: "runner", pid: process.pid };
    if (opts.checkpoint) {
      Object.assign(this.acc, structuredClone(opts.checkpoint.acc));
      this.attestation = opts.checkpoint.attestation;
      this.usageRecorded = opts.checkpoint.usageRecorded;
    }
  }

  checkpoint(): MonitorCheckpoint {
    return structuredClone({ acc: this.acc, ...(this.attestation && { attestation: this.attestation }), usageRecorded: this.usageRecorded });
  }

  /** New complete lines since the last call, parsed. A missing file reads as no output yet. */
  poll(): MonitorPoll {
    const drafts: AnyEventDraft[] = [];
    const sawInit = this.acc.tools !== undefined;
    const bytes = this.readNew();
    let attestation: AttestationResult | undefined;
    if (!sawInit && this.acc.tools !== undefined && this.o.expected !== null) {
      attestation = this.attestation = attest(this.acc, this.o.expected ?? WORKER_ATTESTATION);
      drafts.push({
        type: "agent.attested",
        source: this.source,
        payload: {
          agent: this.o.agent,
          tools: capPathList(attestation.tools, 3000),
          mcp_servers: capPathList(attestation.mcp_servers, 1000),
          ok: attestation.ok,
        },
      });
    }
    if (this.acc.done && !this.usageRecorded) {
      this.usageRecorded = true;
      drafts.push(this.usageDraft(this.acc.usage ?? { inputTokens: 0, outputTokens: 0 }, this.acc.costUsd));
    }
    return { drafts, ...(attestation && { attestation }), done: this.acc.done, bytes };
  }

  /**
   * The run's process has exited: read the rest and add agent.exited. `reason` overrides the
   * inferred one (the runner knows when it killed a worker for a stall, a budget or attestation).
   */
  finish(exit: { code: number | null; signal?: string | null; reason?: ExitReason }): AnyEventDraft[] {
    if (this.finished) return [];
    this.finished = true;
    const { drafts } = this.poll();
    if (this.pending.length && !this.skipping) {
      this.o.parse(this.pending.toString("utf8"), this.acc); // a last line without its newline
      this.pending = Buffer.alloc(0);
      if (this.acc.done && !this.usageRecorded) {
        this.usageRecorded = true;
        drafts.push(this.usageDraft(this.acc.usage ?? { inputTokens: 0, outputTokens: 0 }, this.acc.costUsd));
      }
    }
    if (!this.usageRecorded) {
      const seen = messageUsageTotal(this.acc);
      if (seen) {
        this.usageRecorded = true;
        drafts.push(this.usageDraft(seen, undefined));
      }
    }
    if (!this.attestation && this.o.expected !== null) {
      const a = this.attestation = attest(this.acc, this.o.expected ?? WORKER_ATTESTATION);
      drafts.push({ type: "agent.attested", source: this.source, payload: { agent: this.o.agent, tools: capPathList(a.tools, 3000), mcp_servers: capPathList(a.mcp_servers, 1000), ok: a.ok } });
    }
    const payload: EventPayloads["agent.exited"] = {
      agent: this.o.agent,
      task: this.o.task,
      code: exit.code === null || Number.isSafeInteger(exit.code) ? exit.code : null,
      reason: exit.reason ?? this.inferReason(exit),
    };
    if (this.acc.resultSubtype) payload.result_subtype = this.acc.resultSubtype;
    const usage = this.acc.usage ?? messageUsageTotal(this.acc);
    if (usage) payload.usage = usage;
    drafts.push({ type: "agent.exited", source: this.source, payload });
    return drafts;
  }

  private inferReason(exit: { code: number | null; signal?: string | null }): ExitReason {
    if (this.attestation && !this.attestation.ok) return "attestation";
    if (this.acc.resultSubtype === "error_max_budget_usd") return "budget";
    if (exit.signal) return "killed";
    if (exit.code === 0 && this.acc.done && !this.acc.isError) return "completed";
    return "error";
  }

  /** A reported cost is used as is; otherwise the tokens are priced from the table, and the record is estimated. */
  private usageDraft(tokens: TokenUsage, costUsd: number | undefined): AnyEventDraft {
    const model = this.acc.model ?? this.o.model ?? this.o.provider ?? "unknown";
    const payload: EventPayloads["budget.usage_recorded"] = {
      source: "worker",
      agent: this.o.agent,
      task: this.o.task,
      model,
      tokens,
      usd: costUsd ?? estimateUsd(model, tokens).usd,
      estimated: costUsd === undefined,
      // The CLI counted the tokens; the dollars are its own cost when it reported one, else ours.
      provenance: { tokens: "measured", usd: costUsd === undefined ? "estimated" : "measured" },
    };
    if (this.o.provider) payload.provider = this.o.provider;
    return { type: "budget.usage_recorded", source: this.source, payload };
  }

  /** Read and parse what was appended; returns the bytes read. */
  private readNew(): number {
    let fd: number;
    try {
      fd = openSync(this.o.path, "r");
    } catch {
      return 0;
    }
    let total = 0;
    try {
      const size = fstatSync(fd).size;
      let pos = this.offset + this.pending.length;
      if (size < pos) {
        // Truncated under us: start over from the beginning of what remains.
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        pos = 0;
      }
      const buf = Buffer.alloc(CHUNK);
      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        total += n;
        this.consume(buf.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    return total;
  }

  private consume(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, i);
      const lineBytes = this.pending.length + piece.length;
      if (!this.skipping && lineBytes <= MAX_LINE_BYTES) {
        const line = this.pending.length ? Buffer.concat([this.pending, piece]) : piece;
        const text = line.toString("utf8").trim();
        if (text) this.o.parse(text, this.acc);
      }
      this.offset += lineBytes + 1;
      this.pending = Buffer.alloc(0);
      this.skipping = false;
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    if (!rest.length) return;
    if (this.skipping || this.pending.length + rest.length > MAX_LINE_BYTES) {
      // Too long to keep: count it as consumed so the offset still advances past it.
      if (!this.skipping) {
        this.offset += this.pending.length;
        this.pending = Buffer.alloc(0);
      }
      this.skipping = true;
      this.offset += rest.length;
      return;
    }
    this.pending = Buffer.concat([this.pending, rest]);
  }
}
