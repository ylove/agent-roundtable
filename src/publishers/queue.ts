// Ordered, non-blocking delivery of chunked messages with rate-limit handling.
// Nothing here ever throws into the caller: failures become per-entry status.
import type { OutgoingMessage, Publisher, Channel, SendResult } from "./types.js";
import { errMessage } from "./shared.js";

export const MAX_CHUNK_BYTES = 3800;

function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * Split text into chunks of at most `maxBytes` UTF-8 bytes, preferring paragraph, then line,
 * then whitespace boundaries, and never splitting a code point. Separators stay at the end of
 * the earlier chunk, so chunks.join("") === text exactly.
 */
export function chunkText(text: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    // longest prefix (in UTF-16 units) that fits
    let bytes = 0;
    let end = 0;
    for (const ch of rest) {
      const n = utf8Len(ch.codePointAt(0)!);
      if (bytes + n > maxBytes) break;
      bytes += n;
      end += ch.length;
    }
    const window = rest.slice(0, end);
    const minCut = Math.floor(window.length / 4);
    let cut = -1;
    const para = window.lastIndexOf("\n\n");
    if (para > minCut) cut = para + 2;
    if (cut < 0) {
      const nl = window.lastIndexOf("\n");
      if (nl > minCut) cut = nl + 1;
    }
    if (cut < 0) {
      const sp = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
      if (sp > minCut) cut = sp + 1;
    }
    if (cut < 0) cut = end;
    if (cut <= 0) cut = Math.max(1, end); // pathological: single code point larger than budget
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export interface QueueOptions {
  sleep?: (ms: number) => Promise<void>;
  /** First backoff when the server gives no Retry-After. Default 5000. */
  backoffBaseMs?: number;
  /** Ceiling for any single wait. Default 60000. */
  maxWaitMs?: number;
  /** Attempts per message before giving up. Default 6. */
  maxAttempts?: number;
  /** Entries in a row that exhaust their retries before the channel is marked unreachable. Default 3. */
  maxConsecutiveFailures?: number;
}

interface EntryState {
  total: number;
  delivered: number;
  failed: boolean;
  error?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class PublishQueue {
  degraded = false;
  degradedReason?: string;
  private chain: Promise<void> = Promise.resolve();
  private aborted = false;
  private consecutiveFailures = 0;
  private readonly entries = new Map<number, EntryState>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffBaseMs: number;
  private readonly maxWaitMs: number;
  private readonly maxAttempts: number;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private readonly publisher: Publisher,
    private readonly channel: Channel,
    opts: QueueOptions = {}
  ) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5000;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  }

  /** Queue all chunks of one entry (delivered in order, after everything queued before). Synchronous. */
  enqueue(entryId: number, msgs: OutgoingMessage[]): void {
    this.entries.set(entryId, { total: msgs.length, delivered: 0, failed: false });
    this.chain = this.chain.then(() => this.processEntry(entryId, msgs)).catch((e) => {
      console.error(`[Publish] unexpected queue error: ${errMessage(e)}`);
    });
  }

  isDelivered(entryId: number): boolean {
    const st = this.entries.get(entryId);
    return !!st && st.delivered === st.total && !st.failed;
  }

  errorFor(entryId: number): string | undefined {
    return this.entries.get(entryId)?.error;
  }

  /** Wait until everything queued has been attempted, or the timeout hits (then stop sending). */
  async flush(timeoutMs: number): Promise<{ timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    const drained = this.chain.then(() => true);
    const ok = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    if (!ok) this.aborted = true;
    return { timedOut: !ok };
  }

  private degrade(reason: string): void {
    if (!this.degraded) {
      this.degraded = true;
      this.degradedReason = reason;
      console.error(`[Publish] channel degraded: ${reason}`);
    }
  }

  private fail(st: EntryState, error: string): void {
    st.failed = true;
    st.error = error;
  }

  private async processEntry(id: number, msgs: OutgoingMessage[]): Promise<void> {
    const st = this.entries.get(id)!;
    for (const msg of msgs) {
      if (this.degraded) return this.fail(st, this.degradedReason ?? "channel degraded");
      if (this.aborted) return this.fail(st, "not sent before the flush timeout");
      const r = await this.sendWithRetry(msg);
      if (r.ok) {
        st.delivered++;
        this.consecutiveFailures = 0;
        continue;
      }
      this.fail(st, r.error);
      if (r.stop) {
        this.degrade(r.error);
      } else if (r.retryable && !this.aborted) {
        if (++this.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.degrade(`channel unreachable (${r.error})`);
        }
      }
      return;
    }
  }

  private async sendWithRetry(msg: OutgoingMessage): Promise<SendResult> {
    let delay = this.backoffBaseMs;
    let last: SendResult = { ok: false, retryable: false, error: "not attempted" };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.aborted) return { ok: false, retryable: false, error: "not sent before the flush timeout" };
      try {
        last = await this.publisher.send(this.channel, msg);
      } catch (e) {
        last = { ok: false, retryable: true, error: errMessage(e) };
      }
      if (last.ok) return last;
      if (last.stop || !last.retryable || attempt === this.maxAttempts) return last;
      const wait = Math.min(last.retryAfterMs ?? delay, this.maxWaitMs);
      delay = Math.min(delay * 2, this.maxWaitMs);
      await this.sleep(wait);
    }
    return last;
  }
}
