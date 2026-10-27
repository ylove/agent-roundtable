// ============================================================================
// Private browser handoff: open a temporary file, keeping capability URLs off argv
// ============================================================================

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "./secure-server.js";
import { childEnv } from "../security/child-env.js";

const CLEANUP_SCRIPT = 'import { rmSync } from "node:fs"; setTimeout(() => { try { rmSync(process.argv[1], { recursive: true, force: true }); } catch {} }, Number(process.argv[2]));';

/** A local page with no referrer and an escaped refresh target. */
export function browserRedirectHtml(url: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escapeHtml(url)}"><title>Opening Roundtable</title>`;
}

/** A 0600 handoff file inside a 0700 directory, removed after the opener has had time to read it. */
export function createBrowserRedirect(url: string, lifetimeMs = 60_000): string {
  const dir = mkdtempSync(join(tmpdir(), "roundtable-open-"));
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "open.html");
    writeFileSync(file, browserRedirectHtml(url), { mode: 0o600, flag: "wx" });
    setTimeout(cleanup, lifetimeMs).unref();
    // A short-lived CLI may exit before its timer; a keyless detached helper also removes the file.
    try {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", CLEANUP_SCRIPT, dir, String(lifetimeMs)], {
        detached: true, stdio: "ignore", windowsHide: true, env: childEnv("open"),
      });
      child.on("error", () => {});
      child.unref();
    } catch { /* the local timer still runs while this process lives */ }
    return file;
  } catch (error) { cleanup(); throw error; }
}
