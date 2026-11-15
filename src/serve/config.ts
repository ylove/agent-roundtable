// ============================================================================
// Private check-in configuration, separate from public session publishers
// ============================================================================

import { parseSecretRef } from "../secrets/ref.js";

export const NOTIFY_EVENTS = ["awaiting_human", "budget", "completed", "failed", "aborted", "postmortem_ready", "runner_keeps_dying"] as const;
export type NotifyKind = typeof NOTIFY_EVENTS[number];
export interface NotifyConfig {
  events?: NotifyKind[];
  ntfy?: { url?: string; topic?: string; token?: string; user?: string; password?: string };
  webhook?: { url?: string; secret?: string };
  desktop?: boolean;
}
export const PRIVATE_TOPIC_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function notifyUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Check-in URL must be an https URL (http is allowed on loopback)."); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Check-in URL requires https unless the host is loopback, with no embedded credentials or fragment.");
  }
  return url;
}

export function validateNotifyConfig(raw: unknown): NotifyConfig {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(raw) || Object.keys(raw).some(k => !["events", "ntfy", "webhook", "desktop"].includes(k))) throw new Error("Invalid notify configuration key.");
  if (raw.desktop !== undefined && typeof raw.desktop !== "boolean") throw new Error("notify.desktop must be true or false.");
  if (raw.events !== undefined && (!Array.isArray(raw.events) || raw.events.some(k => !NOTIFY_EVENTS.includes(k)))) throw new Error("Invalid notify.events.");
  for (const channel of ["ntfy", "webhook"] as const) {
    const c = raw[channel];
    if (c === undefined) continue;
    const keys = channel === "ntfy" ? ["url", "topic", "token", "user", "password"] : ["url", "secret"];
    if (!record(c) || Object.entries(c).some(([k, v]) => !keys.includes(k) || typeof v !== "string" || !v)) throw new Error(`Invalid notify.${channel}.`);
    if (c.url !== undefined) notifyUrl(c.url as string);
    if (c.topic !== undefined && !PRIVATE_TOPIC_RE.test(c.topic as string)) throw new Error("Private ntfy topic must contain 16–64 letters, digits, underscores or hyphens.");
    for (const key of ["token", "user", "password", "secret"]) if (c[key] !== undefined) parseSecretRef(c[key]);
  }
  return raw as NotifyConfig;
}
