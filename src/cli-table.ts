import type { DuelControls, DuelOptions, DuelResult, Seat, TableObserver } from "./table/events.js";
import { parseFlags } from "./cli.js";
import { clean, createNdjsonObserver, createTerminalObserver, type TerminalOutput } from "./table/terminal.js";
import { readUserConfig, setUserConfig, setNotifyConfig, setSecretConfig, setConnectorConfig, unsetConfigEntry } from "./user-config.js";
import { resolveSecret } from "./secrets/broker.js";
import { secretReason } from "./secrets/backends.js";
import { parseSecretRef } from "./secrets/ref.js";
import { ENV_NAME } from "./connectors/config.js";
import { trustConnector } from "./connectors/pin.js";
import { assertSeatConnectors, parseSeatConnectorsFlag, type SeatConnectorMap } from "./table/seat-connectors.js";
import { createDuelControls } from "./table/controls.js";
import { readCheckpoint } from "./table/checkpoint.js";
import { exportChosenArtifact, validateDuelOutputDir } from "./table/artifacts.js";
import type { DuelInput, DuelDependencies } from "./table/duel.js";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubAndCap } from "./security/secrets.js";
import { validateDuelOptions } from "./table/duel-options.js";
import { isDuelId } from "./sessions/duel-import.js";
import { DUEL_KINDS } from "./table/prompts.js";

const HELP = `roundtable duel <brief> --team-a <a,...> --team-b <c,...> --judges <j,...> [options]
  teams have 1 to 4 members (first writes the concept, last builds, any between critique); 1 to 5 judges unless --human-judge
  --open --no-room --no-hold   open the live room, skip it, or exit when the duel ends
  --json                       NDJSON events instead of the terminal view
  --seat <agent=provider-or-runtime:model,...>  --mix auto|cheap  --preflight | --no-preflight
  --kind web|code|diagram|text   what the teams build (default web)
  --criteria "a,b,c"           judging rubric (default: fit to the brief, quality, usability and accessibility, risk or safety, process efficiency)
  --stages <1-4>               build stages (web default 4; other kinds 1)
  --human-judge                a person chooses; judges, if given, advise
  --resume <duel-id>           continue a stopped duel from its checkpoint
  --out <dir>                  export the chosen artifact; never overwrite
  --layout auto|split|stack    terminal layout (default auto)
  --no-page-check              skip headless page checks
  --connectors <a,b>           let every seat call these configured MCP connectors (read-only tools unless the config lists more)
  --seat-connectors <s=a+b,...> limit a seat to some of those connectors, e.g. ada=figma,bob=jira+figma (others get all)
  --rounds 1|2  --turn-timeout <s>  --max-seconds <s>  --agents-dir <abs-path>
  --dry-run                    replay the bundled synthetic duel (no keys)
  --replay <archive.json> [--speed <n>]   replay a saved duel
roundtable debate|waffle|meeting <topic> --agents <a,b> [--rounds n] [--seat ...] [--duel <duel-id>] [--connectors <a,b>] [--seat-connectors <seat=a+b,...>]
  --duel makes a saved duel the focus (its brief joins the context); the topic may then be omitted
roundtable config show | config set env-file|agents-dir <absolute-path>
roundtable config set secret <ENV_NAME> <secret://ref> | config unset secret <ENV_NAME>
roundtable config set connector <name> --command <absolute-path> [--arg value] [--env VAR=secret://ref] [--tool name]
roundtable config unset connector <name> | secrets check
roundtable connectors trust <name>
`;
class UsageError extends Error { readonly exitCode = 2; }
/** A turn or session deadline passed: reported as a timeout, never as a person stopping the session. */
class TimeoutReport extends Error { constructor(message: string) { super(message); this.name = "TimeoutReport"; } }
/** A closed pipe (`... | head`) ends the process quietly instead of printing a stack trace. */
const guarded = new WeakSet<object>();
function quietOnClosedPipe(stream: NodeJS.WriteStream): void {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  stream.on("error", error => { if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0); throw error; });
}
type Flags = Record<string, string | true>;
export interface ParsedTableArgs { duelFocus?: import("./sessions/duel-focus.js").DuelFocus; topic: string; flags: Flags; options: DuelOptions; agents: string[] }
const values = ["team-a", "team-b", "judges", "agents", "agents-dir", "rounds", "kind", "criteria", "seat", "mix", "turn-timeout", "max-seconds", "replay", "speed", "duel", "connectors", "seat-connectors", "stages", "resume", "out", "layout"];
const switches = ["open", "no-room", "no-hold", "json", "dry-run", "preflight", "no-preflight", "no-duel-source", "no-page-check", "human-judge"];
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
  if (parsed.layout !== undefined && !["auto", "split", "stack"].includes(String(parsed.layout))) throw new UsageError("--layout must be auto, split or stack.");
  if (command !== "duel" && ["stages", "human-judge", "resume", "out"].some(k => parsed[k] !== undefined)) throw new UsageError("--stages, --human-judge, --resume and --out are available for duel.");
  if (parsed.resume !== undefined) {
    if (!isDuelId(parsed.resume)) throw new UsageError("--resume requires a duel id, never a path.");
    if (topic || Object.keys(parsed).some(k => !["resume", "open", "no-room", "no-hold", "json", "layout", "out"].includes(k))) throw new UsageError("--resume cannot be combined with a topic or duel options; everything comes from the checkpoint.");
    if (parsed.open && parsed["no-room"]) throw new UsageError("--open requires the room.");
    return { topic: "", flags: parsed, agents: [], options: { resume: parsed.resume } as DuelOptions };
  }
  const stages = parsed.stages === undefined ? undefined : Number(parsed.stages);
  if (stages !== undefined && (!Number.isInteger(stages) || stages < 1 || stages > 4)) throw new UsageError("--stages must be an integer from 1 to 4.");
  if (replay && (parsed["human-judge"] || parsed.stages !== undefined)) throw new UsageError("--human-judge and --stages are unavailable with replay or dry-run.");
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
  const connectors = list(parsed.connectors);
  if (connectors.length && replay) throw new UsageError("--connectors is not available with replay or dry-run.");
  const teamA = list(parsed["team-a"]), teamB = list(parsed["team-b"]), judges = list(parsed.judges), agents = list(parsed.agents);
  let seatConnectors: SeatConnectorMap | undefined;
  if (parsed["seat-connectors"] !== undefined) {
    if (typeof parsed["seat-connectors"] !== "string") throw new UsageError("--seat-connectors expects seat=connector pairs such as ada=figma,bob=jira+figma.");
    if (!connectors.length) throw new UsageError("--seat-connectors requires --connectors.");
    try { seatConnectors = assertSeatConnectors(parseSeatConnectorsFlag(parsed["seat-connectors"]), connectors, command === "duel" ? [...teamA, ...teamB, ...judges] : agents); }
    catch (e) { throw new UsageError(e instanceof Error ? e.message : "Invalid --seat-connectors."); }
  }
  if (command !== "duel" && (parsed.kind !== undefined || parsed.criteria !== undefined)) throw new UsageError("--kind and --criteria are available for duel.");
  if (parsed.kind !== undefined && !DUEL_KINDS.includes(parsed.kind as never)) throw new UsageError(`--kind must be one of ${DUEL_KINDS.join(", ")}.`);
  if (parsed.criteria !== undefined && typeof parsed.criteria !== "string") throw new UsageError("--criteria requires a comma-separated list.");
  // Commas split criteria; a ";" anywhere switches the separator, so a criterion may contain commas.
  const criteria = typeof parsed.criteria === "string"
    ? parsed.criteria.split(parsed.criteria.includes(";") ? ";" : ",").map(c => c.trim()) : undefined;
  if (criteria && (criteria.some(c => !c) || criteria.length > 8)) throw new UsageError("--criteria takes 1 to 8 non-empty items, separated by commas (or by ; when an item contains a comma).");
  if (!replay && command === "duel") {
    if (!teamA.length || !teamB.length || (!parsed["human-judge"] && !judges.length)) throw new UsageError("duel requires --team-a, --team-b and at least one judge.");
    try { validateDuelOptions({ topic, teamA, teamB, judges, kind: parsed.kind as never, criteria, stages, humanJudge: !!parsed["human-judge"] }); }
    catch (e) { throw new UsageError(e instanceof Error ? e.message : "Invalid duel options."); }
  }
  if (!replay && command !== "duel" && agents.length < 2) throw new UsageError(`${command} requires --agents with at least two personas.`);
  if (command === "duel" && parsed.agents) throw new UsageError("duel uses --team-a, --team-b and --judges.");
  if (command !== "duel" && (parsed["team-a"] || parsed["team-b"] || parsed.judges || parsed.open || parsed["no-room"] || parsed["no-hold"])) throw new UsageError("Team and room flags are available for duel.");
  const turnTimeoutMs = positive(parsed, "turn-timeout", 90) * 1000;
  const maxSeconds = positive(parsed, "max-seconds", 600);
  positive(parsed, "speed", 1);
  return { topic, flags: parsed, agents, options: { topic, teamA, teamB, judges, ...(stages !== undefined && { stages }), ...(parsed["human-judge"] && { humanJudge: true }), ...(parsed["no-page-check"] && { pageCheck: false }), rounds: rounds as 1 | 2, turnTimeoutMs, ...(command !== "duel" || parsed["max-seconds"] !== undefined ? { maxSeconds } : {}), ...(parsed.kind && { kind: parsed.kind as never }), ...(criteria && { criteria }), ...(parsed.mix && { mix: parsed.mix as "auto" | "cheap" }), ...(typeof parsed["agents-dir"] === "string" && { agentsDir: parsed["agents-dir"] }), ...(connectors.length && { connectors }), ...(seatConnectors && { seatConnectors }) } };
}

/** Merge-time module contracts. String imports let the CLI build before the duel modules land. */
export interface TableRoom extends TableObserver { url?: string; close(): void | Promise<void> }
export interface TableCliModules {
  duel(): Promise<{ runDuel: (opts: DuelInput, obs: TableObserver, signal: AbortSignal, seats?: Map<string, Seat>, deps?: Pick<DuelDependencies, "controls" | "replayHistory" | "resumeBy">) => Promise<DuelResult> }>;
  room(): Promise<{ createRoom(options: { open: boolean; controls?: DuelControls }): Promise<TableRoom> }>;
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
      runDuel: (opts, obs, signal, seats, deps) => real.runDuel(opts, obs, signal, { ...(seats ? real.withChosenSeats(seats) : {}), ...deps }),
    };
  },
  room: async () => {
    const real = await load<typeof import("./table/room.js")>("room");
    return { createRoom: async ({ open, controls }) => {
      const room = await real.startRoom({ open, hold: false, ...(controls && { controls }) });
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
interface CliIO { input?: Readable & { isTTY?: boolean }; output?: TerminalOutput; error?: TerminalOutput; modules?: TableCliModules }

function configCommand(args: string[], output: TerminalOutput): number {
  if (args.length === 1 && args[0] === "show") {
    const config = readUserConfig();
    output.write(`env-file: ${process.env.ROUNDTABLE_ENV_FILE !== undefined || config.envFile ? "set" : "unset"}\nagents-dir: ${process.env.ROUNDTABLE_AGENTS_DIR !== undefined || config.agentsDir ? "set" : "unset"}\n`);
    if (config.notify) output.write(`notify: ${Object.keys(config.notify).join(", ")}\n`);
    for (const [name, ref] of Object.entries(config.secrets ?? {})) output.write(`${name}: ${parseSecretRef(ref).backend}\n`);
    for (const [name, spec] of Object.entries(config.connectors ?? {})) output.write(`connector ${name}: ${Object.keys(spec.env).join(", ") || "(no env)"}\n`);
    return 0;
  }
  if (args.length === 3 && args[0] === "set" && args[1].startsWith("notify.")) {
    setNotifyConfig(args[1], args[2]);
    output.write(`${args[1]}: set\n`);
    return 0;
  }
  if (args.length === 4 && args[0] === "set" && args[1] === "secret") {
    setSecretConfig(args[2], args[3]);
    output.write("secret: set\n");
    return 0;
  }
  if (args.length === 3 && args[0] === "unset" && ["secret", "connector"].includes(args[1])) {
    unsetConfigEntry(args[1] === "secret" ? "secrets" : "connectors", args[2]);
    output.write(`${args[1]}: unset\n`);
    return 0;
  }
  if (args[0] === "set" && args[1] === "connector" && args.length >= 5) {
    let command: string | undefined;
    const argv: string[] = [], env: Record<string, string> = {}, tools: string[] = [];
    for (let i = 3; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (value === undefined) throw new UsageError("Connector flags require a value.");
      if (flag === "--command" && command === undefined) command = value;
      else if (flag === "--arg") argv.push(value);
      else if (flag === "--tool") tools.push(value);
      else if (flag === "--env") {
        const at = value.indexOf("=");
        if (at < 1 || !ENV_NAME.test(value.slice(0, at))) throw new UsageError("Connector env requires VAR=value.");
        env[value.slice(0, at)] = value.slice(at + 1);
      } else throw new UsageError("Use connector --command, --arg, --env or --tool.");
    }
    if (!command) throw new UsageError("Connector requires --command <absolute-path>.");
    setConnectorConfig(args[2], { command, args: argv, env, ...(tools.length && { tools }) });
    output.write("connector: set\n");
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
  if (!io.output) quietOnClosedPipe(process.stdout);
  if (!io.error) quietOnClosedPipe(process.stderr);
  try {
    if (args.includes("--help") || args.includes("-h")) { output.write(HELP); return 0; }
    if (command === "config") return configCommand(args, output);
    if (command === "connectors") {
      if (args.length !== 2 || args[0] !== "trust") throw new UsageError("Use connectors trust <name>.");
      trustConnector(args[1]);
      output.write(scrubAndCap(`Connector ${args[1]}: acceptance reset; the next start records its tools.\n`, 200));
      return 0;
    }
    if (command === "secrets") {
      if (args.length !== 1 || args[0] !== "check") throw new UsageError("Use secrets check.");
      const config = readUserConfig();
      const refs = [...Object.entries(config.secrets ?? {}), ...Object.entries(config.connectors ?? {}).flatMap(([name, c]) => Object.entries(c.env).filter(([, v]) => v.startsWith("secret://")).map(([key, ref]) => [`${name}.${key}`, ref]))];
      let failed = false;
      for (const [name, ref] of refs) {
        try { await resolveSecret(ref); output.write(`${name}: ok\n`); }
        catch (e) { failed = true; output.write(`${name}: ${secretReason(e)}\n`); }
      }
      return failed ? 1 : 0;
    }
    const parsed = parseTableArgs(command, args);
    if (parsed.options.agentsDir) process.env.ROUNDTABLE_AGENTS_DIR = parsed.options.agentsDir;
    const observer = parsed.flags.json ? createNdjsonObserver(output) : createTerminalObserver({ output, layout: (parsed.flags.layout ?? "auto") as "auto" | "split" | "stack" });
    return await runTable(command, parsed, observer, io.modules ?? defaultModules, error, io.input ?? process.stdin);
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode === 2 ? 2 : 1;
    // Usage messages are locally generated; remote bodies may contain credentials or private paths.
    error.write(`roundtable: ${code === 2 || e instanceof TimeoutReport || (e instanceof Error && /^(duel|room|replay) not available in this build$/.test(e.message)) ? (e as Error).message : `The session failed (${e instanceof Error ? scrubAndCap(`${e.name}: ${e.message}`.replace(/\s+/g, " "), 200) : "unknown error"}).`}\n`);
    return code;
  }
}

async function runTable(command: string, parsed: ParsedTableArgs, terminal: TableObserver, modules: TableCliModules, error: TerminalOutput, input: Readable & { isTTY?: boolean }): Promise<number> {
  const { fanout } = await import("./table/events.js");
  let controller = new AbortController();
  const lifetime = new AbortController();
  const replay = !!(parsed.flags.replay || parsed.flags["dry-run"]);
  const controls = command === "duel" && !replay ? createDuelControls() : undefined;
  let interrupts = 0, holding = false, releaseHold: (() => void) | undefined;
  let current: DuelResult | undefined, activeId: string | undefined;
  let resumeHintShown = false;
  let prompt: Interface | undefined;
  let decisionKeeper: ReturnType<typeof setInterval> | undefined;
  const resumeHint = () => { if (!resumeHintShown && activeId) { error.write(`Resume with: roundtable duel --resume ${activeId}\n`); resumeHintShown = true; } };
  const stop = () => {
    interrupts++;
    if (holding || interrupts > 1) {
      if (current?.resumable || (interrupts > 1 && command === "duel" && !replay)) resumeHint();
      lifetime.abort(); releaseHold?.();
      if (!holding) controller.abort();
      return;
    }
    controls?.send({ action: "stop" }, "terminal");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let room: TableRoom | undefined;
  try {
    let observer = terminal;
    const humanJudge = parsed.options.humanJudge || (parsed.options.resume && readCheckpoint(parsed.options.resume).options.humanJudge);
    if (humanJudge && parsed.flags["no-room"] && !input.isTTY) throw new UsageError("--human-judge with --no-room requires a TTY.");
    if (typeof parsed.flags.out === "string") {
      try { validateDuelOutputDir(parsed.flags.out); } catch (e) { throw new UsageError(e instanceof Error ? e.message : "Invalid --out directory."); }
    }
    let seats = new Map<string, Seat>();
    // A bad or unknown duel fails here, before seats are prepared or any provider is called.
    if (!replay && command !== "duel" && typeof parsed.flags.duel === "string") {
      const { loadDuelFocus, defaultDuelTopic } = await import("./sessions/duel-focus.js");
      let focus;
      try { focus = loadDuelFocus(parsed.flags.duel, { source: !parsed.flags["no-duel-source"] }); } catch (e) { throw new UsageError(e instanceof Error ? e.message : "Unable to read the duel."); }
      parsed.duelFocus = focus;
      if (!parsed.topic.trim()) parsed.topic = defaultDuelTopic(focus);
    }
    if (parsed.options.connectors?.length) {
      // An unknown or unlaunchable connector fails here, before seats are prepared or any provider is called.
      const { assertConnectorsKnown } = await import("./table/seat-connectors.js");
      try { assertConnectorsKnown(parsed.options.connectors); } catch (e) { throw new UsageError(e instanceof Error ? e.message : "Unknown connector."); }
    }
    if (!replay && !parsed.options.resume) {
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
      try { room = await (await modules.room()).createRoom({ open: !!parsed.flags.open, ...(controls && { controls }) }); }
      catch (e) {
        if (parsed.flags.open || !(e instanceof Error) || e.message !== "room not available in this build") throw e;
        error.write("roundtable: room not available in this build\n");
      }
      if (room) {
        observer = fanout(terminal, room);
        if (room.url) error.write(`Room: ${room.url}\n`);
      }
    }
    const displayed = observer;
    observer = { async onEvent(event) {
      if (event.type === "start") activeId = event.id;
      await displayed.onEvent(event);
      if (event.type === "decision" && event.status === "awaiting") decisionKeeper ??= setInterval(() => {}, 60_000);
      if (event.type === "decision" && event.status === "awaiting" && parsed.flags["no-room"] && controls) {
        prompt?.close();
        prompt = createInterface({ input, terminal: false });
        error.write("Choose the winner [A/B]: ");
        prompt.on("line", line => {
          const team = line.trim().toUpperCase();
          if ((team === "A" || team === "B") && controls.send({ action: "choose", team }, "terminal")) { const answered = prompt; prompt = undefined; answered?.close(); }
          else error.write("Choose a team with a valid artifact [A/B]: ");
        });
        prompt.on("close", () => { if (prompt) { prompt = undefined; controls.send({ action: "stop" }, "terminal"); } });
      }
      if (event.type === "control" && event.action === "stopped" || event.type === "end" || event.type === "decision" && event.status === "made") { clearInterval(decisionKeeper); decisionKeeper = undefined; const old = prompt; prompt = undefined; old?.close(); }
    } };
    current = "replayDuel" in runner
      ? await runner.replayDuel({ archivePath: parsed.flags.replay as string | undefined, dryRun: !!parsed.flags["dry-run"], speed: positive(parsed.flags, "speed", 1) }, observer, controller.signal)
      : await runner.runDuel(parsed.options, observer, controller.signal, seats.size ? seats : undefined, { controls });
    activeId = current.id;
    if (current.chosen && typeof parsed.flags.out === "string") exportChosenArtifact(current.chosen, parsed.flags.out);
    while (room && !parsed.flags["no-hold"] && !lifetime.signal.aborted) {
      holding = true;
      const keeper = setInterval(() => {}, 60_000);
      try {
        if (current.resumable && controls && "runDuel" in runner) {
          error.write("Duel stopped; resume in the room or press Ctrl-C to exit.\n");
          // The engine has already made Resume available, after saving the checkpoint.
          const message = await controls.runner.wait(lifetime.signal);
          if (message.command.action !== "resume") continue;
          holding = false; interrupts = 0; resumeHintShown = false;
          controller = new AbortController();
          current = await runner.runDuel({ resume: current.id }, observer, controller.signal, undefined, { controls, replayHistory: false, resumeBy: message.by });
          if (current.chosen && typeof parsed.flags.out === "string") exportChosenArtifact(current.chosen, parsed.flags.out);
          continue;
        }
        error.write("Room stays open; press Ctrl-C to exit.\n");
        await new Promise<void>(resolve => { releaseHold = resolve; });
        break;
      } catch (e) { if (!lifetime.signal.aborted) throw e; }
      finally { holding = false; clearInterval(keeper); }
    }
    if (current.resumable) resumeHint();
    return current.aborted || current.winner === "none" ? 1 : 0;
  } finally {
    clearInterval(decisionKeeper);
    const oldPrompt = prompt; prompt = undefined; oldPrompt?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
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
  const early: Extract<import("./table/events.js").TableEvent, { type: "turn" }>[] = [];
  const days = new Set([day()]);
  let timedOut: string | undefined;
  const abort = (message: string) => { timedOut ??= message; limits.abort(new Error(message)); };
  const deadline = setTimeout(() => abort(`timed out after ${parsed.options.maxSeconds} s; raise --max-seconds`), parsed.options.maxSeconds! * 1000);
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const resetTurn = () => { clearTimeout(turnTimer); turnTimer = setTimeout(() => abort(`timed out after ${parsed.options.turnTimeoutMs! / 1000} s without a turn; raise --turn-timeout`), parsed.options.turnTimeoutMs); };
  sessions.setCollaborationRecordHook((c, message) => {
    if (c.origin !== origin) return;
    const starting = !id;
    id = c.id;
    if (starting) {
      pending = pending.then(async () => { await observer.onEvent({ type: "start", id: c.id, topic: parsed.topic, mode: command as "meeting" | "debate" | "waffle", seats: [...seats.values()], startedAt: c.startedAt.toISOString() }); });
      for (const note of early.splice(0)) pending = pending.then(async () => { await observer.onEvent(note); });
    }
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
      ...(parsed.options.connectors?.length && { connectors: parsed.options.connectors }),
      ...(parsed.options.seatConnectors && { seatConnectors: parsed.options.seatConnectors }),
      // Each connector call is a short note in the transcript, like a turn; the payload never appears.
      onToolNote: use => {
        const seat = seats.get(use.seat);
        if (!seat) return;
        const event = { type: "turn" as const, round: "tool", seat, text: use.note, ts: new Date().toISOString() };
        // Notes from the opening turn wait for the start event.
        if (!id) early.push(event); else pending = pending.then(async () => { await observer.onEvent(event); });
      },
    });
    id = started.collaborationId;
    const collaboration = sessions.collaborations.get(id)!;
    while (collaboration.status === "running") {
      stop.throwIfAborted();
      await sessions.advanceCollaboration(collaboration);
    }
    await pending;
    return stop.aborted ? 1 : 0;
  } catch (e) {
    // A deadline surfaces inside the provider call as a stop; only a real Stop keeps that wording.
    if (timedOut && !signal.aborted) throw new TimeoutReport(timedOut);
    throw e;
  } finally {
    clearTimeout(deadline); clearTimeout(turnTimer);
    sessions.setCollaborationRecordHook(undefined);
    if (id && sessions.collaborations.has(id)) await sessions.endCollaboration(id, false);
    await pending;
    if (id) {
      days.add(day());
      const totals = new Map<string, { seatId: string; inputTokens: number; outputTokens: number; costUsd: number; unpricedTokens: number }>();
      for (const line of readTableLines([...days]).filter(line => line.session === id)) {
        const entry = totals.get(line.agent) ?? { seatId: line.agent, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedTokens: 0 };
        const used = (line.tokens?.input ?? 0) + (line.tokens?.cache_read ?? 0) + (line.tokens?.cache_write ?? 0) + (line.tokens?.output ?? 0);
        entry.inputTokens += line.tokens?.input ?? 0; entry.outputTokens += line.tokens?.output ?? 0; entry.costUsd += line.usd ?? 0;
        // Tokens with no known price stay visible as tokens, as in a completed duel, never as $0.0000.
        if (line.usd === undefined) entry.unpricedTokens += used;
        totals.set(line.agent, entry);
      }
      await observer.onEvent({ type: "usage", perSeat: [...totals.values()], totalCostUsd: [...totals.values()].reduce((n, s) => n + s.costUsd, 0), totalUnpricedTokens: [...totals.values()].reduce((n, s) => n + s.unpricedTokens, 0) });
      await observer.onEvent({ type: "end", winner: "none", tally: { A: 0, B: 0 }, aborted: stop.aborted });
    }
  }
}
