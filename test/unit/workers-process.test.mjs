import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorker, workerExit, groupAlive, stopGroup } from "../../dist/workers/process.js";

const secret = "opaque-configured-key-Q7m2R9z4";
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-relay-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const delay = ms => new Promise(r => setTimeout(r, ms));

test("worker relay scrubs both streams before persistence, across chunks and final partial lines, with a line cap", async (t) => {
  const cwd = fixture(t);
  process.env.OPENAI_COMPATIBLE_API_KEY = secret;
  t.after(() => delete process.env.OPENAI_COMPATIBLE_API_KEY);
  const outputPath = join(cwd, "runs", "1.jsonl");
  const code = `process.stdin.resume(); process.stdin.on("end", () => {
    process.stdout.write(${JSON.stringify(secret.slice(0, 12))});
    setTimeout(() => {
      process.stdout.write(${JSON.stringify(secret.slice(12))} + "\\n");
      process.stderr.write(${JSON.stringify(secret)} + "\\n");
      process.stdout.write("a".repeat(1024 * 1024) + ${JSON.stringify(secret)} + "\\n");
      process.stdout.write("ghp_" + "Z".repeat(30) + "\\n");
      process.stdout.write(${JSON.stringify(secret)});
    }, 40);
  });`;
  const { pid } = await spawnWorker({ file: process.execPath, args: ["-e", code], cwd, env: {}, prompt: "go", outputPath });
  assert.equal((await workerExit(pid)).code, 0);
  const log = readFileSync(outputPath, "utf8");
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes("ghp_"));
  assert.match(log, /redacted:env:OPENAI_COMPATIBLE_API_KEY/);
  assert.match(log, /line omitted: size limit/);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});

test("detached relay survives runner exit and an adopting runner sees only scrubbed output", async (t) => {
  const cwd = fixture(t);
  const outputPath = join(cwd, "runs", "1.jsonl");
  const worker = join(cwd, "worker.cjs");
  writeFileSync(worker, `process.stdin.resume(); process.stdin.on("end", () => {
    console.log(${JSON.stringify(secret)});
    setTimeout(() => console.log("after restart " + ${JSON.stringify(secret)}), 500);
    setTimeout(() => console.log("done"), 1200);
  });`);
  const module = new URL("../../dist/workers/process.js", import.meta.url).href;
  const launched = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { spawnWorker } from ${JSON.stringify(module)};
    const { pid } = await spawnWorker(${JSON.stringify({ file: process.execPath, args: [worker], cwd, env: {}, prompt: "go", outputPath })});
    process.stdout.write(String(pid)); process.exit(0);
  `], { env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: secret }, encoding: "utf8", timeout: 5000 });
  assert.equal(launched.status, 0, launched.stderr);
  const pid = Number(launched.stdout);
  t.after(() => stopGroup(pid, 100));
  assert.ok(groupAlive(pid));
  assert.equal(workerExit(pid), undefined, "adoption does not require the original runner's child handle");
  let log = "";
  for (let i = 0; i < 100; i++) {
    log = readFileSync(outputPath, "utf8");
    assert.ok(!log.includes(secret), "even a live tail is scrubbed");
    if (log.includes("done")) break;
    await delay(30);
  }
  assert.match(log, /after restart \[redacted:env:OPENAI_COMPATIBLE_API_KEY\]/);
  assert.match(log, /done/);
});

test("worker spawn errors remain observable through spawnWorker", async (t) => {
  const cwd = fixture(t);
  await assert.rejects(spawnWorker({ file: join(cwd, "missing"), args: [], cwd, env: {}, prompt: "go", outputPath: join(cwd, "runs", "1.jsonl") }), /ENOENT/);
});
