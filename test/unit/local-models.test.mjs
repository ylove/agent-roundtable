import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderHealthCache, providerHealth, availableProviders, endpointFingerprint, trustedRoutingEndpoint, HEALTH_TTL_MS, TRANSIENT_HEALTH_TTL_MS } from '../../dist/providers/health.js';
import { DEFAULT_OLLAMA_URL, parseParameterSize, modelIdSize, ollamaModel } from '../../dist/providers/local-models.js';
import { routeProvider, budgetEstimate } from '../../dist/providers/router.js';
import { prepareSeats } from '../../dist/table/seats.js';
import { executionLLM, prepareExecutionProvider } from '../../dist/execution/provider-routing.js';
import { estimateUsd, isFreeProvider } from '../../dist/execution/pricing.js';
import { UsageMeter } from '../../dist/execution/escalation.js';
import { lineFor, metered } from '../../dist/usage/session-scope.js';
import { sessionSpend } from '../../dist/usage/session-caps.js';
import { parseLine } from '../../dist/usage/table.js';
import { ollamaDiscoveryEnabled } from '../../dist/config.js';
import { chatCompletion } from '../../dist/providers/index.js';
import { withUsageSink } from '../../dist/providers/usage.js';
import { stubFetch, json } from './helpers.mjs';

const keys = ['OLLAMA_URL', 'ROUNDTABLE_OLLAMA_DISCOVERY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TOGETHER_API_KEY', 'REPLICATE_API_TOKEN', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_API_KEY', 'ROUNDTABLE_OPENAI_COMPATIBLE_FREE', 'ROUNDTABLE_EXECUTION_PROVIDER', 'ROUNDTABLE_EXECUTION_MODEL', 'ROUNDTABLE_EXECUTION_BASE_URL'];
let saved;
beforeEach(t => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  providerHealth.clear();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected HTTP request'); });
});
afterEach(() => {
  providerHealth.clear();
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
});
const tags = (parameters = '14.8B') => ({ models: [{ name: 'qwen3:14b', details: { parameter_size: parameters } }] });
const empty = async () => ({ frontmatter: {} });
const routing = extra => ({ env: {}, config: {}, history: [], ...extra });
const reply = () => json(200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });

test('default discovery enables pure routing without an OLLAMA_URL and shares concurrent probes', async t => {
  const cache = new ProviderHealthCache();
  const calls = stubFetch(t, () => json(200, tags()));
  assert.deepEqual(availableProviders({}), []);
  const [ollama, again] = await Promise.all([cache.discoverOllama({}), cache.discoverOllama({})]);
  assert.equal(ollama, again);
  assert.deepEqual(availableProviders({}, ollama), ['ollama']);
  assert.equal(routeProvider(routing({ ollama, tier: 'judge' })).provider, 'ollama');
  assert.equal(trustedRoutingEndpoint('ollama', {}), true);
  assert.equal(endpointFingerprint('ollama', {}), endpointFingerprint('ollama', { OLLAMA_URL: DEFAULT_OLLAMA_URL }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_OLLAMA_URL}/api/tags`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('negative discovery is cached, expires at the transient TTL, and leaves routing ineligible', async t => {
  let now = 1000;
  const cache = new ProviderHealthCache(() => now);
  const calls = stubFetch(t, () => { throw new Error('connection refused'); });
  const ollama = await cache.discoverOllama({});
  assert.equal(ollama.reachable, false);
  assert.deepEqual(availableProviders({}, ollama), []);
  assert.throws(() => routeProvider(routing({ ollama })), /No healthy provider/);
  now += TRANSIENT_HEALTH_TTL_MS - 1;
  assert.equal(await cache.discoverOllama({}), ollama);
  assert.equal(calls.length, 1);
  now++;
  await cache.discoverOllama({});
  assert.equal(calls.length, 2);
  // Explicit configuration remains eligible even when discovery failed.
  assert.deepEqual(availableProviders({ OLLAMA_URL: DEFAULT_OLLAMA_URL }, ollama), ['ollama']);
});

test('discovery off values skip probing and keep only explicit Ollama URLs eligible', async t => {
  const cache = new ProviderHealthCache();
  const calls = stubFetch(t, () => json(200, tags()));
  const reachable = { reachable: true, models: [] };
  for (const value of ['off', 'OFF', ' false ', '0', 'No']) {
    const env = { ROUNDTABLE_OLLAMA_DISCOVERY: value };
    assert.equal(ollamaDiscoveryEnabled(env), false);
    assert.equal((await cache.discoverOllama(env)).reachable, false);
    assert.deepEqual(availableProviders(env, reachable), []);
    assert.throws(() => routeProvider(routing({ env, ollama: reachable })), /No healthy provider/);
  }
  assert.equal(calls.length, 0);
  for (const value of [undefined, '', '1', 'true', 'yes', 'on']) {
    assert.equal(ollamaDiscoveryEnabled({ ROUNDTABLE_OLLAMA_DISCOVERY: value }), true);
  }
  const env = { ROUNDTABLE_OLLAMA_DISCOVERY: 'off', OLLAMA_URL: DEFAULT_OLLAMA_URL };
  const ollama = await cache.discoverOllama(env);
  assert.equal(ollama.reachable, true);
  assert.deepEqual(availableProviders(env, ollama), ['ollama']);
  assert.equal(routeProvider(routing({ env, ollama, tier: 'judge' })).provider, 'ollama');
  assert.equal(calls.length, 1);
});

test('turning discovery off ignores cached tags in seat and execution preparation', async t => {
  const calls = stubFetch(t, url => url.endsWith('/api/tags') ? json(200, tags()) : reply());
  const ollama = await providerHealth.discoverOllama({});
  process.env.ROUNDTABLE_OLLAMA_DISCOVERY = ' off ';
  process.env.OPENAI_API_KEY = 'fixture';
  assert.equal(providerHealth.getOllama(), undefined);
  const opts = { agents: ['a'], load: empty, routing: { config: {}, history: [] } };
  assert.equal((await prepareSeats(opts)).get('a').provider, 'openai');
  // Even a previously supplied discovery result cannot bypass the operator's switch.
  assert.equal((await prepareSeats({ ...opts, routing: { ...opts.routing, ollama } })).get('a').provider, 'openai');
  assert.equal((await prepareExecutionProvider(routing({ env: process.env }))).provider, 'openai');
  assert.equal(executionLLM(routing({ env: process.env, ollama })).provider, 'openai');
  assert.equal(calls.filter(c => c.url.endsWith('/api/tags')).length, 1);
});

test('successful tags and size data use the health TTL and are scoped to the endpoint', async t => {
  let now = 1000;
  const cache = new ProviderHealthCache(() => now);
  const calls = stubFetch(t, () => json(200, tags('70.6B')));
  const first = await cache.discoverOllama({});
  assert.deepEqual(ollamaModel(first, 'qwen3:14b'), { name: 'qwen3:14b', size: 'large', parameters: '70.6B' });
  now += HEALTH_TTL_MS - 1;
  assert.equal(await cache.discoverOllama({}), first);
  await cache.discoverOllama({ OLLAMA_URL: 'http://127.0.0.1:11435' });
  assert.equal(calls.length, 2);
  now++;
  await cache.discoverOllama({});
  assert.equal(calls.length, 3);
});

test('explicit Ollama URLs retain discovery on LAN servers and the routing trust boundary', async t => {
  const env = { OLLAMA_URL: 'http://192.168.1.50:11434' };
  const calls = stubFetch(t, () => json(200, tags()));
  const ollama = await providerHealth.discoverOllama(env);
  assert.equal(ollama.reachable, true);
  assert.equal(calls[0].url, `${env.OLLAMA_URL}/api/tags`);
  assert.deepEqual(availableProviders(env), ['ollama']);
  assert.throws(() => routeProvider(routing({ env, ollama })), /untrusted base URL/);
  const pinned = await prepareSeats({ agents: ['a'], provider: 'ollama', env, load: empty, routing: { config: {}, history: [], ollama } }, { preflight: false });
  assert.equal(pinned.get('a').provider, 'ollama');
});

test('discovery times out and caches the timeout; redirects and malformed tags are unavailable', async t => {
  const cache = new ProviderHealthCache();
  const calls = stubFetch(t, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  assert.equal((await cache.discoverOllama({}, 5)).reachable, false);
  assert.equal((await cache.discoverOllama({}, 5)).reachable, false);
  assert.equal(calls.length, 1);
  for (const response of [new Response('', { status: 302 }), json(500, {}), json(200, {}), new Response('not JSON')]) {
    cache.clear();
    stubFetch(t, () => response);
    assert.equal((await cache.discoverOllama({})).reachable, false);
  }
});

test('Ollama parameter counts and compatible model ids classify total parameters', () => {
  for (const [value, size] of [['14.8B', 'small'], ['70.6B', 'large'], ['567M', 'small'], ['30B', 'large'], ['29.99B', 'small'], [undefined, 'unknown'], ['bad', 'unknown'], ['0B', 'unknown']]) {
    assert.equal(parseParameterSize(value).size, size, String(value));
  }
  for (const [id, size] of [['llama-3.1-8b-instruct', 'small'], ['qwen2.5-32b', 'large'], ['org/model_14.8B', 'small'], ['frontier', 'unknown'], ['model8b', 'unknown'], ['model-8bit', 'unknown'], ['model-8b2', 'unknown'], ['qwen3-235b-a22b', 'large']]) {
    assert.equal(modelIdSize(id).size, size, id);
  }
});

test('model lookup matches the exact name and normalises only bare names to latest', async t => {
  stubFetch(t, () => json(200, { models: [
    { name: 'qwen3:14b', details: { parameter_size: '14.8B' } },
    { name: 'qwen3:latest', details: { parameter_size: '70.6B' } },
    { name: 'other:14b' }, { name: 'registry:5000/org/model:latest' },
  ] }));
  const discovery = await providerHealth.discoverOllama({});
  assert.equal(ollamaModel(discovery, 'qwen3:14b').parameters, '14.8B');
  assert.equal(ollamaModel(discovery, 'qwen3').parameters, '70.6B');
  assert.equal(ollamaModel(discovery, 'qwen3:8b'), undefined);
  assert.equal(ollamaModel(discovery, 'qwen'), undefined);
  assert.equal(ollamaModel(discovery, 'other:14b').size, 'unknown');
  assert.equal(ollamaModel(discovery, 'registry:5000/org/model').name, 'registry:5000/org/model:latest');
});

test('seat preparation discovers once and the native preflight reuses its tags', async t => {
  const calls = stubFetch(t, url => url.endsWith('/api/tags') ? json(200, tags()) : json(200, { message: { content: 'OK' } }));
  const opts = { agents: ['a'], load: empty, env: {}, routing: { config: {}, history: [] }, tier: 'judge' };
  assert.equal((await prepareSeats(opts)).get('a').provider, 'ollama');
  assert.equal((await prepareSeats(opts)).get('a').provider, 'ollama');
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/api/tags', '/api/chat']);
});

test('absent default Ollama is probed once across repeated preparations', async t => {
  process.env.OPENAI_API_KEY = 'fixture';
  const calls = stubFetch(t, url => {
    if (url.endsWith('/api/tags')) throw new Error('not installed');
    return reply();
  });
  const opts = { agents: ['a'], load: empty, routing: { config: {}, history: [] } };
  for (let i = 0; i < 2; i++) assert.equal((await prepareSeats(opts)).get('a').provider, 'openai');
  assert.equal(calls.filter(c => c.url.endsWith('/api/tags')).length, 1);
});

test('execution preparation discovers a small model but selects a healthy hosted model', async t => {
  process.env.OPENAI_API_KEY = 'fixture';
  const calls = stubFetch(t, url => url.endsWith('/api/tags') ? json(200, tags()) : reply());
  const choice = await prepareExecutionProvider(routing({ env: process.env }));
  assert.equal(choice.provider, 'openai');
  assert.match(choice.reason, /small local model, 14\.8B/);
  assert.equal(executionLLM(routing({ env: process.env })).provider, 'openai');
  assert.equal(calls.filter(c => c.url.endsWith('/api/tags')).length, 1);
});

test('explicit seats, persona pins and the explicit execution provider keep small models', async t => {
  const ollama = { reachable: true, models: [{ name: 'qwen3:14b', size: 'small', parameters: '14.8B' }] };
  const opts = { agents: ['a'], load: empty, env: { OPENAI_API_KEY: 'fixture' }, routing: { config: {}, history: [], ollama }, tier: 'judge' };
  const explicit = await prepareSeats({ ...opts, seats: { a: { provider: 'ollama', model: 'qwen3:14b' } } }, { preflight: false });
  assert.equal(explicit.get('a').provider, 'ollama');
  const persona = await prepareSeats({ ...opts, load: async () => ({ frontmatter: { provider: 'ollama', model: 'qwen3:14b' } }) }, { preflight: false });
  assert.equal(persona.get('a').provider, 'ollama');
  assert.equal(persona.get('a').model, 'qwen3:14b');
  process.env.ROUNDTABLE_EXECUTION_PROVIDER = 'ollama';
  process.env.ROUNDTABLE_EXECUTION_MODEL = 'qwen3:14b';
  assert.equal(executionLLM(routing({ env: opts.env, ollama })).provider, 'ollama');
  assert.equal((await prepareExecutionProvider(routing({ env: opts.env, ollama }))).provider, 'ollama');
});

test('--mix cheap seats and balanced spread use discovered small local models freely', async () => {
  const ollama = { reachable: true, models: [{ name: 'qwen3:14b', size: 'small', parameters: '14.8B' }] };
  const opts = { agents: ['a'], load: empty, env: { OPENAI_API_KEY: 'fixture' }, routing: { config: {}, history: [], ollama } };
  const cheap = await prepareSeats({ ...opts, tier: 'judge', mix: 'cheap' }, { preflight: false });
  assert.equal(cheap.get('a').provider, 'ollama');
  const balanced = await prepareSeats({ ...opts, agents: ['a', 'b'], tier: 'balanced' }, { preflight: false });
  assert.deepEqual([...balanced.values()].map(s => s.provider), ['openai', 'ollama']);
});

test('compatible free pricing is opt-in, endpoint-bound, and excludes every per-call URL', () => {
  const tokens = { inputTokens: 1000, outputTokens: 100 };
  const env = { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:1234/v1', ROUNDTABLE_OPENAI_COMPATIBLE_FREE: '1' };
  const opts = { provider: 'openai_compatible', env };
  assert.deepEqual(estimateUsd('house-model', tokens, opts), { usd: 0, estimated: false });
  assert.equal(isFreeProvider('openai_compatible', { env }), true);
  assert.equal(estimateUsd('house-model', tokens, { ...opts, endpoint: endpointFingerprint('openai_compatible', env) }).estimated, false);
  for (const extra of [{ baseUrl: env.OPENAI_COMPATIBLE_BASE_URL }, { baseUrl: 'http://localhost:5678/v1' }, { endpoint: 'other' }, { env: {} }, { env: { ...env, ROUNDTABLE_OPENAI_COMPATIBLE_FREE: '0' } }, { env: { OPENAI_COMPATIBLE_BASE_URL: env.OPENAI_COMPATIBLE_BASE_URL } }]) {
    assert.equal(estimateUsd('house-model', tokens, { ...opts, ...extra }).estimated, true, JSON.stringify(extra));
  }
  assert.deepEqual(estimateUsd('claude-sonnet-5-5', tokens, { ...opts, baseUrl: env.OPENAI_COMPATIBLE_BASE_URL }), { usd: 0.003, estimated: false });
  assert.deepEqual(budgetEstimate('openai_compatible', 'house-model', tokens, undefined, { env }), { usd: 0, estimated: false });
});

test('actual compatible calls retain endpoint pricing through metering and session caps', async t => {
  process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:1234/v1';
  process.env.ROUNDTABLE_OPENAI_COMPATIBLE_FREE = '1';
  stubFetch(t, reply);
  const lines = [];
  const scope = { session: 'local-price', kind: 'meeting', agent: 'a' };
  const call = baseUrl => withUsageSink(r => lines.push(lineFor(scope, r, 'srv-00000000')), () =>
    chatCompletion([{ role: 'user', content: 'hi' }], { provider: 'openai_compatible', model: 'house-model', ...(baseUrl && { baseUrl }) }));
  await call();
  await call(process.env.OPENAI_COMPATIBLE_BASE_URL);
  await call('http://localhost:5678/v1');
  assert.equal(lines[0].usd, 0);
  assert.equal(sessionSpend(lines[0]), 0);
  for (const line of lines.slice(1)) {
    assert.equal(line.usd, undefined);
    assert.ok(sessionSpend(line) > 0);
  }
  // Recomputed caps use only persisted ledger fields, including for the same configured URL.
  for (const [index, line] of lines.entries()) {
    const persisted = parseLine(JSON.parse(JSON.stringify(line)));
    assert.ok(persisted);
    assert.equal(sessionSpend(persisted), sessionSpend(line));
    if (index > 0) assert.ok(sessionSpend({ ...persisted, usd: 0.000000001, usd_prov: 'estimated' }) > 0.000000001);
  }
  assert.equal(lines[0].endpoint, lines[1].endpoint);
  // Old unpriced rows cannot become free just because the flag is enabled later.
  delete process.env.ROUNDTABLE_OPENAI_COMPATIBLE_FREE;
  await call();
  assert.equal(lines[3].usd, undefined);
  process.env.ROUNDTABLE_OPENAI_COMPATIBLE_FREE = '1';
  assert.ok(sessionSpend(lines[3]) > 0);
  assert.doesNotMatch(JSON.stringify(lines), /localhost|baseUrl/);
  // Nested session metering must keep the explicit endpoint for an outer execution meter.
  const meter = new UsageMeter('huddle', undefined, undefined, true);
  await meter.run(() => metered(scope, () => chatCompletion([{ role: 'user', content: 'hi' }], { provider: 'openai_compatible', model: 'house-model' })), { provider: 'openai_compatible', model: 'house-model', usd: 1 });
  assert.equal(meter.pendingUsd, 0);
  const paid = new UsageMeter('huddle', undefined, undefined, true);
  await paid.run(() => chatCompletion([{ role: 'user', content: 'hi' }], { provider: 'openai_compatible', model: 'house-model', baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL }), { provider: 'openai_compatible', model: 'house-model', baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL, usd: 1 });
  assert.ok(paid.pendingUsd > 0);
});
