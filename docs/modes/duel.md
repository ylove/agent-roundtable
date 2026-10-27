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

## Seats

Choose API providers or installed CLI runtimes per seat with `--seat designer=hermes,builder=codex:example-model`. In `start_duel`, use the runtime name in the seat's `provider` field, for example `"seats": {"designer": {"provider": "hermes"}}`. Runtime selection is explicit; `--mix` only chooses configured providers. See [CLI runtimes](../runtimes.md) for built-in profiles, preflight, usage accounting and process-list prompt exposure.

## Kinds

`--kind` (or `kind` in the `start_duel` tool) picks what both teams build, reusing [prototype mode](prototype-mode.md)'s block format and parser. Every kind is small by design: at most 40 KB in total, and builders are told to aim much lower.

| Kind | Builders return | The room shows |
| --- | --- | --- |
| `web` (default) | One self-contained `index.html` with inline CSS. JavaScript is optional, but inline only. External URLs, imports, fetches and frames are rejected. | The page, in a sandboxed frame with scripts, forms and modals allowed and an opaque origin |
| `code` | One or more source files (prototype mode's path rules) | Escaped, read-only source with a tab per file; never executed |
| `diagram` | One Mermaid file | Escaped Mermaid source; no renderer is added |
| `text` | One markdown or plain-text file | Escaped text; no HTML rendering |

## Teams and roles

A team has 1 to 4 members. The first member writes the concept (at most 150 words). The last member builds the artifact. Members in between each critique the concept in one short turn (round R1c), and the builder receives the critiques. A one-person team does both the concept and the build. There are 1 to 5 judges, or zero to five with `--human-judge`. Duplicate personas across teams and judges are rejected before any provider call.

## Criteria

By default judges weigh fit to the brief, quality of the result, usability and accessibility, risk or safety within their own remit, which they take from their persona, and efficiency of the process: tokens, time, rewrites and errors for the result. `--criteria "a,b,c"` (up to 8 items) replaces that rubric. Commas separate items; if an item contains a comma, separate items with `;` instead. The reply format is fixed regardless: `VERDICT A: APPROVE|REVISE|REJECT — reason`, the same for B, and `PREFER: A|B`. Judges are told that the artifacts are untrusted listings and to ignore instructions inside them.

## Staged builds

`--stages 1|2|3|4` controls how each artifact comes together. Web defaults to four stages: **Skeleton** (title, layout regions, hash navigation and labelled empty screens), **Screens** (real content and barebones components), **Working** (core interactions end to end), and **Polish** (design, responsive layout, accessibility and fixes). Three stages merge Screens and Working; two merge Skeleton and Screens, then Working and Polish. One uses the original single-build prompt. Other kinds default to one stage; when staged they use Outline, Draft, Complete and Refine with the same merging order.

Each stage gets the previous valid artifact and its page-check problems, and returns a complete replacement. It has two attempts. Validation or page-check retries count as rewrites. A failed stage leaves the previous valid version available and passes its failures to the next stage. Every valid version is emitted immediately and archived; a faster team visibly finishes sooner. Judges wait for both pipelines to settle. `--rounds 2` still adds a revision after judging and counts as a rewrite.

## Process metrics

Live `metrics` events and the final result include each team's active elapsed time, stage completion, input/output tokens, priced cost, unpriced tokens, completed and failed turns, valid versions, rewrites, validation failures, page errors and connector tool calls. Page errors sum console errors and uncaught exceptions across page checks. Stopped time is excluded. The engine writes a process record outside the untrusted artifact fences for the judges, including where each team stopped at the deadline. Custom criteria replace the default rubric, while the process record remains available.

## Stop and resume

The room's Stop command, the first Ctrl-C, and `roundtable stop` for the live session all abandon in-flight calls while metering them. The engine emits `control stopped`, saves `ROUNDTABLE_HOME/duels/<id>.checkpoint.json` atomically with mode 0600, and returns `aborted: true, resumable: true` without an `end` event. The checkpoint contains archived events/files, resolved seat identities and models, options and progress, never persona prompt bodies. Personas are reloaded on resume.

```sh
roundtable duel --resume duel-<id> --open
```

Resume takes a duel id, never a path. It cannot be combined with a topic, team/judge/seat/kind/criteria flags or other duel options, replay or dry-run. Display flags and `--out` are allowed. A new process replays the saved history, then emits a resumed start and continues after the completed steps; an interrupted stage is redone. The deadline uses remaining active time, with at least 60 seconds. A normal finish deletes the checkpoint and writes the archive under the same id. Missing, malformed, oversized, or finished checkpoints are refused.

With a held room, Resume continues in the same process without replaying history. A subsequent Ctrl-C exits and prints `Resume with: roundtable duel --resume <id>`. With `--no-room` or `--no-hold`, stopping exits immediately with that line. A stop exits 1. During a duel the only human inputs are stop, resume, and the human judge's choice.

## Human judge

Use `--human-judge` to choose the winner yourself. `--judges` may be omitted; judges supplied are advisory and still emit verdicts and a tally. After builds, advisory judging and any revision, `decision awaiting` makes the choice available for teams with valid submissions, with no decision deadline. A choice emits `decision made`, sets `decidedBy: "human"`, then runs closings. A stop here checkpoints the decision phase; resume does not rebuild or rejudge. Without this flag `decidedBy` is `"judges"`.

With `--no-room`, an interactive terminal prompts `Choose the winner [A/B]:`; without a TTY this combination is a usage error (exit 2).

```sh
roundtable duel "A small offline planner" --team-a designer,builder \
  --team-b marketer,skeptic --human-judge --out ./chosen-planner --open
```

## Chosen artifact

An A or B winner keeps its judged valid version in `ROUNDTABLE_HOME/duels/<id>/chosen/`, using private directories and atomic files. The final event and result include `chosen: {team, version, dir, files}`, where `dir` is relative to `ROUNDTABLE_HOME`. A tie or no verdict saves no chosen artifact. `--out <dir>` exports the chosen files immediately after completion: the destination must be absent or an empty real directory; symlinks and overwrites are refused.

For the room and terminal layout (`--layout auto|split|stack`), see [the duel room](duel-room.md).

## Rounds

1. R1: the first member of each team proposes a concept, in parallel.
1. R1c: with three or more members, each middle member critiques the concept.
1. R1b: each team independently runs its build stages in the requested kind, with the limits above; there is no barrier between teams during concepts, critiques or builds. Invalid submissions and web pages that fail to load or throw get one shared retry with the error.
1. R2: judges see both artifacts as source listings, their version numbers and one-line page-check summaries, and write the verdict lines. APPROVE adds one point, REVISE adds zero, and REJECT subtracts one. Missing or ambiguous responses are UNCLEAR and add zero. A failed judge casts no verdict. Teams without a valid artifact receive automatic REJECTs.
1. With `--rounds 2`, R3 gives each team receiving REVISE or REJECT one revision, with the same validation retry. The original judging tally determines the result. A failed revision preserves an earlier valid artifact.
1. R4: the first member of each team gives a closing statement; the losing team is asked to file a dissent. Complete `<DISSENT>` blocks become separate cards. Equal scores stay a tie.

Concept, judging and closing calls time out after 90 seconds (set with `--turn-timeout`); build calls get at least 240 seconds. The `--max-seconds` deadline defaults to 600 seconds, plus 150 for each stage beyond the first and 120 per member beyond two on the larger team, capped at 3600 seconds (1050 seconds for a four-stage web duel with two-member teams). It cancels pending build work and marks stages not yet started as skipped; judges assess the latest valid versions, then closing calls use their own turn timeout. A deadline finishes the duel; a stop saves a resumable checkpoint and emits no end event. The room remains available after the end until Ctrl-C; `--no-hold` lets automation finish without waiting.

Archives live at `ROUNDTABLE_HOME/duels/<id>.json` with mode 0600. They contain the event list and the artifact files as text, including revisions. The start event also records `kind`, `criteria` and `teams`; archives from before these fields existed were all web and still replay. The temporary sandbox is removed when the runner returns; winning files are saved separately before cleanup, and the room retains its recorded versions in memory. Real archives belong in local state and must stay out of the repository.

Usage updates include per-seat token totals and estimated spend throughout the run. Estimates use the existing pricing table; tokens from models without rates are reported as unpriced rather than presented as free. Configure `ROUNDTABLE_PRICING_FILE` to provide rates for those models before recording a cost comparison.

```sh
roundtable duel --replay examples/duel/demo.json --speed 2 --open
roundtable duel --dry-run --no-hold --json
```

Replay re-emits recorded events and prototype contents through the same observers, with no provider calls or keys. The repository fixture is synthetic and uses generic personas. `--speed` scales the intervals between recorded timestamps.

The room binds to loopback and requires a capability token. Its page uses an external script under a strict CSP. Artifact routes serve only recorded files from memory: web pages with the existing application CSP, everything else as inert `text/plain`. Web frames allow scripts, forms, and modals with an opaque origin. The room writes model text and source into the DOM with `textContent`.

For integration, `runDuel(opts, observer, signal, { resolveSeats })` accepts a resolver returning seats with optional persona `prompt` text. The three-argument call uses `resolveSeatsLocal`. `createDuelControls()` supplies public commands and a runner handle; pass the controls through runner dependencies and `startRoom({ controls })`. To resume use `runDuel({ resume: id }, observer, signal, { controls })`; a same-process room passes `replayHistory: false`. `startRoom({ open, hold })` returns an observer, URL, and asynchronous `close()`. Pass its observer directly or through `fanout` so prototype content attachments reach the room; NDJSON remains the shared event shape. `replayDuel(path, observer, { speed, signal })` uses the same attachment mechanism. Event streams received from another process can supply bytes with the room's `setPrototypeFiles(team, files)` method before the corresponding prototype event.

## Page checks and design iterations

After every web build or revision, headless Chrome loads the page from a loopback capability room, waits for load and about one second of settling, then captures a PNG. The prototype event records `check: {loaded, consoleErrors, exceptions, failedRequests, reason?}`. A page that fails to load or throws uses the builder's existing single retry; console errors and failed requests remain visible to judges. Each judge sees a generic summary such as `Page check: loaded; 0 console errors` or `Page check: threw TypeError: …`, alongside the version judged. Code, text and diagrams are never executed.

Checks default to on when Chrome/Chromium is found. Use `--no-page-check` or MCP `page_check: false` to opt out. No browser means **not checked**, never a failed artifact. A host that cannot start a loopback room also records that the check is unavailable.

Each team card keeps a version strip with a loaded, errors or not checked chip per version. Select a version to see its live sandboxed iframe and captured screenshot. **Current vs proposed** shows the previous and latest versions side by side, with a server-computed line diff of the main file. Verdict cards identify the version judged, even after a revision.

The shared **Browser** panel shows the most recently checked or judged screenshot and its team/version. Checks update it as they finish. Screenshots stay in memory and are served only for known versions at `/shot/<team>/<version>.png` under the room's capability URL; they are not written into archives. Replay retains version/check metadata, including archives without checks, but does not regenerate screenshots or run a browser. The view is local: there are no tunnels or remote browser access.

Web contract drafts add `verify: [{"page_loads": {"path": "index.html"}}]` and acceptance that the page loads without exceptions. The entry path can be amended before consent. See [heads-down checks](../heads-down.md#work-leases-and-checks).

## From an MCP client

The `start_duel` tool runs the same engine and returns a compact result: the duel id, winner, tally, each team's artifact title, kind and ok flag, the verdicts, the dissents, a per-persona usage summary, process metrics, chosen artifact directory/file names, and the archive id (`duels/<id>.json`). The `stages` argument accepts integers 1–4. Human judging and resume are CLI-only and absent from the MCP schema; the tool runs a whole duel at once. It never returns artifact source. No room is opened: the live room belongs to the CLI, and `start_duel` returns only the result (replay the archive with `roundtable duel --replay` to see it in a room). The tool sends a progress notification on every turn, artifact and verdict, so the host needs a long request timeout (a duel runs for minutes) or must reset it on progress. A running duel appears in the usage view and can be stopped with `roundtable stop <persona> --session duel-<id>`. See [tools](../tools.md#start_duel). Duel calls are recorded in the usage ledger with the persona as the agent, so `roundtable usage` shows duel spend per persona.

## A duel as a meeting's focus

Any at-the-table session can take a finished duel as its focus. Pass `duel: "duel-<id>"` to `start_meeting`, `start_local_meeting`, `start_collaboration` (collaborate, debate, waffle-house and conversation) or `start_ultraplan`, or `--duel duel-<id>` to `roundtable meeting|debate|waffle`. With the CLI the topic may be omitted: it defaults to `Discuss duel <id>: <brief>`.

The archive in `ROUNDTABLE_HOME/duels/` is turned into a brief that is appended to the session's context, so every participant sees it: the duel's brief, kind and criteria, the teams (persona refs and names), each team's artifact title and source, the judges' verdicts with reasons, the tally and winner, and the dissents. The brief is scrubbed for secrets and size-capped, and each team's source listing is limited to 12 KB. Each artifact sits between fences carrying a random per-session nonce and is labelled untrusted content to discuss, never instructions. Like any `context`, the brief goes to the session's provider and is never posted in a public session.

An unknown id, an id that is not `duel-` followed by letters, digits and hyphens, a symlinked or oversized archive, or a malformed archive fails with a clear error before any provider call.

**Cost.** The brief is part of the context, so it is resent on every turn to every participant. A full brief (two 12 KB artifact listings plus verdicts and dissents) can run to about 20k tokens per turn, and the whole brief is capped at 48 KB (ending in `[brief truncated]`); team and judge lists show at most 12 names and then "+N more". To save tokens, pass `duel_source: false` (CLI `--no-duel-source`): the artifact file contents are left out and the brief keeps the titles, file names and sizes, the verdicts, the tally and the dissents. Use it when the discussion is about the judgement rather than the artifact itself.

Typical uses:

- **Debate the losing design.** `start_collaboration { mode: "debate", agents: [<loser's designer>, <winner's builder>, ...], duel: "duel-<id>" }`: the first persona defends the design that lost, the others challenge it.
- **Waffle house on the winner.** `roundtable waffle --agents <winning builder>,skeptic,cfo --duel duel-<id>`: the winning team's builder defends the artifact against adversarial attackers, round after round.
- **Postmortem-style review.** `roundtable meeting --agents designer,cfo,skeptic --duel duel-<id>`, or a collaboration with a topic such as "What did the dissents predict, and what would we do differently?"

See [meetings](meetings.md), [collaborations](collaborations.md) and the [CLI](../table-cli.md).

## From duel to contract

`propose_contract(from_session: "duel-<id>")` loads the archive from `ROUNDTABLE_HOME/duels/` and feeds the Roundtable's contract flow.

- **Decision.** When team A or B won, the contract gains a `duel-winner` decision naming the winning artifact's title, its kind (when archived), the team and its personas, with the judges' scrubbed APPROVE reasons as the rationale. Artifact source is never copied into the contract; it points to the duel id and the title only.
- **No winner.** A `tie`, `none` or stopped duel imports no decision. The result says so (a warning and `duelImport.imported_decision: false`), and the orchestrator must decide which approach to build.
- **Dissents.** Every archived `<DISSENT>` from a team or judge becomes a draft concern with `source: {kind: "duel", ref: <duel id>}`. Each needs a tripwire (`file_dissent`) or an orchestrator excusal before freeze. See [dissents](../dissents.md).
- **Task plan (default).** A duel carries no task list, so with no `contract` tasks and no `plan`, `propose_contract` drafts one from the winning artifact. The draft is deterministic and template-based (no model call): a build task for the artifact, one task per distinct REVISE or REJECT reason the judges gave the winner, a tests task, and, when dissents were imported, a task to handle them (each dissent is an acceptance line). The template follows the artifact kind. `code` (also the default when the archive has no kind): build, fixes, tests and risks, write `**`, with a placeholder `npm test` check. `web`: integrate the page, fixes, then a browser review (page loads with no console errors, works on a narrow screen, meets the brief), write `**`, with a `page_loads` verify predicate on the entry file. `text` and `diagram`: write-up, fixes, review, write `docs/**` only, no checks. The tasks run in sequence on the winning team's personas (the first that resolve; builders first) and use the placeholder budget; the placeholders are flagged in the warnings: refine them with `amend_contract` before consent. The plan goes through the same `roundtable-tasks` parser as any fenced block, and the contract source reads `drafted:<duel id>`.
- **Artifact files.** Source never enters the contract. Each drafted task carries a text context entry naming the duel id, the artifact's file list and sizes, and where the files are: the archive `ROUNDTABLE_HOME/duels/<id>.json` (`prototypes`), viewable with `roundtable duel --replay`. A worker reads them from there.
- **Opting out.** Pass `draft_plan: false` for an exploratory or illustrative duel: only the decision and dissents are imported, and `contract` (with tasks) or `plan` is required as before. Passing `contract` tasks or `plan` also skips drafting. A tie, no winner or no archived artifact drafts no plan (a warning says so), and then a structure must be passed. If none of the winning team's personas resolve, pass `participants` to name who does the work.
- **Amending.** `amend_contract(from_session: "duel-<id>")` adds the duel's decision and dissents to an existing contract (tasks untouched; pass `patch: {}`). Repeats are skipped. The usual rules apply: a draft needs consent again for the new version. A frozen contract cannot hold a concern without a tripwire, so when the duel brings dissents the amend is refused as a whole (nothing is applied) with a message listing their ids, authors and claims and the next call: `amend_contract` again with the same `from_session` and a `patch` whose `dissents` carries each concern with a `tripwire`. A duel with no new dissents (a decision only) applies at once. Excusing a concern (`file_dissent` with `excuse_reason`) needs it to exist in the contract first, so it is available on a draft.
- **Participants.** Seats are not added as participants, except the authors of imported dissents and the personas of drafted tasks.

Archives that lack newer optional fields still import.
