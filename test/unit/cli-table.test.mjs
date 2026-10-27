import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseTableArgs, runTableCli } from '../../dist/cli-table.js';
import { providerHealth } from '../../dist/providers/health.js';
beforeEach(() => {
  providerHealth.clear();
  rmSync(join(process.env.ROUNDTABLE_HOME, 'usage'), { recursive: true, force: true });
});
import { stubFetch, json } from './helpers.mjs';
const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;
const originalKeys = Object.fromEntries(['OPENAI_API_KEY', 'TOGETHER_API_KEY', 'OPENAI_COMPATIBLE_BASE_URL', 'ROUNDTABLE_ENV_FILE', 'REPLICATE_API_TOKEN', 'ANTHROPIC_API_KEY', 'OLLAMA_URL'].map(k => [k, process.env[k]]));
before(() => {
  mkdirSync(agentsDir, { recursive: true });
  for (const id of ['designer', 'builder', 'marketer', 'skeptic', 'cfo']) writeFileSync(join(agentsDir, `${id}.md`), `You are a ${id}.\n`);
  delete process.env.REPLICATE_API_TOKEN; delete process.env.ANTHROPIC_API_KEY; delete process.env.OLLAMA_URL;
  process.env.OPENAI_API_KEY = 'fixture-key'; process.env.TOGETHER_API_KEY = 'fixture-key';
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';
});
after(() => { for (const [k, v] of Object.entries(originalKeys)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const roster = ['A budgeting game', '--team-a', 'designer,builder', '--team-b', 'marketer,skeptic', '--judges', 'cfo', '--mix', 'auto', '--no-preflight'];
function sink() { let text = ''; return { write(s) { text += s; }, read() { return text; } }; }
function io(modules) { return { output: sink(), error: sink(), modules }; }
const result = { id: 'duel-fixture', winner: 'tie', tally: { A: 1, B: 1 }, aborted: false };
function fixtureModules() {
  const state = { closed: 0, roomEvents: [], roomOptions: undefined, options: undefined, replayOptions: undefined };
  const emit = async (obs, options) => {
    await obs.onEvent({ type: 'start', id: result.id, topic: options.topic, mode: 'duel', seats: [], startedAt: '2026-01-01T00:00:00Z' });
    await obs.onEvent({ type: 'end', winner: result.winner, tally: result.tally });
    return result;
  };
  return { state, modules: {
    duel: async () => ({ runDuel: async (options, obs, signal) => { state.options = options; state.signal = signal; return emit(obs, options); } }),
    room: async () => ({ createRoom: async options => { state.roomOptions = options; return { onEvent: e => state.roomEvents.push(e), close: async () => { state.closed++; } }; } }),
    replay: async () => ({ replayDuel: async (options, obs) => { state.replayOptions = options; return emit(obs, { topic: 'synthetic replay' }); } }),
  } };
}
test('positional topic is removed before flags, numeric options have explicit units', () => {
  const parsed = parseTableArgs('duel', [...roster, '--rounds', '2', '--turn-timeout', '4', '--max-seconds', '10']);
  assert.equal(parsed.topic, 'A budgeting game'); assert.equal(parsed.options.turnTimeoutMs, 4000); assert.equal(parsed.options.rounds, 2);
  assert.equal(parsed.options.maxSeconds, 10);
});
test('invalid flags and incomplete rosters return usage errors', async () => {
  for (const args of [[], ['topic'], [...roster, '--rounds', '3'], [...roster, '--rounds', '1.5'], [...roster, '--mix', 'cheap'], [...roster, '--turn-timeout', '0'], [...roster, '--max-seconds', 'NaN'], [...roster, '--speed', '-1'], [...roster, '--seat', 'designer=openai', '--seat', 'builder=openai'], [...roster, '--open', '--no-room'], [...roster, '--unknown'], [...roster, '--agents-dir', 'relative'], ['--replay', 'fixture.json', '--dry-run']]) {
    const streams = io();
    assert.equal(await runTableCli('duel', args, streams), 2, JSON.stringify(args));
    assert.equal(streams.output.read(), ''); assert.match(streams.error.read(), /roundtable:/);
  }
});
test('duel resolves seats and fans identical NDJSON events into the room, then closes with no-hold', async () => {
  const { state, modules } = fixtureModules(), streams = io(modules);
  const code = await runTableCli('duel', [...roster, '--json', '--open', '--no-hold'], streams);
  assert.equal(code, 0, streams.error.read());
  const events = streams.output.read().trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.type), ['start', 'end']); assert.deepEqual(state.roomEvents, events);
  assert.equal(state.roomOptions.open, true); assert.equal(typeof state.roomOptions.controls.send, "function"); assert.equal(state.closed, 1);
  assert.equal(state.options.seats.designer.agent, 'designer');
  assert.notEqual(state.options.seats.designer.provider, state.options.seats.marketer.provider);
  assert.ok(state.signal instanceof AbortSignal);
});
test('replay and dry-run skip all seat loading, provider calls and credentials', async t => {
  const calls = stubFetch(t, () => { throw new Error('provider calls are forbidden'); });
  for (const args of [['--dry-run', '--speed', '3'], ['--replay', 'synthetic.json']]) {
    const { state, modules } = fixtureModules(); modules.duel = async () => { throw new Error('live runner is forbidden'); };
    const streams = io(modules);
    assert.equal(await runTableCli('duel', [...args, '--json', '--no-room', '--no-hold'], streams), 0);
    assert.equal(state.options, undefined); assert.equal(state.replayOptions.speed, args[0] === '--dry-run' ? 3 : 1);
    assert.equal(state.replayOptions.archivePath, args[0] === '--replay' ? 'synthetic.json' : undefined);
  }
  assert.equal(calls.length, 0);
});
test('missing keys return 2 and missing merge-time runner returns a clear build error', async () => {
  const streams = io();
  const code = await runTableCli('duel', [...roster.filter((_, i) => i < 7), '--seat', 'designer=replicate:fixture-model', '--no-room', '--no-preflight'], streams);
  assert.equal(code, 2); assert.match(streams.error.read(), /Missing REPLICATE_API_TOKEN/);
  const { modules } = fixtureModules(); modules.duel = async () => { throw new Error('duel not available in this build'); };
  const missing = io(modules);
  assert.equal(await runTableCli('duel', [...roster, '--no-room'], missing), 1);
  assert.match(missing.error.read(), /duel not available in this build/);
});
test('first Ctrl-C aborts the runner and removes the signal listener after cleanup', async () => {
  const { modules, state } = fixtureModules(); const previous = process.listenerCount('SIGINT');
  modules.duel = async () => ({ runDuel: async (_options, obs, signal) => {
    setImmediate(() => process.emit('SIGINT'));
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await obs.onEvent({ type: 'end', aborted: true, winner: 'none', tally: { A: 0, B: 0 } });
    return { ...result, aborted: true };
  } });
  const streams = io(modules);
  assert.equal(await runTableCli('duel', [...roster, '--json', '--no-hold'], streams), 1);
  assert.equal(state.closed, 1); assert.equal(process.listenerCount('SIGINT'), previous);
  assert.equal(JSON.parse(streams.output.read()).aborted, true);
});
test('completed room stays alive until Ctrl-C', async () => {
  const { modules, state } = fixtureModules();
  modules.duel = async () => ({ runDuel: async () => { setImmediate(() => process.emit('SIGINT')); return result; } });
  const streams = io(modules);
  assert.equal(await runTableCli('duel', roster, streams), 0);
  assert.equal(state.closed, 1); assert.match(streams.error.read(), /Room stays open/);
});
test('config output contains only setting names and set/unset status', async t => {
  const home = mkdtempSync(join(tmpdir(), 'table-cli-config-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.ROUNDTABLE_HOME; process.env.ROUNDTABLE_HOME = home;
  t.after(() => { process.env.ROUNDTABLE_HOME = oldHome; });
  const file = join(home, 'private.env'); writeFileSync(file, 'OPENAI_API_KEY=never-print-this\n');
  const streams = io();
  assert.equal(await runTableCli('config', ['set', 'env-file', file], streams), 0);
  assert.equal(await runTableCli('config', ['show'], streams), 0);
  assert.equal(streams.output.read(), 'env-file: set\nenv-file: set\nagents-dir: set\n');
  assert.doesNotMatch(streams.output.read() + streams.error.read(), /never-print-this|private.env/);
  assert.equal(await runTableCli('config', ['set', 'env-file', 'relative'], streams), 2);
});
test('debate, waffle and meeting stream their first turn and complete with per-seat calls', async t => {
  const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: 'A concise view.' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  for (const command of ['debate', 'waffle', 'meeting']) {
    const streams = io(); const offset = calls.length;
    const code = await runTableCli(command, ['A budget', '--agents', 'designer,skeptic', '--seat', 'designer=openai:fixture-model,skeptic=together:fixture-other', '--rounds', '1', '--json'], streams);
    assert.equal(code, 0, streams.error.read());
    const events = streams.output.read().trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].seats[0].id, 'designer');
    assert.equal(events[0].seats[0].reason, 'explicit provider/model');
    assert.equal(events[1].type, 'turn'); assert.equal(events[1].seat.id, 'designer');
    assert.equal(events.filter(e => e.type === 'turn').length, command === 'waffle' ? 3 : 2);
    assert.equal(events.at(-1).type, 'end'); assert.equal(events.at(-2).type, 'usage');
    assert.equal(calls[offset].body.model, 'fixture-model'); assert.equal(calls[offset + 1].body.model, 'fixture-other');
    assert.match(calls[offset + 1].url, /together/);
  }
});
test('MCP seats route opening, subsequent, summary and dissent calls to the assigned models', async t => {
  const { handleDeliberationTool, deliberationTools } = await import('../../dist/tools/deliberation.js');
  const { collaborations, endCollaboration, advanceCollaboration } = await import('../../dist/sessions/collaborations.js');
  const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: 'A concise view.' } }] }));
  assert.equal(deliberationTools.find(t => t.name === 'start_collaboration').inputSchema.properties.seats.type, 'object');
  const response = await handleDeliberationTool('start_collaboration', { agents: ['designer', 'skeptic'], topic: 'A budget', max_rounds: 1, mode: 'debate', seats: { designer: { provider: 'openai', model: 'fixture-model' }, skeptic: { provider: 'together', model: 'fixture-other' } } });
  const id = JSON.parse(response.content[0].text).collaborationId;
  await advanceCollaboration(collaborations.get(id)); await endCollaboration(id, true);
  assert.deepEqual(calls.map(c => c.body.model), ['fixture-model', 'fixture-other', 'fixture-model', 'fixture-other']);
});
test('discussion timeout cuts the active provider call, emits aborted end and archives prior turns', async t => {
  const { collaborations } = await import('../../dist/sessions/collaborations.js');
  const { listArchivedSessions } = await import('../../dist/sessions/archive.js');
  const calls = stubFetch(t, (_url, init, index) => index === 0
    ? json(200, { choices: [{ message: { content: 'A concise opening.' } }] })
    : new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true })));
  const streams = io();
  assert.equal(await runTableCli('meeting', ['Timed discussion', '--agents', 'designer,skeptic', '--seat', 'designer=openai:fixture-model,skeptic=openai:fixture-model', '--turn-timeout', '0.02', '--json', '--no-preflight'], streams), 1);
  assert.equal(calls.length, 2); assert.equal(calls[1].signal.aborted, true);
  const events = streams.output.read().trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).aborted, true);
  assert.ok(listArchivedSessions().some(s => s.topic === 'Timed discussion'));
  assert.equal([...collaborations.values()].some(c => c.topic === 'Timed discussion'), false);
});
test('caller already cancelled before the first collaboration call dispatches no request', async t => {
  const { startCollaboration, collaborations } = await import('../../dist/sessions/collaborations.js');
  const calls = stubFetch(t, () => { throw new Error('No dispatch expected.'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startCollaboration(['designer', 'skeptic'], 'Cancelled opening', { provider: 'openai', model: 'fixture-model', signal: controller.signal }));
  assert.equal(calls.length, 0);
  assert.equal([...collaborations.values()].some(c => c.topic === 'Cancelled opening'), false);
});
test('MCP refuses malformed per-seat assignments before dispatch, including with session defaults', async t => {
  const { handleDeliberationTool } = await import('../../dist/tools/deliberation.js');
  const calls = stubFetch(t, () => { throw new Error('No dispatch expected.'); });
  for (const spec of [null, { model: null }, { provider: 'constructor' }, { agent: 'skeptic' }, { model: '' }]) {
    await assert.rejects(handleDeliberationTool('start_collaboration', { agents: ['designer', 'skeptic'], topic: 'A budget', provider: 'openai', model: 'fixture-model', seats: { designer: spec } }), /Invalid seat/);
  }
  assert.equal(calls.length, 0);
});
test('binary dispatch handles config and table usage without loading a room or runner', t => {
  const home = mkdtempSync(join(tmpdir(), 'table-cli-binary-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, ROUNDTABLE_HOME: home, ROUNDTABLE_DOTENV: 'off' };
  const show = spawnSync(process.execPath, ['dist/index.js', 'config', 'show'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(show.status, 0, show.stderr);
  assert.equal(show.stdout, 'env-file: unset\nagents-dir: unset\n');
  const usage = spawnSync(process.execPath, ['dist/index.js', 'duel', 'A game', '--unknown'], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(usage.status, 2); assert.equal(usage.stdout, ''); assert.match(usage.stderr, /unknown argument/);
});
const automaticRoster = () => roster.filter(value => value !== '--no-preflight');
function deadKey(t) {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'invalid-fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; });
}
const preflightReply = url => url.includes('/messages')
  ? json(401, { error: { message: 'never-print-provider-body' } })
  : json(200, { choices: [{ message: { content: 'OK' } }] });
test('CLI mixes automatically preflight and exclude a 401 provider before calling the duel', async t => {
  deadKey(t);
  const calls = stubFetch(t, url => preflightReply(url));
  const { state, modules } = fixtureModules(), streams = io(modules);
  assert.equal(await runTableCli('duel', [...automaticRoster(), '--json', '--no-room'], streams), 0, streams.error.read());
  assert.ok(Object.values(state.options.seats).every(s => s.provider !== 'anthropic'));
  assert.notEqual(state.options.seats.designer.provider, state.options.seats.marketer.provider);
  assert.equal(calls.length, 4, 'the dead key plus each distinct surviving provider/model pair');
  assert.match(streams.error.read(), /anthropic: auth failed, excluded from routing/);
  assert.match(streams.error.read(), /openai\/.*: pass/);
  assert.deepEqual(streams.output.read().trim().split('\n').map(JSON.parse).map(e => e.type), ['start', 'end']);
  assert.doesNotMatch(streams.error.read() + streams.output.read(), /invalid-fixture-key|never-print-provider-body/);
});
test('explicit failing seats exit 2 with seat and provider, with or without mix', async t => {
  deadKey(t);
  stubFetch(t, url => preflightReply(url));
  for (const args of [automaticRoster(), [...roster.slice(0, 7), '--preflight']]) {
    const { state, modules } = fixtureModules(), streams = io(modules);
    assert.equal(await runTableCli('duel', [...args, '--seat', 'designer=anthropic:sonnet', '--no-room'], streams), 2);
    assert.match(streams.error.read(), /Seat designer \(anthropic\): preflight auth failed/);
    assert.equal(state.options, undefined);
    assert.equal(streams.output.read(), '');
    assert.doesNotMatch(streams.error.read(), /invalid-fixture-key|never-print-provider-body/);
  }
});
test('--no-preflight skips mix probes; contradictory preflight flags are refused', async t => {
  deadKey(t);
  const calls = stubFetch(t, () => { throw new Error('No provider calls expected.'); });
  const { modules, state } = fixtureModules(), streams = io(modules);
  assert.equal(await runTableCli('duel', [...roster, '--no-room'], streams), 0);
  assert.equal(calls.length, 0);
  assert.equal(state.options.seats.designer.provider, 'anthropic');
  assert.equal(await runTableCli('duel', [...roster, '--preflight'], streams), 2);
  assert.match(streams.error.read(), /Use either --preflight or --no-preflight/);
});
