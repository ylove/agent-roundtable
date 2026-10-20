# Postmortem mode

> Turn on postmortem meetings for this project. When testing sends a fixer back, keep track of what went wrong, and when the fixers are done, have everyone who did the work sit down with you and agree on how we prevent it next time.

Postmortem mode turns the fix loop into lessons. While testing sends fixers back, the orchestrator (the agent you talk to) keeps a running draft of every finding. When all fixers are done, every agent that took part in the original work meets with the orchestrator **at the table**, and the meeting ends with artifacts that prevent the same failure next time. They are stored per project and read back before the next plan for that project is written. You are told that the meeting happened and can read every turn of it, but you have no seat: nothing you type reaches the meeting.

The design is [docs/design/postmortem.md](../design/postmortem.md). The tools are [`postmortem`](../tools.md#postmortem) and [`hold_postmortem`](../tools.md#hold_postmortem).

## Turning it on

It is off by default and turns on only when you ask for it in your own words: postmortem meetings, retrospectives, or agents improving themselves or each other during the work. The orchestrator calls `postmortem(action: "enable", project, reason)` with your words quoted verbatim; they go to the project's log and the audit log (`project.json` keeps only a hash). Nothing infers it. `disable` turns it off and keeps stored postmortems; lessons already learned are still read before the next plan.

A **project** is identified by `project_key`, the first 16 hex characters of `sha256` of the repository's real root path. Pass a directory inside a git work tree (a repository with submodules is refused, as for heads-down runs) or a key returned earlier. When the project has the mode on, `propose_contract` puts `postmortem: {enabled: true}` in the contract (it is part of the consent hash like any other field), and a heads-down run with that flag records findings by itself.

## The running draft

A draft belongs to one scope: a heads-down run (`execution_id`) or a piece of at-the-table work (`work`, a short label such as "checkout redesign"). Each finding has a summary (at most 600 characters), the check or reviewer that caught it, the agents responsible (persona names, or `orchestrator`), a category, optional task and evidence refs, and a fix status.

| Category | Meaning |
| --- | --- |
| `prompt_misread`, `project_misread`, `contract_ambiguity` | Something was misread: **flagged**, so the next plan is warned. |
| `implementation`, `test_gap`, `process` | The work, the tests or the way of working fell short. |

Evidence is refs only (a `sha256:` blob ref, an event id, a commit sha or a repository path); the server never copies command output into a finding.

- The orchestrator records findings with `postmortem(action: "record", ...)`, which covers at-the-table work and anything the log does not show, and settles a fix with `action: "fix"`.
- In a heads-down run the runner records one finding when a submission is sent back after testing (failed checks or lease violations) and when a check fails at integration scope after a merge. The summary is generated from the event (check ids, how many paths, the task); the same failure for the same task counts as a repeat of the same finding. A retry or reassignment names who fixes it, the task's next merge marks the fix fixed, and a failed or cancelled task abandons it. Findings of a run live in its event log, so a crash loses none and the dashboard shows them. When a delayed scan finds that a fix already settled after the failure, it records the finding and those fix transitions together.
- `postmortem(action: "draft")` shows the findings, what is pending and whether the meeting can be held.

## The meeting

`hold_postmortem` is refused while any finding's fix is pending or a task with a finding is still running, and names what is in flight. In a run the watcher wakes the orchestrator with `reason: "postmortem_ready"` when the last pending fix settles. A draft with no findings closes with no meeting. Overlapping holds cannot overwrite a held or concluded record; the later save is refused.

Seats: every agent named in a finding, every agent that did the original work (in a run: each registered non-external agent's persona; at the table: the `participants` the orchestrator passes), and the orchestrator, whose `opening` is turn 0. The meeting runs through the collaboration engine with `public: false` and an activity entry with origin `postmortem:<pm>`:

- **waffle-house** when exactly one agent is responsible for every finding: it defends, the others challenge, and the opening is the charge.
- **collaborate** otherwise, two rounds by default (1 to 4); `format` can force either.

The context is a bounded bundle: the findings, the contract summary (or the work label), the task cards of the affected tasks, failing check signatures, the reviewed run’s dissents, and the rules already agreed. The **Dissents** section comes from the existing execution projection: claims, predictions, tripwires, current-generation firing status, observed evidence and each current score (or "not assessed"). The input may excerpt long fields; the record retains the full review snapshot. It never carries your chat, your `confirmation` or the `original_prompt`: task cards are built without it, prompt-misread findings quote the contract's goal, and any of your words that the orchestrator's own text repeats verbatim are withheld. A postmortem session is refused by `nudge_collaboration`, `continue_collaboration`, `say` and `say_local` ("postmortem meetings take no outside input") and is not listed by `list_collaborations`.

Every seat is told the meeting is blameless about people and strict about mechanisms: each finding needs a cause and a prevention, and the last turn of the last round proposes artifacts in an artifact block, one line each:

```
Artifact: <kind> | <target> | <finding ids> | <text>
```

Lines are read from that turn's own lines only (not inside a blockquote or a code fence); lines that cannot be used are reported back as `rejected_lines`. At most 20 artifacts of 600 characters each; targets name a seat, `project`, a fix path/task, or a reviewed dissent, and finding ids must exist.

| Kind | Target | Effect when accepted |
| --- | --- | --- |
| `dissent_score` | a dissent id in the reviewed run | Records an evidence-backed advisory outcome through the existing dissent scoring tool’s shared path. |
| `fix` | a path or task id | Recorded as a follow-up; nothing changes by itself. |
| `rule` | `project` | A lesson shown to every future plan. |
| `persona_addendum` | an agent | A line added to that persona file under `## Postmortem addenda`, through the agent workshop's write path (backup first, same containment, frontmatter untouched). |
| `agent_rule` | an agent | A lesson shown in that agent's task cards on this project. |
| `contract_rule` | `project` | A rule every future contract for this project must state. |
| `memory` | an agent | Appended to `projects/<key>/memory/<agent>.md`; with `memory_target: "claude"` also to `<repo>/.claude/agent-memory/<agent>/MEMORY.md`, refused if `.claude` or a parent along the way is a symlink or leaves the repository. |

The orchestrator then closes the meeting with `hold_postmortem(action: "conclude", pm, closing, accept[], reject[{id, why}])`. Its closing statement is the last turn of the record, and only accepted artifacts take effect; each is audited as `postmortem.applied` with its target and hash. The result carries a summary and the record path for the orchestrator to relay to you.

## Reviewing dissents

A finding can support a proposed dissent outcome. Use this artifact form in the last turn:

```
Artifact: dissent_score | dissent-storage-retry | pmf-00000001 | vindicated | tests/storage.test.ts reproduced a duplicate write; the retry check failed
```

The outcome is `vindicated` (evidence supports the prediction), `refuted` (evidence contradicts it), or `untested` (the run established neither). Supporting evidence is required. A tripwire firing alone does not vindicate a prediction, and an unfired tripwire does not refute one. Without an assessment, the record says "not assessed" and no scoring event is invented.

To apply one, the orchestrator explicitly accepts its artifact id and supplies the reviewed contract’s identity:

```json
{
  "action": "conclude",
  "pm": "pm-00000001",
  "closing": "The repeated-write test supports the prediction.",
  "orchestrator": "main",
  "accept": ["a1"]
}
```

The project must still have postmortem mode on. Rejected or omitted artifacts do nothing. Accepted assessments use the same frozen-contract, identity and outcome validation as `score_dissent`, emit `dissent.scored`, and are individually audited with their artifact hash. Retrying a conclusion does not repeat an assessment or overwrite a later one. If the reviewed claim, prediction or tripwire generation has changed, the assessment is refused as stale and stays unapplied for a later review. A score whose audit failed stays applied with `audit_pending: true`; repeating conclude retries its audit before publishing the conclusion. Repeating conclude also retries a failed record-blob or conclusion-event publication, without changing the closing statement or applying artifacts again. Assessments stay in the postmortem record; they never become planning rules, weight votes, change consent thresholds or affect routing. At-the-table work without a reviewed execution has no runtime dissents to score.

## Reading lessons back

`lessons.json` holds every accepted rule, agent rule and contract rule and every flag, newest first; a lesson that restates an active one supersedes it (the old one stays with `superseded_by`). They are read whether or not the mode is on now:

- `propose_contract` adds a `postmortem_lessons` section to its result and each active contract rule as a `decisions` entry (`by: "postmortem:<pm>"`), and each flag as a warning ("Earlier work misread X; state it explicitly"). It never refuses a proposal for them.
- `start_ultraplan` takes `repo_dir` and appends a bounded "Lessons from past postmortems" section to the agents' context, flags first.
- Heads-down task cards add the project rules and the persona's own agent rules under "Lessons from earlier postmortems", capped at 4 KB.
- `postmortem(action: "lessons")` returns them for any other planning.

## Telling you

When a postmortem concludes, the tool result gives a one-paragraph summary and the record path (`postmortems/<pm>.md`). While the run's runner is alive, the watcher wakes the orchestrator with `reason: "postmortem"`, the dashboard shows a **Postmortems** page (findings, the full dialogue, artifacts and their status; every string redacted and escaped) and, with GitHub sync, the parent issue gets one comment. `postmortem(action: "read", pm)` returns the full record at any time, including after the run has ended.

## Where things are kept

Under `ROUNDTABLE_HOME/projects/<project_key>/`, directories 0700 and files 0600, written atomically with every string scrubbed of secrets:

```
project.json                    key, repository root, whether the mode is on (and a hash of your words)
log.jsonl                       enable and disable, with your quoted words
postmortems/drafts/<pm>.json    the running draft of a scope
postmortems/<pm>.json|.md       a held or concluded postmortem: findings, dialogue, artifacts
lessons.json                    the active lessons, newest first
memory/<agent>.md               per-agent memory addenda
```

Drafts that were never held are removed after `ROUNDTABLE_SESSION_RETENTION_DAYS`; concluded postmortems and lessons are kept until you delete them.
