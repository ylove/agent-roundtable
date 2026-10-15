import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await import("../../dist/sandbox/index.js");
const {
  selectBackend,
  runSandboxed,
  runCommandSpec,
  commandSpecRequest,
  tailForTool,
  adhocCommandId,
  killAllSandboxed,
  sandboxedInFlight,
  LocalBackend,
  SandboxRequestError,
  SandboxUnavailableError,
  SANDBOX_ENV,
} = sandbox;

/** A backend that records requests and returns what `respond` makes of them. */
function fake(id, { available = { ok: true }, respond } = {}) {
  const calls = [];
  return {
    id,
    calls,
    async available() {
      return available;
    },
    async run(req) {
      calls.push(req);
      if (respond) return respond(req);
      return { exit: 0, timedOut: false, durationMs: 1, output: "ok", truncated: false, backend: id };
    },
  };
}

const work = () => realpathSync(mkdtempSync(join(tmpdir(), "rt-core-")));

// ============================================================================
// selectBackend
// ============================================================================

test("selectBackend prefers Docker and is not degraded when it is up", async () => {
  const docker = fake("docker");
  const local = fake("local");
  const r = await selectBackend({ docker, local, allowLocal: true });
  assert.equal(r.backend, docker);
  assert.equal(r.degraded, undefined);
});

test("selectBackend falls back to local only when allowed, and reports the fallback as degraded", async () => {
  const down = fake("docker", { available: { ok: false, reason: "docker is not available: daemon down" } });
  const local = fake("local");
  const r = await selectBackend({ docker: down, local, allowLocal: true });
  assert.equal(r.backend, local);
  assert.match(r.degraded, /docker unavailable \(docker is not available: daemon down\); using the local backend/);

  const unisolated = fake("local", { available: { ok: true, degraded: "no isolation" } });
  const u = await selectBackend({ docker: down, local: unisolated, allowLocal: true });
  assert.match(u.degraded, /using the local backend; no isolation$/);

  await assert.rejects(selectBackend({ docker: down, local, allowLocal: false }), (e) => {
    assert.ok(e instanceof SandboxUnavailableError);
    assert.equal(e.reasons.length, 2);
    assert.match(e.message, /daemon down/);
    assert.match(e.message, /ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1/);
    return true;
  });
  assert.equal(local.calls.length, 0);
});

test("selectBackend honours a local preference but still falls back to Docker", async () => {
  const docker = fake("docker");
  const local = fake("local");
  assert.equal((await selectBackend({ preferred: "local", docker, local, allowLocal: true })).backend, local);
  assert.equal((await selectBackend({ preferred: "local", docker, local, allowLocal: false })).backend, docker);
  const off = fake("local", { available: { ok: false, reason: "disabled" } });
  assert.equal((await selectBackend({ preferred: "local", docker, local: off, allowLocal: true })).backend, docker);
});

test("selectBackend defaults allowLocal to the environment opt-in", async () => {
  const down = fake("docker", { available: { ok: false, reason: "down" } });
  const local = fake("local");
  const saved = process.env[SANDBOX_ENV.ALLOW_LOCAL];
  try {
    delete process.env[SANDBOX_ENV.ALLOW_LOCAL];
    await assert.rejects(selectBackend({ docker: down, local }), SandboxUnavailableError);
    process.env[SANDBOX_ENV.ALLOW_LOCAL] = "1";
    assert.equal((await selectBackend({ docker: down, local })).backend, local);
  } finally {
    if (saved === undefined) delete process.env[SANDBOX_ENV.ALLOW_LOCAL];
    else process.env[SANDBOX_ENV.ALLOW_LOCAL] = saved;
  }
});

// ============================================================================
// runSandboxed
// ============================================================================

test("runSandboxed clamps the timeout and output cap before calling the backend", async () => {
  const b = fake("docker");
  const wd = work();
  await runSandboxed(b, { argv: ["npm", "test"], workdir: wd, timeoutMs: 0 });
  await runSandboxed(b, { argv: ["npm", "test"], workdir: wd, timeoutMs: 3_600_000, maxOutputBytes: 10 ** 12 });
  await runSandboxed(b, { argv: ["npm", "test"], workdir: wd, timeoutMs: 600_000 }, { maxTimeoutMs: 120_000 });
  assert.deepEqual(b.calls.map((c) => c.timeoutMs), [600_000, 900_000, 120_000]);
  assert.deepEqual(b.calls.map((c) => c.maxOutputBytes), [2 * 1024 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024]);
  assert.ok(b.calls.every((c) => c.signal instanceof AbortSignal));
});

test("runSandboxed scrubs secrets and caps output whatever the backend returns", async () => {
  process.env.SANDBOX_CORE_TEST_TOKEN = "core-secret-value-0451";
  try {
    const b = fake("docker", {
      respond: () => ({ exit: 1, timedOut: false, durationMs: 5, output: "x".repeat(5000) + " core-secret-value-0451 " + "y".repeat(5000), truncated: false, backend: "docker" }),
    });
    const r = await runSandboxed(b, { argv: ["make"], workdir: work(), timeoutMs: 1000, maxOutputBytes: 4096 });
    assert.ok(!r.output.includes("core-secret-value-0451"));
    assert.ok(Buffer.byteLength(r.output) <= 4096);
    assert.equal(r.truncated, true);
    assert.equal(r.exit, 1);

    const whole = await runSandboxed(fake("docker", { respond: () => ({ exit: 0, timedOut: false, durationMs: 1, output: "token core-secret-value-0451 done", truncated: false, backend: "docker" }) }), {
      argv: ["make"],
      workdir: work(),
      timeoutMs: 1000,
    });
    assert.equal(whole.output, "token [redacted:env:SANDBOX_CORE_TEST_TOKEN] done");
  } finally {
    delete process.env.SANDBOX_CORE_TEST_TOKEN;
  }
});

test("runSandboxed refuses shell -c on local, warns but allows it on Docker, and validates argv", async () => {
  const local = fake("local");
  await assert.rejects(runSandboxed(local, { argv: ["bash", "-c", "rm -rf /"], workdir: work(), timeoutMs: 1000 }), SandboxRequestError);
  assert.equal(local.calls.length, 0);
  const docker = fake("docker");
  const r = await runSandboxed(docker, { argv: ["sh", "-c", "npm ci && npm test"], workdir: work(), timeoutMs: 1000 });
  assert.equal(r.exit, 0);
  assert.equal(docker.calls.length, 1);
  for (const argv of [[], [""], ["a\0"], "npm test"]) {
    await assert.rejects(runSandboxed(docker, { argv, workdir: work(), timeoutMs: 1000 }), SandboxRequestError, JSON.stringify(argv));
  }
});

test("runSandboxed turns backend crashes into results and rethrows request errors", async () => {
  process.env.SANDBOX_CORE_TEST_TOKEN = "core-secret-value-0452";
  try {
    const crash = { id: "docker", available: async () => ({ ok: true }), run: async () => { throw new Error("boom core-secret-value-0452"); } };
    const r = await runSandboxed(crash, { argv: ["x"], workdir: work(), timeoutMs: 1000 });
    assert.equal(r.exit, null);
    assert.equal(r.output, "boom [redacted:env:SANDBOX_CORE_TEST_TOKEN]");
    const refuse = { id: "docker", available: async () => ({ ok: true }), run: async () => { throw new SandboxRequestError("bad cwd"); } };
    await assert.rejects(runSandboxed(refuse, { argv: ["x"], workdir: work(), timeoutMs: 1000 }), /bad cwd/);
  } finally {
    delete process.env.SANDBOX_CORE_TEST_TOKEN;
  }
});

test("the caller's abort reaches the backend", async () => {
  const ac = new AbortController();
  const b = fake("docker", {
    respond: (req) =>
      new Promise((resolve) => {
        req.signal.addEventListener("abort", () => resolve({ exit: null, signal: "SIGKILL", timedOut: false, durationMs: 1, output: "", truncated: false, backend: "docker" }));
      }),
  });
  setTimeout(() => ac.abort(), 50);
  const r = await runSandboxed(b, { argv: ["sleep", "100"], workdir: work(), timeoutMs: 60_000, signal: ac.signal });
  assert.equal(r.signal, "SIGKILL");
  assert.equal(r.timedOut, false);
});

test("the backstop aborts and then abandons a backend that ignores its timeout", async () => {
  let aborted = false;
  const stuck = fake("docker", {
    respond: (req) => {
      req.signal.addEventListener("abort", () => (aborted = true));
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  const r = await runSandboxed(stuck, { argv: ["hang"], workdir: work(), timeoutMs: 50 }, { backstopGraceMs: 50 });
  assert.equal(aborted, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.exit, null);
  assert.match(r.output, /did not stop/);
  assert.ok(Date.now() - started < 2_000);
});

// ============================================================================
// runCommandSpec, tails and ids
// ============================================================================

test("runCommandSpec maps a contract CommandSpec onto a request", async () => {
  const b = fake("docker");
  const wd = work();
  const spec = { id: "unit", argv: ["npm", "test"], cwd: "packages/api", timeout_s: 30, env: { CI: "1" } };
  await runCommandSpec(b, spec, wd, { image: "node:22", maxOutputBytes: 4096 });
  const req = b.calls[0];
  assert.deepEqual(req.argv, ["npm", "test"]);
  assert.equal(req.workdir, wd);
  assert.equal(req.cwd, "packages/api");
  assert.deepEqual(req.env, { CI: "1" });
  assert.equal(req.timeoutMs, 30_000);
  assert.equal(req.image, "node:22");
  assert.equal(req.maxOutputBytes, 4096);
  await runCommandSpec(b, { ...spec, timeout_s: 3600 }, wd, { maxTimeoutMs: 60_000 });
  assert.equal(b.calls[1].timeoutMs, 60_000);
  assert.throws(() => commandSpecRequest({ ...spec, id: "" }, wd), /needs an id/);
  assert.throws(() => commandSpecRequest({ ...spec, argv: "npm test" }, wd), SandboxRequestError);
});

test("tailForTool returns the last ~8 KB and adhocCommandId is stable", () => {
  const out = Array.from({ length: 4000 }, (_, i) => `l${i}`).join("\n");
  const t = tailForTool(out);
  assert.ok(Buffer.byteLength(t) <= 8192 + 64);
  assert.ok(t.endsWith("l3999"));
  assert.equal(tailForTool("short"), "short");
  assert.equal(adhocCommandId(["npm", "test"]), adhocCommandId(["npm", "test"]));
  assert.notEqual(adhocCommandId(["npm", "test"]), adhocCommandId(["npm", "run", "test"]));
  assert.match(adhocCommandId(["x"]), /^argv:[0-9a-f]{16}$/);
});

test("end to end through the local backend: real output, scrubbed", async () => {
  process.env.SANDBOX_CORE_TEST_TOKEN = "core-secret-value-0453";
  try {
    const b = new LocalBackend({ env: { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "1" }, platform: "aix" });
    const r = await runSandboxed(b, { argv: ["node", "-e", "console.log(process.argv[1]); process.exit(4)", "core-secret-value-0453"], workdir: work(), timeoutMs: 10_000 });
    assert.equal(r.exit, 4);
    assert.equal(r.backend, "local");
    assert.match(r.degraded, /without isolation/);
    assert.equal(r.output.trim(), "[redacted:env:SANDBOX_CORE_TEST_TOKEN]");
  } finally {
    delete process.env.SANDBOX_CORE_TEST_TOKEN;
  }
});

// Must stay last: killAllSandboxed() refuses new runs for the rest of the process.
test("killAllSandboxed stops in-flight commands and refuses new ones", async () => {
  const b = new LocalBackend({ env: { ROUNDTABLE_ALLOW_LOCAL_SANDBOX: "1" }, platform: "aix" });
  const wd = work();
  const running = runSandboxed(b, { argv: ["node", "-e", "setInterval(() => {}, 1000)"], workdir: wd, timeoutMs: 60_000 });
  const deadline = Date.now() + 5_000;
  while (sandboxedInFlight() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sandboxedInFlight(), 1);
  await killAllSandboxed();
  const r = await running;
  assert.equal(r.signal, "SIGKILL");
  assert.equal(r.timedOut, false);
  assert.equal(sandboxedInFlight(), 0);
  const after = await runSandboxed(b, { argv: ["node", "-e", "1"], workdir: wd, timeoutMs: 1000 });
  assert.equal(after.exit, null);
  assert.match(after.output, /shutting down/);
});
