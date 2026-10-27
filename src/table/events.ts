import { PROVIDER_IDS } from "../config.js";
import { getRuntime } from "../runtimes/registry.js";
import type { PrototypeKind } from "../prototypes/parse.js";

/** What a duel's teams build: the same kinds prototype mode supports. */
export type DuelKind = PrototypeKind;

/** A participant and the model used for their turns at the table. */
export interface Seat {
  id: string;
  name: string;
  role?: string;
  /** Provider judgment, carried into start events and seat cards. */
  reason?: string;
  maxOutputTokens?: number;
  team?: "A" | "B" | "judge";
  /** API provider or explicit runtime registry name. */
  provider: string;
  /** Empty for a runtime whose own default model is selected. */
  model: string;
}

/** How a team is doing, recomputed as the duel runs: the process record judges and people weigh with the result. */
export interface TeamMetrics {
  /** Active wall-clock time from the team's first turn to its last finished stage, or to now while it works. Time spent stopped is excluded. */
  elapsedMs: number;
  /** When the team's last stage finished (ISO 8601); absent while it is still building. */
  finishedAt?: string;
  stagesDone: number;
  stagesTotal: number;
  inputTokens: number;
  outputTokens: number;
  /** Cost of the priced calls only, as in the usage event. */
  costUsd: number;
  unpricedTokens: number;
  estimated?: boolean;
  /** Model turns that completed, and turns that timed out or failed. */
  turns: number;
  failedTurns: number;
  /** Valid prototype versions the team produced. */
  versions: number;
  /** Build attempts that had to be redone: retries after a failed validation or page check, and revision rounds. */
  rewrites: number;
  /** Artifacts rejected by validation (format, size, external references). */
  validationFailures: number;
  /** Console errors and uncaught exceptions the page checks found, summed over the team's versions. */
  pageErrors: number;
  /** Connector tool calls made by the team's seats. */
  toolCalls: number;
}

/** What a person may do to a running duel: stop it, resume it from where it stopped, or choose the winner when they judge. */
export type DuelCommand = { action: "stop" } | { action: "resume" } | { action: "choose"; team: "A" | "B" };
/** Where a command came from. */
export type DuelCommandSource = "room" | "terminal" | "tool";
/**
 * The only input a person has during a duel. The CLI creates one, passes it to the runner (which acts on it) and to
 * the room (which offers only the commands available now). Replays and dry runs have none, so the room shows no controls.
 */
export interface DuelControls {
  available(): { stop: boolean; resume: boolean; choose: boolean };
  /** False when the command is not available now; otherwise it is acted on asynchronously. */
  send(command: DuelCommand, by: DuelCommandSource): boolean;
}

/** Events shared by duel runners, terminal renderers, and local web rooms. */
export type TableEvent =
  /** A duel begins; startedAt is an ISO 8601 timestamp. */
  | {
      type: "start";
      id: string;
      topic: string;
      mode: "duel" | "meeting" | "debate" | "waffle" | "casting";
      seats: Seat[];
      startedAt: string;
      /** Added in the general duel: absent in older archives, which were all web. */
      kind?: DuelKind;
      /** The judging rubric the judges were given. */
      criteria?: string[];
      /** Seat ids per team, in speaking order (concept first, builder last). */
      teams?: { A: string[]; B: string[] };
      /** Build stages per team (absent in older archives: one build). */
      stages?: { index: number; name: string }[];
      /** A person chooses the winner in the room; judges, if any, advise. */
      humanJudge?: boolean;
      /** Set when this run continues a stopped duel: the id is unchanged and earlier events are not repeated. */
      resumed?: boolean;
    }
  /** A team's build stage starts, finishes, fails (the previous version stands) or is skipped at the deadline. */
  | { type: "stage"; team: "A" | "B"; stage: number; of: number; name: string; status: "started" | "done" | "failed" | "skipped"; ts: string; version?: number }
  /** Each team's process record, sent whenever it changes. */
  | { type: "metrics"; teams: Record<"A" | "B", TeamMetrics>; ts: string }
  /** The duel stopped (in-flight turns are abandoned and a checkpoint is written) or resumed from that checkpoint. */
  | { type: "control"; action: "stopped" | "resumed"; by: DuelCommandSource | "deadline"; ts: string }
  /** With a human judge: the duel waits for the choice, then records it. */
  | { type: "decision"; status: "awaiting"; ts: string }
  | { type: "decision"; status: "made"; by: "human"; winner: "A" | "B"; version?: number; ts: string }
  /** A participant speaks; ts is an ISO 8601 timestamp. */
  | { type: "turn"; round: string; seat: Seat; text: string; ts: string }
  /** A team submits prototype files or reports a failed attempt. */
  | {
      type: "prototype";
      team: "A" | "B";
      seat: Seat;
      title?: string;
      kind?: DuelKind;
      files: { path: string; bytes: number }[];
      ok: boolean;
      error?: string;
      version?: number;
      /** The build stage that produced this version (1-based); absent for a single build. */
      stage?: number;
      check?: import("../prototypes/page-check.js").PageCheck;
    }
  /** A judge assesses a team's submission. */
  | {
      type: "assessment";
      judge: Seat;
      team: "A" | "B";
      verdict: "APPROVE" | "REVISE" | "REJECT" | "UNCLEAR";
      reason: string;
      version?: number;
    }
  /** A participant records a dissent, optionally concerning a team. */
  | { type: "dissent"; seat: Seat; text: string; team?: "A" | "B" }
  /** Token usage and cost totals for the duel. */
  | {
      type: "usage";
      perSeat: {
        seatId: string;
        inputTokens: number;
        outputTokens: number;
        /** Cost of the priced calls only; a model with no known price adds nothing here. */
        costUsd: number;
        /** Tokens from calls with no known price: shown as tokens with "no price", never as $0.00. */
        unpricedTokens?: number;
        /** True when any of the seat's token counts were estimated rather than reported by the provider. */
        estimated?: boolean;
      }[];
      totalCostUsd: number;
      totalUnpricedTokens?: number;
    }
  | { type: "roster"; report: import("../casting/report.js").CastingReport }
  /** The final outcome, including an optional archive location. */
  | {
      type: "end";
      mode?: "casting";
      winner: "A" | "B" | "tie" | "none";
      tally: { A: number; B: number };
      aborted?: boolean;
      archivePath?: string;
      /** Who decided: the judges' tally, or a person in the room. */
      decidedBy?: "judges" | "human";
      /** The winning artifact, saved for further use (the path is relative to ROUNDTABLE_HOME). */
      chosen?: ChosenArtifact;
      /** Stopped rather than finished: `roundtable duel --resume <id>` continues it. */
      resumable?: boolean;
      metrics?: Record<"A" | "B", TeamMetrics>;
    };

/** The artifact a duel settles on: the winner's judged version, copied out of the sandbox before it is removed. */
export interface ChosenArtifact { team: "A" | "B"; version: number; dir: string; files: string[] }

/** A consumer of table events; asynchronous consumers may finish before the next event. */
export interface TableObserver {
  onEvent(e: TableEvent): void | Promise<void>;
}

/** Deliver to every observer and await completion, swallowing each observer's errors. */
export function fanout(...observers: TableObserver[]): TableObserver {
  return {
    async onEvent(e) {
      await Promise.all(observers.map(async (observer) => {
        try {
          await observer.onEvent(e);
        } catch {
          // A failed renderer must not interrupt other consumers or the duel.
        }
      }));
    },
  };
}

/** An agent reference with optional provider/runtime and model overrides. */
export interface SeatSpec {
  agent: string;
  provider?: string;
  model?: string;
}

/** Parse agent, agent=provider, or agent=provider:model, preserving model colons and slashes. */
export function parseSeat(s: string): SeatSpec {
  const equals = s.indexOf("=");
  const agent = (equals === -1 ? s : s.slice(0, equals)).trim();
  if (!agent) throw new Error("Seat agent must not be empty.");
  if (equals === -1) return { agent };

  const override = s.slice(equals + 1);
  const colon = override.indexOf(":");
  const provider = (colon === -1 ? override : override.slice(0, colon)).trim();
  if (!(PROVIDER_IDS as readonly string[]).includes(provider) && !getRuntime(provider)) {
    throw new Error(`Unknown provider or runtime "${provider}". Valid providers: ${PROVIDER_IDS.join(", ")}; list runtimes with roundtable runtimes.`);
  }
  if (colon === -1) return { agent, provider };

  const model = override.slice(colon + 1).trim();
  if (!model) throw new Error("Seat model must not be empty after ':'.");
  return { agent, provider, model };
}

/** Inputs for a two-team duel, with optional seat overrides and execution limits. */
export interface DuelOptions {
  topic: string;
  teamA: string[];
  teamB: string[];
  judges: string[];
  rounds?: 1 | 2;
  /** Build stages per team, 1 to 4; default 4 for web and 1 for the other kinds. */
  stages?: number;
  /** A person chooses the winner in the room. Judges become optional and advisory. */
  humanJudge?: boolean;
  /** Continue a stopped duel from its checkpoint (a duel id). Every other option comes from the checkpoint. */
  resume?: string;
  pageCheck?: boolean;
  /** Artifact kind both teams build; default web. */
  kind?: DuelKind;
  /** Judging rubric; default is fit to the brief, quality, usability and accessibility, and risk or safety. */
  criteria?: string[];
  turnTimeoutMs?: number;
  maxSeconds?: number;
  seats?: Record<string, SeatSpec>;
  mix?: "auto" | "cheap";
  agentsDir?: string;
  /** Configured MCP connectors every seat may use as tools during its turns (read-only tools unless the config lists more). */
  connectors?: string[];
  /** Limits a persona to some of those connectors (persona name to connector names); other seats get them all. */
  seatConnectors?: Record<string, string[]>;
}

/** The outcome returned after a duel finishes or is aborted. */
export interface DuelResult {
  id: string;
  winner: "A" | "B" | "tie" | "none";
  tally: { A: number; B: number };
  archivePath?: string;
  aborted: boolean;
  decidedBy?: "judges" | "human";
  chosen?: ChosenArtifact;
  /** Stopped with a checkpoint; resume with `resume: <id>`. */
  resumable?: boolean;
  metrics?: Record<"A" | "B", TeamMetrics>;
}

/** A cancellable duel runner that streams its progress to an observer. */
export type RunDuel = (opts: DuelOptions, obs: TableObserver, signal: AbortSignal) => Promise<DuelResult>;
