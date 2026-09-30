// Public-session mirror: a session-agnostic object the session code records into.
//   const ch = createPublicChannel(sessionId, { mode, participants, topic });   // {url, topic}
//   ch.record({ turn, speaker, content, kind })                                 // sync, never throws
//   const res = await ch.finalize({ summary })                                  // flush, download, save
// Publishing never throws into or blocks a session; failures are recorded as status.
import {
  NTFY_PASSWORD,
  NTFY_TOKEN,
  NTFY_URL,
  NTFY_USER,
  PUBLIC_TOPIC_PREFIX,
  PUBLISHER_KIND,
  PUBLISH_FLUSH_TIMEOUT_MS,
  TRANSCRIPTS_DIR,
  WEBHOOK_AUTH_HEADER,
  WEBHOOK_URL,
  WEBHOOK_VIEW_URL,
} from "../config.js";
import { NtfyPublisher } from "./ntfy.js";
import { PublishQueue, chunkText, type QueueOptions } from "./queue.js";
import { errMessage } from "./shared.js";
import { mergeCounts, redact } from "./redact.js";
import {
  formatTitle,
  mergeTranscript,
  reassemble,
  countUnmatchedRemote,
  writeTranscript,
  type LocalEntry,
} from "./transcript.js";
import type { Channel, EntryKind, OutgoingMessage, PublicEntry, Publisher, PublisherConfig } from "./types.js";
import { WebhookPublisher } from "./webhook.js";

export { publicSessionDirective } from "./directive.js";
export { redact } from "./redact.js";
export { chunkText, PublishQueue } from "./queue.js";
export { NtfyPublisher } from "./ntfy.js";
export { WebhookPublisher } from "./webhook.js";
export type { PublicEntry, EntryKind, Publisher, PublisherConfig } from "./types.js";

/** Publisher settings read from the environment-backed constants in config.ts. */
export function defaultPublisherConfig(): PublisherConfig {
  return {
    kind: PUBLISHER_KIND,
    ntfyUrl: NTFY_URL,
    ntfyToken: NTFY_TOKEN || undefined,
    ntfyUser: NTFY_USER || undefined,
    ntfyPassword: NTFY_PASSWORD || undefined,
    webhookUrl: WEBHOOK_URL || undefined,
    webhookViewUrl: WEBHOOK_VIEW_URL || undefined,
    webhookAuthHeader: WEBHOOK_AUTH_HEADER || undefined,
    topicPrefix: PUBLIC_TOPIC_PREFIX,
  };
}

/** Select a publisher. Throws a clear error for an unknown kind or incomplete webhook config. */
export function createPublisher(cfg: PublisherConfig = defaultPublisherConfig()): Publisher {
  switch (cfg.kind) {
    case "ntfy":
      return new NtfyPublisher({
        baseUrl: cfg.ntfyUrl,
        token: cfg.ntfyToken,
        user: cfg.ntfyUser,
        password: cfg.ntfyPassword,
        topicPrefix: cfg.topicPrefix,
      });
    case "webhook":
      return new WebhookPublisher({
        url: cfg.webhookUrl ?? "",
        viewUrl: cfg.webhookViewUrl,
        authHeader: cfg.webhookAuthHeader,
        topicPrefix: cfg.topicPrefix,
      });
    default:
      throw new Error(
        `Unknown ROUNDTABLE_PUBLISHER "${cfg.kind}". Supported values: ntfy, webhook.`
      );
  }
}

export interface SessionMeta {
  mode?: string;
  participants: string[];
  /** The session subject. Shown in the header post and transcript; never used to build the channel name. */
  topic?: string;
}

export interface PublicChannelOptions extends QueueOptions {
  publisher?: Publisher;
  config?: PublisherConfig;
  transcriptsDir?: string;
  flushTimeoutMs?: number;
  /** Post an initial header entry (mode, participants, topic). Default true. */
  postHeader?: boolean;
  now?: () => Date;
}

export interface FinalizeResult {
  url: string | null;
  /** Absolute path of the saved transcript, or null if it could not be written. */
  savedPath: string | null;
  /** Entries fully delivered / recorded / not delivered. */
  published: number;
  total: number;
  failed: number;
  degraded: boolean;
  warnings: string[];
  /** Redactions applied, by kind. */
  redactions: Record<string, number>;
}

/**
 * The public form of a speaker/participant label. Agent names can be file paths, so: keep only the
 * base name (drop directories, a .md extension and a subagent- prefix), then redact, and strip the
 * characters the title format uses as delimiters (" · ", a trailing "(n/m)", a leading "#").
 * Idempotent, so it is safe to apply to both the header and every turn.
 */
export function publicLabel(raw: string): string {
  // Sanitize first: a trailing "(n/m)" part suffix must not be mistaken for a path separator.
  let s = String(raw ?? "").replace(/\s*·\s*/g, " ").replace(/^#+\s*/, "").trim();
  s = s.replace(/(?:\s*\(\d+\/\d+\))+$/, "").trim();
  if (looksLikePath(s)) s = s.split(/[\\/]/).filter(Boolean).pop() ?? "";
  s = s.replace(/^subagent-/, "").replace(/\.md(?=\s|$)/i, "");
  s = redact(s).text;
  s = s.replace(/[\\/]/g, "-").replace(/\s*·\s*/g, " ").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  s = s.replace(/(?:\s*\(\d+\/\d+\))+$/, "").trim();
  return s.slice(0, 60).trim() || "unknown";
}

/** A label is a path only if it has a separator AND looks like one (never plain prose like "Bob (1/2) x"). */
function looksLikePath(s: string): boolean {
  if (!/[\\/]/.test(s)) return false;
  return /\.md$/i.test(s) || /^(?:\/|\.{1,2}[\\/]|~|[A-Za-z]:)/.test(s) || !/\s/.test(s);
}

const cleanSpeaker = publicLabel;

// Channels that have not been finalized yet, so a shutdown can flush them (best effort).
const openChannels = new Set<PublicChannel>();

/** Finalize every still-open public channel (used on shutdown). Never throws. */
export async function finalizeOpenChannels(): Promise<void> {
  await Promise.all([...openChannels].map((c) => c.finalize().catch(() => undefined)));
}

export class PublicChannel {
  readonly url: string | null;
  /** The ntfy topic (or webhook channel id). */
  readonly topic: string;
  private readonly channel: Channel;
  private readonly queue: PublishQueue;
  private readonly local: (LocalEntry & { id: number })[] = [];
  private readonly usedLabels = new Set<string>();
  private readonly redactions: Record<string, number> = {};
  private readonly startedAt: string;
  private readonly meta: SessionMeta;
  /** Publisher backend in use ("ntfy" | "webhook"). */
  get kind(): string {
    return this.publisher.kind;
  }
  private lastTurn = 0;
  private nextId = 1;
  private finalizing?: Promise<FinalizeResult>;

  constructor(
    private readonly publisher: Publisher,
    sessionId: string,
    meta: SessionMeta,
    private readonly opts: PublicChannelOptions = {}
  ) {
    // Only redacted / sanitized copies are ever kept, so nothing raw can reach the header or transcript.
    const topicRedaction = meta.topic !== undefined ? redact(meta.topic) : undefined;
    if (topicRedaction) mergeCounts(this.redactions, topicRedaction.counts);
    this.meta = {
      ...(meta.mode !== undefined && { mode: meta.mode }),
      participants: meta.participants.map(publicLabel),
      ...(topicRedaction && { topic: topicRedaction.text }),
    };
    meta = this.meta;
    openChannels.add(this);
    this.channel = publisher.openChannel(sessionId);
    this.topic = this.channel.id;
    this.url = publisher.viewUrl(this.channel);
    this.queue = new PublishQueue(publisher, this.channel, opts);
    this.startedAt = (opts.now ?? (() => new Date()))().toISOString();
    if (opts.postHeader !== false) {
      const lines = [
        `**Mode:** ${meta.mode ?? "standard"}`,
        `**Participants:** ${meta.participants.join(", ")}`,
      ];
      if (meta.topic) lines.push(`**Topic:** ${meta.topic}`);
      this.record({ turn: 0, speaker: "session", kind: "header", content: lines.join("\n\n") });
    }
  }

  /** Record one entry: redacts, keeps a local copy, queues for delivery. Synchronous; never throws. */
  record(entry: PublicEntry): void {
    try {
      if (this.finalizing) return;
      const kind: EntryKind = entry.kind ?? "turn";
      const { text, counts } = redact(entry.content ?? "");
      mergeCounts(this.redactions, counts);
      const content = text.trim() ? text : "_(no content)_";

      // Keep (turn, speaker) unique so the public record can be matched back to local entries.
      let speaker = cleanSpeaker(entry.speaker);
      for (let n = 2; this.usedLabels.has(`${entry.turn}\u0000${speaker}`); n++) {
        speaker = `${cleanSpeaker(entry.speaker)} #${n}`;
      }
      this.usedLabels.add(`${entry.turn}\u0000${speaker}`);

      const id = this.nextId++;
      const timestamp = (this.opts.now ?? (() => new Date()))().toISOString();
      this.lastTurn = Math.max(this.lastTurn, entry.turn);
      this.local.push({ id, turn: entry.turn, speaker, kind, content, timestamp, delivered: false });

      const chunks = chunkText(content);
      const msgs: OutgoingMessage[] = chunks.map((c, i) => ({
        title: formatTitle(entry.turn, speaker, i + 1, chunks.length),
        content: c,
        turn: entry.turn,
        part: i + 1,
        parts: chunks.length,
        speaker,
        kind,
        timestamp,
      }));
      this.queue.enqueue(id, msgs);
    } catch (e) {
      console.error(`[Publish] record failed: ${errMessage(e)}`);
    }
  }

  /** Flush (bounded), download the public record, write the Markdown transcript. Idempotent; never throws. */
  finalize(opts: { summary?: string } = {}): Promise<FinalizeResult> {
    if (!this.finalizing) {
      if (opts.summary && opts.summary.trim()) {
        this.record({ turn: this.lastTurn + 1, speaker: "summary", kind: "summary", content: opts.summary });
      }
      this.finalizing = this.doFinalize().finally(() => openChannels.delete(this)).catch((e): FinalizeResult => {
        console.error(`[Publish] finalize failed: ${errMessage(e)}`);
        return {
          url: this.url,
          savedPath: null,
          published: 0,
          total: this.local.length,
          failed: this.local.length,
          degraded: true,
          warnings: [`Publishing finalize failed: ${errMessage(e)}`],
          redactions: this.redactions,
        };
      });
    }
    return this.finalizing;
  }

  private async doFinalize(): Promise<FinalizeResult> {
    const warnings: string[] = [];
    const timeoutMs = this.opts.flushTimeoutMs ?? PUBLISH_FLUSH_TIMEOUT_MS;
    const { timedOut } = await this.queue.flush(timeoutMs);
    if (timedOut) warnings.push(`Publishing did not finish within ${timeoutMs} ms; unsent entries are saved locally only.`);

    for (const l of this.local) l.delivered = this.queue.isDelivered(l.id);
    const published = this.local.filter((l) => l.delivered).length;
    const total = this.local.length;
    const failed = total - published;
    const degraded = this.queue.degraded;
    if (degraded) warnings.push(`Public channel degraded: ${this.queue.degradedReason}. Later entries were not posted.`);
    if (failed > 0) warnings.push(`${failed} of ${total} entries were not delivered to the public channel.`);

    let remote: ReturnType<typeof reassemble> | null = null;
    if (published > 0) {
      try {
        const hist = await this.publisher.fetchHistory(this.channel);
        if (hist) {
          remote = reassemble(hist.messages);
          if (hist.truncated) warnings.push("The server reported the public history as truncated; missing entries come from the local copy.");
        } else if (this.publisher.kind !== "webhook") {
          warnings.push("Could not download the public record; the transcript was built from the local copy.");
        }
      } catch (e) {
        warnings.push(`Could not download the public record: ${errMessage(e)}`);
      }
    }

    const unmatched = countUnmatchedRemote(this.local, remote);
    if (unmatched > 0) {
      warnings.push(`${unmatched} post(s) on the public channel matched no entry of this session (posted by others?) and were left out of the transcript.`);
    }
    const merged = mergeTranscript(this.local, remote);
    let savedPath: string | null = null;
    try {
      savedPath = await writeTranscript(
        this.opts.transcriptsDir ?? TRANSCRIPTS_DIR,
        {
          sessionId: this.channel.sessionId,
          mode: this.meta.mode,
          participants: this.meta.participants,
          topic: this.meta.topic,
          url: this.url,
          published,
          failed,
          total,
          degraded,
          startedAt: this.startedAt,
          endedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
          publisher: this.publisher.kind,
        },
        this.channel.suffix,
        merged
      );
    } catch (e) {
      warnings.push(`Could not save the transcript: ${errMessage(e)}`);
    }

    return { url: this.url, savedPath, published, total, failed, degraded, warnings, redactions: this.redactions };
  }
}

/**
 * Create a public channel for a session. Throws (a clear config error) if the publisher is
 * unknown or misconfigured; callers should surface that at session start.
 */
export function createPublicChannel(
  sessionId: string,
  meta: SessionMeta,
  opts: PublicChannelOptions = {}
): PublicChannel {
  const publisher = opts.publisher ?? createPublisher(opts.config ?? defaultPublisherConfig());
  return new PublicChannel(publisher, sessionId, meta, opts);
}
