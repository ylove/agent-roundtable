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
  const expected = { hermes: 'A useful answer.', openclaw: 'Gateway answer.', gemini: 'Structured answer.', agy: 'ok\n', codex: 'Final answer.' };
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
  assert.deepEqual(echo.args, ['-p', '\n' + prompt, '--model', 'safe-model:1']);
  assert.equal(echo.stdin, ''); assert.notEqual(echo.cwd, process.cwd()); assert.equal(existsSync(echo.cwd), false);
  const stdin = JSON.parse((await runRuntime(text('argv-echo'), prompt, { env })).text);
  assert.equal(stdin.stdin, prompt); assert.deepEqual(stdin.args, []);
  for (const model of ['--bad', '-m', 'two words', 'x;echo', '$(x)', 'x\n']) await assert.rejects(runRuntime(spec, prompt, { env, model }), /model/);
  const echoCwd = JSON.parse((await runRuntime({ ...text('argv-echo'), cwd: fixtures }, prompt, { env })).text);
  assert.equal(echoCwd.cwd, fixtures); assert.ok(existsSync(fixtures));
});

test('agy seat passes -p values on argv (a dash-leading prompt gets a leading newline), its model and safety flags; stderr warning is harmless', async () => {
  const spec = BUILTIN_RUNTIMES.agy;
  for (const prompt of ['-CHECK_ARGV ; $(no-shell)', '/CHECK_ARGV skill-name']) {
    const result = await runRuntime(spec, prompt, { env, model: 'gemini-3.8-flash-medium' });
    const report = JSON.parse(result.text);
    assert.deepEqual(report.args, [
      '-p', prompt.startsWith('-') ? `\n${prompt}` : prompt, '--output-format', 'json', '--mode', 'plan', '--disable-slash-commands',
      '--model', 'gemini-3.8-flash-medium',
    ]);
    assert.equal(report.stdin, '');
    assert.equal(existsSync(report.cwd), false);
    assert.deepEqual(result.usage, { inputTokens: 7709, outputTokens: 1 });
    assert.equal(result.costUsd, undefined);
    assert.ok(!report.args.includes('--dangerously-skip-permissions'));
  }
  assert.deepEqual(spec.versionArgv, ['--version']);
  assert.equal(runtimeRegistry({ agy: { timeoutMs: 5000 } }).agy.timeoutMs, 5000);
  assert.throws(() => runtimeRegistry({ agy: { modelFlag: '-m' } }), /Built-in runtime overrides/);
  assert.deepEqual(parseSeat('x=agy:gemini-3.8-flash-medium'), { agent: 'x', provider: 'agy', model: 'gemini-3.8-flash-medium' });
  validateSeatSpecs({ x: { provider: 'agy', model: 'gemini-3.8-flash-medium' } });
});

test('agy exit-0 ERROR is a bounded scrubbed failure; SUCCESS without a reply also fails', async () => {
  const secret = 'fixture-agy-private-value';
  await assert.rejects(runRuntime(BUILTIN_RUNTIMES.agy, `FAIL_ME ${secret} ${'x'.repeat(2000)}`, {
    env: { ...env, FIXTURE_SECRET: secret },
  }), error => {
    assert.match(error.message, /failure status: ERROR: boom FAIL_ME \[redacted:env:FIXTURE_SECRET\]/);
    assert.doesNotMatch(error.message, /fixture-agy-private-value/);
    assert.ok(error.message.length < 550);
    return true;
  });
  await assert.rejects(runRuntime(BUILTIN_RUNTIMES.agy, 'DENY_ME', { env }), /no final text/);
  const spec = { ...BUILTIN_RUNTIMES.agy, argv: ['json-output'] };
  for (const status of ['ERROR', 'CANCELLED', null, undefined]) {
    await assert.rejects(runRuntime(spec, JSON.stringify({ status, response: 'A reply must not hide failure', error: 'boom' }), { env }), /failure status/);
  }
  const result = await runRuntime(spec, JSON.stringify({ status: 'SUCCESS', response: 'ok', usage: {
    input_tokens: 7709, output_tokens: 1, thinking_tokens: 300, total_tokens: 8010,
  } }), { env });
  assert.deepEqual(result.usage, { inputTokens: 7709, outputTokens: 1 });
  assert.equal(result.costUsd, undefined);
});

test('JSON result status configuration validates paths, values and allowed fields', () => {
  const spec = { argv: ['json-output'], output: { mode: 'json', path: 'response' } };
  validateRuntimeSpec({ ...spec, output: BUILTIN_RUNTIMES.agy.output });
  for (const status of [null, {}, { path: '__proto__.status', success: 'SUCCESS' },
    { path: 'status', success: '' }, { path: 'status', success: 'SUCCESS', errorPath: 'constructor' },
    { path: 'status', success: 'SUCCESS', typo: true }]) {
    assert.throws(() => validateRuntimeSpec({ ...spec, output: { ...spec.output, status } }), /output status/);
  }
  for (const output of [{ mode: 'text' }, { mode: 'jsonl', path: 'response', filter: { type: 'result' } }]) {
    assert.throws(() => validateRuntimeSpec({ ...spec, output: { ...output, status: { path: 'status', success: 'SUCCESS' } } }), /output status/);
  }
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

test('Codex nonzero JSONL stdout reports an unsupported model with empty stderr', async () => {
  const spec = { ...BUILTIN_RUNTIMES.codex, argv: ['stdout-fail', ...BUILTIN_RUNTIMES.codex.argv.slice(1)] };
  await assert.rejects(runRuntime(spec, '', { env, model: 'not-a-model' }), error => {
    assert.match(error.message, /Runtime exited with 1; stdout error: The 'not-a-model' model is not supported when using Codex with a ChatGPT account/);
    assert.doesNotMatch(error.message, /stderr tail/);
    return true;
  });
});

test('stdout error summaries handle JSON/JSONL error shapes and ignore malformed events', async () => {
  const jsonl = BUILTIN_RUNTIMES.codex.output;
  for (const [output, content, expected] of [
    [jsonl, 'not json\nnull\n[]\n42\n' + JSON.stringify({ type: 'turn.failed', error: 'unknown model' }) + '\n' + JSON.stringify({ type: 'turn.failed', error: { message: 42 } }), 'unknown model'],
    [jsonl, JSON.stringify({ type: 'error', error: { message: 'authentication failed' } }), 'authentication failed'],
    [jsonl, JSON.stringify({ type: 'error', message: 'connection refused' }), 'connection refused'],
    [{ mode: 'json', path: 'response' }, JSON.stringify({ error: { message: 'account unavailable' } }), 'account unavailable'],
    [{ mode: 'json', path: 'response' }, JSON.stringify({ error: 'unsupported model' }), 'unsupported model'],
  ]) {
    await assert.rejects(runRuntime({ argv: ['stdout-fail'], output }, content, { env }), error => {
      assert.ok(error.message.includes(`stdout error: ${expected}`), error.message);
      assert.ok(error.message.length < 300);
      return true;
    });
  }
  for (const content of ['invalid JSON', 'null', '[]', JSON.stringify({ error: { message: { private: 'not a message' } } }),
    JSON.stringify({ type: 'item.completed', error: 'not an error event' })]) {
    await assert.rejects(runRuntime({ argv: ['stdout-fail'], output: jsonl }, content, { env }), { message: 'Runtime exited with 1' });
  }
});

test('stdout diagnostics are scrubbed after JSON decoding, capped, and retain stderr', async () => {
  const secret = 'fixture-"private"-value\nwith\\escapes';
  const output = BUILTIN_RUNTIMES.codex.output;
  const spec = { argv: ['stdout-fail', '--stderr'], output, env: ['FIXTURE_SECRET'] };
  const content = JSON.stringify({ type: 'turn.failed', error: { message: `Unsupported model ${secret}: ${'x'.repeat(5000)}` } });
  await assert.rejects(runRuntime(spec, content, { env: { ...env, FIXTURE_SECRET: secret } }), error => {
    assert.doesNotMatch(error.message, /fixture-|private|escapes/);
    assert.match(error.message, /stdout error: Unsupported model \[redacted:env:FIXTURE_SECRET\]/);
    assert.match(error.message, /stderr tail: Extra diagnostic: \[redacted:env:FIXTURE_SECRET\]/);
    assert.ok(error.message.length < 2200);
    return true;
  });
});

test('text failures use a capped scrubbed stdout tail and keep stderr', async () => {
  const secret = 'fixture-private-stdout-value';
  await assert.rejects(runRuntime({ ...text('stdout-fail'), argv: ['stdout-fail', '--stderr'], env: ['FIXTURE_SECRET'] },
    `OUTSIDE-TAIL-${'x'.repeat(5000)}\nFailure detail: ${secret}`, { env: { ...env, FIXTURE_SECRET: secret } }), error => {
    assert.match(error.message, /stdout tail: .*\nFailure detail: \[redacted:env:FIXTURE_SECRET\]/);
    assert.match(error.message, /stderr tail: Extra diagnostic/);
    assert.doesNotMatch(error.message, /OUTSIDE-TAIL|fixture-private-stdout-value/);
    assert.ok(error.message.length < 2200);
    return true;
  });
});

test('argv prompt limits use bytes, name the runtime, and recommend stdin before spawning', async () => {
  for (const runtimeName of ['hermes', 'openclaw', 'gemini', 'agy']) {
    for (const prompt of ['x'.repeat(100 * 1024 + 1), '界'.repeat(35_000)]) {
      await assert.rejects(runRuntime(BUILTIN_RUNTIMES[runtimeName], prompt, { env, runtimeName }), error => {
        assert.ok(error.message.startsWith(`Runtime ${runtimeName}: an argument exceeds the 100 KiB limit`));
        assert.match(error.message, /stdin-capable runtime profile or override argv in config.json/);
        assert.doesNotMatch(error.message, /E2BIG|spawn failed|界/);
        return true;
      });
    }
  }
  const boundary = 'x'.repeat(100 * 1024);
  const echoed = await runRuntime({ argv: ['argv-echo', '{prompt}'], output: { mode: 'text' } }, boundary, { env });
  assert.deepEqual(JSON.parse(echoed.text).args, [boundary]);
  assert.equal((await runRuntime(BUILTIN_RUNTIMES.codex, 'x'.repeat(200 * 1024), { env })).text, 'Final answer.');
});

test('total argv byte limit also rejects many individually small arguments', async () => {
  const spec = { ...text('argv-echo'), argv: ['argv-echo', ...Array(40).fill('x'.repeat(3500))] };
  await assert.rejects(runRuntime(spec, '', { env, runtimeName: 'custom-agent' }), {
    message: 'Runtime custom-agent: total arguments exceed the 128 KiB limit; use a stdin-capable runtime profile or override argv in config.json to send the prompt on stdin.',
  });
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
  const custom = { argv: [join(fixtures, 'argv-echo')], output: { mode: 'text' }, modelFlag: '--model' };
  const registry = runtimeRegistry({ custom, hermes: { timeoutMs: 1000, argv: [join(fixtures, 'hermes'), '{prompt}'] } });
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
  for (const provider of ['openclaw', 'gemini', 'codex', 'agy']) await metered({ session: 'runtime-fixture', kind: 'collaboration', agent: 'designer' }, () => callSeat('Persona', [{ role: 'user', content: 'Reply.' }], { provider, model: '' }));
  const lines = readTableLines([day(new Date())], home);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].tokens_prov, 'estimated'); assert.ok(lines[0].tokens.input > 0); assert.equal(lines[0].usd, undefined);
  assert.equal(lines[1].tokens_prov, 'reported'); assert.equal(lines[1].tokens.input, 11); assert.equal(lines[1].usd, 0.012); assert.equal(lines[1].usd_prov, 'reported');
  assert.equal(lines[2].tokens_prov, 'reported'); assert.equal(lines[2].tokens.output, 9);
  assert.equal(lines[3].provider, 'agy'); assert.equal(lines[3].tokens_prov, 'reported');
  assert.deepEqual(lines[3].tokens, { input: 7709, output: 1, cache_read: 0, cache_write: 0 }); assert.equal(lines[3].usd, undefined);
  assert.ok(lines.every(l => !JSON.stringify(l).includes('Persona')));
});

test('runtimes command lists profile detections in JSON', () => {
  const profiles = JSON.parse(execFileSync(process.execPath, ['dist/index.js', 'runtimes', '--json'], { env: { ...process.env, PATH: env.PATH, ROUNDTABLE_DOTENV: 'off' }, encoding: 'utf8' }));
  assert.deepEqual(profiles.map(p => p.name), ['hermes', 'openclaw', 'gemini', 'agy', 'codex']);
  assert.ok(profiles.every(p => p.found && p.path.startsWith(fixtures) && p.version.includes('fixture')));
});

test('doctor discovers agy through the default registry', () => {
  // Other optional probes/credentials can fail; the runtime check must still appear.
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['dist/index.js', 'doctor', '--json'], {
      env: { ...process.env, PATH: env.PATH }, encoding: 'utf8', timeout: 15_000,
    });
  } catch (error) {
    assert.equal(error.status, 1);
    stdout = error.stdout;
  }
  const result = JSON.parse(stdout);
  const check = result.checks.find(c => c.id === 'runtime-agy');
  assert.ok(check);
  assert.equal(check.ok, true);
  assert.equal(check.essential, false);
});

test('general live runtime smoke excludes agy without its dedicated opt-in', () => {
  const stdout = execFileSync(process.execPath, ['test/live-smoke.mjs'], {
    env: { ...process.env, PATH: env.PATH, ROUNDTABLE_LIVE_RUNTIMES: 'agy', ROUNDTABLE_TEST_AGY: '0', ROUNDTABLE_LIVE_TEST: '0' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.match(stdout, /skip agy: set ROUNDTABLE_TEST_AGY=1/);
  assert.doesNotMatch(stdout, /ok\s+agy/);
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
  writeFileSync(join(home, 'config.json'), JSON.stringify({ runtimes: { constructor: { argv: [join(fixtures, 'duel-runtime')], output: { mode: 'text' } } } }), { mode: 0o600 });
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
  await resolveSeats({ agents: ['runtime-agent'], env: { OPENAI_API_KEY: 'fixture-key' }, load: metadata });
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
