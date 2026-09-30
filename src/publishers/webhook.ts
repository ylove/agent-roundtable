// Generic webhook publisher: POSTs one JSON object per message. No history download.
import type { Channel, OutgoingMessage, Publisher, RemoteHistory, SendResult } from "./types.js";
import { REQUEST_TIMEOUT_MS, buildChannelId, errMessage, failFromStatus, parseRetryAfter } from "./shared.js";

export interface WebhookOptions {
  url: string;
  viewUrl?: string;
  /** "Header-Name: value" */
  authHeader?: string;
  topicPrefix: string;
  requestTimeoutMs?: number;
}

export class WebhookPublisher implements Publisher {
  readonly kind = "webhook";
  private readonly authName?: string;
  private readonly authValue?: string;

  constructor(private readonly opts: WebhookOptions) {
    if (!opts.url) {
      throw new Error(
        "ROUNDTABLE_PUBLISHER=webhook requires ROUNDTABLE_WEBHOOK_URL (the endpoint each turn is POSTed to)."
      );
    }
    if (!/^https?:\/\/[^\s/]+/i.test(opts.url)) {
      throw new Error("ROUNDTABLE_WEBHOOK_URL is not a valid http(s) URL.");
    }
    if (opts.authHeader) {
      const i = opts.authHeader.indexOf(":");
      if (i <= 0) {
        throw new Error('ROUNDTABLE_WEBHOOK_AUTH_HEADER must look like "Header-Name: value".');
      }
      this.authName = opts.authHeader.slice(0, i).trim();
      this.authValue = opts.authHeader.slice(i + 1).trim();
    }
  }

  openChannel(sessionId: string): Channel {
    return buildChannelId(this.opts.topicPrefix, sessionId);
  }

  viewUrl(channel: Channel): string | null {
    return this.opts.viewUrl ? this.opts.viewUrl.split("{channel}").join(channel.id) : null;
  }

  async send(channel: Channel, msg: OutgoingMessage): Promise<SendResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authName && this.authValue !== undefined) headers[this.authName] = this.authValue;
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          session: channel.sessionId,
          channel: channel.id,
          turn: msg.turn,
          part: msg.part,
          parts: msg.parts,
          speaker: msg.speaker,
          kind: msg.kind,
          content: msg.content,
          timestamp: msg.timestamp,
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
    return failFromStatus(res.status, res.statusText, parseRetryAfter(res.headers.get("Retry-After")));
  }

  async fetchHistory(): Promise<RemoteHistory | null> {
    return null;
  }
}
