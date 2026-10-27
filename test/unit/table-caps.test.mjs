// Session spend and process-wide live session controls, using offline providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { json, stubFetch } from './helpers.mjs';
import { runDuel } from '../../dist/table/duel.js';
import { checkpointPath, validateCheckpoint } from '../../dist/table/checkpoint.js';
import { liveDuels, persistedLiveDuels, registerDuel, unregisterDuel } from '../../dist/table/live-duels.js';
import { setSessionCap, sessionCapView, recordSessionSpend, clearSessionCap, sessionSpend, stopCappedSession } from '../../dist/usage/session-caps.js';
import { liveSessionLimit } from '../../dist/usage/live-limit.js';
import { lineFor, metered, sessionSignal, stoppedSessions } from '../../dist/usage/session-scope.js';
import { reportUsage, withUsageSink } from '../../dist/providers/usage.js';
import { budgetEstimate } from '../../dist/providers/router.js';
import { startMeeting, meetings, continueMeeting, endMeeting } from '../../dist/sessions/meetings.js';
import { startCollaboration, collaborations, endCollaboration } from '../../dist/sessions/collaborations.js';
import { startLocalMeeting } from '../../dist/sessions/local-meetings.js';
import { startUltraplan } from '../../dist/sessions/ultraplan.js';
import { liveSessions } from '../../dist/usage/table-service.js';
import { collectUsage } from '../../dist/usage/model.js';
import { runCastingCall } from '../../dist/casting/casting.js';
import { createTerminalObserver } from '../../dist/table/terminal.js';

const sample = fileURLToPath(new URL('../fixtures/agents/sample.md', import.meta.url));
const plain = fileURLToPath(new URL('../fixtures/agents/plain.md', import.meta.url));
const opts = { topic: 'A policy', teamA: ['a'], teamB: ['b'], judges: ['j'], kind: 'text', stages: 1, pageCheck: false };
const seats = [['a', 'A'], ['b', 'B'], ['j', 'judge']].map(([name, team]) => ({ id: `${team}:${name}`, name, team, provider: 'openai_compatible', model: 'unknown-cap-model' }));
const deps = { resolveSeats: () => seats.map(s => ({ ...s })) };
const signal = () => new AbortController().signal;
function env(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}
function provider(t, hook) {
  env(t, 'OPENAI_COMPATIBLE_BASE_URL', 'http://127.0.0.1:1/v1');
  return stubFetch(t, async (_url, init) => {
    const req = JSON.parse(init.body), p = req.messages.at(-1).content;
    await hook?.(req, init);
    const content = p.startsWith('R1b BUILD') ? '<prototype kind="text" title="Policy"><file path="document.md"># A policy</file></prototype>'
      : p.startsWith('R2 JUDGE') ? 'VERDICT A: APPROVE — clear\nVERDICT B: REJECT — thin\nPREFER: A' : 'A short contribution.';
    return json(200, { model: req.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
}
const observer = () => { const events = []; return { events, onEvent(e) { events.push(e); } }; };
const base = 'http://127.0.0.1:1/v1';
const start = maxUsd => startMeeting(sample, 'agenda', undefined, 'openai_compatible', 'unknown-cap-model', base, 'standard', undefined, false, false, false, { maxUsd });

test('a duel crossing its cap checkpoints, refuses the same cap, and resumes with a higher cap', async t => {
  const calls = provider(t), obs = observer();
  const stopped = await runDuel({ ...opts, maxUsd: 0.001 }, obs, signal(), deps);
  assert.equal(stopped.resumable, true);
  assert.equal(stopped.aborted, true);
  assert.ok(!obs.events.some(e => e.type === 'end'));
  assert.equal(obs.events.at(-1).reason, 'spend cap');
  const cp = JSON.parse(await readFile(checkpointPath(stopped.id), 'utf8'));
  assert.equal(cp.options.maxUsd, 0.001);
  const spent = cp.usage.reduce((n, u) => n + (u.capSpendUsd ?? 0), 0);
  assert.ok(spent >= cp.options.maxUsd);
  const usage = obs.events.filter(e => e.type === 'usage').at(-1);
  assert.equal(usage.spentUsd, spent);
  assert.equal(usage.capUsd, 0.001);
  assert.equal(usage.capReached, true);
  assert.equal(usage.totalCostUsd, 0, 'unpriced tokens retain their normal usage display');
  const offset = calls.length;
  await assert.rejects(runDuel({ resume: stopped.id }, observer(), signal(), deps), /raise --max-usd/);
  await assert.rejects(runDuel({ resume: stopped.id, maxUsd: 0.001 }, observer(), signal(), deps), /raise --max-usd/);
  assert.equal(calls.length, offset);
  for (const cap of [0, -1, Infinity, 'private-value']) {
    const changed = structuredClone(cp); changed.options.maxUsd = cap;
    assert.throws(() => validateCheckpoint(changed, cp.id), /Malformed/);
  }
  const changed = structuredClone(cp); changed.options.extra = 1;
  assert.throws(() => validateCheckpoint(changed, cp.id), /Malformed/);
  const resumed = observer();
  const done = await runDuel({ resume: stopped.id, maxUsd: 1 }, resumed, signal(), deps);
  assert.equal(done.aborted, false);
  assert.ok(calls.length > offset);
  assert.ok(resumed.events.filter(e => e.type === 'usage').at(-1).spentUsd > spent);
  await assert.rejects(stat(checkpointPath(stopped.id)), { code: 'ENOENT' });
});

test('metered calls update the live registry atomically and the usage view shows cap and spend', async t => {
  provider(t);
  const obs = observer();
  let checked = false, observerError;
  const done = await runDuel({ ...opts, maxUsd: 1 }, { async onEvent(e) {
    obs.onEvent(e);
    if (e.type !== 'usage' || e.spentUsd <= 0) return;
    try {
    const id = obs.events[0].id;
    const d = liveDuels().find(d => d.id === id), persisted = persistedLiveDuels().find(d => d.id === id);
    assert.equal(d.maxUsd, 1); assert.equal(d.spentUsd, e.spentUsd);
    assert.equal(persisted.spentUsd, e.spentUsd);
    assert.equal(liveSessions().find(s => s.id === id).maxUsd, 1);
    const view = await collectUsage();
    assert.equal(view.agents.find(a => a.scope === id).spent_usd, e.spentUsd);
    checked = true;
    } catch (error) { observerError = error; }
  } }, signal(), deps);
  assert.equal(done.aborted, false); if (observerError) throw observerError; assert.equal(checked, true);
  assert.ok(!liveDuels().some(d => d.id === done.id));
});

test('uncapped duel usage and events retain their shape', async t => {
  provider(t); const obs = observer();
  const done = await runDuel(opts, obs, signal(), deps);
  assert.equal(done.aborted, false);
  for (const e of obs.events.filter(e => e.type === 'usage')) {
    assert.ok(!('capUsd' in e)); assert.ok(!('spentUsd' in e)); assert.ok(!('capReached' in e));
    assert.ok(e.perSeat.every(s => !('capSpendUsd' in s)));
  }
});

test('unknown prices use the routing estimate, free models cost zero, and the cap fires once', async () => {
  const scope = { session: 'meeting-estimate-cap', kind: 'meeting', agent: 'sample' };
  const line = lineFor(scope, { provider: 'openai_compatible', model: 'unknown', usage: { inputTokens: 100, outputTokens: 20 } }, 'srv-test');
  const expected = budgetEstimate('openai_compatible', 'unknown', { inputTokens: 100, outputTokens: 20 }).usd;
  assert.equal(line.usd, undefined); assert.equal(sessionSpend(line), expected);
  let stops = 0;
  setSessionCap(scope.session, expected, 0, () => stops++);
  await metered(scope, async () => { reportUsage({ provider: 'openai_compatible', model: 'unknown', usage: { inputTokens: 100, outputTokens: 20 } }); });
  assert.equal(sessionCapView(scope.session).spentUsd, expected);
  assert.equal(sessionSignal(scope.session).aborted, true);
  assert.equal(stops, 1);
  assert.equal(recordSessionSpend(scope.session, line), false);
  assert.equal(stops, 1);
  const free = lineFor(scope, { provider: 'ollama', model: 'any-local', usage: { inputTokens: 100, outputTokens: 20 } }, 'srv-test');
  assert.equal(sessionSpend(free), 0);
  assert.equal(sessionSpend({ ...line, usd: 0 }), 0);
  clearSessionCap(scope.session);
});

test('a meeting capped on its opening call ends through the normal clean stop path', async t => {
  provider(t);
  const r = await start(0.001);
  assert.equal(meetings.has(r.meetingId), false);
  assert.equal(stoppedSessions.get(r.meetingId).by, 'spend cap');
  assert.equal(sessionCapView(r.meetingId).reached, true);
});

test('a meeting crossing its cap on a later call records a clean stopped result', async t => {
  const calls = provider(t), r = await start(0.004);
  assert.equal(meetings.has(r.meetingId), true);
  await continueMeeting(r.meetingId, 'one more');
  await stopCappedSession(r.meetingId);
  assert.equal(meetings.has(r.meetingId), false);
  assert.equal(stoppedSessions.get(r.meetingId).by, 'spend cap');
  assert.equal(calls.length, 2);
});

test('a collaboration crossing the cap cleanly stops after its opening contribution', async t => {
  const calls = provider(t);
  const r = await startCollaboration([sample, plain], 'agenda', { provider: 'openai_compatible', model: 'unknown-cap-model', baseUrl: base, maxUsd: 0.001 });
  assert.equal(collaborations.has(r.collaborationId), false);
  assert.equal(stoppedSessions.get(r.collaborationId).by, 'spend cap');
  assert.equal(calls.length, 1);
});

test('the live cap counts session kinds, rejects starts before calls, and ignores casting dry runs', async t => {
  env(t, 'ROUNDTABLE_MAX_LIVE_SESSIONS', '1');
  const calls = provider(t), first = await start(undefined);
  t.after(async () => { if (meetings.has(first.meetingId)) await endMeeting(first.meetingId, false); });
  const fail = /Live session limit 1 reached \(ROUNDTABLE_MAX_LIVE_SESSIONS\)/;
  for (const action of [() => start(undefined),
    () => startCollaboration([sample, plain], 'topic', {}),
    () => startLocalMeeting(sample, 'topic'),
    () => startUltraplan([sample], 'task'),
    () => runDuel(opts, observer(), signal(), deps),
    () => runCastingCall({ brief: 'a cast', agents: [sample, plain] }, observer(), signal()),
  ]) await assert.rejects(action(), fail);
  assert.equal(calls.length, 1);
  const cast = await runCastingCall({ brief: 'a cast', agents: [sample, plain], dryRun: true }, observer(), signal());
  assert.equal(cast.dryRun, true);
  for (const value of [undefined, 'bad-private-value', '0', '-2', '1.5', 'Infinity']) assert.equal(liveSessionLimit({ ROUNDTABLE_MAX_LIVE_SESSIONS: value }), 4);
  assert.equal(liveSessionLimit({ ROUNDTABLE_MAX_LIVE_SESSIONS: '12' }), 12);
});

test('overlapping openings reserve room before their live maps exist', async t => {
  env(t, 'ROUNDTABLE_MAX_LIVE_SESSIONS', '1');
  let entered, release;
  const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  provider(t, async () => { entered(); await gate; });
  const opening = start(undefined);
  await ready;
  await assert.rejects(start(undefined), /Live session limit 1/);
  release();
  const r = await opening;
  await endMeeting(r.meetingId, false);
});

test('terminal cap stops print cumulative spend and the higher-cap resume command', () => {
  let text = '';
  const out = createTerminalObserver({ output: { write(s) { text += s; } } });
  out.onEvent({ type: 'start', id: 'duel-cap', topic: 'policy', seats: [], mode: 'duel', startedAt: new Date().toISOString() });
  out.onEvent({ type: 'usage', perSeat: [], totalCostUsd: 0.1, capUsd: 0.1, spentUsd: 0.12, capReached: true });
  out.onEvent({ type: 'control', action: 'stopped', by: 'tool', reason: 'spend cap', ts: new Date().toISOString() });
  assert.match(text, /spent \$0\.1200 of \$0\.1 cap/);
  assert.match(text, /Stopped by spend cap/);
  assert.match(text, /roundtable duel --resume duel-cap --max-usd/);
});

test('caps apply with an outer sink while preserving its accounting and nesting once', async () => {
  const scope = { session: 'meeting-outer-cap', kind: 'meeting', agent: 'sample' };
  let count = 0, stops = 0;
  setSessionCap(scope.session, 0.001, 0, () => stops++);
  await withUsageSink(() => count++, () => metered(scope, () => metered(scope, async () => {
    reportUsage({ provider: 'openai_compatible', model: 'unknown', usage: { inputTokens: 100, outputTokens: 20 } });
  })));
  assert.equal(count, 1); assert.equal(stops, 1);
  assert.equal(sessionCapView(scope.session).spentUsd, 0.003);
  clearSessionCap(scope.session);
});

test('a known priced provider call reaches the cap with its priced cost', async t => {
  provider(t);
  const obs = observer();
  const result = await runDuel({ ...opts, maxUsd: 1e-8 }, obs, signal(), {
    resolveSeats: () => seats.map(s => ({ ...s, model: 'claude-sonnet-5-5' })),
  });
  assert.equal(result.resumable, true);
  const usage = obs.events.filter(e => e.type === 'usage').at(-1);
  assert.ok(usage.totalCostUsd > 0);
  assert.equal(usage.totalCostUsd, usage.spentUsd);
});

test('casting reports the spend cap and archives the stopped roster', async t => {
  provider(t);
  const obs = observer();
  const report = await runCastingCall({ brief: 'a cast', agents: [sample, plain], provider: 'openai_compatible', model: 'unknown-cap-model', maxUsd: 0.001 }, obs, signal());
  assert.equal(report.usage.capReached, true);
  assert.match(report.note, /Stopped by spend cap/);
  assert.ok(report.usage.spentUsd >= 0.001);
  assert.equal(obs.events.at(-1).aborted, true);
  assert.ok(!liveDuels().some(d => d.id === report.id));
});

test('ultraplan stops cleanly when its input phase reaches the cap', async t => {
  provider(t);
  const r = await startUltraplan([sample], 'a plan', { provider: 'openai_compatible', model: 'unknown-cap-model', baseUrl: base, maxUsd: 0.001 });
  await stopCappedSession(r.ultraplanId);
  assert.equal(stoppedSessions.get(r.ultraplanId).by, 'spend cap');
  assert.ok(!liveSessions().some(s => s.id === r.ultraplanId));
});

test('all matching MCP start schemas advertise a positive cap and refuse invalid values without echoing them', async () => {
  const { tools, handleToolCall } = await import('../../dist/tools.js');
  for (const name of ['start_duel', 'casting_call', 'start_meeting', 'start_local_meeting', 'start_collaboration', 'start_ultraplan']) {
    const tool = tools.find(t => t.name === name);
    assert.equal(tool.inputSchema.properties.max_usd.type, 'number');
    assert.equal(tool.inputSchema.properties.max_usd.exclusiveMinimum, 0);
    const args = name === 'start_duel' ? { topic: 'topic', team_a: ['a'], team_b: ['b'], judges: ['j'] }
      : name === 'casting_call' ? { brief: 'brief' }
      : name === 'start_meeting' || name === 'start_local_meeting' ? { agent: sample, agenda: 'agenda' }
      : name === 'start_collaboration' ? { agents: [sample, plain], topic: 'topic' } : { agents: [sample], task: 'task' };
    for (const value of [0, -1, Infinity, 'private-cap-value']) {
      const r = await handleToolCall(name, { ...args, max_usd: value });
      assert.equal(r.isError, true);
      assert.ok(!r.content[0].text.includes('private-cap-value'));
      assert.match(r.content[0].text, /max_usd/);
    }
  }
});

test('discussion CLI verbs exit 1 with a clear spend cap footer', async t => {
  provider(t);
  const { runTableCli } = await import('../../dist/cli-table.js');
  for (const command of ['debate', 'waffle', 'meeting']) {
    let text = '', error = '';
    const code = await runTableCli(command, ['topic', '--agents', `${sample},${plain}`, '--seat', `${sample}=openai_compatible:unknown-cap-model,${plain}=openai_compatible:unknown-cap-model`, '--no-preflight', '--max-usd', '0.001'], {
      output: { write(s) { text += s; } }, error: { write(s) { error += s; } },
    });
    assert.equal(code, 1, error);
    assert.match(text, /spent \$[0-9.]+ of \$0\.001 cap/);
    assert.match(text, /stopped by spend cap/);
  }
});

test('a stopped duel resume also observes live capacity, while replay stays offline', async t => {
  provider(t);
  const r = await runDuel({ ...opts, maxUsd: 0.001 }, observer(), signal(), deps);
  env(t, 'ROUNDTABLE_MAX_LIVE_SESSIONS', '1');
  const id = 'cast-capacity-fixture';
  registerDuel({ id, kind: 'casting', agents: ['sample'], started: new Date().toISOString() });
  t.after(() => unregisterDuel(id));
  await assert.rejects(runDuel({ resume: r.id, maxUsd: 1 }, observer(), signal(), deps), /Live session limit 1/);
  const { runTableCli } = await import('../../dist/cli-table.js');
  const code = await runTableCli('duel', ['--dry-run', '--speed', '1000000000', '--no-room'], { output: { write() {} }, error: { write() {} } });
  assert.equal(code, 0);
});

test('casting CLI parses and validates --max-usd without a dollar ceiling', async () => {
  const { parseCastArgs } = await import('../../dist/cli-cast.js');
  assert.equal(parseCastArgs(['a brief', '--max-usd', '5000']).options.maxUsd, 5000);
  for (const value of ['0', '-1', 'NaN', 'Infinity', 'private-cap-value']) {
    assert.throws(() => parseCastArgs(['a brief', '--max-usd', value]), /positive finite number/);
  }
});

test('MCP start handlers pass positive spend caps into meeting, collaboration and duel sessions', async t => {
  provider(t);
  const { handleToolCall } = await import('../../dist/tools.js');
  const llm = { provider: 'openai_compatible', model: 'unknown-cap-model', max_usd: 0.001 };
  const meeting = await handleToolCall('start_meeting', { agent: sample, agenda: 'agenda', ...llm });
  assert.ok(!meeting.isError, meeting.content[0].text);
  assert.equal(stoppedSessions.get(JSON.parse(meeting.content[0].text).meetingId).by, 'spend cap');
  const collab = await handleToolCall('start_collaboration', { agents: [sample, plain], topic: 'topic', ...llm });
  assert.ok(!collab.isError, collab.content[0].text);
  assert.equal(stoppedSessions.get(JSON.parse(collab.content[0].text).collaborationId).by, 'spend cap');
  const judge = fileURLToPath(new URL('../fixtures/ultraplan/cfo.md', import.meta.url));
  const duel = await handleToolCall('start_duel', { topic: 'policy', team_a: [sample], team_b: [plain], judges: [judge], kind: 'text', page_check: false, ...llm });
  assert.ok(!duel.isError, duel.content[0].text);
  const result = JSON.parse(duel.content[0].text);
  assert.equal(result.resumable, true);
  assert.equal(result.usage.max_usd, 0.001);
  assert.ok(result.usage.spent_usd >= 0.001);
});
