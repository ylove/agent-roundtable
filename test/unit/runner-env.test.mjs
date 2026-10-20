import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../../dist/security/child-env.js";

test("runner retains provider and execution settings", () => {
  const names = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "TERM",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
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
    "ROUNDTABLE_CHROME_PATH", "ROUNDTABLE_PROTOTYPE_SCREENSHOTS",
  ];
  const source = Object.fromEntries(names.map(name => [name, `setting-${name}`]));
  assert.deepEqual(childEnv("runner", {}, source), source);
});

test("runner composes worker, git, docker and gh allowlists", () => {
  const names = [
    "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME",
    "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_NOSYSTEM",
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN",
  ];
  const source = Object.fromEntries(names.map(name => [name, `setting-${name}`]));
  assert.deepEqual(childEnv("runner", {}, source), source);
  const conditional = { ANTHROPIC_AUTH_TOKEN: "worker-token", ANTHROPIC_BASE_URL: "http://localhost:8080" };
  for (const name of Object.keys(conditional)) assert.equal(childEnv("runner", {}, conditional)[name], undefined);
  assert.deepEqual(childEnv("runner", {}, { ...conditional, ROUNDTABLE_WORKER_AUTH: "api_key" }), {
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
    assert.deepEqual(childEnv("runner", {}, platform), {});
    assert.deepEqual(childEnv("runner", {}, { ...platform, [flag]: "1" }), { ...platform, [flag]: "1" });
  }
});

test("runner drops unrelated settings and runtime overrides", () => {
  const dropped = [
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH", "NPM_TOKEN", "DATABASE_PASSWORD", "UNRELATED_API_KEY", "ROUNDTABLE_UNRELATED_TOKEN",
  ];
  const source = Object.fromEntries(dropped.map(name => [name, "unused-value"]));
  assert.deepEqual(childEnv("runner", {}, source), {});
  assert.deepEqual(childEnv("runner", { ROUNDTABLE_EXECUTION_ID: "exe-test", PATH: undefined }, { PATH: "/bin" }), {
    ROUNDTABLE_EXECUTION_ID: "exe-test",
  });
});
