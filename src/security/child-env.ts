// ============================================================================
// Child-process environment allowlists
//
// Children never inherit process.env wholesale: provider keys, publisher credentials and anything
// else secret-shaped stay in this process unless a profile explicitly needs them.
// ============================================================================

import { configuredSecretLiterals, SCRUB_LITERALS_ENV } from "./secrets.js";
export { SECRET_NAME_RE } from "./secrets.js";

export type ChildEnvProfile =
  | "runtime"
  | "claude-worker"
  | "codex-worker"
  | "runtime-worker"
  | "local-meeting"
  | "git"
  | "gh"
  | "docker"
  | "browser"
  | "open"
  | "sandbox-local"
  | "cloud-cli"
  | "secret-cli"
  | "connector"
  | "runner"
  | "serve";

const BASE = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "TERM"];
const PROXY = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA",
];
const DISPLAY = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

const RUNNER_PROVIDER = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN",
  "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL", "OLLAMA_URL",
];

// Settings read by config, the runner, its workers, pricing and sandbox backends.
const RUNNER_CONFIG = [
  "ROUNDTABLE_HOME", "ROUNDTABLE_AGENTS_DIR", "ROUNDTABLE_SKILLS_DIR", "ROUNDTABLE_WORKSPACE_DIR",
  "ROUNDTABLE_AGENT_PATHS", "ROUNDTABLE_ACTIVITY_LOG", "ROUNDTABLE_DOTENV", "ROUNDTABLE_WORKER_AUTH",
  "ROUNDTABLE_PARALLEL_TURNS", "ROUNDTABLE_MAX_TOKENS", "ROUNDTABLE_LLM_TIMEOUT_MS", "ROUNDTABLE_LOCAL_TIMEOUT_MS",
  "ROUNDTABLE_PROVIDER_RETRIES", "ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS", "ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS",
  "ROUNDTABLE_ANTHROPIC_MODEL", "ROUNDTABLE_OPENAI_MODEL", "ROUNDTABLE_TOGETHER_MODEL",
  "ROUNDTABLE_REPLICATE_MODEL", "ROUNDTABLE_OLLAMA_MODEL",
  "ROUNDTABLE_EXECUTION_ID", "ROUNDTABLE_EXECUTION_PROVIDER", "ROUNDTABLE_EXECUTION_MODEL", "ROUNDTABLE_EXECUTION_BASE_URL",
  "ROUNDTABLE_DEFAULT_VISIBILITY", "ROUNDTABLE_DEFAULT_BUDGET_USD", "ROUNDTABLE_PRICING_FILE",
  "ROUNDTABLE_EXECUTION_RETENTION_DAYS", "ROUNDTABLE_SESSION_RETENTION_DAYS", "ROUNDTABLE_AUDIT_RETENTION_DAYS",
  "ROUNDTABLE_RUNNER_TICK_MS", "ROUNDTABLE_SMOKE_CHECKS", "ROUNDTABLE_ALLOW_CODEX_DRIVER", "ROUNDTABLE_CODEX_READ_ROOTS", "ROUNDTABLE_ALLOW_RUNTIME_WORKERS",
  "ROUNDTABLE_ALLOW_LOCAL_SANDBOX", "ROUNDTABLE_SANDBOX_IMAGE", "ROUNDTABLE_SANDBOX_PROXY_IMAGE",
  "ROUNDTABLE_SANDBOX_MEMORY", "ROUNDTABLE_SANDBOX_CPUS", "ROUNDTABLE_SANDBOX_PIDS",
  "ROUNDTABLE_PUBLISHER", "ROUNDTABLE_NTFY_URL", "ROUNDTABLE_NTFY_TOKEN", "ROUNDTABLE_NTFY_USER", "ROUNDTABLE_NTFY_PASSWORD",
  "ROUNDTABLE_WEBHOOK_URL", "ROUNDTABLE_WEBHOOK_VIEW_URL", "ROUNDTABLE_WEBHOOK_AUTH_HEADER",
  "ROUNDTABLE_PUBLIC_TOPIC_PREFIX", "ROUNDTABLE_TRANSCRIPTS_DIR", "ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS",
  "ROUNDTABLE_PROTOTYPE_DIR", "ROUNDTABLE_PROTOTYPE_TTL_MS", "ROUNDTABLE_PROTOTYPE_OPEN",
  "ROUNDTABLE_CHROME_PATH", "ROUNDTABLE_PROTOTYPE_SCREENSHOTS", "ROUNDTABLE_PAGE_CHECKS",
];

/** The key variables a runtime worker's CLI may be handed with ROUNDTABLE_WORKER_AUTH=api_key (its own login is used otherwise). */
export const RUNTIME_WORKER_API_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** Opt-in: CLI children (claude, codex, runtimes) get the roundtable's provider key instead of their own login. */
function cliUsesApiKey(source: NodeJS.ProcessEnv): boolean {
  return (source.ROUNDTABLE_WORKER_AUTH ?? "").toLowerCase() === "api_key";
}

/**
 * The claude CLI's own login always passes (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`, is the
 * CLI's credential, not the roundtable's). The roundtable's Anthropic credentials pass only with
 * ROUNDTABLE_WORKER_AUTH=api_key; a cloud platform's credentials only when the CLI is set to use it.
 */
function claudeCliNames(source: NodeJS.ProcessEnv): string[] {
  const names = [...BASE, ...PROXY, "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];
  if (cliUsesApiKey(source)) names.push("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL");
  if (source.CLAUDE_CODE_USE_BEDROCK) {
    names.push(
      "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    );
  }
  if (source.CLAUDE_CODE_USE_VERTEX) {
    names.push(
      "CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS",
      "ANTHROPIC_VERTEX_BASE_URL", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    );
  }
  if (source.CLAUDE_CODE_USE_FOUNDRY) {
    names.push(
      "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY",
      "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    );
  }
  return names;
}

const PROFILES: Record<ChildEnvProfile, (source: NodeJS.ProcessEnv) => { pass: string[]; set: Record<string, string> }> = {
  "secret-cli": (s) => ({ pass: [...BASE, ...Object.keys(s).filter(k => k.startsWith("OP_")), "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"], set: {} }),
  connector: () => ({ pass: BASE, set: {} }),
  runtime: () => ({ pass: ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", ...PROXY, "ALL_PROXY", "all_proxy", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"], set: { TERM: "dumb", NO_COLOR: "1" } }),
  "claude-worker": (s) => ({
    pass: claudeCliNames(s),
    set: { TERM: "dumb", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", MCP_TOOL_TIMEOUT: "1200000" },
  }),
  "local-meeting": (s) => ({
    pass: claudeCliNames(s),
    set: { TERM: "dumb", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
  }),
  "codex-worker": (s) => ({
    pass: [...BASE, ...PROXY, "CODEX_HOME", ...(cliUsesApiKey(s) ? ["OPENAI_API_KEY"] : [])],
    set: { TERM: "dumb", NO_COLOR: "1" },
  }),
  // A runtime worker: the core environment only. Its profile's own variables and the api-key set above are added by the driver.
  "runtime-worker": () => ({ pass: [...BASE, ...PROXY], set: { TERM: "dumb", NO_COLOR: "1" } }),
  git: () => ({
    pass: [...BASE, ...PROXY, "SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_NOSYSTEM"],
    set: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }),
  gh: () => ({
    pass: [...BASE, ...PROXY, "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN"],
    set: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  }),
  docker: () => ({
    pass: [...BASE, ...PROXY, "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"],
    set: {},
  }),
  browser: () => ({ pass: [...BASE, ...DISPLAY], set: {} }),
  open: () => ({ pass: [...BASE, ...DISPLAY], set: {} }),
  "sandbox-local": () => ({ pass: ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"], set: { CI: "1" } }),
  "cloud-cli": () => ({ pass: [...BASE, ...PROXY, "CLOUDSDK_CONFIG", "FLY_CONFIG_DIR"], set: {} }),
  serve: (s) => ({
    pass: [...PROFILES.runner(s).pass, ...DISPLAY, "ROUNDTABLE_NOTIFY_NTFY_TOKEN", "ROUNDTABLE_NOTIFY_WEBHOOK_SECRET"],
    set: {},
  }),
  runner: (s) => ({
    pass: [
      ...BASE, ...PROXY, ...RUNNER_PROVIDER, ...RUNNER_CONFIG, "ROUNDTABLE_SECRETS",
      ...claudeCliNames(s), ...PROFILES["codex-worker"](s).pass, ...(cliUsesApiKey(s) ? RUNTIME_WORKER_API_KEYS : []),
      ...PROFILES.git(s).pass, ...PROFILES.docker(s).pass, ...PROFILES.gh(s).pass,
      ...PROFILES["secret-cli"](s).pass,
    ],
    set: {},
  }),
};

/**
 * Build a child environment from an allowlist profile. `extra` is applied last (callers use it for
 * per-run values such as ROUNDTABLE_EXECUTION_ID); undefined values in `extra` delete a key.
 * The private scrub-literal variable is computed for the runner and supervisor and excluded from other profiles.
 */
export function childEnv(
  profile: ChildEnvProfile,
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const { pass, set } = PROFILES[profile](source);
  const env: Record<string, string> = {};
  for (const name of pass) {
    const v = source[name];
    if (typeof v === "string") env[name] = v;
  }
  Object.assign(env, set);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  delete env[SCRUB_LITERALS_ENV];
  if (profile === "runner" || profile === "serve") {
    const literals = configuredSecretLiterals({ ...source, ...extra });
    if (literals.length) env[SCRUB_LITERALS_ENV] = JSON.stringify(literals);
  }
  return env;
}
