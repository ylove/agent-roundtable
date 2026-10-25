import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../dist/security/child-env.js";

const PRIVATE = "ROUNDTABLE_SCRUB_LITERALS";
const runnerSettings = (extra, source) => {
  const { [PRIVATE]: literals, ...settings } = childEnv("runner", extra, source);
  return settings;
};

test("runner retains provider and execution settings", () => {
  const names = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "TERM",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN",
    "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL", "OLLAMA_URL",
    "ROUNDTABLE_HOME", "ROUNDTABLE_AGENTS_DIR", "ROUNDTABLE_SKILLS_DIR", "ROUNDTABLE_WORKSPACE_DIR",
    "ROUNDTABLE_AGENT_PATHS", "ROUNDTABLE_ACTIVITY_LOG", "ROUNDTABLE_DOTENV", "ROUNDTABLE_WORKER_AUTH",
    "ROUNDTABLE_PARALLEL_TURNS", "ROUNDTABLE_MAX_TOKENS", "ROUNDTABLE_LLM_TIMEOUT_MS", "ROUNDTABLE_LOCAL_TIMEOUT_MS",
    "ROUNDTABLE_PROVIDER_RETRIES", "ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS", "ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS",
    "ROUNDTABLE_ANTHROPIC_MODEL", "ROUNDTABLE_OPENAI_MODEL", "ROUNDTABLE_TOGETHER_MODEL",
    "ROUNDTABLE_REPLICATE_MODEL", "ROUNDTABLE_OLLAMA_MODEL",
    "ROUNDTABLE_EXECUTION_ID", "ROUNDTABLE_EXECUTION_PROVIDER", "ROUNDTABLE_EXECUTION_MODEL", "ROUNDTABLE_EXECUTION_BASE_URL",
    "ROUNDTABLE_DEFAULT_VISIBILITY", "ROUNDTABLE_DEFAULT_BUDGET_USD", "ROUNDTABLE_PRICING_FILE",
    "ROUNDTABLE_EXECUTION_RETENTION_DAYS", "ROUNDTABLE_SESSION_RETENTION_DAYS", "ROUNDTABLE_AUDIT_RETENTION_DAYS",
    "ROUNDTABLE_RUNNER_TICK_MS", "ROUNDTABLE_SMOKE_CHECKS", "ROUNDTABLE_ALLOW_CODEX_DRIVER", "ROUNDTABLE_CODEX_READ_ROOTS",
    "ROUNDTABLE_ALLOW_LOCAL_SANDBOX", "ROUNDTABLE_SANDBOX_IMAGE", "ROUNDTABLE_SANDBOX_PROXY_IMAGE",
    "ROUNDTABLE_SANDBOX_MEMORY", "ROUNDTABLE_SANDBOX_CPUS", "ROUNDTABLE_SANDBOX_PIDS",
    "ROUNDTABLE_PUBLISHER", "ROUNDTABLE_NTFY_URL", "ROUNDTABLE_NTFY_TOKEN", "ROUNDTABLE_NTFY_USER", "ROUNDTABLE_NTFY_PASSWORD",
    "ROUNDTABLE_WEBHOOK_URL", "ROUNDTABLE_WEBHOOK_VIEW_URL", "ROUNDTABLE_WEBHOOK_AUTH_HEADER",
    "ROUNDTABLE_PUBLIC_TOPIC_PREFIX", "ROUNDTABLE_TRANSCRIPTS_DIR", "ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS",
    "ROUNDTABLE_PROTOTYPE_DIR", "ROUNDTABLE_PROTOTYPE_TTL_MS", "ROUNDTABLE_PROTOTYPE_OPEN",
    "ROUNDTABLE_CHROME_PATH", "ROUNDTABLE_PROTOTYPE_SCREENSHOTS", "ROUNDTABLE_PAGE_CHECKS",
  ];
  const source = Object.fromEntries(names.map(name => [name, `setting-${name}`]));
  assert.deepEqual(runnerSettings({}, source), source);
});

test("a spawned runner retains Node proxy activation and CA settings", () => {
  const network = {
    NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:8123", HTTPS_PROXY: "http://127.0.0.1:8123",
    NO_PROXY: "localhost", NODE_USE_SYSTEM_CA: "1", SSL_CERT_FILE: "/tmp/runner-ca.pem", SSL_CERT_DIR: "/tmp/runner-certs",
  };
  const env = childEnv("runner", {}, { ...network, NODE_OPTIONS: "--throw-deprecation", DATABASE_PASSWORD: "host-only-password" });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DATABASE_PASSWORD, undefined);
  const script = `
    import assert from "node:assert/strict";
    import http from "node:http";
    import https from "node:https";
    const expected = ${JSON.stringify(network)};
    for (const [name, value] of Object.entries(expected)) assert.equal(process.env[name], value, name);
    if (process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
      // The startup flag activates both built-in HTTP agents, without needing network access.
      for (const agent of [http.globalAgent, https.globalAgent]) {
        assert.equal(agent.options.proxyEnv?.HTTP_PROXY, expected.HTTP_PROXY);
        assert.equal(agent.options.proxyEnv?.HTTPS_PROXY, expected.HTTPS_PROXY);
      }
    }
    process.stdout.write("proxy activation retained");
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(output, "proxy activation retained");
});

test("runner composes worker, git, docker and gh allowlists", () => {
  const names = [
    "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME",
    "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_NOSYSTEM",
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN",
  ];
  const source = Object.fromEntries(names.map(name => [name, `setting-${name}`]));
  assert.deepEqual(runnerSettings({}, source), source);
  const conditional = { ANTHROPIC_AUTH_TOKEN: "worker-token", ANTHROPIC_BASE_URL: "http://localhost:8080" };
  for (const name of Object.keys(conditional)) assert.equal(runnerSettings({}, conditional)[name], undefined);
  assert.deepEqual(runnerSettings({}, { ...conditional, ROUNDTABLE_WORKER_AUTH: "api_key" }), {
    ...conditional, ROUNDTABLE_WORKER_AUTH: "api_key",
  });
  for (const [flag, credentials] of [
    ["CLAUDE_CODE_USE_BEDROCK", ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH"]],
    ["CLAUDE_CODE_USE_VERTEX", ["CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS",
      "ANTHROPIC_VERTEX_BASE_URL", "CLAUDE_CODE_SKIP_VERTEX_AUTH"]],
    ["CLAUDE_CODE_USE_FOUNDRY", ["ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY",
      "CLAUDE_CODE_SKIP_FOUNDRY_AUTH"]],
  ]) {
    const platform = Object.fromEntries(credentials.map(name => [name, `setting-${name}`]));
    assert.deepEqual(runnerSettings({}, platform), {});
    assert.deepEqual(runnerSettings({}, { ...platform, [flag]: "1" }), { ...platform, [flag]: "1" });
  }
});

test("runner drops unrelated settings and runtime overrides", () => {
  const dropped = [
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH", "NPM_TOKEN", "DATABASE_PASSWORD", "UNRELATED_API_KEY", "ROUNDTABLE_UNRELATED_TOKEN",
  ];
  const source = Object.fromEntries(dropped.map(name => [name, "unused-value"]));
  assert.deepEqual(runnerSettings({}, source), {});
  assert.deepEqual(runnerSettings({ ROUNDTABLE_EXECUTION_ID: "exe-test", PATH: undefined }, { PATH: "/bin" }), {
    ROUNDTABLE_EXECUTION_ID: "exe-test",
  });
});

test("runner receives configured literals without the individual host variables", () => {
  const source = {
    DATABASE_PASSWORD: "database-value-123456",
    SERVICE_TOKEN: "database-value-123456-extra",
    DUPLICATE_SECRET: "database-value-123456",
    SHORT_PASSWORD: "short",
    GIT_AUTHOR_NAME: "Example Author",
    UNRELATED_SETTING: "ordinary-value",
    [PRIVATE]: JSON.stringify(["inherited-value-123456", "tiny", 42, null]),
  };
  const env = childEnv("runner", {}, source);
  assert.deepEqual(Object.keys(env), [PRIVATE]);
  assert.deepEqual(JSON.parse(env[PRIVATE]), [
    source.SERVICE_TOKEN, "inherited-value-123456", source.DATABASE_PASSWORD, "tiny",
  ]);
  assert.deepEqual(childEnv("runner", {}, env), env);
});

test("only the runner profile receives the private literal variable, including extra overrides", () => {
  const runner = childEnv("runner", {}, { DATABASE_PASSWORD: "host-database-value-123456" });
  for (const profile of ["claude-worker", "codex-worker", "local-meeting", "git", "gh", "docker", "browser", "open", "sandbox-local", "cloud-cli", "secret-cli", "connector"]) {
    for (const extra of [{}, { [PRIVATE]: runner[PRIVATE] }]) {
      const worker = childEnv(profile, extra, runner);
      assert.equal(worker[PRIVATE], undefined, profile);
      assert.equal(worker.DATABASE_PASSWORD, undefined, profile);
      assert.ok(!Object.values(worker).includes(runner[PRIVATE]), profile);
    }
  }
});

test("a runner process and its output relay redact host literals without package dotenv", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rt-runner-scrub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secret = 'host-only-database-value-123456-"quoted"';
  const env = childEnv("runner", {}, { DATABASE_PASSWORD: secret, ROUNDTABLE_DOTENV: "off" });
  assert.equal(env.DATABASE_PASSWORD, undefined);
  const script = `
    import "./dist/env.js";
    import { readFileSync } from "node:fs";
    import { childEnv } from "./dist/security/child-env.js";
    import { scrubConfiguredSecrets } from "./dist/security/secrets.js";
    import { spawnWorker, workerExit } from "./dist/workers/process.js";
    const secret = readFileSync(0, "utf8");
    const workerEnv = childEnv("codex-worker");
    const { pid } = await spawnWorker({
      file: process.execPath,
      args: ["-e", 'process.stdin.pipe(process.stdout);'],
      cwd: process.cwd(), env: workerEnv, prompt: secret,
      outputPath: ${JSON.stringify(join(dir, "output.log"))},
    });
    const exit = await workerExit(pid);
    if (exit.code !== 0) throw new Error("worker failed");
    process.stdout.write(JSON.stringify({
      direct: scrubConfiguredSecrets(secret).text,
      payload: scrubConfiguredSecrets(process.env.${PRIVATE}).text,
      envDump: scrubConfiguredSecrets(JSON.stringify(process.env)).text,
      relay: readFileSync(${JSON.stringify(join(dir, "output.log"))}, "utf8"),
      hostVariableAbsent: process.env.DATABASE_PASSWORD === undefined,
      privateVariableAbsent: workerEnv.${PRIVATE} === undefined,
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env, input: secret, encoding: "utf8", timeout: 15_000,
  });
  const result = JSON.parse(output);
  assert.equal(result.hostVariableAbsent, true);
  assert.equal(result.privateVariableAbsent, true);
  for (const name of ["direct", "payload", "envDump", "relay"]) {
    assert.doesNotMatch(result[name], /host-only-database-value/);
    assert.match(result[name], /\[redacted:/);
  }
});
