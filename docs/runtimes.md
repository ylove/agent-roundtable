# CLI runtimes at the table

An installed agent CLI can sit at the table alongside API providers. Select a runtime explicitly for a persona:

```sh
roundtable debate "Review the plan" --agents designer,skeptic \
  --seat designer=hermes,skeptic=codex
roundtable debate "Review the plan" --agents x \
  --seat x=agy:gemini-3.8-flash-medium
roundtable runtimes
roundtable runtimes --json
```

`runtimes` lists built-in and configured profiles, found/not found, the absolute executable path and an optional version probe. A failed probe includes a scrubbed diagnostic. The command does not start an agent turn.

Use `--seat agent=runtime[:model]`. The MCP `start_collaboration` and `start_duel` tools accept the same names in the `provider` field of their `seats` argument:

```json
{
  "seats": {
    "designer": { "provider": "hermes" },
    "skeptic": { "provider": "codex", "model": "example-model" }
  }
}
```

An omitted model uses the CLI's own default. A model override is a separate flag and value; identifiers must start with a letter or digit and contain only letters, digits, `.`, `_`, `:`, `/` or `-` (128 characters maximum). Runtimes are explicit-only: `--mix`, session defaults and persona frontmatter never select them. API providers retain their existing behavior. Each turn sends the persona and conversation context to a fresh CLI invocation; runtime conversation sessions are not resumed.

## Built-in profiles

| Runtime | Invocation | Output |
| --- | --- | --- |
| `hermes` | `hermes chat -q {prompt}` | Plain text with decoration stripped; dash-leading argv prompts get a leading newline. |
| `openclaw` | `openclaw agent --message {prompt}` | Plain text; dash-leading argv prompts get a leading newline. Requires its local gateway on `127.0.0.1:18789`. |
| `gemini` | `gemini -p {prompt} --output-format json` | JSON `response`; defensive usage extraction from `stats`; dash-leading argv prompts get a leading newline. |
| Google Antigravity (`agy`) | `agy -p {prompt} --output-format json --mode plan --disable-slash-commands` | JSON `response`; requires `status: "SUCCESS"`; usage from `usage.input_tokens` and `usage.output_tokens`; dash-leading argv prompts get a leading newline. |
| `codex` | `codex exec --json --skip-git-repo-check … -` | Prompt on stdin; last completed agent/assistant message in JSONL; usage from turn completion. |

All profiles support an explicit model via `--model`, or `-m` for `codex`. They use the CLI's installed configuration and login where supported. The codex profile ignores user configuration and rules, uses a read-only sandbox, sets approval policy to `never` and inherits only the core shell environment, following the heads-down driver's safety flags. It gets `CODEX_HOME` when set. The runtime seat does not use the heads-down worker protocol.

Only the codex profile runs sandboxed (read-only); hermes, openclaw and gemini run their own agent loops with the allowlisted environment and an empty temporary cwd but can read the user's filesystem; runtimes are opt-in by explicit name only.

Google Antigravity is a separate CLI from the Gemini CLI; `gemini` keeps its existing profile. In agy 1.4.7, `--mode plan` has no effect with `--disable-slash-commands`; the resulting stderr warning is expected and harmless when exit code is 0 and status is `SUCCESS`. Seats rely on headless print mode's default denial of tools requiring permission for read-only behavior, not plan mode or a filesystem sandbox. The plan flag remains in the profile. Slash expansion is disabled so prompts or briefs starting with `/` stay literal. The profile never bypasses permissions. A non-`SUCCESS` result (including a missing status) fails with a short scrubbed status/error diagnostic, even on exit 0. An empty or whitespace-only `response` also fails with the runner's no-final-text error; this includes a `SUCCESS` result with `denied_actions` after a tool permission denial. agy uses its own saved sign-in; no API-key environment variable is configured. Model ids come from `agy models`, for example `gemini-3.8-flash-medium` or `gemini-4-argon-high`.

**Process-list exposure:** hermes, openclaw, gemini and agy pass the full prompt as one argv element because these profiles use their prompt flags. Other local processes may see it in process listings. agy's `-p` requires its value as the next argument and does not read plain text from stdin; its stream-json input needs NDJSON envelopes that this runner does not produce. Prompts beginning with `-` or `/` are passed as the single, literal `-p` value without a shell. Codex receives the prompt on stdin. Prefer stdin for custom CLIs that support it.

**Antigravity usage:** input and output are the reported `usage.input_tokens` and `usage.output_tokens` only. agy reports `thinking_tokens` separately; it is not folded into output because usage path arrays are alternatives, not sums. `cache_read_tokens` and `total_tokens` are not separately recorded. There is no reported USD cost: Antigravity bills in credits, which roundtable does not convert to dollars. The same accounting applies to its workers.

The hermes heuristic removes ANSI color sequences, lines containing only box/border characters, and leading lines beginning with `Hermes`, `Hermes Agent`, `loading` or `connected`. It can remove legitimate prose resembling a banner; override `output` with `{ "mode": "text" }` to preserve it. `hermes acp` is a possible future upgrade; this adapter uses `chat`.

## As heads-down workers

The same profiles can run [heads-down](heads-down.md) tasks. Name one as the contract's worker driver, `workers.driver: "runtime:<name>"`, or pass `execute(worker_driver: "runtime:<name>")`:

```sh
ROUNDTABLE_ALLOW_RUNTIME_WORKERS=1
```

Runtime workers are opt-in: with the variable unset, contract validation and `execute` refuse the choice with a message naming it, and an unknown runtime name is refused the same way (`roundtable runtimes` lists the names). `runtime:codex` is not offered; use the [Codex driver](heads-down.md#codex-opt-in), which has the full integration (permissions profile, thread resume). Connector contracts are refused on runtime workers.

| Runtime | Gets the roundtable tools | How it submits | Sandbox flag |
| --- | --- | --- | --- |
| `gemini` | yes, through a settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, written next to the worker's other private files and removed when the run ends) naming the roundtable worker server | calls `submit_work` itself | `--sandbox`, plus `--approval-mode auto_edit` and `--allowed-mcp-server-names roundtable` |
| Google Antigravity (`agy`) | no (no per-run MCP injection or isolation) | driver-side `submit_work` after exit 0 and a successful, nonempty JSON result | `--mode accept-edits --sandbox --disable-slash-commands` |
| `hermes`, `openclaw` | no (no MCP in non-interactive mode) | the driver calls `submit_work` when the runtime exits 0, with the runtime's final output (scrubbed, capped) as the summary | none |
| a configured runtime | no | as above | none |

Every runtime worker runs in the task worktree. The prompt (the worker protocol, then the task card) is passed the way the profile takes input: on argv for the profiles whose `argv` has `{prompt}` (so other local processes can see it in a process listing, as for seats), otherwise on stdin. The environment is the core allowlist (`PATH`, `HOME`, locale, proxy and certificate names, `TERM=dumb`, `NO_COLOR=1`) plus the names the profile lists in `env`; no `ROUNDTABLE_*` setting and no provider key reaches the runtime. With `ROUNDTABLE_WORKER_AUTH=api_key`, `gemini` also gets `GEMINI_API_KEY` and `GOOGLE_API_KEY`; otherwise the CLI's own login is used.

For Antigravity, set `workers.driver: "runtime:agy"` and optionally `workers.model: "gemini-3.8-flash-medium"` with the runtime-worker opt-in enabled. Its worker mode replaces the seat's `plan` mode. agy 1.4.7 has no per-run flag/settings override to inject the roundtable MCP server, allow only that server, or prevent the user's other MCP servers and plugins from loading. **The owner's own agy MCP servers and plugins load in this worker.** Disabling slash expansion does not disable plugin loading. Roundtable never runs `agy mcp add`, modifies agy's global configuration, or passes `--dangerously-skip-permissions`. `--sandbox` restricts terminal commands; it does not isolate MCP servers or plugins. agy has no roundtable tools and cannot request more leases, so the driver submits within the task's existing write paths. JSON errors and empty replies fail the attempt without submitting edits.

A small wrapper process starts the runtime and relays its output as JSON lines through the same scrubbing relay and monitor as other workers. For a runtime without MCP the wrapper takes the worker's single-use token before the runtime starts, so the runtime never sees it. A non-zero exit fails the attempt and nothing is submitted; a stop request ends the runtime's whole process group. Runtime conversations are not resumed: a resumed task starts a fresh run with the new task card. While the runtime runs, the wrapper writes a heartbeat line every minute, since these CLIs print little before they finish; the contract's wall clock and budget still bound the run.

Leases are enforced at submit, as for Codex: `submit_work` commits only the paths the task's lease covers and rejects the submission when anything else changed, which fails the attempt with the paths named. A runtime without MCP cannot request more leases; it works within the task's write paths from the task card.

**Usage.** A runtime that reports tokens or cost (gemini does, through its `usage` paths) is recorded as reported. Otherwise the wrapper estimates tokens from text lengths and the monitor prices them from the pricing table with the contract's `workers.model` (or `ROUNDTABLE_PRICING_FILE` for models the table lacks), recorded as estimated; the watchdog enforces the budget on that figure. Set `workers.model` for a profile that reports nothing, or the estimate prices at zero.

**Confinement.** `gemini` and `agy` workers run with their own `--sandbox` flag. The other profiles have no sandbox flag: their commands run with the user's permissions inside the task worktree, which is why the opt-in exists. The launch log says which applies, and the driver does not launch a worker while another worker's token file is still unconsumed. Use a runtime's own permission settings for more. The `gemini` flags are those of its CLI at the time of writing and were not run against a live install in this repository's tests; the fixtures cover how the roundtable starts it. agy's behavior and limits above follow the owner's probes of version 1.4.7.

Tests use fake executables in `test/fixtures/runtime-workers/`; none needs the real CLIs.

## Configuration

Add `runtimes` to `~/.agent-roundtable/config.json` (or the configured `ROUNDTABLE_HOME`). Existing settings remain alongside it:

```json
{
  "runtimes": {
    "hermes": {
      "timeoutMs": 180000,
      "output": { "mode": "text" }
    },
    "my-agent": {
      "argv": ["/absolute/path/to/my-agent", "--plain", "-"],
      "modelFlag": "--model",
      "output": { "mode": "json", "path": "a.b.0.c" },
      "usage": {
        "inputTokens": "usage.input_tokens",
        "outputTokens": "usage.output_tokens",
        "costUsd": "usage.cost_usd"
      },
      "versionArgv": ["--version"],
      "env": ["MY_AGENT_CONFIG"]
    }
  }
}
```

Names match `^[a-z][a-z0-9_-]{0,31}$`, cannot shadow a provider, and are limited to 64 configured entries. New profiles require `argv` and `output`. Built-in overrides may replace `argv`, `output`, `timeoutMs`, `stdoutMaxBytes`, `stderrMaxBytes` and `env`; they cannot introduce execution modes or change the other built-in fields. Unknown spec fields are rejected, including `shell`.

`argv` is an array of at most 64 nonempty strings, each at most 4096 characters without control characters. The first must be an absolute path to a regular executable file. Built-in profiles without an argv override resolve their command names through absolute PATH directories. Relative paths and shell command strings are rejected. Shell interpreters cannot be configured as the executable. Arguments are literal; no interpolation, expansion or shell quoting occurs. A single whole argument `{prompt}` is replaced by the full prompt, with a leading newline added when it begins with `-`. This guard applies to configured profiles, seats and worker wrappers, keeping prompt flags and their values together. Without it, the prompt is written to stdin and stdin is closed. `modelFlag` names one option; its value is always a separate argument. `versionArgv` contains only probe arguments, excluding the binary.

After prompt substitution, each argument is limited to 100 KiB and the full argument list to 128 KiB. Larger requests fail before spawning; use a stdin-capable profile or override `argv` to send the prompt on stdin.

Output modes:

- `{ "mode": "text" }`: trimmed stdout; optional `stripDecoration: true` uses the hermes heuristic.
- `{ "mode": "json", "path": "response" }`: a dotted path, including numeric array indexes.
- JSON can also require a result status: `{ "mode": "json", "path": "response", "status": { "path": "status", "success": "SUCCESS", "errorPath": "error" } }`. Any other or missing status fails, with a scrubbed, capped diagnostic; `errorPath` is optional. This is used by `agy` and enforced for seats and workers.
- `{ "mode": "jsonl", "filter": { "type": "item.completed", "item.type": ["agent_message", "assistant_message"] }, "path": "item.text" }`: every filter condition must match; a value array means any listed value; the last matching event supplies the final text. Every nonempty line must be JSON.

Optional `usage` paths extract nonnegative numbers. An array of paths tries each in order; `*` in a usage path sums across object entries (for example `stats.models.*.tokens.input`). JSONL usage is summed across events reporting both token counts; costs are summed across events reporting cost. Missing or malformed usage leaves token counts estimated from text lengths; reported counts and costs retain `reported` provenance. Unpriced usage remains unpriced. Ledger entries contain counts and identifiers, without prompts or replies.

## Process safety and limits

Runtime children always use `shell: false` and a detached process group. Each invocation runs in a fresh temporary directory that is removed afterward. A custom profile can set an absolute `cwd` explicitly; this is never inferred from the repository. This directory choice does not itself sandbox a CLI's tools; use the CLI's own permissions settings.

The runtime environment passes PATH, HOME, locale/timezone, TMPDIR, proxy and certificate variables, plus `TERM=dumb` and `NO_COLOR=1`. Only names explicitly listed in a spec's `env` pass beyond that allowlist. Provider API keys, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TOGETHER_API_KEY` and `REPLICATE_API_TOKEN`, are excluded unless individually named there. Passing HOME permits the CLI to find its saved login.

Defaults are 120 seconds, 1 MiB stdout and 64 KiB stderr. Configurable limits are capped at one hour, 16 MiB stdout and 1 MiB stderr. A timeout, cancellation or either output overflow terminates the entire process group with SIGTERM, then SIGKILL after a short grace period, and waits for the CLI to close. Overflow is marked as truncated and fails the turn. Output and error diagnostics are scrubbed using the shared secret rules; failures include a bounded stdout error message (JSON/JSONL) or tail (text), plus a stderr tail when present. Nonzero exit and spawn failures fail the turn clearly.

CLI seat preflight checks binary availability and the optional version probe, without sending a prompt or charging a provider call. Existing `--preflight` and `--no-preflight` switches apply. Preflight does not verify saved login or gateway availability.

## Verification

Fake executables in `test/fixtures/runtimes/` cover parsing, safety, configuration, seat selection, preflight and ledger accounting in the normal unit suite. To spend real CLI calls using installed binaries and saved logins:

```sh
ROUNDTABLE_LIVE_RUNTIMES=1 npm run test:live
ROUNDTABLE_LIVE_RUNTIMES=hermes,codex npm run test:live
```

Missing binaries are skipped. These live calls are opt-in and never run in the normal unit suite.

agy is excluded from the general live smoke unless `ROUNDTABLE_TEST_AGY=1` is also set. Its dedicated smoke makes one tiny seat call from a fresh empty scratch directory, using `--model gemini-3.8-flash-low --print-timeout 60s` and the installed CLI's saved sign-in:

```sh
ROUNDTABLE_TEST_AGY=1 node --test test/live-agy.mjs
```

Without that variable the dedicated smoke is skipped. No real agy is used by the unit fixtures or CI by default.
