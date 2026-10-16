// Detached, trusted worker supervisor and group leader. It survives runner exit and owns the only
// log writer; workers receive pipes, never the persistent log descriptor or the supervisor's
// environment. When the spawn carries a launch intent, it takes the launch fence first: it holds
// the launch lock and publishes its identity before the CLI starts, so recovery can adopt it or
// cancel the intent, and a relay scheduled after cancellation never starts work.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { acquireLock, processStart, type LockRelease } from "../execution/lock.js";
import { writeFileAtomic } from "../security/fs-safe.js";
import { SECRET_KEY_RE } from "../security/redaction-rules.js";
import { scrubSecrets } from "../security/secrets.js";
import { launchLock, readLaunchIntent } from "./launch-intent.js";
import type { SpawnWorkerOptions } from "./process.js";

const LINE_CAP = 1024 * 1024;
const STOP_WINDOW_MS = 5 * 60_000;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A line of a PEM body: base64, or an RFC 1421 header such as Proc-Type or DEK-Info. */
const PEM_BODY = /^\s*(?:[A-Za-z0-9+/=]+|(?:Proc-Type|DEK-Info|Comment):.*)?\s*$/;

/** A stream-json line, or undefined for anything else. */
function parseJSONLine(line: string): unknown {
  const t = line.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * A stream-json line is scrubbed value by value: scrubbing serialized JSON as text can break its
 * syntax (a "…tokens": 20 pair would lose its number, and with it the run's usage). String values
 * under secret-shaped keys, the same vocabulary as the text rule, are redacted outright, including
 * inside arrays held by such a key. Anything else is scrubbed as text.
 */
function scrubJSON(v: unknown, key?: string): unknown {
  if (typeof v === "string") return key !== undefined && v && SECRET_KEY_RE.test(key) ? "[redacted:secret]" : scrubSecrets(v).text;
  if (Array.isArray(v)) return v.map((x) => scrubJSON(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubJSON(x, k)]));
  return v;
}

// From the first line: a TERM during setup must not kill the leader between taking its lock and
// publishing the owner (an ownerless lock only ages out after staleMs). A stop before the CLI
// starts ends the launch; after, it is forwarded to the CLI and the leader keeps draining.
let stopping = false;
let child: ChildProcess | undefined;
const onStop = () => {
  stopping = true;
  child?.kill("SIGTERM");
};
process.on("SIGTERM", onStop);
process.on("SIGINT", onStop);

const notify = (message: object) => {
  if (process.connected) process.send!(message, () => { if (process.connected) process.disconnect(); });
};

let config = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { config += chunk; });
process.stdin.on("end", () => {
  let o: SpawnWorkerOptions;
  try {
    o = JSON.parse(config);
  } catch (e) {
    notify({ error: scrubSecrets(String(e)).text });
    process.exitCode = 1;
    return;
  }
  config = "";
  run(o).catch((e) => {
    notify({ error: scrubSecrets(e instanceof Error ? e.message : String(e)).text });
    process.exitCode = 1;
  });
});

async function run(o: SpawnWorkerOptions): Promise<void> {
  let release: LockRelease | undefined;
  let fd: number | undefined;
  try {
    const intentPath = o.env.ROUNDTABLE_LAUNCH_INTENT;
    const sha = o.env.ROUNDTABLE_LAUNCH_SHA;
    if (intentPath && sha) {
      release = await acquireLock(launchLock(intentPath, sha), { staleMs: 10_000, timeoutMs: 0 });
      const intent = readLaunchIntent(intentPath);
      if (!intent || intent.cancelled || intent.token_sha256 !== sha) throw new Error("The worker launch was cancelled before it started");
      const started = processStart(process.pid);
      if (!started) throw new Error("Cannot establish worker process identity");
      writeFileAtomic(intentPath + ".receipt", JSON.stringify({ ...intent.run, pid: process.pid, pgid: process.pid, started }) + "\n");
    }
    if (stopping) throw new Error("The worker was stopped before it started");
    fd = openSync(o.outputPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const logFd = fd;
    const append = (scrubbed: string) => {
      const buf = Buffer.from(scrubbed);
      let offset = 0;
      while (offset < buf.length) offset += writeSync(logFd, buf, offset, buf.length - offset);
    };
    const cli = spawn(o.file, o.args, {
      cwd: o.cwd, env: o.env, shell: false, windowsHide: true,
      // Inherit the relay's process group so adoption and group termination still work.
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = cli;
    const attach = (stream: NodeJS.ReadableStream) => {
      let line = "";
      let dropping = false;
      let privateKey = false;
      // A JSON line carries any key whole inside one string value, so the text rules redact it
      // there and the line keeps its syntax (and the result line its cost). A key printed as plain
      // text spans lines: its body is redacted line by line until the END marker, or until a line
      // that cannot be part of a PEM body, so a lone header never silences the rest of the run.
      const flush = (newline: boolean) => {
        const nl = newline ? "\n" : "";
        if (dropping) {
          append("[worker output line omitted: size limit]\n");
          privateKey = false;
        } else {
          const json = parseJSONLine(line);
          if (json !== undefined) {
            privateKey = false;
            append(JSON.stringify(scrubJSON(json)) + nl);
          } else if (privateKey && (PEM_END.test(line) || PEM_BODY.test(line))) {
            append("[redacted:private_key]" + nl);
            if (PEM_END.test(line)) privateKey = false;
          } else {
            privateKey = PEM_BEGIN.test(line) && !PEM_END.test(line.slice(line.search(PEM_BEGIN)));
            append(privateKey ? "[redacted:private_key]" + nl : scrubSecrets(line).text + nl);
          }
        }
        line = "";
        dropping = false;
      };
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        for (const [i, part] of chunk.split("\n").entries()) {
          if (i > 0) flush(true);
          if (!dropping) {
            if (line.length + part.length > LINE_CAP) { line = ""; dropping = true; }
            else line += part;
          }
        }
      });
      stream.on("end", () => { if (line || dropping) flush(false); });
    };
    attach(cli.stdout!);
    attach(cli.stderr!);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", (code, signal) => resolve({ code, signal }));
    });
    cli.once("spawn", () => {
      cli.stdin!.on("error", () => {});
      cli.stdin!.end(o.prompt);
      notify({ started: true });
    });
    const { code, signal } = await closed;
    closeSync(logFd);
    fd = undefined;
    // Keep the verified group leader present until the controller's identity-checked SIGKILL,
    // even if the CLI exits before its descendants. A replacement runner can adopt this lock and
    // finish the stop. If no controller escalates within the window, the leader ends its group.
    if (stopping) {
      await new Promise<void>((r) => setTimeout(r, STOP_WINDOW_MS));
      try { process.kill(-process.pid, "SIGKILL"); } catch { /* the group is already gone */ }
    }
    release?.();
    release = undefined;
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
  } finally {
    if (fd !== undefined) closeSync(fd);
    release?.();
  }
}
