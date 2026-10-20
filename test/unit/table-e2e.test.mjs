import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const index = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
const game = title => `<prototype kind="web" title="${title}" entry="index.html">\n<file path="index.html">\n<!doctype html><html><body><button id="b">Spend</button><script>document.getElementById('b').onclick=function(){document.title='${title}';};</script></body></html>\n</file>\n</prototype>`;

function fakeProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const messages = JSON.parse(body || '{}').messages ?? [];
      const prompt = String(messages.at(-1)?.content ?? '');
      const reply = text => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'scripted', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
      };
      if (prompt.startsWith('R1 CONCEPT')) return reply(`Concept ${prompt.includes('Team A') ? 'A' : 'B'}: spend ten coins wisely.`);
      if (prompt.startsWith('R1b BUILD')) return reply(game(prompt.includes('Team A') ? 'Ten Coins' : 'Goal Jar'));
      if (prompt.startsWith('R2 JUDGE')) return reply('VERDICT A: APPROVE — Teaches tradeoffs\nVERDICT B: REVISE — Needs fixed expenses');
      if (prompt.startsWith('R4 CLOSING')) return setTimeout(() => reply(`Closing statement.\n<DISSENT>\nclaim: Households differ\npredicted_failure: Players assume spare coins\n</DISSENT>`), 1500);
      reply('ok');
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'roundtable-e2e-'));
  const agents = join(root, 'agents');
  mkdirSync(agents, { recursive: true });
  for (const id of ['designer', 'builder', 'marketer', 'skeptic', 'cfo', 'auditor']) writeFileSync(join(agents, `${id}.md`), `You are a ${id}.\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agents };
}

function run(args, env, onStderr) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [index, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; onStderr?.(err); });
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); ok({ code, out, err }); });
  });
}
const events = out => out.split('\n').filter(Boolean).map(line => JSON.parse(line));
const baseEnv = (root, agents) => ({
  PATH: process.env.PATH, HOME: join(root, 'home'), ROUNDTABLE_HOME: join(root, 'state'), ROUNDTABLE_PROTOTYPE_DIR: join(root, 'prototypes'),
  ROUNDTABLE_AGENTS_DIR: agents, ROUNDTABLE_DOTENV: 'off', ROUNDTABLE_PROTOTYPE_SCREENSHOTS: '0', ROUNDTABLE_PROVIDER_RETRIES: '0',
});

test('duel end to end against a scripted OpenAI-compatible server streams NDJSON and feeds the room', async t => {
  const { root, agents } = setup(t);
  const server = await fakeProvider();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const seats = ['designer', 'builder', 'marketer', 'skeptic', 'cfo', 'auditor'].map(id => `${id}=openai_compatible:scripted`).join(',');
  let roomUrl, snapshot;
  const poll = setInterval(async () => {
    if (!roomUrl) return;
    try {
      const state = await (await fetch(new URL('state.json', roomUrl))).json();
      if (state.assessments.length === 4 && state.prototypes.length === 2) snapshot = state;
    } catch { /* The room closes when the duel ends. */ }
  }, 100);
  t.after(() => clearInterval(poll));
  const { code, out, err } = await run(
    ['duel', 'budget game', '--team-a', 'designer,builder', '--team-b', 'marketer,skeptic', '--judges', 'cfo,auditor', '--seat', seats, '--no-preflight', '--json', '--no-hold'],
    { ...baseEnv(root, agents), OPENAI_COMPATIBLE_BASE_URL: base }, text => { roomUrl ??= /Room: (http\S+)/.exec(text)?.[1]; });
  clearInterval(poll);
  assert.equal(code, 0, err);
  const list = events(out);
  const types = list.map(e => e.type);
  assert.equal(types[0], 'start');
  assert.equal(types.at(-1), 'end');
  assert.equal(types.filter(x => x === 'prototype').length, 2);
  assert.equal(types.filter(x => x === 'assessment').length, 4);
  assert.equal(types.filter(x => x === 'dissent').length, 2);
  assert.ok(types.lastIndexOf('prototype') < types.indexOf('assessment'), 'prototypes precede assessments');
  assert.ok(types.lastIndexOf('assessment') < types.indexOf('dissent'), 'assessments precede dissent');
  assert.ok(types.indexOf('dissent') < types.lastIndexOf('usage'), 'usage follows dissent');
  assert.ok(list.filter(e => e.type === 'turn').every(e => e.seat.provider === 'openai_compatible'));
  assert.deepEqual({ winner: list.at(-1).winner, tally: list.at(-1).tally, aborted: list.at(-1).aborted }, { winner: 'A', tally: { A: 2, B: 0 }, aborted: false });
  assert.ok(roomUrl, 'room url is announced on stderr');
  assert.ok(snapshot, 'the room served its state while the duel ran');
  assert.equal(snapshot.prototypes.filter(p => p.ok).length, 2);
  assert.equal(snapshot.assessments.length, 4);
  assert.equal(snapshot.topic, 'budget game');
});

test('duel --dry-run --json --no-hold replays the synthetic duel with no keys', async t => {
  const { root, agents } = setup(t);
  const { code, out, err } = await run(['duel', 'budget game', '--dry-run', '--json', '--no-hold', '--speed', '1000'], baseEnv(root, agents));
  assert.equal(code, 0, err);
  const types = events(out).map(e => e.type);
  assert.equal(types[0], 'start');
  assert.equal(types.at(-1), 'end');
  assert.equal(types.filter(x => x === 'prototype').length, 2);
});
