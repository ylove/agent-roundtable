import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { runCli, USAGE } from "../../dist/cli.js";
import { runServeCli } from "../../dist/cli-serve.js";
import { runUpCli } from "../../dist/cli-up.js";
import { acquireLock, readLockOwner } from "../../dist/execution/lock.js";
import { serveDir, serveInfoPath, serveLockPath } from "../../dist/serve/service.js";
import { mkdirPrivate } from "../../dist/security/fs-safe.js";
import { installProcessIdentity } from "../fixtures/execution/process-identity.mjs";

installProcessIdentity();

test("down and serve stop have identical output when idle and reject down arguments", async t => {
  const messages = [], errors = [];
  t.mock.method(console, "log", text => messages.push(text));
  t.mock.method(console, "error", text => errors.push(text));
  const before = process.exitCode;
  try {
    await runCli(["serve", "stop"]);
    const stopped = messages.splice(0);
    await runCli(["down"]);
    assert.deepEqual(messages.splice(0), stopped);
    assert.deepEqual(stopped, ["Service is not running."]);
    assert.equal(process.exitCode, 0);
    await runCli(["down", "--unexpected"]);
    assert.equal(process.exitCode, 2);
    assert.match(errors.join(""), /down accepts no arguments/);
    assert.match(USAGE, /roundtable down.*alias of serve stop/);
  } finally { process.exitCode = before; }
});

test("down uses serve's identity check and running status advertises it without leaking the URL", async t => {
  mkdirPrivate(serveDir());
  const release = await acquireLock(serveLockPath(), { timeoutMs: 0 });
  const owner = readLockOwner(serveLockPath());
  const messages = [], signals = [];
  t.mock.method(console, "log", text => messages.push(text));
  t.mock.method(process, "kill", (pid, signal) => { signals.push([pid, signal]); return true; });
  const before = process.exitCode;
  try {
    writeFileSync(serveInfoPath(), JSON.stringify({ pid: process.pid, host: hostname(), url: "http://127.0.0.1:1/private-capability/", started_at: owner.at }));
    assert.equal(await runServeCli(["status"]), 0);
    assert.ok(messages.includes("Stop it with: roundtable down"));
    if (!process.stdout.isTTY) assert.doesNotMatch(messages.join(""), /private-capability/);
    messages.length = 0;
    await runCli(["serve", "stop"]);
    const stopped = messages.splice(0);
    await runCli(["down"]);
    assert.deepEqual(messages.splice(0), stopped);
    assert.deepEqual(stopped, ["Service stop requested."]);
    assert.equal(signals.filter(([, signal]) => signal === "SIGTERM").length, 2);
    assert.ok(signals.every(([pid]) => pid === process.pid));
  } finally {
    process.exitCode = before;
    rmSync(serveInfoPath(), { force: true });
    await release();
  }
});

test("up ends both new and existing service sections with the down hint", async () => {
  for (const alreadyRunning of [true, false]) {
    const output = new PassThrough();
    let text = "";
    output.on("data", chunk => { text += chunk; });
    const running = { running: true, url: "http://127.0.0.1:1/private/" };
    const code = await runUpCli("up", ["--no-input"], { output, showUrl: false }, {
      setup: { view: () => ({ envFile: true, agentsDir: true, desktop: true }) },
      probes: { nodeVersion: "v22.20.0", engines: ">=22", providers: () => ["openai"], keyNames: { openai: "OPENAI_API_KEY" },
        findExecutable: () => "/bin/fixture", runtimes: [], roundtableBin: () => ({ path: "/bin/roundtable", ours: true }), docker: async () => ({ ok: true }), chrome: () => null },
      serve: { status: () => alreadyRunning ? running : { running: false }, start: async () => running },
    });
    assert.equal(code, 0);
    assert.match(text, /Stop it with: roundtable down\n\nNext:/);
    assert.doesNotMatch(text, /private\//);
  }
});
