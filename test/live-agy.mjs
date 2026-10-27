// One tiny real call, explicitly gated; run without the unit preload to retain agy's saved sign-in.
// ROUNDTABLE_TEST_AGY=1 node --test test/live-agy.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_RUNTIMES } from '../dist/runtimes/registry.js';
import { runRuntime } from '../dist/runtimes/runner.js';

test('installed agy seat smoke (explicit opt-in)', {
  skip: process.env.ROUNDTABLE_TEST_AGY !== '1', timeout: 70_000,
}, async () => {
  // The runner creates and removes a fresh empty scratch cwd; no repo/config writes.
  const spec = { ...BUILTIN_RUNTIMES.agy, argv: [...BUILTIN_RUNTIMES.agy.argv, '--print-timeout', '60s'], timeoutMs: 65_000 };
  const result = await runRuntime(spec, 'Reply with exactly: ok', { model: 'gemini-3.8-flash-low' });
  assert.equal(result.text.trim(), 'ok');
  assert.ok(result.usage);
  assert.equal(result.costUsd, undefined);
});
