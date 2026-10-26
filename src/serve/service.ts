// ============================================================================
// One foreground local service per home: supervisor, notifier and read-only index
// ============================================================================

import { closeSync, fchmodSync, openSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ROUNDTABLE_HOME, VERSION } from "../config.js";
import { pidAlive } from "../prototypes/sandbox.js";
import { mkdirPrivate, writeFileAtomic } from "../security/fs-safe.js";
import { childEnv } from "../security/child-env.js";
import { readUserConfig } from "../user-config.js";
import { parseSecretRef } from "../secrets/ref.js";
import { acquireLock, processMatches, readLockOwner } from "../execution/lock.js";
import { ensureRunner, runnerLiveness } from "../execution/runner-launch.js";
import { listExecutions, openExecutionStore } from "../execution/store.js";
import type { ExecutionStore } from "../execution/types.js";
import { selectBind } from "../http/bind.js";
import { escapeHtml } from "../http/secure-server.js";
import { startIndex } from "./index.js";
import { supervise, type RelaunchHistory } from "./supervisor.js";
import { Notifier } from "./notifier.js";
import { configuredSenders } from "./senders.js";
import { buildCheckIn, privateText } from "./messages.js";

export const serveDir = (): string => join(ROUNDTABLE_HOME, "serve");
export const serveInfoPath = (): string => join(serveDir(), "serve.json");
export const serveLockPath = (): string => join(serveDir(), "serve.lock");
export interface ServeInfo { pid: number; host: string; url: string; bind: string; started_at: string; version: string }
export interface ServeStatus { running: boolean; info?: ServeInfo; remote?: boolean }

export function serveStatus(): ServeStatus {
  try {
    const info = JSON.parse(readFileSync(serveInfoPath(), "utf8")) as ServeInfo;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 1 || typeof info.host !== "string") return { running: false };
    if (info.host !== hostname()) return { running: false, remote: true };
    const owner = readLockOwner(serveLockPath());
    const running = !!owner && owner.pid === info.pid && owner.host === info.host && owner.at === info.started_at && processMatches(owner.pid, owner.started);
    return { running, ...(running && { info }) };
  } catch { return { running: false }; }
}

export function stopServe(): boolean {
  const status = serveStatus();
  if (status.remote) throw new Error("The serve record belongs to another host; refusing to signal it.");
  if (!status.running || !status.info) return false;
  process.kill(status.info.pid, "SIGTERM");
  return true;
}

export interface ServeOptions { bind?: string; keepRunners?: boolean; log?: (message: string) => void }
export interface RunningServe { url: string; close(): Promise<void> }

export async function startServe(options: ServeOptions = {}): Promise<RunningServe> {
  const address = selectBind(options.bind ?? "loopback");
  const log = (message: string) => (options.log ?? console.error)(`[Serve] ${privateText(message, 500)}`);
  mkdirPrivate(ROUNDTABLE_HOME);
  mkdirPrivate(serveDir());
  const release = await acquireLock(serveLockPath(), { staleMs: 10_000, timeoutMs: 0 });
  let index: Awaited<ReturnType<typeof startIndex>> | undefined;
  let supervisorTimer: ReturnType<typeof setInterval> | undefined;
  let notifyTimer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let supervising = false, notifying = false;
  const stores = new Map<string, ExecutionStore>();
  const historiesPath = join(serveDir(), "supervisor-state.json");
  let histories: Record<string, RelaunchHistory> = {};
  try {
    try {
      histories = JSON.parse(readFileSync(historiesPath, "utf8"));
      if (!histories || typeof histories !== "object" || Array.isArray(histories) || Object.values(histories).some(h => !h || !Array.isArray(h.attempts) || h.attempts.some(at => !Number.isFinite(at)))) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read supervisor history; refusing to reset the relaunch cap.");
    }
    const config = readUserConfig().notify ?? {};
    const notifier = new Notifier(join(serveDir(), "notify-state.json"), await configuredSenders(config, log), log);
    index = await startIndex(address);
    const owner = readLockOwner(serveLockPath())!;
    const info: ServeInfo = { pid: process.pid, host: hostname(), url: index.url, bind: address, started_at: owner.at, version: VERSION };
    writeFileAtomic(serveInfoPath(), JSON.stringify(info) + "\n");
    const failures = new Set<string>();
    const failed = (key: string) => { if (!failures.has(key)) { failures.add(key); log(`${key}: cannot read or maintain execution; will retry`); } };
    const storeFor = async (id: string) => {
      let store = stores.get(id);
      if (!store) { store = await openExecutionStore(id); stores.set(id, store); }
      return store;
    };
    const superviseTick = async () => {
      if (closed || supervising || options.keepRunners === false) return;
      supervising = true;
      try {
        if (!release.held()) { log("Service lock lost; stopping."); void close(); return; }
        for (const header of await listExecutions()) {
          if (closed) break;
          try {
            const state = await (await storeFor(header.id)).state();
            const runner = runnerLiveness(header.id);
            const alive = runner.state === "stopped" && runner.pid !== undefined ? pidAlive(runner.pid) : undefined;
            const decision = supervise({ id: header.id, status: state.status, runner, alive }, Date.now(), histories[header.id]);
            histories[header.id] = decision.history;
            // Persist before launch so repeated service crashes cannot reset the cap.
            writeFileAtomic(historiesPath, JSON.stringify(histories) + "\n");
            if (decision.action === "relaunch") await ensureRunner(header.id);
            if (decision.action === "notify" && (config.events === undefined || config.events.includes("runner_keeps_dying"))) {
              notifier.queue(buildCheckIn(state, "runner_keeps_dying", state.seq));
              notifier.save();
            }
          } catch { failed(header.id); }
        }
      } catch { log("Supervisor scan failed; will retry."); }
      finally { supervising = false; }
    };
    const notifyTick = async () => {
      if (closed || notifying) return;
      notifying = true;
      try {
        if (!release.held()) { log("Service lock lost; stopping."); void close(); return; }
        const headers = await listExecutions();
        const present = new Set(headers.map(h => h.id));
        for (const id of stores.keys()) if (!present.has(id)) stores.delete(id);
        for (const header of headers) {
          if (closed) break;
          try {
            const store = await storeFor(header.id);
            const cursor = notifier.state.executions[header.id];
            const events = cursor ? await store.events({ sinceSeq: cursor.cursor }) : [];
            const state = await store.state();
            if (!cursor || events.length) notifier.observe(state, events, config.events);
          } catch { failed(header.id); }
        }
        await notifier.flush();
      } catch { log("Check-in scan failed; will retry."); }
      finally { notifying = false; }
    };
    const close = (): Promise<void> => {
      if (!closing) closing = (async () => {
        closed = true;
        clearInterval(supervisorTimer);
        clearInterval(notifyTimer);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await index?.close();
        // Wait for bounded in-flight sends before releasing the service lock.
        while (notifying || supervising) await new Promise(r => setTimeout(r, 20));
        if (release.held()) rmSync(serveInfoPath(), { force: true });
        release();
      })();
      return closing;
    };
    const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (options.bind === "tailnet") log("Anyone on your tailnet with the URL can read this index. Keep the URL private.");
    supervisorTimer = setInterval(() => { void superviseTick(); }, 15_000);
    notifyTimer = setInterval(() => { void notifyTick(); }, 1000);
    await Promise.all([superviseTick(), notifyTick()]);
    return { url: index.url, close };
  } catch (error) {
    clearInterval(supervisorTimer);
    clearInterval(notifyTimer);
    await index?.close();
    if (release.held()) rmSync(serveInfoPath(), { force: true });
    release();
    throw error;
  }
}

export const serveCliPath = (): string => fileURLToPath(new URL("../index.js", import.meta.url));

export function detachServe(args: string[]): number {
  mkdirPrivate(ROUNDTABLE_HOME);
  mkdirPrivate(serveDir());
  const config = readUserConfig();
  const extra: Record<string, string> = {};
  const refs = [...Object.values(config.secrets ?? {}), ...Object.values(config.connectors ?? {}).flatMap(c => Object.values(c.env).filter(v => v.startsWith("secret://"))), ...Object.values(config.notify?.ntfy ?? {}).filter(v => v.startsWith("secret://")), ...Object.values(config.notify?.webhook ?? {}).filter(v => v.startsWith("secret://"))];
  for (const ref of refs) {
    const parsed = parseSecretRef(ref);
    if (parsed.backend === "env" && process.env[parsed.locator] !== undefined) extra[parsed.locator] = process.env[parsed.locator]!;
  }
  for (const name of ["ROUNDTABLE_NOTIFY_NTFY_TOKEN", "ROUNDTABLE_NOTIFY_WEBHOOK_SECRET"]) if (process.env[name] !== undefined) extra[name] = process.env[name]!;
  const fd = openSync(join(serveDir(), "serve.log"), "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const child = spawn(process.execPath, [serveCliPath(), "serve", ...args.filter(a => a !== "--detach")], { detached: true, stdio: ["ignore", fd, fd], env: childEnv("serve", extra), shell: false, windowsHide: true });
    child.on("error", () => {});
    if (!child.pid) throw new Error("The service did not start.");
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

export function printService(kind: string, execPath = process.execPath, cliPath = serveCliPath()): string {
  if (kind === "launchd") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>local.roundtable.serve</string><key>ProgramArguments</key><array><string>${escapeHtml(execPath)}</string><string>${escapeHtml(cliPath)}</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  if (kind === "systemd") {
    const quote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, () => "$$").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
    return `[Unit]\nDescription=Roundtable local run service\n\n[Service]\nType=simple\nExecStart=${quote(execPath)} ${quote(cliPath)} serve\nRestart=on-failure\nRestartSec=15\n\n[Install]\nWantedBy=default.target\n`;
  }
  throw new Error("Use --print-service launchd or --print-service systemd.");
}
