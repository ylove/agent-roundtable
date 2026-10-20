import type { DuelOptions, DuelResult, RunDuel, Seat, TableObserver } from "./table/events.js";
import { parseFlags } from "./cli.js";
import { createNdjsonObserver, createTerminalObserver, type TerminalOutput } from "./table/terminal.js";
import { readUserConfig, setUserConfig } from "./user-config.js";
import { isAbsolute } from "node:path";

class UsageError extends Error { readonly exitCode = 2; }
type Flags = Record<string, string | true>;
export interface ParsedTableArgs { topic: string; flags: Flags; options: DuelOptions; agents: string[] }
const values = ["team-a", "team-b", "judges", "agents", "agents-dir", "rounds", "seat", "mix", "turn-timeout", "max-seconds", "replay", "speed"];
const switches = ["open", "no-room", "no-hold", "json", "dry-run", "preflight", "no-preflight"];
const list = (value: string | true | undefined): string[] => {
  if (value === undefined) return [];
  if (typeof value !== "string" || value.split(",").some(s => !s.trim())) throw new UsageError("Agent lists must be comma-separated non-empty identifiers.");
  return value.split(",").map(s => s.trim());
};
function positive(flags: Flags, key: string, fallback: number): number {
  const value = flags[key] === undefined ? fallback : Number(flags[key]);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${key} must be a positive number.`);
  return value;
}
export function parseTableArgs(command: string, args: string[]): ParsedTableArgs {
  // Remove the positional topic before calling the shared strict flag parser.
  const topic = args[0] && !args[0].startsWith("--") ? args[0] : "";
  const parsed = parseFlags(topic ? args.slice(1) : args, { values, flags: switches });
  if (typeof parsed === "string") throw new UsageError(parsed);
  const replay = !!(parsed.replay || parsed["dry-run"]);
  if (!topic.trim() && !replay) throw new UsageError(`${command} requires a topic.`);
  if (replay && command !== "duel") throw new UsageError("Replay and dry-run are available for duel.");
  if (parsed.replay && parsed["dry-run"]) throw new UsageError("Use either --replay or --dry-run.");
  if (parsed.open && parsed["no-room"]) throw new UsageError("--open requires the room.");
  if (parsed.preflight && parsed["no-preflight"]) throw new UsageError("Use either --preflight or --no-preflight.");
  if (parsed.mix !== undefined && parsed.mix !== "auto" && parsed.mix !== "cheap") throw new UsageError("--mix must be auto or cheap.");
  if (typeof parsed["agents-dir"] === "string" && !isAbsolute(parsed["agents-dir"])) throw new UsageError("--agents-dir requires an absolute directory.");
  const rounds = positive(parsed, "rounds", command === "duel" ? 1 : 2);
  if (!Number.isInteger(rounds) || (command === "duel" ? rounds > 2 : rounds > 20)) throw new UsageError(command === "duel" ? "--rounds must be 1 or 2." : "--rounds must be a whole number from 1 to 20.");
  const teamA = list(parsed["team-a"]), teamB = list(parsed["team-b"]), judges = list(parsed.judges), agents = list(parsed.agents);
  if (!replay && command === "duel" && (teamA.length !== 2 || teamB.length !== 2 || !judges.length)) throw new UsageError("duel requires two agents per team and at least one judge.");
  if (!replay && command !== "duel" && agents.length < 2) throw new UsageError(`${command} requires --agents with at least two personas.`);
  if (command === "duel" && parsed.agents) throw new UsageError("duel uses --team-a, --team-b and --judges.");
  if (command !== "duel" && (parsed["team-a"] || parsed["team-b"] || parsed.judges || parsed.open || parsed["no-room"] || parsed["no-hold"])) throw new UsageError("Team and room flags are available for duel.");
  const turnTimeoutMs = positive(parsed, "turn-timeout", 90) * 1000;
  const maxSeconds = positive(parsed, "max-seconds", 420);
  positive(parsed, "speed", 1);
  return { topic, flags: parsed, agents, options: { topic, teamA, teamB, judges, rounds: rounds as 1 | 2, turnTimeoutMs, maxSeconds, ...(parsed.mix && { mix: parsed.mix as "auto" | "cheap" }), ...(typeof parsed["agents-dir"] === "string" && { agentsDir: parsed["agents-dir"] }) } };
}

/** Merge-time module contracts. String imports let the CLI build before the duel modules land. */
export interface TableRoom extends TableObserver { url?: string; close(): void | Promise<void> }
export interface TableCliModules {
  duel(): Promise<{ runDuel: RunDuel }>;
  room(): Promise<{ createRoom(options: { open: boolean }): Promise<TableRoom> }>;
  replay(): Promise<{ replayDuel(options: { archivePath?: string; dryRun: boolean; speed: number }, observer: TableObserver, signal: AbortSignal): Promise<DuelResult> }>;
}
async function optionalModule<T>(name: string): Promise<T> {
  try { return await import(`./table/${name}.js`) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") throw new Error(`${name} not available in this build`);
    throw error;
  }
}
const defaultModules: TableCliModules = {
  duel: () => optionalModule("duel"), room: () => optionalModule("room"), replay: () => optionalModule("replay"),
};
interface CliIO { output?: TerminalOutput; error?: TerminalOutput; modules?: TableCliModules }

function configCommand(args: string[], output: TerminalOutput): number {
  if (args.length === 1 && args[0] === "show") {
    const config = readUserConfig();
    output.write(`env-file: ${process.env.ROUNDTABLE_ENV_FILE !== undefined || config.envFile ? "set" : "unset"}\nagents-dir: ${process.env.ROUNDTABLE_AGENTS_DIR !== undefined || config.agentsDir ? "set" : "unset"}\n`);
    return 0;
  }
  if (args.length === 3 && args[0] === "set" && ["env-file", "agents-dir"].includes(args[1])) {
    try { setUserConfig(args[1] === "env-file" ? "envFile" : "agentsDir", args[2]); }
    catch { throw new UsageError("Unable to save configuration; use an absolute path to an accessible file or directory."); }
    output.write(`${args[1]}: set\n`);
    return 0;
  }
  throw new UsageError("Use config show or config set env-file|agents-dir <absolute-path>.");
}

export async function runTableCli(command: string, args: string[], io: CliIO = {}): Promise<number> {
  const output = io.output ?? process.stdout, error = io.error ?? process.stderr;
  try {
    if (command === "config") return configCommand(args, output);
    const parsed = parseTableArgs(command, args);
    if (parsed.options.agentsDir) process.env.ROUNDTABLE_AGENTS_DIR = parsed.options.agentsDir;
    const observer = parsed.flags.json ? createNdjsonObserver(output) : createTerminalObserver({ output });
    return await runTable(command, parsed, observer, io.modules ?? defaultModules, error);
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode === 2 ? 2 : 1;
    // Usage messages are locally generated; remote bodies may contain credentials or private paths.
    error.write(`roundtable: ${code === 2 || (e instanceof Error && /^(duel|room|replay) not available in this build$/.test(e.message)) ? (e as Error).message : "The session failed; check provider configuration and try again."}\n`);
    return code;
  }
}

async function runTable(command: string, parsed: ParsedTableArgs, terminal: TableObserver, modules: TableCliModules, error: TerminalOutput): Promise<number> {
  const { fanout } = await import("./table/events.js");
  const controller = new AbortController();
  let interrupts = 0, holding = false, releaseHold: (() => void) | undefined;
  const stop = () => {
    interrupts++;
    if (interrupts > 1) process.exit(controller.signal.aborted ? 1 : 0);
    if (holding) { releaseHold?.(); return; }
    controller.abort();
  };
  process.on("SIGINT", stop);
  let room: TableRoom | undefined;
  try {
    let observer = terminal;
    const replay = !!(parsed.flags.replay || parsed.flags["dry-run"]);
    let seats = new Map<string, Seat>();
    if (!replay) {
      const { prepareSeats } = await import("./table/seats.js");
      seats = await prepareSeats(
        { ...(command === "duel" ? parsed.options : { agents: parsed.agents, agentsDir: parsed.options.agentsDir }), seat: parsed.flags.seat as string | undefined, mix: parsed.options.mix },
        { preflight: !parsed.flags["no-preflight"] && !!(parsed.flags.preflight || parsed.options.mix), signal: controller.signal, report: message => { error.write(`${message}\n`); } },
      );
      parsed.options.seats = Object.fromEntries([...seats].map(([id, seat]) => [id, { agent: id, provider: seat.provider, model: seat.model }]));
    }
    if (command !== "duel") return await runDiscussion(command, parsed, seats, terminal, controller.signal);
    const runner = replay ? await modules.replay() : await modules.duel();
    if (!("runDuel" in runner) && !("replayDuel" in runner)) throw new Error(`${replay ? "replay" : "duel"} not available in this build`);
    if (!parsed.flags["no-room"]) {
      try { room = await (await modules.room()).createRoom({ open: !!parsed.flags.open }); }
      catch (e) {
        if (parsed.flags.open || !(e instanceof Error) || e.message !== "room not available in this build") throw e;
        error.write("roundtable: room not available in this build\n");
      }
      if (room) {
        observer = fanout(terminal, room);
        if (room.url) error.write(`Room: ${room.url}\n`);
      }
    }
    const result = "replayDuel" in runner
      ? await runner.replayDuel({ archivePath: parsed.flags.replay as string | undefined, dryRun: !!parsed.flags["dry-run"], speed: positive(parsed.flags, "speed", 1) }, observer, controller.signal)
      : await runner.runDuel(parsed.options, observer, controller.signal);
    if (room && !parsed.flags["no-hold"]) {
      error.write("Room stays open; press Ctrl-C to exit.\n");
      holding = true;
      await new Promise<void>(resolve => { releaseHold = resolve; });
    }
    return result.aborted || controller.signal.aborted || result.winner === "none" ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", stop);
    await room?.close();
  }
}

async function runDiscussion(command: string, parsed: ParsedTableArgs, seats: Map<string, Seat>, observer: TableObserver, signal: AbortSignal): Promise<number> {
  const sessions = await import("./sessions/collaborations.js");
  const { day, readTableLines } = await import("./usage/table.js");
  const origin = `cli-${crypto.randomUUID()}`;
  const limits = new AbortController();
  const stop = AbortSignal.any([signal, limits.signal]);
  let id: string | undefined;
  let pending = Promise.resolve();
  const days = new Set([day()]);
  const abort = () => limits.abort(new Error("Session time limit reached."));
  const deadline = setTimeout(abort, parsed.options.maxSeconds! * 1000);
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const resetTurn = () => { clearTimeout(turnTimer); turnTimer = setTimeout(abort, parsed.options.turnTimeoutMs); };
  sessions.setCollaborationRecordHook((c, message) => {
    if (c.origin !== origin) return;
    id = c.id;
    const seat = seats.get(message.agent);
    if (!seat) return;
    const event = { type: "turn" as const, round: String(c.currentRound + 1), seat, text: message.content, ts: message.timestamp.toISOString() };
    pending = pending.then(async () => { await observer.onEvent(event); });
    resetTurn();
  });
  try {
    stop.throwIfAborted();
    resetTurn();
    const started = await sessions.startCollaboration(parsed.agents, parsed.topic, {
      mode: command === "debate" ? "debate" : command === "waffle" ? "waffle-house" : "collaborate",
      maxRounds: Number(parsed.flags.rounds ?? 2), seats: parsed.options.seats, origin, signal: stop,
    });
    id = started.collaborationId;
    const collaboration = sessions.collaborations.get(id)!;
    while (collaboration.status === "running") {
      stop.throwIfAborted();
      await sessions.advanceCollaboration(collaboration);
    }
    await pending;
    return stop.aborted ? 1 : 0;
  } finally {
    clearTimeout(deadline); clearTimeout(turnTimer);
    sessions.setCollaborationRecordHook(undefined);
    if (id && sessions.collaborations.has(id)) await sessions.endCollaboration(id, false);
    await pending;
    if (id) {
      days.add(day());
      const totals = new Map<string, { seatId: string; inputTokens: number; outputTokens: number; costUsd: number }>();
      for (const line of readTableLines([...days]).filter(line => line.session === id)) {
        const entry = totals.get(line.agent) ?? { seatId: line.agent, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        entry.inputTokens += line.tokens?.input ?? 0; entry.outputTokens += line.tokens?.output ?? 0; entry.costUsd += line.usd ?? 0;
        totals.set(line.agent, entry);
      }
      await observer.onEvent({ type: "usage", perSeat: [...totals.values()], totalCostUsd: [...totals.values()].reduce((n, s) => n + s.costUsd, 0) });
      await observer.onEvent({ type: "end", winner: "none", tally: { A: 0, B: 0 }, aborted: stop.aborted });
    }
  }
}
