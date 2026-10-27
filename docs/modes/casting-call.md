# Casting Call

Casting Call answers who to seat for a brief. Use it when you have several personas with similar descriptions, need to find missing expertise, or want a cast before a duel, a contract or a heads-down run. It works with any persona set and any brief.

```sh
roundtable cast "Build a queue module with bounded memory" \
  --agents architect,engineer,researcher,reviewer --seats 4
roundtable cast "Draft an expenses policy" --agents-dir /absolute/path/to/agents
```

Omit `--agents` to audition every persona in the configured directory. The set must contain 2 to 24 personas. `--seats` defaults to the smaller of five and the set size; it cannot exceed the set size. More details: [terminal commands](../table-cli.md), [MCP tool](../tools.md#casting_call).

## Flow

1. Local lint checks descriptions, empty or short bodies (fewer than 40 words), tools beyond Read/Grep/Glob, dated model pins and duplicate names. Token-set Jaccard similarity over the description and first 400 body words produces overlap clusters at 0.45 or higher, ignoring common stop words.
2. Each persona auditions with its own body as the system prompt. In at most 120 words it explains ownership, pushback and boundaries for the brief.
3. A built-in neutral casting director reads all auditions and asks one probing question per persona. Each answers in at most 80 words. `--no-examine` skips this stage.
4. The director returns a roster report. For a cast of four or more seats it is asked to assign two teams and judges, ready for a duel.

Auditions and answers run in parallel up to `ROUNDTABLE_PARALLEL_TURNS`. Seat assignment uses the table's [provider judgment](../providers.md#provider-judgment), including persona pins, explicit overrides and routing reasons. Override the director with `--seat casting-director=openai:<model>`, or use `--mix cheap` to favor lower cost routing.

A failed persona becomes `unclear` with a scrubbed error in its risks; the rest continue. Invalid director JSON is retried once with validation feedback. If it still fails, the report falls back to local lint and overlap checks. Unknown persona keys are dropped from director output.

## Report

The report fields are:

| Field | Meaning |
| --- | --- |
| `id`, `createdAt`, `brief` | `cast-<uuid>`, ISO timestamp and scrubbed brief |
| `dryRun` | True on an explicitly requested dry run |
| `note` | Present when the roster is static (a dry run or a director fallback) or partial (stopped early); shown above the roster |
| `agents` | Each persona's `key`, optional `name` and `role`, `verdict`, `strengths`, `risks`, `overlapsWith` and `lint` |
| `agents[].verdict` | `cast`, `bench`, `redundant` or `unclear` |
| `agents[].lint` | `{level, code, message}` entries, where `level` is `warn` or `info` |
| `redundancy` | `{keys, reason}` clusters |
| `gaps` | Expertise or ownership the brief still needs |
| `recommended` | `seats`, plus optional `teamA`, `teamB` and `judges` |
| `usage` | `totalCostUsd` and optional `estimated` |

The terminal shows the roster, overlaps, redundancy, gaps and recommended cast. The MCP result includes strengths, risks and lint in markdown, the archive id and usage. When teams exist, both render a shell-quoted `roundtable duel` command. The command uses the same brief and carries `--agents-dir` when supplied; add a `--kind code`, `--kind diagram` or `--kind text` flag for the artifact you want, since duel defaults to web.

Reports and scrubbed transcript events are stored together in `ROUNDTABLE_HOME/casting/<id>.json`, with an identical copy at `casting/latest.json`. The report fields are at the top level so the agents library can read `latest.json` directly; `version: 1` and `events` carry the transcript. The directory is private (0700), and both files are 0600. Casting archives are separate from duel replay archives.

## Dry run, limits and cost

```sh
roundtable cast "Build a queue module" --agents-dir /absolute/path/to/agents --dry-run --json
```

A dry run makes zero provider calls and needs no keys. In each overlap cluster, the first persona is eligible and the rest are redundant. Empty bodies are unclear. The first eligible personas in input order fill the requested seats; other eligible personas are benched. Static reports have no inferred gaps or duel teams, so they carry a `note` and print "Gaps: not assessed". A fallback uses these same rules and leaves `dryRun` absent.

A full examination normally makes `2 × personas + 2` calls: auditions, one director question call, answers and one verdict call. Without examination it makes `personas + 1`. JSON retries and model fallbacks can add calls. Every call goes through the table usage meter and ledger. The terminal retains unpriced token totals when no model price is known.

The whole-run deadline is 300 seconds by default (`--max-seconds`, up to 3600); per-turn timeout is 90 seconds (`--turn-timeout`, up to 3600). Ctrl-C and the deadline stop new calls and archive the available report, including incomplete personas. CLI exit codes are 0 for completion, 1 for interruption or failure, and 2 for usage errors or missing credentials. `--json` emits NDJSON events followed by the report object.

## Feed the cast into a duel

```sh
roundtable cast "Write a clear remote-work policy" \
  --agents policy-writer,editor,researcher,reviewer --seats 4
# Run the recommended command, adding --kind text for a policy document.
```

The cast recommendation is advisory. Read the reported gaps and risks before using the teams. Casting Call starts no duel itself.

## Feed the cast into a contract and a heads-down run

For implementation work, use `recommended.seats` as the participants in an ultraplan or contract. For example, cast a bounded-memory queue brief, have the recommended architect and engineer plan the interface, and have the recommended reviewer assess the acceptance criteria. Then call `propose_contract` with the tasks, write paths, checks and budget, obtain consent, and `freeze_contract`. Start `execute` when the human asks for the heads-down run.

The roster does not grant write access or create tasks. The contract defines those responsibilities; the heads-down blackboard records execution state. See [contracts](../tools.md#propose_contract) and [heads-down runs](../tools.md#execute).
