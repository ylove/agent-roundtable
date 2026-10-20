# Postmortem mode: design

Status: implemented in 1.1.0. Workstream WS14, issue #130, tracking issue #129. This was the spec WS14 built against; where the implementation went further or differently, the text below says so, and §12 lists those points together. User guide: [docs/modes/postmortem.md](../modes/postmortem.md).

## 1. What it is

Postmortem mode turns the fix loop into lessons. While testing sends fixers back, the **main orchestrator** (the agent the human talks to) keeps a **running postmortem draft** of every finding. When all fixers are done, every agent that took part in the original work sits down with the main orchestrator for a **postmortem meeting** at the table. The meeting must end with **actionable artifacts** that prevent the same failure next time. They are stored per project and read back before the next plan for that project is written.

The human is told that the meeting happened and can read every turn of it, but has no seat: nothing the human types reaches the meeting.

Naming: "postmortem" is one word and a lowercase common noun, like huddle. A postmortem meeting runs an existing format (collaborate or waffle-house); it is not a new format name.

## 2. Opt-in

Postmortem mode is off by default. It turns on for a **project** when the human asks for it, in any of these words: postmortem meetings, retrospectives, agents improving themselves, or agents improving each other during the work.

- The host turns it on with `postmortem(action: "enable", project, reason)`. `reason` must quote the human's words (like `execute`'s `confirmation`), and it is recorded in the project's postmortem log and the audit log.
- A heads-down run inherits it when its contract carries `postmortem: {enabled: true}`. `propose_contract` sets that field when the project has postmortem mode enabled, and the field is part of the consent hash like any other contract field.
- `postmortem(action: "disable", project, reason)` turns it off. Stored postmortems are kept.
- No tool turns postmortem mode on by itself: there is no heuristic that infers it.

## 3. Projects

A **project** is identified by `project_key`: the first 16 hex characters of `sha256(realpath(repo root))`. The host may pass `project` as a repository directory (resolved with `git rev-parse --show-toplevel`, refused unless it is a git work tree and contains no submodules, the same checks as `propose_contract`'s `repo_dir`) or as an existing `project_key`. A heads-down run's project is its `execution.json` `repo_root`.

Store, under the existing home (`~/.agent-roundtable/`, `ROUNDTABLE_HOME`), with 0700 directories and 0600 files written atomically through `fs-safe.ts`:

```
projects/<project_key>/
  project.json                    {key, repo_root, created, postmortem: {enabled, since, reason_sha256, by}}
  log.jsonl                       the project's postmortem log: enable and disable with the human's quoted words (scrubbed)
  postmortems/drafts/<pm>.json    the running draft (one open draft per scope, see §4)
  postmortems/<pm>.json           a concluded postmortem: findings, meeting, artifacts, status
  postmortems/<pm>.md             the readable record: findings, full dialogue, artifacts
  lessons.json                    the active artifacts across all postmortems (§7), newest first
  memory/<agent>.md               per-agent memory addenda (§6)
```

`<pm>` is `newId("pm-")`. Every free-text field is scrubbed (`src/security/secrets.ts`) before it is written. Retention follows `ROUNDTABLE_SESSION_RETENTION_DAYS` for drafts that were never held; concluded postmortems and `lessons.json` are kept until the human deletes them, because their purpose is long-lived.

## 4. The running draft

A draft has a **scope**: either a heads-down execution (`execution_id`) or an at-the-table piece of work (`work`: a short label the host chooses, such as "checkout redesign"), always within one project. There is at most one open draft per scope.

A **finding** is:

```ts
interface PostmortemFinding {
  id: string;                    // pmf-…
  at: string;                    // ISO time
  summary: string;               // what went wrong, ≤ 600 chars
  detected_by: string;           // the check, test or reviewer that caught it
  responsible: string[];         // agents whose work was sent back (persona names, or "orchestrator")
  task?: string;                 // heads-down task id
  category: "prompt_misread" | "project_misread" | "contract_ambiguity" | "implementation" | "test_gap" | "process";
  evidence?: string[];           // refs only: sha256 blob refs, event ids, commit shas, file paths
  fix?: { by: string; status: "pending" | "fixed" | "abandoned"; ref?: string };
}
```

Findings arrive two ways:

1. **By the main orchestrator**, with `postmortem(action: "record", …)`. This covers at-the-table work (subagents, reviews, the host's own tests) and anything the orchestrator learns in a heads-down run that the log does not show. `action: "fix"` updates a finding's `fix` status.
2. **Automatically, in a heads-down run with postmortem enabled.** The runner appends one finding when a task's submission is sent back after testing: `task.rejected` that follows a `task.submitted` (failed checks or lease violations), and a `check.failed` at integration scope after a merge. The finding's summary is generated from the event (check id, signature, task), never from command output; `evidence` carries the event id and the output blob ref. A rejection that repeats an earlier finding's signature for the same task increments that finding's `repeats` instead of adding a new one. `task.retried` / `task.reassigned` set `fix.by`; the task's next `task.merged` marks the fix `fixed`; `task.failed` or `task.cancelled` marks it `abandoned`.

Heads-down runs also record the draft in the event log, so the blackboard and the dashboard can show it. New events (validated in `src/execution/events.ts` like every other type; free-text scrubbed; the reducer gains a `postmortem` section and `REDUCER_VERSION` is bumped):

| Type | Payload |
|---|---|
| `postmortem.finding_recorded` | id, summary, detected_by, responsible, task?, category, evidence?, repeats? |
| `postmortem.fix_updated` | id, by?, status, ref? |
| `postmortem.started` | id (pm), format, seats |
| `postmortem.concluded` | id (pm), artifacts (count by kind), flagged (count), record (the `.md` path's blob ref) |

The draft file is the source of truth for at-the-table scopes; for an execution it is rebuilt from these events, so a crash never loses a finding.

## 5. The meeting

**When.** `hold_postmortem(project, execution_id | work, …)` is refused while any finding's fix is `pending`, and, for an execution, while any task with a finding is not terminal (`accepted`, `failed`, `cancelled`). The error names what is still in flight. A draft with no findings is closed with no meeting ("nothing to learn"). For an execution, the watcher wakes the orchestrator with `reason: "postmortem_ready"` when the last pending fix settles, so the host does not need to poll.

**Seats.** Every agent named in any finding's `responsible`, plus every agent that did the original work in the scope (for an execution: every registered non-external agent's persona; for an at-the-table scope: the host passes `participants`), plus the main orchestrator. Each persona is loaded through the normal agent resolution (`src/agents.ts`). Duplicates collapse to one seat.

**The main orchestrator's seat.** The orchestrator is the host chat agent; the server cannot run it as a persona. It takes part through its own words:
- `opening` (required): the orchestrator's account of what happened, including its own part. It is turn 0 of the meeting.
- After the meeting's rounds, the tool returns the transcript and the proposed artifacts; the orchestrator closes with `hold_postmortem(action: "conclude", pm, closing, accept[], reject[{id, why}])`. Its closing statement is the final turn of the record, and only accepted artifacts take effect.

**Format.**
- **waffle-house** when exactly one agent is responsible for every finding (and that agent is not the orchestrator): the responsible agent is the defender; the other seats are the challengers; the orchestrator's opening is the charge. The defender must answer each finding with what it misunderstood or skipped and what rule would have stopped it.
- **collaborate** otherwise, two rounds by default (`rounds`, 1–4).
- `format` can force either.

The meeting runs through the existing engines (`startCollaboration` / `continueCollaboration`) with `public: false`, `prototype: false`, and an activity entry with `origin: "postmortem:<pm>"`. Its context is a bounded bundle like `buildContextBundle()`: the findings, the contract summary (or the host's `work` summary), the task cards of affected tasks, the failing check signatures, and the reviewed run’s dissents from the WS16 blackboard projection. A **Dissents** section includes each claim, prediction, tripwire, current-generation firing status, firing evidence and current score (or "not assessed"). Long fields are excerpted in the bounded input; the JSON and Markdown records retain the full snapshot taken when the meeting is held. It never includes the human's chat, `confirmation` or `original_prompt` verbatim; prompt-misread findings quote the *contract's* `goal` and the relevant task text instead.

**No human seat.** A postmortem session is not addressable by `nudge_collaboration`, `continue_collaboration`, `say` or `say_local`: each refuses a postmortem session id with "postmortem meetings take no outside input". The session is not listed by `list_collaborations`.

**Directive.** Each seat is told: this is blameless about people and strict about mechanisms; every finding needs a cause and a prevention; propose artifacts only in the artifact block (§6). The last turn of the last round must contain the artifact block.

## 6. Artifacts

The meeting ends with an artifact block. Each line is parsed from the own lines of the last turn (never inside blockquotes or fences, as with huddle directive lines):

```
Artifact: <kind> | <target> | <finding ids> | <text>
```

| Kind | Target | Effect when accepted |
|---|---|---|
| `dissent_score` | a dissent id in the reviewed run | An accepted evidence-backed assessment emits `dissent.scored` through the same scorer as `score_dissent`. |
| `fix` | a path or task id | Recorded as a follow-up; nothing is changed automatically. |
| `rule` | `project` | Added to the project's lessons. Shown to every future plan. |
| `persona_addendum` | an agent name | Appended to that persona file under `## Postmortem addenda`, through the agent workshop's write path (backup first, same realpath containment, same frontmatter preservation). |
| `agent_rule` | an agent name | Added to the lessons, scoped to that agent; shown in its task card / meeting persona while it works on this project. |
| `contract_rule` | `project` | Added to the lessons as a rule every future contract for this project must state; `propose_contract` turns it into a contract `decisions` entry (§7). |
| `memory` | an agent name | Appended to `projects/<key>/memory/<agent>.md`. With `memory_target: "claude"` the same text is also appended to `<repo>/.claude/agent-memory/<agent>/MEMORY.md`, refused if `.claude` or any parent along the way is a symlink or resolves outside the repository. |

Limits: at most 20 artifacts per postmortem, 600 characters each, targets must name a seat, `project`, a fix path/task, or a reviewed dissent for `dissent_score`, and finding ids must exist. Malformed lines are reported back to the orchestrator as `rejected_lines`, never silently dropped. Persona addenda and memory writes happen only on conclude, only for accepted artifacts, and are audited (`postmortem.applied`, with the target path and the artifact hash).

**Dissent assessments.** Findings may support a proposed assessment in this form:

```
Artifact: dissent_score | <dissent id> | <finding ids> | <vindicated/refuted/untested> | <supporting evidence>
```

The final field is required evidence, at most 600 characters, scrubbed like other artifact text. The referenced findings must exist and the dissent must be in this meeting’s reviewed run; at-the-table scopes have no runtime dissent projection. The parsed artifact carries `outcome` separately from its evidence text, and its hash includes the outcome. Only explicit `accept[]` on conclude applies it, with `orchestrator` naming the reviewed contract’s orchestrator and the project still opted in. The shared `src/execution/dissent-scoring.ts` path validates the frozen contract, identity, dissent id and outcome inside the execution transaction; there is no parallel scoring writer. Each successful application is immediately audited as `postmortem.applied` with the target and artifact hash. If a scoring write succeeds but its audit fails, the artifact remains applied with `audit_pending: true`; repeat conclude retries the audit without scoring again. Publication waits for the audit. The scorer compares the reviewed claim, prediction, tripwire, dissenter and predicate generation inside its transaction; an amended prediction leaves a stale assessment unapplied with a reason to review it again. A stable event correlation identifies the postmortem/artifact operation so retries after a partial conclusion cannot duplicate the event or revert a later score. Repeating an unchanged explicit `score_dissent` assessment is also a no-op.

`vindicated` requires evidence supporting the prediction, `refuted` requires contrary evidence, and `untested` means the run established neither. Firing does not establish vindication, and not firing does not establish refutation. Without an accepted assessment there is no new scoring event. Scores remain advisory and display-only: they never weight votes, alter consent thresholds, or change routing. These artifacts stay in the record and never become planning lessons or clearer-wording flags.

**Flags.** A finding with category `prompt_misread`, `project_misread` or `contract_ambiguity` is **flagged**: the postmortem records which contract field, task text or prompt phrase was misread and the clearer wording the meeting proposed. Flags are lessons with `flag: true` (§7).

## 7. Reuse before the next plan

`lessons.json` holds every accepted `rule`, `agent_rule`, `contract_rule` and flag, newest first, each with its postmortem id, finding ids and date. Superseded lessons stay with `superseded_by`.

Before a new work plan for a project:
- `propose_contract` (when `repo_dir` resolves to a project with lessons) adds a `postmortem_lessons` section to its result and the draft contract: every active `contract_rule` becomes a `decisions` entry (`by: "postmortem:<pm>"`), and every flag becomes a warning "Earlier work misread X; state it explicitly" listed in the result's `warnings`. It does not refuse the proposal.
- `start_ultraplan` with `repo_dir` (new optional argument) appends a bounded "Lessons from past postmortems" section to the planner's context, flags first.
- Heads-down task cards include the active `agent_rule`s for the card's persona and the project `rule`s, capped at 4 KB, under "Lessons from earlier postmortems".
- `postmortem(action: "lessons", project)` returns them for any other planning the host does itself.

This happens whether or not postmortem mode is enabled now: lessons that were learned are always read.

## 8. Telling the human

When a postmortem concludes:
- The tool result says so, gives the record path (`postmortems/<pm>.md`) and a one-paragraph summary to relay.
- In a heads-down run, `postmortem.concluded` wakes the watcher (`reason: "postmortem"`), the dashboard gains a **Postmortems** page (findings, the full dialogue, artifacts and their status; every string redacted and escaped like the rest of the dashboard), and, with GitHub sync, the parent issue gets one comment with the summary (bodies redacted and neutralized like every other sync comment).
- `postmortem(action: "read", pm)` returns the full record for the host to show verbatim.

The human can read; there is no route, tool or argument by which their words enter the meeting.

## 9. Tool surface

Two new orchestrator tools (worker servers unchanged), with `additionalProperties: false` and MCP annotations, bringing the combined WS14/WS16 orchestrator server to 41:

| Tool | Arguments |
|---|---|
| `postmortem` | action\* (enable, disable, record, fix, draft, lessons, list, read), project, execution_id, work, reason, finding{summary\*, detected_by\*, responsible[]\*, category\*, task, evidence[]}, finding_id, fix{by, status, ref}, pm |
| `hold_postmortem` | action (hold, the default, or conclude); hold: project\*, execution_id or work, opening\*, participants[], format, rounds, provider, model, base_url, memory_target; conclude: pm\*, closing\*, accept[], reject[{id, why}], orchestrator (required for accepted dissent scores) |

`hold_postmortem(action: "conclude")` is the closing step of §5; it is one tool with an `action` so the count stays small. README tool table, `docs/tools.md`, and a new `docs/modes/postmortem.md` guide are updated; the README entry stays one table row.

## 10. Security

- Free text in findings, openings, closings and artifacts is scrubbed before any write, event or blob, and redacted again on every dashboard and GitHub surface.
- Evidence is refs only; the server never copies command output into a finding.
- Persona and memory writes reuse the workshop's containment and backup path; nothing writes outside allowed agent roots or the project's `.claude/agent-memory`.
- Context bundles never contain the human's chat, confirmation or original prompt verbatim.
- New events go through the existing validators; payloads over 8 KB use blobs.
- `enable` is audited with the human's quoted words; `applied` artifacts are audited with their hash.

## 11. Tests

Unit tests for: project keying and refusal of non-repos; draft record/fix/rebuild from events; automatic findings from rejections (dedupe by signature, fix status transitions); `hold_postmortem` refusals while fixes are pending; seat selection; format choice (waffle-house on a single responsible agent); artifact parsing (fences/blockquotes ignored, limits, bad targets reported); conclude applying only accepted artifacts with backups; lessons fed into `propose_contract`, ultraplan context and task cards; refusal of nudges/says on a postmortem session; watcher wakes; dashboard page escaping; redaction of findings. Provider calls are faked as in the existing collaboration tests. The tests are `test/unit/postmortem-draft.test.mjs`, `postmortem-meeting.test.mjs`, `postmortem-lessons.test.mjs` and `postmortem-visibility.test.mjs`.

## 12. Implementation notes (where the build went further or differently)

- **Reducer.** `REDUCER_VERSION` is 10, combining WS14 postmortem state introduced in version 9 with WS15 usage visibility. The `postmortem` section of the blackboard lives in `src/execution/postmortem-state.ts` (handlers and a hook run after every event). Fix transitions follow the reducer’s task/check settlement rules. Besides the orchestrator’s `fix` action, the runner emits `postmortem.fix_updated` alongside a delayed finding when recovery already follows its causation in the scanned log. The scan and generated batch share the execution transaction, so recovery cannot race the append. A retry sets `fix.by` to the task's persona, a reassignment to the new agent. The meeting covers every finding recorded before `postmortem.started` (each finding then names its `pm`); later findings start the next draft. `ready_seq` is the seq of the event that made the draft ready (no pending fix, every task with a finding terminal), and the watcher wakes on exactly that event.
- **Automatic findings.** A finding's id is derived from the task, the check ids and their signatures, so a repeat has the same id and carries `repeats`. Each finding's envelope names the event that caused it (`causation`), which keeps the runner's pass idempotent across restarts. A failure at integration scope has no `task` (the merged task is already accepted); its fix is settled when the same integration check passes again. A rejection that only asks a worker to resolve a merge conflict is not a finding.
- **Meeting.** At least two agents besides the orchestrator are needed for the engine; the host passes `participants` otherwise. `postmortem.started` is written after the meeting has run, so a meeting that fails leaves the draft unchanged and can be held again. Before saving, the project lock guards a final check: an overlapping hold loses with a clear error if that postmortem already has a held or concluded record; it cannot overwrite closing statements or application history. In a run the meeting's provider usage is recorded per speaking persona on the budget ledger (source `postmortem`) but not enforced, since the human opted in and the run is usually over. The directive of §5 is part of the context every turn carries.
- **Human's words.** Task cards in the context are built without the original request; the orchestrator's opening and closing have any verbatim stretch of the contract's `original_prompt` or the run's `confirmation` replaced by a marker before they are used.
- **Artifacts.** Only the last turn is read. Flags (§6) are recorded automatically when the meeting concludes, one per flagged finding, with the clearer wording taken from the accepted artifacts that name it. An accepted artifact that fails to apply (a missing persona, a symlinked memory path) is reported with its reason and does not stop the others.
- **Lessons.** A lesson restates an active one when kind, target and wording (ignoring case and whitespace) match; the older one gets `superseded_by`. `start_ultraplan` gains the optional `repo_dir`. `execution_status` reports the draft (`postmortem`) once a run has findings or meetings.
- **Telling the human.** The dashboard page, the watcher wake and the GitHub comment need the run's runner (and, for GitHub, its sync) to be alive, so they appear when a meeting concludes before the run ends. The record is always available through `postmortem(action: "read")`. `postmortem.concluded.record` is the blob ref of the record's markdown, which the dashboard renders. A repeat conclude retries failed blob/event publication for the saved record without changing its closing or reapplying artifacts; `postmortem.concluded` is deduplicated by postmortem id under the execution transaction.
- **Opt-in is the project's alone.** `propose_contract` and `amend_contract` set `postmortem.enabled` from the project's state: an explicit `true` while the project is off is dropped with a warning pointing to `postmortem(action: "enable")`; an explicit `false` is kept off. `hold_postmortem` is refused while the project's mode is off.
- **Recurrences.** A failure that repeats an open finding (no meeting yet, fix pending) raises its `repeats` and adds any new responsible agent. A failure whose finding is already fixed, abandoned or covered by a meeting starts a new finding (its id carries an epoch), so a red integration check reopens the question and keeps the draft from its meeting.
- **Seats by path.** A participant ref (such as a path outside the agents directory) replaces the bare key a finding gave the same agent, so the persona loads from where it lives.
- **Usage.** A meeting without an execution uses the collaboration engine's per-persona table ledger. A run-backed meeting records each call on the execution ledger under the speaking persona, with source `postmortem`, a call id and the postmortem id as correlation; it does not duplicate that spend in the table ledger. Usage is flushed on success and failure before the held record is published, including failed or overlapping holds. Provider-reported tokens remain measured and price-table costs estimated. Calls with no usage report use text-length estimates; a failed call estimates its request tokens, with no reply text available. A failed meeting leaves its draft available to retry and retains the spend of the failed attempt.
- **Retention.** Drafts that were never held are removed with the session retention sweep at server start (`src/postmortem/retention.ts`).

- **Dissent integration (#133).** The scoring event payload and reducer semantics are unchanged; WS14 used `REDUCER_VERSION` 9; the combined reducer is version 10. `postmortem.concluded.artifacts` now accepts a `dissent_score` count. Its reducer, watcher, dashboard and sync consumers iterate artifact counts without an exhaustive kind list. The watchdog never reads scores; worker attestation reads worker startup tools and is unaffected by scoring. The session archive preserves scrubbed dialogue (including proposed artifact lines) and does not interpret execution scores. The readable postmortem record/blob preserves the dissent snapshot and each proposal’s outcome, evidence and application status.
