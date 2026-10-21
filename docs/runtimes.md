# CLI runtimes at the table

An installed agent CLI can sit at the table alongside API providers. Select a runtime explicitly for a persona:

```sh
roundtable debate "Review the plan" --agents designer,skeptic \
  --seat designer=hermes,skeptic=codex
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
| `hermes` | `hermes chat -q {prompt}` | Plain text with decoration stripped. |
| `openclaw` | `openclaw agent --message {prompt}` | Plain text; requires its local gateway on `127.0.0.1:18789`. |
| `gemini` | `gemini -p {prompt} --output-format json` | JSON `response`; defensive usage extraction from `stats`. |
| `codex` | `codex exec --json --skip-git-repo-check … -` | Last completed agent/assistant message in JSONL; usage from turn completion. |

All profiles support an explicit model via `--model`, or `-m` for `codex`. They use the CLI's installed configuration and login where supported. The codex profile ignores user configuration and rules, uses a read-only sandbox, sets approval policy to `never` and inherits only the core shell environment, following the heads-down driver's safety flags. It gets `CODEX_HOME` when set. The runtime seat does not use the heads-down worker protocol.

**Process-list exposure:** hermes, openclaw and gemini pass the full prompt as one argv element because these profiles use their prompt flags. Other local processes may see it in process listings. Codex receives the prompt on stdin. Prefer stdin for custom CLIs that support it.

The hermes heuristic removes ANSI color sequences, lines containing only box/border characters, and leading lines beginning with `Hermes`, `Hermes Agent`, `loading` or `connected`. It can remove legitimate prose resembling a banner; override `output` with `{ "mode": "text" }` to preserve it. `hermes acp` is a possible future upgrade; this adapter uses `chat`.

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
      "argv": ["my-agent", "--plain", "-"],
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

`argv` is an array of at most 64 nonempty strings, each at most 4096 characters without control characters. The first is an absolute executable path or bare command name, resolved without a shell through PATH. Relative paths and shell command strings are rejected. Shell interpreters cannot be configured as the executable. Arguments are literal; no interpolation, expansion or shell quoting occurs. A single whole argument `{prompt}` is replaced by the full prompt. Without it, the prompt is written to stdin and stdin is closed. `modelFlag` names one option; its value is always a separate argument. `versionArgv` contains only probe arguments, excluding the binary.

Output modes:

- `{ "mode": "text" }`: trimmed stdout; optional `stripDecoration: true` uses the hermes heuristic.
- `{ "mode": "json", "path": "response" }`: a dotted path, including numeric array indexes.
- `{ "mode": "jsonl", "filter": { "type": "item.completed", "item.type": ["agent_message", "assistant_message"] }, "path": "item.text" }`: every filter condition must match; a value array means any listed value; the last matching event supplies the final text. Every nonempty line must be JSON.

Optional `usage` paths extract nonnegative numbers. An array of paths tries each in order; `*` in a usage path sums across object entries (for example `stats.models.*.tokens.input`). JSONL usage is summed across events reporting both token counts; costs are summed across events reporting cost. Missing or malformed usage leaves token counts estimated from text lengths; reported counts and costs retain `reported` provenance. Unpriced usage remains unpriced. Ledger entries contain counts and identifiers, without prompts or replies.

## Process safety and limits

Runtime children always use `shell: false` and a detached process group. Each invocation runs in a fresh temporary directory that is removed afterward. A custom profile can set an absolute `cwd` explicitly; this is never inferred from the repository. This directory choice does not itself sandbox a CLI's tools; use the CLI's own permissions settings.

The runtime environment passes PATH, HOME, locale/timezone, TMPDIR, proxy and certificate variables, plus `TERM=dumb` and `NO_COLOR=1`. Only names explicitly listed in a spec's `env` pass beyond that allowlist. Provider API keys, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TOGETHER_API_KEY` and `REPLICATE_API_TOKEN`, are excluded unless individually named there. Passing HOME permits the CLI to find its saved login.

Defaults are 120 seconds, 1 MiB stdout and 64 KiB stderr. Configurable limits are capped at one hour, 16 MiB stdout and 1 MiB stderr. A timeout, cancellation or either output overflow terminates the entire process group with SIGTERM, then SIGKILL after a short grace period, and waits for the CLI to close. Overflow is marked as truncated and fails the turn. Output and error diagnostics are scrubbed using the shared secret rules; errors include a bounded stderr tail. Nonzero exit and spawn failures fail the turn clearly.

CLI seat preflight checks binary availability and the optional version probe, without sending a prompt or charging a provider call. Existing `--preflight` and `--no-preflight` switches apply. Preflight does not verify saved login or gateway availability.

## Verification

Fake executables in `test/fixtures/runtimes/` cover parsing, safety, configuration, seat selection, preflight and ledger accounting in the normal unit suite. To spend real CLI calls using installed binaries and saved logins:

```sh
ROUNDTABLE_LIVE_RUNTIMES=1 npm run test:live
ROUNDTABLE_LIVE_RUNTIMES=hermes,codex npm run test:live
```

Missing binaries are skipped. These live calls are opt-in and never run in the normal unit suite.
