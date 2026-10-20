import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayDuel, getPrototypeFiles } from "../../dist/table/replay.js";
import { ROOM_HTML, ROOM_JS, ROOM_CSP } from "../../dist/table/room-assets.js";
import { inlineProblems, stubFetch } from "./helpers.mjs";

const fixture = new URL("../fixtures/duel/demo.json", import.meta.url);

test("synthetic replay reproduces events and prototype contents without any provider calls or keys", async t => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "OPENAI_COMPATIBLE_API_KEY"]) {
    const previous = process.env[key]; delete process.env[key];
    t.after(() => { if (previous !== undefined) process.env[key] = previous; });
  }
  const calls = stubFetch(t, () => { throw new Error("Replay must not call a provider"); });
  const events = [];
  const games = [];
  const result = await replayDuel(fixture, { onEvent(event) {
    events.push(event);
    if (event.type === "prototype") games.push(...getPrototypeFiles(event));
  } }, { speed: 100000 });
  const archive = JSON.parse(await readFile(fixture, "utf8"));
  assert.deepEqual(events, archive.events);
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1).type, "end");
  assert.equal(games.length, 2);
  assert.ok(games.every(g => g.path === "index.html" && g.content.includes("<script>")));
  assert.equal(result.winner, "A");
  assert.equal(calls.length, 0);
});

test("replay cancellation interrupts its delay", async () => {
  const controller = new AbortController();
  let count = 0;
  const pending = replayDuel(fixture, { onEvent() { if (++count === 1) setTimeout(() => controller.abort(new Error("Stopped replay")), 5); } }, { speed: 0.001, signal: controller.signal });
  await assert.rejects(pending, /Stopped replay/);
  assert.equal(count, 1);
});

test("replay rejects invalid speed, unsupported archives, missing sources, and path traversal", async t => {
  await assert.rejects(replayDuel(fixture, { onEvent() {} }, { speed: 0 }), /speed/);
  const archive = JSON.parse(await readFile(fixture, "utf8"));
  const path = join(tmpdir(), `duel-replay-invalid-${process.pid}.json`);
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(path, { force: true }); });
  await writeFile(path, JSON.stringify({ ...archive, version: 99 }));
  await assert.rejects(replayDuel(path, { onEvent() {} }), /Unsupported/);
  await writeFile(path, JSON.stringify({ ...archive, prototypes: [] }));
  await assert.rejects(replayDuel(path, { onEvent() {} }), /missing prototype/);
  archive.prototypes[0].files[0].path = "../index.html";
  await writeFile(path, JSON.stringify(archive));
  await assert.rejects(replayDuel(path, { onEvent() {} }), /Invalid archived/);
});

test("room shell has a strict CSP, external script, safe text DOM writes, and opaque frames", () => {
  assert.deepEqual(inlineProblems(ROOM_HTML), []);
  assert.match(ROOM_CSP, /script-src 'self'/);
  assert.ok(!ROOM_CSP.includes("unsafe-inline"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(ROOM_JS));
  assert.match(ROOM_JS, /textContent/);
  assert.match(ROOM_JS, /allow-scripts allow-forms allow-modals/);
  assert.ok(!ROOM_JS.includes("allow-same-origin"));
  assert.doesNotThrow(() => new Function(ROOM_JS));
});
