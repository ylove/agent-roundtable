import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSeats, availableProviders, preflightSeats, prepareSeats, assertSeatCredentials } from '../../dist/table/seats.js';
import { DEFAULT_MODELS, resolveAnthropicModel } from '../../dist/config.js';
import { stubFetch, json } from './helpers.mjs';
const metadata = { designer: { provider: 'openai', model: 'fixture-model' }, builder: {} };
const load = async id => ({ frontmatter: metadata[id] ?? {} });
const env = { ANTHROPIC_API_KEY: 'fixture-key', OPENAI_API_KEY: 'fixture-key', TOGETHER_API_KEY: 'fixture-key' };
test('seat > mix > frontmatter > default, and model aliases are current', async () => {
  const base = { agents: ['designer', 'builder'], load, env };
  const plain = await resolveSeats(base);
  assert.equal(plain.get('designer').provider, 'openai');
  assert.equal(plain.get('designer').model, 'fixture-model');
  assert.equal(plain.get('builder').provider, 'anthropic');
  assert.equal(plain.get('builder').model, DEFAULT_MODELS.anthropic);
  assert.equal(DEFAULT_MODELS.anthropic, 'claude-sonnet-5-5');
  assert.equal(resolveAnthropicModel('opus'), 'claude-opus-5-5');
  assert.equal(resolveAnthropicModel('haiku'), 'claude-haiku-5-5');
  const mixed = await resolveSeats({ ...base, mix: 'cheap' });
  assert.equal(mixed.get('designer').provider, 'anthropic');
  assert.equal(mixed.get('designer').model, 'claude-sonnet-5-5');
  const explicit = await resolveSeats({ ...base, mix: 'auto', seat: 'designer=together=bad' }).catch(e => e);
  assert.equal(explicit.exitCode, 2);
  const overridden = await resolveSeats({ ...base, mix: 'auto', seat: 'designer=together:fixture:model/version,builder=anthropic:sonnet' });
  assert.equal(overridden.get('designer').model, 'fixture:model/version');
  assert.equal(overridden.get('builder').model, 'claude-sonnet-5-5');
});
test('mix gives the teams different first providers, even with two agents per team', async () => {
  for (const mix of ['auto', 'cheap']) {
    const seats = await resolveSeats({ teamA: ['designer', 'builder'], teamB: ['marketer', 'skeptic'], judges: ['cfo'], load, env, mix });
    assert.equal(seats.get('designer').team, 'A'); assert.equal(seats.get('marketer').team, 'B');
    assert.notEqual(seats.get('designer').provider, seats.get('marketer').provider);
    assert.equal(seats.get('builder').provider, 'openai');
    assert.equal(seats.get('cfo').provider, 'together');
  }
  assert.deepEqual(availableProviders({}), []);
  assert.deepEqual(availableProviders({ OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1234/v1' }), ['openai_compatible']);
  assert.deepEqual(availableProviders({ OLLAMA_URL: 'http://127.0.0.1:11434' }), ['ollama']);
});
test('only frontmatter keys actually present affect defaults, and provider changes choose the matching model', async () => {
  const seats = await resolveSeats({ agents: ['designer'], load: async () => ({ frontmatter: { provider: 'together' } }), provider: 'openai', model: 'fixture-model' });
  assert.equal(seats.get('designer').model, DEFAULT_MODELS.together);
  for (const frontmatter of [{ provider: '' }]) await assert.rejects(resolveSeats({ agents: ['designer'], load: async () => ({ frontmatter }) }), /seat|Seat/);
});
test('invalid overrides, duplicate seats, empty mix and missing credentials fail before calls', async () => {
  for (const options of [{ seat: 'designer=unknown:model' }, { seat: 'designer=openai:' }, { seat: 'designer' }, { seat: 'designer=openai,designer=together' }, { seat: 'skeptic=openai' }, { seats: { designer: null } }, { mix: 'auto', env: {} }]) await assert.rejects(resolveSeats({ agents: ['designer'], load, ...options }), e => e.exitCode === 2);
  await assert.rejects(resolveSeats({ agents: ['designer', 'designer'], load }), /unique seat/);
  assert.throws(() => assertSeatCredentials([{ id: 'designer', provider: 'anthropic' }], {}), e => e.exitCode === 2);
});
test('custom agents directory supports metadata and refuses escaping symlinks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'table-seats-')); t.after(() => rmSync(root, { force: true, recursive: true }));
  const dir = join(root, 'agents'); mkdirSync(dir);
  writeFileSync(join(dir, 'designer.md'), '---\nprovider: openai\nmodel: fixture-model\n---\nYou are a designer.');
  const seats = await resolveSeats({ agents: ['designer'], agentsDir: dir });
  assert.equal(seats.get('designer').model, 'fixture-model');
  writeFileSync(join(root, 'outside.md'), 'outside'); symlinkSync(join(root, 'outside.md'), join(dir, 'skeptic.md'));
  await assert.rejects(resolveSeats({ agents: ['skeptic'], agentsDir: dir }), /not found/);
});
test('preflight calls each distinct provider/model once and uses cancellation', async t => {
  const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: 'OK' } }] }));
  await preflightSeats([{ id: 'designer', provider: 'openai', model: 'fixture-model' }, { id: 'builder', provider: 'openai', model: 'fixture-model' }, { id: 'cfo', provider: 'openai', model: 'fixture-other' }]);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.signal));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(preflightSeats([{ id: 'designer', provider: 'openai', model: 'fixture-model' }], aborted.signal), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});
function providerEnvironment(t) {
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TOGETHER_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_COMPATIBLE_BASE_URL', 'OLLAMA_URL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const probeReply = url => url.includes('/messages')
  ? json(401, { error: { message: 'do-not-print-this' } })
  : json(200, { choices: [{ message: { content: 'OK' } }] });
test('preflight reports every distinct pair after an auth failure without leaking remote text', async t => {
  providerEnvironment(t);
  const calls = stubFetch(t, url => probeReply(url));
  const reports = [];
  const results = await preflightSeats([
    { id: 'designer', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'builder', provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'cfo', provider: 'openai', model: 'fixture-model' },
  ], undefined, result => reports.push(result));
  assert.equal(calls.length, 2);
  assert.deepEqual(results.map(r => [r.provider, r.ok, r.reason]), [['anthropic', false, 'auth failed'], ['openai', true, undefined]]);
  assert.deepEqual(reports, results);
  assert.doesNotMatch(JSON.stringify(results), /do-not-print-this|fixture-key/);
});
test('automatic mix preflight excludes a 401 provider and redistributes both teams', async t => {
  providerEnvironment(t);
  const calls = stubFetch(t, url => probeReply(url));
  for (const mix of ['auto', 'cheap']) {
    const messages = [];
    const offset = calls.length;
    const seats = await prepareSeats({ teamA: ['designer', 'builder'], teamB: ['marketer', 'skeptic'], judges: ['cfo'], load, mix }, { report: message => messages.push(message) });
    assert.ok([...seats.values()].every(s => s.provider !== 'anthropic'));
    assert.notEqual(seats.get('designer').provider, seats.get('marketer').provider);
    assert.equal(calls.length - offset, 3);
    assert.ok(messages.includes('anthropic: auth failed, excluded from mix'));
    assert.ok(messages.some(m => /^openai\/.*: pass$/.test(m)));
    assert.doesNotMatch(messages.join('\n'), /do-not-print-this|fixture-key/);
  }
});
test('explicit seat on a 401 provider refuses fallback and identifies seat and provider', async t => {
  providerEnvironment(t);
  stubFetch(t, url => probeReply(url));
  await assert.rejects(prepareSeats({ agents: ['designer', 'skeptic'], load, mix: 'auto', seat: 'designer=anthropic:sonnet' }), e => e.exitCode === 2 && /Seat designer \(anthropic\): preflight auth failed/.test(e.message));
});
test('mix refuses to run when every configured provider fails preflight', async t => {
  providerEnvironment(t);
  stubFetch(t, () => json(401, { error: { message: 'do-not-print-this' } }));
  await assert.rejects(prepareSeats({ agents: ['designer', 'skeptic'], load, mix: 'auto' }), e => e.exitCode === 2 && /preflight/.test(e.message));
});

test('model inherit, empty, or a Claude name on another provider falls back to the provider default', async () => {
  const resolve = (frontmatter, extra = {}) => resolveSeats({ agents: ['designer'], load: async () => ({ frontmatter }), ...extra }).then(m => m.get('designer'));
  assert.equal((await resolve({ model: 'inherit' })).model, DEFAULT_MODELS.anthropic);
  assert.equal((await resolve({ model: '' })).model, DEFAULT_MODELS.anthropic);
  assert.equal((await resolve({ model: null })).model, DEFAULT_MODELS.anthropic);
  assert.equal((await resolve({ provider: 'openai', model: 'opus' })).model, DEFAULT_MODELS.openai);
  assert.equal((await resolve({ provider: 'openai', model: 'claude-sonnet-5-5' })).model, DEFAULT_MODELS.openai);
  assert.equal((await resolve({ provider: 'openai', model: 'fixture-model' })).model, 'fixture-model');
  assert.equal((await resolve({ model: 'sonnet' })).model, DEFAULT_MODELS.anthropic);
});
