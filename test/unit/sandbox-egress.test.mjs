import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const egress = await import("../../dist/sandbox/egress-proxy.js");
const { runQuiet } = await import("../../dist/sandbox/process.js");
const { childEnv } = await import("../../dist/security/child-env.js");
const { hostAllowed, normalizeHost, decideConnect, decideAddresses, isBlockedAddress, normalizeAllowlist, EGRESS_PROXY_SOURCE, ensureEgressNetwork } = egress;

const info = await runQuiet("docker", ["info", "--format", "{{.ServerVersion}}"], childEnv("docker"), 5_000);
const NO_DOCKER = info.ok ? false : "docker is not available";

// ============================================================================
// Pure decisions
// ============================================================================

test("hostAllowed matches exact names and *.suffix subdomains, case-insensitively", () => {
  const allow = ["registry.npmjs.org", "*.pythonhosted.org", "PyPI.org."];
  assert.equal(hostAllowed("registry.npmjs.org", allow), true);
  assert.equal(hostAllowed("REGISTRY.NPMJS.ORG.", allow), true);
  assert.equal(hostAllowed("pypi.org", allow), true);
  assert.equal(hostAllowed("files.pythonhosted.org", allow), true);
  assert.equal(hostAllowed("a.b.pythonhosted.org", allow), true);
  // A wildcard covers subdomains only, and suffix tricks do not match.
  assert.equal(hostAllowed("pythonhosted.org", allow), false);
  assert.equal(hostAllowed("evilpythonhosted.org", allow), false);
  assert.equal(hostAllowed("registry.npmjs.org.evil.com", allow), false);
  assert.equal(hostAllowed("npmjs.org", allow), false);
  assert.equal(hostAllowed("x.registry.npmjs.org", allow), false);
  // A bare "*." entry or a single-label wildcard allows nothing.
  assert.equal(hostAllowed("example.com", ["*.", "*.com"]), false);
});

test("normalizeHost accepts DNS names only", () => {
  assert.equal(normalizeHost("Registry.NPMJS.org."), "registry.npmjs.org");
  for (const bad of ["1.2.3.4", "[::1]", "::1", "localhost", "a..b", "-a.com", "a_b.com", "", "x".repeat(64) + ".com", "0x7f.1"]) {
    assert.equal(normalizeHost(bad), null, bad);
  }
});

test("decideConnect allows only allowlisted DNS names on port 443", () => {
  const allow = ["registry.npmjs.org"];
  assert.deepEqual(decideConnect("registry.npmjs.org:443", allow), { allow: true, host: "registry.npmjs.org", port: 443 });
  const cases = [
    ["evil.com:443", 403, /not on the egress allowlist/],
    ["registry.npmjs.org:80", 403, /443 only/],
    ["registry.npmjs.org:8443", 403, /443 only/],
    ["127.0.0.1:443", 403, /not a fully qualified DNS name/],
    ["[::1]:443", 403, /not a fully qualified DNS name/],
    ["169.254.169.254:443", 403, /not a fully qualified DNS name/],
    ["registry.npmjs.org", 400, /malformed/],
    ["http://registry.npmjs.org/", 400, /malformed/],
    ["", 400, /malformed/],
  ];
  for (const [target, status, reason] of cases) {
    const d = decideConnect(target, allow);
    assert.equal(d.allow, false, target);
    assert.equal(d.status, status, target);
    assert.match(d.reason, reason, target);
  }
});

test("isBlockedAddress refuses private, loopback, link-local, metadata and reserved ranges", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.192", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
    "168.63.129.16",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "fe80::1", "fe80::1%en0", "fc00::1", "fd00:ec2::254",
    "ff02::1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:c0a8:0101::1", "2001:db8::1", "2001::1", "::127.0.0.1",
    "not-an-ip", "", "1.2.3", "1.2.3.256", "1:2:3:4:5:6:7:8:9",
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  const allowed = ["104.16.1.35", "8.8.8.8", "172.32.0.1", "100.128.0.1", "::ffff:104.16.1.35", "2606:4700::6810:123", "2a04:4e42::223", "64:ff9b::808:808", "2002:0808:0808::1"];
  for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, ip);
});

test("decideAddresses refuses a host when any answer is non-public (no rebinding through a mixed answer)", () => {
  // IPv4 first: containers often have no IPv6 route, and the proxy falls back through the list.
  assert.deepEqual(decideAddresses(["2606:4700::6810:123", "104.16.1.35", "104.16.0.35"]), { ok: true, addresses: ["104.16.1.35", "104.16.0.35", "2606:4700::6810:123"] });
  assert.equal(decideAddresses(["104.16.1.35", "127.0.0.1"]).ok, false);
  assert.equal(decideAddresses([]).ok, false);
});

test("normalizeAllowlist lower-cases, de-duplicates and refuses non-host entries", () => {
  assert.deepEqual(normalizeAllowlist(["Registry.npmjs.org", "registry.npmjs.org.", "*.PythonHosted.org"]), ["*.pythonhosted.org", "registry.npmjs.org"]);
  for (const bad of [[], ["*"], ["*."], ["1.2.3.4"], ["https://registry.npmjs.org"], ["registry.npmjs.org:443"], ["localhost"], [42]]) {
    assert.throws(() => normalizeAllowlist(bad), /allowlist/, JSON.stringify(bad));
  }
});

// ============================================================================
// The generated proxy, run as a local server
// ============================================================================

const proxies = [];
after(() => {
  for (const p of proxies) p.kill("SIGKILL");
});

async function startProxy(allow) {
  const dir = mkdtempSync(join(tmpdir(), "rt-egress-test-"));
  const file = join(dir, "egress-proxy.mjs");
  writeFileSync(file, EGRESS_PROXY_SOURCE);
  const child = spawn(process.execPath, [file], {
    env: { PATH: process.env.PATH, RT_EGRESS_ALLOW: allow.join(","), RT_PROXY_PORT: "0", RT_PROXY_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxies.push(child);
  const log = [];
  child.stderr.on("data", (d) => log.push(String(d)));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("proxy did not start: " + log.join(""))), 10_000);
    child.stdout.on("data", (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });
  return { port, log };
}

function connect(port, target) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target });
    req.on("connect", (res, sock, head) => {
      let body = head ? String(head) : "";
      sock.on("data", (d) => (body += d));
      sock.on("close", () => resolve({ status: res.statusCode, body }));
      sock.on("error", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: e.code }));
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

test("the proxy source carries the tested decision functions", () => {
  for (const fn of ["function decideConnect(", "function hostAllowed(", "function isBlockedAddress(", "function decideAddresses("]) {
    assert.ok(EGRESS_PROXY_SOURCE.includes(fn), fn);
  }
  assert.ok(!/\brequire\(|\bexports\./.test(EGRESS_PROXY_SOURCE), "the proxy is a standalone ES module");
});

test("the proxy answers 403 to CONNECT for non-allowlisted hosts, other ports and IP literals", async () => {
  const { port, log } = await startProxy(["registry.npmjs.org", "unresolvable-rt-test.invalid.example"]);
  const denied = await connect(port, "example.com:443");
  assert.equal(denied.status, 403);
  assert.match(denied.body, /not on the egress allowlist/);
  assert.equal((await connect(port, "registry.npmjs.org:80")).status, 403);
  assert.equal((await connect(port, "127.0.0.1:443")).status, 403);
  assert.equal((await connect(port, "[::1]:443")).status, 403);
  assert.equal((await connect(port, "garbage")).status, 400);
  // Allowlisted but unresolvable: refused by the gateway, never tunnelled.
  assert.equal((await connect(port, "unresolvable-rt-test.invalid.example:443")).status, 502);
  assert.ok(log.join("").includes("deny example.com is not on the egress allowlist"));
});

test("the proxy releases its connection slot on every refusal (the 128 cap never leaks)", async () => {
  const { port } = await startProxy(["unresolvable-rt-test.invalid.example"]);
  const statuses = new Set();
  for (let i = 0; i < 150; i++) {
    const target = i % 3 === 0 ? "evil.example.com:443" : i % 3 === 1 ? "garbage" : "unresolvable-rt-test.invalid.example:443";
    statuses.add((await connect(port, target)).status);
  }
  assert.ok(!statuses.has(503), [...statuses].join(","));
  assert.deepEqual([...statuses].sort(), [400, 403, 502]);
});

test("the proxy refuses plain-HTTP requests, even to allowlisted hosts", async () => {
  const { port } = await startProxy(["registry.npmjs.org"]);
  const status = await new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: "http://registry.npmjs.org/left-pad", headers: { host: "registry.npmjs.org" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", (e) => resolve(e.code));
  });
  assert.equal(status, 403);
});

// ============================================================================
// Docker (skipped without a daemon; runs in CI)
// ============================================================================

const PROBE = `
const http = require("node:http");
const net = require("node:net");
const u = new URL(process.env.PROXY);
const connect = (target) => new Promise((resolve) => {
  const q = http.request({ host: u.hostname, port: u.port, method: "CONNECT", path: target });
  q.on("connect", (res, s) => { s.destroy(); resolve(res.statusCode); });
  q.on("error", (e) => resolve(e.code));
  q.setTimeout(20000, () => { q.destroy(); resolve("timeout"); });
  q.end();
});
(async () => {
  console.log("allowed=" + await connect("registry.npmjs.org:443"));
  console.log("denied=" + await connect("example.com:443"));
  const s = net.connect(443, "1.1.1.1");
  s.setTimeout(5000, () => { console.log("direct=timeout"); s.destroy(); });
  s.on("connect", () => { console.log("direct=connected"); s.destroy(); });
  s.on("error", (e) => console.log("direct=" + e.code));
})();
`;

test("ensureEgressNetwork builds an internal network whose only way out is the allowlisting proxy", { skip: NO_DOCKER, timeout: 300_000 }, async () => {
  const net = await ensureEgressNetwork({ executionTag: "t" + Math.random().toString(36).slice(2, 8), allowlist: ["registry.npmjs.org"] });
  try {
    assert.match(net.network, /^rt-egress-[a-z0-9]+-[0-9a-f]{8}$/);
    assert.match(net.proxyUrl, /^http:\/\/rt-proxy-[a-z0-9]+-[0-9a-f]{8}:3128$/);
    const internal = await runQuiet("docker", ["network", "inspect", "--format", "{{.Internal}}", net.network], childEnv("docker"), 30_000);
    assert.equal(internal.output, "true");
    const r = await runQuiet(
      "docker",
      ["run", "--rm", "--network", net.network, "-e", `PROXY=${net.proxyUrl}`, "node:22-alpine", "node", "-e", PROBE],
      childEnv("docker"),
      180_000
    );
    assert.match(r.output, /allowed=200/, r.output);
    assert.match(r.output, /denied=403/, r.output);
    assert.doesNotMatch(r.output, /direct=connected/, r.output);
  } finally {
    await net.teardown();
  }
  const gone = await runQuiet("docker", ["network", "inspect", net.network], childEnv("docker"), 30_000);
  assert.equal(gone.ok, false, "network removed by teardown");
});
