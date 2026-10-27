# At the table from the terminal

`roundtable` and `agent-roundtable` invoke the same binary. Build a source checkout with `npm run build`; use `node dist/index.js` in place of `roundtable` until installed.

Browse personas with `roundtable agents` (or `agents --json`), import an absolute
file or directory with `agents import <absolute file|dir>`, and install the eight
shipped personas with `agents starter`. `agents --open` opens the local library
and file drop zone until Ctrl-C; `--no-hold` closes it immediately for tests.
Imports skip existing files. Exit codes are 0 for success, 1 if any file is
refused, and 2 for usage errors. See the [agents library](agents-library.md)
for lookup order, limits, warnings and security.

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

Choose a provider or [CLI runtime](runtimes.md) and model for individual seats with one comma-separated flag:

```sh
roundtable debate "A spending limit" --agents designer,skeptic \
  --seat designer=anthropic:sonnet,skeptic=openai:custom-model
```

Assignments resolve in this order:

1. `--seat agent=provider:model` (or `agent=provider` for that provider's default).
2. Healthy persona `provider`/`model` frontmatter.
3. `--mix auto` or `--mix cheap`, aliases for provider judgment with a cost bias.
4. Automatic [provider judgment](providers.md#provider-judgment), using role, health, budget, recent failures/latency and provider spread.

Without flags, the router chooses each seat; `--mix auto` and `--mix cheap` run the same router with a cost bias that still spreads seats across providers. Builders avoid reasoning models when an eligible alternative remains; judge and critique seats prefer known cheaper models; designer and persona chat seats use balanced defaults. Explicit providers retain their defaults and aliases. Runtime seats are never selected automatically.

Preflight sends a brief request for each selected provider/model pair, caches successful pairs and provider health for ten minutes, and retries automatic seats on surviving providers. Diagnostics contain local reasons, never keys or remote error bodies. Probes can incur a small charge. If no candidate survives, startup exits 2 with every provider and its reason.

Explicit assignments are preserved and fail by seat name when their requested preflight fails. `--no-preflight` skips probes while retaining cached health exclusions; it cannot be combined with `--preflight`. Replay and dry-run never probe providers. The terminal prints the routing exclusions once as a `Routing:` line and each seat's choice on its seat line; the NDJSON `start` event carries every seat's full routing reason, and duel room cards show it too.

Runtime seats are explicit: `--seat designer=hermes,skeptic=codex:example-model`. `--mix` selects only configured API providers. `roundtable runtimes [--json]` lists runtime detection and versions. See [CLI runtimes](runtimes.md) for profiles, configuration and prompt exposure.

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
| `--connectors a,b` | Let every seat call these configured MCP connectors (read-only tools unless the connector config lists more). An unknown name is a usage error before any provider call. See [connectors at the table](connectors.md#at-the-table) |
| `--seat-connectors s=a+b,...` | With `--connectors`: limit a seat to some of those connectors, e.g. `ada=figma,bob=jira+figma`. Seats not listed get all. A connector outside `--connectors` or a seat not at the table is a usage error. See [limiting a seat](connectors.md#limiting-a-seat) |
| `--kind` | Duel only: `web` (default), `code`, `diagram` or `text` |
| `--criteria` | Duel only: judging rubric of 1 to 8 items, comma-separated (separate with `;` instead when an item contains a comma); default: fit to the brief, quality, usability and accessibility, risk or safety, process efficiency |
| `--judges` | Duel only: 1 to 5 comma-separated agents; optional and advisory with `--human-judge` |
| `--stages` | Duel only: integer 1–4; default 4 for web and 1 for other kinds |
| `--human-judge` | Duel only: choose the winner after builds, advisory verdicts and any revision; without a room requires a TTY |
| `--resume <duel-id>` | Continue a checkpoint; no topic or duel options, replay or dry-run; display flags and `--out` are allowed |
| `--out <dir>` | Export the chosen artifact into an absent or empty real directory; refuse symlinks and overwrites |
| `--layout` | Terminal layout: `auto` (default), `split` or `stack` |
| `--duel` | Debate, waffle or meeting only: a saved duel id (`duel-<id>`) to focus the session on; the topic may then be omitted |
| `--no-duel-source` | With `--duel`: leave artifact file contents out of the brief to save tokens (titles, file names, verdicts, tally and dissents stay) |
| `--agents` | Debate, waffle or meeting participants, in speaking order |
| `--agents-dir` | Absolute persona directory; overrides the saved directory for this command |
| `--rounds` | Duel: 1 or 2 (default 1); other verbs: 1–20 (default 2) |
| `--seat` | One comma-separated set of per-agent assignments; repeated flags are refused |
| `--mix` | `auto` or `cheap`, using providers that pass automatic preflight |
| `--turn-timeout` | Per-turn timeout in seconds (default 90) |
| `--max-usd n` | Optional positive finite session spend cap in USD; checked after each metered call. Available on duel, debate, waffle, meeting and cast. |
| `--max-seconds` | Overall deadline in seconds: default 600 + 150 per extra build stage + 120 per member beyond two on the larger duel team, capped at 3600; other commands default 600 |
| `--preflight` | Check selected provider/model pairs and report pass/fail; automatic for routed seats |
| `--no-preflight` | Skip probes; retain known health exclusions |
| `--open` | Duel only: open the local room |
| `--no-room` | Duel only: terminal output without a room |
| `--no-hold` | Duel only: close the room when the run finishes |
| `--json` | Emit newline-delimited `TableEvent` JSON on stdout; diagnostics go to stderr |
| `--dry-run` | Duel only: replay the synthetic demo without provider calls or keys |
| `--replay <archive>` | Duel only: replay an archived duel without provider calls or keys |
| `--speed <N>` | Positive replay speed multiplier (default 1) |

`--help` (or `-h`) on any table command prints its usage. The topic is one positional argument before the flags; quote topics containing spaces. Terminal colors require a TTY and an unset `NO_COLOR`. Turns wrap to about six lines, prototype submissions print a short summary, and the closing footer shows spend. JSON output retains full events.

Staged web builds progress independently through Skeleton, Screens, Working and Polish. Live process metrics show time, tokens, cost, versions, rewrites and errors; judges receive an engine-written process record. Final A/B winners keep a private chosen artifact, also exported by `--out`. See [duel](modes/duel.md) and [room/layout](modes/duel-room.md).

A spend cap stops provider work after the call that reaches it. Concurrent calls already in flight can add to the final spend. Unpriced tokens use the same estimate as provider judgment ($15 per million input tokens and $75 per million output tokens); known free models count as zero. The footer and room metrics show spend against the cap. Discussions and casting exit with code 1 when the cap stops them. A capped duel saves a checkpoint and exits with a resume command: `roundtable duel --resume <id> --max-usd 5`. The new cap must exceed its cumulative spend, which carries across resumes.

A completed duel keeps its room open until Ctrl-C unless `--no-hold` is set. During a duel, the first Ctrl-C stops calls and saves a private resumable checkpoint, emitting no end event. The held room can Resume; the next Ctrl-C exits and prints `Resume with: roundtable duel --resume <id>`. With `--no-room` or `--no-hold`, the first stop exits with that line. A deadline instead judges the latest valid versions and finishes. `--human-judge --no-room` prompts `Choose the winner [A/B]:` on a TTY and is a usage error otherwise. Exit codes are 0 for completion or tie, 1 for failure or interruption, and 2 for usage errors or missing credentials.

```sh
roundtable duel --dry-run --speed 4 --no-room --no-hold --json
roundtable duel --replay /absolute/path/to/duel.json --no-hold
roundtable config show
```

See [configuration](configuration.md#saved-cli-settings-and-env-files) for saved env-file and persona-directory settings.

## Persona frontmatter chooses where session content goes

A persona's `provider` and `model` frontmatter decide which provider receives that seat's prompts and replies, for the CLI and for MCP collaborations alike. `model: inherit`, an empty model, or a Claude model name aimed at another provider falls back to that provider's default. Model ids must be printable ASCII without whitespace (up to 200 characters). Prototype file content keeps ordinary source identifiers (`tokens`, `secretKey`, `password: string`) intact; only credential-shaped values and the exact values of configured secrets are replaced there, while transcript text, reasons and titles get the full scrubber. Duel archives under `ROUNDTABLE_HOME/duels/` are scrubbed of configured secrets, written privately, and removed with the other session archives after `ROUNDTABLE_SESSION_RETENTION_DAYS`. The env file and `config.json` are ignored unless you own them and nobody else can write to them. `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` are imported from the env file only as a pair, and only when the shell sets neither.

## Casting Call

`roundtable cast "<brief>"` auditions a persona set and recommends who to seat. Omit `--agents` to use every persona in the configured directory; use `--agents-dir <absolute-path>` for another set. The set must have 2 to 24 personas.

```sh
roundtable cast "Build a queue module" --agents architect,engineer,researcher,reviewer --seats 4
roundtable cast "Draft an expenses policy" --agents-dir /absolute/path/to/agents --dry-run --json
```

| Flag | Meaning |
| --- | --- |
| `--agents a,b,...` | Personas, in audition and recommendation order |
| `--agents-dir <abs>` | Persona discovery directory |
| `--seats N` | Recommended cast size, default min(5, persona count) |
| `--no-examine` | Skip director questions and persona answers |
| `--dry-run` | Static lint and overlap report; no provider calls or keys |
| `--json` | NDJSON events, then the report object |
| `--seat …` | Shared table assignments; the neutral director's key is `casting-director` |
| `--mix auto\|cheap` | Cost-aware provider judgment |
| `--connectors a,b` | Let every seat call these configured MCP connectors; not with `--dry-run`. See [connectors at the table](connectors.md#at-the-table) |
| `--seat-connectors s=a+b,...` | Limit a persona to some of those connectors, e.g. `architect=figma` |
| `--turn-timeout s` | Per-turn timeout, default 90 seconds |
| `--max-usd n` | Optional positive finite session spend cap in USD |
| `--max-seconds s` | Whole-run deadline, default 300 seconds |

Turns stream using the table renderer. The final roster lists verdicts, roles, overlaps, redundancy, gaps and the recommended cast. When the director supplies teams, it also prints a shell-safe duel command. Archives live at `ROUNDTABLE_HOME/casting/<id>.json` and `casting/latest.json`; the terminal prints the archive path. Ctrl-C still prints and archives the available report. Exit codes: 0 completed, 1 aborted or failed, 2 usage error or missing key. See [Casting Call](modes/casting-call.md) for the report fields, costs and handoff to a contract or duel.

### Web page checks

`roundtable duel --no-page-check` skips headless page checks. By default, web builds and revisions are checked when local Chrome/Chromium is available; no browser is reported as not checked. Checks use local capability pages and a deny-all proxy, with no debugging port. The room keeps a version strip, a current/proposed comparison with a line diff, and a shared Browser screenshot panel. See [duel](modes/duel.md#page-checks-and-design-iterations).
