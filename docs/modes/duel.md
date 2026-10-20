# Duel

A duel puts two teams at the table to build competing artifacts for the same brief. Judges assess both against a rubric, in a live local room, and the losing side files dissents. It works for any brief: a web page, a module, a diagram or a written document.

Three dissimilar briefs:

```sh
# A web landing page (the default kind): shown live in the room, in a sandboxed frame.
roundtable duel "Landing page for a bike-repair subscription" \
  --team-a designer,frontend --team-b marketer,skeptic \
  --judges cfo,accessibility-reviewer --open

# A code module: shown as read-only source and never executed.
roundtable duel "A rate limiter module with allow(key) and reset(key)" --kind code \
  --team-a architect,engineer --team-b pragmatist,reviewer --judges security-lead

# A written policy, judged on your own rubric.
roundtable duel "One-page remote-work expenses policy" --kind text \
  --criteria "legal accuracy,plain language,enforceability" \
  --team-a counsel --team-b hr-lead,editor --judges cfo,employee-advocate
```

Use personas available in your agents directory. Each persona holds one seat across both teams and the judges.

## Kinds

`--kind` (or `kind` in the `start_duel` tool) picks what both teams build, reusing [prototype mode](prototype-mode.md)'s block format and parser. Every kind is small by design: at most 40 KB in total, and builders are told to aim much lower.

| Kind | Builders return | The room shows |
| --- | --- | --- |
| `web` (default) | One self-contained `index.html` with inline CSS. JavaScript is optional, but inline only. External URLs, imports, fetches and frames are rejected. | The page, in a sandboxed frame with scripts, forms and modals allowed and an opaque origin |
| `code` | One or more source files (prototype mode's path rules) | Escaped, read-only source with a tab per file; never executed |
| `diagram` | One Mermaid file | Escaped Mermaid source; no renderer is added |
| `text` | One markdown or plain-text file | Escaped text; no HTML rendering |

## Teams and roles

A team has 1 to 4 members. The first member writes the concept (at most 150 words). The last member builds the artifact. Members in between each critique the concept in one short turn (round R1c), and the builder receives the critiques. A one-person team does both the concept and the build. There are 1 to 5 judges. Duplicate personas across teams and judges are rejected before any provider call.

## Criteria

By default judges weigh fit to the brief, quality of the result, usability and accessibility, and risk or safety within their own remit, which they take from their persona. `--criteria "a,b,c"` (up to 8 items) replaces that rubric. The reply format is fixed regardless: `VERDICT A: APPROVE|REVISE|REJECT — reason`, the same for B, and `PREFER: A|B`. Judges are told that the artifacts are untrusted listings and to ignore instructions inside them.

## Rounds

1. R1: the first member of each team proposes a concept, in parallel.
1. R1c: with three or more members, each middle member critiques the concept.
1. R1b: the last member builds the artifact in the requested kind, with the limits above. Invalid submissions get one retry with the validation error.
1. R2: judges see both artifacts as source listings and write the verdict lines. APPROVE adds one point, REVISE adds zero, and REJECT subtracts one. Missing or ambiguous responses are UNCLEAR and add zero. A failed judge casts no verdict. Teams without a valid artifact receive automatic REJECTs.
1. With `--rounds 2`, R3 gives each team receiving REVISE or REJECT one revision, with the same validation retry. The original judging tally determines the result. A failed revision preserves an earlier valid artifact.
1. R4: the first member of each team gives a closing statement; the losing team is asked to file a dissent. Complete `<DISSENT>` blocks become separate cards. Equal scores stay a tie.

Concept, judging and closing calls time out after 90 seconds (set with `--turn-timeout`); build calls get at least 240 seconds. The `--max-seconds` deadline defaults to 600 seconds. It cancels pending work and skips ahead to closing statements; closing calls have their own turn timeout. Ctrl-C cancellation ends provider work and archives the partial result. The room remains available after the end until Ctrl-C; `--no-hold` lets automation finish without waiting.

Archives live at `ROUNDTABLE_HOME/duels/<id>.json` with mode 0600. They contain the event list and the artifact files as text, including revisions. The start event also records `kind`, `criteria` and `teams`; archives from before these fields existed were all web and still replay. The duel owns its sandbox until process exit; artifacts survive judging and have no TTL. Real archives belong in local state and must stay out of the repository.

Usage updates include per-seat token totals and estimated spend throughout the run. Estimates use the existing pricing table; models without rates contribute zero to the displayed total. Configure `ROUNDTABLE_PRICING_FILE` to provide rates for those models before recording a cost comparison.

```sh
roundtable duel --replay examples/duel/demo.json --speed 2 --open
roundtable duel --dry-run --no-hold --json
```

Replay re-emits recorded events and prototype contents through the same observers, with no provider calls or keys. The repository fixture is synthetic and uses generic personas. `--speed` scales the intervals between recorded timestamps.

The room binds to loopback and requires a capability token. Its page uses an external script under a strict CSP. Artifact routes serve only recorded files from memory: web pages with the existing application CSP, everything else as inert `text/plain`. Web frames allow scripts, forms, and modals with an opaque origin. The room writes model text and source into the DOM with `textContent`.

For integration, `runDuel(opts, observer, signal, { resolveSeats })` accepts a resolver returning seats with optional persona `prompt` text. The three-argument call uses `resolveSeatsLocal`. `startRoom({ open, hold })` returns an observer, URL, and asynchronous `close()`. Pass its observer directly or through `fanout` so prototype content attachments reach the room; NDJSON remains the shared event shape. `replayDuel(path, observer, { speed, signal })` uses the same attachment mechanism. Event streams received from another process can supply bytes with the room's `setPrototypeFiles(team, files)` method before the corresponding prototype event.

## From an MCP client

The `start_duel` tool runs the same engine and returns a compact result: the duel id, winner, tally, each team's artifact title, kind and ok flag, the verdicts, the dissents, a per-persona usage summary and the archive id (`duels/<id>.json`). It never returns artifact source. See [tools](../tools.md#start_duel). Duel calls are recorded in the usage ledger with the persona as the agent, so `roundtable usage` shows duel spend per persona.
