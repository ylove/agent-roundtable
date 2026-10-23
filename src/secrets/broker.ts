import { registerSecretLiteral } from "../security/secrets.js";
import { parseSecretRef } from "./ref.js";
import { resolveBuiltinSync, secretBackend, secretReason, secretTimeout } from "./backends.js";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
function remember(ref: string, value: string): string {
  if (!value) throw new Error("empty result");
  registerSecretLiteral(value);
  cache.set(ref, value);
  return value;
}

export function resolveSecret(ref: string): Promise<string> {
  const { backend, locator } = parseSecretRef(ref);
  if (cache.has(ref)) return Promise.resolve(cache.get(ref)!);
  const existing = pending.get(ref);
  if (existing) return existing;
  const timeoutMs = secretTimeout(backend);
  const signal = AbortSignal.timeout(timeoutMs);
  const work = Promise.race([
    Promise.resolve().then(() => secretBackend(backend).resolve(locator, { signal, timeoutMs })),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
  ]).then(value => remember(ref, value), error => { throw new Error(secretReason(error)); }).finally(() => pending.delete(ref));
  pending.set(ref, work);
  return work;
}

/** Import-time provider bootstrap; one caller owns the total startup deadline. */
export function resolveSecretSync(ref: string, timeoutMs: number, source = process.env): string {
  const { backend, locator } = parseSecretRef(ref);
  if (cache.has(ref)) return cache.get(ref)!;
  if (timeoutMs <= 0) throw new Error("timed out");
  return remember(ref, resolveBuiltinSync(backend, locator, { timeoutMs: Math.min(timeoutMs, secretTimeout(backend)) }, source));
}

/** Connector literals pass through; references are resolved and registered before spawn. */
export async function resolveSecrets(map: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(map).map(async ([name, value]) => [name, value.startsWith("secret://") ? await resolveSecret(value) : value])));
}
