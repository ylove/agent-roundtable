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

The dissenter must be a contract participant. Source kinds are `manual`, `consent`, `ultraplan`, `debate` and `waffle_house`; an optional `source.ref` retains provenance. Filing with an existing dissent id replaces that concern. Every filing creates a new draft version and requires renewed consent.

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

Ending a debate or waffle-house session with `request_summary: true` also asks each challenger or attacker for their own closing statement. The proponent or defender still writes the main summary. Adversarial statements are archived separately with their authors; debate meetings use the challenger's own summary. For each remaining concern, the summary prompt requests these exact, unindented lines outside fences and blockquotes:

```text
<DISSENT>
claim: Retrying an order can create a duplicate.
predicted_failure: The order validation fails after a retry.
</DISSENT>
```

`propose_contract` with `from_session` imports these blocks as dissent drafts with `source.kind: debate` or `waffle_house` and the session id in `source.ref`. Identity comes from the archived speaker. Tags embedded in other lines, quoted or indented blocks, incomplete blocks, multiline values and extra fields (including `Decision:` or `Outcome:` lines) are ignored. Ordinary turns and the proponent's or defender's summary cannot file another participant's concern. Sessions ended without a requested summary add no dissent drafts.

Imports use the existing contract validator: each value must fit the 500-character limit and all explicit and imported dissents together must fit the 16-entry limit. Oversized imports fail proposal validation. Imports do not invent tripwires; use `file_dissent` to arm or explicitly excuse each draft before freeze.

Frozen contracts use `amend_contract`; changing dissents requires the existing consent or audited override path. See the [design](design/dissents.md) for implementation details.

## Runtime

Tripwires arm after freeze. The watchdog evaluates failed checks, recorded touched paths, and blocked or rejected tasks from the blackboard. A rejection is retained even after the task returns to work. Each dissent fires once per affected task, including across retries and contract amendments. An unscoped check predicate also covers integration checks, which have no task.

Every firing records `dissent.tripwire_fired` and delivers a directive to the dissenter's inbox. Claims and evidence are scrubbed and fenced as untrusted data. They never become commands or process settings.

| `on_fire` | Response |
|---|---|
| `notify` | Deliver the directive to the dissenter. |
| `huddle` | Also open a micro-huddle: the dissenter opens and concludes it, and the agent whose work tripped the predicate answers. |
| `pause_and_huddle` | Also block the affected task until resolution. |

Agreement resolves the escalation and unblocks its task; disagreement or an unusable answer wakes the orchestrator for resolution. Existing budget limits apply. Without budget, notification still happens and a nonblocking escalation wakes the orchestrator without a model call.

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

Open **Dissents** in the run's local dashboard to see each dissenter, claim, predicted failure, source, tripwire and `on_fire` mode. An armed tripwire is waiting for matching evidence; a fired one lists each affected task (or integration check), who tripped it and the evidence. The page also shows associated huddle outcomes and decisions and the latest advisory score.

The page follows new blackboard events automatically. It is read-only: file or amend concerns and set scores through the tools. Dissent text and evidence are redacted and escaped for display. See [heads-down execution](heads-down.md#escalations-and-huddles) for escalation controls.
