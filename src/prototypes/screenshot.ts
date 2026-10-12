// Screenshots of prototypes with the system Chrome/Chromium in headless mode (public sessions only).
// The argv holds only our own board URL, our own sandbox paths and fixed flags: never agent text.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { CHROME_PATH_OVERRIDE } from "../config.js";

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export const DESKTOP_VIEWPORT: Viewport = { name: "desktop", width: 1280, height: 800 };
export const MOBILE_VIEWPORT: Viewport = { name: "mobile", width: 390, height: 844 };
export const SCREENSHOT_TIMEOUT_MS = 20_000;

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scanPath(names: string[]): string | null {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const name of names) {
    for (const d of dirs) {
      for (const e of exts) {
        const p = join(d, name + e);
        if (isExecutableFile(p)) return p;
      }
    }
  }
  return null;
}

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
  return scanPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
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

function runOnce(chrome: string, args: string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group on POSIX so a timeout can kill Chrome's helper processes too.
      child = spawn(chrome, args, { stdio: "ignore", detached: posix, shell: false, windowsHide: true });
    } catch (e) {
      console.error(`[Prototype] could not start Chrome: ${e instanceof Error ? e.message : String(e)}`);
      resolve({ code: null, timedOut: false });
      return;
    }
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
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
 * with SIGKILL when it runs over). Returns only files that exist and are non-empty. Never throws.
 */
export async function captureScreenshots(
  url: string,
  outDir: string,
  viewports: Viewport[],
  opts: { timeoutMs?: number; chromePath?: string } = {}
): Promise<Array<{ name: string; path: string }>> {
  try {
    const chrome = opts.chromePath ?? findChrome();
    if (!chrome) return [];
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(url)) {
      console.error("[Prototype] screenshot refused: only the local board can be captured");
      return [];
    }
    const timeoutMs = opts.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
    const results = await Promise.all(
      viewports.map(async (vp) => {
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
          `--user-data-dir=${profile}`,
          `--window-size=${Math.round(vp.width)},${Math.round(vp.height)}`,
          "--virtual-time-budget=3000",
          `--screenshot=${png}`,
          url,
        ];
        const r = await runOnce(chrome, args, timeoutMs);
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
