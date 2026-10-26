// ============================================================================
// `roundtable up` and `roundtable doctor`: one command from a fresh install to a working setup
//
//   doctor [--json] [--check-keys]    one line per check; exit 0 when Node, git and a provider key pass
//   up [--setup] [--no-input] [--no-serve] [--open] [--check-keys]
//                                     first-run walkthrough (TTY only), the doctor, then the local service
//
// Every probe is injectable so tests need no keys, network, Docker or Chrome. Only names, versions and
// ok/fix text are printed: never a key value, an env-file path or a binary path. The walkthrough writes
// paths and flags through the same setters as `roundtable config set`; it never stores a secret value.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./cli.js";
import { scrub } from "./security/secrets.js";
import { loadUserEnvironment, readUserConfig, setNotifyConfig, setUserConfig, userConfigHome } from "./user-config.js";

export interface Check { id: string; label: string; ok: boolean; essential: boolean; detail: string; fix?: string }
export interface Doctor { ok: boolean; checks: Check[] }

export interface Probes {
  nodeVersion: string;
  /** The package's `engines.node` range, for example ">=22". */
  engines: string;
  /** Provider ids that have credentials or an endpoint right now (read again after setup). */
  providers(): string[];
  /** The environment variable that holds each provider's key (by name only). */
  keyNames: Record<string, string>;
  findExecutable(name: string): string | null;
  /** Names of the configured CLI runtimes and the program each one runs. */
  runtimes: Array<{ name: string; command: string }>;
  docker(): Promise<{ ok: boolean; reason?: string }>;
  chrome(): string | null;
  /** One cheap request per provider (`--check-keys`). */
  ping?(providers: string[]): Promise<Array<{ provider: string; ok: boolean; reason?: string }>>;
}

const clean = (text: string): string => scrub(text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")).trim().slice(0, 300);

/** The minimum major (and optional minor) of a `>=N[.M]` range; 22 when the range is not in that form. */
export function minNode(engines: string): [number, number] {
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?/.exec(engines);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [22, 0];
}

export function nodeMeets(version: string, engines: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = minNode(engines);
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

/** Run the checks. Essentials are Node, git and at least one provider key; everything else is advice. */
export async function runDoctor(probes: Probes, options: { checkKeys?: boolean } = {}): Promise<Doctor> {
  const checks: Check[] = [];
  const add = (c: Check) => { checks.push({ ...c, detail: clean(c.detail), ...(c.fix && { fix: clean(c.fix) }) }); };
  const node = probes.nodeVersion.replace(/^v/, "");
  add({ id: "node", label: "Node", essential: true, ok: nodeMeets(node, probes.engines), detail: `${node} (needs ${probes.engines})`, fix: `Install Node ${minNode(probes.engines)[0]} or newer from nodejs.org.` });
  const git = probes.findExecutable("git");
  add({ id: "git", label: "git", essential: true, ok: !!git, detail: git ? "found" : "not found", fix: "Install git; heads-down runs and worktrees need it." });
  const keyed = probes.providers();
  const missing = Object.entries(probes.keyNames).filter(([p]) => !keyed.includes(p)).map(([, name]) => name);
  add({
    id: "keys", label: "Provider keys", essential: true, ok: keyed.length > 0,
    detail: keyed.length ? `available: ${keyed.join(", ")} (names only)` : "none found",
    fix: `Set one of ${missing.join(", ")} in your shell, or point to a file that has it: roundtable config set env-file /absolute/path/to/.env`,
  });
  if (options.checkKeys) {
    if (!probes.ping) add({ id: "key-check", label: "Key check", essential: false, ok: false, detail: "not available", fix: "Run from a build with provider support." });
    else if (!keyed.length) add({ id: "key-check", label: "Key check", essential: false, ok: false, detail: "no provider to check", fix: "Add a provider key first." });
    else {
      for (const r of await probes.ping(keyed)) {
        add({ id: `key-check-${r.provider}`, label: `Key check ${r.provider}`, essential: false, ok: r.ok, detail: r.ok ? "responded" : (r.reason ?? "failed"), fix: "Check the key and the model name for this provider." });
      }
    }
  }
  const claude = probes.findExecutable("claude");
  add({ id: "claude", label: "claude CLI", essential: false, ok: !!claude, detail: claude ? "found" : "not found", fix: "Install Claude Code if you want local meetings and Claude workers." });
  for (const r of probes.runtimes) {
    const found = !!probes.findExecutable(r.command);
    add({ id: `runtime-${r.name}`, label: `Runtime ${r.name}`, essential: false, ok: found, detail: found ? "found" : "not found", fix: `Install ${r.command} to use it as a seat (see docs/runtimes.md).` });
  }
  const docker = await probes.docker().catch(() => ({ ok: false, reason: "not reachable" }));
  add({ id: "docker", label: "Docker", essential: false, ok: docker.ok, detail: docker.ok ? "daemon running" : (docker.reason ?? "not running"), fix: "Start Docker; it is the default sandbox for heads-down checks." });
  const chrome = probes.chrome();
  add({ id: "chrome", label: "Chrome", essential: false, ok: !!chrome, detail: chrome ? "found" : "not found", fix: "Install Chrome or Chromium, or set ROUNDTABLE_CHROME_PATH, for page checks and screenshots." });
  return { ok: checks.filter(c => c.essential).every(c => c.ok), checks };
}

export function formatDoctor(result: Doctor): string {
  const lines = result.checks.map(c => {
    const mark = c.ok ? "[ok]" : c.essential ? "[!!]" : "[--]";
    return `${mark} ${c.label}: ${c.detail}${c.ok || !c.fix ? "" : `. ${c.fix}`}`;
  });
  lines.push(result.ok ? "Essentials pass." : "Essentials missing: fix the [!!] lines above.");
  return lines.join("\n");
}

// --- Onboarding -------------------------------------------------------------------------------

export interface LineReader { next(): Promise<string | null>; close(): void }

/** Queue input lines so scripted input written before a question is asked is not lost. */
export function lineReader(input: Readable): LineReader {
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let closed = false;
  rl.on("line", line => { if (waiter) { const w = waiter; waiter = undefined; w(line); } else queue.push(line); });
  rl.on("close", () => { closed = true; const w = waiter; waiter = undefined; w?.(null); });
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise(resolve => { waiter = resolve; }),
    close: () => rl.close(),
  };
}

export interface ConfigView { envFile: boolean; agentsDir: boolean; desktop: boolean }

/** What the walkthrough would ask for, with the command that sets each one without prompting. */
export function missingSetup(view: ConfigView): Array<{ key: string; fix: string }> {
  const out: Array<{ key: string; fix: string }> = [];
  if (!view.envFile) out.push({ key: "env-file", fix: "roundtable config set env-file /absolute/path/to/.env" });
  if (!view.agentsDir) out.push({ key: "agents-dir", fix: "roundtable config set agents-dir /absolute/path/to/agents" });
  if (!view.desktop) out.push({ key: "notify.desktop", fix: "roundtable config set notify.desktop true" });
  return out;
}

export interface Setup {
  view(): ConfigView;
  setPath(kind: "envFile" | "agentsDir", path: string): void;
  enableDesktop(): void;
  starter(): Promise<number>;
}

export interface Prompter { ask(question: string): Promise<string | null> }

const expand = (p: string): string => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const yes = (answer: string | null): boolean => /^y(es)?$/i.test((answer ?? "").trim());

/** The short walkthrough. Every step is skippable (blank line); end of input skips the rest. */
export async function onboard(prompt: Prompter, setup: Setup, out: (line: string) => void): Promise<void> {
  out("Setup: press Enter to skip any step. Nothing here stores a secret value, only paths.");
  const view = setup.view();
  const askPath = async (kind: "envFile" | "agentsDir", present: boolean, text: string): Promise<boolean> => {
    if (present) { out(`${kind === "envFile" ? "Env file" : "Agents directory"}: already set.`); return true; }
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await prompt.ask(text);
      if (answer === null) return false;
      if (!answer.trim()) return true;
      try { setup.setPath(kind, expand(answer.trim())); out("Saved."); return true; }
      catch (error) { out(`Not saved: ${clean(error instanceof Error ? error.message : "invalid path")}`); }
    }
    return true;
  };
  if (!await askPath("envFile", view.envFile, "1/4 Env file with your provider keys (absolute path, for example a .env you own): ")) return;
  if (!await askPath("agentsDir", view.agentsDir, "2/4 Folder for your own agent files (absolute path): ")) return;
  const starter = await prompt.ask("3/4 Install the starter personas now? [y/N]: ");
  if (starter === null) return;
  if (yes(starter)) {
    try { await setup.starter(); } catch { out("The starter pack could not be installed; run roundtable agents starter later."); }
  }
  if (view.desktop) { out("Desktop check-ins: already set."); return; }
  const desktop = await prompt.ask("4/4 Turn on desktop check-ins? [y/N] (ntfy and webhook: see docs/long-running.md): ");
  if (yes(desktop)) {
    try { setup.enableDesktop(); out("Desktop check-ins on."); } catch { out("Not saved; run roundtable config set notify.desktop true."); }
  }
}

// --- Commands ---------------------------------------------------------------------------------

export interface ServeControl {
  status(): { running: boolean; remote?: boolean; url?: string };
  /** Start the detached service and wait until it is ready; the new status. */
  start(): Promise<{ running: boolean; url?: string }>;
}

export interface UpIO {
  input?: Readable;
  output?: Writable;
  /** Force or deny prompting; default is both streams being a TTY. */
  interactive?: boolean;
  /** Whether the terminal may show the private index URL. */
  showUrl?: boolean;
}

export interface UpDeps {
  probes?: Probes;
  setup?: Setup;
  serve?: ServeControl;
  firstRun?: () => boolean;
  /** Re-read the configured env file after onboarding saved a pointer. */
  reload?: () => void;
  open?: (url: string) => void;
}

const HELP = `Usage: roundtable up [--setup] [--no-input] [--no-serve] [--open] [--check-keys]
       roundtable doctor [--json] [--check-keys]

up walks a first run through setup (on a terminal only), runs the doctor, starts the local
service and prints the next steps. doctor prints one line per check and exits 0 when Node,
git and a provider key are present. Exit codes: 0 ok, 1 an essential check failed, 2 usage.
`;

async function defaultProbes(): Promise<Probes> {
  const { PROVIDER_IDS } = await import("./provider-ids.js");
  const { PROVIDER_KEYS, availableProviders } = await import("./providers/health.js");
  const { findExecutable } = await import("./executables.js");
  const { runtimeRegistry } = await import("./runtimes/registry.js");
  const { findChrome } = await import("./prototypes/browser.js");
  let engines = ">=22";
  try { engines = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).engines?.node ?? engines; } catch { /* Keep the default range. */ }
  const keyNames: Record<string, string> = {};
  for (const p of PROVIDER_IDS) {
    const name = PROVIDER_KEYS[p] ?? (p === "openai_compatible" ? "OPENAI_COMPATIBLE_BASE_URL" : "OLLAMA_URL");
    keyNames[p] = name;
  }
  return {
    nodeVersion: process.version, engines, providers: () => availableProviders(process.env), keyNames,
    findExecutable: name => findExecutable(name),
    runtimes: (() => { try { return Object.entries(runtimeRegistry()).map(([name, spec]) => ({ name, command: spec.argv[0] })); } catch { return []; } })(),
    docker: async () => { const { DockerBackend } = await import("./sandbox/docker.js"); return new DockerBackend().available(); },
    chrome: () => findChrome(),
    ping: async providers => {
      const { preflightSeats } = await import("./table/seats.js");
      const { DEFAULT_MODELS } = await import("./config.js");
      const seats = providers.map(p => ({ id: p, name: p, provider: p, model: DEFAULT_MODELS[p as keyof typeof DEFAULT_MODELS] }));
      return (await preflightSeats(seats)).map(r => ({ provider: r.provider, ok: r.ok, ...(r.reason && { reason: r.reason }) }));
    },
  };
}

async function defaultSetup(): Promise<Setup> {
  return {
    view: () => {
      const c = readUserConfig();
      return { envFile: !!c.envFile, agentsDir: !!c.agentsDir, desktop: c.notify?.desktop !== undefined };
    },
    setPath: (kind, path) => setUserConfig(kind, path),
    enableDesktop: () => setNotifyConfig("notify.desktop", "true"),
    starter: async () => { const { runAgentsCli } = await import("./cli-agents.js"); return runAgentsCli(["starter"]); },
  };
}

async function defaultServe(): Promise<ServeControl> {
  const s = await import("./serve/service.js");
  const { pidAlive } = await import("./prototypes/sandbox.js");
  const status = () => { const x = s.serveStatus(); return { running: x.running, ...(x.remote && { remote: true }), ...(x.info && { url: x.info.url }) }; };
  return {
    status,
    start: async () => {
      const pid = s.detachServe([]);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const current = s.serveStatus();
        if (current.running && current.info?.pid === pid) return { running: true, url: current.info.url };
        if (!pidAlive(pid)) throw new Error("The service exited before it was ready; inspect the private serve log.");
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error("The service did not become ready; inspect the private serve log.");
    },
  };
}

export const MCP_ADD = "claude mcp add --scope user roundtable -- roundtable mcp";

export async function runUpCli(command: "up" | "doctor", args: string[], io: UpIO = {}, deps: UpDeps = {}): Promise<number> {
  const output = io.output ?? process.stdout;
  const out = (line: string) => { output.write(line + "\n"); };
  if (args.includes("--help") || args.includes("-h")) { output.write(HELP); return 0; }
  const flags = parseFlags(args, command === "doctor"
    ? { values: [], flags: ["json", "check-keys"] }
    : { values: [], flags: ["setup", "no-input", "no-serve", "open", "check-keys"] });
  if (typeof flags === "string") { process.stderr.write(`roundtable ${command}: ${flags}\n${HELP}`); return 2; }
  const probes = deps.probes ?? await defaultProbes();
  const doctorOptions = { checkKeys: flags["check-keys"] === true };

  if (command === "doctor") {
    const result = await runDoctor(probes, doctorOptions);
    out(flags.json ? JSON.stringify(result) : formatDoctor(result));
    return result.ok ? 0 : 1;
  }

  const setup = deps.setup ?? await defaultSetup();
  const input = io.input ?? process.stdin;
  const interactive = flags["no-input"] ? false : (io.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY));
  const firstRun: boolean = (deps.firstRun ?? (() => !existsSync(join(userConfigHome(), "config.json"))))();
  if (interactive) {
    if (firstRun || flags.setup) {
      const reader = lineReader(input);
      try {
        await onboard({ ask: async q => { output.write(q); return reader.next(); } }, setup, out);
      } finally { reader.close(); }
      // A saved env-file pointer fills keys the shell did not set; the doctor below sees them.
      (deps.reload ?? (() => loadUserEnvironment()))();
    }
  } else {
    const missing = missingSetup(setup.view());
    if (missing.length) {
      out("Setup (not prompting; no terminal or --no-input). Optional items still unset:");
      for (const m of missing) out(`  ${m.key}: ${m.fix}`);
    }
  }

  out("");
  const result = await runDoctor(probes, doctorOptions);
  out(formatDoctor(result));

  if (!flags["no-serve"]) {
    out("");
    const serve = deps.serve ?? await defaultServe();
    let state: { running: boolean; remote?: boolean; url?: string } = serve.status();
    if (state.remote) out("Service: the record belongs to another host; not starting it.");
    else {
      try {
        if (!state.running) { state = await serve.start(); out("Service: started."); } else out("Service: already running.");
        const showUrl = io.showUrl ?? !!process.stdout.isTTY;
        if (state.url && showUrl) out(`Index: ${state.url}`);
        else out("Index: run roundtable serve status in a terminal to see its private URL.");
        if (flags.open && state.url) (deps.open ?? ((u: string) => { void import("./prototypes/board.js").then(m => m.openInBrowser(u)); }))(state.url);
      } catch (error) {
        out(`Service: not started. ${clean(error instanceof Error ? error.message : "failed")}`);
      }
    }
  }

  out("");
  out("Next:");
  out("  roundtable duel --dry-run");
  out(`  ${MCP_ADD}`);
  out("    (this registers the MCP server with Claude Code; run it yourself, up never does)");
  return result.ok ? 0 : 1;
}
