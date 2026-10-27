import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSecretRef } from '../../dist/secrets/ref.js';
import { resolveBuiltin, resolveBuiltinSync, secretBackend, secretReason } from '../../dist/secrets/backends.js';
import { resolveSecret, resolveSecretSync } from '../../dist/secrets/broker.js';
import { scrub, scrubArtifact, SCRUB_LITERALS_ENV } from '../../dist/security/secrets.js';
import { childEnv } from '../../dist/security/child-env.js';
import { readUserConfig, loadUserEnvironment, setSecretConfig, unsetConfigEntry } from '../../dist/user-config.js';
import { runTableCli } from '../../dist/cli-table.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fake(dir, name, code) {
  writeFileSync(join(dir, name), `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
}
function restore(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
}

test('strict reference shapes never echo a refused reference', () => {
  for (const [ref, backend, locator] of [
    ['secret://env/ISSUE_LOGIN', 'env', 'ISSUE_LOGIN'],
    ['secret://keychain/roundtable', 'keychain', 'roundtable'],
    ['secret://keychain/roundtable/alice', 'keychain', 'roundtable/alice'],
    ['secret://op/Work/item/credential', 'op', 'Work/item/credential'],
  ]) assert.deepEqual(parseSecretRef(ref), { backend, locator });
  for (const ref of ['secret://env/a', 'secret://env/1A', 'secret://env/' + 'A'.repeat(129), 'secret://env/A/B',
    'secret://keychain/a/../b', 'secret://keychain/a..b', 'secret://keychain/a%2fb', 'secret://keychain/a b',
    'secret://keychain/a\nb', 'secret://keychain/a?b', 'secret://keychain/a#b', 'secret://keychain/a/b/c',
    'secret://keychain/', 'secret://op/v/i', 'secret://op/v/i/f/', 'op://v/i/f', 'secret://cloud/private-locator']) {
    assert.throws(() => parseSecretRef(ref), e => e.message === 'Expected secret://env/NAME, secret://keychain/service[/account] or secret://op/vault/item/field.');
  }
});

for (const [id, platform, binary, locator, argv] of [
  ['keychain', 'darwin', 'security', 'table/alice', ['find-generic-password', '-s', 'table', '-a', 'alice', '-w']],
  ['keychain', 'linux', 'secret-tool', 'table/alice', ['lookup', 'service', 'table', 'account', 'alice']],
  ['op', 'linux', 'op', 'vault/item/field', ['read', '--no-newline', 'op://vault/item/field']],
]) test(`${binary}: success, safe errors, timeout, empty and capped output`, async t => {
  const dir = fixture(t), source = { PATH: dir, HOME: dir, OP_SESSION_test: 'session', DBUS_SESSION_BUS_ADDRESS: 'bus', XDG_RUNTIME_DIR: dir, ANTHROPIC_API_KEY: 'must-not-pass', UNRELATED: 'no' };
  const options = { timeoutMs: 5000 };
  fake(dir, binary, `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(argv))}) process.exit(7); if (process.env.ANTHROPIC_API_KEY || process.env.UNRELATED || !process.env.OP_SESSION_test) process.exit(8); process.stdout.write('opaque-login-value\\n');`);
  assert.equal(await resolveBuiltin(id, locator, options, source, platform), 'opaque-login-value');
  assert.equal(resolveBuiltinSync(id, locator, options, source, platform), 'opaque-login-value');
  for (const [code, reason] of [
    ["process.stderr.write('account-private: not found'); process.exit(44)", 'not found'],
    ["process.stderr.write('account-private: locked'); process.exit(2)", 'locked or denied'],
    ["process.stdout.write('')", 'empty result'],
    ["setTimeout(() => {}, 10000)", 'timed out'],
    ["process.stdout.write('x'.repeat(70000))", 'output too large'],
  ]) {
    fake(dir, binary, code);
    await assert.rejects(resolveBuiltin(id, locator, { timeoutMs: reason === 'timed out' ? 80 : 5000 }, source, platform), { message: reason });
    assert.throws(() => resolveBuiltinSync(id, locator, { timeoutMs: reason === 'timed out' ? 80 : 5000 }, source, platform), { message: reason });
  }
});

test('env backend, missing binaries, unsupported hosts and minimal secret-cli profile', async () => {
  assert.equal(await resolveBuiltin('env', 'LOGIN', { timeoutMs: 10 }, { LOGIN: 'line\n' }), 'line\n');
  await assert.rejects(resolveBuiltin('env', 'LOGIN', { timeoutMs: 10 }, {}), { message: 'not found' });
  await assert.rejects(resolveBuiltin('env', 'LOGIN', { timeoutMs: 10 }, { LOGIN: '' }), { message: 'empty result' });
  await assert.rejects(resolveBuiltin('op', 'v/i/f', { timeoutMs: 10 }, { PATH: '' }), { message: 'op not installed' });
  await assert.rejects(resolveBuiltin('keychain', 's/a', { timeoutMs: 10 }, {}, 'win32'), { message: 'not supported' });
  assert.equal(secretBackend('env').id, 'env');
  assert.equal(secretReason(new Error('private-value')), 'locked or denied');
  assert.deepEqual(childEnv('secret-cli', {}, { PATH: '/bin', OP_SESSION_x: 'op', DBUS_SESSION_BUS_ADDRESS: 'bus', XDG_RUNTIME_DIR: '/run', OPENAI_API_KEY: 'private', OTHER: 'no' }), { PATH: '/bin', OP_SESSION_x: 'op', DBUS_SESSION_BUS_ADDRESS: 'bus', XDG_RUNTIME_DIR: '/run' });
});

test('broker caches values and registers short and opaque credentials at call time', async t => {
  restore(t, SCRUB_LITERALS_ENV);
  restore(t, 'ISSUE_LOGIN_CACHE', 'opaque-fixture-login');
  const ref = 'secret://env/ISSUE_LOGIN_CACHE';
  assert.equal(await resolveSecret(ref), 'opaque-fixture-login');
  process.env.ISSUE_LOGIN_CACHE = 'changed';
  assert.equal(resolveSecretSync(ref, 20), 'opaque-fixture-login');
  assert.ok(!scrub('before opaque-fixture-login after').includes('opaque-fixture-login'));
  assert.ok(!scrubArtifact('before opaque-fixture-login after').includes('opaque-fixture-login'));
  restore(t, 'ISSUE_SHORT_LOGIN', 'xy7');
  await resolveSecret('secret://env/ISSUE_SHORT_LOGIN');
  assert.ok(!scrubArtifact('xy7').includes('xy7'));
});

test('startup precedence, unavailable references, off switch and invalid entries', t => {
  const home = fixture(t), envFile = join(home, 'provider.env'), pkg = join(home, 'package.env');
  restore(t, SCRUB_LITERALS_ENV);
  writeFileSync(envFile, 'ANTHROPIC_API_KEY=plaintext-fallback\nOPENAI_API_KEY=plain-openai\n', { mode: 0o600 });
  writeFileSync(pkg, 'ANTHROPIC_API_KEY=package\n');
  const save = secrets => writeFileSync(join(home, 'config.json'), JSON.stringify({ envFile, secrets }), { mode: 0o600 });
  save({ ANTHROPIC_API_KEY: 'secret://env/BOOTSTRAP_LOGIN_OK' });
  const shell = { ANTHROPIC_API_KEY: 'shell', BOOTSTRAP_LOGIN_OK: 'reference-credential' };
  loadUserEnvironment({ home, env: shell, packageEnvFile: pkg });
  assert.equal(shell.ANTHROPIC_API_KEY, 'shell');
  const env = { BOOTSTRAP_LOGIN_OK: 'reference-credential' };
  loadUserEnvironment({ home, env, packageEnvFile: pkg });
  assert.equal(env.ANTHROPIC_API_KEY, 'reference-credential');
  save({ ANTHROPIC_API_KEY: 'secret://env/BOOTSTRAP_MISSING' });
  const failed = {}, warnings = [];
  loadUserEnvironment({ home, env: failed, packageEnvFile: pkg, warn: m => warnings.push(m) });
  assert.equal(failed.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(warnings, ['ANTHROPIC_API_KEY: secret unavailable (not found)']);
  const off = { ROUNDTABLE_SECRETS: 'OFF' };
  loadUserEnvironment({ home, env: off });
  assert.equal(off.ANTHROPIC_API_KEY, 'plaintext-fallback');
  save({ ANTHROPIC_API_KEY: 'a-private-ref', UNKNOWN: 'secret://env/UNKNOWN' });
  const invalid = [];
  assert.deepEqual(readUserConfig(home, m => invalid.push(m)).secrets, {});
  readUserConfig(home, m => invalid.push(m));
  assert.equal(invalid.length, 2);
  assert.ok(invalid.every(m => !m.includes('a-private-ref')));
});

test('broker credentials preserve launcher endpoints and env files supply no endpoints', t => {
  const home = fixture(t), envFile = join(home, 'compatible.env');
  restore(t, SCRUB_LITERALS_ENV);
  writeFileSync(envFile, 'OPENAI_COMPATIBLE_BASE_URL=https://fixture.invalid/v1\nOPENAI_COMPATIBLE_API_KEY=file-fallback\n', { mode: 0o600 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ envFile, secrets: { OPENAI_COMPATIBLE_API_KEY: 'secret://env/COMPATIBLE_BROKER_LOGIN' } }), { mode: 0o600 });
  const env = { COMPATIBLE_BROKER_LOGIN: 'compatible-broker-fixture' };
  loadUserEnvironment({ home, env });
  assert.equal(env.OPENAI_COMPATIBLE_BASE_URL, undefined);
  assert.ok(env.OPENAI_COMPATIBLE_API_KEY === 'compatible-broker-fixture');
  const shellKey = { OPENAI_COMPATIBLE_API_KEY: 'shell-fixture' };
  loadUserEnvironment({ home, env: shellKey });
  assert.equal(shellKey.OPENAI_COMPATIBLE_BASE_URL, undefined);
  assert.ok(shellKey.OPENAI_COMPATIBLE_API_KEY === 'shell-fixture');
  const shellUrl = { OPENAI_COMPATIBLE_BASE_URL: 'https://shell.invalid/v1', ROUNDTABLE_SECRETS: 'off' };
  loadUserEnvironment({ home, env: shellUrl });
  assert.equal(shellUrl.OPENAI_COMPATIBLE_BASE_URL, 'https://shell.invalid/v1');
  assert.equal(shellUrl.OPENAI_COMPATIBLE_API_KEY, undefined);
});

test('config secret set/unset/show and secrets check never print a value or locator', async t => {
  const home = fixture(t);
  restore(t, 'ROUNDTABLE_HOME', home);
  restore(t, 'CLI_LOGIN_FIXTURE', 'opaque-cli-login-fixture');
  restore(t, SCRUB_LITERALS_ENV);
  let out = '', err = '';
  const io = { output: { write(s) { out += s; } }, error: { write(s) { err += s; } } };
  assert.equal(await runTableCli('config', ['set', 'secret', 'ANTHROPIC_API_KEY', 'secret://env/CLI_LOGIN_FIXTURE'], io), 0);
  assert.equal(await runTableCli('config', ['show'], io), 0);
  assert.match(out, /ANTHROPIC_API_KEY: env/);
  assert.equal(await runTableCli('secrets', ['check'], io), 0);
  assert.match(out, /ANTHROPIC_API_KEY: ok/);
  setSecretConfig('OPENAI_API_KEY', 'secret://env/CLI_LOGIN_MISSING', home);
  assert.equal(await runTableCli('secrets', ['check'], io), 1);
  assert.match(out, /OPENAI_API_KEY: not found/);
  assert.equal(await runTableCli('config', ['unset', 'secret', 'ANTHROPIC_API_KEY'], io), 0);
  assert.equal(readUserConfig(home).secrets.ANTHROPIC_API_KEY, undefined);
  assert.ok(!out.includes('CLI_LOGIN_FIXTURE') && !out.includes('opaque-cli-login-fixture') && !err.includes('opaque-cli-login-fixture'));
  unsetConfigEntry('secrets', 'OPENAI_API_KEY', home);
  assert.throws(() => setSecretConfig('PATH', 'secret://env/CLI_LOGIN_FIXTURE', home), /allowed provider/);
  const child = spawnSync(process.execPath, ['dist/index.js', 'secrets', 'check'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ROUNDTABLE_HOME: home, ROUNDTABLE_DOTENV: 'off', ROUNDTABLE_SECRETS: 'off' } });
  assert.equal(child.status, 0, child.stderr);
});

test('startup budget exhaustion skips unresolved keys; workers and hooks skip references', t => {
  const home = fixture(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ secrets: { ANTHROPIC_API_KEY: 'secret://env/BOOTSTRAP_BUDGET_LOGIN' } }), { mode: 0o600 });
  const now = Date.now;
  let tick = 0;
  const env = { BOOTSTRAP_BUDGET_LOGIN: 'private-budget-fixture' }, warnings = [];
  try {
    Date.now = () => (tick++ * 20_001);
    loadUserEnvironment({ home, env, warn: m => warnings.push(m) });
  } finally { Date.now = now; }
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(warnings, ['ANTHROPIC_API_KEY: secret unavailable (timed out)']);
  const bootstrap = new URL('../../dist/env.js', import.meta.url).href;
  for (const args of [['hook', 'pre-tool-use'], ['mcp', '--worker']]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv = [process.execPath, 'index.js', ...${JSON.stringify(args)}]; await import(${JSON.stringify(bootstrap)}); console.log(process.env.ANTHROPIC_API_KEY ?? 'unset');`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ROUNDTABLE_HOME: home, BOOTSTRAP_BUDGET_LOGIN: 'private-budget-fixture' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'unset');
    assert.equal(child.stderr, '');
  }
});

test('registered backend calls are deduplicated and arbitrary backend errors stay private', async t => {
  const { registerSecretBackend } = await import('../../dist/secrets/backends.js');
  const original = secretBackend('op');
  t.after(() => registerSecretBackend(original));
  restore(t, SCRUB_LITERALS_ENV);
  let calls = 0;
  registerSecretBackend({ id: 'op', async resolve(locator, options) {
    calls++;
    assert.equal(locator, 'Fixture/item/opaque');
    assert.equal(options.timeoutMs, 30_000);
    assert.ok(options.signal instanceof AbortSignal);
    return 'registered-backend-private-fixture';
  } });
  assert.deepEqual(await Promise.all([resolveSecret('secret://op/Fixture/item/opaque'), resolveSecret('secret://op/Fixture/item/opaque')]), ['registered-backend-private-fixture', 'registered-backend-private-fixture']);
  assert.equal(calls, 1);
  assert.ok(!scrubArtifact('registered-backend-private-fixture').includes('registered-backend-private-fixture'));
  registerSecretBackend({ id: 'op', resolve() { throw new Error('private-backend-error-fixture'); } });
  await assert.rejects(resolveSecret('secret://op/Fixture/item/failure'), { message: 'locked or denied' });
});
