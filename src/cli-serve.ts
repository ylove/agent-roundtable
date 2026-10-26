// ============================================================================
// Lazy CLI dispatch for the local service and private check-in setup
// ============================================================================

import { pidAlive } from "./prototypes/sandbox.js";
import { randomBytes } from "node:crypto";
import { readUserConfig, setNotifyConfig } from "./user-config.js";
import { configuredSenders } from "./serve/senders.js";
import { privateText, type CheckIn } from "./serve/messages.js";
import { detachServe, printService, serveStatus, startServe, stopServe } from "./serve/service.js";

function printStatus(): void {
  const status = serveStatus();
  if (status.remote) console.log("Service record is on another host.");
  else if (status.running) console.log(process.stdout.isTTY ? `Running: ${status.info!.url}` : "Running. Run roundtable serve status in a terminal to see its private URL.");
  else console.log("Service is not running.");
}

export async function runServeCli(args: string[]): Promise<number> {
  process.umask(0o077);
  try {
    if (args.length === 1 && args[0] === "status") { printStatus(); return 0; }
    if (args.length === 1 && args[0] === "stop") { console.log(stopServe() ? "Service stop requested." : "Service is not running."); return 0; }
    if (args.length === 2 && args[0] === "--print-service") { process.stdout.write(printService(args[1])); return 0; }
    let bind = "loopback", detach = false, keepRunners = true;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (seen.has(arg)) throw new Error("Duplicate serve option.");
      seen.add(arg);
      if (arg === "--detach") detach = true;
      else if (arg === "--no-keep-runners") keepRunners = false;
      else if (arg === "--bind" && ["loopback", "tailnet"].includes(args[i + 1])) bind = args[++i];
      else throw new Error("Use serve [--detach] [--no-keep-runners] [--bind loopback|tailnet], serve status, serve stop, or serve --print-service launchd|systemd.");
    }
    if (detach) {
      const status = serveStatus();
      if (status.remote) throw new Error("Service record belongs to another host.");
      if (status.running) { printStatus(); return 0; }
      const pid = detachServe(args);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const current = serveStatus();
        if (current.running && current.info?.pid === pid) { printStatus(); return 0; }
        if (!pidAlive(pid)) throw new Error("Service exited before becoming ready; inspect the private serve log.");
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error("Service did not become ready; inspect the private serve log.");
    }
    const service = await startServe({ bind, keepRunners });
    if (process.stdout.isTTY) console.log(`Running: ${service.url}`);
    return 0;
  } catch (error) { console.error(`roundtable serve: ${privateText(error instanceof Error ? error.message : "failed")}`); return 1; }
}

export async function runNotifyCli(args: string[]): Promise<number> {
  try {
    if (args.length === 2 && args[0] === "init" && args[1] === "ntfy") {
      setNotifyConfig("notify.ntfy.topic", randomBytes(24).toString("base64url"));
      console.log("Private ntfy topic saved. Set notify.ntfy.url and an authenticated token or user/password reference, then run roundtable notify test. Restart serve after configuration changes.");
      return 0;
    }
    if (args.length !== 1 || args[0] !== "test") throw new Error("Use notify init ntfy or notify test.");
    let errors = 0;
    const senders = await configuredSenders(readUserConfig().notify, message => { console.error(message); errors++; });
    const message: CheckIn = { v: 1, kind: "test", execution: "", tag: "test", title: "Roundtable check-in test", body: "Private check-in channel works. Answer it from your chat, or run: roundtable status", seq: 0, at: new Date().toISOString() };
    for (const sender of senders) {
      try {
        const result = await sender.send(message);
        console.log(`${sender.name}: ${result.ok ? "ok" : privateText(result.error)}`);
        if (!result.ok) errors++;
      } catch { console.log(`${sender.name}: check-in failed`); errors++; }
    }
    return errors ? 1 : 0;
  } catch (error) { console.error(`roundtable notify: ${privateText(error instanceof Error ? error.message : "failed")}`); return 1; }
}
