# At the table from the terminal

`roundtable` and `agent-roundtable` invoke the same binary. Build a source checkout with `npm run build`; use `node dist/index.js` in place of `roundtable` until installed.

```sh
roundtable duel "Landing page for a bike-repair subscription" \
  --team-a designer,builder --team-b marketer,skeptic \
  --judges cfo,safety-reviewer --mix auto --open

roundtable duel "One-page expenses policy" --kind text --criteria "legal accuracy,plain language" \
  --team-a counsel --team-b hr-lead,editor --judges cfo

roundtable debate "A weekly spending limit" --agents designer,skeptic --rounds 2
roundtable waffle "A weekly spending limit" --agents designer,cfo,skeptic --rounds 2
roundtable meeting "A weekly spending limit" --agents designer,builder,cfo
```

Duel gives each team 1 to 4 members (the first writes the concept, the last builds, any between critique) and 1 to 5 judges. Each agent needs a unique seat. The room shows the two artifacts, assessments, dissent and outcome; `--open` opens it in a browser. See [duel](modes/duel.md) for rounds and scoring.

`debate` makes the first persona the proponent and the others challengers. `waffle` makes the first persona the defender; each round ends with its rebuttal. `meeting` runs a collaboration where participants take turns. These three commands need at least two agents, stream from the opening turn, then archive their transcripts. They use the existing collaboration engine.

## Seats and models

Choose a provider and model for individual seats with one comma-separated flag:

```sh
roundtable debate "A spending limit" --agents designer,skeptic \
  --seat designer=anthropic:sonnet,skeptic=openai:custom-model
```

Assignments resolve in this order:

1. `--seat agent=provider:model` (or `agent=provider` for that provider's default).
2. `--mix auto` or `--mix cheap`.
3. The persona's `provider` and `model` frontmatter, only when those keys exist.
4. The default provider and its configured model.

An explicit provider chooses its matching default model unless a model is specified with it. A model-only frontmatter key uses the default provider. `--mix` replaces the frontmatter assignment and cycles through providers with configured credentials; team B starts one provider later than team A. With a single configured provider all seats use that provider. A configured compatible endpoint or explicitly configured local endpoint can participate without a key.

Both mixes use the configured provider defaults. The default for `anthropic` is `claude-sonnet-5-5`; aliases `sonnet`, `haiku` and `opus` resolve to the current model IDs. Opus requires an explicit model choice or configured model override. `cheap` does not promise a price or select Opus automatically.

`--preflight` sends one brief request for every distinct provider/model pair before starting and reports pass or fail on stderr. Diagnostics never include keys or remote error bodies. These are live calls and can incur a small charge. Missing keys produce exit code 2 before the run.

Both `--mix auto` and `--mix cheap` run preflight automatically. Each configured candidate provider is checked, including candidates not used by the initial roster. Any provider with a failed check is excluded, with one warning such as `anthropic: auth failed, excluded from mix`. Seats are then reassigned across the remaining providers; the teams start on different providers when at least two remain. If no provider passes, the command exits 2.

Explicit `--seat` assignments are preserved: if their provider fails preflight, the command exits 2 and names the seat and provider. Use `--no-preflight` to skip automatic mix checks and exclusions. It cannot be combined with `--preflight`. Replay and dry-run never make preflight requests.

For MCP parity, `start_collaboration` accepts a `seats` object keyed by the exact agent identifiers. Explicit session-wide `provider`/`model` arguments preserve their existing behavior, with per-seat overrides taking priority:

```json
{
  "agents": ["designer", "skeptic"],
  "topic": "A spending limit",
  "seats": {
    "designer": { "provider": "anthropic", "model": "sonnet" },
    "skeptic": { "provider": "openai", "model": "custom-model" }
  }
}
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--team-a`, `--team-b` | Duel only: 1 to 4 comma-separated agents per team; first writes the concept, last builds, any between critique |
| `--kind` | Duel only: `web` (default), `code`, `diagram` or `text` |
| `--criteria` | Duel only: comma-separated judging rubric (default: fit to the brief, quality, usability and accessibility, risk or safety) |
| `--judges` | Duel only: 1 to 5 comma-separated agents |
| `--agents` | Debate, waffle or meeting participants, in speaking order |
| `--agents-dir` | Absolute persona directory; overrides the saved directory for this command |
| `--rounds` | Duel: 1 or 2 (default 1); other verbs: 1–20 (default 2) |
| `--seat` | One comma-separated set of per-agent assignments; repeated flags are refused |
| `--mix` | `auto` or `cheap`, using providers that pass automatic preflight |
| `--turn-timeout` | Per-turn timeout in seconds (default 90) |
| `--max-seconds` | Overall deadline in seconds (default 600) |
| `--preflight` | Check each distinct provider/model and report pass/fail; automatic for mixes |
| `--no-preflight` | Skip automatic mix preflight and provider exclusion |
| `--open` | Duel only: open the local room |
| `--no-room` | Duel only: terminal output without a room |
| `--no-hold` | Duel only: close the room when the run finishes |
| `--json` | Emit newline-delimited `TableEvent` JSON on stdout; diagnostics go to stderr |
| `--dry-run` | Duel only: replay the synthetic demo without provider calls or keys |
| `--replay <archive>` | Duel only: replay an archived duel without provider calls or keys |
| `--speed <N>` | Positive replay speed multiplier (default 1) |

The topic is one positional argument before the flags; quote topics containing spaces. Terminal colors require a TTY and an unset `NO_COLOR`. Turns wrap to about six lines, prototype submissions print a short summary, and the closing footer shows spend. JSON output retains full events.

A completed duel keeps its room open until Ctrl-C unless `--no-hold` is set. During a run, the first Ctrl-C aborts and lets the runner archive; its room stays available. A second Ctrl-C exits. Exit codes are 0 for completion or tie, 1 for failure or interruption, and 2 for usage errors or missing credentials.

```sh
roundtable duel --dry-run --speed 4 --no-room --no-hold --json
roundtable duel --replay /absolute/path/to/duel.json --no-hold
roundtable config show
```

See [configuration](configuration.md#saved-cli-settings-and-env-files) for saved env-file and persona-directory settings.

## Persona frontmatter chooses where session content goes

A persona's `provider` and `model` frontmatter decide which provider receives that seat's prompts and replies, for the CLI and for MCP collaborations alike. `model: inherit`, an empty model, or a Claude model name aimed at another provider falls back to that provider's default. Model ids must be printable ASCII without whitespace (up to 200 characters). Prototype file content keeps ordinary source identifiers (`tokens`, `secretKey`, `password: string`) intact; only credential-shaped values and the exact values of configured secrets are replaced there, while transcript text, reasons and titles get the full scrubber. Duel archives under `ROUNDTABLE_HOME/duels/` are scrubbed of configured secrets, written privately, and removed with the other session archives after `ROUNDTABLE_SESSION_RETENTION_DAYS`. The env file and `config.json` are ignored unless you own them and nobody else can write to them. `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` are imported from the env file only as a pair, and only when the shell sets neither.
