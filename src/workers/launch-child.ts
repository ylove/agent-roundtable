// Detached group leader. No CLI code or prompt is consumed before its durable launch identity.
import { spawn, type ChildProcess } from "node:child_process";
import { acquireLock, processStart } from "../execution/lock.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { launchLock, readLaunchIntent } from "./launch-intent.js";

const STOP_WINDOW_MS = 5 * 60_000;
const [path, token, file, ...args] = process.argv.slice(2);
// From the first line: a TERM during setup must not kill the leader between taking its lock and
// publishing the owner (an ownerless lock only ages out after staleMs). A stop before the CLI
// starts ends the launch cleanly; after, it is forwarded to the CLI.
let stopping = false;
let child: ChildProcess | undefined;
process.on("SIGTERM", () => {
  stopping = true;
  child?.kill("SIGTERM");
});
const release = await acquireLock(launchLock(path, token), { staleMs: 10_000, timeoutMs: 0 });
let exitSignal: NodeJS.Signals | null = null;
try {
  const intent = readLaunchIntent(path);
  if (stopping || !intent || intent.cancelled || intent.token_sha256 !== token) process.exitCode = 1;
  else {
    const started = processStart(process.pid);
    if (!started) throw new Error("Cannot establish worker process identity");
    writeFileAtomic(path + ".receipt", JSON.stringify({ ...intent.run, pid: process.pid, pgid: process.pid, started }) + "\n");
    if (stopping) process.exitCode = 1;
    else {
      const cli = spawn(file, args, { stdio: "inherit", env: process.env, shell: false });
      child = cli;
      // The CLI shares this group. Keep its leader alive through TERM so the controller can verify
      // identity again before escalation, even if a descendant ignores TERM.
      await new Promise<void>((resolve, reject) => {
        cli.once("error", reject);
        cli.once("exit", (code, signal) => { process.exitCode = code ?? 1; exitSignal = signal; resolve(); });
      });
      // Keep the verified group leader present until escalation, even if the CLI exits before
      // its descendants. A replacement runner can adopt this lock and finish the stop. If no
      // controller escalates within the window, the leader ends its own group.
      if (stopping) {
        await new Promise<void>((r) => setTimeout(r, STOP_WINDOW_MS));
        try { process.kill(-process.pid, "SIGKILL"); } catch { /* the group is already gone */ }
      }
    }
  }
} finally { release(); }
if (exitSignal) {
  process.removeAllListeners(exitSignal);
  process.kill(process.pid, exitSignal);
}
