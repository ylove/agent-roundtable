// ============================================================================
// Provider retries: transient HTTP statuses and network errors, with backoff inside the caller's signal
// ============================================================================

import { setTimeout as delay } from "node:timers/promises";
import { providerRetries } from "../config.js";
import { parseRetryAfter } from "../publishers/shared.js";

/** An HTTP error from a provider; `retryAfterMs` comes from the Retry-After header, when there is one. */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** Build a ProviderHttpError from a response, reading its Retry-After (seconds or HTTP date). */
export function providerHttpError(message: string, response: Response): ProviderHttpError {
  return new ProviderHttpError(message, response.status, parseRetryAfter(response.headers.get("retry-after")));
}

/** Request timeout, conflict, rate limit, and every 5xx (Anthropic's 529 "overloaded" included). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED",
]);

/** A connection-level failure (fetch's "fetch failed" TypeError and the like); never an abort or a timeout. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError" || error.name === "TimeoutError") return false;
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return error instanceof TypeError && /^(fetch failed|terminated|other side closed)/i.test(error.message);
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof ProviderHttpError ? isRetryableStatus(error.status) : isNetworkError(error);
}

export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 8_000;
export const RETRY_AFTER_CAP_MS = 60_000;

/** The clock withRetry uses unless given its own; tests replace `sleep` to keep the suite fast. */
export const retryClock = {
  /** Resolves after `ms`, or rejects with the signal's reason as soon as it fires. */
  sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      throw signal?.aborted ? signal.reason : error;
    }
  },
  random: (): number => Math.random(),
};

export interface RetryOptions {
  /** The caller's signal: no attempt starts, and no backoff lasts, after it fires. */
  signal?: AbortSignal;
  /** Total attempts, the first included. Default: 1 + ROUNDTABLE_PROVIDER_RETRIES (3). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Names the request in the retry log line, e.g. "Anthropic". */
  label?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * The wait before retry number `retry` (1-based): the server's Retry-After when it sent one (capped at
 * 60 s), otherwise exponential backoff with equal jitter (half fixed, half random).
 */
export function retryDelayMs(retry: number, error: unknown, o: RetryOptions = {}): number {
  if (error instanceof ProviderHttpError && error.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, error.retryAfterMs), RETRY_AFTER_CAP_MS);
  }
  const ceiling = Math.min(o.maxDelayMs ?? RETRY_MAX_DELAY_MS, (o.baseDelayMs ?? RETRY_BASE_DELAY_MS) * 2 ** (retry - 1));
  return Math.round(ceiling / 2 + (o.random ?? retryClock.random)() * (ceiling / 2));
}

/**
 * Run `fn`, retrying ProviderHttpError with a retryable status and network errors. Anything else,
 * and the last attempt's error, is thrown as is. When the signal fires during a backoff, the wait
 * ends at once with the signal's reason (a TimeoutError for AbortSignal.timeout).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(o.attempts ?? 1 + providerRetries()));
  for (let attempt = 1; ; attempt++) {
    o.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || o.signal?.aborted || !isRetryableError(error)) throw error;
      const wait = retryDelayMs(attempt, error, o);
      const why = error instanceof ProviderHttpError ? `HTTP ${error.status}` : "network error";
      console.error(`[Providers] ${o.label ?? "request"} failed (${why}); retry ${attempt} of ${attempts - 1} in ${wait} ms`);
      await (o.sleep ?? retryClock.sleep)(wait, o.signal);
    }
  }
}
