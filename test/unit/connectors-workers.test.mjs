import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConnectors } from '../../dist/connectors/config.js';
import { setConnectorConfig, setSecretConfig, readUserConfig, unsetConfigEntry } from '../../dist/user-config.js';
import { runTableCli } from '../../dist/cli-table.js';
import { validateContract, checkContract, consentHash, renderContractMarkdown } from '../../dist/execution/contract.js';
import { contractMarkdown } from '../../dist/dashboard/render.js';
import { proposeContract, freezeContract, amendContract, RUN_WIDE_FIELDS } from '../../dist/execution/contract-lifecycle.js';
import { openContractStore } from '../../dist/execution/contract-state.js';
import { execute } from '../../dist/execution/orchestrator.js';
import { buildMcpConfig, prepareWorkerFiles, registerWorkerSecrets, removeWorkerMcpConfig } from '../../dist/workers/files.js';
import { attest, WORKER_ATTESTATION, buildWorkerArgs } from '../../dist/workers/claude-code.js';
import { readCodexMcpServer } from '../../dist/workers/codex.js';
import { spawnWorker, workerExit } from '../../dist/workers/process.js';
import { SCRUB_LITERALS_ENV, scrub, scrubArtifact } from '../../dist/security/secrets.js';
import { makeRun, runner } from '../fixtures/workers/run.mjs';
import { makeRepo } from '../fixtures/execution/git-fixture.mjs';
import { Runner } from '../../dist/execution/runner.js';
import { goodInit, sandbox, scriptedDriver } from '../fixtures/runner/driver.mjs';
import { installProcessIdentity } from '../fixtures/execution/process-identity.mjs';

function restore(t, key, value) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rt-connectors-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const spec = (extra = {}) => ({ command: process.execPath, args: [], env: {}, ...extra });

test('connector config validates executable paths, names, argument/env limits and credential references', t => {
  const dir = fixture(t), blocked = join(dir, 'not-executable');
  writeFileSync(blocked, 'no'); chmodSync(blocked, 0o600);
  const good = { issues: spec({ args: ['a', ''], env: { ISSUE_TOKEN: 'secret://op/work/issues/token', REGION: 'us' } }) };
  assert.deepEqual(validateConnectors(good), good);
  for (const invalid of [
    { roundtable: spec() }, { 'Bad-name': spec() }, { 'a_b': spec() },
    { issues: spec({ command: 'node' }) }, { issues: spec({ command: '/bin/sh' }) },
    { issues: spec({ args: Array(17).fill('a') }) }, { issues: spec({ args: ['é'.repeat(2049)] }) },
    { issues: spec({ args: ['bad\0arg'] }) }, { issues: spec({ env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, 'x'])) }) },
    { issues: spec({ env: { ISSUE_TOKEN: 'plaintext-private' } }) }, { issues: spec({ env: { 'BAD-NAME': 'x' } }) },
    { issues: spec({ env: { ISSUE_TOKEN: 'secret://env/lower' } }) }, { issues: { ...spec(), shell: true } },
  ]) assert.throws(() => validateConnectors(invalid), e => !e.message.includes('plaintext-private'));
  assert.throws(() => setConnectorConfig('issues', spec({ command: blocked }), dir), { message: 'Connector issues is unavailable.' });
});

test('connector CLI set/show/unset keeps commands, arguments and env values out of output', async t => {
  const home = fixture(t); restore(t, 'ROUNDTABLE_HOME', home);
  let output = '', error = '';
  const io = { output: { write(s) { output += s; } }, error: { write(s) { error += s; } } };
  assert.equal(await runTableCli('config', ['set', 'connector', 'issues', '--command', process.execPath, '--arg', '--stdio', '--arg', 'private-arg', '--env', 'ISSUE_TOKEN=secret://env/CLI_CONNECTOR_LOGIN', '--env', 'REGION=private-region'], io), 0);
  assert.deepEqual(readUserConfig(home).connectors.issues.args, ['--stdio', 'private-arg']);
  setSecretConfig('ISSUE_TOKEN', 'secret://env/CLI_CONNECTOR_LOGIN', home);
  assert.equal(await runTableCli('config', ['show'], io), 0);
  assert.match(output, /connector issues: ISSUE_TOKEN, REGION/);
  assert.ok(!output.includes(process.execPath) && !output.includes('private-arg') && !output.includes('private-region') && !output.includes('CLI_CONNECTOR_LOGIN'));
  assert.equal(await runTableCli('config', ['set', 'connector', 'bad', '--command', process.execPath, '--env', 'ISSUE_TOKEN=private-literal'], io), 1);
  assert.ok(!error.includes('private-literal'));
  unsetConfigEntry('secrets', 'ISSUE_TOKEN', home);
  assert.equal(await runTableCli('config', ['unset', 'connector', 'issues'], io), 0);
  assert.deepEqual(readUserConfig(home).connectors, {});
});

test('missing connector binaries still allow config reads and unset without losing other connectors or secrets', async t => {
  const home = process.env.ROUNDTABLE_HOME, dir = fixture(t), command = join(dir, 'moved-binary');
  writeFileSync(command, '', { mode: 0o700 });
  setConnectorConfig('issues', spec({ command, args: ['private-argument'] }), home);
  setConnectorConfig('healthy', spec(), home);
  setSecretConfig('OPENAI_API_KEY', 'secret://env/MISSING_BINARY_PROVIDER_LOGIN', home);
  rmSync(command);
  const before = readUserConfig(home);
  assert.equal(before.connectors.issues.command, command);
  assert.deepEqual(before.connectors.healthy, spec());
  assert.throws(() => setConnectorConfig('missing', spec({ command }), home), { message: 'Connector missing is unavailable.' });
  await assert.rejects(buildMcpConfig({ execPath: process.execPath, cli: join(dir, 'cli.js'), tokenFile: join(dir, 'token'), home, execution: 'exe-test', agent: 'builder', connectors: ['issues'] }), { message: 'Connector issues is unavailable.' });
  const healthy = await buildMcpConfig({ execPath: process.execPath, cli: join(dir, 'cli.js'), tokenFile: join(dir, 'token'), home, execution: 'exe-test', agent: 'builder', connectors: ['healthy'] });
  assert.deepEqual(Object.keys(healthy.mcpServers), ['roundtable', 'healthy']);
  let output = '';
  const io = { output: { write(s) { output += s; } }, error: { write(s) { output += s; } } };
  assert.equal(await runTableCli('config', ['unset', 'connector', 'issues'], io), 0);
  assert.ok(!output.includes(command) && !output.includes('private-argument'));
  const after = readUserConfig(home);
  assert.equal(after.connectors.issues, undefined);
  assert.deepEqual(after.connectors.healthy, before.connectors.healthy);
  assert.deepEqual(after.secrets, before.secrets);
  unsetConfigEntry('connectors', 'healthy', home);
  unsetConfigEntry('secrets', 'OPENAI_API_KEY', home);
});

test('contract connector names are consent-bound, validated on propose/freeze, and checked before execute', async t => {
  const home = process.env.ROUNDTABLE_HOME;
  setConnectorConfig('issues', spec(), home);
  const repo = makeRepo(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const persona = new URL('../fixtures/ultraplan/cfo.md', import.meta.url).pathname;
  const input = {
    goal: 'Build an issue view', originalPrompt: 'Build it', orchestrator: 'main', repoDir: repo.root,
    consent: false,
    contract: { tasks: [{ id: 'ui', title: 'Issue view', persona, paths: { write: ['src/**'] }, acceptance: ['Shows issues'] }], connectors: ['issues'], budget: { usd: 5, per_task_usd: 5, wall_clock_min: 10 } },
  };
  const proposed = await proposeContract(input);
  const store = await openContractStore(proposed.contractId);
  const normalized = checkContract(proposed.contract).contract;
  assert.deepEqual(normalized.connectors, ['issues']);
  assert.notEqual(consentHash(normalized), consentHash({ ...normalized, connectors: [] }));
  assert.ok(RUN_WIDE_FIELDS.includes('connectors'));
  assert.match(renderContractMarkdown(normalized), /Connectors: issues/);
  assert.match(contractMarkdown(normalized), /Connectors: issues/);
  assert.equal((await validateContract({ ...normalized, connectors: ['missing'] }, { personas: false })).ok, false);
  assert.equal(checkContract({ ...normalized, connectors: Array(9).fill('issues') }).ok, false);
  assert.equal(checkContract({ ...normalized, workers: { driver: 'codex' } }).ok, false);
  await assert.rejects(proposeContract({ ...input, contract: { ...input.contract, connectors: ['missing'] } }), /unknown connector missing/);
  unsetConfigEntry('connectors', 'issues', home);
  await assert.rejects(freezeContract(proposed.contractId, { orchestrator: 'main' }), /unknown connector issues/);
  setConnectorConfig('issues', spec(), home);
  const frozen = await freezeContract(proposed.contractId, { orchestrator: 'main', excuse: [{ agent: persona, reason: 'fixture participant' }] });
  assert.deepEqual(frozen.contract.connectors, ['issues']);
  const config = readUserConfig(home);
  config.connectors.issues.command = join(fixture(t), 'missing-binary');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(execute({ contract_id: proposed.contractId, confirmation: 'go' }), { message: 'Connector issues is unavailable.' });
  unsetConfigEntry('connectors', 'issues', home);
  await assert.rejects(execute({ contract_id: proposed.contractId, confirmation: 'go' }), { message: 'Connector issues is unavailable.' });
});

test('amending away a connector affects running tasks and supersedes their workers and MCP files', async t => {
  const oldPath = process.env.PATH;
  installProcessIdentity();
  const home = process.env.ROUNDTABLE_HOME;
  setConnectorConfig('issues', spec(), home);
  const repo = makeRepo();
  const persona = new URL('../fixtures/ultraplan/cfo.md', import.meta.url).pathname;
  const proposed = await proposeContract({
    goal: 'Build an issue view', originalPrompt: 'Build it', orchestrator: 'main', repoDir: repo.root, consent: false,
    contract: { tasks: ['api', 'ui', 'later'].map(id => ({ id, title: id, persona, paths: { write: [`src/${id}/**`] }, acceptance: ['Works'] })), connectors: ['issues'], budget: { usd: 10, per_task_usd: 3, wall_clock_min: 10, max_parallel: 2 } },
  });
  const frozen = await freezeContract(proposed.contractId, { orchestrator: 'main', excuse: [{ agent: persona, reason: 'fixture participant' }] });
  const store = await openContractStore(proposed.contractId);
  await store.transact(() => ({ events: [{ type: 'execution.started', source: runner, payload: { confirmation: 'go', visibility: { dashboard: false, chat_only: true }, budget: frozen.contract.budget, lead: persona, sandbox: 'local', drivers: ['claude-code'] } }] }));
  const driver = scriptedDriver(t, l => ({ init: { ...goodInit, mcp_servers: Object.keys(JSON.parse(readFileSync(l.mcpConfigPath, 'utf8')).mcpServers).map(name => ({ name, status: 'connected' })) } }));
  const r = new Runner(store.id, { drivers: { 'claude-code': driver }, sandbox: sandbox(), tickMs: 10 });
  await r.start();
  t.after(async () => { r.stop('test cleanup'); await r.run(); process.env.PATH = oldPath; rmSync(repo.root, { recursive: true, force: true }); });
  await r.tick();
  assert.equal(driver.calls.length, 2);
  const old = [...driver.calls];
  const paths = old.map(h => h.mcpConfigPath);
  assert.ok(paths.every(path => existsSync(path)));
  await store.transact(() => ({ events: [{ type: 'execution.paused', source: runner, payload: { scope: 'all', reason: 'Inspect revocation' } }] }));
  const amended = await amendContract(store, { connectors: [] }, { by: 'main', reason: 'Revoke issues access', overrideConsent: true });
  assert.deepEqual(amended.affected.all, ['api', 'ui']);
  const event = (await store.events()).find(e => e.type === 'contract.amended');
  assert.deepEqual(event.payload.affected_tasks, ['api', 'ui']);
  await r.tick();
  assert.ok(paths.every(path => !existsSync(path)));
  const exits = (await store.events()).filter(e => e.type === 'agent.exited');
  assert.ok(old.every(h => exits.some(e => e.payload.agent === h.agent && e.payload.reason === 'killed')));
  await store.transact(() => ({ events: [{ type: 'execution.resumed', source: runner, payload: { scope: 'all', reason: 'Continue' } }] }));
  for (let i = 0; i < 100 && driver.calls.length < 4; i++) {
    await r.tick();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(driver.calls.length, 4);
  for (const h of driver.calls.slice(2)) {
    const config = JSON.parse(readFileSync(h.mcpConfigPath, 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['roundtable']);
  }
});

test('prepared connectors resolve at spawn, use private files, filter inherited env and redact relay/tool events', async t => {
  const home = process.env.ROUNDTABLE_HOME;
  restore(t, SCRUB_LITERALS_ENV);
  restore(t, 'ISSUE_LOGIN_WORKER', 'opaque-connector-login-fixture');
  const secret = process.env.ISSUE_LOGIN_WORKER;
  setConnectorConfig('issues', spec({ args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'], env: { LOGIN: 'secret://env/ISSUE_LOGIN_WORKER', REGION: 'us' } }), home);
  const run = await makeRun({ contract: { connectors: ['issues'] } });
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  const files = await prepareWorkerFiles({ store: run.store, agent: 'builder-1', task: 'api', persona: { body: 'Builder', skills: [] } });
  assert.equal(statSync(files.mcpConfigPath).mode & 0o777, 0o600);
  assert.equal(statSync(files.dir).mode & 0o777, 0o700);
  assert.ok(!files.mcpConfigPath.startsWith(join(home, 'worktrees') + '/'));
  const cfg = JSON.parse(readFileSync(files.mcpConfigPath, 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['roundtable', 'issues']);
  const connector = cfg.mcpServers.issues;
  assert.equal(connector.env.LOGIN, secret);
  assert.equal(connector.env.REGION, 'us');
  assert.equal(connector.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(connector.env[SCRUB_LITERALS_ENV], undefined);
  assert.ok(cfg.mcpServers.roundtable.env[SCRUB_LITERALS_ENV].includes(secret));
  assert.ok(!scrub(secret).includes(secret) && !scrubArtifact(secret).includes(secret));
  const child = spawnSync(connector.command, connector.args, { env: { ...process.env, ...connector.env, UNRELATED: 'no', ANTHROPIC_API_KEY: 'private-inherited' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const received = JSON.parse(child.stdout);
  assert.equal(received.LOGIN, secret);
  assert.equal(received.ANTHROPIC_API_KEY, undefined);
  assert.equal(received.UNRELATED, undefined);
  assert.equal(received[SCRUB_LITERALS_ENV], undefined);
  const expected = { ...WORKER_ATTESTATION, mcpServers: ['roundtable', 'issues'] };
  assert.equal(attest({ tools: ['Read', 'mcp__roundtable__read_blackboard', 'mcp__issues__search'], mcpServers: ['roundtable', 'issues'] }, expected).ok, true);
  assert.equal(attest({ tools: ['mcp__rogue__search'], mcpServers: ['roundtable', 'issues'] }, expected).ok, false);
  assert.throws(() => readCodexMcpServer(files.mcpConfigPath), /not supported by codex/);
  const args = buildWorkerArgs({ execution: run.store.id, agent: 'builder-1', task: 'api', attempt: 1, cwd: run.root, sessionId: '00000000-0000-4000-8000-000000000001', appendPromptPath: files.promptPath, mcpConfigPath: files.mcpConfigPath, settingsPath: files.settingsPath, budgetUsd: 1, connectors: ['issues'] });
  assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__issues/);
  const outputPath = join(files.runsDir, '1.jsonl');
  const { pid } = await spawnWorker({ file: process.execPath, args: ['-e', `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({type:'assistant', message: {content:[{type:'text',text:${JSON.stringify(secret)}}]}})))`], cwd: run.root, env: {}, prompt: 'go', outputPath, cleanupPaths: [files.mcpConfigPath] });
  assert.equal((await workerExit(pid)).code, 0);
  assert.equal(existsSync(files.mcpConfigPath), false);
  const output = readFileSync(outputPath, 'utf8');
  assert.ok(!output.includes(secret));
  await run.store.transact(() => ({ events: [{ type: 'note.posted', source: runner, payload: { topic: 'connector-output', text: output, refs: [] } }] }));
  const logPath = join(run.store.dir, 'events.jsonl');
  assert.ok(!readFileSync(logPath, 'utf8').includes(secret));
  // A trusted worker server starts separately with these literals and scrubs direct tool events.
  const scrubModule = new URL('../../dist/security/secrets.js', import.meta.url).href;
  const scrubbed = spawnSync(process.execPath, ['--input-type=module', '-e', `const {scrub} = await import(${JSON.stringify(scrubModule)}); console.log(scrub(${JSON.stringify(secret)}))`], { env: cfg.mcpServers.roundtable.env, encoding: 'utf8' });
  assert.equal(scrubbed.status, 0, scrubbed.stderr);
  assert.ok(!scrubbed.stdout.includes(secret));
  // Recovery re-registers active connector credentials without consulting a changed keychain.
  writeFileSync(files.mcpConfigPath, JSON.stringify(cfg), { mode: 0o600 });
  delete process.env[SCRUB_LITERALS_ENV];
  registerWorkerSecrets(run.store.id, 'builder-1');
  assert.ok(!scrub(secret).includes(secret));
  removeWorkerMcpConfig(run.store.id, 'builder-1');
  assert.equal(existsSync(files.mcpConfigPath), false);
});
