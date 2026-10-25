// Load only a local capability page, behind that server's deny-all proxy. Never throws.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { scrubAndCap } from "../security/secrets.js";
import { browserArgs, CdpPipe, ChromeProcesses, findChrome, launchBrowser } from "./browser.js";
import { DESKTOP_VIEWPORT, type Viewport } from "./screenshot.js";

export interface PageCheck {
  loaded: boolean;
  consoleErrors: string[];
  exceptions: string[];
  failedRequests: number;
  reason?: string;
}
export interface PageCheckResult extends PageCheck {
  ok: boolean;
  title?: string;
  screenshot?: Buffer;
}
export interface PageCheckOptions {
  timeoutMs?: number;
  viewport?: Viewport;
  chromePath?: string;
  processes?: ChromeProcesses;
}

export function pageCheckSummary(check?: PageCheck): string {
  if (!check || check.reason === "no browser" || check.reason === "disabled" || check.reason === "page check unavailable") return "Page check: not checked";
  if (check.exceptions.length) return `Page check: threw ${check.exceptions[0].replace(/\s+/g, " ")}`;
  if (check.reason) return `Page check: ${check.loaded ? "loaded" : "not loaded"}; ${check.reason}`;
  if (!check.loaded) return "Page check: not loaded";
  return `Page check: loaded; ${check.consoleErrors.length} console errors; ${check.failedRequests} failed requests`;
}

/** Metadata only: screenshots never enter event logs or archives. */
export function pageCheckRecord({ loaded, consoleErrors, exceptions, failedRequests, reason }: PageCheck): PageCheck {
  return { loaded, consoleErrors, exceptions, failedRequests, ...(reason && { reason }) };
}

export async function checkPage(url: string, opts: PageCheckOptions = {}): Promise<PageCheckResult> {
  const result: PageCheckResult = { ok: false, loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0 };
  let dir: string | undefined;
  let browser: ReturnType<typeof launchBrowser> | undefined;
  let pipe: CdpPipe | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const clean = (value: string) => scrubAndCap(value.replace(/http:\/\/127\.0\.0\.1:\d+\/[^/\s]+/g, "[local page]"), 300);
  try {
    const chrome = opts.chromePath ?? findChrome();
    if (!chrome) return { ...result, reason: "no browser" };
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password ||
        !/^\/[A-Za-z0-9_-]+\/p\//.test(target.pathname)) return { ...result, reason: "only a local board or room page can be checked" };
    if (opts.processes?.killed) return { ...result, reason: "browser closed" };
    dir = await mkdtemp(join(tmpdir(), "roundtable-page-"));
    const vp = opts.viewport ?? DESKTOP_VIEWPORT;
    browser = launchBrowser(chrome, [...browserArgs(target.origin, join(dir, "profile")),
      "--remote-debugging-pipe", "about:blank"], dir, opts.processes);
    pipe = new CdpPipe(browser.child.stdio[3] as Writable, browser.child.stdio[4] as Readable);
    browser.child.on("error", () => pipe?.close());
    browser.child.on("exit", () => pipe?.close());
    const cdp = pipe;
    const message = (value: string) => clean(value.split(target.pathname.split("/")[1]).join("<token>"));
    const add = (list: string[], value: string) => { if (list.length < 10) list.push(message(value)); };
    let loaded: () => void = () => {};
    const load = new Promise<void>(resolve => { loaded = resolve; });
    let navigating = false;
    cdp.onEvent = (method, p) => {
      if (method === "Runtime.consoleAPICalled" && p.type === "error") add(result.consoleErrors,
        (p.args ?? []).map((arg: any) => String(arg.description ?? arg.value ?? arg.type)).join(" "));
      if (method === "Runtime.exceptionThrown") add(result.exceptions,
        String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"));
      if (method === "Network.responseReceived" && p.type === "Document" && p.response?.status >= 400) result.reason = `HTTP ${p.response.status}`;
      if (method === "Network.loadingFailed") result.failedRequests++;
      if (method === "Page.loadEventFired" && navigating) { result.loaded = true; loaded(); }
    };
    const work = async () => {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (method: string, params = {}) => cdp.send(method, params, sessionId);
      await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: Math.round(vp.width), height: Math.round(vp.height), deviceScaleFactor: 1, mobile: false });
      navigating = true;
      const nav = await send("Page.navigate", { url });
      if (nav.errorText) throw new Error(nav.errorText);
      await load;
      await new Promise<void>(resolve => { settle = setTimeout(resolve, 1000); });
      const title = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      if (typeof title.result?.value === "string") result.title = message(title.result.value);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (typeof shot.data === "string") result.screenshot = Buffer.from(shot.data, "base64");
      result.ok = !result.reason && result.loaded && !result.exceptions.length && !result.consoleErrors.length && !result.failedRequests;
    };
    await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { browser?.stop(); reject(new Error("timed out")); }, opts.timeoutMs ?? 15_000);
    })]);
  } catch (e) {
    result.reason = clean(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer); clearTimeout(settle);
    browser?.stop(); pipe?.close();
    if (browser && browser.child.exitCode === null && browser.child.signalCode === null) {
      await new Promise<void>(resolve => { const t = setTimeout(resolve, 1000); browser!.child.once("exit", () => { clearTimeout(t); resolve(); }); });
    }
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
  return result;
}
