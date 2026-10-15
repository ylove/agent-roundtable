import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildDockerRunArgs, dockerLimitsFromEnv, defaultSandboxImage, containerUser, DockerBackend, DEFAULT_DOCKER_LIMITS } = await import("../../dist/sandbox/docker.js");
const { SandboxRequestError } = await import("../../dist/sandbox/common.js");
const { runQuiet } = await import("../../dist/sandbox/process.js");
const { childEnv } = await import("../../dist/security/child-env.js");

const real = await new DockerBackend().available();
const NO_DOCKER = real.ok ? false : "docker is not available";

const base = { name: "rt-cmd-abc123", uid: 501, gid: 20, image: "node:22-bookworm-slim", limits: DEFAULT_DOCKER_LIMITS };

// ============================================================================
// buildDockerRunArgs
// ============================================================================

test("buildDockerRunArgs: the full hardened argv", () => {
  const req = {
    argv: ["npm", "test", "--", "--grep", "a b"],
    workdir: "/srv/worktrees/task-1",
    cwd: "./packages//api",
    env: { NODE_ENV: "test", CI: "1" },
    timeoutMs: 60_000,
  };
  assert.deepEqual(buildDockerRunArgs(req, base), [
    "run", "--rm", "--init",
    "--name", "rt-cmd-abc123",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--memory", "2g",
    "--cpus", "2",
    "--user", "501:20",
    "-e", "HOME=/tmp",
    "-e", "NODE_ENV=test",
    "-e", "CI=1",
    "--mount", "type=bind,src=/srv/worktrees/task-1,dst=/work",
    "-w", "/work/packages/api",
    "node:22-bookworm-slim",
    "npm", "test", "--", "--grep", "a b",
  ]);
});

test("buildDockerRunArgs: egress joins the internal network and points the proxy variables at the proxy", () => {
  const req = { argv: ["npm", "ci"], workdir: "/srv/wt", egress: ["registry.npmjs.org"], timeoutMs: 1 };
  const args = buildDockerRunArgs(req, { ...base, egress: { network: "rt-egress-abc123-0011aabb", proxyUrl: "http://rt-proxy-abc123-0011aabb:3128" } });
  assert.equal(args[args.indexOf("--network") + 1], "rt-egress-abc123-0011aabb");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) assert.ok(args.includes(`${k}=http://rt-proxy-abc123-0011aabb:3128`), k);
  assert.equal(args[args.indexOf("-w") + 1], "/work");
  assert.deepEqual(args.slice(-3), ["node:22-bookworm-slim", "npm", "ci"]);
  // No egress requested: the network stays none even when one is offered.
  const none = buildDockerRunArgs({ argv: ["true"], workdir: "/srv/wt", egress: [], timeoutMs: 1 }, { ...base, egress: { network: "rt-egress-x", proxyUrl: "http://p:3128" } });
  assert.equal(none[none.indexOf("--network") + 1], "none");
  assert.ok(!none.some((a) => a.includes("PROXY")));
  // Egress requested without a prepared network is refused rather than silently offline.
  assert.throws(() => buildDockerRunArgs(req, base), /no egress network/);
});

test("buildDockerRunArgs: req.image overrides the default and limits come from opts", () => {
  const args = buildDockerRunArgs(
    { argv: ["python", "-V"], workdir: "/srv/wt", image: "python:3.12-slim@sha256:" + "a".repeat(64), timeoutMs: 1 },
    { ...base, limits: { memory: "512m", cpus: "0.5", pids: 64 } }
  );
  assert.equal(args[args.indexOf("--memory") + 1], "512m");
  assert.equal(args[args.indexOf("--cpus") + 1], "0.5");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "64");
  assert.equal(args.at(-3), "python:3.12-slim@sha256:" + "a".repeat(64));
});

test("buildDockerRunArgs refuses secrets, reserved names, escapes, option-like images and root", () => {
  const ok = { argv: ["true"], workdir: "/srv/wt", timeoutMs: 1 };
  const cases = [
    [{ ...ok, env: { NPM_TOKEN: "x" } }, base, /credential/],
    [{ ...ok, env: { MY_API_KEY: "x" } }, base, /credential/],
    [{ ...ok, env: { HOME: "/root" } }, base, /set by the sandbox/],
    [{ ...ok, env: { https_proxy: "http://evil" } }, base, /set by the sandbox/],
    [{ ...ok, cwd: "../other" }, base, /stay inside/],
    [{ ...ok, cwd: "/etc" }, base, /stay inside/],
    [{ ...ok, workdir: "relative" }, base, /absolute/],
    [{ ...ok, workdir: "/srv/wt,dst=/etc" }, base, /cannot mount safely/],
    [{ ...ok, image: "--privileged" }, base, /invalid image/],
    [{ ...ok, image: "" }, base, /invalid image/],
    [{ ...ok, argv: ["sh\0"] }, base, /NUL/],
    [{ ...ok, argv: [] }, base, /non-empty/],
    [ok, { ...base, uid: 0 }, /root/],
    [ok, { ...base, name: "-x" }, /container name/],
    [ok, { ...base, limits: { memory: "lots", cpus: "2", pids: 512 } }, /limits/],
    [ok, { ...base, limits: { memory: "2g", cpus: "0", pids: 512 } }, /limits/],
  ];
  for (const [req, opts, re] of cases) assert.throws(() => buildDockerRunArgs(req, opts), (e) => e instanceof SandboxRequestError && re.test(e.message), JSON.stringify(req));
});

test("limits, image and user come from the environment with safe fallbacks", () => {
  assert.deepEqual(dockerLimitsFromEnv({}), DEFAULT_DOCKER_LIMITS);
  assert.deepEqual(
    dockerLimitsFromEnv({ ROUNDTABLE_SANDBOX_MEMORY: "4g", ROUNDTABLE_SANDBOX_CPUS: "1.5", ROUNDTABLE_SANDBOX_PIDS: "1024" }),
    { memory: "4g", cpus: "1.5", pids: 1024 }
  );
  assert.deepEqual(dockerLimitsFromEnv({ ROUNDTABLE_SANDBOX_MEMORY: "-1", ROUNDTABLE_SANDBOX_CPUS: "all", ROUNDTABLE_SANDBOX_PIDS: "3" }), DEFAULT_DOCKER_LIMITS);
  assert.equal(defaultSandboxImage({}), "node:22-bookworm-slim");
  assert.equal(defaultSandboxImage({ ROUNDTABLE_SANDBOX_IMAGE: "ghcr.io/acme/ci:1" }), "ghcr.io/acme/ci:1");
  const u = containerUser();
  assert.ok(u.uid > 0 && Number.isInteger(u.gid));
});

// ============================================================================
// DockerBackend against a fake docker CLI (runs everywhere)
// ============================================================================

function fakeDocker({ down = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-fake-docker-"));
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.keys(process.env).sort() }) + "\\n");
const dir = ${JSON.stringify(dir)};
switch (args[0]) {
  case "info":
    if (${down}) { console.error("Cannot connect to the Docker daemon. Is the docker daemon running?"); process.exit(1); }
    console.log("27.1.1"); process.exit(0);
  case "image":
    console.log(args[3].includes("RepoDigests") ? "rt-test-image@sha256:feedface" : "sha256:deadbeef"); process.exit(0);
  case "logs":
    console.log("listening 3128"); process.exit(0);
  case "inspect":
    console.log("true"); process.exit(0);
  case "run": {
    const name = args[args.indexOf("--name") + 1];
    if (args[1] === "-d") { console.log("c0ffee"); process.exit(0); }
    fs.writeFileSync(dir + "/" + name + ".pid", String(process.pid));
    const cmd = args.slice(args.indexOf("rt-test-image:1") + 1);
    if (cmd[0] === "hang") { setInterval(() => {}, 1000); break; }
    console.log("ran " + cmd.join(" "));
    console.error("leaked " + (process.env.SANDBOX_DOCKER_TEST_TOKEN || "nothing"));
    process.exit(/^\\d+$/.test(cmd[1] || "") ? Number(cmd[1]) : 0);
  }
  case "kill": {
    try { process.kill(Number(fs.readFileSync(dir + "/" + args[1] + ".pid", "utf8")), "SIGKILL"); } catch {}
    process.exit(0);
  }
  default:
    process.exit(0);
}
`
  );
  chmodSync(bin, 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { bin, calls, dir };
}

test("available() reports the daemon state", async () => {
  assert.deepEqual(await new DockerBackend({ dockerPath: fakeDocker().bin }).available(), { ok: true });
  const down = await new DockerBackend({ dockerPath: fakeDocker({ down: true }).bin }).available();
  assert.equal(down.ok, false);
  assert.match(down.reason, /Cannot connect to the Docker daemon/);
  const missing = await new DockerBackend({ dockerPath: "/nonexistent/docker" }).available();
  assert.equal(missing.ok, false);
});

test("run() spawns docker with the docker env profile, records the digest and returns the output", async () => {
  const fake = fakeDocker();
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  process.env.SANDBOX_DOCKER_TEST_TOKEN = "should-never-reach-docker";
  try {
    const backend = new DockerBackend({ dockerPath: fake.bin, image: "rt-test-image:1" });
    const r = await backend.run({ argv: ["echo", "0"], workdir: work, timeoutMs: 10_000 });
    assert.equal(r.exit, 0);
    assert.equal(r.backend, "docker");
    assert.equal(r.timedOut, false);
    assert.equal(r.imageDigest, "rt-test-image@sha256:feedface");
    assert.match(r.output, /ran echo 0/);
    assert.match(r.output, /leaked nothing/);
    const run = fake.calls().find((c) => c.args[0] === "run");
    assert.ok(run.args.includes(`type=bind,src=${work},dst=/work`));
    assert.match(run.args[run.args.indexOf("--name") + 1], /^rt-cmd-[0-9a-z]{12}$/);
    assert.ok(!run.env.includes("SANDBOX_DOCKER_TEST_TOKEN"), "docker CLI env is the allowlisted profile");
    const failed = await backend.run({ argv: ["exit", "7"], workdir: work, timeoutMs: 10_000 });
    assert.equal(failed.exit, 7);
  } finally {
    delete process.env.SANDBOX_DOCKER_TEST_TOKEN;
  }
});

test("on timeout run() kills the container by name, then the client, then removes it", async () => {
  const fake = fakeDocker();
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  const backend = new DockerBackend({ dockerPath: fake.bin, image: "rt-test-image:1" });
  const started = Date.now();
  const r = await backend.run({ argv: ["hang"], workdir: work, timeoutMs: 1_500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL");
  assert.ok(Date.now() - started < 10_000);
  // afterKill is fire-and-forget; give it a moment.
  await new Promise((res) => setTimeout(res, 500));
  const calls = fake.calls().map((c) => c.args);
  const name = calls.find((a) => a[0] === "run")[calls.find((a) => a[0] === "run").indexOf("--name") + 1];
  const kill = calls.findIndex((a) => a[0] === "kill" && a[1] === name);
  const rm = calls.findIndex((a) => a[0] === "rm" && a.includes(name));
  assert.ok(kill > 0, "docker kill <name> was called");
  assert.ok(rm > kill, "docker rm -f <name> followed");
});

test("run() refuses invalid requests before touching docker", async () => {
  const fake = fakeDocker();
  const backend = new DockerBackend({ dockerPath: fake.bin, image: "rt-test-image:1" });
  await assert.rejects(backend.run({ argv: ["true"], workdir: "/nonexistent-rt-workdir", timeoutMs: 1000 }), /does not exist/);
  await assert.rejects(backend.run({ argv: ["true"], workdir: tmpdir(), env: { GH_TOKEN: "x" }, timeoutMs: 1000 }), /credential/);
  await assert.rejects(backend.run({ argv: ["true"], workdir: tmpdir(), cwd: "rt-missing-subdir", timeoutMs: 1000 }), /does not exist/);
  await assert.rejects(backend.run({ argv: ["true"], workdir: tmpdir(), egress: ["*"], timeoutMs: 1000 }), /allowlist/);
  assert.equal(fake.calls().length, 0);
  assert.throws(() => new DockerBackend({ executionTag: "Not A Tag" }), /execution tag/);
});

test("egress run() joins a fresh internal network with the proxy variables, then tears it down", async () => {
  const fake = fakeDocker();
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  const backend = new DockerBackend({ dockerPath: fake.bin, image: "rt-test-image:1", executionTag: "abc123" });
  const r = await backend.run({ argv: ["npm", "ci"], workdir: work, egress: ["registry.npmjs.org"], timeoutMs: 20_000 });
  assert.equal(r.exit, 0, r.output);
  const calls = fake.calls().map((c) => c.args);
  const create = calls.find((a) => a[0] === "network" && a[1] === "create");
  assert.ok(create.includes("--internal"));
  const network = create.at(-1);
  assert.match(network, /^rt-egress-abc123-[0-9a-f]{8}$/);
  const proxyRun = calls.find((a) => a[0] === "run" && a[1] === "-d");
  const proxy = proxyRun[proxyRun.indexOf("--name") + 1];
  for (const flag of ["--read-only", "no-new-privileges", "ALL", "65534:65534", "RT_EGRESS_ALLOW=registry.npmjs.org"]) assert.ok(proxyRun.includes(flag), flag);
  assert.ok(proxyRun.some((a) => a.endsWith("dst=/proxy,readonly")));
  assert.deepEqual(calls.find((a) => a[0] === "network" && a[1] === "connect"), ["network", "connect", network, proxy]);
  const cmd = calls.find((a) => a[0] === "run" && a[1] === "--rm");
  assert.equal(cmd[cmd.indexOf("--network") + 1], network);
  assert.ok(cmd.includes(`HTTPS_PROXY=http://${proxy}:3128`));
  const rmProxy = calls.findIndex((a) => a[0] === "rm" && a.includes(proxy));
  const rmNet = calls.findIndex((a) => a[0] === "network" && a[1] === "rm" && a[2] === network);
  assert.ok(rmProxy > calls.indexOf(cmd) && rmNet > rmProxy, "proxy and network removed after the command");
});

// ============================================================================
// Real Docker (skipped without a daemon; runs in CI)
// ============================================================================

test("docker: non-root, HOME=/tmp, only the given env, writable /work, read-only root, no network", { skip: NO_DOCKER, timeout: 300_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  process.env.SANDBOX_DOCKER_TEST_TOKEN = "host-secret-value-123";
  try {
    const backend = new DockerBackend();
    const script = `
      const fs = require("node:fs");
      const out = { uid: process.getuid(), home: process.env.HOME, cwd: process.cwd(), secret: process.env.SANDBOX_DOCKER_TEST_TOKEN ?? null, mine: process.env.MY_FLAG };
      fs.writeFileSync("/work/inside.txt", "ok");
      try { fs.writeFileSync("/etc/rt-test", "x"); out.root = "writable"; } catch (e) { out.root = e.code; }
      const s = require("node:net").connect(443, "1.1.1.1");
      s.setTimeout(5000, () => { out.net = "timeout"; console.log(JSON.stringify(out)); process.exit(0); });
      s.on("connect", () => { out.net = "connected"; console.log(JSON.stringify(out)); process.exit(0); });
      s.on("error", (e) => { out.net = e.code; console.log(JSON.stringify(out)); process.exit(0); });
    `;
    const r = await backend.run({ argv: ["node", "-e", script], workdir: work, env: { MY_FLAG: "yes" }, timeoutMs: 240_000 });
    assert.equal(r.exit, 0, r.output);
    const out = JSON.parse(r.output.trim().split("\n").at(-1));
    assert.ok(out.uid > 0, "runs as non-root");
    assert.equal(out.home, "/tmp");
    assert.equal(out.cwd, "/work");
    assert.equal(out.secret, null);
    assert.equal(out.mine, "yes");
    assert.equal(out.root, "EROFS");
    assert.notEqual(out.net, "connected");
    assert.equal(readFileSync(join(work, "inside.txt"), "utf8"), "ok");
    assert.match(r.imageDigest ?? "", /sha256:/);
  } finally {
    delete process.env.SANDBOX_DOCKER_TEST_TOKEN;
  }
});

test("docker: a timeout kills and removes the container", { skip: NO_DOCKER, timeout: 300_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  const backend = new DockerBackend();
  await backend.prepare();
  const r = await backend.run({ argv: ["node", "-e", "console.log('started'); setInterval(() => {}, 1000)"], workdir: work, timeoutMs: 8_000 });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 2_000));
  const ps = await runQuiet("docker", ["ps", "-aq", "--filter", "name=rt-cmd-"], childEnv("docker"), 30_000);
  assert.equal(ps.output, "", "no rt-cmd containers left");
});

test("docker: egress reaches allowlisted hosts through the proxy and nothing else", { skip: NO_DOCKER, timeout: 300_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rt-wt-"));
  const tag = "t" + Math.random().toString(36).slice(2, 8);
  const backend = new DockerBackend({ executionTag: tag });
  const script = `
    const http = require("node:http");
    const u = new URL(process.env.HTTPS_PROXY);
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
      const s = require("node:net").connect(443, "1.1.1.1");
      s.setTimeout(5000, () => { console.log("direct=timeout"); process.exit(0); });
      s.on("connect", () => { console.log("direct=connected"); process.exit(0); });
      s.on("error", (e) => { console.log("direct=" + e.code); process.exit(0); });
    })();
  `;
  const r = await backend.run({ argv: ["node", "-e", script], workdir: work, egress: ["registry.npmjs.org"], timeoutMs: 240_000 });
  assert.equal(r.exit, 0, r.output);
  assert.match(r.output, /allowed=200/, r.output);
  assert.match(r.output, /denied=403/, r.output);
  assert.doesNotMatch(r.output, /direct=connected/, r.output);
  const left = await runQuiet("docker", ["ps", "-aq", "--filter", `label=io.agent-roundtable.egress=${tag}`], childEnv("docker"), 30_000);
  assert.equal(left.output, "", "the proxy is torn down after the run");
});
