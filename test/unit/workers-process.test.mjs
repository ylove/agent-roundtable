import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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

test("worker relay redacts every secret-shaped JSON key and a lone PEM header never silences later lines", async (t) => {
  const cwd = fixture(t);
  const outputPath = join(cwd, "runs", "1.jsonl");
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  const lines = [
    JSON.stringify({ type: "user", auth: "opaque-auth-1111", authorization: "opaque-authz-2222", pwd: "opaque-pwd-3333",
      aws_access_key_id: "opaque-access-4444", token: ["opaque-array-5555"], author: "kept-author", usage: { output_tokens: 20 } }),
    JSON.stringify({ type: "user", content: "fixture: -----BEGIN RSA PRIVATE KEY-----" }),
    "plain -----BEGIN PRIVATE KEY-----",
    body,
    "-----END PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "Warning: not a key body",
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.25, usage: { output_tokens: 20 } }),
  ];
  const code = `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")}); });`;
  const { pid } = await spawnWorker({ file: process.execPath, args: ["-e", code], cwd, env: {}, prompt: "go", outputPath });
  assert.equal((await workerExit(pid)).code, 0);
  const log = readFileSync(outputPath, "utf8");
  for (const leaked of ["opaque-auth-1111", "opaque-authz-2222", "opaque-pwd-3333", "opaque-access-4444", "opaque-array-5555", body]) {
    assert.ok(!log.includes(leaked), `leaked ${leaked}`);
  }
  const out = log.trimEnd().split("\n");
  assert.equal(out.length, lines.length);
  const first = JSON.parse(out[0]);
  assert.equal(first.author, "kept-author");
  assert.equal(first.usage.output_tokens, 20);
  assert.equal(JSON.parse(out[1]).type, "user", "a JSON line with a header keeps its syntax");
  assert.deepEqual(out.slice(2, 6), Array(4).fill("[redacted:private_key]"));
  assert.equal(out[6], "Warning: not a key body", "a line that cannot be a PEM body ends the redaction");
  const result = JSON.parse(out[7]);
  assert.equal(result.type, "result");
  assert.equal(result.total_cost_usd, 0.25, "the result line, and with it the run's cost, survives");
});

test("worker relay bounds whitespace and structured output processing", { timeout: 5000 }, async (t) => {
  const cwd = fixture(t);
  const outputPath = join(cwd, "bounded.jsonl");
  const script = join(cwd, "bounded.cjs");
  writeFileSync(script, `process.stdin.resume(); process.stdin.on("end", () => {
    console.log("-----BEGIN PRIVATE KEY-----");
    console.log(" ".repeat(200000) + "!");
    console.log('{"payload":' + '['.repeat(30000) + '"private-value"' + ']'.repeat(30000) + '}');
    console.log(JSON.stringify({ payload: Array(10001).fill("private-value") }));
    console.log(JSON.stringify({ type: "result", usage: { output_tokens: 20 } }));
  });`);
  const started = performance.now();
  const { pid } = await spawnWorker({ file: process.execPath, args: [script], cwd, env: {}, prompt: "go", outputPath });
  t.after(() => stopGroup(pid, 100));
  assert.equal((await workerExit(pid)).code, 0);
  assert.ok(performance.now() - started < 1000, "relay processing stays within 1s");
  const lines = readFileSync(outputPath, "utf8").trimEnd().split("\n");
  assert.equal(lines[0], "[redacted:private_key]");
  assert.equal(lines[1], " ".repeat(200000) + "!");
  assert.ok(!lines[2].includes("private-value"));
  assert.match(lines[2], /redacted:limit/);
  assert.equal(JSON.parse(lines[3]).payload, "[redacted:limit]");
  assert.equal(JSON.parse(lines[4]).usage.output_tokens, 20);
});

test("worker relay continues after a per-line processing error", { timeout: 5000 }, async (t) => {
  const cwd = fixture(t);
  const outputPath = join(cwd, "recovery.jsonl");
  const preload = join(cwd, "preload.mjs");
  writeFileSync(preload, `const original = JSON.stringify;
    JSON.stringify = (value, ...args) => {
      if (value?.fixtureFault) throw new Error("fixture processing error");
      return original(value, ...args);
    };`);
  const relay = new URL("../../dist/workers/output-relay.js", import.meta.url);
  const proc = spawn(process.execPath, ["--import", preload, relay.pathname], { cwd, stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => proc.kill("SIGKILL"));
  const closed = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code));
  });
  proc.stdin.end(JSON.stringify({ file: process.execPath, args: ["-e",
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(\'{"fixtureFault":true}\\n{"type":"result"}\\n\'));'],
    cwd, env: {}, prompt: "go", outputPath }));
  assert.equal(await closed, 0);
  assert.equal(readFileSync(outputPath, "utf8"), '[redacted:processing_error]\n{"type":"result"}\n');
});
