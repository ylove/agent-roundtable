// ============================================================================
// Child-process environment allowlists
//
// Children never inherit process.env wholesale: provider keys, publisher credentials and anything
// else secret-shaped stay in this process unless a profile explicitly needs them.
// ============================================================================

export type ChildEnvProfile =
  | "claude-worker"
  | "codex-worker"
  | "local-meeting"
  | "git"
  | "gh"
  | "docker"
  | "browser"
  | "open"
  | "sandbox-local"
  | "cloud-cli"
  | "runner";

/**
 * Names that look like credentials (used by secret scrubbing, tests and the contract validator).
 * AUTH, PASS and CRED count only as whole name segments, so GIT_AUTHOR_NAME, BYPASS_CACHE and
 * session ids are not treated as secrets while ROUNDTABLE_WEBHOOK_AUTH_HEADER and DB_PASS are.
 */
export const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|(?:^|_)(?:AUTH|PASS|CREDS?)(?:_|$)/i;

const BASE = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "TERM"];
const PROXY = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const DISPLAY = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/** Opt-in: CLI children (claude, codex) get the roundtable's provider key instead of their own login. */
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
  // The runner is this package's own code and needs provider keys for huddles; it inherits everything.
  runner: (s) => ({ pass: Object.keys(s), set: {} }),
};

/**
 * Build a child environment from an allowlist profile. `extra` is applied last (callers use it for
 * per-run values such as ROUNDTABLE_EXECUTION_ID); undefined values in `extra` delete a key.
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
  return env;
}
