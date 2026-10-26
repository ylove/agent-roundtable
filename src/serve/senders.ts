// ============================================================================
// Private push senders: authenticated ntfy, signed webhooks and local desktop
// ============================================================================

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { resolveSecret } from "../secrets/broker.js";
import { registerSecretLiteral } from "../security/secrets.js";
import { childEnv } from "../security/child-env.js";
import { findExecutable } from "../executables.js";
import { headerValue } from "../publishers/ntfy.js";
import { failFromStatus, parseRetryAfter, REQUEST_TIMEOUT_MS } from "../publishers/shared.js";
import type { SendResult } from "../publishers/types.js";
import { notifyUrl, PRIVATE_TOPIC_RE, validateNotifyConfig, type NotifyConfig } from "./config.js";
import { privateText, type CheckIn } from "./messages.js";

export interface CheckInSender { name: string; send(message: CheckIn): Promise<SendResult> }

export async function postCheckIn(url: string, body: string, headers: Record<string, string>): Promise<SendResult> {
  try {
    const res = await fetch(url, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true };
    const result = failFromStatus(res.status, "", parseRetryAfter(res.headers.get("Retry-After")));
    if (!result.ok) result.retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    return result;
  } catch { return { ok: false, retryable: true, error: "check-in network error" }; }
}

export function ntfySender(options: { url: string; topic: string; token?: string; user?: string; password?: string }): CheckInSender {
  const url = notifyUrl(options.url).href.replace(/\/+$/, "") + "/";
  if (!PRIVATE_TOPIC_RE.test(options.topic)) throw new Error("Private ntfy topic must contain 16–64 letters, digits, underscores or hyphens.");
  if (!options.token && !(options.user && options.password)) throw new Error("Private ntfy requires authentication: an unauthenticated topic may expose your check-ins to other people.");
  for (const value of [options.token, options.user, options.password]) if (value) registerSecretLiteral(value);
  const auth = options.token ? `Bearer ${options.token}` : `Basic ${Buffer.from(`${options.user}:${options.password}`).toString("base64")}`;
  if (/[^\x20-\x7e]/.test(auth)) throw new Error("Invalid ntfy authentication header.");
  return { name: "ntfy", send: m => postCheckIn(url, JSON.stringify({ topic: options.topic, title: m.title, message: m.body }), { "Content-Type": "application/json", Authorization: headerValue(auth), Firebase: "no" }) };
}

export function webhookSender(url: string, secret: string): CheckInSender {
  notifyUrl(url);
  if (!secret) throw new Error("Private webhook requires a signing secret.");
  registerSecretLiteral(secret);
  return { name: "webhook", send(m) {
    const body = JSON.stringify(m);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return postCheckIn(url, body, { "Content-Type": "application/json", "X-Roundtable-Signature": `sha256=${signature}`, "X-Roundtable-Timestamp": m.at });
  } };
}

export type DesktopExec = (file: string, args: string[]) => Promise<void>;
const desktopExec: DesktopExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 4096, env: childEnv("open"), windowsHide: true }, error => error ? reject(error) : resolve());
});
const APPLESCRIPT = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';

export function desktopSender(platform = process.platform, find = findExecutable, exec: DesktopExec = desktopExec): CheckInSender | null {
  const file = platform === "darwin" ? find("osascript") : platform === "linux" ? find("notify-send") : null;
  if (!file) return null;
  return { name: "desktop", async send(m) {
    const args = platform === "darwin" ? ["-e", APPLESCRIPT, "--", m.title, m.body] : ["--", m.title, m.body];
    try { await exec(file, args); return { ok: true }; }
    catch { return { ok: false, retryable: false, error: "desktop notification failed" }; }
  } };
}

/** Configuration is independent of whether credentials or desktop tools are available. */
export function configuredChannels(config: NotifyConfig = {}): string[] {
  return ["ntfy", "webhook", "desktop"].filter(name => name === "ntfy" ? !!config.ntfy : name === "webhook" ? !!config.webhook : config.desktop === true);
}

export async function configuredSenders(config: NotifyConfig = {}, log: (s: string) => void = console.error, names: readonly string[] = configuredChannels(config)): Promise<CheckInSender[]> {
  validateNotifyConfig(config);
  const out: CheckInSender[] = [];
  const credential = async (ref?: string, env?: string) => {
    const value = (env && process.env[env]) || (ref ? await resolveSecret(ref) : undefined);
    if (value) registerSecretLiteral(value);
    return value;
  };
  for (const name of ["ntfy", "webhook", "desktop"] as const) {
    if (!names.includes(name)) continue;
    try {
      if (name === "ntfy" && config.ntfy) {
        const c = config.ntfy;
        if (!c.url || !c.topic) throw new Error("Private ntfy requires notify.ntfy.url and notify.ntfy.topic.");
        const token = await credential(c.token, "ROUNDTABLE_NOTIFY_NTFY_TOKEN");
        const [user, password] = token ? [] : await Promise.all([credential(c.user), credential(c.password)]);
        out.push(ntfySender({ url: c.url, topic: c.topic, token, user, password }));
      }
      if (name === "webhook" && config.webhook) {
        const c = config.webhook;
        if (!c.url) throw new Error("Private webhook requires notify.webhook.url.");
        out.push(webhookSender(c.url, await credential(c.secret, "ROUNDTABLE_NOTIFY_WEBHOOK_SECRET") ?? ""));
      }
      if (name === "desktop" && config.desktop) {
        const sender = desktopSender();
        if (sender) out.push(sender);
        else log("desktop notifications are not supported here");
      }
    } catch (error) { log(`${name}: ${privateText(error instanceof Error ? error.message : "check-in configuration failed")}`); }
  }
  if (!configuredChannels(config).length) log("no check-in channel configured");
  return out;
}
