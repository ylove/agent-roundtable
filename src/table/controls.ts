import type { DuelCommand, DuelCommandSource, DuelControls } from "./events.js";

export interface DuelControlMessage { command: DuelCommand; by: DuelCommandSource }
export interface DuelControlRunner {
  setAvailable(options: { stop?: boolean; resume?: boolean; choose?: readonly ("A" | "B")[] }): void;
  wait(signal?: AbortSignal): Promise<DuelControlMessage>;
  onStop(fn: ((by: DuelCommandSource) => void) | undefined): void;
  clear(): void;
}
const runners = new WeakMap<DuelControls, DuelControlRunner>();

/** Public commands and a separate runner handle. Only the runner changes availability. */
export function createDuelControls(): DuelControls & { controls: DuelControls; runner: DuelControlRunner } {
  let stop = false, resume = false, choices: readonly ("A" | "B")[] = [];
  let stopHandler: ((by: DuelCommandSource) => void) | undefined;
  const queued: DuelControlMessage[] = [];
  let waiting: { resolve(message: DuelControlMessage): void; reject(error: unknown): void } | undefined;
  const controls: DuelControls = {
    available: () => ({ stop, resume, choose: choices.length > 0 }),
    send(command, by) {
      if (!command || !["room", "terminal", "tool"].includes(by) ||
          Object.keys(command).some(k => k !== "action" && !(command.action === "choose" && k === "team"))) return false;
      if (command.action === "stop" && stop) stop = false;
      else if (command.action === "resume" && resume) resume = false;
      else if (command.action === "choose" && choices.includes(command.team)) choices = [];
      else return false;
      const message = { command: { ...command }, by };
      if (command.action === "stop" && stopHandler) stopHandler(by);
      else if (waiting) { const next = waiting; waiting = undefined; next.resolve(message); }
      else queued.push(message);
      return true;
    },
  };
  const runner: DuelControlRunner = {
    setAvailable(options) { stop = !!options.stop; resume = !!options.resume; choices = [...(options.choose ?? [])]; },
    onStop(fn) { stopHandler = fn; },
    clear() { queued.length = 0; },
    async wait(signal) {
      signal?.throwIfAborted();
      if (queued.length) return queued.shift()!;
      if (waiting) throw new Error("A duel command is already being awaited.");
      return new Promise<DuelControlMessage>((resolve, reject) => {
        const abort = () => { waiting = undefined; reject(signal!.reason); };
        waiting = { resolve(message) { signal?.removeEventListener("abort", abort); resolve(message); }, reject };
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const handle = { ...controls, controls, runner };
  runners.set(controls, runner);
  runners.set(handle, runner);
  return handle;
}

export function duelControlRunner(controls: DuelControls): DuelControlRunner {
  const runner = runners.get(controls);
  if (!runner) throw new Error("Use createDuelControls() to provide duel controls.");
  return runner;
}
