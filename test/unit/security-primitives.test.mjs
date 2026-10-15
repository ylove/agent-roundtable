import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { newId, newExecutionId, executionTag, EXECUTION_ID_RE, randomBase32 } = await import("../../dist/ids.js");
const { mkdirPrivate, writeFileAtomic, isContained, normalizeRelPath } = await import("../../dist/security/fs-safe.js");
const { childEnv, SECRET_NAME_RE } = await import("../../dist/security/child-env.js");
const { scrubSecrets, scrubAndCap } = await import("../../dist/security/secrets.js");
const { redact, redactSecrets, redactPII } = await import("../../dist/publishers/redact.js");
const { EVENT_TYPES, GENESIS_HASH, CONTRACT_SCHEMA } = await import("../../dist/execution/types.js");

test("ids are random, prefixed and use the Crockford alphabet", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId("collab")));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^collab-[0-9a-hjkmnp-tv-z]{8}$/);
  assert.match(randomBase32(32), /^[0-9a-hjkmnp-tv-z]{32}$/);
});

test("execution ids sort by creation time and expose a 6-char branch tag", () => {
  const a = newExecutionId(1_700_000_000_000);
  const b = newExecutionId(1_700_000_000_001);
  assert.match(a, EXECUTION_ID_RE);
  assert.ok(a.slice(0, 14) < b.slice(0, 14));
  assert.equal(executionTag(a).length, 6);
  assert.equal(executionTag(a), a.slice(-6));
});

test("mkdirPrivate creates 0700 directories and refuses symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-fs-"));
  const dir = join(root, "a", "b");
  mkdirPrivate(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const link = join(root, "link");
  symlinkSync(dir, link);
  assert.throws(() => mkdirPrivate(link), /not a real directory/);
});

test("writeFileAtomic writes 0600 files and leaves no temp files", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-fs-"));
  const file = join(root, "state.json");
  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ["state.json"]);
});

test("containment and relative-path normalization reject escapes", () => {
  assert.equal(isContained("/srv/work", "src/a.ts"), true);
  assert.equal(isContained("/srv/work", "/srv/work"), true);
  assert.equal(isContained("/srv/work", "../etc/passwd"), false);
  assert.equal(isContained("/srv/work", "/srv/workshop/x"), false);
  assert.equal(normalizeRelPath("./src//nav/../x"), null);
  assert.equal(normalizeRelPath("src//nav/./x.ts"), "src/nav/x.ts");
  assert.equal(normalizeRelPath("/abs"), null);
  assert.equal(normalizeRelPath("C:/win"), null);
  assert.equal(normalizeRelPath("a\0b"), null);
  assert.equal(normalizeRelPath(""), null);
});

const FAKE_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/test",
  LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdef",
  OPENAI_API_KEY: "sk-test-0123456789abcdef0123",
  ROUNDTABLE_NTFY_TOKEN: "tk_abcdefghijklmnop",
  ROUNDTABLE_WEBHOOK_AUTH_HEADER: "Bearer abc.def.ghi",
  GH_TOKEN: "gho_aaaaaaaaaaaaaaaaaaaaaaaa",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  RANDOM_PASSWORD: "hunter2hunter2",
};

test("no profile leaks secret-named variables unless it exists to carry them", () => {
  const allowed = { gh: ["GH_TOKEN"], git: ["SSH_AUTH_SOCK"], runner: Object.keys(FAKE_ENV) };
  for (const profile of ["claude-worker", "codex-worker", "local-meeting", "git", "gh", "docker", "browser", "open", "sandbox-local", "cloud-cli"]) {
    const env = childEnv(profile, {}, FAKE_ENV);
    for (const name of Object.keys(env)) {
      if (SECRET_NAME_RE.test(name)) {
        assert.ok((allowed[profile] ?? []).includes(name), `${profile} leaked ${name}`);
      }
    }
  }
});

test("CLI profiles pass the provider key only with ROUNDTABLE_WORKER_AUTH=api_key", () => {
  assert.equal(childEnv("claude-worker", {}, FAKE_ENV).ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv("claude-worker", {}, { ...FAKE_ENV, ROUNDTABLE_WORKER_AUTH: "api_key" }).ANTHROPIC_API_KEY, FAKE_ENV.ANTHROPIC_API_KEY);
  assert.equal(childEnv("codex-worker", {}, FAKE_ENV).OPENAI_API_KEY, undefined);
  assert.equal(childEnv("codex-worker", {}, { ...FAKE_ENV, ROUNDTABLE_WORKER_AUTH: "API_KEY" }).OPENAI_API_KEY, FAKE_ENV.OPENAI_API_KEY);
});

test("childEnv applies fixed settings and extra values last", () => {
  const env = childEnv("claude-worker", { ROUNDTABLE_EXECUTION_ID: "exe-1", PATH: undefined }, FAKE_ENV);
  assert.equal(env.TERM, "dumb");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.ROUNDTABLE_EXECUTION_ID, "exe-1");
  assert.equal(env.PATH, undefined);
  assert.equal(childEnv("git", {}, FAKE_ENV).GIT_TERMINAL_PROMPT, "0");
  assert.equal(childEnv("sandbox-local", {}, FAKE_ENV).HOME, undefined);
});

test("scrubSecrets removes exact env secret values of any shape", () => {
  const env = { MY_SERVICE_TOKEN: "plainwordsecretvalue", SHORT_KEY: "abc" };
  const out = scrubSecrets("token=x and plainwordsecretvalue twice: plainwordsecretvalue; abc stays", env);
  assert.ok(!out.text.includes("plainwordsecretvalue"));
  assert.match(out.text, /\[redacted:env:MY_SERVICE_TOKEN\]/);
  assert.match(out.text, /abc stays/);
  assert.ok(out.redactions >= 2);
});

test("scrubSecrets keeps PII (that is redactPII's job) and scrubAndCap caps", () => {
  const out = scrubSecrets("mail me at a@example.com with sk-ant-abcdefgh12345678", {});
  assert.match(out.text, /a@example\.com/);
  assert.match(out.text, /\[redacted:api_key\]/);
  assert.equal(scrubAndCap("x".repeat(50), 10).length, 10);
});

test("redact equals PII(secrets(x)) with secret kinds counted first", () => {
  const input = "key: sk-ant-abcdefgh12345678 from bob@example.com at 192.168.1.4, Bearer abcdefgh1234";
  const both = redact(input);
  const s = redactSecrets(input);
  const p = redactPII(s.text);
  assert.equal(both.text, p.text);
  assert.deepEqual(Object.keys(both.counts).slice(0, Object.keys(s.counts).length), Object.keys(s.counts));
});

test("event catalog constants are exported", () => {
  assert.ok(EVENT_TYPES.length > 70);
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  for (const t of EVENT_TYPES) assert.match(t, /^[a-z]+\.[a-z_]+$/);
  assert.equal(GENESIS_HASH, "0".repeat(64));
  assert.equal(CONTRACT_SCHEMA, "roundtable.contract/1");
});
