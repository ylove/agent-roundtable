import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatedFiles } from '../../dist/table/duel.js';
import { replayDuel, getPrototypeFiles } from '../../dist/table/replay.js';

const fixture = new URL('../../examples/duel/demo.json', import.meta.url);
const archive = JSON.parse(await readFile(fixture, 'utf8'));

// A small DOM harness exercises the bundled games without a browser or listener.
function game(html) {
  const elements = new Map();
  const element = attrs => ({ ...attrs, textContent: '', setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; } });
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element({ id }));
  const screens = ['welcome', 'play', 'results'].map(id => elements.get(id));
  const links = [...html.matchAll(/href="(#[^"]+)"/g)].map(([, hash]) => element({ hash }));
  const choices = [...html.matchAll(/data-cost="(\d+)" data-item="([^"]+)"/g)].map(([, cost, item]) => element({ dataset: { cost, item } }));
  const errors = [], listeners = new Map(), intervals = new Map();
  let hash = '', nextId = 1;
  const location = { get hash() { return hash; }, set hash(value) { hash = value.startsWith('#') ? value : '#' + value; listeners.get('hashchange')?.(); } };
  const context = createContext({
    document: { getElementById: id => elements.get(id), querySelectorAll: selector => ({ 'main section': screens, 'nav a': links, '[data-cost]': choices })[selector] },
    location, addEventListener: (name, fn) => listeners.set(name, fn), console: { error: text => errors.push(text) },
    setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
  });
  for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(source).runInContext(context, { timeout: 100 });
  return { elements, screens, links, choices, errors, intervals, location };
}

test('the promotional fixture has eight valid, small versions that truly grow from shell to screens to working to polished', () => {
  assert.equal(archive.version, 2);
  assert.equal(archive.events[0].topic, '60-second browser game that teaches kids to budget');
  assert.equal(archive.events[0].stages.length, 4);
  assert.equal(archive.prototypes.length, 8);
  for (const team of ['A', 'B']) {
    const versions = archive.prototypes.filter(p => p.team === team);
    assert.equal(versions.length, 4);
    let previousSize = 0;
    versions.forEach((p, i) => {
      const event = archive.events[p.eventIndex], html = p.files[0].content;
      assert.equal(event.type, 'prototype');
      assert.equal(event.version, i + 1);
      assert.equal(event.stage, i + 1);
      const source = `<prototype kind="web" title="demo" entry="index.html"><file path="index.html">${html}</file></prototype>`;
      assert.doesNotThrow(() => validatedFiles(source));
      const size = Buffer.byteLength(html);
      assert.ok(size <= 6 * 1024, `${team} v${i + 1} is ${size} bytes`);
      assert.ok(size > previousSize, `${team} v${i + 1} grows`);
      previousSize = size;
      assert.equal(event.files[0].bytes, size);
      assert.match(html, /^<!doctype html><html lang="en"><head>/);
      assert.ok(html.endsWith('</body></html>'));
      const dom = game(html);
      for (const id of ['welcome', 'play', 'results']) {
        assert.ok(html.includes(`id="${id}" aria-label="`));
        dom.location.hash = id;
        assert.deepEqual(dom.screens.filter(s => !s.hidden).map(s => s.id), [id]);
        assert.equal(dom.links.filter(l => l['aria-current'] === 'page').length, 1);
      }
      if (i === 0) {
        assert.equal((html.match(/Empty placeholder/g) ?? []).length, 3);
        assert.ok(!html.includes('<button') && !html.includes('<output'));
      } else if (i === 1) {
        assert.match(html, /id="start" disabled/);
        assert.match(html, /Bus · need · 2 coins/);
        assert.match(html, /Your result will appear here/);
        assert.ok(!dom.elements.get('start').onclick);
      } else {
        assert.equal(typeof dom.elements.get('start').onclick, 'function');
        assert.equal(dom.errors.length, 0, 'the Working stage fixes the page error');
      }
      if (i === 3) {
        assert.match(html, /@media\(max-width:600px\)/);
        assert.match(html, /:focus-visible/);
        assert.match(html, /role="status"/);
        assert.match(html, /No round played yet/);
      }
    });
  }
});

test('the demo working and polished versions run purchases, errors, results, restart, and the full 60 second timer', () => {
  for (const p of archive.prototypes) {
    if (archive.events[p.eventIndex].version < 3) continue;
    const dom = game(p.files[0].content), byId = id => dom.elements.get(id), choice = item => dom.choices.find(b => b.dataset.item === item);
    byId('start').onclick();
    assert.equal(dom.location.hash, '#play');
    assert.equal(dom.intervals.size, 1);
    choice('bus').onclick(); choice('lunch').onclick(); choice('sticker').onclick();
    assert.equal(byId('balance').textContent, 3);
    choice('toy').onclick();
    assert.match(byId('feedback').textContent, /Not enough coins/);
    assert.equal(byId('balance').textContent, 3);
    choice('sticker').onclick();
    assert.equal(byId('balance').textContent, 5);
    byId('finish').onclick();
    assert.equal(dom.intervals.size, 0);
    assert.equal(dom.location.hash, '#results');
    assert.match(byId('summary').textContent, /Great plan!.*saved 5 of 10/);
    byId('again').onclick();
    assert.equal(byId('balance').textContent, 10);
    const tick = [...dom.intervals.values()][0];
    for (let i = 0; i < 60; i++) tick();
    assert.equal(dom.intervals.size, 0);
    assert.equal(dom.location.hash, '#results');
    assert.match(byId('summary').textContent, /Cover bus and lunch/);
  }
});

test('demo timing and metrics show A finishing sooner and cheaper, B rewriting once and fixing its single page error', async () => {
  const events = [], files = [];
  const result = await replayDuel(fixture, { onEvent(e) { events.push(e); if (e.type === 'prototype') files.push(...getPrototypeFiles(e)); } }, { speed: 1e9 });
  assert.deepEqual(events, archive.events);
  assert.equal(files.length, 8);
  const finish = team => archive.events.find(e => e.type === 'stage' && e.team === team && e.stage === 4 && e.status === 'done');
  const difference = Date.parse(finish('B').ts) - Date.parse(finish('A').ts);
  assert.ok(difference >= 10_000, 'A visibly finishes at least 10 seconds sooner');
  const timestamps = archive.events.map(e => e.type === 'start' ? e.startedAt : e.ts).filter(Boolean).map(Date.parse);
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b));
  const duration = timestamps.at(-1) - timestamps[0];
  assert.ok(duration >= 40_000 && duration <= 60_000, `default replay lasts ${duration / 1000}s`);
  assert.ok(result.metrics.A.elapsedMs < result.metrics.B.elapsedMs);
  assert.ok(result.metrics.A.inputTokens + result.metrics.A.outputTokens < result.metrics.B.inputTokens + result.metrics.B.outputTokens);
  assert.ok(result.metrics.A.costUsd < result.metrics.B.costUsd);
  assert.equal(result.metrics.A.rewrites, 0);
  assert.equal(result.metrics.B.rewrites, 1);
  assert.equal(result.metrics.B.validationFailures, 1);
  assert.equal(result.metrics.B.pageErrors, 1);
  for (const team of ['A', 'B']) {
    assert.equal(result.metrics[team].stagesDone, 4);
    assert.equal(result.metrics[team].versions, 4);
    const usage = archive.events.find(e => e.type === 'usage').perSeat.filter(s => archive.events[0].seats.find(seat => seat.id === s.seatId)?.team === team);
    assert.equal(result.metrics[team].inputTokens, usage.reduce((n, s) => n + s.inputTokens, 0));
    assert.equal(result.metrics[team].outputTokens, usage.reduce((n, s) => n + s.outputTokens, 0));
  }
  const b = archive.events.filter(e => e.type === 'prototype' && e.team === 'B');
  assert.equal(b.filter(e => e.check.consoleErrors.length).length, 1);
  assert.equal(b[1].check.consoleErrors.length, 1);
  assert.equal(b[2].check.consoleErrors.length, 0);
  assert.equal(result.winner, 'A');
  assert.equal(result.decidedBy, 'judges');
  assert.ok(archive.events.some(e => e.type === 'assessment'));
  assert.ok(archive.events.some(e => e.type === 'dissent'));
});


test('the CLI dry run replays every staged event without keys or a listener', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
    'duel', '--dry-run', '--json', '--no-room', '--no-hold', '--speed', '1000000000'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ROUNDTABLE_DOTENV: 'off', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TOGETHER_API_KEY: '', REPLICATE_API_TOKEN: '', OPENAI_COMPATIBLE_BASE_URL: '' },
  });
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line)), archive.events);
});
