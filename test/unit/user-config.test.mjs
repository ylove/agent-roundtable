import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync, readFileSync, rmSync, copyFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { allowedEnvKey, loadUserEnvironment, readUserConfig, setUserConfig } from '../../dist/user-config.js';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'table-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'private.env');
  writeFileSync(file, '', { mode: 0o600 });
  return { home, file };
}
test('shell > package > pointed file; both files copy only allowed keys', t => {
  const { home, file } = fixture(t);
  const packageEnvFile = join(home, 'package.env');
  writeFileSync(packageEnvFile, 'OPENAI_API_KEY=package\nPACKAGE_SETTING=enabled\nOLLAMA_URL=http://127.0.0.1:11434\n');
  writeFileSync(file, ['ANTHROPIC_API_KEY=external', 'OPENAI_API_KEY=external', 'TOGETHER_API_KEY=external', 'REPLICATE_API_TOKEN=external', 'OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1', 'OPENAI_COMPATIBLE_API_KEY=external', 'ROUNDTABLE_ANTHROPIC_MODEL=sonnet', 'ROUNDTABLE_EXECUTION_MODEL=custom', 'ROUNDTABLE_AGENTS_DIR=/unrelated', 'ROUNDTABLE_HOME=/unrelated', 'DATABASE_PASSWORD=unrelated', 'PATH=/unrelated'].join('\n'));
  const env = { ROUNDTABLE_ENV_FILE: file, ANTHROPIC_API_KEY: 'shell', OPENAI_API_KEY: 'shell' };
  const warnings = [];
  loadUserEnvironment({ home, env, packageEnvFile, warn: m => warnings.push(m) });
  assert.equal(env.ANTHROPIC_API_KEY, 'shell');
  assert.equal(env.OPENAI_API_KEY, 'shell');
  assert.equal(env.TOGETHER_API_KEY, 'external');
  assert.equal(env.REPLICATE_API_TOKEN, 'external');
  assert.equal(env.OPENAI_COMPATIBLE_API_KEY, 'external');
  assert.equal(env.ROUNDTABLE_ANTHROPIC_MODEL, 'sonnet');
  assert.equal(env.ROUNDTABLE_EXECUTION_MODEL, 'custom');
  assert.equal(env.PACKAGE_SETTING, undefined);
  assert.equal(env.OLLAMA_URL, 'http://127.0.0.1:11434');
  for (const key of ['DATABASE_PASSWORD', 'PATH', 'ROUNDTABLE_HOME', 'ROUNDTABLE_AGENTS_DIR']) assert.equal(env[key], undefined);
  assert.deepEqual(warnings, []);
  assert.equal(allowedEnvKey('ROUNDTABLE_MODEL'), false);
});
test('persisted settings use a private config; env pointer and agents directory win', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, 'ANTHROPIC_API_KEY=config-file\n');
  const agents = join(home, 'agents'); mkdirSync(agents);
  setUserConfig('envFile', file, home); setUserConfig('agentsDir', agents, home);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.deepEqual(readUserConfig(home), { envFile: file, agentsDir: agents });
  const env = { ROUNDTABLE_HOME: home };
  loadUserEnvironment({ env });
  assert.equal(env.ROUNDTABLE_AGENTS_DIR, agents);
  assert.equal(env.ANTHROPIC_API_KEY, 'config-file');
  const other = join(home, 'other.env'); writeFileSync(other, 'ANTHROPIC_API_KEY=env-pointer\n', { mode: 0o600 });
  const override = { ROUNDTABLE_HOME: home, ROUNDTABLE_ENV_FILE: other, ROUNDTABLE_AGENTS_DIR: '/existing' };
  loadUserEnvironment({ env: override });
  assert.equal(override.ANTHROPIC_API_KEY, 'env-pointer');
  assert.equal(override.ROUNDTABLE_AGENTS_DIR, '/existing');
});
test('off skips both env files; empty shell values are preserved', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, 'ANTHROPIC_API_KEY=external\n');
  const env = { ROUNDTABLE_ENV_FILE: file, ROUNDTABLE_DOTENV: ' OFF ' };
  loadUserEnvironment({ home, env, packageEnvFile: file });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const empty = { ROUNDTABLE_ENV_FILE: file, ANTHROPIC_API_KEY: '' };
  loadUserEnvironment({ home, env: empty, packageEnvFile: file });
  assert.equal(empty.ANTHROPIC_API_KEY, '');
});
test('paths and values never occur in warnings, including permission warnings', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, 'ANTHROPIC_API_KEY=private-value\n'); chmodSync(file, 0o644);
  const warnings = [];
  loadUserEnvironment({ home, env: { ROUNDTABLE_ENV_FILE: file }, warn: m => warnings.push(m) });
  for (const envFile of ['relative.env', home, join(home, 'missing')]) loadUserEnvironment({ home, env: { ROUNDTABLE_ENV_FILE: envFile }, warn: m => warnings.push(m) });
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /group or world read/);
  assert.ok(warnings.every(m => !m.includes(home) && !m.includes('private-value') && !m.includes('relative.env')));
});
test('refuses relative paths, directories, missing files and malformed config without echoing paths', t => {
  const { home, file } = fixture(t);
  for (const value of ['relative.env', home, join(home, 'missing')]) assert.throws(() => setUserConfig('envFile', value, home), e => !e.message.includes(value));
  assert.throws(() => setUserConfig('agentsDir', file, home), /accessible directory/);
  writeFileSync(join(home, 'config.json'), '{invalid private configuration');
  assert.throws(() => readUserConfig(home), { message: 'Unable to read user configuration.' });
  const warnings = [];
  loadUserEnvironment({ home, env: {}, warn: m => warnings.push(m) });
  assert.deepEqual(warnings, ['Unable to read user configuration.']);
});
test('env bootstrap applies agentsDir before config module evaluation', t => {
  const { home, file } = fixture(t);
  const agents = join(home, 'agents'); mkdirSync(agents);
  setUserConfig('agentsDir', agents, home);
  const script = `await import(${JSON.stringify(pathToFileURL(resolve('dist/env.js')).href)}); const c = await import(${JSON.stringify(pathToFileURL(resolve('dist/config.js')).href)}); console.log(JSON.stringify(c.AGENTS_DIR));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ROUNDTABLE_HOME: home, ROUNDTABLE_DOTENV: 'off' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), agents);
});
test('package loader and pointed loader compose in a fresh isolated package', t => {
  const { home, file } = fixture(t);
  mkdirSync(join(home, 'dist'));
  for (const name of ['env.js', 'user-config.js', 'provider-ids.js']) copyFileSync(resolve('dist', name), join(home, 'dist', name));
  for (const name of ['secrets', 'security', 'connectors', 'serve', 'http']) cpSync(resolve('dist', name), join(home, 'dist', name), { recursive: true });
  copyFileSync(resolve('dist/executables.js'), join(home, 'dist/executables.js'));
  mkdirSync(join(home, 'dist', 'runtimes'));
  copyFileSync(resolve('dist/runtimes/spec.js'), join(home, 'dist/runtimes/spec.js'));
  symlinkSync(resolve('node_modules'), join(home, 'node_modules'), 'dir');
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=package\n');
  writeFileSync(file, 'ANTHROPIC_API_KEY=external\nOPENAI_API_KEY=external\n');
  const script = `await import(${JSON.stringify(pathToFileURL(join(home, 'dist/env.js')).href)}); console.log(JSON.stringify([process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ROUNDTABLE_HOME: home, ROUNDTABLE_ENV_FILE: file, ANTHROPIC_API_KEY: 'shell', OPENAI_API_KEY: 'shell-openai' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['shell', 'shell-openai']);
});
test('the OpenAI-compatible endpoint and key are imported together, only when the shell set neither', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, 'OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1\nOPENAI_COMPATIBLE_API_KEY=file-key\n', { mode: 0o600 });
  const mixed = { ROUNDTABLE_ENV_FILE: file, OPENAI_COMPATIBLE_API_KEY: 'shell-key' };
  loadUserEnvironment({ home, env: mixed, warn: () => {} });
  assert.equal(mixed.OPENAI_COMPATIBLE_API_KEY, 'shell-key');
  assert.equal(mixed.OPENAI_COMPATIBLE_BASE_URL, undefined);
  const clean = { ROUNDTABLE_ENV_FILE: file };
  loadUserEnvironment({ home, env: clean, warn: () => {} });
  assert.equal(clean.OPENAI_COMPATIBLE_BASE_URL, 'http://127.0.0.1:1234/v1');
  assert.equal(clean.OPENAI_COMPATIBLE_API_KEY, 'file-key');
});
test('an env file or config.json that others can modify is refused without naming a path', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, 'OPENAI_API_KEY=file-key\n', { mode: 0o600 });
  chmodSync(file, 0o666);
  const env = { ROUNDTABLE_ENV_FILE: file }, warnings = [];
  loadUserEnvironment({ home, env, warn: m => warnings.push(m) });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(home));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ envFile: file }), { mode: 0o600 });
  chmodSync(join(home, 'config.json'), 0o666);
  assert.throws(() => readUserConfig(home), /Unable to read user configuration/);
});
test('the package .env cannot complete an endpoint and key pair the shell started', t => {
  const { home } = fixture(t);
  const packageEnvFile = join(home, 'package.env');
  writeFileSync(packageEnvFile, 'OPENAI_COMPATIBLE_BASE_URL=https://package.example/v1\nOPENAI_COMPATIBLE_API_KEY=package-key\n');
  const env = { OPENAI_COMPATIBLE_BASE_URL: 'https://shell.example/v1' };
  loadUserEnvironment({ home, env, packageEnvFile, warn: () => {} });
  assert.equal(env.OPENAI_COMPATIBLE_BASE_URL, 'https://shell.example/v1');
  assert.equal(env.OPENAI_COMPATIBLE_API_KEY, undefined);
  const fresh = {};
  loadUserEnvironment({ home, env: fresh, packageEnvFile, warn: () => {} });
  assert.deepEqual([fresh.OPENAI_COMPATIBLE_BASE_URL, fresh.OPENAI_COMPATIBLE_API_KEY], ['https://package.example/v1', 'package-key']);
});

const hostile = [
  'NODE_TLS_REJECT_UNAUTHORIZED=0', 'NODE_EXTRA_CA_CERTS=/private/certs',
  'HTTPS_PROXY=https://proxy.example', 'ALL_PROXY=https://proxy.example',
  'ROUNDTABLE_CHROME_PATH=./x', 'ROUNDTABLE_WORKER_AUTH=api_key',
  'ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1', 'ROUNDTABLE_SANDBOX_IMAGE=custom',
  'ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS=https://provider.example',
  'ROUNDTABLE_EXECUTION_PROVIDER=openai_compatible', 'ROUNDTABLE_EXECUTION_BASE_URL=https://provider.example',
];
const hostileKeys = hostile.map(row => row.split('=')[0]);
test('an untracked package .env applies documented settings and never security switches', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, [...hostile, 'OLLAMA_URL=http://127.0.0.1:11434', 'ROUNDTABLE_MAX_TOKENS=900', 'ROUNDTABLE_PUBLISHER=ntfy', 'OPENAI_COMPATIBLE_BASE_URL=https://package.example/v1', 'OPENAI_COMPATIBLE_API_KEY=package-key', 'ANTHROPIC_API_KEY=fixture-provider-value'].join('\n'));
  const env = {};
  loadUserEnvironment({ home, env, packageEnvFile: file, warn: () => {} });
  assert.equal(env.OLLAMA_URL, 'http://127.0.0.1:11434');
  assert.equal(env.ROUNDTABLE_MAX_TOKENS, '900');
  assert.equal(env.ROUNDTABLE_PUBLISHER, 'ntfy');
  assert.deepEqual([env.OPENAI_COMPATIBLE_BASE_URL, env.OPENAI_COMPATIBLE_API_KEY], ['https://package.example/v1', 'package-key']);
  assert.equal(env.ANTHROPIC_API_KEY, 'fixture-provider-value');
  for (const key of hostileKeys) assert.equal(env[key], undefined);
  chmodSync(file, 0o666);
  const refused = {};
  loadUserEnvironment({ home, env: refused, packageEnvFile: file, warn: () => {} });
  assert.equal(refused.ANTHROPIC_API_KEY, undefined);
});
test('the pointed env file takes the credential keys and the endpoint pair but no package-only or hostile keys', t => {
  const { home, file } = fixture(t);
  writeFileSync(file, [...hostile, 'OLLAMA_URL=http://127.0.0.1:11434', 'ROUNDTABLE_MAX_TOKENS=900', 'ANTHROPIC_API_KEY=fixture-provider-value'].join('\n'), { mode: 0o600 });
  const env = { ROUNDTABLE_ENV_FILE: file };
  loadUserEnvironment({ home, env, warn: () => {} });
  assert.equal(env.ANTHROPIC_API_KEY, 'fixture-provider-value');
  for (const key of [...hostileKeys, 'OLLAMA_URL', 'ROUNDTABLE_MAX_TOKENS']) assert.equal(env[key], undefined);
});
test('a package .env tracked by git applies nothing and warns once without a path', t => {
  const { home } = fixture(t);
  const repo = join(home, 'checkout');
  mkdirSync(repo);
  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  if (git.status !== 0) return t.skip('git unavailable');
  const packageEnvFile = join(repo, '.env');
  writeFileSync(packageEnvFile, 'ANTHROPIC_API_KEY=tracked-value\nOLLAMA_URL=http://127.0.0.1:11434\n');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-f', '.env'], { encoding: 'utf8' }).status, 0);
  const env = {};
  const warnings = [];
  loadUserEnvironment({ home, env, packageEnvFile, warn: m => warnings.push(m) });
  loadUserEnvironment({ home, env, packageEnvFile, warn: m => warnings.push(m) });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OLLAMA_URL, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(repo));
});
