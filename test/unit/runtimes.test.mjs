import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { runRuntime, runtimeEnv, detectRuntime } from '../../dist/runtimes/runner.js';
import { BUILTIN_RUNTIMES, runtimeRegistry } from '../../dist/runtimes/registry.js';
import { validateRuntimeSpec, validateRuntimeConfig } from '../../dist/runtimes/spec.js';
import { readUserConfig } from '../../dist/user-config.js';
import { childEnv } from '../../dist/security/child-env.js';
import { parseSeat } from '../../dist/table/events.js';
import { resolveSeats, prepareSeats, preflightSeats, validateSeatSpecs } from '../../dist/table/seats.js';
import { callSeat } from '../../dist/table/dispatch.js';
import { metered, setLedgerHome } from '../../dist/usage/session-scope.js';
import { day, readTableLines } from '../../dist/usage/table.js';
const fixtures = resolve('test/fixtures/runtimes');
const env = { PATH: [fixtures, dirname(process.execPath), process.env.PATH].join(delimiter), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
const text = name => ({ argv: [name], output: { mode: 'text' } });
const load = async () => ({ frontmatter: {} });

test('built-in profiles parse text, JSON, JSONL final messages and usage', async () => {
  const expected = { hermes: 'A useful answer.', openclaw: 'Gateway answer.', gemini: 'Structured answer.', codex: 'Final answer.' };
  for (const [name, spec] of Object.entries(BUILTIN_RUNTIMES)) {
    const result = await runRuntime(spec, 'Say something.', { env, model: 'fixture-model' });
    assert.equal(result.text, expected[name]);
    if (name === 'gemini') { assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 }); assert.equal(result.costUsd, 0.012); }
    if (name === 'codex') assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 9 });
  }
  const codex = BUILTIN_RUNTIMES.codex.argv;
  for (const flag of ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', 'read-only', 'approval_policy="never"', 'shell_environment_policy.inherit=core']) assert.ok(codex.includes(flag));
});

test('stdin prompts, one-element argv prompts, separate model values and fresh removed cwd', async () => {
  const prompt = '--foo; rm -rf / $(x)';
  const spec = { argv: ['argv-echo', '-p', '{prompt}'], modelFlag: '--model', output: { mode: 'text' } };
  const echo = JSON.parse((await runRuntime(spec, prompt, { env, model: 'safe-model:1' })).text);
  assert.deepEqual(echo.args, ['-p', prompt, '--model', 'safe-model:1']);
  assert.equal(echo.stdin, ''); assert.notEqual(echo.cwd, process.cwd()); assert.equal(existsSync(echo.cwd), false);
  const stdin = JSON.parse((await runRuntime(text('argv-echo'), prompt, { env })).text);
  assert.equal(stdin.stdin, prompt); assert.deepEqual(stdin.args, []);
  for (const model of ['--bad', '-m', 'two words', 'x;echo', '$(x)', 'x\n']) await assert.rejects(runRuntime(spec, prompt, { env, model }), /model/);
  const echoCwd = JSON.parse((await runRuntime({ ...text('argv-echo'), cwd: fixtures }, prompt, { env })).text);
  assert.equal(echoCwd.cwd, fixtures); assert.ok(existsSync(fixtures));
});

test('runtime environment excludes provider keys unless the spec explicitly lists each name', async () => {
  const secrets = { ANTHROPIC_API_KEY: 'fixture-secret-anthropic', OPENAI_API_KEY: 'fixture-secret-openai', TOGETHER_API_KEY: 'fixture-secret-together', REPLICATE_API_TOKEN: 'fixture-secret-replicate', OTHER_SECRET: 'fixture-secret-other' };
  const source = { ...env, ...secrets, HTTPS_PROXY: 'http://127.0.0.1:9999', LANG: 'C', UNRELATED: 'no', ROUNDTABLE_WORKER_AUTH: 'api_key' };
  const profile = childEnv('runtime', {}, source);
  for (const key of Object.keys(secrets)) assert.equal(profile[key], undefined);
  assert.equal(profile.HTTPS_PROXY, source.HTTPS_PROXY);
  const output = JSON.parse((await runRuntime(text('env-dump'), '', { env: source })).text);
  for (const key of Object.keys(secrets)) assert.equal(output[key], undefined);
  assert.equal(output.UNRELATED, undefined);
  const authorized = runtimeEnv({ ...text('env-dump'), env: ['ANTHROPIC_API_KEY'] }, source);
  assert.equal(authorized.ANTHROPIC_API_KEY, secrets.ANTHROPIC_API_KEY);
  assert.equal(authorized.OPENAI_API_KEY, undefined);
  const scrubbed = await runRuntime({ ...text('env-dump'), env: ['ANTHROPIC_API_KEY'] }, '', { env: source });
  assert.ok(!scrubbed.text.includes(secrets.ANTHROPIC_API_KEY));
});

test('nonzero, spawn failure, missing binaries and byte caps give bounded scrubbed errors', async () => {
  await assert.rejects(runRuntime({ ...text('fail'), env: ['FIXTURE_SECRET'] }, '', { env: { ...env, FIXTURE_SECRET: 'sensitive-fixture-value' } }), e => /23/.test(e.message) && /stderr tail/.test(e.message) && !e.message.includes('sensitive-fixture-value'));
  await assert.rejects(runRuntime(text('missing-runtime-fixture'), '', { env }), /binary not found/);
  await assert.rejects(runRuntime({ ...text('argv-echo'), cwd: join(fixtures, 'missing') }, '', { env }), /spawn failed/);
  for (const name of ['oversize', 'oversize-stderr']) await assert.rejects(runRuntime({ ...text(name), stdoutMaxBytes: 1024, stderrMaxBytes: 1024 }, '', { env }), e => /byte cap.*truncated/.test(e.message) && e.message.length < 3000);
});

test('timeout and abort kill the detached group, reap the CLI and clean abort listeners', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 500) : undefined;
    const started = Date.now();
    try {
      await assert.rejects(runRuntime({ ...text('hang'), timeoutMs: abort ? 5000 : 500 }, '', { env, signal: controller.signal }), e => {
        assert.match(e.message, abort ? /aborted/ : /timed out/);
        const pid = Number(/descendant=(\d+)/.exec(e.message)?.[1]); assert.ok(pid > 1);
        // The direct child is reaped by Node. Descendants can briefly be defunct awaiting the OS reaper.
        let status = ''; try { status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
        assert.ok(!status || status.startsWith('Z'), `descendant is still running: ${status}`);
        return true;
      });
    } finally { clearTimeout(timer); }
    assert.ok(Date.now() - started < 4000);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runRuntime(text('hang'), '', { env, signal: controller.signal }), { name: 'AbortError' });
});

test('JSON paths include arrays; missing, invalid and nonnumeric usage stays defensive', async () => {
  const spec = { argv: ['json-output'], output: { mode: 'json', path: 'a.b.0.c' }, usage: { inputTokens: 'stats.input', outputTokens: 'stats.output', costUsd: 'stats.cost' } };
  const result = await runRuntime(spec, JSON.stringify({ a: { b: [{ c: 'Answer' }] }, stats: { input: 'bad', output: -1, cost: null } }), { env });
  assert.deepEqual(result, { text: 'Answer' });
  await assert.rejects(runRuntime(spec, 'invalid', { env }), /invalid JSON/);
  await assert.rejects(runRuntime(spec, '{}', { env }), /no final text/);
});

test('strict config validation, overrides, extension and provider collision rejection', t => {
  const custom = { argv: ['argv-echo'], output: { mode: 'text' }, modelFlag: '--model' };
  const registry = runtimeRegistry({ custom, hermes: { timeoutMs: 1000, argv: ['hermes', '{prompt}'] } });
  assert.equal(registry.hermes.timeoutMs, 1000); assert.equal(registry.hermes.output.stripDecoration, true);
  assert.deepEqual(registry.custom, custom);
  for (const config of [{ openai: custom }, { 'Upper': custom }, { ['a'.repeat(33)]: custom }, { custom: { ...custom, shell: true } }, { custom: { ...custom, argv: 'echo bad' } }, { custom: { ...custom, argv: ['echo bad'] } }, { custom: { ...custom, argv: ['../binary'] } }, { custom: { ...custom, argv: ['sh', '-c', 'echo bad'] } }, { custom: { ...custom, argv: ['x', 'prefix{prompt}'] } }, { custom: { ...custom, env: ['BAD=VALUE'] } }, { custom: { ...custom, timeoutMs: Infinity } }, { custom: { ...custom, cwd: 'relative' } }, { custom: { ...custom, output: { mode: 'json', path: '__proto__.x' } } }, { custom: {} }, { hermes: { cwd: fixtures } }]) assert.throws(() => validateRuntimeConfig(config));
  assert.throws(() => validateRuntimeSpec({ ...custom, argv: ['x'.repeat(4097)] }));
  const home = mkdtempSync(join(tmpdir(), 'runtime-config-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runtimes: { custom } }), { mode: 0o600 });
  assert.deepEqual(readUserConfig(home).runtimes, { custom });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runtimes: { anthropic: custom } }));
  assert.throws(() => readUserConfig(home), /configuration/);
});

test('explicit seat parsing, MCP validation and mix never auto-select runtimes', async () => {
  assert.deepEqual(parseSeat('designer=hermes:fixture-model'), { agent: 'designer', provider: 'hermes', model: 'fixture-model' });
  validateSeatSpecs({ designer: { provider: 'gemini' } });
  const seats = await resolveSeats({ agents: ['designer', 'reviewer'], seat: 'designer=codex', mix: 'auto', env: { OPENAI_API_KEY: 'fixture' }, load });
  assert.equal(seats.get('designer').provider, 'codex'); assert.equal(seats.get('designer').model, ''); assert.equal(seats.get('reviewer').provider, 'openai');
  await assert.rejects(resolveSeats({ agents: ['designer'], seat: 'designer=codex:--unsafe', load }), /model/);
  await assert.rejects(resolveSeats({ agents: ['designer'], mix: 'auto', env: {}, load }), /configured provider/);
  await assert.rejects(resolveSeats({ agents: ['designer'], load: async () => ({ frontmatter: { provider: 'codex' } }) }), /provider/);
  for (const mix of ['auto', 'cheap']) {
    const mixed = await resolveSeats({ agents: ['designer', 'reviewer'], mix, env: { OPENAI_API_KEY: 'fixture' }, load });
    assert.ok([...mixed.values()].every(s => s.provider === 'openai'));
  }
});

test('preflight detects path and version; failure is local and runtime credentials are optional', async t => {
  const oldPath = process.env.PATH; process.env.PATH = env.PATH; t.after(() => { process.env.PATH = oldPath; });
  const detected = await detectRuntime(BUILTIN_RUNTIMES.codex, { env });
  assert.equal(detected.ok, true); assert.equal(detected.path, join(fixtures, 'codex')); assert.match(detected.version, /fixture 1.0/);
  assert.equal((await detectRuntime(text('missing-runtime-fixture'), { env })).found, false);
  assert.equal((await detectRuntime({ ...text('fail'), versionArgv: [] }, { env })).ok, false);
  const results = await preflightSeats([{ id: 'designer', provider: 'codex', model: '' }, { id: 'other', provider: 'codex', model: '' }]);
  assert.equal(results.length, 1); assert.equal(results[0].ok, true);
  await prepareSeats({ agents: ['designer'], seat: 'designer=codex', env: {}, load }, { preflight: true });
  process.env.PATH = dirname(process.execPath);
  const missing = await preflightSeats([{ id: 'designer', provider: 'hermes', model: '' }]);
  assert.equal(missing[0].ok, false); assert.equal(missing[0].reason, 'runtime unavailable');
});

test('seat dispatch persists estimated and reported runtime usage/cost in the table ledger', async t => {
  const oldPath = process.env.PATH; process.env.PATH = env.PATH; t.after(() => { process.env.PATH = oldPath; setLedgerHome(undefined); });
  const home = mkdtempSync(join(tmpdir(), 'runtime-ledger-')); setLedgerHome(home); t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const provider of ['openclaw', 'gemini', 'codex']) await metered({ session: 'runtime-fixture', kind: 'collaboration', agent: 'designer' }, () => callSeat('Persona', [{ role: 'user', content: 'Reply.' }], { provider, model: '' }));
  const lines = readTableLines([day(new Date())], home);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].tokens_prov, 'estimated'); assert.ok(lines[0].tokens.input > 0); assert.equal(lines[0].usd, undefined);
  assert.equal(lines[1].tokens_prov, 'reported'); assert.equal(lines[1].tokens.input, 11); assert.equal(lines[1].usd, 0.012); assert.equal(lines[1].usd_prov, 'reported');
  assert.equal(lines[2].tokens_prov, 'reported'); assert.equal(lines[2].tokens.output, 9);
  assert.ok(lines.every(l => !JSON.stringify(l).includes('Persona')));
});

test('runtimes command lists profile detections in JSON', () => {
  const profiles = JSON.parse(execFileSync(process.execPath, ['dist/index.js', 'runtimes', '--json'], { env: { ...process.env, PATH: env.PATH }, encoding: 'utf8' }));
  assert.deepEqual(profiles.map(p => p.name), ['hermes', 'openclaw', 'gemini', 'codex']);
  assert.ok(profiles.every(p => p.found && p.path.startsWith(fixtures) && p.version.includes('fixture')));
});


test('CLI discussion carries runtime defaults through seat serialization into collaborations', async t => {
  const { runTableCli } = await import('../../dist/cli-table.js');
  const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;
  mkdirSync(agentsDir, { recursive: true });
  for (const id of ['runtime-designer', 'runtime-reviewer']) writeFileSync(join(agentsDir, `${id}.md`), `You are ${id}.`);
  const previous = process.env.PATH; process.env.PATH = env.PATH; t.after(() => { process.env.PATH = previous; });
  const sink = () => ({ value: '', write(s) { this.value += s; } });
  const output = sink(), error = sink();
  const code = await runTableCli('debate', ['Review a proposal', '--agents', 'runtime-designer,runtime-reviewer', '--seat', 'runtime-designer=openclaw,runtime-reviewer=codex', '--rounds', '1', '--json', '--no-preflight'], { output, error });
  assert.equal(code, 0, error.value);
  const events = output.value.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'turn' && e.text === 'Gateway answer.'));
  assert.ok(events.some(e => e.type === 'turn' && e.text === 'Final answer.'));
});

test('duel uses configured runtime dispatch for turns, artifacts, judging and ledger entries', async t => {
  const { runDuel } = await import('../../dist/table/duel.js');
  const previous = { home: process.env.ROUNDTABLE_HOME, path: process.env.PATH };
  const home = mkdtempSync(join(tmpdir(), 'runtime-duel-'));
  process.env.ROUNDTABLE_HOME = home; process.env.PATH = env.PATH;
  t.after(() => { process.env.ROUNDTABLE_HOME = previous.home; process.env.PATH = previous.path; rmSync(home, { recursive: true, force: true }); setLedgerHome(undefined); });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runtimes: { constructor: { argv: ['duel-runtime'], output: { mode: 'text' } } } }), { mode: 0o600 });
  setLedgerHome(home);
  const { assertSeatCredentials } = await import('../../dist/table/seats.js');
  assert.doesNotThrow(() => assertSeatCredentials([{ id: 'designer', provider: 'constructor' }], {}));
  const seats = [['designer', 'A'], ['reviewer', 'B'], ['judge', 'judge']].map(([name, team]) => ({ id: name, name, team, provider: 'constructor', model: '', prompt: `You are ${name}.` }));
  const events = [];
  const result = await runDuel({ topic: 'A short proposal', teamA: ['designer'], teamB: ['reviewer'], judges: ['judge'], kind: 'text' }, { onEvent(e) { events.push(e); } }, new AbortController().signal, { resolveSeats: () => seats });
  assert.equal(result.aborted, false);
  assert.equal(events.filter(e => e.type === 'prototype' && e.ok).length, 2);
  assert.ok(events.some(e => e.type === 'assessment' && e.verdict === 'APPROVE'));
  const lines = readTableLines([day(new Date())], home);
  assert.ok(lines.length >= 5); assert.ok(lines.every(l => l.provider === 'constructor' && l.tokens_prov === 'estimated'));
});

test('Gemini model-keyed stats aggregate safely and missing stats remain estimated', async () => {
  const spec = { ...BUILTIN_RUNTIMES.gemini, argv: ['json-output'] };
  const stats = { models: { first: { tokens: { input: 3, candidates: 2 } }, second: { tokens: { input: 7, candidates: 5 } } } };
  const result = await runRuntime(spec, JSON.stringify({ response: 'OK', stats }), { env });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 7 });
  assert.equal((await runRuntime(spec, JSON.stringify({ response: 'OK' }), { env })).usage, undefined);
});

test('JSONL filters use the last matching text and sum reported turn usage', async () => {
  const spec = { argv: ['json-output'], output: { mode: 'jsonl', filter: { type: 'message', 'item.kind': ['agent', 'assistant'] }, path: 'item.text' }, usage: { inputTokens: 'usage.input', outputTokens: 'usage.output', costUsd: 'usage.cost' } };
  const events = [
    { type: 'message', item: { kind: 'agent', text: 'Earlier' } },
    { type: 'usage', usage: { input: 3, output: 2, cost: 0.1 } },
    { type: 'message', item: { kind: 'tool', text: 'Ignore' } },
    { type: 'message', item: { kind: 'assistant', text: 'Final' } },
    { type: 'usage', usage: { input: 7, output: 5, cost: 0.2 } },
  ].map(JSON.stringify).join('\n');
  const result = await runRuntime(spec, events, { env });
  assert.equal(result.text, 'Final'); assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 7 });
  assert.ok(Math.abs(result.costUsd - 0.3) < 1e-12);
  await assert.rejects(runRuntime(spec, JSON.stringify({ type: 'ignored', item: { text: 'Ignore' } }), { env }), /no final text/);
});

test('absolute binaries work and successful runs remove abort listeners', async () => {
  const signal = new AbortController().signal;
  const result = await runRuntime({ ...text('argv-echo'), argv: [join(fixtures, 'argv-echo')] }, 'Hello', { env, signal });
  assert.equal(JSON.parse(result.text).stdin, 'Hello');
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});


test('codex and gemini preserve realistic large numeric usage before scrubbing decoded text', async () => {
  for (const name of ['codex', 'gemini']) {
    const builtin = BUILTIN_RUNTIMES[name];
    const spec = { ...builtin, argv: [`large-${name}`, ...builtin.argv.slice(1)] };
    const result = await runRuntime(spec, 'Reply.', { env });
    assert.equal(result.text, 'Large usage answer.');
    assert.deepEqual(result.usage, { inputTokens: 125678, outputTokens: 12345 });
    if (name === 'gemini') assert.equal(result.costUsd, 0.1234);
    // The exact secret contains JSON escapes, so scrubbing must happen after decoding it.
    const secret = 'fixture-"private"-value\nwith\\escapes';
    const scrubbed = await runRuntime({ ...spec, env: ['FIXTURE_SECRET'] }, 'Reply.', { env: { ...env, FIXTURE_SECRET: secret } });
    assert.equal(scrubbed.text, 'Answer: [redacted:env:FIXTURE_SECRET]');
    assert.deepEqual(scrubbed.usage, { inputTokens: 125678, outputTokens: 12345 });
  }
});

test('timeout, abort and overflow bound draining when a detached helper holds output pipes', async () => {
  for (const reason of ['timeout', 'abort', 'overflow']) {
    const root = mkdtempSync(join(tmpdir(), 'runtime-escaped-pipes-'));
    const statePath = join(root, 'state.json');
    const controller = new AbortController();
    const spec = { ...text('escaped-pipes'), argv: ['escaped-pipes', statePath, reason], timeoutMs: reason === 'timeout' ? 500 : 5000, stdoutMaxBytes: 1024 };
    let state;
    const cleanupHelper = () => {
      if (!state && existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (state?.helper > 1) { try { process.kill(-state.helper, 'SIGKILL'); } catch {} }
    };
    let deadline, abort;
    const started = Date.now();
    const run = runRuntime(spec, '', { env, signal: controller.signal });
    try {
      if (reason === 'abort') abort = setTimeout(() => controller.abort(), 500);
      const failure = await Promise.race([
        run.then(() => { throw new Error('Runtime unexpectedly succeeded'); }, error => error),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Runtime hung draining inherited pipes')), 3000); }),
      ]);
      assert.match(failure.message, reason === 'timeout' ? /timed out/ : reason === 'abort' ? /aborted/ : /byte cap.*truncated/);
      assert.ok(Date.now() - started < 2500, 'failure must settle before helper cleanup releases its pipes');
      state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.doesNotThrow(() => process.kill(state.helper, 0), 'the helper still holds the inherited pipes');
      assert.throws(() => process.kill(state.parent, 0), { code: 'ESRCH' }, 'the direct child was reaped');
      assert.equal(existsSync(state.cwd), false, 'the runtime temporary directory was removed');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      clearTimeout(deadline); clearTimeout(abort);
      cleanupHelper();
      await run.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test('frontmatter model fallback is not applied to runtime seats with an unknown model', async t => {
  const previousHome = process.env.ROUNDTABLE_HOME;
  const home = mkdtempSync(join(tmpdir(), 'runtime-no-model-fallback-'));
  process.env.ROUNDTABLE_HOME = home;
  t.after(() => { process.env.ROUNDTABLE_HOME = previousHome; rmSync(home, { recursive: true, force: true }); });
  const script = join(home, 'model-check.mjs'), log = join(home, 'calls.jsonl');
  writeFileSync(script, String.raw`import { appendFileSync } from 'node:fs';
const args = process.argv.slice(3);
appendFileSync(process.argv[2], JSON.stringify(args) + '\n');
if (args.includes('missing-model')) { console.error('unknown model: missing-model (404 model not found)'); process.exitCode = 23; }
else console.log('Default model would succeed.');
`);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runtimes: {
    'model-check': { argv: [process.execPath, script, log], modelFlag: '--model', versionArgv: ['--version'], output: { mode: 'text' } },
  } }), { mode: 0o600 });
  const warnings = [], replacements = [];
  t.mock.method(process.stderr, 'write', line => { warnings.push(line); return true; });
  let apiCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { apiCalls++; throw new Error('Unexpected API call'); });
  const metadata = async () => ({ frontmatter: { provider: 'openai', model: 'missing-model' } });
  // Even the same persona/model previously resolved for an API provider must not affect the runtime.
  await resolveSeats({ agents: ['runtime-agent'], load: metadata });
  const seat = (await prepareSeats({ agents: ['runtime-agent'], load: metadata, seat: 'runtime-agent=model-check:missing-model', env: {} }, { preflight: true })).get('runtime-agent');
  await assert.rejects(callSeat('Persona', [{ role: 'user', content: 'Reply.' }], seat, {
    agent: 'runtime-agent', onModelFallback: model => replacements.push(model),
  }), /Runtime exited with 23; stderr tail: unknown model: missing-model/);
  assert.equal(seat.model, 'missing-model');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [['--model', 'missing-model']]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(replacements, []);
  assert.equal(apiCalls, 0);
});
