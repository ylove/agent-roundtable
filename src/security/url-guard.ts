// ============================================================================
// Outbound URL guard (SSRF) for per-call provider base URLs and the webhook publisher
//
// Rules: https only, except http to loopback; no userinfo; cloud metadata targets always blocked;
// private, CGNAT, link-local and ULA targets blocked unless opted in. Loopback is always allowed,
// because local model servers (LM Studio, vLLM, llama.cpp, Ollama) live there.
//
// Limitation (DNS rebinding, a TOCTOU gap): the guard resolves the host and checks every address,
// but fetch resolves the name again when it connects. A hostile resolver can answer the guard with
// a public address and fetch with a private one moments later. Closing the gap needs a connect-time
// check (a pinned lookup in a custom dispatcher), which fetch does not offer without a dependency.
// Callers make redirects manual, so an allowed host cannot bounce a request, or a key, elsewhere.
// ============================================================================

// Called as dns.lookup(...) at call time, so tests can stub dns.promises.lookup.
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { allowPrivateBaseUrls } from "../config.js";

export type AddressClass = "loopback" | "metadata" | "private" | "public";

export const URL_GUARD_LOOKUP_TIMEOUT_MS = 3000;

/** Thrown for a refused URL. `retryable` is true only when the host could not be resolved. */
export class UrlGuardError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "UrlGuardError";
  }
}

/** `scheme://host[:port]` only: never the userinfo, path or query (webhook URLs often carry tokens there). */
export function describeUrl(url: string | URL | undefined | null): string {
  if (!url) return "(not set)";
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid URL)";
  }
}

// ----------------------------------------------------------------------------
// Address classification
// ----------------------------------------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

const cidr4 = (base: string, bits: number): [number, number] => [v4ToInt(base)!, bits];
const V4_METADATA = [cidr4("169.254.0.0", 16), cidr4("100.100.100.200", 32)];
const V4_LOOPBACK = [cidr4("127.0.0.0", 8)];
// "This network", RFC 1918, CGNAT, IETF protocol assignments, benchmarking, multicast, reserved and broadcast.
const V4_PRIVATE = [
  cidr4("0.0.0.0", 8),
  cidr4("10.0.0.0", 8),
  cidr4("100.64.0.0", 10),
  cidr4("172.16.0.0", 12),
  cidr4("192.0.0.0", 24),
  cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15),
  cidr4("224.0.0.0", 4),
  cidr4("240.0.0.0", 4),
];

function inRanges(n: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

function classifyV4(n: number): AddressClass {
  if (inRanges(n, V4_METADATA)) return "metadata";
  if (inRanges(n, V4_LOOPBACK)) return "loopback";
  if (inRanges(n, V4_PRIVATE)) return "private";
  return "public";
}

/** Eight 16-bit groups, or null. Accepts "::" compression, a dotted IPv4 tail and a zone id. */
function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

const isZero = (h: number[], from: number, to: number) => h.slice(from, to).every((g) => g === 0);
const embeddedV4 = (hi: number, lo: number) => hi * 65536 + lo;

function classifyV6(h: number[]): AddressClass {
  if (isZero(h, 0, 8)) return "private"; // unspecified
  if (isZero(h, 0, 7) && h[7] === 1) return "loopback";
  // AWS IMDS over IPv6: fd00:ec2::254
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && isZero(h, 2, 7) && h[7] === 0x254) return "metadata";
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): the IPv4 decides.
  if (isZero(h, 0, 5) && (h[5] === 0xffff || h[5] === 0)) return classifyV4(embeddedV4(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b && isZero(h, 2, 6)) return classifyV4(embeddedV4(h[6], h[7]));
  // 6to4 (2002:a.b.c.d::/48) reaches the embedded IPv4 through a relay.
  if (h[0] === 0x2002) {
    const inner = classifyV4(embeddedV4(h[1], h[2]));
    if (inner !== "public") return inner === "metadata" ? "metadata" : "private";
  }
  if ((h[0] & 0xfe00) === 0xfc00) return "private"; // ULA fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return "private"; // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return "private"; // site-local fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return "private"; // multicast
  return "public";
}

/** Classify an IP literal (IPv4 or IPv6). Anything unparseable is "private", so it is refused by default. */
export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) return classifyV4(v4ToInt(ip)!);
  if (family === 6) {
    const h = parseV6(ip);
    return h ? classifyV6(h) : "private";
  }
  return "private";
}

// ----------------------------------------------------------------------------
// URL checks
// ----------------------------------------------------------------------------

const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal"]);

/** Lowercase hostname without IPv6 brackets or trailing dots. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

/** localhost and *.localhost always mean loopback (RFC 6761); they are never sent to DNS. */
function isLoopbackName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

export interface UrlGuardOptions {
  /** How the URL is named in errors, e.g. "base_url" or "ROUNDTABLE_WEBHOOK_URL". */
  label?: string;
  /** Allow private, CGNAT, link-local and ULA targets. Default: ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS. */
  allowPrivate?: boolean;
  lookupTimeoutMs?: number;
}

function assertAllowed(cls: AddressClass, what: string, label: string, allowPrivate: boolean): void {
  if (cls === "metadata") {
    throw new UrlGuardError(`${label} refused: ${what} is a cloud metadata address`);
  }
  if (cls === "private" && !allowPrivate) {
    throw new UrlGuardError(
      `${label} refused: ${what} is a private, link-local or reserved address ` +
        `(set ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1 to allow private networks)`
    );
  }
}

/**
 * The checks that need no DNS: a valid URL, https (or http to a loopback literal or localhost), no
 * userinfo, no metadata host name, and an allowed class for a literal address. Returns the parsed URL.
 */
export function checkUrl(raw: string, opts: UrlGuardOptions = {}): URL {
  const label = opts.label ?? "URL";
  const allowPrivate = opts.allowPrivate ?? allowPrivateBaseUrls();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError(`${label} is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new UrlGuardError(`${label} must not contain credentials (user:password@): ${describeUrl(url)}`);
  }
  const host = hostOf(url);
  const literal = isIP(host) ? classifyAddress(host) : undefined;
  const loopback = literal === "loopback" || (literal === undefined && isLoopbackName(host));
  if (url.protocol === "http:") {
    if (!loopback) throw new UrlGuardError(`${label} must use https (http is allowed only to loopback): ${describeUrl(url)}`);
  } else if (url.protocol !== "https:") {
    throw new UrlGuardError(`${label} must use https: ${describeUrl(url)}`);
  }
  if (METADATA_HOSTS.has(host)) assertAllowed("metadata", host, label, allowPrivate);
  if (literal) assertAllowed(literal, host, label, allowPrivate);
  return url;
}

async function lookupAll(host: string, label: string, timeoutMs: number): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UrlGuardError(`${label}: could not resolve ${host} within ${timeoutMs} ms`, true)),
      timeoutMs
    );
    timer.unref?.();
  });
  try {
    const found = await Promise.race([dns.lookup(host, { all: true, verbatim: true }), timeout]);
    if (!found.length) throw new UrlGuardError(`${label}: ${host} has no addresses`, true);
    return found.map((a) => a.address);
  } catch (e) {
    if (e instanceof UrlGuardError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    throw new UrlGuardError(`${label}: could not resolve ${host}${code ? ` (${code})` : ""}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * checkUrl, then resolve a host name (short timeout) and check every address it has. Literal
 * addresses and localhost names are never sent to DNS. Throws UrlGuardError; returns the parsed URL.
 */
export async function guardUrl(raw: string, opts: UrlGuardOptions = {}): Promise<URL> {
  const url = checkUrl(raw, opts);
  const host = hostOf(url);
  if (isIP(host) || isLoopbackName(host)) return url;
  const label = opts.label ?? "URL";
  const allowPrivate = opts.allowPrivate ?? allowPrivateBaseUrls();
  for (const address of await lookupAll(host, label, opts.lookupTimeoutMs ?? URL_GUARD_LOOKUP_TIMEOUT_MS)) {
    assertAllowed(classifyAddress(address), `${host} (${address})`, label, allowPrivate);
  }
  return url;
}
