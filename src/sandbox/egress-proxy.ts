// ============================================================================
// Egress-allowlist proxy for dependency installs
//
// A command that needs the network (an install step with contract.sandbox.install.egress) runs on an
// --internal Docker network whose only other member is this proxy. The proxy container also sits on
// the default bridge, so it is the single way out, and it only tunnels:
//   - CONNECT <host>:443, where host is a DNS name on the allowlist (exact, or "*.suffix" for
//     subdomains), and
//   - only when every address the host resolves to is public (no private, loopback, link-local,
//     CGNAT, metadata or reserved ranges). The tunnel goes to the address that was checked, so a
//     second DNS answer cannot rebind it.
// Plain-HTTP requests are refused outright, allowlisted or not: registries serve HTTPS, and a
// cleartext fetch would be both unauthenticated and unrestricted in what it carries.
//
// The decision functions below are ordinary exports (unit-tested here) and are also serialized
// with Function.prototype.toString into the proxy's source, so the proxy runs exactly the tested
// code. They must therefore stay self-contained: no imports, no module-level references.
// ============================================================================

import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../security/child-env.js";
import { DEFAULT_PROXY_IMAGE, SANDBOX_ENV, SandboxRequestError, validateWorkdir } from "./common.js";
import { registerInflight, runQuiet } from "./process.js";

export const EGRESS_PROXY_PORT = 3128;
/** The only port a tunnel may reach. */
export const EGRESS_ALLOWED_PORT = 443;

// ============================================================================
// Pure decision functions (serialized into the proxy)
// ============================================================================

/** Dotted-quad IPv4 as four octets, or null. */
export function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return o.every((n) => n <= 255) ? o : null;
}

/** IPv6 (optionally bracketed, with a zone or an embedded IPv4 tail) as eight 16-bit groups, or null. */
export function parseIPv6(s: string): number[] | null {
  let ip = String(s).toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;
  const lastColon = ip.lastIndexOf(":");
  if (ip.indexOf(".", lastColon) > 0) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.slice(lastColon + 1));
    if (!m) return null;
    const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (!o.every((n) => n <= 255)) return null;
    ip = ip.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...new Array(fill).fill("0"), ...tail];
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out.length === 8 ? out : null;
}

/** True for any IPv4 address outside public unicast, plus known cloud metadata endpoints. */
export function isBlockedIPv4(o: number[]): boolean {
  const [a, b, c, d] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && (b & 0xc0) === 64) return true; // 100.64/10 CGNAT (also Alibaba metadata 100.100.100.200)
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && (b & 0xf0) === 16) return true; // 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b & 0xfe) === 18) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  if (a === 168 && b === 63 && c === 129 && d === 16) return true; // Azure WireServer
  return false;
}

/** True unless `ip` is a public unicast address. Anything unparseable is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedIPv4(v4);
  const g = parseIPv6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return isBlockedIPv4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(6)) return true; // ::, ::1, deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0 || isBlockedIPv4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // Teredo, ORCHID, benchmarking and other IETF blocks
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if ((g[0] & 0xe000) !== 0x2000) return true; // only 2000::/3 is global unicast (ULA, link-local, multicast all fail here)
  return false;
}

/** Lower-cased DNS name without a trailing dot, or null when it is not one (IP literals included). */
export function normalizeHost(host: string): string | null {
  let h = String(host).trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 253) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return h;
}

/** True when `host` equals an allowlist entry or is a subdomain of a "*.suffix" entry (case-insensitive). */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const raw of allowlist) {
    const e = String(raw).trim().toLowerCase().replace(/\.$/, "");
    if (e.startsWith("*.")) {
      const base = e.slice(2);
      if (base.includes(".") && h.endsWith("." + base)) return true;
    } else if (e && h === e) return true;
  }
  return false;
}

export type ConnectDecision =
  | { allow: true; host: string; port: number }
  | { allow: false; status: 400 | 403; reason: string };

/** Decide a CONNECT request target (`host:port`, the authority form). The address check comes after DNS. */
export function decideConnect(target: string, allowlist: readonly string[]): ConnectDecision {
  const t = String(target ?? "").trim();
  const m = /^(\[[^\]]*\]|[^:\s]+):(\d{1,5})$/.exec(t);
  if (!m) return { allow: false, status: 400, reason: "malformed CONNECT target" };
  const port = Number(m[2]);
  const host = m[1];
  if (port !== 443) return { allow: false, status: 403, reason: `port ${port} is not allowed (443 only)` };
  const name = normalizeHost(host);
  if (!name) return { allow: false, status: 403, reason: `${host.slice(0, 80)} is not a fully qualified DNS name (IP literals are refused)` };
  if (!hostAllowed(name, allowlist)) return { allow: false, status: 403, reason: `${name} is not on the egress allowlist` };
  return { allow: true, host: name, port };
}

/** After DNS: the address to dial, or the reason to refuse (every answer must be public). */
export function decideAddresses(addresses: readonly string[]): { ok: true; address: string } | { ok: false; reason: string } {
  if (!addresses.length) return { ok: false, reason: "no addresses" };
  for (const a of addresses) if (isBlockedAddress(a)) return { ok: false, reason: `resolves to a non-public address (${a})` };
  return { ok: true, address: addresses[0] };
}

// ============================================================================
// Proxy source
// ============================================================================

const PROXY_MAIN = String.raw`
const ALLOW = (process.env.RT_EGRESS_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.RT_PROXY_PORT || 3128);
const HOST = process.env.RT_PROXY_HOST || "0.0.0.0";
const MAX_CONNECTIONS = 128;
const CONNECT_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 300000;
let active = 0;

const log = (m) => process.stderr.write("[egress] " + m + "\n");
const STATUS = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway", 503: "Service Unavailable" };

function refuse(sock, status, reason) {
  log("deny " + reason);
  try {
    sock.end("HTTP/1.1 " + status + " " + (STATUS[status] || "Error") + "\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" + reason + "\n");
  } catch {}
}

const server = http.createServer((req, res) => {
  log("deny plain HTTP " + String(req.method).slice(0, 16));
  res.writeHead(403, { "content-type": "text/plain", connection: "close" });
  res.end("egress proxy: only CONNECT to allowlisted hosts on port 443\n");
});

server.on("connect", (req, sock, head) => {
  sock.on("error", () => {});
  if (active >= MAX_CONNECTIONS) return refuse(sock, 503, "too many connections");
  const d = decideConnect(req.url || "", ALLOW);
  if (!d.allow) return refuse(sock, d.status, d.reason);
  dns.lookup(d.host, { all: true, verbatim: true }, (err, answers) => {
    if (err) return refuse(sock, 502, d.host + " did not resolve");
    const pick = decideAddresses(answers.map((a) => a.address));
    if (!pick.ok) return refuse(sock, 403, d.host + " " + pick.reason);
    active++;
    let done = false;
    const up = net.connect({ host: pick.address, port: d.port });
    const close = () => {
      if (done) return;
      done = true;
      active--;
      up.destroy();
      sock.destroy();
    };
    up.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!up.connecting) return;
      log("connect timeout " + d.host);
      refuse(sock, 502, "upstream connect timed out");
      close();
    });
    up.on("connect", () => {
      log("allow " + d.host + " -> " + pick.address);
      up.setTimeout(IDLE_TIMEOUT_MS, close);
      sock.setTimeout(IDLE_TIMEOUT_MS, close);
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", (e) => {
      if (up.connecting) refuse(sock, 502, "upstream connect failed");
      close();
    });
    up.on("close", close);
    sock.on("close", close);
  });
});

server.on("clientError", (_e, sock) => sock.destroy());
server.listen(PORT, HOST, () => process.stdout.write("listening " + server.address().port + "\n"));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(0));
`;

/** The proxy as a standalone ES module (node >= 18, no dependencies). */
export const EGRESS_PROXY_SOURCE = [
  "// agent-roundtable egress proxy (generated; see src/sandbox/egress-proxy.ts)",
  'import http from "node:http";',
  'import net from "node:net";',
  'import dns from "node:dns";',
  ...[parseIPv4, parseIPv6, isBlockedIPv4, isBlockedAddress, normalizeHost, hostAllowed, decideConnect, decideAddresses].map((f) => f.toString()),
  PROXY_MAIN,
].join("\n\n");

// ============================================================================
// Allowlist validation
// ============================================================================

/** Validate, lower-case, de-duplicate and sort allowlist entries ("host.tld" or "*.suffix.tld"). */
export function normalizeAllowlist(allowlist: readonly string[]): string[] {
  if (!Array.isArray(allowlist) || allowlist.length === 0) throw new SandboxRequestError("egress allowlist must be a non-empty array of host names");
  const out = new Set<string>();
  for (const raw of allowlist) {
    if (typeof raw !== "string") throw new SandboxRequestError("egress allowlist entries must be strings");
    const e = raw.trim().toLowerCase().replace(/\.$/, "");
    const wild = e.startsWith("*.");
    const base = wild ? e.slice(2) : e;
    const host = normalizeHost(base);
    if (!host) throw new SandboxRequestError(`egress allowlist entry ${JSON.stringify(raw)} is not a host name ("registry.npmjs.org" or "*.example.org")`);
    out.add(wild ? `*.${host}` : host);
  }
  return [...out].sort();
}

// ============================================================================
// Docker network and proxy container
// ============================================================================

export interface EgressNetwork {
  /** The --internal network commands join. */
  network: string;
  /** http://<proxy container>:3128, for HTTPS_PROXY / HTTP_PROXY. */
  proxyUrl: string;
  allowlist: string[];
  /** Remove the proxy container, the network and the mounted source. Idempotent; never throws. */
  teardown(): Promise<void>;
}

export interface EgressOptions {
  /** The execution tag (executionTag(id)); names and labels resources rt-egress-<tag>-<id>. */
  executionTag: string;
  allowlist: string[];
  /** Default: ROUNDTABLE_SANDBOX_PROXY_IMAGE or node:22-alpine. */
  image?: string;
  dockerPath?: string;
  /** Source of ROUNDTABLE_SANDBOX_PROXY_IMAGE; default process.env. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const TAG_RE = /^[a-z0-9]{1,32}$/;
const DOCKER_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 15_000;
/** Label on every egress resource, so leftovers from a crashed process can be swept per execution. */
export const EGRESS_LABEL = "io.agent-roundtable.egress";
/** The proxy runs as nobody; it only needs to read its own script. */
const PROXY_USER = "65534:65534";

function dockerEnv(): Record<string, string> {
  return childEnv("docker");
}

async function waitForReady(docker: string, name: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    const logs = await runQuiet(docker, ["logs", name], dockerEnv(), 5_000);
    if (/^listening \d+/m.test(logs.output)) return true;
    const state = await runQuiet(docker, ["inspect", "--format", "{{.State.Running}}", name], dockerEnv(), 5_000);
    if (state.ok && state.output !== "true") return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Create an --internal network and a proxy container that is its only way out, allowing CONNECT
 * to the allowlisted hosts on 443. Each call creates its own pair (rt-egress-<tag>-<id>,
 * rt-proxy-<tag>-<id>), so concurrent installs in different processes never share or tear down
 * each other's proxy. Throws when Docker refuses; partial resources are removed first.
 */
export async function ensureEgressNetwork(opts: EgressOptions): Promise<EgressNetwork> {
  const tag = String(opts.executionTag ?? "").toLowerCase();
  if (!TAG_RE.test(tag)) throw new SandboxRequestError(`execution tag ${JSON.stringify(opts.executionTag)} must be 1-32 lowercase letters or digits`);
  const allowlist = normalizeAllowlist(opts.allowlist);
  const docker = opts.dockerPath ?? "docker";
  const env = opts.env ?? process.env;
  const image = opts.image ?? ((env[SANDBOX_ENV.PROXY_IMAGE] ?? "").trim() || DEFAULT_PROXY_IMAGE);
  const id = randomBytes(4).toString("hex");
  const network = `rt-egress-${tag}-${id}`;
  const proxy = `rt-proxy-${tag}-${id}`;
  // The script directory is bind-mounted, so its path must be safe inside --mount.
  validateWorkdir(tmpdir());
  const dir = mkdtempSync(join(tmpdir(), "rt-egress-"));

  let tornDown = false;
  let untrack = () => {};
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    untrack();
    await runQuiet(docker, ["rm", "-f", proxy], dockerEnv(), DOCKER_TIMEOUT_MS);
    await runQuiet(docker, ["network", "rm", network], dockerEnv(), DOCKER_TIMEOUT_MS);
    rmSync(dir, { recursive: true, force: true });
  };
  untrack = registerInflight({ label: proxy, stop: teardown });

  const fail = async (what: string, output: string): Promise<never> => {
    await teardown();
    throw new Error(`egress proxy: ${what}${output ? `: ${output.slice(0, 500)}` : ""}`);
  };

  try {
    // The script must be readable by the proxy's unprivileged user whatever the process umask is.
    const script = join(dir, "egress-proxy.mjs");
    writeFileSync(script, EGRESS_PROXY_SOURCE);
    chmodSync(script, 0o644);
    chmodSync(dir, 0o755);

    const label = `${EGRESS_LABEL}=${tag}`;
    const created = await runQuiet(docker, ["network", "create", "--internal", "--label", label, network], dockerEnv(), DOCKER_TIMEOUT_MS, opts.signal);
    if (!created.ok) return await fail("could not create the internal network", created.output);

    const present = await runQuiet(docker, ["image", "inspect", "--format", "{{.Id}}", image], dockerEnv(), DOCKER_TIMEOUT_MS, opts.signal);
    if (!present.ok) {
      const pulled = await runQuiet(docker, ["pull", image], dockerEnv(), PULL_TIMEOUT_MS, opts.signal);
      if (!pulled.ok) return await fail(`could not pull ${image}`, pulled.output);
    }

    const run = await runQuiet(
      docker,
      [
        "run", "-d", "--rm",
        "--name", proxy,
        "--label", label,
        "--network", "bridge",
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "64",
        "--memory", "256m",
        "--cpus", "1",
        "--user", PROXY_USER,
        "--mount", `type=bind,src=${dir},dst=/proxy,readonly`,
        "-e", `RT_EGRESS_ALLOW=${allowlist.join(",")}`,
        "-e", `RT_PROXY_PORT=${EGRESS_PROXY_PORT}`,
        image,
        "node", "/proxy/egress-proxy.mjs",
      ],
      dockerEnv(),
      DOCKER_TIMEOUT_MS,
      opts.signal
    );
    if (!run.ok) return await fail("could not start the proxy container", run.output);

    const joined = await runQuiet(docker, ["network", "connect", network, proxy], dockerEnv(), DOCKER_TIMEOUT_MS, opts.signal);
    if (!joined.ok) return await fail("could not attach the proxy to the internal network", joined.output);

    if (!(await waitForReady(docker, proxy, opts.signal))) {
      const logs = await runQuiet(docker, ["logs", proxy], dockerEnv(), 5_000);
      return await fail("the proxy did not start", logs.output);
    }
  } catch (e) {
    if (!tornDown) await teardown();
    throw e;
  }

  return { network, proxyUrl: `http://${proxy}:${EGRESS_PROXY_PORT}`, allowlist, teardown };
}

/** Remove every egress proxy and network left for an execution (e.g. after a crash). Never throws. */
export async function sweepEgress(executionTag: string, dockerPath = "docker"): Promise<void> {
  const tag = String(executionTag ?? "").toLowerCase();
  if (!TAG_RE.test(tag)) return;
  const filter = `label=${EGRESS_LABEL}=${tag}`;
  const ps = await runQuiet(dockerPath, ["ps", "-aq", "--filter", filter], dockerEnv(), DOCKER_TIMEOUT_MS);
  const ids = ps.ok ? ps.output.split(/\s+/).filter(Boolean) : [];
  if (ids.length) await runQuiet(dockerPath, ["rm", "-f", ...ids], dockerEnv(), DOCKER_TIMEOUT_MS);
  const nets = await runQuiet(dockerPath, ["network", "ls", "-q", "--filter", filter], dockerEnv(), DOCKER_TIMEOUT_MS);
  const netIds = nets.ok ? nets.output.split(/\s+/).filter(Boolean) : [];
  if (netIds.length) await runQuiet(dockerPath, ["network", "rm", ...netIds], dockerEnv(), DOCKER_TIMEOUT_MS);
}
