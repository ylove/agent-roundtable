// Explicit opt-in only: these calls use installed CLIs and their saved logins.
// ROUNDTABLE_LIVE_RUNTIMES=1 npm run test:live
import { runtimeRegistry } from '../dist/runtimes/registry.js';
import { detectRuntime, runRuntime } from '../dist/runtimes/runner.js';

export async function smokeRuntimes() {
  let failures = 0;
  const requested = process.env.ROUNDTABLE_LIVE_RUNTIMES;
  const names = requested === '1' ? undefined : requested.split(',');
  for (const [name, spec] of Object.entries(runtimeRegistry())) {
    if (names && !names.includes(name)) continue;
    if (name === 'agy' && process.env.ROUNDTABLE_TEST_AGY !== '1') {
      console.log('  skip agy: set ROUNDTABLE_TEST_AGY=1');
      continue;
    }
    const detected = await detectRuntime(spec);
    if (!detected.found) { console.log(`  skip ${name}: binary not found`); continue; }
    try {
      if (!detected.ok) throw new Error(detected.error);
      const result = name === 'agy'
        ? await runRuntime({ ...spec, cwd: undefined, argv: [...spec.argv, '--print-timeout', '60s'], timeoutMs: 65_000 }, 'Reply with exactly: ok', { model: 'gemini-3.8-flash-low' })
        : await runRuntime(spec, 'Reply with exactly: OK');
      if (!result.text.trim()) throw new Error('Empty reply');
      console.log(`  ok   ${name}: nonempty reply`);
    } catch (error) { failures++; console.error(`  FAIL ${name}: ${error.message}`); }
  }
  return failures;
}
