# Configuration

| Variable | Required for | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `anthropic` | — |
| `OPENAI_API_KEY` | `openai` | — |
| `TOGETHER_API_KEY` | `together` | — |
| `REPLICATE_API_TOKEN` | `replicate` | — |
| `OPENAI_COMPATIBLE_BASE_URL` | `openai_compatible` (unless `base_url` is passed) | — |
| `OPENAI_COMPATIBLE_API_KEY` | optional | — |
| `OPENAI_COMPATIBLE_MODEL` | `openai_compatible` | `default` |
| `OLLAMA_URL` | `ollama` | `http://localhost:11434` |
| `ROUNDTABLE_AGENTS_DIR` | agent prompt lookup; also set from the `agentsDir` saved with `roundtable config`, or per command with `--agents-dir` | `.claude/agents` (relative to the server's working directory — use an absolute path) |
| `ROUNDTABLE_SKILLS_DIR` | last skill lookup location after personal/project skills; new create skills and improve skills outside `.claude/agents` | `skills` beside the agents directory (normally `.claude/skills`) |
| `ROUNDTABLE_WORKSPACE_DIR` | conversation grounding | project containing `.claude/agents`, otherwise server working directory |
| `ROUNDTABLE_ACTIVITY_LOG` | stored session activity; excerpts in private conversation grounding and private improve prompts | `~/.agent-roundtable/activity.jsonl`; `off`, `false`, `0` or `no` disables it |
| `ROUNDTABLE_PARALLEL_TURNS` | concurrent ultraplan phases and workshop reviews | `4` (minimum 1) |
| `ROUNDTABLE_ANTHROPIC_MODEL` | default model for `anthropic` (id or alias) | `claude-sonnet-5-5` |
| `ROUNDTABLE_OPENAI_MODEL` | default OpenAI model | `gpt-5.6-luna` |
| `ROUNDTABLE_TOGETHER_MODEL` | default Together model | `zai-org/GLM-5.3` |
| `ROUNDTABLE_REPLICATE_MODEL` | default Replicate model | `qwen/qwen3-235b-a22b-instruct-2507` |
| `ROUNDTABLE_OLLAMA_MODEL` | default Ollama model | `qwen3:14b` |
| `ROUNDTABLE_MAX_TOKENS` | max output tokens (thinking tokens count) | `8192` |
| `ROUNDTABLE_LLM_TIMEOUT_MS` | per-request timeout | `600000` |
| `ROUNDTABLE_PUBLISHER` | public sessions: `ntfy` or `webhook` | `ntfy` |
| `ROUNDTABLE_NTFY_URL` | ntfy server | `https://ntfy.sh` |
| `ROUNDTABLE_NTFY_TOKEN` | ntfy access token (`tk_...`), if the server needs auth | — |
| `ROUNDTABLE_NTFY_USER` / `ROUNDTABLE_NTFY_PASSWORD` | ntfy basic auth, alternative to the token | — |
| `ROUNDTABLE_WEBHOOK_URL` | webhook publisher: URL that receives each entry as JSON; https, or http to loopback or a private (LAN) address; never a cloud metadata address | — |
| `ROUNDTABLE_WEBHOOK_VIEW_URL` | webhook publisher: URL template for the viewing page, `{channel}` is replaced | — |
| `ROUNDTABLE_WEBHOOK_AUTH_HEADER` | webhook publisher: header name and value, e.g. `Authorization: Bearer abc123` | — |
| `ROUNDTABLE_PUBLIC_TOPIC_PREFIX` | prefix of the generated public channel name | `roundtable` |
| `ROUNDTABLE_TRANSCRIPTS_DIR` | where public-session transcripts are saved | `~/.agent-roundtable/transcripts` |
| `ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS` | max wait for pending posts when a public session ends | `30000` |
| `ROUNDTABLE_PROTOTYPE_DIR` | prototype sandbox root; refused inside a git work tree, as a symlink, or when owned by another user; created with mode 0700 | `<os temp dir>/agent-roundtable-prototypes` |
| `ROUNDTABLE_PROTOTYPE_TTL_MS` | prototype safety cap: a prototype still under assessment after this long is destroyed; values below `60000` are raised to `60000` | `1800000` (30 min) |
| `ROUNDTABLE_PROTOTYPE_OPEN` | open the prototype blackboard in a browser at session start | off (`1`, `true`, `yes` or `on` enables) |
| `ROUNDTABLE_CHROME_PATH` | Chrome/Chromium binary for public-session screenshots | auto-detect: the Google Chrome or Chromium app (macOS) or Chrome install (Windows), then `google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` on `PATH` |
| `ROUNDTABLE_PROTOTYPE_SCREENSHOTS` | screenshots of web prototypes; only used by public prototype sessions | on (`0`, `false`, `no` or `off` disables) |
| `ROUNDTABLE_PAGE_CHECKS` | headless page checks of web artifacts (duels, prototype mode, `page_loads` verify) | on when Chrome is found (`0` disables) |
| `ROUNDTABLE_LOCAL_TIMEOUT_MS` | local meetings: timeout for one `claude -p` call; the CLI's process group is killed after it | `300000` (5 min) |
| `ROUNDTABLE_WORKER_AUTH` | `api_key` passes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` to the `claude` CLI (local meetings) and `OPENAI_API_KEY` to `codex`, and `GEMINI_API_KEY` / `GOOGLE_API_KEY` to a `runtime:gemini` worker; otherwise they use their own login (including `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and Bedrock, Vertex or Foundry credentials when the CLI is set to use them) and get no provider keys | CLI login |
| `ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS` | a per-call `base_url` may reach private, CGNAT, link-local and ULA addresses, over plain http too (cloud metadata stays blocked; loopback is always allowed) | off (`1`, `true`, `yes` or `on` enables) |
| `ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS` | comma-separated origins (`https://host:port`) besides `OPENAI_COMPATIBLE_BASE_URL`'s that receive `OPENAI_COMPATIBLE_API_KEY` when passed as `base_url` | — (the key goes only to the configured origin) |
| `ROUNDTABLE_AGENT_PATHS` | extra directories (separated by `:`, or `;` on Windows) that path-like agent refs may point into | — (the agents directory, `<workspace>/.claude/agents`, `~/.claude/agents` and the existing non-symlink library are allowed) |
| `ROUNDTABLE_PROVIDER_RETRIES` | retries after a provider call fails with 408, 409, 429, 5xx or a network error (backoff with jitter, `Retry-After` honored up to 60 s, always within `ROUNDTABLE_LLM_TIMEOUT_MS`) | `2` (`0` disables, at most `5`) |
| `ROUNDTABLE_ENV_FILE` | absolute path of a private env file that supplies provider keys and model defaults the shell did not set; overrides the `envFile` saved with `roundtable config`. Rules: [saved CLI settings and env files](#saved-cli-settings-and-env-files) | the saved `envFile`, otherwise none |
| `ROUNDTABLE_DOTENV` | `off` skips loading `.env` entirely (worker MCP servers start keyless) | `.env` is loaded |
| `ROUNDTABLE_DEFAULT_VISIBILITY` | how `execute` shows a run when the call names no channel: a comma list of `dashboard`, `chat_only` and `github:<owner/name>` | — (`execute` asks) |
| `ROUNDTABLE_DEFAULT_BUDGET_USD` | a run's budget when neither `execute` nor the contract sets one | — (`execute` asks) |
| `ROUNDTABLE_EXECUTION_PROVIDER` | provider of the runner's persona calls: micro-huddles, the lead fallback and goal review | `anthropic` |
| `ROUNDTABLE_EXECUTION_MODEL` | model of those calls | the provider's default model |
| `ROUNDTABLE_EXECUTION_BASE_URL` | `base_url` of those calls (an `openai_compatible` or `ollama` endpoint) | — (the provider's configured URL) |
| `ROUNDTABLE_EXECUTION_RETENTION_DAYS` | days a completed, failed or aborted run (worktrees, branches, log) is kept; swept at server start | `30` (`0` or `off` keeps all) |
| `ROUNDTABLE_SESSION_RETENTION_DAYS` | days an archived at-the-table session, and a postmortem draft that was never held, is kept; swept at server start | `30` (`0` or `off` keeps all) |
| `ROUNDTABLE_AUDIT_RETENTION_DAYS` | days the audit log keeps a month file after the month ended; swept at server start | `365` (`0` or `off` keeps all) |

The launcher's environment takes precedence. The package `.env` (next to `package.json`) fills unset variables; an optional pointed env file then fills allowed unset variables. Existing values, including empty values, are preserved. See [`.env.example`](../.env.example).

## Saved CLI settings and env files

```sh
roundtable config set env-file /absolute/path/to/private.env
roundtable config set agents-dir /absolute/path/to/agents
roundtable config show
```

Settings are saved as `{ "envFile": "…", "agentsDir": "…" }` in `~/.agent-roundtable/config.json`, or `ROUNDTABLE_HOME/config.json` when a state root is configured. Writes use mode 0600. `config show` prints `env-file: set|unset`, `agents-dir: set|unset`, secret names with backend ids, and connector names with env variable names; it never displays paths, locators or values.

`ROUNDTABLE_ENV_FILE` overrides the saved `envFile`. The target must be an absolute path to an accessible regular file. A file readable by group or world produces a warning without revealing its path. Restrict it to mode 0600. Invalid targets are skipped with a path-free warning.

**Owner-only rule.** Both `config.json` and the pointed env file are read only when you own them and neither group nor world can write to them (mode 0600 or 0644 passes; 0666, or a file owned by another user, does not). A file that fails the rule is skipped with a path-free warning: the settings and keys in it are not used. The package `.env` is not subject to this rule.

**OpenAI-compatible pair rule.** `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` travel together. From the pointed file they are imported only as a pair, and only when the shell set neither of them, so a key from a file can never be sent to an endpoint the shell chose. Set both in the file, or both in the shell.

Only these key names may be copied from the pointed file:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TOGETHER_API_KEY`, `REPLICATE_API_TOKEN`
- `OPENAI_COMPATIBLE_*`
- `ROUNDTABLE_*_MODEL`

Other credentials, shell settings and paths from that file are ignored. Parsing never populates the entire pointed file into the environment. The pointed file preserves existing values, including empty values. Precedence is the launcher's environment, then package `.env`, then the pointed file.

The saved `agentsDir` sets `ROUNDTABLE_AGENTS_DIR` only when the variable is unset, before model and persona configuration is evaluated. `--agents-dir` overrides it for a terminal session. Set paths through `config set` or the shell, because the pointed env-file allowlist excludes `ROUNDTABLE_AGENTS_DIR`.

`ROUNDTABLE_DOTENV=off` skips both env files. Worker and hook processes also skip saved settings and both env files, preserving their launcher's environment. Provider defaults use `claude-sonnet-5-5` for `anthropic`; the `opus` alias selects `claude-opus-5-5` explicitly and `haiku` selects `claude-haiku-5-5`.

See [the table CLI](table-cli.md) for mixed-provider seats, preflight and replay.

## State root and sandbox

The [agents library](agents-library.md) lives at `<ROUNDTABLE_HOME>/agents`.
It is created with mode 0700 on first import; persona files use mode 0600.
Configured agents take precedence over library personas. A symlinked library
directory is not an allowed root.

These settings complete the table above. `SANDBOX_ENV` is re-exported by `src/sandbox/index.ts` from `src/sandbox/common.ts`; defaults also come from `src/sandbox/docker.ts`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `ROUNDTABLE_HOME` | Root for the agents library (`agents/`), execution state, sessions, worktrees, audit, activity and transcripts unless individually overridden | `~/.agent-roundtable`; fresh OS temp directory in a Node test process when unset |
| `ROUNDTABLE_SANDBOX_IMAGE` | Default Docker command/check image; contract `sandbox.image` can override it | `node:22-bookworm-slim` |
| `ROUNDTABLE_SANDBOX_PROXY_IMAGE` | Docker HTTPS install-egress proxy image | `node:22-alpine` |
| `ROUNDTABLE_SANDBOX_MEMORY` | Docker memory limit with swap disabled; invalid values warn and fall back | `2g` |
| `ROUNDTABLE_SANDBOX_CPUS` | Positive Docker CPU quota; invalid values warn and fall back | `2` |
| `ROUNDTABLE_SANDBOX_PIDS` | Docker process limit, integer 16–1000000; invalid values warn and fall back | `512` |
| `ROUNDTABLE_ALLOW_LOCAL_SANDBOX` | Allow the weaker local command backend | off; exactly `1` enables, or explicitly choose `execute(sandbox: "local")` |
| `ROUNDTABLE_ALLOW_CODEX_DRIVER` | Opt into the Codex worker driver and its broader access model | off; exactly `1` enables, or explicitly choose `execute(worker_driver: "codex")` |
| `ROUNDTABLE_ALLOW_RUNTIME_WORKERS` | Opt into runtime profiles (`hermes`, `openclaw`, `gemini`, or a configured one) as heads-down workers, `workers.driver: "runtime:<name>"`; contract validation and `execute` refuse the choice without it. See [runtimes as workers](runtimes.md#as-heads-down-workers) | off; exactly `1` enables |
| `ROUNDTABLE_CODEX_READ_ROOTS` | Extra absolute, colon-separated toolchain read roots in the Codex permissions profile; denied home/state/checkout roots stay denied | none |
| `ROUNDTABLE_PRICING_FILE` | JSON model-price overrides, USD per million tokens; re-read when file changes | built-in table; unknown rates are estimated |
| `ROUNDTABLE_SMOKE_CHECKS` | Comma-separated contract command ids for integration checks after each merge | contract `validation.final` |

Explicit sandbox flags are opt-ins to reduced isolation, not provider choices. A contract's structured install step separately supplies allowed HTTPS hosts; it does not inherit the host's network credentials. See [budgets and sandbox](heads-down.md#budgets-and-sandbox).

Pricing file example (numbers here illustrate the schema, not current prices):

```json
{
  "my-model": { "input": 1, "output": 4, "cache_read": 0.1, "cache_write": null }
}
```

Each model requires `input` and `output` (non-negative numbers or `null`); cache rates are optional. An optional `long` object supplies `above_tokens` and rates for longer contexts. Invalid files fail validation. See `src/execution/pricing.ts` for the built-in table and schema.

## CLI login and inherited environment

Provider keys in the main table belong to the orchestrator and trusted runner. Local meetings and worker CLIs use their own login unless `ROUNDTABLE_WORKER_AUTH=api_key`. `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are also passed to Claude under that opt-in; Codex receives `OPENAI_API_KEY`. `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` and `CLAUDE_CONFIG_DIR` configure Claude's own login. `CODEX_HOME` configures Codex's own credential/config location.

The child allowlists in `src/security/child-env.ts` additionally recognize these environment groups. They have no roundtable default; they are inherited only by profiles that need them:

| Profile | Environment |
| --- | --- |
| Base | `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TZ`, `TMPDIR`, `TERM` |
| Proxy and CA (CLI/git/gh/Docker) | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `https_proxy`, `http_proxy`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` |
| Claude Bedrock (only when `CLAUDE_CODE_USE_BEDROCK` is set) | `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH` |
| Claude Vertex (only when `CLAUDE_CODE_USE_VERTEX` is set) | `CLAUDE_CODE_USE_VERTEX`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_BASE_URL`, `CLAUDE_CODE_SKIP_VERTEX_AUTH` |
| Claude Foundry (only when `CLAUDE_CODE_USE_FOUNDRY` is set) | `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` |
| git | `SSH_AUTH_SOCK`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_CONFIG_NOSYSTEM`; sets `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` |
| GitHub CLI | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `GH_ENTERPRISE_TOKEN`; sets `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1` |
| Docker | `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY` |
| Browser/open | `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` |
| Cloud CLI | `CLOUDSDK_CONFIG`, `FLY_CONFIG_DIR` |

Claude children set `TERM=dumb`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`; worker Claude also sets `MCP_TOOL_TIMEOUT=1200000`. Codex sets `TERM=dumb` and `NO_COLOR=1`. The local sandbox inherits only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` and sets `CI=1`. The trusted runner deliberately inherits the full environment. No per-command contract `env` key may look credential-shaped or carry a recognized secret value.

## Set by the server (do not set)

The server and runner set these for the processes they start. They are not operator configuration; setting them yourself has no supported effect.

| Name | Where | Meaning |
| --- | --- | --- |
| `ROUNDTABLE_EXECUTION_ID`, `ROUNDTABLE_AGENT_ID` | worker and hook processes | The run and agent identity a worker or the lease hook acts as. |
| `ROUNDTABLE_LAUNCH_INTENT`, `ROUNDTABLE_LAUNCH_SHA` | the detached output relay of a worker launch | Path of the launch record in the agent's directory and the hash of the agent's token. The relay checks them (under a lock) before it starts, so a launch cancelled in the meantime never begins, and writes a receipt. |
| `RT_EGRESS_ALLOW`, `RT_PROXY_PORT` | the Docker install-egress proxy container | The allowed HTTPS hosts (comma-separated) from the contract's install step, and the port the proxy listens on. |
| `RT_PROXY_HOST` | the same proxy | Listen address; defaults to `0.0.0.0` inside the container, and the runner does not set it. |

`RT_HOME` is not an environment variable: it is the name of a parameter the macOS local-sandbox profile receives, hiding the state root from local commands. `ROUNDTABLE_LABEL`, `ROUNDTABLE_SERVER` and `ROUNDTABLE_TOOL_PREFIX` in the source are constants (the `roundtable` GitHub issue label, the `roundtable` server name in generated worker configuration, and the `mcp__roundtable__` tool prefix), not variables.

Terminal output honors the standard `NO_COLOR` (any value turns colors off in the table commands, `usage` and `statusline`) and `COLUMNS` (the status line width).

## Test and internal environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `NODE_TEST_CONTEXT` | Set by Node's test runner; config uses fresh temp state and warns once if `ROUNDTABLE_HOME` is unset | absent outside tests; do not set manually |
| `ROUNDTABLE_RUNNER_TICK_MS` | Runner tick for tests/demos, 50–10000 ms | `1500` |
| `ROUNDTABLE_TEST_CHROME` | `1` enables real-browser screenshot tests | off |
| `ROUNDTABLE_LIVE_TEST` | `1` permits paid live-provider smoke tests | off |
| `ROUNDTABLE_LIVE_PROVIDERS` | Comma-separated live test providers | `anthropic,openai,together` |
| `ROUNDTABLE_LIVE_REPLICATE` | `1` adds Replicate to live checks | off |
| `ROUNDTABLE_LIVE_OPENAI_COMPATIBLE` | `1` adds the configured compatible endpoint | off |
| `ROUNDTABLE_LIVE_OLLAMA` | `1` also checks Ollama | off |

The standard unit-test preload isolates state, HOME, persona/skill directories and transcripts, disables retries and browser opening, and cleans up. The config fallback protects the state root when you invoke `node --test` without that preload; it does not isolate every explicitly configured path or clean up the fresh temp directory automatically.

## Credential references and worker connectors

Use `roundtable config set secret ANTHROPIC_API_KEY secret://keychain/roundtable/anthropic` to save a reference under `secrets` in the user config. Shell values win for referenced keys; otherwise references beat plaintext files. Startup resolves synchronously within 20 seconds; a failure warns by name and leaves the key unset. `ROUNDTABLE_SECRETS=off` disables startup resolution. Workers and hooks never run the startup broker. See [secrets](secrets.md) for backends, checks, caching and the resolver interface.

The `connectors` config defines extra stdio MCP servers by absolute executable path, separate arguments and an env map. Credentials use references. Heads-down contracts opt in with `connectors: ["issues"]`; names are covered by consent. Claude workers support them; Codex workers refuse them. An optional `tools` list on a connector allows non-read-only tools for seats at the table, which opt in with `--connectors` or the `connectors` argument. See [connectors](connectors.md) for configuration, limits and trust.

## Long-running service and private check-ins

These options are independent of public session publishers. Use `roundtable config set notify.<key> <value>`; restart `serve` after changes. See [long-running runs](long-running.md) for setup and privacy details.

| Saved key | Meaning | Default |
| --- | --- | --- |
| `notify.events` | Comma-separated list or JSON array of `awaiting_human`, `budget`, `completed`, `failed`, `aborted`, `postmortem_ready`, `runner_keeps_dying` | All listed events |
| `notify.ntfy.url` | Authenticated ntfy server; HTTPS except loopback | Unset |
| `notify.ntfy.topic` | Private topic, 16–64 letters/digits/underscores/hyphens; generate with `notify init ntfy` | Unset |
| `notify.ntfy.token` | `secret://` reference to bearer token | Unset |
| `notify.ntfy.user` | `secret://` reference to username, paired with password | Unset |
| `notify.ntfy.password` | `secret://` reference to password | Unset |
| `notify.webhook.url` | Signed check-in receiver; HTTPS except loopback | Unset |
| `notify.webhook.secret` | `secret://` reference to HMAC signing secret | Unset |
| `notify.desktop` | `true` for macOS or Linux desktop check-ins | `false` |

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `ROUNDTABLE_NOTIFY_NTFY_TOKEN` | Private ntfy bearer token; overrides the saved reference | Unset |
| `ROUNDTABLE_NOTIFY_WEBHOOK_SECRET` | Private webhook HMAC secret; overrides the saved reference | Unset |

`serve` uses `ROUNDTABLE_HOME/serve/` for its lock, metadata, private detached log, notification cursors/queues and relaunch history. All state files are 0600. `--bind tailnet` opts into a locally assigned private tailnet address; no wildcard bind or public tunnel is supported. Service definition printouts never contain environment values and must be installed by the person.
