// ============================================================================
// Outbound URL guard (SSRF) for per-call provider base URLs and the webhook publisher
//
// Rules: no userinfo; cloud metadata targets always blocked; private, CGNAT, link-local and ULA
// targets blocked unless opted in. Loopback is always allowed, because local model servers (LM
// Studio, vLLM, llama.cpp, Ollama) live there. https everywhere, except plain http to loopback and,
// when private targets are allowed, to private addresses (LAN model servers and webhook receivers).
// Only the literal name "localhost" and IP literals are classified without DNS.
//
// Guarded requests connect through a pinned lookup; TLS still verifies the URL hostname.
// Callers make redirects manual, so each destination needs its own policy check.
// ============================================================================

// Called as dns.lookup(...) at call time, so tests can stub dns.promises.lookup.
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
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

/**
 * An IPv4 reached through a translator or relay: its metadata stays metadata, but nothing behind it
 * is this host's loopback, so anything non-public is "private". `localUse` prefixes are never public.
 */
function viaTranslator(v4: number, localUse = false): AddressClass {
  const inner = classifyV4(v4);
  if (inner === "metadata") return "metadata";
  return inner === "public" && !localUse ? "public" : "private";
}

function classifyV6(h: number[]): AddressClass {
  if (isZero(h, 0, 8)) return "private"; // unspecified
  if (isZero(h, 0, 7) && h[7] === 1) return "loopback";
  // AWS IMDS over IPv6: fd00:ec2::254
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && isZero(h, 2, 7) && h[7] === 0x254) return "metadata";
  // IPv4-mapped (::ffff:0:0/96, ::ffff:a.b.c.d): the host's own IPv4 stack, so the IPv4 decides.
  if (isZero(h, 0, 5) && h[5] === 0xffff) return classifyV4(embeddedV4(h[6], h[7]));
  // IPv4-translated (::ffff:0:a.b.c.d, SIIT) and IPv4-compatible (::a.b.c.d, deprecated).
  if (isZero(h, 0, 4) && h[4] === 0xffff && h[5] === 0) return viaTranslator(embeddedV4(h[6], h[7]));
  if (isZero(h, 0, 6)) return viaTranslator(embeddedV4(h[6], h[7]));
  // NAT64: the well-known 64:ff9b::/96, and the local-use 64:ff9b:1::/48 (RFC 8215), never public.
  if (h[0] === 0x64 && h[1] === 0xff9b && isZero(h, 2, 6)) return viaTranslator(embeddedV4(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return viaTranslator(embeddedV4(h[6], h[7]), true);
  // 6to4 (2002:a.b.c.d::/48) reaches the embedded IPv4 through a relay.
  if (h[0] === 0x2002) {
    const inner = viaTranslator(embeddedV4(h[1], h[2]));
    if (inner !== "public") return inner;
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

export interface UrlGuardOptions {
  /** How the URL is named in errors, e.g. "base_url" or "ROUNDTABLE_WEBHOOK_URL". */
  label?: string;
  /**
   * Allow private, CGNAT, link-local and ULA targets, over http too.
   * Default: ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS.
   */
  allowPrivate?: boolean;
  lookupTimeoutMs?: number;
}

/** Throw unless a target of class `cls` is allowed over the URL's scheme. */
function assertAllowed(cls: AddressClass, what: string, url: URL, label: string, allowPrivate: boolean): void {
  if (cls === "metadata") {
    throw new UrlGuardError(`${label} refused: ${what} is a cloud metadata address`);
  }
  if (cls === "private" && !allowPrivate) {
    throw new UrlGuardError(
      `${label} refused: ${what} is a private, link-local or reserved address ` +
        `(set ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1 to allow private networks)`
    );
  }
  if (url.protocol === "http:" && cls === "public") {
    throw new UrlGuardError(
      `${label} must use https (http is allowed only to loopback${allowPrivate ? " and private addresses" : ""}): ${describeUrl(url)}`
    );
  }
}

/**
 * The checks that need no DNS: a valid http(s) URL, no userinfo, no metadata host name, and an allowed
 * class (and scheme) for an IP literal or "localhost". Any other host name is decided by guardUrl's
 * lookup. Returns the parsed URL.
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
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlGuardError(`${label} must use https: ${describeUrl(url)}`);
  }
  if (url.username || url.password) {
    throw new UrlGuardError(`${label} must not contain credentials (user:password@): ${describeUrl(url)}`);
  }
  const host = hostOf(url);
  if (METADATA_HOSTS.has(host)) assertAllowed("metadata", host, url, label, allowPrivate);
  if (isIP(host)) assertAllowed(classifyAddress(host), host, url, label, allowPrivate);
  return url;
}

async function lookupAll(host: string, label: string, timeoutMs: number): Promise<string[]> {
  // Not unref'd: a check in flight is real work, and dns.lookup itself may hold no handle open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UrlGuardError(`${label}: could not resolve ${host} within ${timeoutMs} ms`, true)),
      timeoutMs
    );
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
 * checkUrl, then resolve a host name (short timeout) and check every address it has, and the scheme
 * against each. IP literals and "localhost" are never sent to DNS; every other name is (*.localhost
 * included). Throws UrlGuardError; returns the URL and approved addresses.
 */
async function approvedUrl(raw: string, opts: UrlGuardOptions): Promise<{ url: URL; addresses: string[] }> {
  const url = checkUrl(raw, opts);
  const host = hostOf(url);
  if (isIP(host)) return { url, addresses: [] };
  const label = opts.label ?? "URL";
  const allowPrivate = opts.allowPrivate ?? allowPrivateBaseUrls();
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"]
    : await lookupAll(host, label, opts.lookupTimeoutMs ?? URL_GUARD_LOOKUP_TIMEOUT_MS);
  for (const address of addresses) {
    assertAllowed(classifyAddress(address), `${host} (${address})`, url, label, allowPrivate);
  }
  return { url, addresses };
}

export async function guardUrl(raw: string, opts: UrlGuardOptions = {}): Promise<URL> {
  return (await approvedUrl(raw, opts)).url;
}

/** A dispatcher for this URL only. The caller closes it after consuming the response. */
export async function guardedDispatcher(raw: string, opts: UrlGuardOptions = {}): Promise<Agent | undefined> {
  const { addresses } = await approvedUrl(raw, opts);
  if (!addresses.length) return undefined; // IP literals connect directly.
  return new Agent({ connect: { lookup: (_host, options, callback) => {
    const family = typeof options === "number" ? options : options.family;
    const found = addresses.map(address => ({ address, family: isIP(address) }))
      .filter(address => !family || address.family === Number(family));
    if (!found.length) {
      callback(Object.assign(new Error("No approved address for the requested family"), { code: "ENOTFOUND" }), "", 0);
    } else if (typeof options === "object" && options.all) {
      callback(null, found);
    } else {
      callback(null, found[0].address, found[0].family);
    }
  } } });
}
