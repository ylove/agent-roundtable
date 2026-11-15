import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPage } from "../../dist/prototypes/page-check.js";
import { ChromeProcesses, findChrome } from "../../dist/prototypes/browser.js";
import { startRoom } from "../../dist/table/room.js";
import { attachPrototypeFiles } from "../../dist/table/replay.js";

const url = "http://127.0.0.1:4567/capability/p/A/index.html";
async function peer(t, control = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rt-cdp-peer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("../fixtures/runtimes/cdp-peer.mjs", import.meta.url), join(dir, "peer.mjs"));
  await writeFile(join(dir, "control.json"), JSON.stringify(control));
  const chromePath = join(dir, "chrome");
  await writeFile(chromePath, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(dir, "peer.mjs").replaceAll("'", "'\\''")}' "$@"\n`);
  await chmod(chromePath, 0o700);
  return { chromePath, launch: async () => JSON.parse(await readFile(join(dir, "launch.json"), "utf8")) };
}

test("page check: captures errors, exceptions and failed requests over inherited pipes", async t => {
  const fake = await peer(t, { events: [
    { method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "ignore" }] } },
    { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "bad console" }] } },
    { method: "Runtime.exceptionThrown", params: { exceptionDetails: { exception: { description: "TypeError: broken" } } } },
    { method: "Network.loadingFailed", params: {} },
  ] });
  const result = await checkPage(url, fake);
  assert.equal(result.ok, false); assert.equal(result.loaded, true);
  assert.deepEqual(result.consoleErrors, ["bad console"]); assert.deepEqual(result.exceptions, ["TypeError: broken"]);
  assert.equal(result.failedRequests, 1); assert.equal(result.title, "A page");
  assert.equal(result.screenshot.toString("hex"), "89504e470d0a1a0a");
  const launch = await fake.launch();
  assert.ok(launch.args.includes("--remote-debugging-pipe"));
  assert.ok(!launch.args.some(a => a.includes("remote-debugging-port")));
  for (const flag of ["--proxy-server=http://127.0.0.1:4567", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]) assert.ok(launch.args.includes(flag));
  assert.equal(existsSync(launch.env.TMPDIR), false, "temporary profile removed");
});

test("page check: clean load passes; messages are capped and scrubbed before capping", async t => {
  const fake = await peer(t);
  assert.equal((await checkPage(url, fake)).ok, true);
  process.env.PAGE_TEST_SECRET = "private-page-token";
  t.after(() => delete process.env.PAGE_TEST_SECRET);
  const value = "private-page-token " + url + " x".repeat(400);
  const events = Array.from({ length: 15 }, () => [
    { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value }] } },
    { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: value } } },
  ]).flat();
  const noisy = await peer(t, { events });
  const result = await checkPage(url, noisy);
  for (const messages of [result.consoleErrors, result.exceptions]) {
    assert.equal(messages.length, 10);
    assert.ok(messages.every(s => s.length <= 300 && !s.includes("private-page-token") && !s.includes("capability")));
  }
  assert.ok(!(await noisy.launch()).env.PAGE_TEST_SECRET);
});

test("page check: timeout SIGKILLs the browser, untracks it and removes its temp dir", async t => {
  const fake = await peer(t, { hang: true });
  const processes = new ChromeProcesses();
  const result = await checkPage(url, { ...fake, timeoutMs: 500, processes });
  assert.equal(result.ok, false); assert.equal(result.reason, "timed out");
  const launch = await fake.launch();
  assert.throws(() => process.kill(launch.pid, 0), e => e.code === "ESRCH");
  assert.deepEqual(processes.running, []); assert.equal(existsSync(launch.env.TMPDIR), false);
});

test("page check: no browser is not a page failure; refuses other URLs; never throws", async () => {
  assert.deepEqual(await checkPage(url, { chromePath: "" }), { ok: false, loaded: false, consoleErrors: [], exceptions: [], failedRequests: 0, reason: "no browser" });
  for (const bad of ["https://example.org/", "http://localhost:9/x", "http://127.0.0.1:9/state.json", "bad URL"]) {
    const result = await checkPage(bad, { chromePath: "/missing/chrome" });
    assert.equal(result.ok, false);
  }
  assert.equal((await checkPage(url, { chromePath: "/missing/chrome" })).ok, false);
});

test("real Chrome: loads a tiny page and records its deliberate throw", { skip: (process.env.ROUNDTABLE_TEST_CHROME !== "1" && "set ROUNDTABLE_TEST_CHROME=1 to run") || (!findChrome() && "no browser") }, async t => {
  let room;
  try { room = await startRoom({ hold: false }); }
  catch (e) { if (e.code === "EPERM") { t.skip("loopback listeners blocked"); return; } throw e; }
  t.after(() => room.close());
  const seat = { id: "a", name: "a", provider: "test", model: "test" };
  const content = '<title>Throw test</title><script>throw new TypeError("deliberate page error")</script>';
  const event = { type: "prototype", team: "A", seat, kind: "web", ok: true, files: [{ path: "index.html", bytes: Buffer.byteLength(content) }] };
  attachPrototypeFiles(event, [{ path: "index.html", content }]);
  await room.observer.onEvent(event);
  const result = await checkPage(`${room.url}p/A/index.html`);
  assert.equal(result.loaded, true); assert.equal(result.ok, false);
  assert.match(result.exceptions.join("\n"), /TypeError: deliberate page error/);
  assert.ok(result.screenshot?.length);
});
