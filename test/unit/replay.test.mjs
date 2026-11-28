import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayDuel, getPrototypeFiles } from "../../dist/table/replay.js";
import { ROOM_HTML, ROOM_JS, ROOM_CSP } from "../../dist/table/room-assets.js";
import { inlineProblems, stubFetch } from "./helpers.mjs";

const fixture = new URL("../../examples/duel/demo.json", import.meta.url);

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
  assert.equal(games.length, 8);
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

test('version 1 archives retain the original events, files and result without new optional fields', async () => {
  const path = new URL('../fixtures/duel-v1.json', import.meta.url);
  const original = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(original.version, 1);
  const events = [];
  const result = await replayDuel(path, { onEvent(e) { events.push(e); } }, { speed: 1e9 });
  assert.deepEqual(events, original.events);
  assert.equal(events.filter(e => e.type === 'prototype').length, 2);
  assert.ok(events.filter(e => e.type === 'prototype').every(e => getPrototypeFiles(e).length === 1));
  assert.equal(result.winner, 'A');
  assert.ok(!('metrics' in result) && !('chosen' in result));
});

test('version 2 replay faithfully carries controls, decisions, metrics and chosen artifact metadata', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'duel-replay-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const start = { ...original.events[0], humanJudge: true };
  const end = { ...original.events.at(-1), decidedBy: 'human', chosen: { team: 'A', version: 4, dir: 'duels/duel-demo/chosen', files: ['index.html'] }, resumable: false };
  const ts = start.startedAt;
  const events = [start, { type: 'control', action: 'stopped', by: 'room', ts }, { ...start, resumed: true }, { type: 'control', action: 'resumed', by: 'terminal', ts },
    { type: 'decision', status: 'awaiting', ts }, { type: 'decision', status: 'made', by: 'human', winner: 'A', version: 4, ts },
    { type: 'metrics', teams: end.metrics, ts }, end];
  const path = join(dir, 'archive.json');
  await writeFile(path, JSON.stringify({ version: 2, events, prototypes: [] }));
  const replayed = [];
  const result = await replayDuel(path, { onEvent(e) { replayed.push(e); } }, { speed: 1e9 });
  assert.deepEqual(replayed, events);
  assert.deepEqual(result.chosen, end.chosen);
  assert.deepEqual(result.metrics, end.metrics);
  assert.equal(result.decidedBy, 'human');
  assert.equal(result.resumable, false);
});

test('replay uses stage, metric and control timestamps as well as turn timestamps', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'duel-replay-time-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const start = original.events[0], end = original.events.at(-1);
  const at = seconds => new Date(Date.parse(start.startedAt) + seconds * 1000).toISOString();
  const events = [start, { type: 'stage', team: 'A', stage: 1, of: 4, name: 'Skeleton', status: 'started', ts: at(10) },
    { type: 'metrics', teams: end.metrics, ts: at(20) }, { type: 'control', action: 'stopped', by: 'room', ts: at(30) },
    { type: 'turn', round: 'R1b', seat: start.seats[0], text: 'A turn', ts: at(40) }, end];
  const path = join(dir, 'archive.json');
  await writeFile(path, JSON.stringify({ version: 2, events, prototypes: [] }));
  const delays = [], timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => { delays.push(delay); return timeout(fn, 0, ...args); });
  await replayDuel(path, { onEvent() {} }, { speed: 2 });
  assert.deepEqual(delays, [5000, 5000, 5000, 5000]);
});

test('version 2 replay rejects malformed stage and process fields before emitting anything', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'duel-replay-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const path = join(dir, 'archive.json');
  for (const mutate of [
    a => { a.events.find(e => e.type === 'stage').stage = 0; },
    a => { a.events.find(e => e.type === 'stage').of = 5; },
    a => { a.events.find(e => e.type === 'stage').status = 'unknown'; },
    a => { a.events[0].stages[0].index = 2; },
    a => { a.events.find(e => e.type === 'prototype').stage = 5; },
    a => { a.events.find(e => e.type === 'metrics').teams.A.rewrites = -1; },
    a => { a.events.find(e => e.type === 'metrics').teams.B = null; },
    a => { a.events.at(-1).metrics.A.finishedAt = 'bad date'; },
    a => { a.events.at(-1).metrics.A.stagesDone = 5; },
    a => { a.events.at(-1).chosen = { team: 'A', version: 4, dir: '../chosen', files: ['index.html'] }; },
  ]) {
    const archive = structuredClone(original);
    mutate(archive);
    await writeFile(path, JSON.stringify(archive));
    await assert.rejects(replayDuel(path, { onEvent() { assert.fail('invalid replay must emit nothing'); } }), /Invalid duel/);
  }
});
