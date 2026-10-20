# Dissent tripwires: design

Status: approved. WS16 is split across issues #139–#142. This document specifies the contract, filing, runtime and visibility behavior those workstreams build against. It extends [Heads-down execution: design](heads-down.md).

## 1. Motivation

Agreement to proceed does not mean every participant thinks the plan will work. An objector may consent while still predicting a specific failure. Today, that prediction can disappear into a session transcript or a consent reason, leaving execution without a way to recognize that the concern has become relevant.

A **dissent** preserves the dissenter, their claim, the predicted failure and a **tripwire**: a structured predicate over execution state. When the predicate becomes true, the watchdog notifies the dissenter and, by default, opens a micro-huddle with the participant whose work tripped it. The concern returns with evidence at the point where it can affect a decision.

Dissents are part of the agreed contract. They are neither executable instructions nor an alternative voting system. Scoring records what happened for later review; it never changes a persona's voting weight.

## 2. Contract field

Add a top-level `dissents[]` field to `Contract` in `src/execution/types.ts`. Each armed dissent has this shape:

```ts
{
  id: string;
  by: string;
  source: {
    kind: "ultraplan" | "consent" | "debate" | "waffle_house" | "manual";
    ref?: string;
  };
  claim: string;
  predicted_failure: string;
  tripwire:
    | { kind: "check_failed"; check: string; task?: string }
    | { kind: "path_touched"; paths: string[]; task?: string }
    | { kind: "task_state"; task: string; state: "rejected" | "blocked" };
  on_fire: "notify" | "huddle" | "pause_and_huddle";
}
```

`id` is stable and unique within the contract. `by` identifies the dissenter and must resolve to a participant in the contract. `source` preserves provenance; `ref`, when present, identifies the originating session or objection. The source enum uses `waffle_house`, even though the human-facing format is called waffle house.

`claim` states the concern. `predicted_failure` states the observable failure the dissenter expects. Each is limited to 500 characters. A contract contains at most 16 dissents. An omitted `on_fire` normalizes to `huddle`; a contract without dissents normalizes to an empty array.

For example, assuming `skeptic`, task `storage` and validation command `storage-unit` exist in the contract:

```json
{
  "id": "dissent-storage-retry",
  "by": "skeptic",
  "source": { "kind": "consent" },
  "claim": "The retry path may apply the same write twice.",
  "predicted_failure": "The storage unit check will fail on a repeated request.",
  "tripwire": {
    "kind": "check_failed",
    "check": "storage-unit",
    "task": "storage"
  },
  "on_fire": "huddle"
}
```

### Contract integration

In `src/execution/contract.ts`:

- Add `dissents` to the top-level `ck.known` allow-list and to the normalized return value in `normalize`.
- Extend `CONTRACT_LIMITS` with the count and text limits, and validate the nested shape, enums and references through `checkContract`.
- Include dissents in `renderContractMarkdown`, so consent prompts and `CONTRACT.md` expose the concern, provenance, tripwire and response policy.
- Keep the existing hashing model. `contractHash` excludes only `consent` and `frozen`, so the new top-level field is automatically hashed. `consentHash` also includes it. Changing a dissent therefore changes the content participants agree to and follows the existing version and re-consent rules.

Every referenced contract id must exist: the dissenter must be a participant, `check` must name an entry in `validation.commands`, and each `task` must name a contract task. A provenance reference is not a substitute for these checks. Duplicate dissent ids and dangling references are validation errors.

## 3. Tripwire kinds and safety model

Tripwires are non-executing predicates only. The watchdog reads the current `BlackboardState`; it does not run a command or inspect the filesystem to evaluate a dissent.

| Kind | Predicate | Scope |
|---|---|---|
| `check_failed` | The named validation command has a failed result in `state.checks`. | With `task`, match that task's result. Without it, consider matching task and integration results. |
| `path_touched` | A path recorded in `state.files` matches one of the supplied relative globs. | With `task`, require that task's recorded touch. Without it, consider any recorded task. |
| `task_state` | The named task's current state is `rejected` or `blocked`, as specified. | Always names exactly one task. |

`path_touched.paths` uses the existing relative-glob conventions. Reject absolute paths and any parent traversal (`..` path segment), including platform-specific forms. These patterns select recorded paths; they never grant filesystem access or expand a task's write scope.

Dissenter text never reaches `argv`, `cwd` or `env`. A `check_failed` tripwire refers to an existing validation command; it cannot supply, change or execute that command. Claims, predictions, provenance and evidence remain data in stored records, notifications and huddle context.

The state projection determines what is observable. A path tripwire observes touches already recorded on the blackboard, not unsubmitted edits. Check matching uses the reducer's submission-aware check state, retaining its protection against stale results. A matching tripwire is evidence that the concern deserves attention, not proof that the entire prediction was correct.

## 4. Filing paths

### Structured filing while drafting

Add a tool available to the orchestrator and agents that files a structured dissent while the contract is a draft. It accepts the contract fields above, validates references and limits, and persists the dissent through the existing contract lifecycle. An agent files under its bound identity; filing must not let one participant impersonate another.

Filing updates the draft content and its hash. It must not silently mutate a frozen contract. Later changes follow the existing amendment and consent rules.

### Consent objections

An `OBJECT` verdict can be resolved with a new `how: "dissented"` value on `contract.objection_resolved`. The objector consents to proceeding while retaining the structured dissent in the contract. This differs from withdrawing the concern or excusing the objector.

Extend the event type and validator, the consent projection in `src/execution/contract-state.ts`, and the lifecycle handling in `src/execution/contract-lifecycle.ts`. Resolution must retain the dissent and apply to the version being consented to. An unresolved objection must not disappear merely because a dissent draft exists.

### Ultraplan sign-offs

When building a contract from an ultraplan session that was not signed off, import its `OBJECT` sign-offs as dissent drafts. The proposal hook is the existing unsigned-session branch in `proposeContract` in `src/execution/contract-lifecycle.ts`. Use the archived sign-offs produced by `src/sessions/ultraplan.ts`, retaining the objector and source reference.

The existing warning that a session was not signed off is insufficient on its own: the objection must remain visible as a draft concern. Import does not invent a valid predicate or turn an `UNCLEAR` verdict into an `OBJECT` verdict.

### Debate and waffle house

Extend the challenger and attacker summary prompts in `src/sessions/modes.ts` to request a tagged `DISSENT` block for a remaining concern. Carry the author's identity and source session into the resulting dissent draft. The existing proponent and defender summaries do not replace the challenger's or attacker's own statement.

Parse tagged blocks using `ownLines`-style rules from `src/execution/escalation.ts`: ignore content inside backtick or tilde fences and lines inside blockquotes. A closing fence must contain only matching fence characters (at least the opening length) and optional whitespace. A language-labelled fence inside a fence cannot close it. A quoted transcript, example or another participant's words cannot spoof a filed dissent. Parsed text still passes through structural validation; a tag alone does not arm a tripwire.

Debate meetings and local meetings retain their normal discussion summary and action items. They make an additional challenger extraction call, archive it in `dissentSummaries`, and import only that authored extraction. Raw extraction blocks are removed from readable and public meeting summaries.

### Freeze gate

An imported or incomplete dissent draft needs a valid tripwire before freeze, or it must be explicitly excused with a reason. Missing predicates must not become an always-true default, silently disappear, or enter the executable contract as armed dissents.

Draft handling must preserve the concern and the disposition for review. The final frozen `dissents[]` contains validated, armed entries; excusing an incomplete draft is an explicit lifecycle disposition, not an additional tripwire kind. A `dissented` resolution does not bypass this freeze gate or the existing consent blockers.

## 5. Runtime

### Pure watchdog rule

Add `dissentTripwireRules` to `src/execution/watchdog.ts`, wire it into `evaluate`, and add the corresponding `WatchdogRule` member in `src/execution/watchdog-actions.ts`.

The rule evaluates the frozen contract's dissents against `state.checks`, `state.files` and task states. It produces action drafts without filesystem access, process execution, model calls or other side effects. The existing runner applies those actions.

Use the deterministic key `tripwire:<dissent>:<task>` for each initial match. A taskless match uses an empty task component. Persist fired keys in the dissent projection so repeated watchdog passes, replay and runner restarts cannot notify or escalate again for the same dissent/task pair and predicate generation. A dissent that applies across tasks can fire once for each matching task. Changing a tripwire assigns a new generation from its amendment sequence and appends `@<generation>` to the key. Preserve historical firings, but display armed/fired status for the current generation.

New or changed tripwires retain an `armed_seq` floor. Check results, path touches and task-state evidence must have a later sequence to match; amendments cannot retroactively fire on older evidence. Unchanged predicates retain their deduplication keys across amendments.

### Response policy

Every firing records evidence and issues `directive.issued` to the dissenter's identity/persona seats and matching live worker ids, including runner-style ids. The existing `deliver` path in `src/execution/blackboard.ts` reduces that directive into `state.inbox`. The firing payload retains `notified` recipients and `orchestrator_woken`. With no live reader, the firing itself also wakes the orchestrator's watcher. Notification is required for all three policies, including when a huddle cannot run.

The notification identifies the dissent, the matching task when present, the claim and the observed evidence. Scrub free text and fence the claim and evidence as data. Delimiter handling must prevent embedded text from escaping the data fence and becoming instructions in notification or huddle prompts.

| `on_fire` | Action after notification |
|---|---|
| `notify` | Record the firing and deliver the directive. |
| `huddle` | Raise an agent escalation and use the existing micro-huddle path. |
| `pause_and_huddle` | Also block the task whose work tripped the predicate until the huddle resolves. |

For a huddle, call `escalationAction` with `with: "agent"`. Set the escalation's `agent` to the dissenter and its counterpart target to the participant whose work tripped the predicate. Preserve the distinction between the dissenter and the tripper when selecting seats.

The dissenter opens the micro-huddle and concludes it after the counterpart answers, using the existing flow in `src/execution/huddle.ts`. A `DISAGREED` outcome routes to the orchestrator. Existing handling for inconclusive outcomes, unavailable seats and budget clamps continues to apply.

Self-trips notify and wake the orchestrator without a huddle, including taskless checks attributed to an orchestrator dissenter. Counterpart selection preserves the task-equality guard and cannot replace a rejected self-seat with an unrelated persona fallback.

The micro-huddle reserves a scoped allowance shared by both calls (at most $1, with a live worker answer still capped at $0.50). Execution, task and requesting-agent budgets bound that allowance. Concurrent micro-huddles in the runner share these reservations. Persona requests subtract a conservative prompt-cost estimate before bounding output tokens; unknown rates use conservative estimates. Both persona and driver usage charge the requesting identity, and the answer's usage is persisted before checking the conclusion's allowance. Exhaustion between turns routes to the orchestrator. Lead fallback checks and charges the lead's identity; if it cannot run for lack of funds, it requests human action.

Bounded persona calls pass their per-call allowance to the usage meter. Reserve paid calls in the meter before dispatch and settle the reservation against any reported usage. If a paid provider reports no usage (including Replicate), or the call fails before reporting usage (including timeouts and empty completions), retain that allowance as estimated USD. A usage report replaces the reservation, so settlement cannot double charge a call. Persist and subtract it before admitting the conclusion, so neither the second turn nor later huddles can reuse unreported spend. Local providers that bill nothing per token remain free.

If no huddle budget remains, retain the firing and notification and wake the orchestrator instead of starting model calls. An integration-only match may lack a task or counterpart; route it through the existing orchestrator fallback when a micro-huddle cannot be seated.

For `pause_and_huddle`, hold only the affected task through the existing escalation/task lifecycle. Each escalation owns a separate blocking reason. Worker tools refuse work while held, and the runner's existing kill path stops the affected worker regardless of the escalation's requester identity. Submitted, checking and merging tasks retain their pipeline state: the hold gates the merge queue and is checked again under the git lock. A hold winning the merge/acceptance race rolls the merge back. In-flight check completion or rejection cannot erase a hold. Resolution removes only its own escalation reason, preserving other escalations, dependency waits and interface/artifact needs. A taskless match must not pause arbitrary tasks. When a huddle falls back to the orchestrator, any applicable hold remains subject to explicit escalation resolution.

Retry and reassignment reset the attempt and claim without dropping unrelated blocking reasons. `escalation.resolved` releases its own blocking reason so historical retry/reassignment logs that omitted `task.unblocked` recover correctly. New writers still emit a source-specific unblock, whose repeated release is harmless; another hold or dependency/need wait keeps the task blocked and prevents spawning. Dependency release recursively expands `state.splits`, using the watchdog's task-first satisfaction rule: a known task must be accepted even when an interface shares its id.

### Integrated micro-huddle accounting and Stop

Dissent micro-huddle persona and driver calls use `budget.usage_recorded` with `source: "dissent micro-huddle"`, `dissent_id`, `task` when present, and `agent` set to the requesting identity charged for both turns. The containing execution log supplies the execution id. Each bounded call has a stable `call_id` (`<huddle>:<turn>`). Before dispatch, its paid allowance is durably recorded with `reservation: true`, `estimated: true` and estimated USD provenance. A later event with the same call id replaces that entry, including its token counts and provenance, rather than adding another charge. Historical events without call ids remain additive. The blackboard keeps current entries in `budget.calls`; execution, task, team and agent totals and per-model provenance all reflect replacement. `REDUCER_VERSION` stays 10.

The usage JSON and tool expose current entries as `agents[].calls`: call id, source, dissent id, execution, task, charged agent, provider, model, USD, `estimated`, `reservation` and provenance. The CLI and dashboard Usage page show the same provenance beside each call. Totals split measured, reported and estimated spend on every surface; the status line spells out **estimated**. Outstanding reservations and retained allowances count as estimated USD even when they have zero tokens. Provider token reports are measured; a cost computed from those tokens remains estimated. A driver-reported dollar cost is measured. Settlement can lower an estimate; dashboard sparklines apply replacement deltas. Per-agent `platforms` projections and `agents[].platforms` keep driver and persona platform totals distinct even when both charge the same identity. Free local providers reserve no paid allowance and remain free. Outstanding reservations reduce admission headroom, but the watchdog defers durable budget thresholds and money escalations until settlement or retention; a temporary allowance cannot leave a permanent budget pause after a cheaper report.

Stop behavior is the same for a requester, counterpart, or worker on the affected task, including Stop while the conclusion is in flight:

| Case | Money release or retention | Routing and task hold |
|---|---|---|
| Stop before a paid call dispatches | Release its unused reservation to zero; release the unused shared allowance. | Route the unresolved escalation to the scope's orchestrator. Preserve any dissent hold. |
| Stop after dispatch, with usage already reported | Replace the reservation with reported token usage and its measured or estimated cost; release unused allowance. | Abort the remaining discussion, conclude `NO_OUTCOME`, and route to the orchestrator. Preserve holds. |
| Stop after dispatch, without usage; provider failure, empty completion or timeout without usage | Retain the dispatched call's allowance as estimated USD, mark it no longer outstanding, and release only unused allowance. | Conclude `NO_OUTCOME` and route. Preserve holds for explicit escalation resolution. |
| A stopped provider or driver reports late | Replace the same call's retained estimate; never add it twice. | Keep the huddle ended; do not dispatch a conclusion or release a hold. Stop does not wait indefinitely for a provider that ignores abort. |
| Stop after runner interruption left a huddle and reservation outstanding | Retain its durable estimated charge and mark it settled; release process-local unused allowance. | Recover the unfinished micro-huddle as `NO_OUTCOME` and route. Preserve holds. |
| Missing seats, no available allowance, budget exhaustion between turns, disagreement or unusable outcome | Charge calls already dispatched; release unused allowance. No charge for calls never dispatched. | Route to the orchestrator. Any hold already acquired stays until explicit resolution. Initial unfunded firing retains the existing notification and nonblocking routing policy. |
| Agreement commits before Stop | Keep settled usage; release unused allowance. | Agreement resolves only its own escalation and hold. Stop then follows the worker Stop lifecycle and may raise its own blocker. |
| Stop commits before agreement | Settle or retain calls as above; release unused allowance. | The resolution transaction refuses agreement, concludes `NO_OUTCOME`, and routes. Preserve every existing hold. |
| Free local call is stopped or fails | No paid reservation or charge. | Route the unresolved huddle and preserve any hold. |

Holds belong to escalation ids, not to the huddle process or the agent's lifetime. Stop never emits an unscoped unblock. A fallback hold is released only by explicit resolution of that escalation (or its existing explicit withdrawal through contract amendment); other dissent holds, Stop blockers, dependencies and needs survive. Submitted, checking and merging tasks keep their pipeline state while held. Notifications and the existing orchestrator/lead fallback policy remain in force.

## 6. Events and reducer

Add these events to `EventPayloads` and `EVENT_TYPES` in `src/execution/types.ts` and to the shapes table in `src/execution/events.ts`:

| Event | Payload | Meaning |
|---|---|---|
| `dissent.tripwire_fired` | `dissent_id, task?, tripped_by, evidence, generation?, notified?, orchestrator_woken?` | Records the matching dissent, affected task if any, observed evidence, predicate generation and delivery disposition. Optional fields preserve replay of older logs. |
| `dissent.scored` | `dissent_id, outcome: vindicated / refuted / untested` | Records the orchestrator's assessment of the prediction. |

Keep evidence bounded, scrubbed and sufficient to identify the matched check, path or task state. Reuse event causation and correlation to connect the firing, directive, escalation and huddle. Use the normal transaction path so the firing marker and its required notification are durable together.

Add `state.dissents` to `BlackboardState` and initialize and reduce it in `src/execution/blackboard.ts`. It must expose the contract's dissent definitions, fired keys and evidence, links to the associated escalation/huddle, and the latest recorded score. Huddle outcomes come from the existing huddle events; they are not a second, independently maintained verdict.

The reducer remains pure and deterministic. Contract adoption supplies dissent definitions from resolved contract blobs. New firing and scoring events update the projection, and older logs without dissents produce an empty dissent section. Preserve runtime records for unchanged predicates across contract amendments. Removed dissents are pruned from the current projection; their unresolved escalations are withdrawn and their own holds released. The amendment tool always appends `escalation.withdrawn` for an unresolved removed dissent and includes removed dissent ids in the amendment audit. It appends a source-specific `task.unblocked` only when the affected task exists and is nonterminal; a task cancelled by an earlier amendment stays cancelled. Withdrawal also appends correlated `execution.resumed` events for human-action pauses owned by the removed escalations, including dependent-task scopes. Compute ownership from pause/resume events, treating all escalations withdrawn in the same amendment as released while preserving overlapping manual and other unresolved-escalation pauses.

The initial WS16 reducer version was 6. Version 7 added source-specific holds, pipeline-safe pauses, amendment generations and delivery records. Version 8 made replay release resolved escalation holds even in historical retry/reassignment logs without an explicit unblock. `REDUCER_VERSION` is now 10, combining those semantics with WS15 per-agent usage and Stop state; version 9 is reserved for another workstream. The store rejects older snapshots and rebuilds the projection from the event log. Do not rewrite historical events or add a separate mutable store for runtime dissent state.

## 7. Scoring

Add an orchestrator tool to set a dissent's outcome by emitting `dissent.scored`:

- `vindicated`: the available evidence supports the predicted failure.
- `refuted`: the available evidence contradicts the prediction.
- `untested`: the run did not establish an outcome.

The per-persona record is advisory and display-only. It must never weight votes, alter consent thresholds or change routing authority. A fired tripwire does not automatically mean `vindicated`, and an unfired one does not automatically mean `refuted`. Before scoring, display the absence of an assessment rather than manufacturing an event.

WS16 supplies the event, projection and explicit scoring tool. WS14 later connects postmortem findings to this scoring path.

## 8. Dashboard

Add a **Dissents** page in `src/dashboard/render.ts`, a `PageKey`, a `NAV` entry, the appropriate live-update behavior and a route in `src/dashboard/server.ts`.

For each dissent, show the dissenter, claim, predicted failure, source, tripwire, response policy, armed or fired status, huddle outcome when present, and score. For a dissent that fires on multiple tasks, retain the task association so the evidence and huddle outcome are understandable.

Render every dynamic value through the existing `t()` helper, including claims, evidence, provenance and outcome labels. Dissent content remains escaped data. The page reads the blackboard projection and existing escalation/huddle state; it does not run predicates or set scores itself.

## 9. User documentation

The implementation adds `docs/dissents.md` with filing examples, the three predicates, freeze requirements, response policies, scoring semantics and the budget fallback. Link it from the escalations section of `docs/heads-down.md` and add one short index entry to `README.md`. Keep the detailed workflow in `docs/`.

This design document is the first WS16 artifact. The user guide, index links and implementation changes belong to the workstreams below.

## 10. Workstream split

| Workstream | Issue | Scope | Dependencies |
|---|---|---|---|
| WS16a | #139 | Contract types, normalization, limits, reference validation, hashing coverage and Markdown rendering; define the event payloads and dissent projection contract. | Establishes the shared schema used by the other workstreams. |
| WS16b | #140 | Draft filing tool, `dissented` consent resolution, unsigned ultraplan imports, debate/waffle house tagged summaries, safe parsing and freeze/excusal handling. | Uses WS16a's schema and validation. |
| WS16c | #141 | Event validation and reducer implementation, version bump, pure watchdog rule, durable deduplication, notifications, huddle routing, pause behavior and budget fallback. | Uses WS16a's schema and produces the runtime state consumed by WS16d. |
| WS16d | #142 | Orchestrator scoring tool, advisory persona display, Dissents page and route, user guide, README index entry and heads-down guide link. | Uses the schema and event/reducer interfaces from WS16a and WS16c. |

Each implementation workstream adds or adjusts unit tests in `test/unit/*.test.mjs`, runs `npm run build`, and runs the specific test files it touches with `node --test` using the repository's test environment fixture where needed. The design-document task itself changes only this file.

### Verification requirements for implementation

| Area | Required coverage |
|---|---|
| Contract | Empty default, response-policy default, count and text limits, malformed shapes, duplicate ids, missing participants/checks/tasks, unsafe paths, hashing and rendered dissents. |
| Filing | Draft-only authorization, objector consent with retained dissent, version-bound resolution, imported `OBJECT` sign-offs, incomplete-draft freeze refusal and explicit excusal. |
| Summary parsing | Valid author-owned tags; spoofed tags inside backtick fences, tilde fences and blockquotes; invalid structured content. |
| Events and replay | Both event validators, malformed payload rejection, empty state for older logs, deterministic replay, snapshot invalidation and durable fired keys. |
| Watchdog | All three predicates, task filters and taskless checks, no match, repeated evaluation/restart deduplication, multiple matching tasks and evidence selection. |
| Notification and huddles | Directive delivery, scrubbed and fenced text, dissenter/requester identity, tripper/counterpart identity, `DISAGREED` routing, budget fallback and task block/resolution behavior. |
| Scoring and dashboard | Authorized scoring and replay, all outcomes, absence of automatic scoring or voting effects, page navigation/route, armed/fired state, huddle outcome and escaped malicious text. |
