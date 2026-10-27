import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalObserver, createNdjsonObserver } from '../../dist/table/terminal.js';
const seat = { id: 'designer', name: 'designer', role: 'designer', team: 'A', provider: 'anthropic', model: 'claude-sonnet-5-5' };
const turn = text => ({ type: 'turn', seat, text, round: '1', ts: '2026-01-01T00:00:00.000Z' });
function sink(isTTY = false) { let text = ''; return { isTTY, columns: 45, write(s) { text += s; }, read() { return text; } }; }
test('runtime seats without a model display the default badge on turns and dissents', () => {
  const output = sink(), obs = createTerminalObserver({ output });
  const runtime = { ...seat, provider: 'codex', model: '' };
  obs.onEvent({ ...turn('A contribution.'), seat: runtime });
  obs.onEvent({ type: 'dissent', seat: runtime, text: 'A concern.' });
  assert.equal(output.read().match(/\[codex\/default\]/g)?.length, 2);
  assert.doesNotMatch(output.read(), /\[codex\/\]/);
  obs.onEvent({ ...turn('Explicit model.'), seat: { ...runtime, model: 'fixture-model' } });
  assert.match(output.read(), /\[codex\/fixture-model\]/);
});
test('non-TTY and NO_COLOR output have no ANSI; turns wrap to at most six text lines', () => {
  for (const [isTTY, env] of [[false, {}], [true, { NO_COLOR: '' }]]) {
    const output = sink(isTTY), obs = createTerminalObserver({ output, env });
    obs.onEvent(turn('A useful thought about budgets. '.repeat(70)));
    assert.doesNotMatch(output.read(), /\x1b/);
    assert.match(output.read(), /● designer · designer · \[anthropic\/claude-sonnet-5-5\]/);
    const lines = output.read().trim().split('\n').slice(1);
    assert.equal(lines.length, 6); assert.ok(lines.every(s => s.length <= 45));
    assert.match(lines.at(-1), /…$/);
  }
});
test('seat colors are stable on a TTY, and incoming terminal controls are stripped', () => {
  const output = sink(true), obs = createTerminalObserver({ output, env: {} });
  obs.onEvent(turn('hello\x1b[31mprivate\x1b[0m\x07'));
  obs.onEvent(turn('again'));
  const colors = [...output.read().matchAll(/● (\x1b\[\d+m)/g)].map(m => m[1]);
  assert.equal(colors.length, 2); assert.equal(colors[0], colors[1]);
  assert.match(output.read(), /helloprivate/); assert.doesNotMatch(output.read(), /\x07/);
});
test('prototype is a single summary line, assessments have verdict chips, and end prints spend', () => {
  const output = sink(), obs = createTerminalObserver({ output });
  obs.onEvent({ type: 'prototype', team: 'A', seat, ok: true, title: 'Budget\nGame', files: [{ path: 'index.html', bytes: 100 }] });
  assert.equal(output.read().trim().split('\n').length, 1);
  assert.doesNotMatch(output.read(), /index.html|<script/);
  obs.onEvent({ type: 'assessment', judge: { ...seat, name: 'cfo' }, team: 'A', verdict: 'APPROVE', reason: 'Clear controls.' });
  obs.onEvent({ type: 'dissent', seat, text: 'The spending limit needs another check.' });
  obs.onEvent({ type: 'usage', perSeat: [{ seatId: 'designer', inputTokens: 10, outputTokens: 20, costUsd: 0.0123 }], totalCostUsd: 0.0123 });
  obs.onEvent({ type: 'end', winner: 'tie', tally: { A: 1, B: 1 } });
  assert.match(output.read(), /\[APPROVE\]/); assert.match(output.read(), /Dissent/);
  assert.match(output.read(), /Tie · A 1 \/ B 1/); assert.match(output.read(), /Spend: \$0.0123 \(designer \$0.0123\)/);
});
test('unpriced seats print tokens with no price, never $0.0000', () => {
  const output = sink(), obs = createTerminalObserver({ output });
  obs.onEvent({ type: 'usage', perSeat: [{ seatId: 'priced', inputTokens: 10, outputTokens: 20, costUsd: 0.0123, unpricedTokens: 0 }, { seatId: 'glm', inputTokens: 30000, outputTokens: 11200, costUsd: 0, unpricedTokens: 41200, estimated: true }], totalCostUsd: 0.0123, totalUnpricedTokens: 41200 });
  obs.onEvent({ type: 'end', winner: 'A', tally: { A: 1, B: 0 } });
  assert.match(output.read(), /Spend: \$0\.0123 \+ 41\.2k tok unpriced \(priced \$0\.0123, glm 41\.2k tok \(no price\)\)/);
  assert.doesNotMatch(output.read(), /glm \$0/);
});
test('failed prototype never dumps its error or files, and aborted end is labeled', () => {
  const output = sink(), obs = createTerminalObserver({ output });
  obs.onEvent({ type: 'prototype', team: 'B', seat, ok: false, error: 'private detail', files: [] });
  obs.onEvent({ type: 'end', winner: 'none', aborted: true, tally: { A: 0, B: 0 } });
  assert.match(output.read(), /Prototype B: unavailable/); assert.doesNotMatch(output.read(), /private detail/);
  assert.match(output.read(), /Aborted/);
});
test('NDJSON emits precisely one complete uncolored event per line', async () => {
  const output = sink(true), obs = createNdjsonObserver(output);
  const events = [turn('line one\nline two'), { type: 'end', winner: 'A', tally: { A: 2, B: -1 } }];
  for (const event of events) await obs.onEvent(event);
  assert.deepEqual(output.read().trim().split('\n').map(line => JSON.parse(line)), events);
  assert.doesNotMatch(output.read(), /\x1b/);
});
test('NDJSON escapes C1 controls and line separators', async () => {
  const output = sink(true), obs = createNdjsonObserver(output);
  const text = ['a', '\u009b', 'b', ' ', 'c', '\u007f', 'd'].join('');
  await obs.onEvent(turn(text));
  const raw = output.read();
  assert.doesNotMatch(raw, new RegExp('[\\u007f-\\u009f\\u2028\\u2029]'));
  assert.equal(JSON.parse(raw).text, text);
});

test('terminal strips Unicode formatting controls but keeps joiners, and NDJSON escapes them', () => {
  const joined = sink();
  createTerminalObserver({ output: joined }).onEvent(turn('Builder 👩\u200d💻 ready'));
  assert.match(joined.read(), /👩\u200d💻/);
  const codes = [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  const text = 'Visible café 中文 ' + String.fromCharCode(...codes) + ' text';
  const terminal = sink(), ndjson = sink();
  createTerminalObserver({ output: terminal }).onEvent(turn(text));
  createNdjsonObserver(ndjson).onEvent(turn(text));
  for (const code of codes) {
    const character = String.fromCharCode(code);
    // The terminal keeps the joiners (U+200C, U+200D) that scripts and emoji sequences need; NDJSON escapes them all.
    if (code !== 0x200c && code !== 0x200d) assert.ok(!terminal.read().includes(character));
    assert.ok(!ndjson.read().includes(character));
    assert.ok(ndjson.read().includes('\\u' + code.toString(16).padStart(4, '0')));
  }
  assert.match(terminal.read(), /Visible café 中文/);
  assert.equal(JSON.parse(ndjson.read()).text, text);
});
