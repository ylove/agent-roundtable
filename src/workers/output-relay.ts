// Detached, trusted worker supervisor. It survives runner exit and owns the only log writer;
// workers receive pipes, never the persistent log descriptor or the supervisor's environment.
import { spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { scrubSecrets } from "../security/secrets.js";
import type { SpawnWorkerOptions } from "./process.js";

// Group signals also reach the worker; keep draining until it exits or the group is killed.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

const LINE_CAP = 1024 * 1024;
let config = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { config += chunk; });
process.stdin.on("end", () => {
  let fd: number | undefined;
  try {
    const o: SpawnWorkerOptions = JSON.parse(config);
    config = "";
    fd = openSync(o.outputPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const logFd = fd;
    const append = (text: string) => {
      const buf = Buffer.from(scrubSecrets(text).text);
      let offset = 0;
      while (offset < buf.length) offset += writeSync(logFd, buf, offset, buf.length - offset);
    };
    const child = spawn(o.file, o.args, {
      cwd: o.cwd, env: o.env, shell: false, windowsHide: true,
      // Inherit the relay's process group so adoption and group termination still work.
      stdio: ["pipe", "pipe", "pipe"],
    });
    const attach = (stream: NodeJS.ReadableStream) => {
      let line = "";
      let dropping = false;
      let privateKey = false;
      const flush = (newline: boolean) => {
        if (dropping) append("[worker output line omitted: size limit]\n");
        else {
          if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = true;
          if (privateKey) append("[redacted:private_key]" + (newline ? "\n" : ""));
          else append(line + (newline ? "\n" : ""));
          if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = false;
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
    attach(child.stdout!);
    attach(child.stderr!);
    const notify = (message: object) => {
      if (process.connected) process.send!(message, () => { if (process.connected) process.disconnect(); });
    };
    child.once("spawn", () => {
      child.stdin!.on("error", () => {});
      child.stdin!.end(o.prompt);
      notify({ started: true });
    });
    child.once("error", (e) => { notify({ error: scrubSecrets(e.message).text }); });
    child.once("close", (code, signal) => {
      closeSync(logFd);
      fd = undefined;
      if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } else process.exitCode = code ?? 1;
    });
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (process.connected) process.send!({ error: scrubSecrets(String(e)).text }, () => process.disconnect());
    process.exitCode = 1;
  }
});
