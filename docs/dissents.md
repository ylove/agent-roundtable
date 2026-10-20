# Dissents and tripwires

A dissent preserves a participant's concern and predicted failure when the group agrees to proceed. A concern raised at the table becomes a tripwire during heads-down work: when the recorded evidence matches, the dissenter hears about it and can help reconsider the decision.

Dissents are included in the contract hash, consent hash and rendered contract. A contract may contain at most 16 dissents; each claim and prediction is limited to 500 characters. `on_fire` defaults to `huddle`.

## File or update a concern

The orchestrator can call `file_dissent` while the contract is a draft:

```json
{
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main",
  "dissent": {
    "id": "retry-risk",
    "by": "skeptic",
    "source": { "kind": "manual" },
    "claim": "Retries may duplicate writes.",
    "predicted_failure": "The repeated request check fails.",
    "tripwire": { "kind": "check_failed", "check": "unit", "task": "storage" }
  }
}
```

The dissenter must be a contract participant. Source kinds are `manual`, `consent`, `ultraplan`, `debate`, `waffle_house` and `duel`; an optional `source.ref` retains provenance. Filing with an existing dissent id replaces that concern. Every filing creates a new draft version and requires renewed consent.

Authenticated agents use the same tool with `execution_id` and `agent_token` instead of `orchestrator`. On a worker server, identity is already bound and neither credential argument is accepted. Agents must be contract participants and may file or update only their own concerns; `by` can be omitted and is filled from their identity.

## Tripwires and freeze

Tripwires are structured data, never commands:

| Kind | Fields | Fires when |
|---|---|---|
| `check_failed` | `check`: a validation command id; optional `task` | The named check has a failed result, limited to `task` if supplied. |
| `path_touched` | `paths`: nonempty relative globs; optional `task` | A recorded touched path matches a glob, limited to `task` if supplied. |
| `task_state` | `task` and `state`: `rejected` or `blocked` | The named task is blocked or has a recorded rejection, as specified. |

Every check or task reference must exist. Globs support `**`, `*` and `?`; absolute paths and parent traversal are rejected with either path separator. Dissent text cannot supply `argv`, `cwd` or `env`.

A draft may omit its tripwire. Freeze refuses incomplete dissents even when everyone consents or participant objections are excused. Update the dissent with a valid tripwire, or explicitly excuse it:

```json
{
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main",
  "dissent": { "id": "retry-risk" },
  "excuse_reason": "Retries were removed from the scope."
}
```

Only the orchestrator can excuse a dissent. Excusal removes it from the next draft, records the reason in the proposal and audit log, and preserves the concern in its earlier contract blob. Participants must consent to the new version. Excusing a dissent does not resolve the participant's consent objection.

An objector can pass `resolve_objection: true` when filing their own dissent. This records `contract.objection_resolved` with `how: "dissented"` and the dissent id: the objector agrees to the new version while retaining the concern. It requires an unresolved `OBJECT` on the current version; `UNCLEAR` and stale objections do not qualify. Other participants must consent again, and an incomplete retained dissent still blocks freeze.

Unsigned ultraplan sessions automatically import their archived `OBJECT` sign-offs as dissent drafts with author and session provenance. `UNCLEAR` and approved sign-offs are not imported. Imported text is capped at 500 characters with a warning when truncated; the full sign-off stays in the archive. Refine the prediction and supply a tripwire, or excuse the draft before freeze.

Ending a debate or waffle-house session with `request_summary: true` also asks each challenger or attacker for their own closing statement. The proponent or defender still writes the main summary. Adversarial statements are archived separately with their authors. Debate meetings, including local meetings, keep the normal discussion summary and action items and make a separate extraction call for the challenger's concerns. Extraction blocks stay out of the readable and public summary. For each remaining concern, the extraction prompt requests these exact, unindented lines outside fences and blockquotes:

```text
<DISSENT>
claim: Retrying an order can create a duplicate.
predicted_failure: The order validation fails after a retry.
</DISSENT>
```

`propose_contract` with `from_session` imports these blocks as dissent drafts with `source.kind: debate` or `waffle_house` and the session id in `source.ref`. Identity comes from the archived speaker. Tags embedded in other lines, quoted or indented blocks, incomplete blocks, multiline values and extra fields (including `Decision:` or `Outcome:` lines) are ignored. A fence closes only with bare fence characters and optional whitespace; a language-labelled fence inside it does not expose its contents. Ordinary turns and the proponent's or defender's summary cannot file another participant's concern. Sessions ended without a requested summary add no dissent drafts.

A finished duel imports the same way. `from_session: "duel-<id>"` reads `ROUNDTABLE_HOME/duels/<id>.json` (a regular file of at most 10 MB; the id is validated strictly, with no paths). Each archived `dissent` event becomes a draft concern with `source.kind: duel`, the duel id in `source.ref`, and the filing persona as author. Text is scrubbed and capped at 500 characters, a repeated identical dissent counts once, and a dissent already carried in the proposal is not added twice. These drafts need a tripwire or an explicit excusal before freeze, like the others.

Imports use the existing contract validator: each value must fit the 500-character limit and all explicit and imported dissents together must fit the 16-entry limit. Oversized imports fail proposal validation. Imports do not invent tripwires; use `file_dissent` to arm or explicitly excuse each draft before freeze.

Frozen contracts use `amend_contract`; changing dissents requires the existing consent or audited override path. See the [design](design/dissents.md) for implementation details.

## Runtime

Tripwires arm after freeze. The watchdog evaluates failed checks, recorded touched paths, and blocked or rejected tasks from the blackboard. A rejection is retained even after the task returns to work. Each tripwire fires once per affected task across retries and amendments that keep the same predicate. Changing the predicate re-arms it under a new generation. New and changed tripwires match only evidence recorded after their amendment. An unscoped check predicate also covers integration checks, which have no task.

Removing a dissent through `amend_contract` removes it from the current blackboard projection, withdraws its open escalations and releases only its own holds. This also works after an earlier amendment cancelled the affected task: the escalation is withdrawn while the task stays terminal. Withdrawal also releases human-action pauses owned by the escalation, including pauses on dependent tasks; overlapping manual pauses and pauses from other open escalations remain. The amendment audit and withdrawal events preserve that disposition; unrelated dependencies, needs and escalations keep blocking work.

Every firing records `dissent.tripwire_fired` and delivers a directive to the dissenter's persona inbox and matching live worker inboxes, including runner ids such as `w-storage`. The firing records its notification recipients. If no live reader exists, it also wakes the orchestrator. A self-trip, including a taskless check attributed to an orchestrator dissenter, notifies and wakes the orchestrator without opening a huddle. Claims and evidence are scrubbed and fenced as untrusted data. They never become commands or process settings.

| `on_fire` | Response |
|---|---|
| `notify` | Deliver the directive to the dissenter. |
| `huddle` | Also open a micro-huddle: the dissenter opens and concludes it, and the agent whose work tripped the predicate answers. |
| `pause_and_huddle` | Also hold the affected task until resolution: worker tools refuse further work and the runner stops its worker. Submitted, checking and merging tasks retain their pipeline state while the hold prevents merging. |

Agreement resolves the escalation and releases only its own blocking reason. Retry and reassignment also preserve other escalation holds, dependencies and interface or artifact needs; a fresh attempt cannot start until the remaining blockers clear. Replaying older retry or reassignment resolutions without an explicit unblock releases the resolved escalation’s own hold too. Dependency waits follow recursively split tasks to their parts. A published interface with the same name cannot satisfy an unfinished task dependency. Disagreement or an unusable answer wakes the orchestrator for resolution.

A micro-huddle reserves one allowance shared by its answer and conclusion, bounded by the execution, affected task and requesting agent caps. Both calls are capped, first-turn usage is recorded before the conclusion starts, and both turns charge the requesting identity's ledger. The usage meter reserves the paid call’s allowance before dispatch and settles it against reported usage. If the provider omits usage, or the request fails without a usage report (including a timeout or empty completion), the reservation remains charged as an estimate. This can consume the remaining allowance and stop the conclusion; later huddles see that spend too. Exhaustion between turns routes the unresolved escalation to the orchestrator. Persona output limits account conservatively for prompt cost; unknown model rates use conservative estimates, so configure pricing for accurate budgets. Without initial huddle budget, notification still happens and a nonblocking escalation wakes the orchestrator without a model call. If the orchestrator is unavailable, fallback checks the lead's own budget; an exhausted lead budget requests human action.

Both persona and driver calls appear in the [usage report](usage.md), the usage tool, status-line totals and dashboard Usage page. Call provenance names **dissent micro-huddle**, the dissent id, execution, affected task and requesting identity charged. Outstanding paid reservations, missing usage and failures retain explicit **estimated** USD. Reports replace reservations by call id, including token counts, without double charging. Free local providers remain free.

After runner loss, huddle timeout or recovery retains uncertain paid spend once under the same call id with `reservation: false`, including when the huddle has already concluded or routed. The retained estimate counts toward budget enforcement; settlement preserves task holds and does not restart the discussion. Stop adds its own hold even if dissent already blocks the task, so resolving all dissent escalations cannot resume work while the Stop escalation remains unresolved.

Stopping either participant or the affected task's worker aborts the huddle and routes the unresolved escalation to the orchestrator. Stop before dispatch releases the unused reservation. After dispatch, usage already reported is charged; unreported paid allowance remains estimated, and only unused allowance is released. This also applies during the conclusion and after a runner interruption. A late report settles the same entry without restarting the huddle. A `pause_and_huddle` hold survives Stop, unavailable seats, exhausted budget, disagreement and other fallback paths until explicit resolution of its escalation. Resolution removes only that escalation's reason; other dissent holds, Stop blockers, dependencies and needs remain. If agreement commits before Stop, it releases only its own hold; if Stop commits first, agreement cannot clear the hold. See both [design documents](design/dissents.md#integrated-micro-huddle-accounting-and-stop) for the full case table.

## Advisory scores

The contract's orchestrator may record or revise an outcome after freeze:

```json
{
  "tool": "score_dissent",
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main",
  "dissent_id": "retry-risk",
  "outcome": "vindicated"
}
```

Outcomes are `vindicated` (evidence supports the prediction), `refuted` (evidence contradicts it), or `untested` (the run did not establish an outcome), recorded as `dissent.scored`. Scores stay alongside the dissent and its author for display and review. They never change voting or consent weight. A fired tripwire does not automatically vindicate a prediction, and an unfired one does not refute it. Until the orchestrator records an outcome, the dissent is shown as not scored.

## Dashboard

Open **Dissents** in the run's local dashboard to see each dissenter, claim, predicted failure, source, tripwire and `on_fire` mode. An armed tripwire is waiting for matching evidence in its current generation; a fired one lists each affected task (or integration check), who tripped it and the evidence. The page also shows notification recipients and orchestrator wakes, historical firings, associated huddle outcomes and decisions, and the latest advisory score.

The page follows new blackboard events automatically. It is read-only: file or amend concerns and set scores through the tools. Dissent text and evidence are redacted and escaped for display. See [heads-down execution](heads-down.md#escalations-and-huddles) for escalation controls.
