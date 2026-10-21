import type { DuelOptions, DuelResult, Seat, TableObserver } from "./table/events.js";
import { parseFlags } from "./cli.js";
import { clean, createNdjsonObserver, createTerminalObserver, type TerminalOutput } from "./table/terminal.js";
import { readUserConfig, setUserConfig } from "./user-config.js";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubAndCap } from "./security/secrets.js";
import { validateDuelOptions } from "./table/duel-options.js";
import { isDuelId } from "./sessions/duel-import.js";
import { DUEL_KINDS } from "./table/prompts.js";

const HELP = `roundtable duel <brief> --team-a <a,...> --team-b <c,...> --judges <j,...> [options]
  teams have 1 to 4 members (first writes the concept, last builds, any between critique); 1 to 5 judges
  --open --no-room --no-hold   open the live room, skip it, or exit when the duel ends
  --json                       NDJSON events instead of the terminal view
  --seat <agent=provider-or-runtime:model,...>  --mix auto|cheap  --preflight | --no-preflight
  --kind web|code|diagram|text   what the teams build (default web)
  --criteria "a,b,c"           judging rubric (default: fit to the brief, quality, usability and accessibility, risk or safety)
  --rounds 1|2  --turn-timeout <s>  --max-seconds <s>  --agents-dir <abs-path>
  --dry-run                    replay the bundled synthetic duel (no keys)
  --replay <archive.json> [--speed <n>]   replay a saved duel
roundtable debate|waffle|meeting <topic> --agents <a,b> [--rounds n] [--seat ...] [--duel <duel-id>]
  --duel makes a saved duel the focus (its brief joins the context); the topic may then be omitted
roundtable config show | config set env-file|agents-dir <absolute-path>
`;
class UsageError extends Error { readonly exitCode = 2; }
type Flags = Record<string, string | true>;
export interface ParsedTableArgs { duelFocus?: import("./sessions/duel-focus.js").DuelFocus; topic: string; flags: Flags; options: DuelOptions; agents: string[] }
const values = ["team-a", "team-b", "judges", "agents", "agents-dir", "rounds", "kind", "criteria", "seat", "mix", "turn-timeout", "max-seconds", "replay", "speed", "duel"];
const switches = ["open", "no-room", "no-hold", "json", "dry-run", "preflight", "no-preflight", "no-duel-source"];
const list = (value: string | true | undefined): string[] => {
  if (value === undefined) return [];
  if (typeof value !== "string" || value.split(",").some(s => !s.trim())) throw new UsageError("Agent lists must be comma-separated non-empty identifiers.");
  return value.split(",").map(s => s.trim());
};
function positive(flags: Flags, key: string, fallback: number): number {
  const value = flags[key] === undefined ? fallback : Number(flags[key]);
  if (!Number.isFinite(value) || value <= 0 || (key !== "speed" && key !== "rounds" && value > 3600)) throw new UsageError(`--${key} must be a positive number${key === "speed" || key === "rounds" ? "" : " up to 3600"}.`);
  return value;
}
export function parseTableArgs(command: string, args: string[]): ParsedTableArgs {
  // Remove the positional topic before calling the shared strict flag parser.
  const topic = args[0] && !args[0].startsWith("--") ? args[0] : "";
  const parsed = parseFlags(topic ? args.slice(1) : args, { values, flags: switches });
  if (typeof parsed === "string") throw new UsageError(parsed);
  const replay = !!(parsed.replay || parsed["dry-run"]);
  if (parsed.duel !== undefined && (command === "duel" || typeof parsed.duel !== "string" || !isDuelId(parsed.duel))) throw new UsageError(command === "duel" ? "--duel is available for debate, waffle and meeting." : "--duel requires a duel id such as duel-<id>.");
  if (parsed["no-duel-source"] && parsed.duel === undefined) throw new UsageError("--no-duel-source requires --duel.");
  if (!topic.trim() && !replay && !(parsed.duel && command !== "duel")) throw new UsageError(`${command} requires a topic.`);
  if (replay && command !== "duel") throw new UsageError("Replay and dry-run are available for duel.");
  if (parsed.replay && parsed["dry-run"]) throw new UsageError("Use either --replay or --dry-run.");
  if (parsed.open && parsed["no-room"]) throw new UsageError("--open requires the room.");
  if (parsed.preflight && parsed["no-preflight"]) throw new UsageError("Use either --preflight or --no-preflight.");
  if (parsed.mix !== undefined && parsed.mix !== "auto" && parsed.mix !== "cheap") throw new UsageError("--mix must be auto or cheap.");
  if (typeof parsed["agents-dir"] === "string" && !isAbsolute(parsed["agents-dir"])) throw new UsageError("--agents-dir requires an absolute directory.");
  const rounds = positive(parsed, "rounds", command === "duel" ? 1 : 2);
  if (!Number.isInteger(rounds) || (command === "duel" ? rounds > 2 : rounds > 20)) throw new UsageError(command === "duel" ? "--rounds must be 1 or 2." : "--rounds must be a whole number from 1 to 20.");
  const teamA = list(parsed["team-a"]), teamB = list(parsed["team-b"]), judges = list(parsed.judges), agents = list(parsed.agents);
  if (command !== "duel" && (parsed.kind !== undefined || parsed.criteria !== undefined)) throw new UsageError("--kind and --criteria are available for duel.");
  if (parsed.kind !== undefined && !DUEL_KINDS.includes(parsed.kind as never)) throw new UsageError(`--kind must be one of ${DUEL_KINDS.join(", ")}.`);
  if (parsed.criteria !== undefined && typeof parsed.criteria !== "string") throw new UsageError("--criteria requires a comma-separated list.");
  // Commas split criteria; a ";" anywhere switches the separator, so a criterion may contain commas.
  const criteria = typeof parsed.criteria === "string"
    ? parsed.criteria.split(parsed.criteria.includes(";") ? ";" : ",").map(c => c.trim()) : undefined;
  if (criteria && (criteria.some(c => !c) || criteria.length > 8)) throw new UsageError("--criteria takes 1 to 8 non-empty items, separated by commas (or by ; when an item contains a comma).");
  if (!replay && command === "duel") {
    if (!teamA.length || !teamB.length || !judges.length) throw new UsageError("duel requires --team-a, --team-b and at least one judge.");
    try { validateDuelOptions({ topic, teamA, teamB, judges, kind: parsed.kind as never, criteria }); }
    catch (e) { throw new UsageError(e instanceof Error ? e.message : "Invalid duel options."); }
  }
  if (!replay && command !== "duel" && agents.length < 2) throw new UsageError(`${command} requires --agents with at least two personas.`);
  if (command === "duel" && parsed.agents) throw new UsageError("duel uses --team-a, --team-b and --judges.");
  if (command !== "duel" && (parsed["team-a"] || parsed["team-b"] || parsed.judges || parsed.open || parsed["no-room"] || parsed["no-hold"])) throw new UsageError("Team and room flags are available for duel.");
  const turnTimeoutMs = positive(parsed, "turn-timeout", 90) * 1000;
  const maxSeconds = positive(parsed, "max-seconds", 600);
  positive(parsed, "speed", 1);
  return { topic, flags: parsed, agents, options: { topic, teamA, teamB, judges, rounds: rounds as 1 | 2, turnTimeoutMs, ...(command !== "duel" || parsed["max-seconds"] !== undefined ? { maxSeconds } : {}), ...(parsed.kind && { kind: parsed.kind as never }), ...(criteria && { criteria }), ...(parsed.mix && { mix: parsed.mix as "auto" | "cheap" }), ...(typeof parsed["agents-dir"] === "string" && { agentsDir: parsed["agents-dir"] }) } };
}

/** Merge-time module contracts. String imports let the CLI build before the duel modules land. */
export interface TableRoom extends TableObserver { url?: string; close(): void | Promise<void> }
export interface TableCliModules {
  duel(): Promise<{ runDuel: (opts: DuelOptions, obs: TableObserver, signal: AbortSignal, seats?: Map<string, Seat>) => Promise<DuelResult> }>;
  room(): Promise<{ createRoom(options: { open: boolean }): Promise<TableRoom> }>;
  replay(): Promise<{ replayDuel(options: { archivePath?: string; dryRun: boolean; speed: number }, observer: TableObserver, signal: AbortSignal): Promise<DuelResult> }>;
}
const unavailable = (name: string) => new Error(`${name} not available in this build`);
async function load<T>(name: string): Promise<T> {
  try { return await import(`./table/${name}.js`) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") throw unavailable(name);
    throw error;
  }
}
const defaultModules: TableCliModules = {
  duel: async () => {
    const real = await load<typeof import("./table/duel.js")>("duel");
    return {
      // The CLI already resolved every seat (flags, mix, frontmatter, preflight); apply those to the loaded personas.
      runDuel: (opts, obs, signal, seats) => real.runDuel(opts, obs, signal, seats ? real.withChosenSeats(seats) : {}),
    };
  },
  room: async () => {
    const real = await load<typeof import("./table/room.js")>("room");
    return { createRoom: async ({ open }) => {
      const room = await real.startRoom({ open, hold: false });
      return { url: room.url, onEvent: e => room.observer.onEvent(e), close: () => room.close() };
    } };
  },
  replay: async () => {
    const real = await load<typeof import("./table/replay.js")>("replay");
    return { replayDuel: (options, obs, signal) => {
      const archivePath = options.archivePath ?? fileURLToPath(new URL("../examples/duel/demo.json", import.meta.url));
      return real.replayDuel(archivePath, obs, { speed: options.speed, signal });
    } };
  },
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
    if (args.includes("--help") || args.includes("-h")) { output.write(HELP); return 0; }
    if (command === "config") return configCommand(args, output);
    const parsed = parseTableArgs(command, args);
    if (parsed.options.agentsDir) process.env.ROUNDTABLE_AGENTS_DIR = parsed.options.agentsDir;
    const observer = parsed.flags.json ? createNdjsonObserver(output) : createTerminalObserver({ output });
    return await runTable(command, parsed, observer, io.modules ?? defaultModules, error);
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode === 2 ? 2 : 1;
    // Usage messages are locally generated; remote bodies may contain credentials or private paths.
    error.write(`roundtable: ${code === 2 || (e instanceof Error && /^(duel|room|replay) not available in this build$/.test(e.message)) ? (e as Error).message : `The session failed (${e instanceof Error ? scrubAndCap(`${e.name}: ${e.message}`.replace(/\s+/g, " "), 200) : "unknown error"}).`}\n`);
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
    // A bad or unknown duel fails here, before seats are prepared or any provider is called.
    if (!replay && command !== "duel" && typeof parsed.flags.duel === "string") {
      const { loadDuelFocus, defaultDuelTopic } = await import("./sessions/duel-focus.js");
      let focus;
      try { focus = loadDuelFocus(parsed.flags.duel, { source: !parsed.flags["no-duel-source"] }); } catch (e) { throw new UsageError(e instanceof Error ? e.message : "Unable to read the duel."); }
      parsed.duelFocus = focus;
      if (!parsed.topic.trim()) parsed.topic = defaultDuelTopic(focus);
    }
    if (!replay) {
      const { prepareSeats } = await import("./table/seats.js");
      seats = await prepareSeats(
        { ...(command === "duel" ? parsed.options : { agents: parsed.agents, agentsDir: parsed.options.agentsDir }), seat: parsed.flags.seat as string | undefined, mix: parsed.options.mix },
        { preflight: !parsed.flags["no-preflight"], signal: controller.signal, report: message => { error.write(`${clean(message)}\n`); } },
      );
      parsed.options.seats = Object.fromEntries([...seats].map(([id, seat]) => [id, { agent: id, provider: seat.provider, ...(seat.model && { model: seat.model }) }]));
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
      : await runner.runDuel(parsed.options, observer, controller.signal, seats);
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
      maxRounds: Number(parsed.flags.rounds ?? 2), ...(parsed.duelFocus && { duel: parsed.duelFocus }), seats: parsed.options.seats, origin, signal: stop,
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
