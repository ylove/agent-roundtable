import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointFingerprint } from '../../dist/providers/health.js';
import { runnerHookContext, resolveHuddleLLM } from '../../dist/execution/escalation.js';
import { makeState } from '../fixtures/execution-state.mjs';
import { Runner } from '../../dist/execution/runner.js';
import { splitRoutingReason } from '../../dist/table/terminal.js';
import { appendTableLine, newServerId } from '../../dist/usage/table.js';
import { seedExecutionProvider } from '../../dist/execution/provider-routing.js';
import { routeProvider, routingModels, FAILURE_WINDOW_MS, modelFitsProvider, recentPerformance, recentRoutingHistory } from '../../dist/providers/router.js';
import { ProviderHealthCache, providerHealth, HEALTH_TTL_MS, TRANSIENT_HEALTH_TTL_MS, credentialFingerprint } from '../../dist/providers/health.js';
import { PROVIDER_MAX_TOKENS } from '../../dist/providers/limits.js';
import { resolveSeats, prepareSeats, preflightSeats } from '../../dist/table/seats.js';
import { callLLM } from '../../dist/providers/index.js';
import { DEFAULT_MODELS, PROVIDER_IDS, ROUNDTABLE_HOME } from '../../dist/config.js';
import { validateRoutingConfig, readUserConfig } from '../../dist/user-config.js';
import { createNdjsonObserver, createTerminalObserver } from '../../dist/table/terminal.js';
import { summarizeDuel } from '../../dist/tools/duel.js';
import { handleToolCall, tools } from '../../dist/tools.js';
import { executionLLM, prepareExecutionProvider } from '../../dist/execution/provider-routing.js';
import { executionHuddleLLM } from '../../dist/execution/escalation.js';
import { preflightExecutionProvider } from '../../dist/execution/orchestrator.js';
import { stubFetch, json } from './helpers.mjs';

const NOW = Date.UTC(2026, 9, 20, 12);
const env = { ANTHROPIC_API_KEY: 'fixture-a', OPENAI_API_KEY: 'fixture-b', TOGETHER_API_KEY: 'fixture-c', REPLICATE_API_TOKEN: 'fixture-d' };
const empty = async () => ({ frontmatter: {} });
const inputs = extra => ({ env, config: {}, history: [], health: new ProviderHealthCache(() => NOW), ...extra });
const rates = (input, output) => ({ input, output, cache_read: 0, cache_write: 0 });
const reply = text => json(200, { choices: [{ message: { content: text } }] });
const originalEnv = {};
const keys = [...Object.keys(env), 'OLLAMA_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_API_KEY', 'ROUNDTABLE_EXECUTION_PROVIDER', 'ROUNDTABLE_EXECUTION_MODEL', 'ROUNDTABLE_EXECUTION_BASE_URL', 'ROUNDTABLE_SKIP_EXECUTION_PREFLIGHT'];
beforeEach(t => {
  for (const key of keys) { originalEnv[key] = process.env[key]; delete process.env[key]; }
  providerHealth.clear();
  t.mock.method(Date, 'now', () => NOW);
});
afterEach(() => {
  providerHealth.clear();
  for (const key of keys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
});

function fixtureAgents() {
  mkdirSync(process.env.ROUNDTABLE_AGENTS_DIR, { recursive: true });
  for (const id of ['judgment-a', 'judgment-b', 'judgment-judge']) writeFileSync(join(process.env.ROUNDTABLE_AGENTS_DIR, `${id}.md`), `---\nname: ${id}\n---\nOffer a brief review.\n`);
}

test('dead auth is learned only from real calls; cached bad provider is excluded, even when pinned by a persona', async t => {
  Object.assign(process.env, env);
  const calls = stubFetch(t, url => url.includes('/messages') ? json(401, { error: { message: 'fixture-secret-must-not-appear' } }) : reply('OK'));
  const result = await preflightSeats([{ id: 'probe', name: 'probe', provider: 'anthropic', model: DEFAULT_MODELS.anthropic }]);
  assert.equal(result[0].reason, 'auth failed');
  const choice = routeProvider(inputs({ health: providerHealth, env: process.env }));
  assert.notEqual(choice.provider, 'anthropic');
  const seats = await resolveSeats({ agents: ['a'], env: process.env, routing: { config: {}, history: [] }, load: async () => ({ frontmatter: { provider: 'anthropic', model: 'sonnet' } }) });
  assert.notEqual(seats.get('a').provider, 'anthropic');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(choice.reason, /fixture-secret|fixture-a/);
});

test('automatic preparation retries another provider after a dead first key and preserves explicit pins', async t => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY });
  const calls = stubFetch(t, url => url.includes('/messages') ? json(401, { error: { message: 'bad key' } }) : reply('OK'));
  const seats = await prepareSeats({ agents: ['a'], load: empty, routing: { config: {}, history: [] } });
  assert.equal(seats.get('a').provider, 'openai');
  assert.match(seats.get('a').reason, /healthy/);
  assert.equal(calls.length, 2);
  await assert.rejects(prepareSeats({ agents: ['a'], provider: 'anthropic', load: empty }, { preflight: true }), /preflight auth failed/);
});

test('builds avoid reasoning models; shared output ceilings and strict overrides apply', () => {
  const choice = routeProvider(inputs({ tier: 'builder', env: { TOGETHER_API_KEY: 'fixture', REPLICATE_API_TOKEN: 'fixture' } }));
  assert.equal(choice.provider, 'replicate');
  assert.match(choice.reason, /together.*excluded for build \(reasoning model\)/);
  assert.equal(choice.maxOutputTokens, PROVIDER_MAX_TOKENS.replicate);
  assert.equal(routeProvider(inputs({ tier: 'builder', env: { TOGETHER_API_KEY: 'fixture' } })).provider, 'together');
  const config = validateRoutingConfig({ together: { builder: { model: 'fixture-builder', reasoning: false, maxOutputTokens: 2000 } } });
  assert.equal(routingModels('together', 'builder', config).maxOutputTokens, 2000);
  assert.equal(routingModels('together', 'builder', { together: { builder: { model: 'GLM-fixture', reasoning: false } } }).reasoning, true);
  assert.equal(routingModels('replicate', 'builder', { replicate: { builder: { model: 'fixture', maxOutputTokens: 999999 } } }).maxOutputTokens, PROVIDER_MAX_TOKENS.replicate);
});

test('recent 429 and timeout history demotes providers; only the last 50 calls count, with median latency', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ at: new Date(NOW - 1000).toISOString(), provider: 'anthropic', model: DEFAULT_MODELS.anthropic, outcome: i < 11 ? 'rate_limit' : 'ok', latency_ms: i }));
  assert.deepEqual(recentPerformance(history, 'anthropic', DEFAULT_MODELS.anthropic), { failures: 1, rate: 0.02, medianMs: 34.5 });
  assert.equal(routeProvider(inputs({ history })).provider, 'openai');
  const timeout = [{ at: new Date(NOW - 1000).toISOString(), provider: 'anthropic', model: DEFAULT_MODELS.anthropic, outcome: 'timeout', latency_ms: 3000 }];
  assert.equal(routeProvider(inputs({ history: timeout })).provider, 'openai');
  assert.deepEqual(routeProvider(inputs()), routeProvider(inputs()));
});

test('budget is a hard cap on known and estimated costs; unpriced providers stay eligible on an estimate', async () => {
  const pricing = { [DEFAULT_MODELS.anthropic]: rates(100, 100), [DEFAULT_MODELS.openai]: rates(1, 1) };
  const choice = routeProvider(inputs({ remainingBudgetUsd: 0.02, pricing }));
  assert.equal(choice.provider, 'openai');
  assert.match(choice.reason, /exceeds remaining budget/);
  assert.throws(() => routeProvider(inputs({ remainingBudgetUsd: 0, pricing })), /No healthy provider/);
  assert.throws(() => routeProvider(inputs({ remainingBudgetUsd: NaN, pricing })), /No healthy provider/);
  for (const bounds of [{ inputTokens: -1 }, { outputTokens: 0 }, { outputTokens: NaN }]) assert.throws(() => routeProvider(inputs({ ...bounds, remainingBudgetUsd: 1, pricing })), /token bounds/);
  // Together has no built-in price: eligible on a conservative estimate, labelled as such, until the estimate exceeds the budget.
  const together = { TOGETHER_API_KEY: 'fixture' };
  const eligible = routeProvider(inputs({ env: together, remainingBudgetUsd: 100 }));
  assert.equal(eligible.provider, 'together');
  assert.match(eligible.reason, /price estimated/);
  assert.throws(() => routeProvider(inputs({ env: together, remainingBudgetUsd: 0.0001 })), /exceeds remaining budget \(estimated cost\)/);
  // A price from the table overrides the estimate: a cheap known price fits where the estimate does not.
  const priced = routeProvider(inputs({ env: together, remainingBudgetUsd: 0.01, pricing: { [DEFAULT_MODELS.together]: rates(0.1, 0.1) } }));
  assert.equal(priced.provider, 'together');
  assert.doesNotMatch(priced.reason, /price estimated/);
  const base = { agents: ['a'], env, load: empty, routing: { config: {}, history: [], remainingBudgetUsd: 0.02, pricing } };
  await assert.rejects(resolveSeats({ ...base, seats: { a: { provider: 'anthropic', model: DEFAULT_MODELS.anthropic } } }), /exceeds remaining budget/);
  await assert.rejects(resolveSeats({ ...base, provider: 'anthropic' }), /exceeds remaining budget/);
  await assert.rejects(resolveSeats({ ...base, load: async () => ({ frontmatter: { provider: 'together' } }) }), /exceeds remaining budget \(estimated/);
});

test('persona model fallback checks affordability, counting estimated cost, before probing or accepting the default', async t => {
  process.env.TOGETHER_API_KEY = 'fixture';
  const calls = stubFetch(t, (_url, init) => JSON.parse(init.body).model === 'missing-fixture' ? json(404, { error: { message: 'unknown model' } }) : reply('OK'));
  const load = async () => ({ frontmatter: { provider: 'together', model: 'missing-fixture' } });
  const pricing = { 'missing-fixture': rates(0.001, 0.001) };
  // The pinned model is cheap; the provider default has no price, so its estimate exceeds the allowance.
  await assert.rejects(prepareSeats({ agents: ['a'], load, routing: { config: {}, history: [], remainingBudgetUsd: 0.01, pricing } }), /exceeds remaining budget \(estimated/);
  assert.ok(calls.every(call => call.body.model === 'missing-fixture'), 'the unaffordable default is never probed');
  calls.length = 0;
  const seats = await prepareSeats({ agents: ['a'], load, routing: { config: {}, history: [], remainingBudgetUsd: 100, pricing } });
  assert.equal(seats.get('a').model, DEFAULT_MODELS.together);
});

test('endpoint-scoped history: an unrelated openai_compatible URL cannot sway routing for the configured endpoint', async t => {
  Object.assign(process.env, { OPENAI_COMPATIBLE_BASE_URL: 'https://configured.example/v1', OPENAI_COMPATIBLE_API_KEY: 'sk-secret-key', ANTHROPIC_API_KEY: 'fixture-a' });
  stubFetch(t, () => json(401, { error: { message: 'no' } }));
  for (let i = 0; i < 3; i++) {
    await assert.rejects(callLLM('brief', [{ role: 'user', content: 'brief' }], { provider: 'openai_compatible', model: 'judgment-endpoint-fixture', baseUrl: 'https://foreign.example/v1' }));
  }
  const history = recentRoutingHistory(NOW, ROUNDTABLE_HOME).filter(line => line.model === 'judgment-endpoint-fixture');
  assert.equal(history.length, 3);
  assert.ok(history.every(line => /^[0-9a-f]{16}$/.test(line.endpoint) && !JSON.stringify(line).includes('foreign.example') && !JSON.stringify(line).includes('sk-secret-key')));
  assert.equal(endpointFingerprint('openai_compatible', process.env, 'https://user:pw@foreign.example/v1/?k=1'), endpointFingerprint('openai_compatible', process.env, 'https://foreign.example/v1'));
  assert.notEqual(endpointFingerprint('openai_compatible', process.env, 'https://foreign.example/v1'), endpointFingerprint('openai_compatible', process.env));
  const configured = { ...process.env };
  const model = routingModels('openai_compatible', 'judge').model;
  const poisoned = history.map(line => ({ ...line, model }));
  assert.equal(recentPerformance(poisoned, 'openai_compatible', model, endpointFingerprint('openai_compatible', configured)).failures, 0);
  assert.equal(recentPerformance(poisoned, 'openai_compatible', model, endpointFingerprint('openai_compatible', configured, 'https://foreign.example/v1')).failures, 3);
  const choice = routeProvider(inputs({ env: configured, tier: 'judge', history: poisoned, health: new ProviderHealthCache(() => NOW) }));
  assert.equal(choice.provider, 'anthropic', 'tie-break order is unchanged by foreign failures (anthropic precedes openai_compatible)');
  assert.equal(routeProvider(inputs({ env: { OPENAI_COMPATIBLE_BASE_URL: 'https://configured.example/v1' }, tier: 'judge', history: poisoned })).provider, 'openai_compatible');
});

test('hook context resolves its provider lazily, so recovery needs neither budget nor a healthy provider', async () => {
  process.env.ANTHROPIC_API_KEY = 'fixture';
  const store = { state: async () => makeState({ contract: null }) };
  const ctx = await runnerHookContext({ store, header: {}, driver: () => ({}), worker: () => undefined });
  assert.equal(typeof ctx.llm, 'function');
  assert.throws(() => resolveHuddleLLM(ctx.llm), /exceeds remaining budget|No healthy provider/);
  const explicit = await runnerHookContext({ store, header: {}, driver: () => ({}), worker: () => undefined }, { llm: { provider: 'openai', model: 'x' } });
  assert.deepEqual(resolveHuddleLLM(explicit.llm), { provider: 'openai', model: 'x' });
});

test('the routed output ceiling applies to every meeting call: opening, turns and summaries', async t => {
  mkdirSync(ROUNDTABLE_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(join(ROUNDTABLE_HOME, 'config.json'), JSON.stringify({ routing: { openai: { balanced: { model: DEFAULT_MODELS.openai, maxOutputTokens: 250 }, judge: { model: DEFAULT_MODELS.openai, maxOutputTokens: 250 } } } }), { mode: 0o600 });
  t.after(() => rmSync(join(ROUNDTABLE_HOME, 'config.json'), { force: true }));
  fixtureAgents();
  process.env.OPENAI_API_KEY = 'fixture';
  const calls = stubFetch(t, () => reply('OK'));
  const started = await handleToolCall('start_meeting', { agent: 'judgment-a', agenda: 'brief', provider: 'auto' });
  assert.ok(!started.isError, started.content[0].text);
  const id = JSON.parse(started.content[0].text).meetingId;
  const said = await handleToolCall('say', { meeting_id: id, message: 'go on' });
  assert.ok(!said.isError, said.content[0].text + started.content[0].text);
  assert.ok((await handleToolCall('end_meeting', { meeting_id: id, request_summary: true })).isError !== true);
  const limits = calls.filter(call => call.body.messages).map(call => call.body.max_tokens ?? call.body.max_completion_tokens).filter(n => n !== 64);
  assert.ok(limits.length >= 3, `expected opening, turn and summary calls, saw ${limits.length}`);
  assert.ok(limits.every(n => n <= 250), `uncapped call: ${limits}`);
});

test('judge and mix cost bias use known prices and stable provider order', () => {
  const config = { anthropic: { judge: { model: DEFAULT_MODELS.anthropic } } };
  const pricing = { [DEFAULT_MODELS.anthropic]: rates(10, 10), [DEFAULT_MODELS.openai]: rates(1, 1) };
  assert.equal(routeProvider(inputs({ tier: 'judge', config, pricing })).provider, 'openai');
  assert.equal(routeProvider(inputs({ costBias: true, pricing })).provider, 'openai');
  assert.equal(routeProvider(inputs()).provider, 'anthropic');
});

test('precedence: seats and tool provider/model > healthy persona > mix alias > router; model-only persona is retained', async () => {
  const load = async () => ({ frontmatter: { provider: 'together', model: 'persona-fixture' } });
  const base = { agents: ['a'], env, load, routing: { config: {}, history: [] } };
  assert.equal((await resolveSeats({ ...base, mix: 'cheap' })).get('a').model, 'persona-fixture');
  const tool = (await resolveSeats({ ...base, mix: 'auto', provider: 'openai', model: 'tool-fixture' })).get('a');
  assert.equal(tool.provider, 'openai'); assert.equal(tool.model, 'tool-fixture');
  const seat = (await resolveSeats({ ...base, provider: 'openai', model: 'tool-fixture', seats: { a: { provider: 'replicate', model: 'seat-fixture' } } })).get('a');
  assert.equal(seat.provider, 'replicate'); assert.equal(seat.model, 'seat-fixture');
  assert.equal((await resolveSeats({ ...base, seat: 'a=replicate:seat-fixture' })).get('a').model, 'seat-fixture');
  assert.equal((await resolveSeats({ ...base, model: 'explicit-model-only' })).get('a').model, 'explicit-model-only');
  const modelOnly = (await resolveSeats({ ...base, load: async () => ({ frontmatter: { model: 'persona-model-only' } }) })).get('a');
  assert.equal(modelOnly.model, 'persona-model-only');
  assert.match((await resolveSeats({ ...base, provider: 'auto', load: empty })).get('a').reason, /chosen/);
});

test('teams spread across eligible providers; runtimes are never automatic candidates', async () => {
  const seats = await resolveSeats({ teamA: ['a'], teamB: ['b'], judges: ['j'], env, load: empty, routing: { config: {}, history: [] } });
  assert.notEqual(seats.get('a').provider, seats.get('b').provider);
  for (const seat of seats.values()) assert.ok(PROVIDER_IDS.includes(seat.provider));
  assert.throws(() => routeProvider(inputs({ env: { PATH: '/fixture/bin', ROUNDTABLE_EXECUTION_PROVIDER: 'fixture-runtime' } })), /No healthy provider/);
});

test('cache expires with an injected clock and isolates endpoint and credential identities', () => {
  let now = 100;
  const cache = new ProviderHealthCache(() => now);
  const configured = { OPENAI_COMPATIBLE_BASE_URL: 'https://configured.invalid/v1', OPENAI_COMPATIBLE_API_KEY: 'fixture' };
  cache.recordCall('openai_compatible', false, 'auth failed', configured);
  assert.equal(cache.get('openai_compatible', configured).ok, false);
  assert.equal(cache.get('openai_compatible', { ...configured, OPENAI_COMPATIBLE_BASE_URL: 'https://different.invalid/v1' }), undefined);
  assert.equal(cache.get('openai_compatible', { ...configured, OPENAI_COMPATIBLE_API_KEY: 'replacement' }), undefined);
  cache.recordCall('openai_compatible', true, undefined, configured, 'https://untrusted.invalid/v1');
  assert.equal(cache.get('openai_compatible', configured).ok, false);
  now += HEALTH_TTL_MS - 1;
  assert.equal(cache.get('openai_compatible', configured).ok, false);
  now++;
  assert.equal(cache.get('openai_compatible', configured), undefined);
});

test('unsafe compatible endpoints are excluded and caller base_url cannot steer automatic calls', async t => {
  for (const endpoint of ['http://untrusted.invalid/v1', 'https://token@untrusted.invalid/v1', 'file:///fixture', 'https://configured.invalid/v1?token=fixture']) {
    assert.throws(() => routeProvider(inputs({ env: { OPENAI_COMPATIBLE_BASE_URL: endpoint, OPENAI_COMPATIBLE_API_KEY: 'fixture' } })), /untrusted base URL/);
  }
  const calls = stubFetch(t, () => { throw new Error('must not call'); });
  for (const [name, args] of [
    ['start_meeting', { agent: 'judgment-a', agenda: 'brief' }],
    ['start_collaboration', { agents: ['judgment-a', 'judgment-b'], topic: 'brief' }],
    ['start_ultraplan', { agents: ['judgment-a'], task: 'brief' }],
  ]) {
    const result = await handleToolCall(name, { ...args, provider: 'auto', base_url: 'https://untrusted.invalid/v1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /base_url/);
  }
  assert.equal(calls.length, 0);
});

test('failure names every provider and local diagnostics, without credential or remote error text', async t => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY });
  stubFetch(t, () => json(401, { error: { message: 'remote-fixture-secret' } }));
  await assert.rejects(prepareSeats({ agents: ['a'], load: empty, routing: { config: {}, history: [] } }), error => {
    for (const provider of PROVIDER_IDS) assert.ok(error.message.includes(provider));
    assert.match(error.message, /auth failed/); assert.doesNotMatch(error.message, /remote-fixture-secret|fixture-a/);
    return true;
  });
});

test('routing config validates strictly and is loaded from an isolated operator config', t => {
  for (const raw of [null, [], { unknown: {} }, { openai: { typo: { model: 'x' } } }, { openai: { judge: {} } }, { openai: { judge: { model: 'x', health: true } } }, { openai: { judge: { model: 'x', reasoning: 'false' } } }, { openai: { judge: { model: 'x', maxOutputTokens: -1 } } }]) assert.throws(() => validateRoutingConfig(raw));
  const home = mkdtempSync(join(tmpdir(), 'judgment-config-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const routing = { openai: { judge: { model: 'fixture-cheap', reasoning: false, maxOutputTokens: 1000 } } };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ routing }), { mode: 0o600 });
  assert.deepEqual(readUserConfig(home).routing, routing);
  assert.equal(routeProvider(inputs({ env: { OPENAI_API_KEY: 'fixture', ROUNDTABLE_HOME: home }, config: undefined, tier: 'judge' })).model, 'fixture-cheap');
});

test('reason strings survive NDJSON, terminal seat lines, and the duel MCP routing block', async () => {
  const seat = { id: 'a', name: 'a', ...routeProvider(inputs()) };
  const event = { type: 'start', id: 'duel-fixture', topic: 'brief', mode: 'duel', seats: [seat], startedAt: new Date(NOW).toISOString() };
  let ndjson = '', terminal = '';
  await createNdjsonObserver({ write: s => { ndjson += s; } }).onEvent(event);
  await createTerminalObserver({ output: { write: s => { terminal += s; } }, env: {} }).onEvent(event);
  assert.equal(JSON.parse(ndjson).seats[0].reason, seat.reason);
  assert.ok(terminal.includes(seat.reason));
  const result = summarizeDuel([event], { id: 'duel-fixture', winner: 'tie', tally: { A: 0, B: 0 }, aborted: false });
  assert.equal(result.routing[0].reason, seat.reason);
});

test('MCP auto start schemas and meeting, collaboration, ultraplan results expose routing', async t => {
  fixtureAgents();
  process.env.OPENAI_API_KEY = 'fixture';
  stubFetch(t, () => reply('OK'));
  for (const name of ['start_meeting', 'start_collaboration', 'start_duel', 'start_ultraplan']) {
    assert.ok(tools.find(tool => tool.name === name).inputSchema.properties.provider.enum.includes('auto'));
  }
  for (const [name, args] of [
    ['start_meeting', { agent: 'judgment-a', agenda: 'brief' }],
    ['start_collaboration', { agents: ['judgment-a', 'judgment-b'], topic: 'brief', grounding: false }],
    ['start_ultraplan', { agents: ['judgment-a'], task: 'brief' }],
  ]) {
    const result = await handleToolCall(name, { ...args, provider: 'auto' });
    assert.ok(!result.isError, result.content[0].text);
    const output = JSON.parse(result.content[0].text);
    assert.ok(output.routing.length);
    assert.ok(output.routing.every(seat => seat.provider === 'openai' && /healthy/.test(seat.reason)));
  }
});

test('heads-down review and huddle provider is routed when unset; execute preflight falls back and checks it', async t => {
  process.env.ANTHROPIC_API_KEY = 'fixture-a'; process.env.OPENAI_API_KEY = 'fixture-b';
  const calls = stubFetch(t, url => url.includes('/messages') ? json(401, { error: { message: 'bad key' } }) : reply('OK'));
  const chosen = await prepareExecutionProvider();
  assert.equal(chosen.provider, 'openai');
  assert.equal(executionLLM({ config: {}, history: [] }).provider, 'openai');
  assert.equal(executionHuddleLLM().provider, 'openai');
  delete process.env.ROUNDTABLE_SKIP_EXECUTION_PREFLIGHT;
  await preflightExecutionProvider();
  assert.ok(calls.every(c => c.body.max_tokens === 64 || c.body.max_completion_tokens === 64));
  process.env.ROUNDTABLE_EXECUTION_PROVIDER = 'together'; process.env.ROUNDTABLE_EXECUTION_MODEL = 'explicit-fixture';
  assert.equal(executionLLM().provider, 'together'); assert.equal(executionLLM().model, 'explicit-fixture');
});

test('real outcome ledger captures failure and latency without usage double counting', async t => {
  process.env.OPENAI_API_KEY = 'fixture';
  stubFetch(t, () => json(429, { error: { message: 'rate limited' } }));
  await assert.rejects(callLLM('brief', [{ role: 'user', content: 'brief' }], { provider: 'openai', model: 'judgment-ledger-fixture' }));
  const history = recentRoutingHistory(NOW, ROUNDTABLE_HOME).filter(line => line.model === 'judgment-ledger-fixture');
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'rate_limit'); assert.equal(history[0].latency_ms, 0);
  assert.equal(history[0].tokens, undefined); assert.equal(history[0].usd, undefined);
});

test('healthy pair preflight is cached until TTL expiry and retried after a key rotation', async t => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  process.env.OPENAI_API_KEY = 'fixture';
  const calls = stubFetch(t, () => reply('OK'));
  const options = { agents: ['a'], load: empty, routing: { config: {}, history: [] } };
  await prepareSeats(options); await prepareSeats(options);
  assert.equal(calls.length, 1);
  now += HEALTH_TTL_MS;
  await prepareSeats(options);
  assert.equal(calls.length, 2);
  process.env.OPENAI_API_KEY = 'rotated-fixture';
  await prepareSeats(options);
  assert.equal(calls.length, 3);
});

test('persona missing-model fallback survives automatic preflight, while explicit model errors never fall back', async t => {
  process.env.OPENAI_API_KEY = 'fixture';
  const calls = stubFetch(t, (_url, init) => JSON.parse(init.body).model === 'missing-fixture' ? json(404, { error: { message: 'unknown model' } }) : reply('OK'));
  const seats = await prepareSeats({ agents: ['a'], load: async () => ({ frontmatter: { provider: 'openai', model: 'missing-fixture' } }), routing: { config: {}, history: [] } });
  assert.equal(seats.get('a').model, DEFAULT_MODELS.openai);
  assert.equal(calls.length, 2);
  await assert.rejects(prepareSeats({ agents: ['a'], provider: 'openai', model: 'missing-fixture', load: empty }, { preflight: true }), /model missing-fixture not available/);
});

test('configured output cap reaches automatic calls and explicit starts preserve their model and token defaults', async t => {
  fixtureAgents();
  process.env.OPENAI_API_KEY = 'fixture';
  const home = mkdtempSync(join(tmpdir(), 'judgment-call-cap-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const originalHome = process.env.ROUNDTABLE_HOME;
  process.env.ROUNDTABLE_HOME = home;
  t.after(() => { process.env.ROUNDTABLE_HOME = originalHome; });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ routing: { openai: { balanced: { model: DEFAULT_MODELS.openai, maxOutputTokens: 250 } } } }), { mode: 0o600 });
  const calls = stubFetch(t, () => reply('OK'));
  const auto = await handleToolCall('start_meeting', { agent: 'judgment-a', agenda: 'brief' });
  assert.ok(!auto.isError, auto.content[0].text);
  assert.equal(calls.at(-1).body.max_completion_tokens, 250);
  for (const [name, args] of [
    ['start_meeting', { agent: 'judgment-a', agenda: 'brief' }],
    ['start_ultraplan', { agents: ['judgment-a'], task: 'brief' }],
  ]) {
    const result = await handleToolCall(name, { ...args, provider: 'openai', model: 'explicit-fixture' });
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).routing, undefined);
    assert.equal(calls.at(-1).body.model, 'explicit-fixture');
    assert.notEqual(calls.at(-1).body.max_completion_tokens, 250);
  }
});

test('duel MCP auto result contains the selected reasons after a complete stubbed duel', async t => {
  fixtureAgents();
  process.env.OPENAI_API_KEY = 'fixture';
  stubFetch(t, (_url, init) => {
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    const content = prompt.startsWith('R1b BUILD') ? '<prototype kind="text" title="Draft"><file path="draft.md">A short draft.</file></prototype>'
      : prompt.startsWith('R2 JUDGE') ? 'VERDICT A: APPROVE — fits\nVERDICT B: APPROVE — fits\nPREFER: A' : 'OK';
    return reply(content);
  });
  const result = await handleToolCall('start_duel', { topic: 'A short draft', kind: 'text', team_a: ['judgment-a'], team_b: ['judgment-b'], judges: ['judgment-judge'], provider: 'auto' });
  assert.ok(!result.isError, result.content[0].text);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.routing.length, 3);
  assert.ok(output.routing.every(seat => seat.provider === 'openai' && /chosen: healthy/.test(seat.reason)));
});

test('explicit compatible URLs dispatch without environment endpoints, probes, health fallback or duplicate ledger rows', async t => {
  fixtureAgents();
  const { withUsageSink } = await import('../../dist/providers/usage.js');
  const { readTableLines, day } = await import('../../dist/usage/table.js');
  const { startCollaboration, advanceCollaboration, collaborations, endCollaboration } = await import('../../dist/sessions/collaborations.js');
  const baseUrl = 'http://localhost:4141/v1';
  assert.equal(process.env.OPENAI_COMPATIBLE_BASE_URL, undefined);
  providerHealth.recordCall('openai_compatible', false, 'auth failed');
  const calls = stubFetch(t, (url, init) => {
    assert.equal(url, `${baseUrl}/chat/completions`);
    assert.notEqual(JSON.parse(init.body).max_tokens, 64, 'explicit seats must never preflight');
    return reply('OK');
  });
  const seen = [], before = readTableLines([day(NOW)], ROUNDTABLE_HOME).length;
  await withUsageSink(report => seen.push(report), async () => {
    const { collaborationId } = await startCollaboration(['judgment-a', 'judgment-b'], 'brief', {
      provider: 'openai_compatible', model: 'explicit-fixture', baseUrl, maxRounds: 1,
    });
    await advanceCollaboration(collaborations.get(collaborationId));
    await endCollaboration(collaborationId, true);
  });
  assert.equal(calls.length, 3);
  assert.equal(seen.length, 3);
  assert.equal(readTableLines([day(NOW)], ROUNDTABLE_HOME).length, before, 'execution-owned calls cannot create table outcome rows');
  assert.ok(calls.every(call => call.body.model === 'explicit-fixture'));
  assert.ok(seen.every(report => !Object.hasOwn(report, 'outcome') && !Object.hasOwn(report, 'latency_ms')));

  const result = await handleToolCall('start_collaboration', { agents: ['judgment-a', 'judgment-b'], topic: 'brief', base_url: baseUrl,
    seats: { 'judgment-a': { provider: 'openai_compatible', model: 'seat-a' }, 'judgment-b': { provider: 'openai_compatible', model: 'seat-b' } }, grounding: false });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).body.model, 'seat-a');
  await endCollaboration(JSON.parse(result.content[0].text).collaborationId);
});

test('pure duel seat resolution with explicit seats performs no credential or network preflight', async t => {
  fixtureAgents();
  const { resolveSeatsLocal } = await import('../../dist/table/duel.js');
  const calls = stubFetch(t, () => { throw new Error('Pure seat resolution cannot dispatch'); });
  const seats = await resolveSeatsLocal({ topic: 'brief', teamA: ['judgment-a'], teamB: ['judgment-b'], judges: ['judgment-judge'],
    seats: Object.fromEntries(['judgment-a', 'judgment-b', 'judgment-judge'].map(agent => [agent, { provider: 'openai_compatible', model: 'explicit-fixture' }])) });
  assert.equal(seats.length, 3);
  assert.ok(seats.every(seat => seat.provider === 'openai_compatible' && seat.model === 'explicit-fixture'));
  assert.equal(calls.length, 0);
});

test('the runner validates a missing execution before selecting or probing any provider', async t => {
  const { runRunner } = await import('../../dist/execution/runner.js');
  process.env.ROUNDTABLE_SKIP_EXECUTION_PREFLIGHT = '1';
  const calls = stubFetch(t, () => { throw new Error('A missing execution cannot probe'); });
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(String(message)));
  assert.equal(await runRunner('exe-01m5e6mgmc6np7f4'), 1);
  assert.match(messages.join('\n'), /not found/);
  assert.doesNotMatch(messages.join('\n'), /No healthy provider/);
  assert.equal(calls.length, 0);
});

const four = { ANTHROPIC_API_KEY: 'fixture-a', OPENAI_API_KEY: 'fixture-b', REPLICATE_API_TOKEN: 'fixture-d', OLLAMA_URL: 'http://localhost:11434' };
const roster = ['a', 'b', 'c', 'd'];

test('--mix auto and --mix cheap spread four seats across four healthy providers', async () => {
  for (const mix of ['auto', 'cheap']) {
    const seats = await resolveSeats({ agents: roster, mix, env: four, load: empty, routing: { config: {}, history: [] } });
    assert.deepEqual([...new Set([...seats.values()].map(seat => seat.provider))].sort(), ['anthropic', 'ollama', 'openai', 'replicate'], mix);
  }
});

test('mix cost bias ranks known prices first; an unknown price is its own rank, never the budget estimate', () => {
  const pricing = { [DEFAULT_MODELS.anthropic]: rates(100, 100), [DEFAULT_MODELS.openai]: rates(1, 1) };
  const cheap = routeProvider(inputs({ costBias: true, pricing }));
  assert.equal(cheap.provider, 'openai');
  const premiumVsUnknown = routeProvider(inputs({ env: { ANTHROPIC_API_KEY: 'k', TOGETHER_API_KEY: 'k' }, costBias: true, pricing, tier: 'balanced' }));
  assert.equal(premiumVsUnknown.provider, 'anthropic', 'a priced model is not displaced by an unpriced one valued at the estimate rate');
});

test('execute preflight with automatic judgment never refuses: no keys, or a small budget with unpriced providers', async t => {
  for (const key of Object.keys(env)) delete process.env[key];
  await preflightExecutionProvider(5);
  process.env.TOGETHER_API_KEY = 'fixture';
  stubFetch(t, () => reply('OK'));
  await preflightExecutionProvider(0.0001);
  assert.equal(await seedExecutionProvider(), undefined);
  delete process.env.TOGETHER_API_KEY;
  assert.match(await seedExecutionProvider(), /No healthy provider/);
});

test('the runner retries a failed escalation route with doubling pauses, gives up to the human after five, and clears on success', async t => {
  const given = [], routes = [];
  let fail = true, now = 0;
  t.mock.method(Date, 'now', () => now);
  const runner = new Runner('exe-01m5e6grqmtp6rv8', { signals: false, routeRetryBaseMs: 100, hooks: {
    escalationRouter: async (_ctx, esc) => { routes.push(now); if (fail) throw new Error('No healthy provider'); },
    escalationGiveUp: async (_ctx, id, message) => { given.push([id, message]); },
  } });
  runner.say = () => {};
  const state = { escalations: { 'esc-1': { id: 'esc-1', status: 'open' } } };
  const tick = async ms => { now += ms; runner.routeEscalations(state); await Promise.all([...runner.pending]); };
  await tick(0);
  await tick(50); assert.equal(routes.length, 1, 'inside the first pause nothing is retried');
  await tick(50); await tick(199); assert.equal(routes.length, 2);
  await tick(1); assert.equal(routes.length, 3, 'second pause doubled');
  await tick(400); assert.equal(routes.length, 4);
  await tick(800); assert.equal(routes.length, 5);
  assert.equal(given.length, 1); assert.equal(given[0][0], 'esc-1'); assert.match(given[0][1], /after 5 attempts/);
  await tick(100000); assert.equal(routes.length, 5, 'after giving up it is not routed again');
  // Success clears the bookkeeping.
  const ok = new Runner('exe-01m5e6grqmtp6rv8', { signals: false, routeRetryBaseMs: 100, hooks: { escalationRouter: async () => { if (fail) throw new Error('x'); } } });
  ok.say = () => {};
  ok.routeEscalations({ escalations: { e: { id: 'e', status: 'open' } } }); await Promise.all([...ok.pending]);
  assert.equal(ok.routeAttempts.get('e'), 1);
  fail = false; now += 100; ok.routeEscalations({ escalations: { e: { id: 'e', status: 'open' } } }); await Promise.all([...ok.pending]);
  assert.equal(ok.routeAttempts.has('e'), false); assert.equal(ok.routeRetryAt.has('e'), false);
});

test('failures decay after the window and stop counting once the credential or endpoint changes; transient failures expire sooner than auth', () => {
  const line = (extra = {}) => ({ at: new Date(NOW - 1000).toISOString(), server: 's', session: 'x', kind: 'provider-call', agent: 'provider', provider: 'openai', model: 'm', outcome: 'rate_limit', latency_ms: 5, ...extra });
  assert.equal(recentPerformance([line()], 'openai', 'm', undefined, undefined, NOW).failures, 1);
  assert.equal(recentPerformance([line({ at: new Date(NOW - FAILURE_WINDOW_MS - 1).toISOString() })], 'openai', 'm', undefined, undefined, NOW).failures, 0);
  const rotated = credentialFingerprint('openai', { OPENAI_API_KEY: 'old-key' }), current = credentialFingerprint('openai', { OPENAI_API_KEY: 'new-key' });
  assert.match(rotated, /^[0-9a-f]{16}$/); assert.notEqual(rotated, current);
  assert.equal(recentPerformance([line({ cred: rotated })], 'openai', 'm', undefined, current, NOW).failures, 0);
  assert.equal(recentPerformance([line({ cred: current })], 'openai', 'm', undefined, current, NOW).failures, 1);
  let at = NOW;
  const cache = new ProviderHealthCache(() => at);
  const e = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' };
  cache.recordCall('openai', false, 'rate limited', e); cache.recordCall('anthropic', false, 'auth failed', e);
  at = NOW + TRANSIENT_HEALTH_TTL_MS;
  assert.equal(cache.get('openai', e), undefined, 'a 429 excludes briefly');
  assert.equal(cache.get('anthropic', e)?.ok, false, 'a rejected key stays excluded for the full TTL');
});

test('the ledger stores a credential hash, never the key', async t => {
  process.env.OPENAI_API_KEY = 'sk-never-store-this';
  stubFetch(t, () => json(429, { error: { message: 'slow down' } }));
  await assert.rejects(callLLM('brief', [{ role: 'user', content: 'brief' }], { provider: 'openai', model: 'judgment-cred-fixture' }));
  const rows = recentRoutingHistory(NOW, ROUNDTABLE_HOME).filter(row => row.model === 'judgment-cred-fixture');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cred, credentialFingerprint('openai', process.env));
  assert.ok(!JSON.stringify(rows).includes('sk-never-store-this'));
});

test('reasons name request failures; the terminal prints shared exclusions once and the choice per seat', async () => {
  const health = new ProviderHealthCache(() => NOW);
  health.recordCall('anthropic', false, 'request failed', env);
  const choice = routeProvider(inputs({ health, tier: 'judge' }));
  assert.match(choice.reason, /anthropic\/.*: request failed/);
  const seats = await resolveSeats({ agents: ['a', 'b'], env, load: empty, routing: { config: {}, history: [], health } });
  const rendered = [];
  const observer = createTerminalObserver({ output: { write: text => rendered.push(text), isTTY: false, columns: 200 }, env: {} });
  observer.onEvent({ type: 'start', id: 'x', topic: 'topic', mode: 'duel', seats: [...seats.values()], startedAt: new Date(NOW).toISOString() });
  const text = rendered.join('');
  assert.equal(text.match(/request failed/g).length, 1, text);
  assert.match(text, /Routing: /);
  assert.equal(splitRoutingReason('x: request failed; a/b chosen: healthy').chosen, 'a/b chosen: healthy');
  assert.ok([...seats.values()].every(seat => /request failed/.test(seat.reason)), 'per-seat reasons stay complete for NDJSON and MCP');
});

test('a model given without a provider only goes to providers that can serve it', () => {
  assert.equal(modelFitsProvider('anthropic', 'claude-sonnet-5-5'), true);
  assert.equal(modelFitsProvider('openai', 'claude-sonnet-5-5'), false);
  assert.equal(routeProvider(inputs({ model: 'claude-sonnet-5-5' })).provider, 'anthropic');
  const health = new ProviderHealthCache(() => NOW);
  health.recordCall('anthropic', false, 'auth failed', env);
  assert.throws(() => routeProvider(inputs({ model: 'claude-sonnet-5-5', health })), /No healthy provider/);
  assert.equal(routeProvider(inputs({ model: 'zai-org/GLM-5.3' })).provider, 'together');
});

test('reasoning models are ranked last for live seats when a non-reasoning one is healthy, but still usable alone', () => {
  const pair = { TOGETHER_API_KEY: 'k', REPLICATE_API_TOKEN: 'k' };
  assert.equal(routeProvider(inputs({ env: pair, tier: 'balanced' })).provider, 'replicate');
  assert.equal(routeProvider(inputs({ env: pair, tier: 'judge' })).provider, 'replicate');
  assert.equal(routeProvider(inputs({ env: { TOGETHER_API_KEY: 'k' }, tier: 'balanced' })).provider, 'together');
});

test('routing history is re-read after a local ledger write and routing context is memoised per hook', async () => {
  const both = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' };
  const base = { env: both, config: {}, health: new ProviderHealthCache(() => NOW), now: NOW };
  assert.equal(routeProvider(base).provider, 'anthropic');
  const model = routingModels('anthropic', 'balanced').model;
  for (let i = 0; i < 3; i++) appendTableLine({ at: new Date(NOW - 1000).toISOString(), server: newServerId(), session: 'provider-calls', kind: 'provider-call', agent: 'provider', provider: 'anthropic', model, outcome: 'timeout', latency_ms: 1, cred: credentialFingerprint('anthropic', both) });
  assert.equal(routeProvider(base).provider, 'openai');
  process.env.OPENAI_API_KEY = 'fixture';
  const ctx = await runnerHookContext({ store: { state: async () => makeState({ contract: null }) }, header: {}, driver: () => ({}), worker: () => undefined }, {});
  assert.equal(typeof ctx.llm, 'function');
});

test('non-team live seats all avoid a reasoning model while a non-reasoning one is healthy; duel teams still split', async () => {
  const pair = { TOGETHER_API_KEY: 'k', REPLICATE_API_TOKEN: 'k' };
  const seats = await resolveSeats({ agents: ['a', 'b', 'c'], env: pair, load: empty, routing: { config: {}, history: [] } });
  assert.deepEqual([...seats.values()].map(seat => seat.provider), ['replicate', 'replicate', 'replicate']);
  const teams = await resolveSeats({ teamA: ['a', 'x'], teamB: ['b', 'y'], env: pair, load: empty, routing: { config: {}, history: [] } });
  assert.notEqual(teams.get('a').provider, teams.get('b').provider);
});
