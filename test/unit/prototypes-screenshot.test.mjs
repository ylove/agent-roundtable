import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The override is read from the environment when config.js is first imported.
const fakeDir = await mkdtemp(join(tmpdir(), "rt-chrome-"));
const fakeChrome = join(fakeDir, "fake-chrome");
await writeFile(fakeChrome, "#!/bin/sh\nexit 0\n");
await chmod(fakeChrome, 0o755);
const useRealChrome = process.env.ROUNDTABLE_TEST_CHROME === "1";
if (!useRealChrome) process.env.ROUNDTABLE_CHROME_PATH = fakeChrome;

const { findChrome, captureScreenshots, DESKTOP_VIEWPORT, MOBILE_VIEWPORT } = await import("../../dist/prototypes/screenshot.js");
const { PrototypeTracker } = await import("../../dist/prototypes/index.js");

const posix = process.platform !== "win32";

test("findChrome: honors ROUNDTABLE_CHROME_PATH and caches; a missing override falls back", { skip: !posix || useRealChrome }, () => {
  assert.equal(findChrome(), fakeChrome);
  assert.equal(findChrome(), fakeChrome);
  assert.notEqual(findChrome(join(fakeDir, "missing")), join(fakeDir, "missing"));
  assert.equal(findChrome(fakeChrome), fakeChrome);
});

test("viewports: desktop 1280x800, mobile 390x844", () => {
  assert.deepEqual(DESKTOP_VIEWPORT, { name: "desktop", width: 1280, height: 800 });
  assert.deepEqual(MOBILE_VIEWPORT, { name: "mobile", width: 390, height: 844 });
});

test("captureScreenshots: only the local board, never throws, empty when nothing was written", { skip: !posix }, async () => {
  const out = await mkdtemp(join(tmpdir(), "rt-shots-"));
  assert.deepEqual(await captureScreenshots("https://example.com/", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome }), []);
  assert.deepEqual(await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT], { chromePath: fakeChrome }), []);
  assert.deepEqual(await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT], { chromePath: join(fakeDir, "nope") }), []);
  assert.deepEqual(readdirSync(out).filter((n) => n.startsWith(".chrome-")), [], "profile dirs removed");
});

test("captureScreenshots: a hung browser is killed at the timeout", { skip: !posix }, async () => {
  const slow = join(fakeDir, "slow-chrome");
  await writeFile(slow, "#!/bin/sh\nsleep 30\n");
  await chmod(slow, 0o755);
  const out = await mkdtemp(join(tmpdir(), "rt-shots-"));
  const t0 = Date.now();
  const res = await captureScreenshots("http://127.0.0.1:9/x", out, [DESKTOP_VIEWPORT, MOBILE_VIEWPORT], { chromePath: slow, timeoutMs: 200 });
  assert.deepEqual(res, []);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("real Chrome: a public web prototype yields desktop and mobile PNGs, removed with the prototype", { skip: !useRealChrome && "set ROUNDTABLE_TEST_CHROME=1 to run" }, async (t) => {
  assert.ok(findChrome(), "Chrome not found");
  const tr = await PrototypeTracker.create({
    sessionId: "shots",
    mode: "collaborate",
    participants: ["a", "b"],
    assessorIsCaller: false,
    public: true,
    screenshots: true,
    openBrowser: false,
    root: await mkdtemp(join(tmpdir(), "rt-proto-shots-")),
  });
  t.after(() => tr.close("ended"));
  const r = await tr.onTurn(
    0,
    `<prototype title="Coupon" kind="web"><file path="index.html"><!doctype html><h1>Coupon</h1><input><button>Apply</button></file>` +
      `<demo>impatient; impaired; expert</demo></prototype>`,
    1
  );
  assert.equal(r.created.label, "P1 v1");
  assert.deepEqual(r.attachments.map((a) => a.filename).sort(), ["P1v1-desktop.png", "P1v1-mobile.png"]);
  for (const a of r.attachments) {
    assert.equal(a.contentType, "image/png");
    assert.ok(a.bytes.length > 1000);
    assert.deepEqual([...a.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.match(a.caption, /^P1 v1 screenshot \((desktop|mobile)\)$/);
  }
  const shots = join(tr.sessionDir, "P1v1", "shots");
  assert.ok(existsSync(join(shots, "desktop.png")));
  assert.deepEqual(readdirSync(shots).filter((n) => n.startsWith(".chrome-")), []);
  await tr.onTurn(1, "Verdict on P1: APPROVE — fine", 2);
  assert.equal(existsSync(shots), false, "screenshots destroyed with the prototype");
});
