# Heads-down runs

Agents talk it out at the table, agree on a contract, then build in parallel. A detached runner schedules work, watches budgets and handles escalations. Workers coordinate through the event log, shared blackboard, task claims and path leases. A run keeps its state across MCP reconnects and runner restarts.

> Use agent-roundtable to plan an accessible nav bar, a navigation API and its docs with product-lead and skeptic. Show me the contract before executing. Once I approve, build it with a $20 cap and a dashboard.

Heads-down runs support macOS and Linux, Node 22+, one trusted operator and one host per state directory. You need git, a supported worker CLI with its own login, and Docker for the default command sandbox. See [configuration](configuration.md), [providers](providers.md), and the [design specification](design/heads-down.md) for implementation details.

## Agree on a contract

A contract records the ultimate goal, the human's request verbatim, repository and base commit, participants, task dependencies, write globs, acceptance criteria, checks, interfaces, budget, sandbox and the lead's authority. Checks use structured `argv`, not shell command strings. Task dependencies must form a DAG; write paths must stay inside the contract's scope.

Start from an agreed plan or an [ultraplan](modes/ultraplan.md) with `execution_ready: true`. Its plan must end with a fenced `roundtable-tasks` JSON block. End/finalize the session to archive it before handing its id to `propose_contract`. The [three-task example](../examples/contract.example.json) illustrates an API task, a dependent nav task and a docs task that depends on both. It is a template for another project: replace the repository path, base ref, personas and check commands with your project's values. `propose_contract` resolves the actual repository and base commit and supplies the stored id, version and consent state.

```json
{
  "goal": "Ship an accessible nav backed by a navigation API, with usage docs",
  "original_prompt": "Build a nav bar, a navigation API endpoint and a docs page.",
  "orchestrator": "main",
  "from_session": "<archived-ultraplan-id>",
  "consent": true
}
```

Call `propose_contract` with that object. For explicit structure, pass the example JSON as its `contract` object along with `goal`, `orchestrator`, and the real `repo_dir`. This is the most reliable route. Otherwise the tool uses the plan's last task block, or makes a provider call to structure plan prose, with one validation retry. A contract object without tasks overlays settings on the extracted structure.

Show the returned contract to the human. Each participant answers `Consent: AGREE` or `Consent: OBJECT`; an unclear answer is re-asked once. Consent applies only to the current version. `freeze_contract` requires the proposing orchestrator and every participant's agreement to that version. It lists unresolved objections, missing/stale votes, unfinished consent rounds, busy source sessions and parent-contract problems. An explicit `excuse: [{agent, reason}]` is audited. `abandon_round: true` ends a dead consent round; its missing votes still need excusing. Freezing starts no workers.

```json
{ "contract_id": "<contract-id>", "orchestrator": "main" }
```

Use `amend_contract` for revisions: an RFC 7396 merge patch merges objects, replaces arrays and deletes fields with `null`. Draft revisions need consent again. A frozen contract's task changes take effect in force, cancel removed tasks and notify affected workers. Run-wide changes to budget, scope, sandbox, authority, validation, workers or goal need `consent: true` or an audited `override_consent: true`. Identity, repository, base commit and the original human prompt cannot be rewritten. An empty patch with `consent: true` asks those still missing agreement. Child contracts stay within their parent task's paths, remaining budget and authority; the parent must be frozen first.

## Execute and preflight

The human must ask to execute. The host calls `execute` with a frozen `contract_id` and `confirmation` containing the human's words verbatim. That confirmation is recorded in the event and audit logs. Planning or freezing alone does not authorize execution.

```json
{
  "contract_id": "<contract-id>",
  "confirmation": "Yes, build it with a $20 cap and a dashboard.",
  "visibility": { "dashboard": true },
  "budget_usd": 20
}
```

Missing choices return `{status: "needs_input", questions: [...]}` and start nothing. Ask the human the returned plain-language questions and call again with answers. Preflight checks visibility, budget, sandbox availability, CLI flags/login readiness, GitHub access when requested, and unsupported submodules. A dirty main worktree warns. A placeholder budget produced while structuring a plan must be confirmed. Overrides such as `budget_usd`, `max_parallel`, `lead`, `sandbox`, `worker_driver` and `worker_model` are applied together as an audited contract amendment.

A successful call returns the execution id, runner pid, optional dashboard URL and `watch` instructions. Calling `execute` again for an already-started run returns its current information. The runner survives MCP server shutdown and writes its own private log.

## Visibility

Choose explicitly, or set `ROUNDTABLE_DEFAULT_VISIBILITY`:

- `visibility: {dashboard: true}`: a loopback dashboard with capability URL, task DAG, contract, checks, diffs, budget, a Usage page (who is spending what, with a Stop button per agent), events and human-action banners. Keep the returned URL private: anyone who holds it can read the run and stop its agents. Steering stays in MCP tools.
- `visibility: {github: {repo: "owner/name", create_project: true}}`: optional parent/task issues, project status, progress and `needs-human` labels/comments through the installed GitHub CLI. This needs login, repository write access and the `repo`/`project` scopes. The sync redacts text and excludes diffs/command output; remote visibility can degrade without blocking work.
- `visibility: {chat_only: true}`: follow progress in chat without either UI. Use this alone; dashboard and GitHub can instead be combined with each other.

GitHub options include an existing `project_number` and `project_owner`, or `create_project`; `pr: true` requests publication of the integration branch and a PR at completion. The runner never pushes to the base branch or auto-merges. Human review remains the final merge step. Public sessions at the table use a separate [publishing mechanism](modes/public-sessions.md).

## Watch and status

Start the exact `watch.command` returned by `execute` as a background shell command immediately. Each invocation exits after one JSON wake; re-arm after handling it. The watcher maintains a cursor and liveness so the runner knows whether the orchestrator is available.

```sh
agent-roundtable watch <execution-id> --as main --timeout-min 50
agent-roundtable status <execution-id> --json
```

The watcher's wake `reason` is one of `escalation`, `awaiting_human`, `budget`, `completed`, `failed`, `aborted`, `timeout`, and, with [postmortem mode](modes/postmortem.md), `postmortem_ready` (every fix has settled; hold the meeting) and `postmortem` (a meeting concluded; tell the human).

Use `execution_status` for natural questions such as “how close is the nav?”:

```json
{ "execution_id": "<execution-id>", "focus": "nav", "view": "summary" }
```

Without an execution id it lists runs. Views are `summary`, `tasks`, `escalations`, `events`, `budget`, and `context`; events accept `since_seq` and `limit`. Focus matches task ids, titles, teams, paths and interface names. Summary includes blockers, latest checks, rough ETA, budget, runner health and visibility links. Completion weights accepted tasks as 1, submitted work as 0.8, and other work by reported progress or 0.4 when progress is absent. ETA is an estimate from accepted-task durations, available after a task finishes. `view: "context"` returns bounded, scrubbed blackboard context for a session at the table; it excludes the human's chat and execution confirmation.

## Work, leases and checks

The runner schedules ready tasks up to `budget.max_parallel` (default 3). Each task owns a branch and worktree. Workers claim tasks, request leases on write paths, post progress and publish interfaces through the [worker tools](tools.md#workers-both-servers). Conflicting path requests queue FIFO. A task waiting on an interface unblocks when its owner publishes it and other blockers clear.

Claude workers have restricted file tools, no Bash and a PreToolUse lease hook. Commands go through sandboxed `run_command`. `submit_work(ready: false)` checkpoints; `ready: true` commits leased changes and runs checks in a separate checkout of that exact commit. The runner merges the checked commit serially into the integration branch, runs integration checks, and either accepts it or returns conflict/check context to the worker. Changes outside leases are refused. Submodules and escaping symlink chains are unsupported. Final validation and a lead goal review run before completion.

Optional [worker connectors](connectors.md) add locally configured stdio MCP servers to Claude workers. A contract opts in with `connectors: ["issues"]`; those names are frozen and covered by consent. Credentials resolve through the [secrets broker](secrets.md) before spawn, are scrubbed from output and blackboard writes, and live only in the private temporary MCP config. Connector processes are trusted host programs with access to their external services. Codex workers refuse connector contracts; seat connectors at the table are not yet supported.

External workers register with `join_execution` and receive an `agent_token` once. The orchestrator server's worker tools require it and `execution_id` on every call; their claims expire after 15 minutes without a tool call. External workers are trusted like the host chat and are unsandboxed. Every worker response also delivers inbox directives and decisions; directives need acknowledgement.

## Swarms

Swarms require consent to a frozen contract with `budget.max_agents >= 2`. Without it workers cannot delegate. `max_parallel` still caps top-level workers; `max_agents` caps every live worker, including parents and children (1–32). `max_subtasks` caps the total children created over the run, including failed and cancelled children (default 16, maximum 64).

A worker calls `spawn_subtasks({subtasks: [{id, title, instructions, paths, depends_on?}]})` with 1–8 children. Each slug becomes `<parent>.<id>`. Instructions are at most 4000 characters. Dependencies name other siblings in that call, without cycles. Children inherit the parent's persona and checks and run through the usual claims, checks and merge queue. Subtasks cannot spawn more subtasks, and a parent may have only one open batch.

Paths must be inside the parent's current leases and cannot overlap siblings. The parent hands those paths to its children for their lifetime: its write hook and submission checks exclude them, while its remaining paths stay writable. The reservation also protects children waiting for a worker slot. Paths return after children finish. A parent cannot submit while children are open, or before merged child work has been brought back into its worktree.

Call `await_subtasks({timeout_s: 30})` for status, scrubbed final notes, changed files and merge status. It waits at most 120 seconds; `still_running: true` means call again. Once children merge, the runner snapshots the parent's leased work and merges integration into the parent's worktree with host git. `ready: true` means every child merged and fan-in finished. Conflicts use the existing conflict escalation path; resolve the parent worktree and await again.

A failed or cancelled child is returned to the parent, which can spawn a replacement with a new id if the limits allow, or escalate. Cancelling or failing the parent cancels its open children. Events and blackboard state retain every child and its result across runner restarts. `execution_status`, the DAG and task pages show the tree. Worker `Task` and `Agent` tools remain disallowed: all delegation goes through the runner.

Child spend counts toward the execution and the child's own task cap, without charging the parent's task cap. Spawning reserves no money. It refuses if the parent has no budget left or the remaining execution budget, after outstanding worker allocations, is less than one worker's per-task budget. Worker launches still obey the existing budget gate.

| Contract budget field | Meaning |
|---|---|
| `max_parallel` | Top-level workers at once, default 3 (1–16). |
| `max_agents` | Optional total live workers (1–32); at least 2 enables swarms. |
| `max_subtasks` | Total subtasks ever spawned, default 16 (1–64). |

## Escalations and huddles

Keep concerns raised at the table through [dissents and tripwires](dissents.md): notify the dissenter, huddle or pause affected work when recorded evidence matches. The dashboard's **Dissents** page shows firings, huddle outcomes and advisory scores.

Only blocked work and affected dependents pause. Workers use `escalate` for blockers, ambiguity, resource needs, conflicts, assistance or emergencies. The watchdog handles expired claims/leases and transient failures, detects stalls, repeated signatures and deadlocks, and routes what remains.

`execution_status(view: "escalations")` lists open items. Answer with `resolve_escalation` using `decide`, `huddle`, `retry`, `reassign`, `amend`, `dismiss` or `await_human`. `participants[0]` is the replacement persona for reassignment. `amendment` is a contract merge patch. The runner applies resulting worker resumes/stops on its next tick.

```json
{
  "execution_id": "<execution-id>",
  "escalation_id": "<escalation-id>",
  "action": "huddle",
  "format": "micro",
  "participants": ["product-lead", "skeptic"]
}
```

A micro-huddle takes two turns; other formats are `meeting`, `collaborate`, `debate`, `waffle-house`, `conversation`, `replan` and `ultraplan`. Huddles stay private and receive only relevant blackboard context. If the orchestrator is away, the lead can decide within `authority.may`; money, credentials, wider scope and human actions require the human. Dashboard, configured GitHub sync and watch surface those requests.

For a larger rethink, `control_execution(action: "pause", to_table: true)`, obtain `execution_status(view: "context")`, run a format at the table, archive it, use `amend_contract(from_session: ..., patch: {})`, then `control_execution(action: "resume", to_table: true)`. These switches are recorded as mode changes. `steer` sends acknowledged directives to agents, teams or tasks. Pausing starts no new work; running workers finish their turn.

## Resume and recovery

Reconnect and call `execution_status` or `control_execution(action: "resume")`: these ensure a live run has a runner. To start it manually use `agent-roundtable run <execution-id>`. Recovery verifies the chain, replays state, adopts live workers and resumes dead workers with their WIP and fresh task cards. The task retains its branch and worktree. A live runner lock is never stolen, even with a stale heartbeat; a different host is refused. A fully paused runner exits after six hours and can be restarted later.

`stop_agent` stops one or more workers (the same stop as the dashboard's button): the runner keeps the work, blocks the task and wakes the orchestrator with two choices, rework around the agent with `resolve_escalation` or `control_execution(action: "handoff")`. Stopping either micro-huddle participant routes the unresolved huddle to the orchestrator: reported usage is charged, dispatched unreported allowance stays estimated, and unused allowance is released. Dissent holds survive until their own explicit escalation resolution; other holds and dependency waits remain. See [usage visibility](usage.md#stopping-an-agent). `abort` stops workers and keeps worktrees, branches and logs. `purge` deletes a terminal run only, needs `confirm: true` (CLI: `--confirm`), and is audited. `agent-roundtable verify <execution-id>` checks event and audit chains. Startup retention defaults to 30 days for terminal runs and archived sessions and 365 days for audit months; configure each policy or use `0`/`off` to retain it. Public transcripts and remote copies are separate.

## Budgets and sandbox

Set the run's USD cap, per-task cap and wall-clock limit in the contract. `max_parallel` is 1–16; default attempts per task are 3. The lead's permitted actions and budget extension percentage are explicit, defaulting to retry/reassign/resolve-merge and no extension. Usage includes worker, consent, huddle and lead calls. CLI-reported costs take precedence; otherwise token pricing is estimated. `ROUNDTABLE_PRICING_FILE` can override model rates. Budget warnings occur at 50% and 80%; reaching the cap stops new work and requests human action. Worker spawns reserve their `--max-budget-usd` up front. Orchestration calls (consent, huddles, lead fallback, goal review) are metered when they return: a huddle starts only while budget remains and a micro-huddle answer is capped at what is left, so calls already in flight can overshoot the cap by a bounded amount. Per-task caps, stalls and provider circuits are enforced by the watchdog.

Docker is the default command/check backend: no network, non-root user, read-only root and git metadata, dropped capabilities, bounded output/time and CPU/memory/process limits. If needed, `sandbox.install` declares installation argv and an HTTPS destination allowlist for the egress proxy. Review install hosts and image digests. Docker images must contain the toolchain your checks need; the sample uses Node 22.

A local backend requires `ROUNDTABLE_ALLOW_LOCAL_SANDBOX=1` or the human's explicit `execute(sandbox: "local")` choice. Its weaker isolation is surfaced as degradation; macOS uses Seatbelt when available, while Linux may provide only network isolation or no isolation. It lacks Docker's resource limits and install egress support. This sandbox contains commands, not the entire orchestrator or worker CLI. See the [threat model](THREAT_MODEL.md) and [security policy](../SECURITY.md).

## Codex opt-in

Claude Code is the default driver. To use Codex, opt in with `ROUNDTABLE_ALLOW_CODEX_DRIVER=1` or explicitly choose `execute(worker_driver: "codex")`. Preflight reports missing CLI capabilities and the broader access model. Codex keeps its own sandboxed shell, and leases are enforced at submission rather than before every edit. Its profile denies the user's home, roundtable state and main checkout, reopens the task worktree for writes and toolchain/git roots for reads, and disables network. Reads outside denied roots remain possible. `ROUNDTABLE_CODEX_READ_ROOTS` adds absolute toolchain roots where needed; it cannot reopen denied roots. Use the CLI's login by default; `ROUNDTABLE_WORKER_AUTH=api_key` explicitly forwards provider API credentials.
