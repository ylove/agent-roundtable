// ============================================================================
// The docker CLI as the preview manager uses it (injectable, so tests run with a fake)
// ============================================================================

import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { childEnv } from "../security/child-env.js";
import { findExecutable, isExecutableFile } from "../executables.js";
import { scrubAndCap } from "../security/secrets.js";
import { killTree, runQuiet } from "../sandbox/process.js";

export interface RunClient {
  /** Resolves when the docker client exits (the container ended, or the client was detached). */
  exited: Promise<{ code: number | null; tail: string }>;
  /** Kill the docker client only (SIGKILL cannot be proxied to the container, which keeps running). */
  detach(): void;
}

export interface RunToFileResult {
  ok: boolean;
  code: number | null;
  tooBig: boolean;
  timedOut: boolean;
  tail: string;
}

export interface PreviewDocker {
  info(): Promise<{ ok: boolean; reason?: string }>;
  quiet(args: string[], timeoutMs?: number): Promise<{ ok: boolean; output: string }>;
  /** `docker run -i` with stdin read from a file; stdout is discarded. */
  start(args: string[], stdinFile: string): RunClient;
  /** Run to completion with stdin from a file and stdout written to a private file, capped at maxBytes. */
  runToFile(args: string[], stdinFile: string, stdoutFile: string, o: { maxBytes: number; timeoutMs: number }): Promise<RunToFileResult>;
}

const TAIL_BYTES = 4000;

function spawnDocker(docker: string, args: string[], stdinFile: string, stdout: "ignore" | "pipe") {
  const fd = openSync(stdinFile, "r");
  try {
    const child = spawn(docker, args, { env: childEnv("docker"), stdio: [fd, stdout, "pipe"], detached: process.platform !== "win32", shell: false, windowsHide: true });
    return child;
  } finally {
    closeSync(fd);
  }
}

export function realDocker(override?: string): PreviewDocker {
  const docker = override === undefined ? findExecutable("docker") ?? "" : isExecutableFile(override) ? override : "";
  return {
    async info() {
      const r = await runQuiet(docker, ["info", "--format", "{{.ServerVersion}}"], childEnv("docker"), 8_000);
      if (r.ok && r.output) return { ok: true };
      const detail = r.output.split("\n").find((l) => l.trim()) ?? (r.exit === null ? "timed out or not installed" : `exit ${r.exit}`);
      return { ok: false, reason: scrubAndCap(detail, 300) };
    },
    async quiet(args, timeoutMs = 30_000) {
      const r = await runQuiet(docker, args, childEnv("docker"), timeoutMs);
      return { ok: r.ok, output: r.output };
    },
    start(args, stdinFile) {
      const child = spawnDocker(docker, args, stdinFile, "ignore");
      let tail = "";
      child.stderr?.on("data", (c: Buffer) => { tail = (tail + c.toString("utf8")).slice(-TAIL_BYTES); });
      const exited = new Promise<{ code: number | null; tail: string }>((resolve) => {
        child.on("error", (e) => resolve({ code: null, tail: e.message }));
        child.on("close", (code) => resolve({ code, tail: scrubAndCap(tail.trim(), 1000) }));
      });
      return { exited, detach: () => { child.stderr?.destroy(); killTree(child.pid); } };
    },
    runToFile(args, stdinFile, stdoutFile, o) {
      return new Promise((resolve) => {
        const child = spawnDocker(docker, args, stdinFile, "pipe");
        const out = createWriteStream(stdoutFile, { mode: 0o600 });
        let bytes = 0, tooBig = false, timedOut = false, tail = "", done = false;
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, o.timeoutMs);
        child.stdout?.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > o.maxBytes) { tooBig = true; killTree(child.pid); return; }
          out.write(c);
        });
        child.stderr?.on("data", (c: Buffer) => { tail = (tail + c.toString("utf8")).slice(-TAIL_BYTES); });
        const finish = (code: number | null, extra = "") => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          out.end(() => resolve({ ok: code === 0 && !tooBig && !timedOut, code, tooBig, timedOut, tail: scrubAndCap((tail + extra).trim(), 1000) }));
        };
        child.on("error", (e) => finish(null, e.message));
        child.on("close", (code) => finish(code));
      });
    },
  };
}
