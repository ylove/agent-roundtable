// Shared types for the publisher layer (public session channels).

export type EntryKind = "turn" | "header" | "nudge" | "caller" | "summary";

/** One thing recorded into a public session. */
export interface PublicEntry {
  /** Agent-turn number the entry belongs to (0 for the header). Drives ordering in the public record. */
  turn: number;
  speaker: string;
  content: string;
  kind?: EntryKind;
}

/** Opaque per-session destination created by a publisher. */
export interface Channel {
  /** Topic (ntfy) or channel id (webhook). Never derived from the session subject. */
  id: string;
  sessionId: string;
  /** Short piece of the random part, for filenames. */
  suffix: string;
}

/** A single wire message (one chunk of one entry). */
export interface OutgoingMessage {
  title: string;
  content: string;
  turn: number;
  part: number;
  parts: number;
  speaker: string;
  kind: EntryKind;
  timestamp: string;
}

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      /** Worth retrying (network error, 429, 5xx). */
      retryable: boolean;
      /** Stop posting to this channel entirely. */
      stop?: "quota" | "auth";
      retryAfterMs?: number;
      error: string;
    };

export interface HistoryMessage {
  title: string;
  content: string;
  /** Server time (unix seconds) when known. */
  time?: number;
}

export interface RemoteHistory {
  messages: HistoryMessage[];
  /** The server said the history was cut short. */
  truncated: boolean;
}

/**
 * Low-level backend. Ordering, chunking, retry and degradation live in PublishQueue;
 * send() must never throw (it returns a SendResult), openChannel() may throw on bad config.
 */
export interface Publisher {
  readonly kind: string;
  openChannel(sessionId: string): Channel;
  send(channel: Channel, msg: OutgoingMessage): Promise<SendResult>;
  /** Download the public record, or null if this backend cannot (or the download failed). */
  fetchHistory(channel: Channel): Promise<RemoteHistory | null>;
  /** Where a human can watch, or null if the backend has no view URL. */
  viewUrl(channel: Channel): string | null;
}

export interface PublisherConfig {
  kind: string;
  ntfyUrl: string;
  ntfyToken?: string;
  ntfyUser?: string;
  ntfyPassword?: string;
  webhookUrl?: string;
  webhookViewUrl?: string;
  webhookAuthHeader?: string;
  topicPrefix: string;
}
