import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { printService, serveStatus, stopServe, serveInfoPath, serveDir } from "../../dist/serve/service.js";
import { mkdirPrivate } from "../../dist/security/fs-safe.js";
import { readUserConfig, setNotifyConfig } from "../../dist/user-config.js";
import { validateNotifyConfig } from "../../dist/serve/config.js";
import { runTableCli } from "../../dist/cli-table.js";
import { childEnv } from "../../dist/security/child-env.js";
import { runNotifyCli } from "../../dist/cli-serve.js";

const temps = [];
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }); });

test("serve user config allowlists private check-in keys and rejects literal credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "serve-config-"));
  temps.push(home);
  for (const [key, value] of Object.entries({
    "notify.ntfy.url": "https://ntfy.example", "notify.ntfy.topic": "long_private_topic_1234", "notify.ntfy.token": "secret://env/PRIVATE_TOKEN",
    "notify.ntfy.user": "secret://keychain/ntfy/user", "notify.ntfy.password": "secret://op/vault/ntfy/password",
    "notify.webhook.url": "http://localhost:8080/hook", "notify.webhook.secret": "secret://env/WEBHOOK_KEY",
    "notify.desktop": "true", "notify.events": "awaiting_human,completed,runner_keeps_dying",
  })) setNotifyConfig(key, value, home);
  const config = readUserConfig(home);
  assert.equal(config.notify.desktop, true);
  assert.deepEqual(config.notify.events, ["awaiting_human", "completed", "runner_keeps_dying"]);
  assert.equal(config.notify.ntfy.token, "secret://env/PRIVATE_TOKEN");
  assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
  const before = readFileSync(join(home, "config.json"), "utf8");
  for (const key of ["notify.ntfy.token", "notify.ntfy.user", "notify.ntfy.password", "notify.webhook.secret"]) assert.throws(() => setNotifyConfig(key, "literal-secret", home), /Expected secret/);
  for (const [key, value] of [["notify.bad", "true"], ["notify.ntfy.unknown", "x"], ["notify.desktop", "yes"], ["notify.events", "all"], ["notify.webhook.url", "http://public.example"]]) assert.throws(() => setNotifyConfig(key, value, home));
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  assert.throws(() => validateNotifyConfig({ webhook: { secret: "literal" } }), /secret/);
});

test("serve print-service contains argv and no environment values", () => {
  const old = process.env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET;
  process.env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET = "must-not-print-this-env-value";
  try {
    for (const kind of ["launchd", "systemd"]) {
      const result = printService(kind, "/opt/node", "/opt/roundtable/dist/index.js");
      assert.match(result, /serve/);
      assert.match(result, /\/opt\/node/);
      assert.match(result, /\/opt\/roundtable\/dist\/index.js/);
      assert.ok(!result.includes(process.env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET));
      assert.ok(!result.includes("Environment"));
      assert.ok(!result.includes("--detach"));
    }
    assert.match(printService("launchd", '/node&path', '/cli<path'), /node&amp;path/);
    assert.match(printService("systemd", '/node%path', '/cli"path'), /node%%path/);
    assert.match(printService("systemd", "/node$PATH", "/cli"), /node\$\$PATH/);
    assert.throws(() => printService("public"));
  } finally { if (old === undefined) delete process.env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET; else process.env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET = old; }
});

test("serve stop refuses a foreign host and a live pid without a matching service lock", () => {
  mkdirPrivate(serveDir());
  writeFileSync(serveInfoPath(), JSON.stringify({ pid: process.pid, host: "other-host" }));
  assert.equal(serveStatus().remote, true);
  assert.throws(() => stopServe(), /another host/);
  writeFileSync(serveInfoPath(), JSON.stringify({ pid: process.pid, host: hostname() }));
  assert.equal(stopServe(), false);
});

test("serve CLI config setter and notify init use the allowlist", async t => {
  const output = [];
  const terminal = { write: s => output.push(s), error: s => output.push(s), isTTY: false };
  assert.equal(await runTableCli("config", ["set", "notify.desktop", "false"], { output: terminal, error: terminal }), 0);
  assert.equal(readUserConfig().notify.desktop, false);
  assert.equal(await runTableCli("config", ["set", "notify.ntfy.token", "literal"], { output: terminal, error: terminal }), 1);
  t.mock.method(console, "log", () => {});
  assert.equal(await runNotifyCli(["init", "ntfy"]), 0);
  assert.match(readUserConfig().notify.ntfy.topic, /^[A-Za-z0-9_-]{16,64}$/);
});

test("serve detached environment keeps check-in credentials and desktop session out of runner children", () => {
  const source = { PATH: "/bin", DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "desktop-session", ROUNDTABLE_HOME: "/tmp/home", ROUNDTABLE_NOTIFY_NTFY_TOKEN: "private-notify", ROUNDTABLE_NOTIFY_WEBHOOK_SECRET: "private-webhook", UNRELATED_PASSWORD: "do-not-inherit" };
  const env = childEnv("serve", {}, source);
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.ROUNDTABLE_NOTIFY_NTFY_TOKEN, "private-notify");
  assert.equal(env.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET, "private-webhook");
  assert.equal(env.UNRELATED_PASSWORD, undefined);
  const runner = childEnv("runner", {}, env);
  assert.equal(runner.ROUNDTABLE_NOTIFY_NTFY_TOKEN, undefined);
  assert.equal(runner.ROUNDTABLE_NOTIFY_WEBHOOK_SECRET, undefined);
});
