import { test } from "node:test";
import assert from "node:assert/strict";

const common = await import("../../dist/sandbox/common.js");
const { spawnCaptured, sandboxedInFlight } = await import("../../dist/sandbox/process.js");
const { capText, tailText, OutputCapture, validateArgv, isShellCommand, validateEnv, resolveCwd, validateWorkdir, clampTimeout, clampOutputBytes, SandboxRequestError } = common;

const posix = process.platform !== "win32";
const node = process.execPath;
const env = { PATH: process.env.PATH ?? "" };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

// ============================================================================
// Output capping
// ============================================================================

test("capText leaves short text alone and keeps head and tail of long text within the byte cap", () => {
  assert.deepEqual(capText("short", 100), { text: "short", truncated: false });
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const r = capText(text, 4096);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= 4096);
  assert.ok(r.text.startsWith("line 0\nline 1\n"));
  assert.ok(r.text.endsWith("line 1998\nline 1999"));
  assert.match(r.text, /\n\[\.\.\. \d+ bytes truncated \.\.\.\]\n/);
  // Cuts land on line boundaries.
  const [head, tail] = r.text.split(/\n\[\.\.\. \d+ bytes truncated \.\.\.\]\n/);
  assert.ok(head.endsWith("\n") || /line \d+$/.test(head));
  assert.match(tail, /^line \d+\n/);
});

test("capText never splits a UTF-8 sequence", () => {
  const text = "é😀".repeat(5000);
  for (const max of [301, 302, 303, 1000, 1001]) {
    const r = capText(text, max);
    assert.ok(Buffer.byteLength(r.text) <= max, `cap ${max}`);
    assert.ok(!r.text.includes("\uFFFD"), `no replacement chars at cap ${max}`);
  }
});

test("tailText keeps the last bytes from a line start and says what it dropped", () => {
  assert.equal(tailText("abc", 10), "abc");
  const text = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
  const t = tailText(text, 8192);
  assert.match(t, /^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]\nrow \d+\n/);
  assert.ok(t.endsWith("row 4999"));
  assert.ok(Buffer.byteLength(t) <= 8192 + 64);
});

test("OutputCapture streams megabytes in bounded memory and keeps the first and last bytes", () => {
  const max = 64 * 1024;
  const cap = new OutputCapture(max);
  const chunk = (i) => Buffer.from(`chunk ${String(i).padStart(4, "0")} `.padEnd(4096, ".") + "\n");
  for (let i = 0; i < 1500; i++) cap.push(chunk(i));
  const { text, truncated } = cap.finish();
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= max);
  assert.ok(text.startsWith("chunk 0000 "));
  assert.ok(text.trimEnd().endsWith("."));
  assert.match(text, /chunk 1499 /);
  assert.equal(cap.total, 1500 * 4097);
});

test("OutputCapture scrubs secrets, even ones split across chunks, before cutting", () => {
  process.env.SANDBOX_TEST_API_TOKEN = "tok-9f8e7d6c5b4a3210-zz";
  try {
    const cap = new OutputCapture(1024 * 1024);
    cap.push("value: tok-9f8e7d6c");
    cap.push("5b4a3210-zz end\n");
    const { text } = cap.finish();
    assert.ok(!text.includes("tok-9f8e7d6c5b4a3210-zz"));
    assert.match(text, /\[redacted:env:SANDBOX_TEST_API_TOKEN\]/);

    // In a long stream, a secret near the tail survives the rolling window and is still scrubbed.
    const small = new OutputCapture(4096);
    for (let i = 0; i < 100; i++) small.push("x".repeat(1000) + "\n");
    small.push("leak tok-9f8e7d6c5b4a3210-zz\n");
    const r = small.finish();
    assert.ok(!r.text.includes("tok-9f8e7d6c5b4a3210-zz"));
    assert.ok(Buffer.byteLength(r.text) <= 4096);
  } finally {
    delete process.env.SANDBOX_TEST_API_TOKEN;
  }
});

// ============================================================================
// Validation
// ============================================================================

test("validateArgv accepts structured argv and refuses everything else", () => {
  assert.deepEqual(validateArgv(["node", "-e", "1"]), ["node", "-e", "1"]);
  for (const bad of [[], "npm test", [""], ["  "], ["a\0b"], [1], ["node", 2], ["-rf"], ["node", "x\0"], null]) {
    assert.throws(() => validateArgv(bad), SandboxRequestError, JSON.stringify(bad));
  }
});

test("isShellCommand spots shell strings behind common wrappers", () => {
  for (const yes of [
    ["sh", "-c", "x"],
    ["/bin/bash", "-lc", "x"],
    ["bash", "-e", "-c", "x"],
    ["bash", "-o", "pipefail", "-c", "x"],
    ["zsh", "-c", "x"],
    ["dash", "-ec", "x"],
    ["env", "FOO=1", "sh", "-c", "x"],
    ["/usr/bin/env", "bash", "-c", "x"],
    ["timeout", "10", "sh", "-c", "x"],
    ["busybox", "sh", "-c", "x"],
    ["fish", "--command", "x"],
  ]) assert.equal(isShellCommand(yes), true, yes.join(" "));
  for (const no of [["bash", "script.sh"], ["bash", "-e", "script.sh", "-c"], ["node", "-e", "x"], ["npm", "test"], ["shellcheck", "-c", "x"], ["env", "node", "-c"]]) {
    assert.equal(isShellCommand(no), false, no.join(" "));
  }
});

test("validateEnv refuses secret-shaped, malformed and reserved names", () => {
  assert.deepEqual(validateEnv(undefined), {});
  assert.deepEqual(validateEnv({ NODE_ENV: "test", CI: "1" }), { NODE_ENV: "test", CI: "1" });
  for (const bad of [{ API_KEY: "x" }, { GITHUB_TOKEN: "x" }, { DB_PASSWORD: "x" }, { AWS_SECRET: "x" }, { "1BAD": "x" }, { "A=B": "x" }, { A: 1 }, { A: "x\0" }]) {
    assert.throws(() => validateEnv(bad), SandboxRequestError, JSON.stringify(bad));
  }
  assert.throws(() => validateEnv({ home: "/x" }, ["HOME"]), /set by the sandbox/);
});

test("resolveCwd keeps commands inside the workdir", () => {
  for (const root of [undefined, "", ".", "./", ".//"]) assert.equal(resolveCwd(root), "");
  assert.equal(resolveCwd("packages/api"), "packages/api");
  assert.equal(resolveCwd("./src//lib/"), "src/lib");
  for (const bad of ["../x", "a/../../b", "/etc", "a\0b", "C:/x"]) assert.throws(() => resolveCwd(bad), SandboxRequestError, bad);
});

test("validateWorkdir wants an absolute path that is safe inside --mount", () => {
  assert.equal(validateWorkdir("/srv/work tree"), "/srv/work tree");
  for (const bad of ["relative/path", "", "/a,readonly=false", '/a"b', "/a\nb", 42]) assert.throws(() => validateWorkdir(bad), SandboxRequestError);
});

test("timeouts and output caps are clamped", () => {
  assert.equal(clampTimeout(undefined), 600_000);
  assert.equal(clampTimeout(0), 600_000);
  assert.equal(clampTimeout(Number.NaN), 600_000);
  assert.equal(clampTimeout(5_000), 5_000);
  assert.equal(clampTimeout(3_600_000), 900_000);
  assert.equal(clampTimeout(600_000, 60_000), 60_000);
  assert.equal(clampOutputBytes(undefined), 2 * 1024 * 1024);
  assert.equal(clampOutputBytes(10 ** 12), 16 * 1024 * 1024);
});

// ============================================================================
// spawnCaptured
// ============================================================================

test("spawnCaptured combines stdout and stderr and reports the exit code", async () => {
  const r = await spawnCaptured(node, ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)"], {
    env,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
    label: "t",
  });
  assert.equal(r.exit, 3);
  assert.equal(r.timedOut, false);
  assert.match(r.output, /out\n/);
  assert.match(r.output, /err\n/);
  assert.equal(sandboxedInFlight(), 0);
});

test("spawnCaptured reports a missing program without throwing", async () => {
  const r = await spawnCaptured("rt-definitely-not-a-program", [], { env, timeoutMs: 5_000, maxOutputBytes: 1024, label: "missing" });
  assert.equal(r.exit, null);
  assert.match(r.error, /ENOENT/);
  assert.equal(sandboxedInFlight(), 0);
});

test("a timeout kills the whole process group", { skip: !posix && "POSIX only" }, async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log("child " + c.pid);
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const r = await spawnCaptured(node, ["-e", script], { env, timeoutMs: 1_500, maxOutputBytes: 4096, label: "group" });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL");
  assert.ok(Date.now() - started < 8_000);
  const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
  assert.ok(pid > 0, r.output);
  assert.equal(await waitDead(pid), true, "grandchild survived the timeout");
});

test("background processes do not outlive a command that exits", { skip: !posix && "POSIX only" }, async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    c.unref();
    console.log("child " + c.pid);
  `;
  const r = await spawnCaptured(node, ["-e", script], { env, timeoutMs: 10_000, maxOutputBytes: 4096, label: "bg" });
  assert.equal(r.exit, 0);
  const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
  assert.ok(pid > 0, r.output);
  assert.equal(await waitDead(pid), true, "background child survived");
});

test("an abort signal stops the run and runs the pre-kill hook first", async () => {
  const ac = new AbortController();
  const calls = [];
  const p = spawnCaptured(node, ["-e", "setInterval(() => {}, 1000)"], {
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    signal: ac.signal,
    label: "abort",
    beforeKill: async () => {
      calls.push("before");
    },
    afterKill: () => calls.push("after"),
  });
  setTimeout(() => ac.abort(), 200);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(calls, ["before", "after"]);
  const pre = await spawnCaptured(node, ["-e", "1"], { env, timeoutMs: 1_000, maxOutputBytes: 64, signal: ac.signal, label: "pre" });
  assert.equal(pre.aborted, true);
  assert.equal(pre.exit, null);
});
