// Shared Chrome lifecycle and DevTools pipe transport. No debugging port is opened.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CHROME_PATH_OVERRIDE } from "../config.js";
import { findExecutable, isExecutableFile } from "../executables.js";
import { childEnv } from "../security/child-env.js";

function detectChrome(override: string): string | null {
  if (override && isAbsolute(override) && isExecutableFile(override)) return override;
  if (override) console.error(`[Prototype] ROUNDTABLE_CHROME_PATH must be an absolute path to a regular executable; auto-detecting instead.`);
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (process.platform === "win32") {
    for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
      if (base) candidates.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  }
  for (const c of candidates) if (existsSync(c) && isExecutableFile(c)) return c;
  return findExecutable(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
}

let cached: string | null | undefined;

/**
 * The Chrome/Chromium binary: ROUNDTABLE_CHROME_PATH if it exists, then the usual macOS app paths,
 * then google-chrome, google-chrome-stable, chromium or chromium-browser on PATH (no shell).
 * Cached after the first call; pass an override to bypass the cache.
 */
export function findChrome(override?: string): string | null {
  if (override !== undefined) return detectChrome(override);
  if (cached === undefined) cached = detectChrome(CHROME_PATH_OVERRIDE);
  return cached;
}

const posix = process.platform !== "win32";

/** SIGKILL a browser and, on POSIX, its whole process group (Chrome's helpers). Never throws. */
export function killTree(pid: number): void {
  try {
    if (posix) process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * The browsers one owner (a prototype session) has running. killAll() stops every one of them and
 * makes any later start die at once, so nothing writes into a sandbox after it has been removed.
 */
export class ChromeProcesses {
  private readonly pids = new Set<number>();
  private stopped = false;

  get killed(): boolean {
    return this.stopped;
  }

  get running(): number[] {
    return [...this.pids];
  }

  track(pid: number): void {
    if (this.stopped) killTree(pid);
    else this.pids.add(pid);
  }

  untrack(pid: number): void {
    this.pids.delete(pid);
  }

  /** Synchronous, so it also works from a process 'exit' hook. Idempotent. */
  killAll(): void {
    this.stopped = true;
    for (const pid of this.pids) killTree(pid);
    this.pids.clear();
  }
}

export function runOnce(
  chrome: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string>,
  processes?: ChromeProcesses
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group on POSIX so a timeout or a session close can kill Chrome's helper processes too.
      child = spawn(chrome, args, { stdio: "ignore", detached: process.platform !== "win32", shell: false, windowsHide: true, env });
    } catch (e) {
      console.error(`[Prototype] could not start Chrome: ${e instanceof Error ? e.message : String(e)}`);
      resolve({ code: null, timedOut: false });
      return;
    }
    const pid = child.pid;
    if (pid) processes?.track(pid);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid) processes?.untrack(pid);
      resolve({ code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killTree(pid);
      else child.kill("SIGKILL");
      // If the exit event never arrives, give up anyway.
      setTimeout(() => finish(null), 1000).unref?.();
    }, timeoutMs);
    child.on("error", (e) => {
      console.error(`[Prototype] Chrome failed: ${e.message}`);
      finish(null);
    });
    child.on("exit", (code) => finish(code));
  });
}


export function browserEnv(dir: string): Record<string, string> {
  return childEnv("browser", { TMPDIR: dir, TMP: dir, TEMP: dir, MAC_CHROMIUM_TMPDIR: dir });
}

export function browserArgs(proxy: string, profile: string): string[] {
  return ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--mute-audio", "--disable-extensions", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--use-mock-keychain", `--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--user-data-dir=${profile}`];
}

/**
 * Chrome flags for a dev-server preview: every request goes to a dead proxy except the preview's own
 * 127.0.0.1:<port>, so the page can load itself and nothing else (no other local port, no internet).
 */
export function previewBrowserArgs(port: number, profile: string): string[] {
  const args = browserArgs("http://127.0.0.1:1", profile);
  return args.map(a => a.startsWith("--proxy-bypass-list=") ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}` : a);
}

export function launchBrowser(chrome: string, args: string[], dir: string, processes?: ChromeProcesses) {
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", shell: false, windowsHide: true, env: browserEnv(dir) });
  if (child.pid) processes?.track(child.pid);
  const stop = () => {
    if (child.pid) { killTree(child.pid); processes?.untrack(child.pid); }
    else child.kill("SIGKILL");
  };
  return { child, stop };
}

/** Chrome reads NUL-delimited JSON on fd 3 and writes it on fd 4. */
export class CdpPipe {
  private next = 0;
  private buffer = "";
  private closed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  onEvent: (method: string, params: any) => void = () => {};
  constructor(private readonly input: Writable, output: Readable) {
    input.on("error", () => this.close());
    output.on("error", () => this.close());
    output.on("end", () => this.close());
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (this.buffer.length > 24 * 1024 * 1024) { this.close(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\0")) !== -1) {
        const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const message = JSON.parse(raw);
          if (message.id) {
            const waiter = this.pending.get(message.id); this.pending.delete(message.id);
            if (message.error) waiter?.reject(new Error(message.error.message)); else waiter?.resolve(message.result);
          } else if (message.method) this.onEvent(message.method, message.params ?? {});
        } catch { /* Ignore malformed peer messages. */ }
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("browser closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
    });
  }
  close(): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("browser closed"));
    this.pending.clear(); this.buffer = "";
  }
}
