// Live-demo readiness fixes (#192): the room outlives a CLI duel, timeouts are not "stopped by a person",
// unpriced spend shows tokens, and a closed pipe ends quietly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runTableCli } from '../../dist/cli-table.js';
import { stubFetch, json } from './helpers.mjs';

const agentsDir = process.env.ROUNDTABLE_AGENTS_DIR;
const saved = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].map(k => [k, process.env[k]]));
before(() => {
  mkdirSync(agentsDir, { recursive: true });
  for (const id of ['designer', 'builder']) writeFileSync(join(agentsDir, `${id}.md`), `You are a ${id}.\n`);
  process.env.OPENAI_API_KEY = 'fixture-key';
});
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const sink = () => { let text = ''; return { write(s) { text += s; }, read: () => text }; };

function until(read, pattern, ms = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = pattern.exec(read());
      if (m) { clearInterval(timer); resolve(m); }
      else if (Date.now() - started > ms) { clearInterval(timer); reject(new Error(`timed out waiting for ${pattern}: ${read()}`)); }
    }, 25);
  });
}

test('the room stays up after a replayed duel ends, until SIGINT, then exits cleanly', async () => {
  const child = spawn(process.execPath, ['dist/index.js', 'duel', '--replay', 'examples/duel/demo.json', '--speed', '100'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', out = '';
  child.stderr.on('data', d => { err += d; }); child.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const [, url] = await until(() => err, /Room: (http\S+)/);
    await until(() => err, /Room stays open/);
    await until(() => out, /Spend:/);
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(child.exitCode, null, `the process exited early: ${err}`);
    assert.equal((await fetch(new URL('state.json', url))).status, 200);
    child.kill('SIGINT');
    const { code, signal } = await exited;
    assert.ok(signal === null && (code === 0 || code === 130), `exit ${code} ${signal}`);
  } finally { child.kill('SIGKILL'); }
});

test('--no-hold still exits when the duel ends', async () => {
  const child = spawn(process.execPath, ['dist/index.js', 'duel', '--replay', 'examples/duel/demo.json', '--speed', '100', '--no-hold'], { env: process.env, stdio: 'ignore' });
  const code = await new Promise(resolve => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 20000); child.on('exit', c => { clearTimeout(t); resolve(c); }); });
  assert.ok(code === 0 || code === 1, `exit ${code}`);
});

test('a turn timeout is reported as a timeout, with the unpriced spend in tokens, never as a human stop or $0.0000', async t => {
  let n = 0;
  stubFetch(t, (url, init) => ++n === 1
    ? json(200, { choices: [{ message: { content: 'An opening argument.' } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } })
    : new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))));
  const streams = { output: sink(), error: sink() };
  const code = await runTableCli('debate', ['Cats or dogs', '--agents', 'designer,builder', '--seat', 'designer=openai:fixture-unpriced,builder=openai:fixture-unpriced', '--no-preflight', '--turn-timeout', '0.3', '--rounds', '1'], streams);
  assert.equal(code, 1);
  assert.match(streams.error.read(), /timed out after 0\.3 s without a turn; raise --turn-timeout/);
  assert.doesNotMatch(streams.error.read() + streams.output.read(), /stopped by a person|StoppedError/);
  assert.match(streams.output.read(), /Aborted/);
  assert.match(streams.output.read(), /Spend: 1\.5k tok unpriced/);
  assert.doesNotMatch(streams.output.read(), /Spend: \$0\.0000/);
});

test('the overall --max-seconds deadline says to raise --max-seconds', async t => {
  stubFetch(t, (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))));
  const streams = { output: sink(), error: sink() };
  const code = await runTableCli('waffle', ['Tabs or spaces', '--agents', 'designer,builder', '--seat', 'designer=openai:m,builder=openai:m', '--no-preflight', '--max-seconds', '0.3', '--turn-timeout', '60'], streams);
  assert.equal(code, 1);
  assert.match(streams.error.read(), /timed out after 0\.3 s; raise --max-seconds/);
  assert.doesNotMatch(streams.error.read(), /stopped by a person/);
});

test('a closed pipe ends the CLI quietly with no stack trace', async () => {
  const child = spawn(process.execPath, ['dist/index.js', 'duel', '--dry-run', '--json', '--no-hold', '--no-room', '--speed', '1'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  child.stdout.once('data', () => child.stdout.destroy()); // like `| head -1`: close the read end early
  const code = await new Promise(resolve => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 30000); child.on('exit', c => { clearTimeout(t); resolve(c); }); });
  assert.doesNotMatch(err, /EPIPE|at .*terminal\.js|Unhandled/);
  assert.equal(code, 0);
});
