// Screenshots of web prototypes with the system Chrome/Chromium in headless mode (public sessions only).
// The argv holds only our own board URL, our own sandbox paths and fixed flags: never agent text.
//
// Network: the page under capture is agent-authored, so Chrome runs behind a deny-all proxy, which is
// the board itself. Every request (loopback included: "<-loopback>" removes Chrome's implicit bypass)
// goes to the board, which serves only its own prototype files and answers anything else with 403.
// WebRTC may not send UDP outside the proxy. Nothing else on this machine or network is reachable.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CHROME_PATH_OVERRIDE } from "../config.js";
import { findExecutable, isExecutableFile } from "../executables.js";
import { childEnv } from "../security/child-env.js";

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export const DESKTOP_VIEWPORT: Viewport = { name: "desktop", width: 1280, height: 800 };
export const MOBILE_VIEWPORT: Viewport = { name: "mobile", width: 390, height: 844 };
export const SCREENSHOT_TIMEOUT_MS = 20_000;

/** Only the local board can be captured; its origin doubles as the proxy. */
const BOARD_URL_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//;

function detectChrome(override: string): string | null {
  if (override && isExecutableFile(override)) return override;
  if (override) console.error(`[Prototype] ROUNDTABLE_CHROME_PATH does not point to an executable; auto-detecting instead.`);
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
function killTree(pid: number): void {
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

function runOnce(
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
      child = spawn(chrome, args, { stdio: "ignore", detached: posix, shell: false, windowsHide: true, env });
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

/**
 * Capture one PNG per viewport into `outDir` (in parallel, each bounded by the timeout and killed
 * with SIGKILL when it runs over). The URL must be on the local board, which is also Chrome's
 * deny-all proxy. Chrome's temporary files go to `outDir` too. Pass `processes` to let the owner
 * kill a capture in flight. Returns only files that exist and are non-empty. Never throws.
 */
export async function captureScreenshots(
  url: string,
  outDir: string,
  viewports: Viewport[],
  opts: { timeoutMs?: number; chromePath?: string; processes?: ChromeProcesses } = {}
): Promise<Array<{ name: string; path: string }>> {
  try {
    const chrome = opts.chromePath ?? findChrome();
    if (!chrome) return [];
    const board = BOARD_URL_RE.exec(url);
    if (!board) {
      console.error("[Prototype] screenshot refused: only the local board can be captured");
      return [];
    }
    const proxy = `http://127.0.0.1:${board[1]}`;
    const timeoutMs = opts.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
    // Chrome's temporary files (its process-singleton directory included) go to the shots directory, so
    // they are removed with the prototype even when Chrome is killed. macOS Chrome ignores TMPDIR for these
    // and reads MAC_CHROMIUM_TMPDIR instead. Nothing else of this process's environment reaches Chrome.
    const env = childEnv("browser", { TMPDIR: outDir, TMP: outDir, TEMP: outDir, MAC_CHROMIUM_TMPDIR: outDir });
    const results = await Promise.all(
      viewports.map(async (vp) => {
        if (opts.processes?.killed) return null;
        const name = vp.name.replace(/[^A-Za-z0-9_-]/g, "") || "shot";
        const profile = join(outDir, `.chrome-${name}`);
        const png = join(outDir, `${name}.png`);
        const args = [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--no-default-browser-check",
          "--mute-audio",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--use-mock-keychain",
          `--proxy-server=${proxy}`,
          "--proxy-bypass-list=<-loopback>",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          `--user-data-dir=${profile}`,
          `--window-size=${Math.round(vp.width)},${Math.round(vp.height)}`,
          "--virtual-time-budget=3000",
          `--screenshot=${png}`,
          url,
        ];
        const r = await runOnce(chrome, args, timeoutMs, env, opts.processes);
        if (r.timedOut) console.error(`[Prototype] screenshot (${name}) timed out after ${timeoutMs} ms`);
        await rm(profile, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
        try {
          const s = await stat(png);
          return s.isFile() && s.size > 0 ? { name: vp.name, path: png } : null;
        } catch {
          return null;
        }
      })
    );
    return results.filter((r): r is { name: string; path: string } => r !== null);
  } catch (e) {
    console.error(`[Prototype] screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
