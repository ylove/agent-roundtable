// Absolute executable overrides, argv prompt values and private env-file diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUserEnvironment } from "../../dist/user-config.js";
import { BUILTIN_RUNTIMES } from "../../dist/runtimes/registry.js";
import { runRuntime } from "../../dist/runtimes/runner.js";
import { validateRuntimeConfig } from "../../dist/runtimes/spec.js";
import { isExecutableFile } from "../../dist/executables.js";
import { DockerBackend } from "../../dist/sandbox/docker.js";
import { spawnCaptured } from "../../dist/sandbox/process.js";
import { realDocker } from "../../dist/previews/docker-io.js";
import { launchRunner } from "../../dist/execution/runner-launch.js";
import { ClaudeCodeDriver } from "../../dist/workers/claude-code.js";
import { CodexDriver } from "../../dist/workers/codex.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rt-process-controls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("tracked package env files apply nothing and warn once without a path, through resolved git", t => {
  const root = fixture(t), bin = join(root, "bin"), calls = join(root, "calls");
  mkdirSync(bin);
  const git = join(bin, "git");
  writeFileSync(git, `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  const packageEnvFile = join(root, "package.credentials");
  writeFileSync(packageEnvFile, "ANTHROPIC_API_KEY=fixture-value\n", { mode: 0o600 });
  const warnings = [];
  for (let i = 0; i < 2; i++) {
    const env = { PATH: ["", "relative", bin].join(delimiter) };
    loadUserEnvironment({ home: root, env, packageEnvFile, warn: message => warnings.push(message) });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tracked by git/);
  assert.ok(!warnings[0].includes(root));
  assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", "--error-unmatch", "--", "package.credentials"]);
});

test("runtime overrides require absolute regular executable files", t => {
  const root = fixture(t), plain = join(root, "plain");
  writeFileSync(plain, "text", { mode: 0o600 });
  const spec = binary => ({ argv: [binary], output: { mode: "text" } });
  for (const binary of ["node", "./node", join(root, "missing"), root, ...(process.platform === "win32" ? [] : [plain])]) {
    assert.throws(() => validateRuntimeConfig({ custom: spec(binary) }), /absolute path to a regular executable|runtime argv/i);
  }
  assert.deepEqual(validateRuntimeConfig({ custom: spec(process.execPath) }), { custom: spec(process.execPath) });
});

test("host driver overrides require absolute regular executable files", async t => {
  const root = fixture(t);
  for (const binary of ["node", "./node", root, join(root, "missing")]) {
    assert.equal(isExecutableFile(binary), false);
    assert.equal((await new ClaudeCodeDriver({ cli: binary }).detect()).ok, false);
    assert.equal((await new CodexDriver({ cli: binary, env: { ROUNDTABLE_ALLOW_CODEX_DRIVER: "1" } }).detect()).ok, false);
    assert.equal((await new DockerBackend({ dockerPath: binary }).available()).ok, false);
    assert.equal((await realDocker(binary).info()).ok, false);
    assert.throws(() => launchRunner("exe-0000000000000000", { execPath: binary }), /absolute path to a regular executable/);
  }
});

test("sandbox and preview processes resolve programs before selecting their cwd", async t => {
  const root = fixture(t), bin = join(root, "bin");
  mkdirSync(bin);
  const script = `#!${process.execPath}\nprocess.stdout.write('ready');\n`;
  writeFileSync(join(bin, "docker"), script, { mode: 0o755 });
  writeFileSync(join(root, "docker"), `#!${process.execPath}\nprocess.exit(77);\n`, { mode: 0o755 });
  const previous = { cwd: process.cwd(), path: process.env.PATH };
  t.after(() => { process.chdir(previous.cwd); process.env.PATH = previous.path; });
  process.chdir(root);
  process.env.PATH = ["", ".", "relative", bin].join(delimiter);
  const captured = await spawnCaptured("docker", [], { cwd: root, env: { PATH: process.env.PATH }, label: "docker", timeoutMs: 2000, maxOutputBytes: 1024 });
  assert.equal(captured.exit, 0);
  assert.equal(captured.output, "ready");
  assert.deepEqual(await new DockerBackend().available(), { ok: true });
  assert.deepEqual(await realDocker().info(), { ok: true });
});

test("argv prompt profiles and the worker wrapper preserve dash-leading prompt values", async t => {
  const root = fixture(t), echo = join(root, "echo.cjs");
  writeFileSync(echo, `const args = process.argv.slice(2);
const flag = args.findIndex(value => ['-q', '--message', '-p'].includes(value));
if (args[flag + 1].startsWith('-')) process.exit(42);
console.log(JSON.stringify(args));
`);
  const env = { PATH: process.env.PATH, HOME: root, ROUNDTABLE_DOTENV: "off" };
  const prompt = "--option=true\nA task.";
  for (const name of ["hermes", "openclaw", "gemini"]) {
    const profileArgs = [echo, ...BUILTIN_RUNTIMES[name].argv.slice(1)];
    const result = await runRuntime({ argv: [process.execPath, ...profileArgs], output: { mode: "text" } }, prompt, { env });
    assert.ok(JSON.parse(result.text).includes("\n" + prompt), name);
    const config = { v: 1, runtime: name, binary: process.execPath, args: profileArgs, output: { mode: "text" }, stdoutMaxBytes: 65536, submit: "server" };
    const child = spawnSync(process.execPath, [resolve("dist/workers/runtime-wrapper.js"), JSON.stringify(config)], { input: prompt, encoding: "utf8", cwd: root, env });
    assert.equal(child.status, 0, child.stderr);
    const final = child.stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "roundtable.runtime.result");
    assert.equal(final.ok, true);
    assert.ok(JSON.parse(final.text).includes("\n" + prompt), name);
  }
});

test("Chrome overrides use absolute regular executable files", t => {
  const root = fixture(t), binary = join(root, "chrome");
  writeFileSync(binary, `#!${process.execPath}\n`, { mode: 0o755 });
  const module = pathToFileURL(resolve("dist/prototypes/browser.js")).href;
  const script = `const { findChrome } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(findChrome()));`;
  const detect = override => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, encoding: "utf8", env: { PATH: "", HOME: root, ROUNDTABLE_HOME: root, ROUNDTABLE_CHROME_PATH: override, ROUNDTABLE_DOTENV: "off" },
  });
  const absolute = detect(binary);
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.equal(JSON.parse(absolute.stdout), binary);
  for (const override of ["./chrome", root, join(root, "missing")]) {
    const child = detect(override);
    assert.equal(child.status, 0, child.stderr);
    assert.notEqual(JSON.parse(child.stdout), binary);
    assert.match(child.stderr, /absolute path to a regular executable/);
    assert.ok(!child.stderr.includes(root));
  }
  if (process.platform !== "win32") {
    chmodSync(binary, 0o600);
    assert.notEqual(JSON.parse(detect(binary).stdout), binary);
  }
});
