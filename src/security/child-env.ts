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

function claudeCliNames(source: NodeJS.ProcessEnv): string[] {
  const names = [...BASE, ...PROXY, "CLAUDE_CONFIG_DIR"];
  if (cliUsesApiKey(source)) names.push("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL");
  if (source.CLAUDE_CODE_USE_BEDROCK) {
    names.push("CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN");
  }
  if (source.CLAUDE_CODE_USE_VERTEX) {
    names.push("CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS");
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
