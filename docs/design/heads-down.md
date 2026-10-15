# Heads-down execution: design

Status: approved for 1.0.0. Tracking issue #9. This document is the spec every 1.0 workstream builds against. If an implementation needs to diverge from it, update this file in the same pull request.

## 1. Two modes

The roundtable has two modes.

**At the table** is the umbrella for the turn-by-turn formats that already exist: meeting, local meeting, collaboration (collaborate, debate, waffle-house, conversation), ultraplan, agent workshops and prototype mode. The phrase is always used together with a format, as in "a debate at the table". It never replaces the format names.

**Heads-down** is the new execution mode, and one session of it is a *heads-down run*. A session at the table produces a **contract**. Every participant agrees to it, and then an **orchestrator** freezes it. When the human says "execute", workers build in parallel and stop needing the human. Agents never talk to each other during a run. They coordinate only through:

- the **event log**: append-only, hash-chained, readable by any agent or team;
- the **blackboard**: shared state derived from the event log;
- **claims** on tasks and **leases** on paths.

A blocked agent **escalates** into a **huddle**. A huddle runs a real format: a micro-huddle (2 turns), a meeting, a collaboration, a debate, a waffle house, or a re-plan through ultraplan. The orchestrator picks the format. The **watchdog** enforces budgets, expires leases, and catches stalls, loops and deadlocks. It resolves what it can on its own and escalates the rest.

Naming rules: huddle, watchdog and blackboard are lowercase common nouns. "Blackboard" is never shortened to "board", because "board" already means the prototype board. Code enums use `deliberation` and `execution`. Human-facing labels are kept in `src/tools/names.ts`.

## 2. Processes

All three processes run from `dist/index.js`. `src/cli.ts` dispatches the subcommands. Without arguments, the binary is the MCP stdio server, exactly as before.

| Process | Started by | Holds secrets | Lifetime |
|---|---|---|---|
| Orchestrator server (`agent-roundtable`) | The MCP host, such as Claude Code's main chat | Provider keys from `.env` | The chat |
| Runner (`agent-roundtable run <exe>`) | `execute`, `control_execution resume`, `ensureRunner`, or by hand | Provider keys (for huddles, consent and the lead) plus git and gh credentials | Until the run ends, or 6 h after it is paused |
| Worker server (`agent-roundtable mcp --worker --execution <exe> --agent <id> --token-file <p>`) | Each worker, through the `--mcp-config` the runner generates for it | **None** (`ROUNDTABLE_DOTENV=off`) | One worker run |

**Where LLM calls happen.** Only in the orchestrator server and the runner, never in a worker server.

**How the runner starts.** `spawn(process.execPath, [cli, "run", id], {detached: true, stdio: ["ignore", log, log], cwd: repoRoot}).unref()`. Because it is detached, it survives the MCP host killing the server's process group. The stdio server's shutdown never touches runners.

**Runner ownership.**
- The runner creates `runner.lock/` with `mkdir` and writes `runner.json {pid, host, startedAt, heartbeatAt, version}` atomically every 5 s.
- A runner counts as stale when its pid is dead on the same host or its heartbeat is older than 30 s.
- A runner on a different host is refused: 1.0 supports one host per home directory.
- Takeover renames the lock, removes it, takes a new lock, and emits `runner.takeover`.
- Every orchestrator tool that touches a live run calls `ensureRunner(id)`.

**Permissions.** Heads-down subcommands (including `mcp --worker` and `hook`) call `process.umask(0o077)`. The orchestrator keeps the host umask; private state uses explicit modes from `fs-safe.ts`.

## 3. Store

Everything lives under `~/.agent-roundtable/` (override with `ROUNDTABLE_HOME`). Directories are 0700 and files 0600.

```
audit/audit-YYYY-MM.jsonl            global hash-chained security audit (the chain carries across months)
audit/audit-anchor.json              where the chain starts after a retention prune
sessions/<id>.json                   archived at-the-table sessions (e.g. finalized ultraplans)
executions/<exe>/
  execution.json                     immutable header {id, schema: 1, repo_root, base_sha, agents_dir, created}
  events.jsonl                       append-only, hash-chained
  events.lock/  runner.lock/  git.lock/
  snapshot.json                      {reducer_version, seq, offset, hash, state_sha256, state}; written only by the runner, every 500 events or 60 s
  runner.json  runner.log
  contracts/<ctr>/v<N>.json  CONTRACT.md
  blobs/sha256/ab/<hash>             diffs, outputs, huddle turns, prompts (secrets redacted before writing)
  agents/<agent>/{mcp.json, settings.json, prompt.md, token, token.used, leases.json, inbox.cursor, heartbeat, runs/<attempt>.jsonl}
  watch/<orchestrator>.json          watcher liveness and cursor
  dashboard.json  github.json
worktrees/<exe>/<task>/  worktrees/<exe>/_integration/
```

Branches are named `rt/<exe6>/<task>` and `rt/<exe6>/integration`, where `exe6` is the first 6 characters of the execution ID's random part.

**IDs** (`src/ids.ts`):
- `newId(prefix)` gives the prefix plus 8 characters of Crockford base32 from `randomBytes`.
- Executions are `exe-<10 time chars><6 random chars>`.
- Contracts are `ctr-<exe6>-<n>`.
- At-the-table sessions keep their prefixes (`meeting-`, `local-`, `collab-`, `ultraplan-`, `create-`, `improve-`) but get random suffixes.

**Writes** all go through `store.transact(fn)`:
1. Take the `mkdir` lock `events.lock/`, which holds `owner.json {pid, host, token, at, started}`, where `started` is the holder process's start time. Waiting uses backoff from 5 ms up to 5 s.
   - A lock is **never taken from a live holder**, however long it is held. A holder stalled by a GC pause, swap, SIGSTOP or a suspended laptop must not wake up next to a second writer. Waiters time out with `LockTimeoutError` instead: safety beats liveness.
   - A lock is cleared only when its owner is known to be gone: its pid is dead on this host; or the pid is alive but `started` differs, meaning the pid was reused (checked with `ps` once the lock is older than 10 s); or `owner.json` is missing or unreadable 10 s after the directory was created.
   - A lock owned by another host is never cleared, because 1.0 supports one host per home directory.
   - Clearing is an atomic rename aside. `owner.json` is published with `link(2)`, so the lock fails closed on filesystems without hard links. A lock never recreates a missing parent directory, such as a purged execution.
2. Replay the projection up to the tail.
3. `fn(state)` validates against that fresh state and returns event drafts.
4. Append with `O_APPEND`, then `fsync`.
5. Unlock.

Writes are therefore serializable across processes.

Details of `transact` (`src/execution/store.ts`):
- All of `fn`'s drafts are validated and their contract blobs resolved. The batch is then reduced on a copy of the state in strict mode, which throws on an invalid task transition. Only a batch that reduces cleanly is written, so no event that would break replay reaches the log.
- A transaction's events are one **batch**. They are appended with one write, and when there is more than one, each carries `batch: {n, i}`. Readers apply a batch only once all n lines are complete. A failed or partial write is truncated back before the error is rethrown. A crash mid-write leaves an incomplete batch that no reader applies.
- `fn` should be quick, since other writers wait for it. Slow work, such as an LLM call, happens outside `transact`. Just before writing, the store checks that `owner.json` still carries its token and that the log has not grown. If either check fails, it throws and writes nothing.
- A writer holding the lock truncates a torn line or an incomplete batch at the end of the log. A live holder is never displaced and checks `held()` right before writing, so under the lock no live writer can be mid-append, and those bytes are a dead writer's.
- Durability: files are fsynced. When a file is created or renamed into a directory, that directory is fsynced too (best effort). A blob therefore survives power loss whenever an event that references it does.

**Reads** take no lock. They tail from a byte offset and ignore a trailing partial line or incomplete batch. A complete line that does not parse, breaks the seq or `prev` chain, or breaks batch framing throws. `verify` accepts an incomplete batch only at the end of the log.

**Resume** reconciles in this order:
1. Verify the chain.
2. Load the snapshot and replay the tail.
3. Workers whose pid is still alive are adopted. Their stdout goes to a file, not a pipe, so the new runner can tail it.
4. Dead workers have their worktree WIP committed (`rt: wip snapshot`) and are respawned with `--resume <session>` and an "interrupted" card. If the session is gone, a fresh worker starts and gets the WIP diff stat.
5. Lease TTLs restart.

The **task owns its branch and worktree**, and agents come and go. That ownership is what lets a resumed run pick up where it left off.

## 4. Event envelope

```ts
export interface EventEnvelope<T extends EventType = EventType> {
  v: 1;
  id: string;                 // evt-…
  seq: number;                // gap-free, starts at 1
  ts: string;                 // ISO 8601 UTC
  execution: string;
  contract?: string;
  contract_version?: number;
  mode: "deliberation" | "execution";
  source: { kind: "orchestrator" | "agent" | "runner" | "watchdog" | "human" | "system"; id: string; team?: string; task?: string; pid: number };
  type: T;
  payload: EventPayloads[T];
  causation?: string;         // event id that caused this one
  correlation?: string;       // e.g. escalation id, task attempt id
  batch?: { n: number; i: number }; // set by the store on each event of a multi-event transaction
  prev: string;               // hash of the previous event ("0"*64 for seq 1)
  hash: string;               // sha256(prev + canonicalJSON(envelope without hash))
}
```

- Free-text payload fields pass through `scrub` (`src/security/secrets.ts`) before hashing. Identifiers, refs and paths are stored as given.
- Payloads whose canonical JSON exceeds 8 KB are refused. The caller stores the large content with `putBlob` and puts the `sha256:<hex>` ref in the payload.
- Each type has a small validator in `src/execution/events.ts`. Unknown types, unknown fields and wrongly typed fields are rejected.
- `canonicalJSON` sorts keys recursively and has no whitespace. It rejects values that do not survive a JSON round trip, such as non-finite numbers.

## 5. Event catalog

| Type | Payload |
|---|---|
| `execution.created` | repo_root, base_sha, contract, contract_version |
| `execution.started` | confirmation, visibility, budget, lead, sandbox, drivers |
| `execution.paused` / `execution.resumed` | scope: "all" or task_ids, reason |
| `execution.steered` | message, targets |
| `execution.mode_changed` | from, to, reason, session? |
| `execution.completed` | integration_sha, pr_url? |
| `execution.failed` / `execution.aborted` | reason |
| `contract.proposed` | contract, version, source, blob, reason?, patch_blob? (both set when a draft is amended: see §8) |
| `contract.consent_requested` | participants, round?, hash?, host? (round id, consentHash of the version asked, owner host: see §8) |
| `contract.consent_recorded` | agent, verdict, reason, round? (an answer naming any other round is ignored) |
| `contract.objection_resolved` | agent, how: amended / withdrawn / excused, reason |
| `contract.frozen` | by, hash, blob (the full contract at this version) |
| `contract.amended` | version, patch_blob, reason, affected_tasks, blob (the full contract at the new version) |
| `contract.superseded` | by_contract |
| `runner.started` | pid, version |
| `runner.takeover` | previous_pid |
| `runner.stopped` | reason (heartbeats are files, never events) |
| `agent.registered` | agent, persona, team, driver, token_sha256, external |
| `agent.spawned` | task, attempt, pid, session_id |
| `agent.attested` | tools, mcp_servers, ok |
| `agent.exited` | code, reason, result_subtype, usage, paused (the pause it stopped for: not counted against max_attempts) |
| `agent.left` | reason |
| `task.ready` | task |
| `task.claimed` | task, agent, attempt, ttl_s |
| `task.released` | task, note |
| `task.progress` | task, percent?, note |
| `task.submitted` | task, commit, diff_blob, stat, files, rewrites |
| `task.checks_passed` | task, commands, commit?, submitted_seq? |
| `task.rejected` | task, reasons, violations? |
| `task.merged` | task, integration_sha |
| `task.accepted` | task |
| `task.blocked` | task, escalation? or deps? |
| `task.unblocked` | task |
| `task.retried` | task, attempt, why |
| `task.reassigned` | task, from, to |
| `task.split` | task, into |
| `task.failed` | task, why |
| `task.cancelled` | task, why |
| `lease.granted` | lease |
| `lease.queued` | request, blocking |
| `lease.released` / `lease.expired` | lease_id |
| `lease.revoked` | lease_id, by, reason |
| `lease.violation` | task, paths |
| `artifact.published` | name, kind: interface / design / doc, path?, blob, task |
| `artifact.changed` | name, version, consumers |
| `dependency.requested` | task, need: {kind, ref} |
| `dependency.satisfied` | task, need, by_event |
| `check.started` | command_id, scope: task / integration, task?, commit?, submitted_seq? |
| `check.passed` | command_id, scope, task?, duration_ms, commit?, submitted_seq? |
| `check.failed` | command_id, scope, task?, exit, signature, output_blob, commit?, submitted_seq? |
| `check.timed_out` | command_id, scope, task?, commit?, submitted_seq? |
| `command.completed` | task, argv, exit, duration_ms, signature, output_blob |
| `merge.succeeded` | task, sha |
| `merge.conflicted` | task, files |
| `note.posted` | topic, text, refs (broadcast only; there is no addressee) |
| `decision.recorded` | scope, text, rationale, supersedes?, by |
| `directive.issued` | id, to: agents / teams, text, requires_ack |
| `directive.acknowledged` | id, agent |
| `escalation.raised` | id, task, kind, with, target?, summary, question?, options?, diagnostics_blob?, blocking, emergency? |
| `escalation.routed` | id, to, format?, wake |
| `escalation.auto_resolved` | id, rule |
| `escalation.resolved` | id, action, decision, by |
| `escalation.awaiting_human` | id, class: money / credentials / scope / human_action |
| `escalation.withdrawn` | id, reason |
| `huddle.started` | id, escalation, format, seats |
| `huddle.turn` | id, seat, blob |
| `huddle.concluded` | id, outcome, decision? |
| `budget.usage_recorded` | agent?, task?, source: worker / huddle / consent / lead, model, tokens, usd, estimated |
| `budget.threshold_crossed` | pct, spent_usd, budget_usd (the total, extensions included, that pct refers to) |
| `budget.exhausted` | scope: execution / task / agent, ref? |
| `budget.extended` | by, usd |
| `watchdog.action` | rule, action, target |
| `watchdog.circuit_opened` | driver, reason, until, opens? (consecutive opens since the last close) |
| `watchdog.circuit_closed` | driver |
| `watchdog.deadlock_detected` | cycle |
| `watchdog.stall_detected` | agent, task |
| `sandbox.degraded` | backend, reason |

## 6. Blackboard

The blackboard is a pure reducer, `apply(state, event) → state`, in `src/execution/blackboard.ts`. Every process computes the same state from the same log. It has these sections:

| Section | Contents |
|---|---|
| `contract` | Current frozen version plus amendments |
| `goal` | The ultimate goal |
| `interfaces` | By name, with version and owner |
| `decisions` | Recorded decisions |
| `tasks` | TaskRuntime per task |
| `claims` | Active task claims |
| `leases`, `lease_queue` | Granted leases and waiting requests |
| `files` | path → {task, agent, last_commit, merged} |
| `diffs` | Latest per task: stat and blob |
| `checks` | [scope][command] → {status, signature, streak, since_patch_seq, blob} |
| `escalations`, `huddles` | Open and resolved |
| `agents`, `teams` | Registered agents and team membership |
| `budget` | Totals by agent, task, team and execution; thresholds crossed for the current total (`thresholds_budget_usd`) |
| `notes` | Broadcast notes |
| `inbox` | Per-agent directives and decisions |
| `watchdog` | Circuits (`open`, `until`, `reason`, `opens`; a closed circuit keeps the end of its last open period in `until`) and deadlocks |

The human's chat is never stored on the blackboard.

**How the contract reaches the reducer.** `contract.frozen` and `contract.amended` carry `blob`: the full contract JSON at that version, stored with `putBlob(scrubbedJSON(contract), {redact: false})`. Before calling `apply(state, event, resolved)`, the store reads that blob, checks its hash, and passes the parsed contract in as `resolved.contract`. The reducer never touches the disk, and because blobs are content-addressed, every process resolves the same bytes. A frozen or amended event without a resolvable, matching blob is refused at write time. `contract.proposed` leaves the blackboard unchanged, since `contract` holds only frozen versions. The `contracts/<ctr>/v<N>.json` files are for people and tools; the reducer does not read them.

**Reducer semantics** (`src/execution/blackboard.ts`; each handler is documented there):
- Unknown types throw. An event that names a task, agent, lease or escalation the state does not know changes nothing for that part.
- Freezing or amending sets `contract` and `goal` and merges teams, interfaces and decisions. Tasks are created `pending`, and become `ready` once all their dependencies are `accepted`. An amendment keeps existing tasks' runtime state, and the amending tool cancels removed tasks explicitly.
- `task.merged` (and `task.accepted`) accepts the task, drops its claim and promotes dependents. Pausing never changes task states; it only fills `paused_tasks`.
- `checks.task` is keyed `<task>/<command_id>` and `checks.integration` by command id. `task.submitted` resets that task's streaks only when its `diff_blob` differs from the task's previous submission (resubmitting the same diff is no patch), and `task.merged` resets the integration streaks. `budget.threshold_crossed` for a new `budget_usd` starts a new list.
- `raised_seq`, `granted_seq` and `requested_seq` are set from the event's seq, whatever the payload says.
- `blocked_by.needs` lists a task's open interface and artifact needs: `dependency.requested` adds one and `dependency.satisfied` removes it (task needs are `deps`). `task.blocked` on a task that is already blocked keeps its other reasons: a new escalation replaces the old one, deps are added, and open needs are always kept. `task.unblocked` clears them all.
- A task check that carries `submitted_seq` counts only while that is the task's latest `task.submitted`; a stale one changes nothing. A `task.checks_passed` that carries `submitted_seq` is refused unless it names the latest submission and commit and the task is still `submitted` or `checking`.
- Task events are checked against the task's state. On the write path, which uses strict mode, an event that names an unknown task, or that would move a task out of `accepted`, `failed` or `cancelled`, is refused before append. The exceptions are a retry or cancel of a failed task, and a merge or accept of an accepted one, which does nothing. Replay ignores such events, so an old log never breaks.
- `task.split` records `splits[task] = parts`. Whenever a contract version is adopted, dependencies on a split task are rewritten to its parts, recursively.
- Task and command ids match `^[a-z0-9][a-z0-9._-]{0,63}$` in payloads and contracts, so the `/` in a check key is unambiguous.
- `contract.amended` marks the contract `frozen` and keeps the earlier freeze record unless the blob carries one.
- Snapshots record `REDUCER_VERSION` (now 4) and a sha256 of the canonical state. Bump the version whenever `apply` would produce a different state from an existing log. A snapshot with another version, or whose state does not match its digest, is ignored, and the log is replayed.

## 7. Contract

```ts
export interface Contract {
  schema: "roundtable.contract/1";
  id: string; version: number;
  status: "draft" | "consenting" | "frozen" | "superseded" | "closed";
  title: string;
  goal: { ultimate: string; original_prompt: string; artifacts: ArtifactRef[]; source_session?: string };
  scope: { orchestrator: string; parent?: { contract: string; task: string }; repo_root: string; base_ref: string; paths: string[] };
  participants: Array<{ agent: string; role?: string; team?: string }>;
  teams: Array<{ id: string; lead?: string; members: string[] }>;
  tasks: TaskSpec[];
  interfaces: InterfaceSpec[];
  decisions: Decision[];
  validation: { commands: CommandSpec[]; final: string[] };
  budget: { usd: number; per_task_usd: number; per_agent_usd?: number; wall_clock_min: number; max_parallel: number; max_attempts: number };
  authority: { lead: string; may: Array<"retry" | "reassign" | "split_task" | "add_task" | "amend_interfaces" | "extend_budget" | "resolve_merge">; budget_extension_pct: number };
  sandbox: { backend: "docker" | "local"; image: string; install?: { argv: string[]; egress: string[] } };
  workers: { driver: "claude-code" | "codex"; model?: string; fallback_model?: string };
  consent: Array<{ agent: string; verdict: "AGREE" | "OBJECT" | "UNCLEAR" | "EXCUSED"; reason?: string }>;
  frozen?: { by: string; at: string; hash: string };
}
export interface TaskSpec {
  id: string; title: string; team?: string; persona: string; kind: "build" | "subcontract" | "review";
  depends_on: string[]; paths: { write: string[]; read?: string[] };
  acceptance: string[]; checks: string[]; effort?: "low" | "medium" | "high"; budget_usd?: number; context?: ArtifactRef[];
}
export interface CommandSpec { id: string; argv: string[]; cwd?: string; timeout_s: number; env?: Record<string, string> }
```

**Validation** (`src/execution/contract.ts`):
- IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- `depends_on` forms a DAG, checked with Kahn's algorithm; the error names the cycle.
- Write globs are relative and normalized, with no `..`, no NUL and no absolute paths, and they sit inside `scope.paths`.
- `argv` is non-empty strings. `sh|bash|zsh|dash -c` is rejected on the local backend and warned on docker.
- No `env` key may match `/KEY|TOKEN|SECRET|PASS/i`.
- Budgets are greater than 0.
- A child contract must fit inside its parent task's paths and budget.
- The task id `integration` is reserved, because `rt/<exe6>/integration` is the integration branch.
- Every task persona is a participant: a persona missing from an explicit `participants` list is added, with a warning.
- A structure without a budget gets a placeholder budget ($20 total, $5 per task, 120 min), with a warning; `execute` asks the human for the real cap.
- A task's `budget_usd` may not exceed `budget.per_task_usd`. A child contract may have at most `min(parent task budget_usd ?? parent per_task_usd, parent remaining budget)`, and that cap is shared with the task's other child contracts.
- Env names are checked against `CONTRACT_SECRET_ENV_RE` (`KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE|SESSION|(^|_)PAT$|DATABASE_URL|DSN`, broader than `SECRET_NAME_RE`), and a value that scrubbing would change is refused, so the stored command is always the validated one.
- `sudo`, `doas`, `su`, `pkexec` and `run0` anywhere along a command's wrapper chain are refused on every backend. Shell detection (`isShellCommand`) follows wrapper chains and matches lowercased basenames; it is a hygiene signal, not the boundary (the sandbox is, and `node -e` exists).
- A wildcard egress host needs two labels after `*.` (no `*.com`). Glob lists (`paths.write`, `paths.read`, `scope.paths`) hold at most 64 entries.

**Defaults:**
- `budget.max_parallel`: 3
- `budget.max_attempts`: 3
- `authority.budget_extension_pct`: 0
- `authority.may`: `["retry", "reassign", "resolve_merge"]`
- Sub-orchestration depth: at most 2

## 8. Contract lifecycle

**Proposing.** `propose_contract` takes its structure from the first source available:
1. An explicit `contract` object. This is the most reliable route and the one the main chat should use.
2. A fenced ```` ```roundtable-tasks ```` JSON block in the plan or archived session. For an ultraplan only its plan versions are searched, latest first, never the document or entries (a participant's input or sign-off may quote a block). Other sessions: the summary and orchestrator turns first, then agents' turns, with a warning.
3. A structuring LLM call, run as `extractJsonObject` → validate → one retry with the errors included. This mirrors the agent-creation architect. Falling back to it for an ultraplan whose plans have no block is warned about, as is proposing from an ultraplan that was not signed off.

**Ultraplan support.** `start_ultraplan` gains `execution_ready`.
- When it is set, planner draft and revise prompts require the fenced block, and sign-off prompts ask participants to check it.
- `signedOff` becomes true only when there are no OBJECT and no UNCLEAR votes.
- `finalize` archives the session to `sessions/<id>.json`.
- The tool result gains a JSON trailer `{ultraplan_id, archived, tally}`.

**Consent.** `runVerdictRound(agents, prompt, label, options)` is extracted into `workshop.ts` and shared with ultraplan sign-off.
- Each participant answers `Consent: AGREE | OBJECT`.
- An UNCLEAR answer is re-asked once with a stricter prompt; if it is still unclear, it is recorded as UNCLEAR and counts as an objection.
- **A verdict counts only for the version it was given on.** Each verdict carries that version and the `consentHash` of what was asked (`contractHash` without `status`, so a draft and its freeze match). An answer on an older version is *stale*: it needs re-consent or an excusal.
- Rounds carry an id. `contract.consent_requested` gains optional `round`, `hash` and `host` (the owner's pid is the event source's), and `contract.consent_recorded` gains optional `round`. The request is recorded in its own transaction (refused while another round is in flight), the calls run outside any transaction, and the answers are recorded together, but only while their round is still current and the version unchanged; otherwise they are dropped with a warning. The first answer per participant in a round wins, on replay too.
- A round run by another process counts as in flight for at most `CONSENT_ROUND_STALE_CAP_MS` (10 minutes), and not at all once its owner pid is dead on this host. Its missing answers then count as UNCLEAR. `freeze_contract {abandon_round: true}` lets the orchestrator record them as UNCLEAR at once (they still need excusing); this is audited as `contract.consent_round_abandoned`.
- An objection is resolved by amendment when the objector is re-asked on the amended version and agrees (`contract.objection_resolved{how: "amended"}`), and withdrawn when they agree on the same version.

**Freezing.** `freeze_contract` takes an `orchestrator` name, and only the contract's orchestrator can freeze. It refuses, listing every reason, when:
- a participant has no AGREE on the current version: no answer, a stale answer, an objection or an UNCLEAR. Each can be excused with a reason; excusals are audited;
- the source session is busy, or a consent round is in flight;
- for a child contract: the parent is not frozen, or the caller is not the parent task's persona or the parent's orchestrator.

The hash is taken over the scrubbed contract (what the blob stores) and goes to the audit log.

**Amending.** An amendment is an RFC 7396 merge patch that produces v(N+1).
- `affected_tasks` is computed by diffing task specs, interface owners and consumers, and the commands tasks check with.
- Who may amend: without an authority list, the contract's orchestrator (or a child's parent orchestrator); with one (the lead fallback), only `authority.lead`, and only with actions inside `authority.may`.
- **Drafts.** The reducer marks every `contract.amended` frozen, so amending a contract that is not frozen yet records `contract.proposed` for v(N+1) instead, with `source: "amendment"`, the `reason` and the `patch_blob`. Every participant agreed to the old draft, not this one: `consent: true` asks them all again, and the freeze needs their AGREE on v(N+1).
- **Frozen contracts** get `contract.amended`, whose blob carries its own freeze record and hash (also audited), `task.cancelled` for removed tasks, and a `directive.issued` telling the agents of affected tasks to re-read the contract. A change to a run-wide field (`budget`, `scope`, `sandbox`, `authority`, `validation`, `workers`, `goal`) by the orchestrator needs everyone's consent first: with `consent: true` every participant is asked about the candidate version, which is applied only if all agree; `override_consent: true` applies it without, audited as `contract.consent_overridden`; without either it is refused. A task-level change applies at once, and `consent: true` then asks the personas of the affected tasks. A lead's change within its authority was consented to as part of the authority and needs no round.
- **The lead's authority** is default-deny over every field: `add_task` for new tasks, `reassign` for persona or team changes (either may bring the new persona in as a participant, if it resolves through `loadAgent`), `amend_interfaces`, and `extend_budget` for budget and time increases up to `budget_extension_pct` above the budget first frozen. Removing tasks, decreases and new caps, and anything else are reserved to the orchestrator.
- **Affected checks** are not marked stale on the blackboard: `contract.amended` lists `affected_tasks`, the directive tells their agents, and the runner (WS08) re-runs those tasks' checks on their next submission.
- An empty patch with `consent: true` makes no new version and only asks the participants without an AGREE on the current version.

## 9. Workers

```ts
export interface WorkerDriver {
  readonly id: "claude-code" | "codex" | "external";
  detect(): Promise<{ ok: boolean; version?: string; missing: string[] }>;
  launch(l: WorkerLaunch): Promise<WorkerHandle>;
  resume(rec: WorkerRecord, l: WorkerLaunch): Promise<WorkerHandle>; // l: fresh files, budget, card, output path
  parse(line: string, acc: RunAccumulator): void;
  stop(h: WorkerHandle, reason: string): Promise<void>;
  answer?(rec: WorkerRecord, question: string, maxUsd: number, signal?: AbortSignal): Promise<{ text: string; usage?: UsageRecord }>;
}
```

The drivers live in `src/workers/` (WS07): `claude-code.ts`, `codex.ts`, the generated files in `files.ts`, the lease hook in `hook.ts`, token consumption in `token.ts`, process groups in `process.ts`, and `RunMonitor` in `monitor.ts`. A worker is spawned detached in its own process group, with cwd set to the task worktree and stdout and stderr appended to `runs/<attempt>.jsonl` (0600), so a restarted runner can adopt it and keep tailing. `stop` sends SIGTERM to the group, then SIGKILL after 10 s.

### Claude Code invocation

`buildWorkerArgs` is a pure function with a snapshot test. The worker runs with cwd set to the task worktree. It gets **no positional arguments**, because several of the flags are variadic; the task card goes in on stdin.

```
claude -p --output-format stream-json --verbose
  --session-id <uuid> | --resume <uuid>
  [--model <m>] [--fallback-model <f>] [--effort <e>]
  --append-system-prompt-file agents/<id>/prompt.md
  --mcp-config agents/<id>/mcp.json --strict-mcp-config
  --settings agents/<id>/settings.json
  --restricted --tools Read,Edit,Write,Glob,Grep
  --allowedTools "Read Edit Write Glob Grep mcp__roundtable"
  --disallowedTools "Bash WebFetch WebSearch Task Agent"
  --permission-mode dontAsk --permission-prompts none
  --max-budget-usd <min(task remaining, execution remaining)>
  --disable-slash-commands --no-chrome
```

Flags deliberately left out:
- `--bare`, because it skips hooks, and the lease hook depends on them.
- `--max-turns`, because it is not listed in the CLI help.

Preflight (`detect()`) parses `claude --help` once per binary (failures expire after 60 seconds) and refuses to run when a required flag is missing. CLI 2.1.300 lists `--append-system-prompt-file` only as `--append-system-prompt[-file]`, and preflight accepts either spelling. `--model`, `--fallback-model` and `--effort` are optional capabilities: a CLI without one runs without it, with a warning.

Checked against a live 2.1.300 run:
- `--restricted` drops the user's and the project's settings, hooks, plugins and agents, while `--settings` still applies, so the lease hook fires.
- `system/init` lists exactly `Edit, Glob, Grep, Read, Write` plus the `mcp__roundtable__*` tools, with `roundtable` connected.
- `--tools ""` leaves no built-in tool.

**Micro-huddle answers** (`answer`) run in the worker's worktree, where its session lives:

```
claude -p --resume <session> --fork-session --output-format json --restricted --tools ""
  --strict-mcp-config --disallowedTools "mcp__*" --permission-mode dontAsk --permission-prompts none
  --max-budget-usd <maxUsd> --disable-slash-commands --no-chrome
```

The question goes in on stdin. The fork gets a new session id and leaves the original transcript byte-identical, which was checked live. The usage is recorded as `source: "huddle"`. Answers accept an `AbortSignal` and retain the tail of stdout so large output cannot displace the final result.

### Generated files

- `mcp.json` defines one server, `roundtable`, with command `process.execPath`. Its args are `[cli, "mcp", "--worker", "--execution", X, "--agent", Y, "--token-file", P]` and its env is `{ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME}`.
- `settings.json`:
  - `permissions.deny`: `Read(./.env*)`, `Read(./**/.env*)`, `Edit(./.git)`, `Write(./.git)`, `Edit(./**/.git)`, `Write(./**/.git)`, `Edit(./.git/**)`, `Write(./.git/**)`, `Edit(./**/.git/**)`, `Write(./**/.git/**)`, `Edit(./.gitmodules)`, `Edit(./**/.gitmodules)`, `Bash`. A `.git` directory is denied at any depth, because a nested repository's config can define filter drivers that host git would run. Claude Code consults `Edit(...)` path rules for every file-writing tool; it accepts `Write(...)` rules but never consults them.
  - `hooks.PreToolUse` with matchers `Edit|Write|NotebookEdit|MultiEdit` and `Read|Glob|Grep`, which runs `"<execPath>" "<cli>" hook pre-tool-use` through `sh -c`. Both paths are double-quoted. A path with a character a shell would interpret inside double quotes is refused when the files are generated.
  - The hook reads `agents/<id>/leases.json`, never the event log or the network. Reads need no lease; recursive searches inspect their subtree for escaping symlinks and secret files and refuse unsafe searches, so workers should scope them to safe directories. It resolves the target through the realpath of its deepest existing ancestor, and refuses a path that contains `..`. It refuses paths starting with `~`, URI or foreign path syntax, and denies when the path:
    - leaves the task worktree, or is itself a symlink;
    - has a `.git` segment at any depth, or names `.gitmodules`;
    - looks like a secret (`.env*`, `*.pem`, `*.key`, SSH keys such as `id_rsa` or `id_ed25519.pub`, `.npmrc`, `.netrc`);
    - is not covered by a live lease of the task (`pathCovered`, including the explicit-lease rule for `.git*`). The message is then `No lease for X: call lease(request) or escalate(with: path_owner)`.

    A deny exits 2 with the reason on stderr, and also prints `hookSpecificOutput.permissionDecision: "deny"` on stdout. Anything unexpected also denies: no identity, no leases file, unreadable input, or a crash. An allow exits 0 silently, so the permission rules still apply.
- `prompt.md` holds the persona body, its skills and the worker protocol.
- `token` holds 32 random bytes as hex. `prepareWorkerFiles` returns its sha256 for `agent.registered`, and every call rotates it.
- `leases.json` is the agent's live leases plus its task and worktree. `writeAgentLeases` rewrites it atomically: the worker server after every lease change it makes, and the runner after it grants or expires leases.

### Environment and identity

**Environment.** `childEnv("claude-worker")` passes:
- PATH, HOME, USER, LOGNAME, LANG, LC_*, TZ, TMPDIR and `TERM=dumb`;
- `CLAUDE_CONFIG_DIR` and proxy/CA variables, when they are set;
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `MCP_TOOL_TIMEOUT=1200000`, `ROUNDTABLE_EXECUTION_ID`, `ROUNDTABLE_AGENT_ID`, `ROUNDTABLE_HOME` and `ROUNDTABLE_DOTENV=off`. Hooks inherit this environment.

`src/env.ts` never loads `.env` for `hook` or for `mcp --worker`, whatever their environment says.

Workers use whatever account the CLI is logged into. `ANTHROPIC_API_KEY` is passed only when `ROUNDTABLE_WORKER_AUTH=api_key`.

**Identity.**
- The runner generates each agent's token immediately before its launch, rather than preparing tokens for all agents ahead of time. It writes a 32-byte token to a single-use file (`prepareWorkerFiles`) and records its sha256 in `agent.registered`.
- The worker server accepts `--token-file` only at `agents/<agent>/token`, so it can never be pointed at another file to read or unlink. The file must be a private regular file of this user.
- The server claims the file with an atomic rename, reads it, unlinks it, and compares the sha256 in constant time with `agents[agent].token_sha256`.
- `token.used` keeps the hash of the last consumed token, so a copy of the token put back cannot start a second server.
- The server refuses to start on a wrong path, a missing, reused or mismatched token, an unknown agent, or a departed one.
- Every event the worker emits is then stamped with `source {kind: "agent", id, task, team, pid}`.
- Tokens rotate on every resume. A worker server whose agent was registered again since it started refuses every call.

**Attestation.** The `system/init` stream line lists the worker's tools and MCP servers.
- `attest(acc)` expects only the five file tools plus `mcp__roundtable__*`, and the MCP servers exactly `[roundtable]`, connected.
- `RunMonitor` tails `runs/<attempt>.jsonl` and drafts `agent.attested` once, then `budget.usage_recorded`, then `agent.exited` with its reason. Usage has `source: "worker"` and is `estimated: false` when the CLI reported a cost; otherwise the tokens are priced from `pricing.ts`. A run killed before its result line records the per-message usage it had seen.
- The runner kills the worker and raises an escalation when attestation fails.

### Other drivers

**Codex** is opt-in with `ROUNDTABLE_ALLOW_CODEX_DRIVER=1`; otherwise `detect()` returns `ok: false` with that reason. Its permissions profile denies the user's home, `ROUNDTABLE_HOME` and the repository checkout, reopens the task worktree for writes and the toolchain and git directory for reads, and disables network access. Codex workers can still read anything outside the denied roots; this is not complete read isolation. Launch refuses while another agent has an unconsumed token file. Invocation:

```
codex exec --json -C <wt> --ignore-user-config --ignore-rules
  -c default_permissions="roundtable"
  -c permissions.roundtable.filesystem={":minimal"="read", …}
  -c shell_environment_policy.inherit=core
  -c shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null",GIT_CONFIG_NOSYSTEM="1"}
  -c approval_policy="never"
  -c mcp_servers.roundtable.command=… -c mcp_servers.roundtable.args=[…] -c mcp_servers.roundtable.env={…}
  -c mcp_servers.roundtable.default_tools_approval_mode="approve"
  [-m <model>] -
```

- Resume uses `codex exec resume --json --ignore-user-config --ignore-rules -c … <thread> -`. `exec resume` takes neither `-C` nor `-s`, so the spawn's cwd is the worktree.
- `prompt.md` goes in front of the task card on stdin, because codex takes no system prompt file.
- The thread id comes from `thread.started`, and usage is summed over `turn.completed`.
- Codex reports no cost and has no budget flag, so its usage is priced from the table and the watchdog enforces its budget.
- Codex keeps its own sandboxed shell, so leases are enforced only when it submits.

**External workers.** `join_execution` returns a one-time `agent_token` and a worktree. External workers are trusted at the level of the host chat and are not sandboxed; their leases are checked when they submit. Their claims have a 15-minute TTL, which every worker tool call renews by rewriting `agents/<id>/heartbeat`.

### Task card

`buildTaskCard(state, taskId, {immediate?, external?, worktree?})` (`src/execution/task-card.ts`) renders it from the blackboard alone, as markdown capped at 32 KB. The cap cuts the body, never the protocol. The task card, sent on stdin, contains:
- the ultimate goal and the verbatim original prompt (capped);
- the task, its acceptance criteria and its write scope;
- summaries of completed dependencies;
- the interfaces and decisions in force;
- the immediate context: the resolution, failing output, conflict files or a design artifact;
- the protocol:
  - no messages to other agents; use `read_blackboard`;
  - `post_update` for progress;
  - escalate when blocked;
  - targeted edits instead of rewrites;
  - `run_command` only;
  - `submit_work(ready: true)` to finish;
  - stay within budget.

## 10. Tasks, claims, leases, merging

```ts
type TaskState = "pending" | "ready" | "claimed" | "in_progress" | "submitted" | "checking" | "merging" | "accepted" | "blocked" | "paused" | "failed" | "cancelled";
interface Claim { task: string; agent: string; attempt: number; ttl_s: number; granted_seq: number }
interface Lease { id: string; agent: string; task: string; paths: string[]; mode: "exclusive" | "shared"; branch: string; reason: string; granted_seq: number }
```

**Claims.**
- Runner workers are pre-claimed. Their claims live while the pid is alive and the output file keeps growing.
- External claims have a 15-minute TTL, renewed by any tool call.
- When a claim expires, its leases expire too and the task returns to `ready`. The WIP stays in its worktree.

**Leases.**
- Globs support `**`, `*` and `?`, with no braces. `*` and `?` never cross `/`, a trailing `/**` needs at least one segment, and `[` and `]` are literal.
- Overlap is judged conservatively: two leases overlap if the static prefix of one is a whole-segment path prefix of the other. The comparison ignores case and Unicode normalization, because `SRC/**` and `src/**` name the same files on macOS. This never misses an overlap, but it can report one that cannot happen (`src/*.ts` and `src/*.css`), so requests may queue unnecessarily. Coverage stays exact: a path in another case is simply not covered, which fails closed.
- An exclusive lease conflicts with anything; a shared lease conflicts only with an exclusive one. An agent never conflicts with itself on the same task.
- A conflicting request is queued. The response names the leaseholder, its task and its progress, and suggests `escalate(with: "path_owner")`.
- The queue is FIFO: a request also waits behind an earlier queued request it conflicts with, so a stream of compatible requests cannot starve a waiting one.
- Git metadata needs an explicit lease. A path with a segment starting with `.git` (`.gitattributes`, `.gitmodules`, `.gitignore`, `.github/…`) is covered only by a glob that names that segment literally. A `.git` segment is never covered.
- The task id `integration` is reserved, because `rt/<exe6>/integration` names the integration branch.

**Enforcement** happens at three points:
1. The PreToolUse hook.
2. `submit_work`, where every path in `git diff --raw -M <merge-base>..HEAD` must be covered by a lease. Both sides of a rename count, gitlinks are refused, and so are symlinks that leave the repository. The merge base is taken with the integration branch, so other tasks' merged work never counts.
3. Before merging.

**Commits.** The worker server commits only leased paths (`src/execution/worktrees.ts`). Changed paths outside the leases stay uncommitted and are reported. Commits carry the trailers `Roundtable-Execution`, `Roundtable-Task` and `Roundtable-Agent`, and their messages are scrubbed.

Every host-side git call goes through `src/execution/git.ts`:
- argv only, `childEnv("git")`, a timeout and capped output;
- no fsmonitor, hooks, pager, external diff, textconv, signing, auto gc or maintenance, transports, rerere or submodule recursion;
- an explicit `--git-dir`/`--work-tree` taken from the main repository's worktree records. A worktree whose `.git` file was rewritten, or is a symlink, is refused;
- the commit identity, read from the main repository;
- no nested repository is ever entered. Status and every diff that reads the working tree pass `--ignore-submodules=all`, because a child git in a submodule's directory would read that directory's agent-writable `.git/config` and `.gitattributes` and run their filters on the host. `diff.ignoreSubmodules=all` is set only as a fallback, since a worktree's `.gitmodules` can override it.

**Submodules are not supported in heads-down runs in 1.0.** A `base_sha` whose tree holds a gitlink is refused before any worktree is created. So is any worktree whose index or HEAD holds one, and any branch that would bring one into a merge. Commits never stage a gitlink.

**`submit_work`.** Commits, checks leases, then runs the task's checks in the sandbox. It is capped at 15 minutes and sends progress notifications. With `ready: false` it only makes a checkpoint commit.
- One submission per task at a time: a worker server refuses a second `submit_work` for the task while one is in progress.
- A submission is one commit. Lease coverage, the diff, `task.submitted` and every check are taken at the commit `submit_work` made, never at a `HEAD` that may move.
- Checks run in a fresh detached checkout of that commit (`withCommitCheckout`, under `executions/<exe>/checks/`), which no worker tool reaches, and which is removed afterwards. Whatever the worker does to its worktree during the checks, they see the committed bytes and nothing uncommitted. The checkout's `.git` is a gitfile, which the docker backend mounts read-only.
- Every check event, and `task.checks_passed`, carries the submission's `submitted_seq` and `commit`. The outcome (`task.checks_passed` or `task.rejected`) is recorded only if, in the same transaction, the submission is still the task's latest `task.submitted`, the task is still `submitted` or `checking`, and the same agent holds the claim in the same attempt under the same token. Otherwise nothing is recorded and the worker is told its submission is out of date.
- **The runner merges exactly `task.checks_passed.commit`**, the commit the checks passed on, never the task branch's current head.

**Merge queue.** The runner merges serially, under `git.lock`, with `git merge --no-ff` into `_integration`.
- If the conflicted files are inside the task's leases, the runner merges the integration branch into the task worktree, leaving the conflict markers, and resumes the worker.
- Conflicts outside the leases escalate as `conflict`.
- When a merge succeeds, the integration smoke checks run.

**Completion.**
1. All tasks are accepted.
2. Final validation runs on the integration branch.
3. The lead does a goal review and answers `Verdict: COMPLETE | INCOMPLETE`. A run gets at most 2 review cycles, counted from its goal-review notes; INCOMPLETE may add tasks within authority, then escalates when the cycles are spent.
4. `execution.completed` is emitted. Optionally the integration branch is pushed and a PR opened with `gh pr create`.

The runner never pushes to the base branch, and nothing auto-merges.

## 11. Watchdog

`evaluate(state, now, cfg) → Action[]` is pure, and the runner applies the resulting actions through `transact`.

| Rule | Automatic action | Escalates when |
|---|---|---|
| Lease or claim expiry | Reclaim and grant the head of the queue | — |
| Worker died or lost | Retry with `--resume`, attempt+1; a death from a transient driver failure (rate limit, auth, credit) is not counted against `max_attempts`; a worker that stopped while its task was paused (an emergency, a driver circuit, a manual pause) is resumed on the same attempt once the pause ends | Attempts exceed `max_attempts`; transient deaths exceed `infraRetries` (20) |
| Stall (pid alive, no output or heartbeat for 10 min) | SIGTERM, then SIGKILL, then resume | 2 stalls on the same task |
| Dependency wait | Block the task; unblock on `dependency.satisfied` or `task.merged` | A wait-for cycle → `deadlock_detected`, sent to the common orchestrator |
| Repeated failure | — | The same check signature 3× with no patch in between (a diff-hash change resets the streak); or diff-hash ping-pong A→B→A |
| Budget | Ledger fed by `total_cost_usd`/usage plus huddle usage; `threshold_crossed` at 50% and 80% of the current total, re-armed after an extension (80% wakes the orchestrator) | 100% of the execution budget → stop spawning, `awaiting_human{money}`; a per-task cap → kill and escalate `resource` |
| Circuit breaker (per driver or provider) | 5 failures in 10 min, or a 429 → open; half-open after 1, 2, 4… up to 30 min, admitting exactly one trial worker, which closes the circuit once it has run 2 min | Auth or credit failures → immediate emergency that lists alternatives |
| Note ping-pong (A and B alternate on a topic ≥4×) | — | Suggest a micro-huddle |
| Huddle caps | Micro-huddle = 2 turns; collaboration huddles ≤ 3 rounds | No outcome, or none after `huddleTimeoutMs` (20 min) → orchestrator |

**Failure signatures** (`src/sandbox/signature.ts`): strip ANSI codes, timestamps, durations, temp paths and hex addresses; keep the first 60 error-like lines; hash them with sha256 together with the command id.

**Usage accounting:**
- `callLLMDetailed` plus an `AsyncLocalStorage` usage sink (`src/providers/usage.ts`), so the existing engines feed the ledger.
- `pricing.ts` is a data table that can be overridden with `ROUNDTABLE_PRICING_FILE`.
- Models missing from the table are recorded as `estimated: true`.

**Implementation** (`src/execution/watchdog.ts`, with `budget.ts`, `pricing.ts`, `circuit.ts`, `deadlock.ts`, and the action types shared by all of them in `watchdog-actions.ts`):
- The signature is `evaluate(state, now, obs, cfg?)`. `obs` holds what the blackboard does not: agent liveness and output and heartbeat times, watcher liveness, lead calls in flight, and times kept only in the log. `observeEvents(events, base)` derives the log part: claim renewals, spawn times, huddle starts, routing times, lead fallback issue times, diff history, open dependency needs, stall counts, transient driver deaths, driver outcomes and circuit history.
- An action is `emit` (event drafts) or a process operation: `kill_worker`, `resume_worker`, `spawn_retry`, `stop_spawning`, `lead_fallback` or `wake_orchestrator`. Each carries a `rule` and a deterministic `key`. Watchdog escalation ids derive from the key, which is how a rule knows it has already escalated. `actionsToDrafts` adds one `watchdog.action` per action for the audit trail.
- The runner evaluates inside `transact` against the fresh state, commits the drafts, then performs the process operations. **Every process operation is idempotent for the runner**: it can arrive again after a crash or on the next pass. Operations whose condition persists are *standing* (`standing: true`, not audited, no events): `stop_spawning` while the budget is spent, and `kill_worker` while a worker runs on a task at its cap or blocked by the watchdog. A lost `lead_fallback` is issued again `leadRetryMs` (5 min) after it was last issued, unless `obs.leadInFlight` marks the call as running. A lost `spawn_retry` leaves a `ready` task that the runner's scheduler starts.
- Every respawn path (retry, resume, the runner's own spawns via `canRespawn`) goes through one gate: budget left, and the driver's circuit closed, or half-open with no trial worker started yet. While the gate is shut, a dead worker waits and no attempt is counted.
- The lead fallback first re-routes the escalation to `authority.lead` (`wake: false`), which marks it handled. A huddle that times out concludes `NO_OUTCOME`, and its escalation is routed to the orchestrator.
- Budget thresholds fire once per budget total. After `budget.extended` the 50% and 80% warnings re-arm, and spending through the extension escalates again. The circuit counts failures since the last success or the end of its last open period.
- `classifyFailure(message, {source: "driver" | "provider"})` reads only provider-shaped messages (an API error type, "Credit balance is too low", "Not logged in · Please run /login", a status inside an API error line). A worker's command or test output must never be classified.
- A deadlock is reported once per occurrence. The same set of tasks is reported again only after the escalation for its last report is resolved or withdrawn. A task blocked on a dependency that failed or was cancelled escalates.
- The leases of a finished task (accepted, failed or cancelled) expire, and queued requests of tasks without a claim are withdrawn. Claims do not expire while the run or the task is paused, or while the task's submitted work is being checked or merged; a resume, a rejection or a check restarts their TTL.
- The lease grants and overlap check here are a conservative stand-in until the WS06 lease engine replaces them.

## 12. Escalations and huddles

`escalate` takes:
- `kind`: blocker, ambiguity, resource, conflict, assistance or emergency;
- `with`: orchestrator, management, team, agent or path_owner;
- target, summary, question, options, diagnostics, `blocking` and `emergency`.

Only the escalating task blocks.

**Routing:**

1. **Watchdog first.** A dead leaseholder, a dependency that only needs waiting, or a transient rate limit is handled automatically and emits `auto_resolved`.

2. **Peer escalations** (`agent`, `path_owner` or `team`, for conflict or assistance) go to a **micro-huddle** run by the runner:
   - Turn 0 is the escalation text. No model call is made.
   - Turn 1 is the counterpart's answer.
     - A live claude-code counterpart answers through `answer()`: `claude -p --resume <B> --fork-session --tools "" --max-budget-usd 0.5`, with cwd set to B's worktree. This is read-only and does not disturb B's run.
     - Other counterparts answer through a persona call that gets the persona, the task card, recent progress and the diff stat.
   - Turn 2 is the requester-side conclusion: `Outcome: AGREED | DISAGREED | NEEDS_ORCHESTRATOR` and `Decision:`.

   The outcome becomes `decision.recorded`. The counterpart learns of it through inbox piggyback, because every worker tool response includes new directives and decisions. The requester is resumed with the resolution.

3. **Orchestrator, management, ambiguity and blocker** escalations go to the scope's orchestrator. They climb to the parent when the decision is outside a sub-contract's authority.
   - If the main chat's watcher is alive: `routed{wake: true}`, and the orchestrator picks a response with `resolve_escalation`.
   - Otherwise, after 2 minutes, the **lead fallback** decides in one persona call that must output `Action:` and `Decision:`.
   - An action outside the lead's authority becomes `awaiting_human`.

4. **Emergencies** (money, credentials, scope beyond the contract, or something that needs human action) become `awaiting_human`.
   - Only the affected tasks pause: the escalating task, its dependents, and tasks on a failing driver.
   - The human is alerted three ways: a dashboard banner, a GitHub comment with the `needs-human` label, and a watcher wake.

**Formats.** The runner calls the existing engines in-process. The context is `buildContextBundle()`: the contract summary, the escalation, the diagnostics and the relevant blackboard slices, never the human's chat. Every huddle runs with `public: false` and tags its activity entry with an `origin`.
- Collaborate, debate, waffle-house and conversation use `startCollaboration` and `continueCollaboration`.
- Re-plan and ultraplan use `startUltraplan({planner: lead, execution_ready: true, revisionRounds: 1})`, followed by `amend_contract`.
- The orchestrator can also run any format itself with `execution_status(view: "context")` and then call `resolve_escalation(action: "decide")`.

**Implementation (WS10).** `src/execution/escalation.ts` exports `routeEscalation`, `resolveEscalation` and `createRunnerHooks`. `huddle.ts`, `lead.ts`, `goal-review.ts` and `context-bundle.ts` supply the engines, fallback, review and bounded context. Persona calls and engine calls run under a usage sink outside event transactions; live-worker answers report their driver usage to the same ledger. A failed worker answer routes to the orchestrator without a third model attempt.

Resolvers serialize through a separate per-escalation lock, leaving the event lock free during calls. An amendment's reason identifies its escalation so a retry after a crash can finish resolving without amending twice. A concluded format huddle can likewise recover its session and decision from its turn blobs: `routeEscalation` and the runner pass finish a huddle that concluded while its escalation is still `in_huddle`, as whoever started it, with no further model call. Emergency pause scopes retain separate ownership: resolving an escalation preserves overlapping emergencies and manual pauses.

A resolution that unblocks a task owes it a resume until `agent.spawned` (or `task.retried`) for that task is observed. `owedResumeOps` re-derives the same `resume_worker` (same key) from the log on every pass, so a resume that failed or was lost in a crash is issued again. Directive lines (`Action:`, `Outcome:`, `Verdict:`, `Decision:`) are read only from the answer's own lines, never inside blockquotes or fences; conflicting `Action:` lines fail closed to `await_human`, conflicting `Outcome:` lines to `NEEDS_ORCHESTRATOR` and conflicting `Verdict:` lines to `INCOMPLETE`.

`createRunnerHooks({llm?, alive?})` implements WS08's `escalationRouter(ctx, escalation)`, `leadFallback(ctx, id)` and `goalReview(ctx, input)` interface, plus the optional `escalationPass(ctx)` the runner calls every pass for owed resumes and concluded huddles. The mirror in `runner-hook-types.ts` must stay identical to WS08's `runner-hooks.ts`. The adapter uses `ctx.worker` for live session records and applies returned process operations through the driver's stop control and `ctx.resumeTask`. Persona calls use the supplied provider/model, or the provider layer's default OpenAI model. The direct WS11 resolver returns the current escalation, process operations, an idempotence flag, warnings and any amendment result; `participants[0]` supplies the new persona for a `reassign` action.

## 13. Orchestrator experience

**`execute`** requires a frozen contract and `confirmation`, which is the human's verbatim words; it is recorded in the event log and the audit log. It returns `{status: "needs_input", questions}` when any of these is true:
- no visibility channel was chosen (dashboard, GitHub, or an explicit `chat_only`) and `ROUNDTABLE_DEFAULT_VISIBILITY` is not set;
- no budget was given, either as an argument or in the environment;
- Docker is unreachable and the local sandbox was not opted into;
- a required CLI flag is missing;
- GitHub was requested but the `gh` scopes are missing.

It warns when the main worktree is dirty. Otherwise it returns `{execution_id, runner_pid, dashboard_url?, watch: {argv, instructions}}`.

**`agent-roundtable watch <exe> --as main [--timeout-min 50]`** is a background command the orchestrator runs.
- It tails from its cursor and writes its liveness every 10 s.
- It exits with one JSON line when an escalation is routed to it, on `awaiting_human`, when the budget passes 80%, when the run completes or fails, or when it times out.
- The orchestrator handles the wake and re-arms the watcher.

**`execution_status`.**
- `focus` scores tokens and prefixes against task id, title, team, path segments and interface names, so "nav" matches `build-nav-bar` and `src/components/nav/**`.
- Completion is weighted: accepted tasks count 1, submitted 0.8, in progress the reported percent or 0.4.
- The status also reports blockers, the latest checks, an ETA, the budget, runner health and sync health.
- Views: `summary`, `tasks`, `escalations`, `events`, `budget`, `context`.

**`control_execution`** has these actions:
- `pause` and `resume`, for the whole run or for specific tasks;
- `steer`, which issues a directive;
- `abort`, which kills the process groups but keeps the worktrees and the log;
- `purge`, which works on terminal runs only and needs `confirm: true`.

**Back to the table.** Pause the run, run any format with the `context` from `execution_status(view: "context")`, call `amend_contract(from_session)`, then resume. Both switches emit `execution.mode_changed`.

## 14. Visibility

**Dashboard** (`src/dashboard/`, served by the runner) builds on `src/http/secure-server.ts`, which is extracted from the prototype board. The shared server:
- binds to 127.0.0.1 on a random port;
- requires a capability token (`randomBytes(18)`, base64url) as the first path segment of every route. It is compared with `timingSafeEqual` on sha256 digests, so neither its length nor a near miss shows: any request without it is the same plain 404. The token is never logged;
- checks the Host header and answers 421 when it does not match;
- serves only GET and HEAD (405 otherwise), and refuses CONNECT, upgrades and proxy requests (unless it is a deny-all proxy, as the board is for the screenshot browser);
- sends `nosniff`, `no-store`, `no-referrer`, same-origin CORP and COOP, `X-Frame-Options: DENY`, a Permissions-Policy denying camera, microphone, geolocation and similar features, and a CSP on every response (`default-src 'none'` unless the route sets its own).

`startDashboard(executionId, {store?})` returns `{url, close()}` and writes `dashboard.json {url, pid, host, started_at}` while it runs. Pages: overview (goal, status, completion with the §13 weights, budget, runner heartbeat from `runner.json`, open escalations, the DAG, recent notes), tasks, task detail (acceptance, checks with signatures and redacted failing output, the latest diff from its blob, recent events), escalations, events (newest first, paged, filtered by type, group or task through plain links), contract (markdown generated from the frozen contract, plus `contracts/<ctr>/CONTRACT.md` when present, through a converter that escapes everything, passes no raw HTML and builds no links), and a server-rendered SVG of the task DAG (layered layout, colored by state; also at `dag.svg`). Every string from the run is redacted (secrets and personal data) and escaped. A banner on every page names the escalations awaiting a human.

Updates arrive over SSE (`<token>/stream?since=<seq>` sends `rev {seq}` when the log grows), with polling of `state.json`, a redacted subset of the blackboard without diffs, outputs or blobs, as a fallback. The dashboard is read-only: it has no mutating route, so CSRF does not apply; steering stays in the orchestrator's tools.

The dashboard's CSP is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. Its stylesheet and script are TypeScript string constants served under `<token>/static/`, and no page has an inline script, style or event handler.

The prototype board's own scripts and stylesheet move to static routes too, so `BOARD_CSP` and `VIEWER_CSP` allow no `'unsafe-inline'`. Diagrams render with Mermaid's `securityLevel: "sandbox"` and `htmlLabels: false`, inside a script-less, opaque-origin `data:` frame, so a diagram cannot restyle or overlay the viewer; a diagram carrying a configuration directive (`%%{…}%%` or front matter, which can hold `themeCSS`) is shown as source and never rendered, and `secure` locks every styling key. `DIAGRAM_VIEWER_CSP` allows that frame (`frame-src data:`) and inline styles (never scripts) for it. Residual risk: inside its frame a diagram draws what it likes, and a link in it can open a popup on a click. A live prototype's missing file answers in plain text that only the board may frame. `APP_CSP` keeps `'unsafe-inline'` as an accepted risk: prototype pages are agent-written and run in a sandboxed, opaque origin that can read nothing from the board. Mermaid is pinned to 11.17.2, the newest 11.x release without a GitHub advisory, and loaded as the single file `dist/mermaid.min.js` with a sha384 `integrity` attribute and `crossorigin="anonymous"`; the viewer CSP names that one file.

**GitHub sync** (`src/github/`) is a runner loop with its own cursor, and it never blocks the run. The runner builds `new GitHubSync({executionId, repo, projectOwner?, projectNumber?, createProject?, pr?})` and calls `syncOnce()`, which never throws and returns a `SyncReport`.
- On start it creates a parent issue (a redacted contract summary, `<!-- roundtable:<exe> -->`), then one issue per task carrying the marker `<!-- roundtable:<exe>:<task> -->`, all labelled `roundtable`.
- Each task issue is linked with `addSubIssue` through `gh api graphql` and added to the project with `gh project item-add`. With `createProject` and no number, the project is created.
- Status changes go through `item-edit`, coalesced so only the latest state per task is written: Todo for pending and ready, Done for accepted, failed and cancelled (the last two with a comment), In Progress otherwise. The project's `Status` field is used when it has those options; otherwise a `Roundtable Status` single-select field is created.
- When a human is needed, the issue (the parent when the escalation names no task) gets a comment and the `needs-human` label, created if missing and removed once the escalation is resolved or withdrawn.
- Progress notes become at most one comment per task per 10 minutes.
- On completion the parent gets a comment linking the PR, and the issues are closed.
- Idempotency: `github.json` (atomic) holds the cursor, the issue numbers and node ids, the project ids and an outbox of comments, labels and closes. An issue is recorded as soon as `gh issue create` prints its URL (its node id is fetched afterwards). A lost mapping is rebuilt by searching for the body markers before anything is created, a create interrupted before it was recorded is looked up before it is retried, and comments carry an event marker so neither a rebuilt sync nor a post that timed out repeats them. Markers are public, so only issues authored by the gh account itself (`author:@me`, checked again against the GraphQL viewer) and labelled `roundtable` are trusted, and only that account's comments count when looking for a posted marker.
- Rate limits: token buckets of 20 creates per minute and 60 other calls per minute. A rate-limit answer backs off 60 s plus jitter. Three failing rounds in a row mark the report `degraded`.
- Every call is an argv spawn with `childEnv("gh")`, a 30 s timeout and capped output; bodies go through 0600 `--body-file` temp files. Bodies are redacted and escaped (no HTML, so no forged markers; @mentions, `#123`, `owner/repo#123`, `GH-123` and github.com URLs are broken with a zero-width space, so nothing notifies anyone or backlinks another issue), and diffs and command output are never read or posted.
- Only GraphQL is used: gh subcommands and `gh api graphql`, never a REST path.
- `checkGhReady({repo, project})` returns `{ok, missing[]}` for the `execute` preflight: a gh login with the `repo` and `project` scopes, write access to the repository, and a readable project when one is named.

## 15. Tool surface

There are 15 new tools, which brings the orchestrator server to 37 and leaves the worker server with 7. Every new tool has `additionalProperties: false` and MCP annotations.

| Group | Tool | Arguments |
|---|---|---|
| Contract | `propose_contract` | goal\*, orchestrator\*, title, original_prompt, artifacts[], from_session, plan, contract{}, parent_contract, parent_task, participants[], repo_dir, base_ref, consent, provider, model, base_url |
| | `amend_contract` | contract_id\*, patch{}\*, reason\*, orchestrator\*, from_session, consent, override_consent, provider, model, base_url |
| | `freeze_contract` | contract_id\*, orchestrator\*, excuse[{agent, reason}], abandon_round |
| Run | `execute` | contract_id\*, confirmation\*, visibility{dashboard, chat_only, github{repo, project_owner, project_number, create_project, pr}}, budget_usd, max_parallel, lead, sandbox, worker_driver, worker_model |
| | `execution_status` | execution_id, focus, view, since_seq, limit |
| | `control_execution` | execution_id\*, action\*, reason, message, task_ids[], targets[], confirm |
| | `resolve_escalation` | execution_id\*, escalation_id\*, action\*, decision, format, participants[], amendment{}, resolved_by |
| | `join_execution` | execution_id\*, agent\*, team, task_id (orchestrator server only) |
| Worker | `read_blackboard` | section, query, task_id, ref, since_seq, limit |
| | `claim_task` | task_id, release, note |
| | `lease` | action\*, paths[]\*, mode, reason |
| | `post_update` | kind\*, text\*, percent, topic, name, owner, path, refs[], directive_id |
| | `run_command` | command_id or argv[], timeout_s |
| | `submit_work` | summary\*, ready\* |
| | `escalate` | kind\*, with\*, summary\*, target, question, options[], diagnostics{}, blocking, emergency |

On the worker server, the worker tools are bound to the token. On the orchestrator server, they require `agent_token` and `execution_id`: the tool definition carries a second schema for that mode (`inputSchemaByMode`). Subcontract tasks additionally get scoped `propose_contract` and `freeze_contract`. With WS04's contract tools and WS07's `join_execution` and seven worker tools, the orchestrator lists 33 tools until WS08 lands the other four run tools.

**Worker tool semantics** (`src/tools/worker.ts`). Every response is JSON and carries `inbox`: the agent's new directives and decisions since `agents/<id>/inbox.cursor`, which advances only after a response containing those items is built, plus `awaiting_ack` (directive ids and text) for directives not yet acknowledged. Inbox is the first response key and is never truncated: oversized inboxes deliver the oldest fitting page and advance only to its last item. Pending acknowledgements also page oldest first, retaining each directive's text, with `more_awaiting_ack` when more remain. Other sections are capped as valid JSON; errors carry the inbox too.
- `read_blackboard`: `section` is summary (the default), goal, contract, tasks, task, interfaces, decisions, leases, claims, files, diffs, checks, escalations, notes, inbox, budget, agents, teams, events, blob or query.
  - `events` filters on `since_seq`, `limit`, `task_id`, and a type prefix in `query`.
  - `blob` is scrubbed and capped at 16 KB.
  - `query` fuzzy-matches tasks, teams, paths and interfaces, and answers questions such as "is the nav done?".
- `claim_task`: external agents only, with at most one held task (including the agent-record fallback); runner assignments cannot be claimed or released by the worker. Claims a ready task whose dependencies are accepted and that nobody holds; the run must be running. It ensures the worktree and returns the task card. External claims get `ttl_s: 900`. `release` emits `task.released` and releases the task's leases.
- `lease`: `action` is `request` or `release`.
  - A request must lie within `contract.scope.paths`, or it is refused. One outside the task's write scope is granted with a warning.
  - A queued request names its holders and suggests `escalate(with: "path_owner")`.
  - `release` takes lease ids or globs; `**` releases all of the agent's leases on the task.
  - `leases.json` is rewritten for the agent and for every agent a release grants a lease to.
- `post_update`:
  - progress, note, interface and need require an active run and, when assigned, an active task; paused and terminal runs refuse them.
  - progress → `task.progress`
  - note → `note.posted`
  - interface → `artifact.published` (the text as a blob; refused when another task owns the interface or artifact; undeclared names belong to their first publisher), then `dependency.satisfied` for every open `dependency.requested` on it. In the same transaction, a blocked task whose last open need that was, with no deps or blocking escalation, gets `task.unblocked`. A task that also waits on deps is left to the watchdog, which unblocks it once those are met and no needs are open.
  - need → `dependency.requested` + `task.blocked`. `topic` gives the kind (task, interface or artifact), else it is inferred; optional `owner` names the expected publishing task. A need is met only by its declared owner or first publisher, matching the expected owner when supplied; an already met need is reported, not recorded.
  - ack → `directive.acknowledged`
- `run_command`: one sandbox backend per execution and process. `execution.started.sandbox: "local"` counts as the opt-in, because the keyless worker server has no `.env`. A named command emits `check.*` with scope `task`; an argv emits `command.completed`. Full output goes to a blob, and the response has `tailForTool`, the exit code and the signature.
- `submit_work`:
  1. `commitLeasedPaths` with the integration branch as `summaryBase`.
  2. Uncovered or refused paths emit `lease.violation` + `task.rejected`, and the submission is refused.
  3. `checkLeaseCoverage` of the new commit against the integration branch.
  4. `task.submitted` with the commit and the diff blob, while the agent still holds the claim under its token.
  5. The task's checks in a checkout of that commit, within 15 minutes, with progress notifications. The result is `task.checks_passed` with the commit (state merging), or `check.failed` + `task.rejected` (back to in_progress), recorded only while the submission is still live (§10).

  `ready: false` makes a checkpoint commit and emits `task.progress`. Nothing here merges.
- `escalate`: `escalation.raised`, plus `task.blocked` when blocking, with the instruction to end the turn. Diagnostics go to a scrubbed blob.
- `join_execution`: registers an external agent (`driver: "external"`) with a fresh token, returned once. A runner-managed agent id is refused, and a re-join voids the old token. It is audited as `agent.joined`, and with `task_id` it ensures the worktree and returns the card.

**Validation** moves to `src/validate.ts`, which supports a subset of JSON Schema: type, enum, required, items, properties, additionalProperties, minLength/maxLength, pattern, minimum/maximum and maxItems. Error paths name nested fields, for example `visibility.github.repo`. Legacy messages stay byte-identical.

## 16. Security controls

- **Child environments.** A child-env allowlist applies to every spawn.
- **No shell.** There are no shell strings anywhere, and prompts go in on stdin.
- **Outbound URLs.** A URL guard covers provider and webhook URLs:
  - https only, except http to loopback;
  - no userinfo in URLs;
  - metadata ranges are always blocked, and private ranges are blocked unless opted in;
  - redirects are manual whenever credentials are attached;
  - the API key is bound to its configured origin.
- **Redaction.** Secrets are redacted from every log, event, blob and error. PII is also redacted from GitHub, ntfy and public channels.
- **Files and IDs.** Directories are 0700, files 0600, and writes are atomic. Agent refs must stay inside allowed roots. IDs are durable and random.
- **Locks.** Per-session locks prevent concurrent turns.
- **Retries.** Provider calls retry with backoff inside the original timeout.
- **Sandbox.** Docker runs with no network, as non-root, with a read-only root, all capabilities dropped and `no-new-privileges`. Resources are limited, the env is empty, and output is capped. Dependency installs reach only allowlisted hosts through the egress proxy. The local backend requires an explicit opt-in and reports `sandbox.degraded` when it falls back.
- **Audit.** The audit log is hash-chained, checked by `verify`, and swept for retention: runs are kept 30 days after they end, and the audit log 365 days.
  - A prune writes `audit-anchor.json {hash, previous, files, at}` before deleting whole month files, and records an `audit.pruned` entry.
  - `verifyAudit` requires the first remaining entry to link to the anchor, or to the genesis hash when nothing was ever pruned. Deleting the oldest entries without a prune is therefore detected.
- **CI.** Least-privilege permissions, actions pinned by SHA, an `npm audit` gate, CodeQL, Dependabot, an SBOM, and npm provenance on release.
- **Documentation.** `SECURITY.md`, `docs/THREAT_MODEL.md` (STRIDE for each trust boundary, including prompt injection from repo content) and `docs/SECURITY_CONTROLS.md`.

Supported platforms are macOS and Linux. Windows is not supported for heads-down runs in 1.0.

## 17. Shared primitives (landed in WS03a)

These modules exist so the workstreams can run in parallel without depending on each other. Each workstream must reuse them rather than write its own.

| Module | API |
|---|---|
| `src/execution/types.ts` | Every shared type above, plus `EVENT_TYPES` (checked at compile time against the catalog), `GENESIS_HASH`, `CONTRACT_SCHEMA` and `CONTRACT_DEFAULTS` |
| `src/ids.ts` | `newId(prefix)`, `newExecutionId()`, `executionTag(id)`, `EXECUTION_ID_RE` |
| `src/security/fs-safe.ts` | `mkdirPrivate`, `writeFileAtomic` (which also fsyncs the directory), `fsyncDir` (added in WS03), `isContained`, `normalizeRelPath` |
| `src/security/child-env.ts` | `childEnv(profile, extra?, source?)`, `SECRET_NAME_RE`. Profiles: claude-worker, codex-worker, local-meeting, git, gh, docker, browser, open, sandbox-local, cloud-cli, runner |
| `src/security/secrets.ts` | `scrubSecrets(text)` (exact env secret values first, then credential patterns), `scrub`, `scrubAndCap` |
| `src/publishers/redact.ts` | `redactSecrets` and `redactPII`. `redact` composes the two, so public output is unchanged |

WS02 added the tool layer and session durability that later workstreams build on:

| Module | API |
|---|---|
| `src/validate.ts` | `findProblem(schema, args, phases?)`, `assertValid(label, schema, args, phases?)`, `publicSchema(schema)`. Phases are `values` then `required`. Extensions: `x-hint`, `x-advisory-enum`, `x-nonblank` (all stripped before listing) |
| `src/tools.ts` | `tools`, `toolsFor(mode)`, `handleToolCall(name, args, mode?, ctx?)`, `checkArgs(tool, args, mode?)`. A new group is a `ToolGroup` (`definitions` + `handle(name, args, ctx)`) added to its `groups` list; `ctx` (WS07) carries the mode, an MCP progress callback and the abort signal |
| `src/tools/shared.ts` | `ToolDefinition` (`modes`, `annotations`, optional `precheck`, optional `inputSchemaByMode` (WS07)), `ToolGroup`, `ToolCallContext`, `schemaFor(definition, mode)`, annotation presets, `PROVIDER_PROPS`, `validateProviderOptions` |
| `src/tools/names.ts` | Tool-name constants, `AT_THE_TABLE`, `HEADS_DOWN`, `MODE_LABELS` |
| `src/sessions/lock.ts` | `lockSession(id, message)`, `withSessionLock(id, message, fn)`, `isSessionBusy(id)`, `sessionBusyMessage`, `SessionBusyError`. Refuses at once, never queues |
| `src/sessions/archive.ts` | `archiveSession(record)`, `readArchivedSession(id)`, `listArchivedSessions()`, `pruneArchivedSessions(retentionDays = 30)` (not wired in yet). Agent refs and ids are stored as passed; only content fields are scrubbed. Records are `roundtable.session/1`; ultraplans carry `document` (markdown, versions, entries, sign-offs, tally) |

WS03 adds the store that the other workstreams write through:

| Module | API |
|---|---|
| `src/execution/store.ts` | `createExecutionStore({repoRoot, baseSha, agentsDir, id?})`, `openExecutionStore(id)`, `listExecutions()`, `executionDir(id)`, `REDUCER_VERSION`. Stores implement `ExecutionStore` plus `writeSnapshot()` |
| `src/execution/lock.ts` | `acquireLock(dir, {staleMs, timeoutMs, waitMs?})` returns `release()` with `.held()`; `withLock(dir, opts, fn)`. Never taken from a live holder; the parent directory must exist |
| `src/execution/events.ts` | `validateDraft(draft)`, `PAYLOAD_SPECS`, `PAYLOAD_LIMIT_BYTES` |
| `src/execution/blackboard.ts` | `initialState(id)`, `apply(state, event, resolved?, {strict?})`, `checkKey(scope, command, task?)` |
| `src/execution/blobs.ts` | `putBlob`, `getBlob`, `scrubbedJSON(value)` for structured blobs |
| `src/execution/verify.ts` | `verifyExecution(idOrDir)` returns `{ok, seq, badSeq?, reason?}` |
| `src/security/audit.ts` | `appendAudit({actor, action, target?, details?})`, `verifyAudit()`, `pruneAudit(retentionDays = 365)` |

WS04 adds the contract lifecycle:

| Module | API |
|---|---|
| `src/execution/contract.ts` | `checkContract(c, {parent?})` (sync), `validateContract(c, {parent?, personas?})` (resolves personas), `contractHash`, `consentHash`, `applyMergePatch`, `createMergePatch`, `affectedTasks(old, new)` → `{changed, added, removed, dependents, all}`, `renderContractMarkdown(c, {mark?})`, `contractPath`, `childBudgetCap(parent, task)`, `RESERVED_TASK_IDS`, `CONTRACT_SECRET_ENV_RE` |
| `src/execution/contract-state.ts` | `contractRecord(store, id?)` (versions, verdicts with their version and hash, the consent round and freeze, read from the log), `standing(record, agent)`, `summarizeConsent(record)`, `openContractStore(contractId)`, `loadParent(id, {task?, exclude?})` (depth, remaining budget, sibling budgets), `CONSENT_ROUND_STALE_CAP_MS` |
| `src/execution/contract-parse.ts` | `findTaskBlock(text)`, `blockToContract(value)`, `sessionSource(archived)`, `structureContract(request, llm, check)`, `TASK_BLOCK_FORMAT` |
| `src/execution/consent.ts` | `requestConsent(store, contractId, {by, participants?, llm?, candidate?})` (returns `dropped` when the round stopped being current) |
| `src/execution/contract-lifecycle.ts` | `proposeContract(opts)`, `freezeContract(contractId, {orchestrator, excuse?, abandonRound?})`, `freezeContractIn(store, …)`, `amendContract(store, patch, {by, reason?, authority?, contractId?, fromSession?, consent?, overrideConsent?, source?})`, `authorityNeeds`, `RUN_WIDE_FIELDS`, `AuthorityError`, `ContractRefusal` |
| `src/sandbox/common.ts` | `analyzeArgv(argv)` → `{programs, shell}`, `isShellCommand`, `isPrivilegedCommand` (WS04 widened the shell detection) |
| `src/sessions/workshop.ts` | `runVerdictRound(agents, buildPrompt, label, {verdicts, llm, limit?, reask?, catchErrors?})` (ultraplan reviews and sign-offs, consent) |

WS06 adds worktrees, leases and the merge queue:

| Module | API |
|---|---|
| `src/execution/git.ts` | `runGit(target, args, opts)` (hardened; see §10), `openRepo(root)`, `openLinkedWorktree(repo, path)`, `gitIdentity(repo)`, `taskBranch(exe, task)`, `integrationBranch(exe)`, `assertSafeRef`, `resolveCommit`, `GIT_HARDENING`, `GitError`, `GitSafetyError` |
| `src/execution/leases.ts` | Pure. `matchGlob`, `staticPrefix`, `globsOverlap`, `leasesConflict`, `decideLeaseRequest(state, req)`, `nextGrants(state, source, {gone?})`, `releaseLeases(state, filter, source, opts?)`, `pathCovered`, `uncoveredPaths`, `leasesFor`, `leaseDrafts.*` |
| `src/execution/worktrees.ts` | `ensureIntegrationWorktree(header)`, `ensureTaskWorktree(header, task, startPoint?)`, `taskStartPoint(state, task)`, `removeWorktree(path, {deleteBranch?})`, `pruneWorktrees(exe, {remove?, branches?})`, `worktreeStatus(path)`, `withGitLock(exe, fn)`, `mergeBase`, `changedPaths`, `checkLeaseCoverage`, `commitLeasedPaths`, `snapshotWip`, `diffForTask`, `taskDiffSummary` |
| `src/execution/merge.ts` | `mergeTask(header, task, {leases?})`, `prepareConflictResolution(header, task)`, `classifyConflict(conflicts, leases)`, `mergeDrafts.{succeeded, conflicted, taskMerged}` |

WS12 adds the visibility modules the runner hosts:

| Module | API |
|---|---|
| `src/http/secure-server.ts` | `SecureServer.start({name, routes, allowProxied?})` with `url`, `base`, `close()`, `closeNow()`; `COMMON_HEADERS`, `DEFAULT_CSP`, `escapeHtml`, `tokenMatches`. Routes are exact paths or RegExps; a handler gets `send`, `text`, `html(status, body, csp)`, `json`, `stream` (SSE) |
| `src/dashboard/server.ts` | `startDashboard(executionId, {store?, pollMs?, writeInfo?})` returns `{url, close()}`; `DASHBOARD_CSP` |
| `src/dashboard/render.ts` | `completion(state)` and `taskWeight(rt)` (the §13 weights), `publicState(state, runner)`, `markdownToHtml(md)` |
| `src/github/sync.ts` | `new GitHubSync({executionId, repo, projectOwner?, projectNumber?, createProject?, pr?})`, `syncOnce(): Promise<SyncReport>`, `statusFor(taskState)` |
| `src/github/gh.ts` | `runGh(args, {input?, timeoutMs?})`, `ghJson`, `ghGraphql`, `withBodyFile`, `checkGhReady({repo, project})` returns `{ok, missing[]}` |

WS07 adds the worker drivers, the worker MCP server and the worker tools:

| Module | API |
|---|---|
| `src/workers/claude-code.ts` | `ClaudeCodeDriver({cli?, killGraceMs?, answerTimeoutMs?})` (`detect`, `launch`, `resume`, `parse`, `stop`, `answer`), `buildWorkerArgs(launch, caps?, {resume?})`, `buildAnswerArgs(session, maxUsd)`, `parseClaudeHelp(help)`, `parseClaudeLine(line, acc)`, `attest(acc, expected?)`, `WORKER_ATTESTATION`, `workerEnvExtras(launch)` |
| `src/workers/codex.ts` | `CodexDriver`, `buildCodexArgs(launch, mcp)`, `buildCodexResumeArgs(thread, launch, mcp)`, `parseCodexLine(line, acc)`, `readCodexMcpServer(path)` |
| `src/workers/files.ts` | `prepareWorkerFiles({store, agent, persona, task, execPath?, cliPath?, home?})` returns the paths and `token_sha256`; `writeAgentLeases(store, agent, {task?})`; `agentTask(state, agent)`; `agentDir`, `ensureAgentDir`, `buildMcpConfig`, `buildWorkerSettings`, `newAgentToken`, `tokenSha256` |
| `src/workers/monitor.ts` | `new RunMonitor({path, parse, agent, task, source?, expected?, provider?, model?, offset?})` with `.poll()` returning `{drafts, attestation?, done, bytes}`, `.finish({code, signal?, reason?})` returning drafts, `.offset` and `.acc` |
| `src/workers/process.ts` | `spawnWorker`, `workerExit(pid)`, `groupAlive(pgid)`, `signalGroup`, `stopGroup(pgid, graceMs)` |
| `src/workers/hook.ts` | `decidePreToolUse(input, env)`, `runPreToolUseHook()`; the CLI's `hook pre-tool-use` |
| `src/workers/token.ts` | `consumeWorkerToken({execution, agent, tokenFile})`, `sameDigest` |
| `src/execution/task-card.ts` | `buildTaskCard(state, taskId, {immediate?, external?, worktree?})` |
| `src/server.ts`, `src/cli.ts` | `buildServer(mode)`, `startStdio(mode, worker?)`; `runCli(argv)` with `mcp [--worker …]` and `hook pre-tool-use` |
| `src/tools/worker.ts` | `workerTools`, `handleWorkerTool`, `bindWorkerIdentity`, `globWithin` |
