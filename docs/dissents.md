# Draft dissents

A dissent preserves a participant's concern and predicted failure in the contract. It is included in the contract hash, consent hash and rendered contract. A contract may contain at most 16 dissents; each claim and prediction is limited to 500 characters. `on_fire` defaults to `huddle`.

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

| Kind | Fields |
|---|---|
| `check_failed` | `check`: a validation command id; optional `task` |
| `path_touched` | `paths`: nonempty relative globs; optional `task` |
| `task_state` | `task` and `state`: `rejected` or `blocked` |

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

Frozen contracts use `amend_contract`; changing dissents requires the existing consent or audited override path. Runtime tripwire evaluation, notification, huddles and scoring are subsequent workstreams described in the [design](design/dissents.md).
