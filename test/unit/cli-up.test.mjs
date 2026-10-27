import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";

const { runDoctor, formatDoctor, nodeMeets, checkRoundtableBin, onboard, missingSetup, runUpCli, MCP_ADD } = await import("../../dist/cli-up.js");
const { privateText } = await import("../../dist/serve/messages.js");
const { VERSION } = await import("../../dist/config.js");

const probes = (over = {}) => ({
  nodeVersion: "v22.4.0", engines: ">=22", providers: () => ["anthropic", "openai"],
  keyNames: { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", together: "TOGETHER_API_KEY" },
  findExecutable: () => "/bin/x", runtimes: [{ name: "codex", command: "codex" }],
  roundtableBin: () => ({ path: "/bin/roundtable", ours: true }),
  docker: async () => ({ ok: true }), chrome: () => "/chrome", ...over,
});
const sink = () => { const s = new PassThrough(); let text = ""; s.on("data", d => { text += d; }); return { stream: s, text: () => text }; };

test("nodeMeets compares against the engines range", () => {
  assert.equal(nodeMeets("22.0.0", ">=22"), true);
  assert.equal(nodeMeets("v24.1.0", ">=22"), true);
  assert.equal(nodeMeets("20.11.1", ">=22"), false);
  assert.equal(nodeMeets("garbage", ">=22"), false);
});

test("doctor passes with the essentials and names keys without values", async () => {
  const result = await runDoctor(probes());
  assert.equal(result.ok, true);
  const text = formatDoctor(result);
  assert.match(text, /\[ok\] Provider keys: available: anthropic, openai/);
  assert.match(text, /Essentials pass\./);
  assert.doesNotMatch(text, /\/bin\/x|\/chrome/);
});

test("roundtable bin advice covers this package, another package and no PATH entry", async () => {
  for (const [bin, ok, detail] of [
    [{ path: "/bin/roundtable", ours: true }, true, "this package"],
    [{ path: "/bin/roundtable", ours: false }, false, "another package"],
    [{ path: null, ours: false }, true, "not on PATH"],
  ]) {
    const check = checkRoundtableBin(bin);
    assert.equal(check.id, "bin");
    assert.equal(check.label, "roundtable on PATH");
    assert.equal(check.ok, ok);
    assert.equal(check.essential, false);
    assert.equal(check.detail, detail);
    assert.doesNotMatch(check.detail, /\/bin\//);
    const result = await runDoctor(probes({ roundtableBin: () => bin }));
    assert.equal(result.ok, true);
    assert.equal(result.checks.find(c => c.id === "bin").ok, ok);
    if (!ok) {
      assert.match(check.fix, /Uninstall.*reorder PATH/);
      assert.ok(check.fix.includes(`npx -y agent-roundtable@${VERSION}`));
      assert.match(check.fix, /absolute path/);
    }
  }
});

test("doctor checks the first PATH bin through symlinks and the nearest package manifest", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "rt-bin-check-"));
  try {
    const packageName = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).name;
    const dirs = ["ours", "other", "absent"].map(name => join(root, name));
    for (const dir of dirs) mkdirSync(dir);
    for (const [index, name] of [packageName, "example-roundtable"].entries()) {
      const install = join(root, `install-${index}`);
      mkdirSync(join(install, "dist"), { recursive: true });
      writeFileSync(join(install, "package.json"), JSON.stringify({ name }));
      const bin = join(install, "dist", "index.js");
      writeFileSync(bin, 'throw new Error("The bin check must not execute the candidate");\n');
      chmodSync(bin, 0o755);
      symlinkSync(bin, join(dirs[index], "roundtable"));
    }
    for (const [path, ok, detail] of [
      [[dirs[0], dirs[1]].join(delimiter), true, "this package"],
      [[dirs[1], dirs[0]].join(delimiter), false, "another package"],
      [dirs[2], true, "not on PATH"],
    ]) {
      const result = spawnSync(process.execPath, [new URL("../../dist/index.js", import.meta.url).pathname, "doctor", "--json"], {
        env: { ...process.env, PATH: path, ROUNDTABLE_HOME: join(root, "state"), ROUNDTABLE_DOTENV: "off" }, encoding: "utf8", timeout: 20_000,
      });
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      const check = JSON.parse(result.stdout).checks.find(c => c.id === "bin");
      assert.equal(check.ok, ok);
      assert.equal(check.detail, detail);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("up includes the optional roundtable PATH warning", async () => {
  const o = sink();
  const code = await runUpCli("up", ["--no-input", "--no-serve"], { output: o.stream }, {
    probes: probes({ roundtableBin: () => ({ path: "/bin/roundtable", ours: false }) }), setup: fakeSetup(),
  });
  assert.equal(code, 0);
  assert.match(o.text(), /\[--\] roundtable on PATH: another package\. Uninstall/);
  assert.ok(o.text().includes(`npx -y agent-roundtable@${VERSION}`));
});

test("doctor: missing git, keys, Docker and Chrome", async () => {
  const result = await runDoctor(probes({
    providers: () => [], findExecutable: name => (name === "git" ? null : "/bin/x"),
    docker: async () => ({ ok: false, reason: "docker is not available: not installed" }), chrome: () => null,
  }));
  assert.equal(result.ok, false);
  const by = Object.fromEntries(result.checks.map(c => [c.id, c]));
  assert.equal(by.git.ok, false); assert.equal(by.git.essential, true);
  assert.equal(by.keys.ok, false);
  assert.match(by.keys.fix, /ANTHROPIC_API_KEY, OPENAI_API_KEY, TOGETHER_API_KEY/);
  assert.equal(by.docker.ok, false); assert.equal(by.docker.essential, false);
  assert.equal(by.chrome.ok, false); assert.equal(by.chrome.essential, false);
  assert.match(formatDoctor(result), /\[!!\] git: not found\. Install git/);
  assert.match(formatDoctor(result), /\[--\] Chrome: not found/);
});

test("doctor: optional failures do not fail it; an old Node does", async () => {
  assert.equal((await runDoctor(probes({ docker: async () => { throw new Error("boom"); }, chrome: () => null, findExecutable: n => (n === "git" ? "/g" : null) }))).ok, true);
  assert.equal((await runDoctor(probes({ nodeVersion: "v20.1.0" }))).ok, false);
});

test("doctor --check-keys pings each available provider only", async () => {
  let asked;
  const result = await runDoctor(probes({ ping: async p => { asked = p; return [{ provider: "anthropic", ok: true }, { provider: "openai", ok: false, reason: "auth failed" }]; } }), { checkKeys: true });
  assert.deepEqual(asked, ["anthropic", "openai"]);
  assert.equal(result.ok, true);
  assert.match(formatDoctor(result), /\[--\] Key check openai: auth failed/);
  assert.equal((await runDoctor(probes({ ping: async () => { throw new Error("no"); } }))).ok, true, "no ping without the flag");
});

test("doctor --json prints the checks and exits by the essentials", async () => {
  const o = sink();
  const code = await runUpCli("doctor", ["--json"], { output: o.stream }, { probes: probes({ providers: () => [] }) });
  assert.equal(code, 1);
  const parsed = JSON.parse(o.text());
  assert.equal(parsed.ok, false);
  assert.ok(parsed.checks.some(c => c.id === "keys" && !c.ok));
});

test("usage errors exit 2", async () => {
  assert.equal(await runUpCli("up", ["--wat"], { output: sink().stream }, { probes: probes() }), 2);
  assert.equal(await runUpCli("doctor", ["--setup"], { output: sink().stream }, { probes: probes() }), 2);
});

const fakeSetup = (view = { envFile: false, agentsDir: false, desktop: false }) => {
  const calls = [];
  return {
    calls,
    view: () => view,
    setPath: (kind, path) => { if (path === "/bad") throw new Error("Unable to save"); calls.push(["path", kind, path]); },
    enableDesktop: () => calls.push(["desktop"]),
    starter: async () => { calls.push(["starter"]); return 0; },
  };
};
const scripted = lines => { const s = new PassThrough(); s.end(lines.join("\n") + "\n"); return s; };

test("onboarding saves answers through the setters and re-asks a bad path", async () => {
  const setup = fakeSetup();
  const o = sink();
  const code = await runUpCli("up", ["--no-serve"], { input: scripted(["/bad", "/home/x/.env", "/home/x/agents", "y", "y"]), output: o.stream, interactive: true }, { probes: probes(), setup, firstRun: () => true, reload: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(setup.calls, [["path", "envFile", "/home/x/.env"], ["path", "agentsDir", "/home/x/agents"], ["starter"], ["desktop"]]);
  assert.match(o.text(), /Not saved: Unable to save/);
  assert.match(o.text(), /Next:\n {2}roundtable duel --dry-run\n {2}claude mcp add --scope user roundtable -- roundtable mcp/);
});

test("onboarding: blank answers skip, and end of input skips the rest", async () => {
  const setup = fakeSetup();
  await onboard({ ask: async () => "" }, setup, () => {});
  assert.deepEqual(setup.calls, []);
  const asked = [];
  await onboard({ ask: async q => { asked.push(q); return null; } }, setup, () => {});
  assert.equal(asked.length, 1);
});

test("onboarding does not re-ask what is set", async () => {
  const setup = fakeSetup({ envFile: true, agentsDir: true, desktop: true });
  const asked = [];
  await onboard({ ask: async q => { asked.push(q); return ""; } }, setup, () => {});
  assert.equal(asked.length, 1);
  assert.match(asked[0], /starter/);
});

test("up does not prompt after the first run, and never without a terminal or with --no-input", async () => {
  for (const [io, args, first] of [
    [{ interactive: true }, ["--no-serve"], false],
    [{ interactive: false }, ["--no-serve"], true],
    [{ interactive: true }, ["--no-serve", "--no-input"], true],
  ]) {
    const setup = fakeSetup();
    const o = sink();
    const input = new PassThrough();
    await runUpCli("up", args, { ...io, input, output: o.stream }, { probes: probes(), setup, firstRun: () => first });
    assert.deepEqual(setup.calls, []);
    assert.doesNotMatch(o.text(), /1\/4/);
    if (!io.interactive || args.includes("--no-input")) {
      assert.match(o.text(), /env-file: roundtable config set env-file/);
      assert.match(o.text(), /notify\.desktop: roundtable config set notify\.desktop true/);
    }
  }
  assert.deepEqual(missingSetup({ envFile: true, agentsDir: true, desktop: true }), []);
});

test("up --setup prompts again after the first run", async () => {
  const setup = fakeSetup();
  const o = sink();
  await runUpCli("up", ["--setup", "--no-serve"], { input: scripted(["", "", "n", "n"]), output: o.stream, interactive: true }, { probes: probes(), setup, firstRun: () => false, reload: () => {} });
  assert.match(o.text(), /1\/4/);
});

test("up skips starting the service when it already runs, and starts it when not", async () => {
  const running = { running: true, url: "http://127.0.0.1:1/abcdefgh/" };
  let started = 0, opened = [];
  const serve = { status: () => running, start: async () => { started++; return running; } };
  const o = sink();
  assert.equal(await runUpCli("up", ["--no-input", "--open"], { output: o.stream, showUrl: true }, { probes: probes(), setup: fakeSetup({ envFile: true, agentsDir: true, desktop: true }), serve, open: u => opened.push(u) }), 0);
  assert.equal(started, 0);
  assert.match(o.text(), /Service: already running\./);
  assert.match(o.text(), /Index: http:\/\/127\.0\.0\.1:1\/abcdefgh\//);
  assert.deepEqual(opened, [running.url]);

  const idle = { status: () => ({ running: false }), start: async () => { started++; return running; } };
  const p = sink();
  await runUpCli("up", ["--no-input"], { output: p.stream, showUrl: false }, { probes: probes(), setup: fakeSetup(), serve: idle, open: () => assert.fail("no --open") });
  assert.equal(started, 1);
  assert.match(p.text(), /Service: started\./);
  assert.doesNotMatch(p.text(), /127\.0\.0\.1/);

  const q = sink();
  await runUpCli("up", ["--no-input", "--no-serve"], { output: q.stream }, { probes: probes(), setup: fakeSetup(), serve: { status: () => assert.fail("skipped"), start: () => assert.fail("skipped") } });
  assert.doesNotMatch(q.text(), /Service:/);
});

test("up reports a service that cannot start and still exits by the doctor", async () => {
  const o = sink();
  const code = await runUpCli("up", ["--no-input"], { output: o.stream }, { probes: probes({ providers: () => [] }), setup: fakeSetup(), serve: { status: () => ({ running: false }), start: async () => { throw new Error("nope /tmp/x/y"); } } });
  assert.equal(code, 1);
  assert.match(o.text(), /Service: not started\. nope/);
});

test("the MCP registration is printed, never run", () => {
  assert.equal(MCP_ADD, "claude mcp add --scope user roundtable -- roundtable mcp");
});

test("--version, -v and version print the version; no arguments still start the MCP server", () => {
  const index = new URL("../../dist/index.js", import.meta.url).pathname;
  for (const arg of ["--version", "-v", "version"]) {
    const r = spawnSync(process.execPath, [index, arg], { env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, VERSION + "\n");
  }
  const r = spawnSync(process.execPath, [index], { env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, input: "", encoding: "utf8", timeout: 20000 });
  assert.notEqual(r.stdout, VERSION + "\n");
  assert.doesNotMatch(r.stderr, /Usage:/);
});

test("check-in text masks paths but not ratios or alternatives", () => {
  for (const text of ["50/50", "and/or", "a/b testing", "yes/no", "a 50/50 split of and/or"]) assert.equal(privateText(text), text);
  assert.equal(privateText("see /etc/passwd now"), "see [private path] now");
  assert.equal(privateText("/var/log/x.txt failed"), "[private path] failed");
  assert.equal(privateText('open "/opt/app/file" and (/tmp/a) or ~/notes/x'), 'open "[private path]" and ([private path] or [private path]');
  assert.equal(privateText("file=/srv/data/x"), "file=[private path]");
  assert.equal(privateText("at C:\\Work\\proj\\a.ts"), "at [private path]");
  assert.equal(privateText("D:/work/a"), "[private path]");
  assert.equal(privateText("a / b"), "a / b");
});
