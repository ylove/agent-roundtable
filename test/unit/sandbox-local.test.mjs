import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { LocalBackend, buildSeatbeltProfile, SENSITIVE_HOME_PATHS } = await import("../../dist/sandbox/local.js");
const { SandboxRequestError } = await import("../../dist/sandbox/common.js");

const ON = { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "1" };
const darwin = process.platform === "darwin";
const linux = process.platform === "linux";
const node = process.execPath;

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-local-")));
  const rtHome = join(root, "rt-home");
  const work = join(rtHome, "worktrees", "exe-1", "task-1");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(rtHome, "token"), "runner-token");
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { root, rtHome, work, outside };
}

function backend(rtHome, extra = {}) {
  return new LocalBackend({ env: ON, roundtableHome: rtHome, ...extra });
}

const js = (code) => ["node", "-e", code];

// ============================================================================
// Opt-in and request validation (all platforms)
// ============================================================================

test("available() refuses unless ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1", async () => {
  for (const env of [{}, { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "0" }, { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "true" }]) {
    const a = await new LocalBackend({ env }).available();
    assert.equal(a.ok, false);
    assert.match(a.reason, /ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1/);
  }
  await assert.rejects(new LocalBackend({ env: {} }).run({ argv: ["true"], workdir: tmpdir(), timeoutMs: 1000 }), /disabled/);
  const on = await new LocalBackend({ env: ON }).available();
  assert.equal(on.ok, true);
});

test("an unknown platform runs unisolated and says so in available() and every result", async () => {
  const { work, rtHome } = workspace();
  const b = backend(rtHome, { platform: "aix" });
  const a = await b.available();
  assert.equal(a.ok, true);
  assert.match(a.degraded, /without isolation/);
  const r = await b.run({ argv: js("console.log('hi')"), workdir: work, timeoutMs: 10_000 });
  assert.equal(r.exit, 0);
  assert.equal(r.backend, "local");
  assert.match(r.degraded, /without isolation/);
});

test("the local backend refuses shell strings, loader variables, egress and escaping cwds", async () => {
  const { work, rtHome, root } = workspace();
  const b = backend(rtHome, { platform: "aix" });
  const req = { argv: ["true"], workdir: work, timeoutMs: 1000 };
  const bad = [
    [{ ...req, argv: ["sh", "-c", "true"] }, /shell -c/],
    [{ ...req, argv: ["/bin/bash", "-lc", "true"] }, /shell -c/],
    [{ ...req, env: { LD_PRELOAD: "/tmp/x.so" } }, /loader/],
    [{ ...req, env: { DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" } }, /loader/],
    [{ ...req, env: { HOME: "/" } }, /set by the sandbox/],
    [{ ...req, env: { NPM_TOKEN: "x" } }, /credential/],
    [{ ...req, egress: ["registry.npmjs.org"] }, /egress proxy/],
    [{ ...req, cwd: "../.." }, /stay inside/],
    [{ ...req, cwd: "missing" }, /does not exist/],
  ];
  for (const [r, re] of bad) await assert.rejects(b.run(r), (e) => e instanceof SandboxRequestError && re.test(e.message), JSON.stringify(r));
  // A symlink that leads out of the workdir is not a usable cwd.
  symlinkSync(root, join(work, "escape"));
  await assert.rejects(b.run({ ...req, cwd: "escape" }), /outside the workdir/);
});

test("commands get an empty HOME and TMPDIR, the cwd inside the workdir, and none of our secrets", async () => {
  const { work, rtHome } = workspace();
  mkdirSync(join(work, "pkg"));
  process.env.SANDBOX_LOCAL_TEST_API_KEY = "local-secret-value-987";
  try {
    const r = await backend(rtHome, { platform: "aix" }).run({
      argv: js("console.log(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cwd: process.cwd(), keys: Object.keys(process.env) }))"),
      workdir: work,
      cwd: "pkg",
      env: { MY_FLAG: "1" },
      timeoutMs: 10_000,
    });
    assert.equal(r.exit, 0, r.output);
    const out = JSON.parse(r.output);
    assert.equal(out.cwd, join(work, "pkg"));
    assert.match(out.home, /rt-sbx-[^/]+\/home$/);
    assert.match(out.tmp, /rt-sbx-[^/]+\/tmp$/);
    assert.ok(out.keys.includes("MY_FLAG"));
    assert.ok(!out.keys.includes("SANDBOX_LOCAL_TEST_API_KEY"));
    assert.ok(!out.keys.some((k) => /KEY|TOKEN|SECRET/.test(k)), out.keys.join(","));
    assert.equal(existsSync(out.home), false, "the per-run temp dir is removed");
  } finally {
    delete process.env.SANDBOX_LOCAL_TEST_API_KEY;
  }
});

test("buildSeatbeltProfile passes every path as a parameter and re-allows the workdir last", () => {
  const { profile, params } = buildSeatbeltProfile({
    workdir: "/state/worktrees/w1",
    tmp: "/scratch/rt-sbx-1",
    homes: ["/h/me"],
    roundtableHome: "/state",
    denyRead: ["/repo/secrets"],
  });
  assert.ok(!profile.includes("/state") && !profile.includes("/h/me") && !profile.includes("/repo"), "no literal paths in the profile");
  const p = Object.fromEntries(params.filter((_, i) => i % 2 === 1).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  assert.equal(p.WORKDIR, "/state/worktrees/w1");
  assert.equal(p.RT_HOME, "/state");
  assert.equal(p.HOME_0, "/h/me");
  assert.equal(p.DENY_0, "/repo/secrets");
  assert.ok(Object.values(p).includes("/state/worktrees"), "ancestors get metadata access");
  for (const rel of [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".npmrc", ".netrc", "Library/Keychains"]) {
    assert.ok(SENSITIVE_HOME_PATHS.includes(rel), rel);
    assert.ok(profile.includes(`"/${rel}"`), rel);
  }
  assert.match(profile, /\(prefix \(string-append \(param "HOME_0"\) "\/\.claude"\)\)/);
  assert.match(profile, /\(deny network\*\)/);
  const denyRead = profile.indexOf("(deny file-read*");
  const allowRead = profile.indexOf('(allow file-read* (subpath (param "WORKDIR"))');
  assert.ok(denyRead > 0 && allowRead > denyRead, "the workdir allow comes after the deny (last match wins)");
});

// ============================================================================
// macOS: sandbox-exec
// ============================================================================

const mac = { skip: !darwin && "macOS only" };

test("macOS: sandbox-exec is used and not reported as degraded", mac, async () => {
  const b = backend(workspace().rtHome);
  assert.deepEqual(await b.available(), { ok: true });
  assert.equal((await b.isolation()).kind, "sandbox-exec");
});

test("macOS: writes inside the workdir succeed and writes outside it fail", mac, async () => {
  const { work, outside, rtHome } = workspace();
  const b = backend(rtHome);
  const inside = await b.run({ argv: js("require('fs').writeFileSync('inside.txt', 'ok'); require('fs').mkdirSync('sub/dir', { recursive: true })"), workdir: work, timeoutMs: 20_000 });
  assert.equal(inside.exit, 0, inside.output);
  assert.equal(inside.degraded, undefined);
  assert.equal(readFileSync(join(work, "inside.txt"), "utf8"), "ok");
  const out = await b.run({ argv: js(`require('fs').writeFileSync(${JSON.stringify(join(outside, "x.txt"))}, 'no')`), workdir: work, timeoutMs: 20_000 });
  assert.notEqual(out.exit, 0);
  assert.match(out.output, /EPERM|operation not permitted/i);
  assert.equal(existsSync(join(outside, "x.txt")), false);
  const home = await b.run({ argv: js(`require('fs').writeFileSync(${JSON.stringify(join(homedir(), "planted.txt"))}, 'no')`), workdir: work, timeoutMs: 20_000 });
  assert.notEqual(home.exit, 0);
});

test("macOS: network connections fail fast", mac, async () => {
  const { work, rtHome } = workspace();
  const started = Date.now();
  const r = await backend(rtHome).run({
    argv: js(`
      const s = require('net').connect(443, '1.1.1.1');
      s.setTimeout(4000, () => { console.log('net=timeout'); process.exit(2); });
      s.on('connect', () => { console.log('net=connected'); process.exit(0); });
      s.on('error', (e) => { console.log('net=' + e.code); process.exit(3); });
    `),
    workdir: work,
    timeoutMs: 20_000,
  });
  assert.equal(r.exit, 3, r.output);
  assert.match(r.output, /net=EPERM/);
  assert.ok(Date.now() - started < 5_000);
  const loop = await backend(rtHome).run({
    argv: js("const srv = require('net').createServer(); srv.on('error', (e) => { console.log(e.code); process.exit(3); }); srv.listen(0, '127.0.0.1', () => process.exit(0));"),
    workdir: work,
    timeoutMs: 20_000,
  });
  assert.equal(loop.exit, 3, "no loopback listeners either");
});

test("macOS: credential stores, roundtable state and outside .env files are unreadable; the workdir is not", mac, async () => {
  const { work, rtHome, root } = workspace();
  // test-env points HOME at a temp dir, so this is the "fake HOME" the sandbox must protect.
  const ssh = join(homedir(), ".ssh");
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(ssh, "id_test"), "PRIVATE KEY");
  writeFileSync(join(homedir(), ".claude.json"), "{}");
  writeFileSync(join(root, ".env"), "OPENAI_API_KEY=x");
  writeFileSync(join(work, ".env.example"), "FOO=");
  writeFileSync(join(work, "lib.js"), "module.exports = 42;");
  const probe = (p) => `try { require('fs').readFileSync(${JSON.stringify(p)}); console.log('read ' + ${JSON.stringify(p)}); } catch (e) { console.log('denied ' + e.code); }`;
  const code = [
    probe(join(ssh, "id_test")),
    `try { require('fs').readdirSync(${JSON.stringify(ssh)}); console.log('listed ssh'); } catch (e) { console.log('denied ' + e.code); }`,
    probe(join(homedir(), ".claude.json")),
    probe(join(rtHome, "token")),
    probe(join(root, ".env")),
    probe(join(work, ".env.example")),
    `console.log('lib ' + require(${JSON.stringify(join(work, "lib.js"))}));`,
  ].join("\n");
  const r = await backend(rtHome).run({ argv: js(code), workdir: work, timeoutMs: 20_000 });
  assert.equal(r.exit, 0, r.output);
  const lines = r.output.trim().split("\n");
  assert.deepEqual(lines.slice(0, 5), ["denied EPERM", "denied EPERM", "denied EPERM", "denied EPERM", "denied EPERM"], r.output);
  assert.equal(lines[5], `read ${join(work, ".env.example")}`);
  assert.equal(lines[6], "lib 42");
});

test("macOS: toolchains still work (npm test in a worktree)", mac, async () => {
  const { work, rtHome } = workspace();
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "rt-sbx-fixture", version: "1.0.0", private: true, scripts: { test: "node --test" } }));
  writeFileSync(join(work, "a.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert'; test('adds', () => assert.equal(1 + 1, 2));");
  const r = await backend(rtHome).run({ argv: ["npm", "test"], workdir: work, timeoutMs: 120_000 });
  assert.equal(r.exit, 0, r.output);
  assert.match(r.output, /pass 1/);
});

test("macOS: processes outside the sandbox cannot be signalled", mac, async () => {
  const { work, rtHome } = workspace();
  const r = await backend(rtHome).run({ argv: js(`try { process.kill(${process.pid}, 0); console.log('signalled'); } catch (e) { console.log(e.code); }`), workdir: work, timeoutMs: 20_000 });
  assert.equal(r.output.trim(), "EPERM");
});

test("macOS: a timeout kills the sandboxed process tree", mac, async () => {
  const { work, rtHome } = workspace();
  const r = await backend(rtHome).run({
    argv: js("const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('child ' + c.pid); setInterval(() => {}, 1000);"),
    workdir: work,
    timeoutMs: 2_000,
  });
  assert.equal(r.timedOut, true);
  const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
  assert.ok(pid > 0, r.output);
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0));
});

// ============================================================================
// Linux: unshare -rn when permitted
// ============================================================================

test("linux: unshare isolates the network when permitted, and results are always degraded", { skip: !linux && "Linux only" }, async () => {
  const { work, rtHome } = workspace();
  const b = backend(rtHome);
  const iso = await b.isolation();
  const a = await b.available();
  assert.equal(a.ok, true);
  assert.ok(a.degraded, "the Linux local backend is always reported as degraded");
  const r = await b.run({
    argv: js(`
      const s = require('net').connect(443, '1.1.1.1');
      s.setTimeout(4000, () => { console.log('net=timeout'); process.exit(2); });
      s.on('connect', () => { console.log('net=connected'); process.exit(0); });
      s.on('error', (e) => { console.log('net=' + e.code); process.exit(3); });
    `),
    workdir: work,
    timeoutMs: 20_000,
  });
  assert.ok(r.degraded);
  if (iso.kind === "unshare") {
    assert.notEqual(r.exit, 0, r.output);
    assert.doesNotMatch(r.output, /net=connected/);
  } else {
    assert.equal(iso.kind, "none");
    assert.match(r.degraded, /without isolation/);
  }
});
