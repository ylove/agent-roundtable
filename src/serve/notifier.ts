// ============================================================================
// Durable check-in cursors and per-channel queues (at most one attempt per 10 s)
// ============================================================================

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../security/fs-safe.js";
import { awaitingHuman } from "../dashboard/render.js";
import type { AnyEvent, BlackboardState } from "../execution/types.js";
import { NOTIFY_EVENTS, type NotifyKind } from "./config.js";
import { buildCheckIn, checkInKind, privateText, type CheckIn } from "./messages.js";
import type { CheckInSender } from "./senders.js";

export interface NotifyCursor { cursor: number; escalations: string[] }
export interface ChannelQueue { lastAt?: number; pending?: CheckIn; count: number; tries: number; notBefore?: number }
export interface NotifyState { v: 1; executions: Record<string, NotifyCursor>; channels: Record<string, ChannelQueue> }
export const emptyNotifyState = (): NotifyState => ({ v: 1, executions: {}, channels: {} });

export function readNotifyState(path: string): NotifyState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as NotifyState;
    if (raw.v !== 1 || !raw.executions || !raw.channels) throw new Error();
    for (const c of Object.values(raw.executions)) if (!Number.isSafeInteger(c.cursor) || c.cursor < 0 || !Array.isArray(c.escalations) || c.escalations.some(id => typeof id !== "string")) throw new Error();
    for (const c of Object.values(raw.channels)) if (!Number.isSafeInteger(c.count) || c.count < 0 || !Number.isSafeInteger(c.tries) || c.tries < 0) throw new Error();
    return raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read check-in state; refusing to reset notification cursors.");
    return emptyNotifyState();
  }
}

export function planCheckIns(state: BlackboardState, events: AnyEvent[], previous?: NotifyCursor, enabled: readonly NotifyKind[] = NOTIFY_EVENTS): { cursor: NotifyCursor; messages: CheckIn[] } {
  const seen = new Set(previous?.escalations ?? []);
  const messages: CheckIn[] = [];
  let cursor = previous?.cursor ?? state.seq;
  const add = (kind: NotifyKind, seq: number, id?: string, summary = "", at?: string) => {
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    if (enabled.includes(kind)) messages.push(buildCheckIn(state, kind, seq, summary, at));
  };
  if (!previous) {
    for (const esc of awaitingHuman(state)) add("awaiting_human", state.seq, esc.id, esc.summary);
  } else {
    for (const event of events) {
      if (event.seq <= cursor) continue;
      const kind = checkInKind(state, event);
      if (kind) {
        const id = event.type === "escalation.awaiting_human" ? event.payload.id : undefined;
        const esc = id && Object.hasOwn(state.escalations, id) ? state.escalations[id] : undefined;
        add(kind, event.seq, id, esc?.summary, event.ts);
      }
      cursor = event.seq;
    }
  }
  return { cursor: { cursor, escalations: [...seen] }, messages };
}

/** Keep only one safe payload plus a count while the channel is cooling down. */
export function enqueue(queue: ChannelQueue | undefined, message: CheckIn): ChannelQueue {
  return { ...(queue ?? { count: 0, tries: 0 }), pending: message, count: (queue?.count ?? 0) + 1 };
}

export function readyPush(queue: ChannelQueue, now: number): CheckIn | null {
  if (!queue.pending || (queue.lastAt !== undefined && now - queue.lastAt < 10_000) || now < (queue.notBefore ?? 0)) return null;
  if (queue.count === 1) return queue.pending;
  const end = "Answer it from your chat, or run: roundtable status " + queue.pending.tag;
  return { ...queue.pending, kind: "updates", title: `${queue.count} more updates`, body: `You have ${queue.count} check-in updates. ${end}` };
}

export class Notifier {
  readonly state: NotifyState;
  private flushing = false;
  constructor(private readonly path: string, private readonly senders: CheckInSender[], private readonly log: (s: string) => void = console.error) {
    this.state = readNotifyState(path);
    // An explicitly removed channel must not replay its old queue if re-enabled later.
    for (const name of Object.keys(this.state.channels)) if (!senders.some(s => s.name === name)) delete this.state.channels[name];
  }
  save(): void { writeFileAtomic(this.path, JSON.stringify(this.state) + "\n"); }
  queue(message: CheckIn): void {
    for (const sender of this.senders) this.state.channels[sender.name] = enqueue(this.state.channels[sender.name], message);
  }
  observe(state: BlackboardState, events: AnyEvent[], enabled?: readonly NotifyKind[]): void {
    const plan = planCheckIns(state, events, this.state.executions[state.execution], enabled);
    this.state.executions[state.execution] = plan.cursor;
    for (const message of plan.messages) this.queue(message);
    this.save();
  }
  async flush(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await Promise.all(this.senders.map(async sender => {
        const queue = this.state.channels[sender.name];
        if (!queue) return;
        const message = readyPush(queue, now);
        if (!message) return;
        const count = queue.count;
        queue.lastAt = now;
        queue.tries++;
        this.save();
        let result;
        try { result = await sender.send(message); }
        catch { result = { ok: false, retryable: false, error: "check-in sender failed" } as const; }
        // New events may arrive while the request is in flight.
        const current = this.state.channels[sender.name];
        if (!result.ok) this.log(`${sender.name}: ${privateText(result.error)}`);
        if (!result.ok && result.retryable && current.tries < 3) {
          current.notBefore = now + Math.max(10_000, Math.min(300_000, result.retryAfterMs ?? 10_000));
        } else {
          current.count = Math.max(0, current.count - count);
          if (!current.count) delete current.pending;
          current.tries = 0;
          delete current.notBefore;
        }
        this.save();
      }));
    } finally { this.flushing = false; }
  }
}
