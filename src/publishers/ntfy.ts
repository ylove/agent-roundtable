// ntfy publisher (default). Publishes JSON to the server root, downloads history as NDJSON.
import type { Channel, HistoryMessage, OutgoingMessage, Publisher, RemoteHistory, SendResult } from "./types.js";
import { REQUEST_TIMEOUT_MS, buildChannelId, errMessage, failFromStatus, parseRetryAfter } from "./shared.js";

export interface NtfyOptions {
  baseUrl: string;
  token?: string;
  user?: string;
  password?: string;
  topicPrefix: string;
  requestTimeoutMs?: number;
}

export class NtfyPublisher implements Publisher {
  readonly kind = "ntfy";
  private readonly base: string;

  constructor(private readonly opts: NtfyOptions) {
    const base = opts.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/i.test(base)) {
      throw new Error(`ROUNDTABLE_NTFY_URL is not a valid http(s) URL: "${opts.baseUrl}"`);
    }
    this.base = base;
  }

  openChannel(sessionId: string): Channel {
    return buildChannelId(this.opts.topicPrefix, sessionId);
  }

  viewUrl(channel: Channel): string {
    return `${this.base}/${channel.id}`;
  }

  private authHeaders(): Record<string, string> {
    if (this.opts.token) return { Authorization: `Bearer ${this.opts.token}` };
    if (this.opts.user && this.opts.password) {
      const b64 = Buffer.from(`${this.opts.user}:${this.opts.password}`).toString("base64");
      return { Authorization: `Basic ${b64}` };
    }
    return {};
  }

  async send(channel: Channel, msg: OutgoingMessage): Promise<SendResult> {
    if (msg.attachment) return this.sendAttachment(channel, msg);
    let res: Response;
    try {
      res = await fetch(`${this.base}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Firebase: "no", ...this.authHeaders() },
        body: JSON.stringify({
          topic: channel.id,
          title: msg.title,
          message: msg.content,
          markdown: true,
        }),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, retryable: true, error: `network error: ${errMessage(e)}` };
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    return this.failure(res);
  }

  /** Upload a file: PUT to the topic with the bytes as the body; title and caption travel as headers. */
  private async sendAttachment(channel: Channel, msg: OutgoingMessage): Promise<SendResult> {
    const a = msg.attachment!;
    let res: Response;
    try {
      res = await fetch(`${this.base}/${channel.id}`, {
        method: "PUT",
        headers: {
          Filename: asciiFilename(a.filename),
          Title: headerValue(msg.title),
          Message: headerValue(msg.content),
          Firebase: "no",
          ...this.authHeaders(),
        },
        body: new Uint8Array(a.bytes),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, retryable: true, error: `network error: ${errMessage(e)}` };
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    return this.failure(res, true);
  }

  private async failure(res: Response, attachment = false): Promise<SendResult> {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    let code: number | undefined;
    let errText = "";
    try {
      const j = JSON.parse(body) as { code?: number; error?: string };
      code = j.code;
      errText = j.error ?? "";
    } catch {
      errText = body.slice(0, 200);
    }
    if (res.status === 429) {
      const daily = code === 42908 || /daily|quota/i.test(errText);
      if (daily) {
        return { ok: false, retryable: false, stop: "quota", error: `daily message limit reached (${errText || "HTTP 429"})` };
      }
    }
    if (attachment && (res.status === 413 || /too large/i.test(errText))) {
      return {
        ok: false,
        retryable: false,
        error: `attachment rejected as too large by the ntfy server (HTTP ${res.status}${errText ? `: ${errText}` : ""})`,
      };
    }
    const fail = failFromStatus(res.status, res.statusText, parseRetryAfter(res.headers.get("Retry-After")));
    if (!fail.ok && errText) fail.error += `: ${errText}`;
    return fail;
  }

  async fetchHistory(channel: Channel): Promise<RemoteHistory | null> {
    try {
      const res = await fetch(`${this.base}/${channel.id}/json?poll=1&since=all`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`[Publish] history download failed: HTTP ${res.status}`);
        return null;
      }
      const text = await res.text();
      const messages: HistoryMessage[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { event?: string; title?: string; message?: string; time?: number };
          if (ev.event !== "message") continue;
          messages.push({ title: ev.title ?? "", content: ev.message ?? "", time: ev.time });
        } catch {
          /* skip malformed line */
        }
      }
      return { messages, truncated: res.headers.get("X-Messages-Truncated") === "1" };
    } catch (e) {
      console.error(`[Publish] history download failed: ${errMessage(e)}`);
      return null;
    }
  }
}

/** ASCII-only file name for the Filename header. */
function asciiFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100) || "attachment.bin";
}

/**
 * A header-safe value: printable ASCII as is; anything else as RFC 2047 encoded words (UTF-8, base64),
 * which ntfy decodes. Words carry at most 45 bytes each, split on code-point boundaries.
 */
export function headerValue(value: string): string {
  const v = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let cur = "";
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch, "utf8") > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}
