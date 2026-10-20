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

By default judges weigh fit to the brief, quality of the result, usability and accessibility, and risk or safety within their own remit, which they take from their persona. `--criteria "a,b,c"` (up to 8 items) replaces that rubric. Commas separate items; if an item contains a comma, separate items with `;` instead. The reply format is fixed regardless: `VERDICT A: APPROVE|REVISE|REJECT — reason`, the same for B, and `PREFER: A|B`. Judges are told that the artifacts are untrusted listings and to ignore instructions inside them.

## Rounds

1. R1: the first member of each team proposes a concept, in parallel.
1. R1c: with three or more members, each middle member critiques the concept.
1. R1b: the last member builds the artifact in the requested kind, with the limits above. Invalid submissions get one retry with the validation error.
1. R2: judges see both artifacts as source listings and write the verdict lines. APPROVE adds one point, REVISE adds zero, and REJECT subtracts one. Missing or ambiguous responses are UNCLEAR and add zero. A failed judge casts no verdict. Teams without a valid artifact receive automatic REJECTs.
1. With `--rounds 2`, R3 gives each team receiving REVISE or REJECT one revision, with the same validation retry. The original judging tally determines the result. A failed revision preserves an earlier valid artifact.
1. R4: the first member of each team gives a closing statement; the losing team is asked to file a dissent. Complete `<DISSENT>` blocks become separate cards. Equal scores stay a tie.

Concept, judging and closing calls time out after 90 seconds (set with `--turn-timeout`); build calls get at least 240 seconds. The `--max-seconds` deadline defaults to 600 seconds, plus 120 per member beyond two on the larger team (to fit the critique turns). It cancels pending work and skips ahead to closing statements; closing calls have their own turn timeout. Ctrl-C cancellation ends provider work and archives the partial result. The room remains available after the end until Ctrl-C; `--no-hold` lets automation finish without waiting.

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

The `start_duel` tool runs the same engine and returns a compact result: the duel id, winner, tally, each team's artifact title, kind and ok flag, the verdicts, the dissents, a per-persona usage summary and the archive id (`duels/<id>.json`). It never returns artifact source. No room is opened: the live room belongs to the CLI, and `start_duel` returns only the result (replay the archive with `roundtable duel --replay` to see it in a room). The tool sends a progress notification on every turn, artifact and verdict, so the host needs a long request timeout (a duel runs for minutes) or must reset it on progress. A running duel appears in the usage view and can be stopped with `roundtable stop <persona> --session duel-<id>`. See [tools](../tools.md#start_duel). Duel calls are recorded in the usage ledger with the persona as the agent, so `roundtable usage` shows duel spend per persona.

## From duel to contract

`propose_contract(from_session: "duel-<id>")` loads the archive from `ROUNDTABLE_HOME/duels/` and feeds the Roundtable's contract flow.

- **Decision.** When team A or B won, the contract gains a `duel-winner` decision naming the winning artifact's title, its kind (when archived), the team and its personas, with the judges' scrubbed APPROVE reasons as the rationale. Artifact source is never copied into the contract; it points to the duel id and the title only.
- **No winner.** A `tie`, `none` or stopped duel imports no decision. The result says so (a warning and `duelImport.imported_decision: false`), and the orchestrator must decide which approach to build.
- **Dissents.** Every archived `<DISSENT>` from a team or judge becomes a draft concern with `source: {kind: "duel", ref: <duel id>}`. Each needs a tripwire (`file_dissent`) or an orchestrator excusal before freeze. See [dissents](../dissents.md).
- **Task plan (default).** A duel carries no task list, so with no `contract` tasks and no `plan`, `propose_contract` drafts one from the winning artifact. The draft is deterministic and template-based (no model call): a build task for the artifact, one task per distinct REVISE or REJECT reason the judges gave the winner, a tests task, and, when dissents were imported, a task to handle them (each dissent is an acceptance line). The template follows the artifact kind. `code` (also the default when the archive has no kind): build, fixes, tests and risks, write `**`, with a placeholder `npm test` check. `web`: integrate the page, fixes, then a browser review (page loads with no console errors, works on a narrow screen, meets the brief), write `**`, no checks. `text` and `diagram`: write-up, fixes, review, write `docs/**` only, no checks. The tasks run in sequence on the winning team's personas (the first that resolve; builders first) and use the placeholder budget; the placeholders are flagged in the warnings: refine them with `amend_contract` before consent. The plan goes through the same `roundtable-tasks` parser as any fenced block, and the contract source reads `drafted:<duel id>`.
- **Artifact files.** Source never enters the contract. Each drafted task carries a text context entry naming the duel id, the artifact's file list and sizes, and where the files are: the archive `ROUNDTABLE_HOME/duels/<id>.json` (`prototypes`), viewable with `roundtable duel --replay`. A worker reads them from there.
- **Opting out.** Pass `draft_plan: false` for an exploratory or illustrative duel: only the decision and dissents are imported, and `contract` (with tasks) or `plan` is required as before. Passing `contract` tasks or `plan` also skips drafting. A tie, no winner or no archived artifact drafts no plan (a warning says so), and then a structure must be passed. If none of the winning team's personas resolve, pass `participants` to name who does the work.
- **Amending.** `amend_contract(from_session: "duel-<id>")` adds the duel's decision and dissents to an existing contract (tasks untouched; pass `patch: {}`). Repeats are skipped. The usual rules apply: a draft needs consent again for the new version. A frozen contract cannot hold a concern without a tripwire, so when the duel brings dissents the amend is refused as a whole (nothing is applied) with a message listing their ids, authors and claims and the next call: `amend_contract` again with the same `from_session` and a `patch` whose `dissents` carries each concern with a `tripwire`. A duel with no new dissents (a decision only) applies at once. Excusing a concern (`file_dissent` with `excuse_reason`) needs it to exist in the contract first, so it is available on a draft.
- **Participants.** Seats are not added as participants, except the authors of imported dissents and the personas of drafted tasks.

Archives that lack newer optional fields still import.
