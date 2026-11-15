// Screenshots of web prototypes with the system Chrome/Chromium in headless mode (public sessions only).
// The argv holds only our own board URL, our own sandbox paths and fixed flags: never agent text.
//
// Network: the page under capture is agent-authored, so Chrome runs behind a deny-all proxy, which is
// the board itself. Every request (loopback included: "<-loopback>" removes Chrome's implicit bypass)
// goes to the board, which serves only its own prototype files and answers anything else with 403.
// WebRTC may not send UDP outside the proxy. Nothing else on this machine or network is reachable.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { browserArgs, browserEnv, ChromeProcesses, findChrome, runOnce } from "./browser.js";
export { ChromeProcesses, findChrome } from "./browser.js";

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
    const env = browserEnv(outDir);
    const results = await Promise.all(
      viewports.map(async (vp) => {
        if (opts.processes?.killed) return null;
        const name = vp.name.replace(/[^A-Za-z0-9_-]/g, "") || "shot";
        const profile = join(outDir, `.chrome-${name}`);
        const png = join(outDir, `${name}.png`);
        const args = [
          ...browserArgs(proxy, profile),
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
