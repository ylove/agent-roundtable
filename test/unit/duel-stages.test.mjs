import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runDuel, validateDuelOptions } from '../../dist/table/duel.js';
import { stagePlan, stageBuildPrompt, buildPrompt, DEFAULT_CRITERIA } from '../../dist/table/prompts.js';
import { getPrototypeFiles, replayDuel } from '../../dist/table/replay.js';
import { withSeatConnectors } from '../../dist/table/seat-connectors.js';
import { json, stubFetch } from './helpers.mjs';

const options = { topic: 'A tiny offline planner', teamA: ['a'], teamB: ['b'], judges: ['j'], pageCheck: false };
const seats = [['a', 'A'], ['b', 'B'], ['j', 'judge']].map(([name, team]) => ({ id: `${team}:${name}`, name, team, provider: 'openai_compatible', model: 'claude-sonnet-5-5' }));
const artifact = (team, stage, kind = 'web') => `<prototype kind="${kind}" title="${team} stage ${stage}"><file path="${kind === 'web' ? 'index.html' : 'document.md'}">${kind === 'web' ? `<!doctype html><html><head><title>${team}</title></head><body>Valid ${team} stage ${stage}</body></html>` : `${team} stage ${stage}`}</file></prototype>`;
const verdict = 'VERDICT A: APPROVE — complete\nVERDICT B: REVISE — improve\nPREFER: A';
function stub(t, script = {}) {
  const original = process.env.OPENAI_COMPATIBLE_BASE_URL;
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1/v1';
  t.after(() => { if (original === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL; else process.env.OPENAI_COMPATIBLE_BASE_URL = original; });
  const attempts = {};
  return stubFetch(t, async (_url, init) => {
    const req = JSON.parse(init.body), prompt = req.messages.at(-1).content;
    const team = /Team ([AB])/.exec(prompt)?.[1];
    let content = 'A concise closing.';
    if (prompt.startsWith('R1 CONCEPT')) {
      await script.concept?.(team);
      content = `A concept for ${team}.`;
    } else if (prompt.startsWith('R1c CRITIQUE')) content = 'Keep the controls simple.';
    else if (prompt.startsWith('R1b BUILD')) {
      const stage = Number(/stage (\d) of/.exec(prompt)?.[1] ?? 1);
      const key = team + stage;
      const attempt = attempts[key] = (attempts[key] ?? 0) + 1;
      content = await script.build?.(team, stage, attempt, prompt) ?? artifact(team, stage, script.kind);
    } else if (prompt.startsWith('R2 JUDGE')) content = script.verdict ?? verdict;
    return json(200, { model: req.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
}
async function run(t, { script, opts, onEvent, deps } = {}) {
  const calls = stub(t, script), events = [];
  const result = await runDuel({ ...options, ...opts }, { async onEvent(e) { events.push(e); await onEvent?.(e); } }, new AbortController().signal,
    { resolveSeats: () => seats.map(s => ({ ...s })), ...deps });
  return { result, calls, events, prompts: calls.map(c => c.body.messages.at(-1).content) };
}

test('stage plans merge adjacent goals in order, are pure, and one stage keeps the original prompt', () => {
  assert.deepEqual(stagePlan('web', 4).map(s => s.name), ['Skeleton', 'Screens', 'Working', 'Polish']);
  assert.deepEqual(stagePlan('web', 3).map(s => s.name), ['Skeleton', 'Screens and interactions', 'Polish']);
  assert.deepEqual(stagePlan('web', 2).map(s => s.name), ['Skeleton and screens', 'Working and polished']);
  for (const kind of ['web', 'code', 'diagram', 'text']) {
    const full = stagePlan(kind, 4);
    for (const n of [1, 2, 3, 4]) {
      const plan = stagePlan(kind, n);
      assert.deepEqual(plan.map(s => s.index), Array.from({ length: n }, (_, i) => i + 1));
      assert.equal(plan.map(s => s.goal).join(' '), full.map(s => s.goal).join(' '));
    }
    assert.equal(stageBuildPrompt('brief', 'A', 'concept', '', kind, full[0], 1, 'ignored', 'nonce'), buildPrompt('brief', 'A', 'concept', '', kind));
  }
  for (const kind of ['code', 'diagram', 'text']) assert.deepEqual(stagePlan(kind, 4).map(s => s.name), ['Outline', 'Draft', 'Complete', 'Refine']);
  stagePlan('web', 4)[0].name = 'mutated';
  assert.equal(stagePlan('web', 4)[0].name, 'Skeleton');
  for (const stages of [0, 5, -1, 1.5, NaN, Infinity, '2', null]) {
    assert.throws(() => validateDuelOptions({ ...options, stages }), /stages.*integer.*1.*4/);
    assert.throws(() => stagePlan('web', stages), /stages/);
  }
});

test('web defaults to four independent pipelines with ordered stages, valid versions, and nonce fenced previous source', async t => {
  const slowB = Promise.withResolvers();
  const { events, result, calls, prompts } = await run(t, {
    script: { concept: team => team === 'B' ? slowB.promise : undefined },
    onEvent(e) { if (e.type === 'stage' && e.team === 'A' && e.stage === 4 && e.status === 'done') slowB.resolve(); },
  });
  assert.equal(result.aborted, false);
  assert.equal(events[0].stages.length, 4);
  for (const team of ['A', 'B']) {
    const stages = events.filter(e => e.type === 'stage' && e.team === team);
    assert.deepEqual(stages.map(e => [e.stage, e.status]), [1, 2, 3, 4].flatMap(n => [[n, 'started'], [n, 'done']]));
    const versions = events.filter(e => e.type === 'prototype' && e.team === team && e.ok);
    assert.deepEqual(versions.map(e => [e.version, e.stage]), [[1, 1], [2, 2], [3, 3], [4, 4]]);
    for (const version of versions) {
      const index = events.indexOf(version);
      assert.ok(events.findIndex(e => e.type === 'stage' && e.team === team && e.stage === version.stage && e.status === 'started') < index);
      assert.ok(events.findIndex(e => e.type === 'stage' && e.team === team && e.stage === version.stage && e.status === 'done') > index);
    }
    assert.equal(result.metrics[team].stagesDone, 4);
    assert.equal(result.metrics[team].versions, 4);
    assert.equal(result.metrics[team].turns, 6);
    assert.equal(result.metrics[team].inputTokens, 600);
    assert.equal(result.metrics[team].outputTokens, 120);
    assert.ok(result.metrics[team].finishedAt);
  }
  const finishA = events.findIndex(e => e.type === 'stage' && e.team === 'A' && e.stage === 4 && e.status === 'done');
  assert.ok(finishA < events.findIndex(e => e.type === 'turn' && e.round === 'R1' && e.seat.team === 'B'), 'A finishes while B is still designing');
  const build2 = prompts.find(p => p.startsWith('R1b BUILD') && /Team A/.test(p) && /stage 2 of 4/.test(p));
  const nonce = /<<<ARTIFACT (\w+) A>>>/.exec(build2)[1];
  assert.ok(build2.includes(`<<<END ARTIFACT ${nonce} A>>>`));
  assert.ok(build2.includes(`<<<FILE ${nonce} index.html>>>`));
  assert.match(build2, /Valid A stage 1/);
  assert.match(build2, /Keep what works; return the complete updated artifact, not a diff/);
  assert.match(build2, /Return one self-contained web page/);
  assert.ok(calls.filter(c => c.body.messages.at(-1).content.startsWith('R1b BUILD')).every(c => c.body.max_tokens === 16_384));
  const judging = prompts.find(p => p.startsWith('R2 JUDGE'));
  const record = judging.slice(judging.indexOf('Engine-written process record:'), judging.indexOf('Team A source:'));
  assert.match(record, /Team A: stages done 4 of 4; elapsed \d+ ms; tokens 500 input \+ 100 output/);
  assert.match(record, /versions 4; rewrites 0; validation failures 0; page errors 0/);
  assert.ok(!record.includes('<<<'), 'process record sits outside the untrusted fences');
  assert.ok(judging.includes(DEFAULT_CRITERIA.at(-1)));
  assert.deepEqual(events.at(-1).metrics, result.metrics);
  const archive = JSON.parse(await readFile(result.archivePath, 'utf8'));
  assert.equal(archive.version, 2);
  assert.equal(archive.prototypes.length, 8);
  const replayed = [];
  const replay = await replayDuel(result.archivePath, { onEvent(e) { replayed.push(e); } }, { speed: 1e9 });
  assert.deepEqual(replayed, events);
  assert.deepEqual(replay.metrics, result.metrics);
  assert.equal(getPrototypeFiles(replayed.find(e => e.type === 'prototype')).length, 1);
});

test('failed stages retain the valid version, carry all feedback forward, and count failed calls separately from validation', async t => {
  const checkAttempts = { A: 0, B: 0 };
  const { events, result, prompts } = await run(t, {
    opts: { stages: 3, pageCheck: true },
    script: { build(team, stage, attempt) {
      if (team === 'A' && stage === 1 && attempt === 1) return 'invalid';
      if (team === 'A' && stage === 2 && attempt === 2) throw new Error('Synthetic provider failure');
    } },
    deps: {
      startRoom: async () => ({ url: 'http://127.0.0.1:1/test/', observer: { onEvent() {} }, close: async () => {} }),
      checkPage: async url => {
        const team = /\/p\/([AB])\//.exec(url)[1], attempt = ++checkAttempts[team];
        return { ok: true, loaded: true, failedRequests: 0, consoleErrors: team === 'A' && attempt <= 2 ? ['First console error', 'Second console error'] : [], exceptions: team === 'A' && attempt === 2 ? ['Broken screen'] : [] };
      },
    },
  });
  assert.deepEqual(events.filter(e => e.type === 'stage' && e.team === 'A').map(e => e.status), ['started', 'done', 'started', 'failed', 'started', 'done']);
  assert.deepEqual(events.filter(e => e.type === 'prototype' && e.team === 'A').map(e => [e.version, e.stage]), [[1, 1], [2, 3]]);
  const next = prompts.find(p => /stage 3 of 3/.test(p) && /Team A/.test(p));
  assert.match(next, /Valid A stage 1/);
  assert.doesNotMatch(next, /Valid A stage 2/);
  assert.match(next, /The build turn did not complete/);
  assert.match(next, /First console error/);
  assert.match(next, /Second console error/);
  assert.match(next, /Broken screen/);
  const m = result.metrics.A;
  assert.equal(m.stagesDone, 2);
  assert.equal(m.versions, 2);
  assert.equal(m.rewrites, 2);
  assert.equal(m.validationFailures, 1);
  assert.equal(m.pageErrors, 5);
  assert.equal(m.failedTurns, 1);
  assert.equal(m.turns, 7);
  assert.equal(result.metrics.B.rewrites, 0);
  const stage3start = events.findIndex(e => e.type === 'stage' && e.team === 'A' && e.stage === 3 && e.status === 'started');
  assert.ok(events.slice(0, stage3start).some(e => e.type === 'metrics' && e.teams.A.failedTurns === 1));
});

test('a failed final stage leaves the previous version for the judges', async t => {
  const { events, result, prompts } = await run(t, { opts: { stages: 2 }, script: { build: (team, stage) => team === 'A' && stage === 2 ? 'invalid stage' : undefined } });
  assert.equal(result.metrics.A.versions, 1);
  assert.equal(result.metrics.A.stagesDone, 1);
  assert.equal(result.metrics.A.validationFailures, 2);
  assert.equal(result.metrics.A.rewrites, 1);
  assert.match(prompts.find(p => p.startsWith('R2 JUDGE')), /Version v1\nPage check: not checked\n<<<FILE [^\n]+\n[^\n]*Valid A stage 1/);
  assert.equal(events.find(e => e.type === 'assessment' && e.team === 'A').version, 1);
});

test('deadline skips stages not started and judges the latest valid version with a stopped-at process record', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const { events, prompts, result } = await run(t, {
    opts: { maxSeconds: 1 },
    onEvent(e) { if (e.type === 'stage' && e.team === 'A' && e.stage === 1 && e.status === 'done') t.mock.timers.tick(1000); },
  });
  assert.equal(result.aborted, false);
  assert.deepEqual(events.filter(e => e.type === 'stage' && e.team === 'A' && e.status === 'skipped').map(e => e.stage), [2, 3, 4]);
  const judging = prompts.find(p => p.startsWith('R2 JUDGE'));
  assert.match(judging, /Team A: stages done 1 of 4; stopped at stage 1 of 4/);
  assert.match(judging, /Valid A stage 1/);
  assert.equal(events.find(e => e.type === 'assessment' && e.team === 'A').version, 1);
});

test('default web deadline adds 150 seconds for each extra stage', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const { result, events } = await run(t, {
    onEvent(e) {
      if (e.type === 'stage' && e.team === 'A' && e.stage === 1 && e.status === 'started') t.mock.timers.tick(600_000);
      if (e.type === 'stage' && e.team === 'A' && e.stage === 1 && e.status === 'done') t.mock.timers.tick(450_000);
    },
  });
  assert.equal(result.metrics.A.versions, 1, 'stage 1 can still build after the original 600 second deadline');
  assert.deepEqual(events.filter(e => e.type === 'stage' && e.team === 'A' && e.status === 'skipped').map(e => e.stage), [2, 3, 4]);
});

test('other kinds default to one build and custom criteria replace the process criterion', async t => {
  const { result, events, prompts } = await run(t, { opts: { kind: 'text', criteria: ['Clarity only'] }, script: { kind: 'text' } });
  assert.equal(events[0].stages.length, 1);
  assert.equal(result.metrics.A.stagesTotal, 1);
  assert.equal(result.metrics.A.versions, 1);
  assert.ok(prompts.filter(p => p.startsWith('R1b BUILD')).every(p => !p.includes('stage 1 of')));
  const judging = prompts.find(p => p.startsWith('R2 JUDGE'));
  assert.match(judging, /Clarity only/);
  assert.ok(!judging.includes(DEFAULT_CRITERIA.at(-1)));
});

test('revision after judging counts as a rewrite while keeping the original stage total', async t => {
  const { result, events } = await run(t, { opts: { stages: 2, rounds: 2 } });
  assert.equal(result.metrics.A.rewrites, 0);
  assert.equal(result.metrics.B.rewrites, 1);
  assert.equal(result.metrics.B.stagesDone, 2);
  assert.equal(result.metrics.B.stagesTotal, 2);
  assert.equal(result.metrics.B.versions, 3);
  assert.equal(events.filter(e => e.type === 'turn' && e.round === 'R3').length, 1);
});

test('connector hook counts actual tool calls (including failed calls), excluding notices and judges', async t => {
  let note;
  const connectors = { connectors: [], toolNames: [], turn() {}, unavailable() {}, onNote(fn) { note = fn; }, async close() {} };
  const { result, events } = await withSeatConnectors(connectors, () => run(t, {
    opts: { stages: 1 }, script: { concept(team) {
      if (team === 'A') {
        note({ seat: 'a', tool: '', ok: false, note: 'Notice only' });
        note({ seat: 'a', tool: 'docs__read', ok: true, note: 'Read docs' });
        note({ seat: 'a', tool: 'docs__read', ok: false, note: 'Read failed' });
        note({ seat: 'j', tool: 'docs__read', ok: true, note: 'Judge read docs' });
      }
    } },
  }));
  assert.equal(result.metrics.A.toolCalls, 2);
  assert.equal(result.metrics.B.toolCalls, 0);
  assert.ok(events.some(e => e.type === 'metrics' && e.teams.A.toolCalls === 1));
  assert.ok(events.some(e => e.type === 'metrics' && e.teams.A.toolCalls === 2));
});
