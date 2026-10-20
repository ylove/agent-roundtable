# Usage visibility: design

Status: implemented in 1.1.0 (see §11 for how it was built). Workstream WS15, issue #131, tracking issue #129. This is the spec WS15 builds against. If the implementation needs to diverge, update this file in the same pull request.

## 1. Goal

People running agents want to know, at a glance and all the time, **who is spending what, on which platform**, and they want a big friendly stop button for any one agent. 1.0 already meters heads-down workers (the budget ledger fed by `budget.usage_recorded`) but shows it only inside `execution_status` and the dashboard overview, as run totals. 1.1 makes usage:

- **per agent and per platform** (the provider id and model each agent ran on);
- **persistent** inside the agent harness, like the Claude Code status line;
- **unambiguous**: every figure says whether it was measured, reported or estimated;
- **actionable**: any single agent can be stopped from the UI, and the stop is an event the orchestrator acts on.

This UI is a selling point. It must feel welcoming and polished, not like a debug dump.

## 2. Surfaces, and why

| Surface | Verdict | Why |
|---|---|---|
| **Status line command** (`agent-roundtable statusline`) | **Build.** | The status line is the one place a Claude Code user looks at all the time. It is native, persistent and needs only a settings entry. It reads the host's own JSON on stdin, so it can show the host's figures (model, rate-limit windows, session cost) next to ours in one line, which is what the owner already uses. It cannot be clicked, so it carries a short stop hint instead. |
| **1.0 dashboard, new Usage page** | **Build.** | The dashboard is already the rich, secured, live view of a run. It is the right home for detail (per-agent cards, per-platform breakdown, a usage-over-time sparkline) and for the clickable **Stop** button. |
| **`agent-roundtable usage` CLI and the `usage` tool** | **Build.** | The same data for terminals without a status line, for scripts (`--json`) and for the host model itself, which needs it to answer "what has cfo cost so far?" and to stop an agent when asked in chat. |
| Claude Code plugin pane | **Defer to a later release.** | A pane would be nice, but the roundtable is an MCP server for any MCP client; the status line and dashboard work everywhere Claude Code does and with any browser. A pane can reuse §4's `usage --json` output unchanged when it is built. |

All three surfaces read one model (§4) and share one vocabulary (§3), so they never disagree.

## 3. Provenance: measured, reported, estimated

Every token count and every cost carries its own provenance. Tokens and cost of the same call can differ: a provider can report tokens (measured) while the cost is computed from the price table (estimated).

| Provenance | Meaning | Sources |
|---|---|---|
| **measured** | Counted by the system that did the work and read by us directly. | Worker stream-json `usage` and `total_cost_usd` (`src/workers/claude-code.ts`, relayed through `src/workers/output-relay.ts`); token `usage` in provider responses (`src/providers/usage.ts` sink); the local CLI's JSON result. |
| **reported** | Told to us by the agent or host, which we cannot check. | The host's status line JSON (its own session cost and rate-limit windows); an external worker's `post_update(kind: "usage")`. |
| **estimated** | Computed by us. | Cost from the price table (`src/execution/pricing.ts`, `ROUNDTABLE_PRICING_FILE`) when no cost was measured; tokens from text length (4 characters per token) when the provider reported none. |

Display rules, everywhere:
- Words, not just symbols. The full label is "measured", "reported" or "estimated". The status line may abbreviate to `meas`, `rep`; estimated remains spelled out (documented in `docs/usage.md`); colour is never the only signal.
- Estimated money is shown with `≈`, reported with a trailing `rep`, measured plain: `$0.92`, `$0.40 rep`, `≈$0.12`.
- A total that mixes provenances shows the split ("$1.84 = $1.62 measured + ≈$0.22 estimated"), never one blended number with no label.
- Cost is shown whenever any cost is available. When none is (an unpriced local model, say), the figure is tokens with "no price" rather than `$0.00`.

## 4. Data model

### Heads-down

- `budget.usage_recorded` gains an optional `provenance: {tokens: "measured" | "reported" | "estimated", usd: "measured" | "reported" | "estimated"}` and an optional `provider`. Old events without it are read as `{tokens: "measured", usd: estimated ? "estimated" : "measured"}`, which is what 1.0 meant.
- The reducer's `budget` section gains `by_agent_usage[agent] = {provider?, models: {[model]: {tokens: {input, output, cache_read, cache_write}, usd: {measured, reported, estimated}}}, last_at}`. The existing `by_agent`, `by_task` and `spent_usd` totals keep their meaning, so budgets and the watchdog are unchanged. `REDUCER_VERSION` stays 10 for the integrated usage and dissent projection.
- `post_update(kind: "usage", tokens, usd)` lets an external worker report its own usage. It is recorded with `provenance.tokens = provenance.usd = "reported"` and counts toward the budget like any other spend (fail toward caution). It is refused for runner-managed workers, whose usage is measured.

### At the table

At-the-table sessions run inside the orchestrator server. Their provider calls already pass through `reportUsage`; the server installs a session-scoped usage sink around every turn and appends one line per call to a **table ledger**:

```
usage/table-YYYY-MM-DD.jsonl   {at, server, session, kind, agent, provider, model, tokens{…}, tokens_prov, usd?, usd_prov}
usage/live/<server-id>.json    {pid, host, started, heartbeat_at, sessions: [{id, kind, agents, started}]}, every 5 s
usage/stops/<server-id>/<request-id>.json   stop requests (§6)
```

Lines hold ids, names, numbers and provenance only: no message text. Files are 0600 in 0700 directories under the roundtable home, appended atomically; ledger files follow `ROUNDTABLE_SESSION_RETENTION_DAYS`. The server's `live` file is removed on clean shutdown; a reader treats one whose pid is dead on this host, or whose heartbeat is older than 30 s, as gone.

The host agent itself (the main chat) is not metered by the server. Its figures come only from the host's status line JSON and are always labelled **reported (host)**.

### The usage model

`src/usage/model.ts` exports `collectUsage({executions?, since?}) → UsageView`: live and recent runs (from each store's blackboard, lock-free), plus today's table ledger and live servers, grouped:

```ts
interface UsageView {
  generated_at: string;
  totals: Money & { tokens: Tokens };            // split by provenance
  platforms: { provider: string; models: string[]; tokens: Tokens; money: Money }[];
  agents: {
    id: string;                     // persona/agent id
    where: "heads-down" | "at-the-table" | "host";
    scope: string;                  // execution id or session id
    provider?: string; model?: string;
    tokens: Tokens; money: Money;   // each with provenance split
    state: "working" | "idle" | "stopped" | "done";
    stoppable: boolean;
  }[];
  stops: { agent: string; scope: string; at: string; by: string; status: "requested" | "stopped" | "failed" }[];
}
```

Every surface renders this view. `usage --json` prints it, so other tools (and a future pane) can use it.

## 5. The status line

`agent-roundtable statusline` is a Claude Code `statusLine` command:

```json
{ "statusLine": { "type": "command", "command": "agent-roundtable statusline" } }
```

It reads the host's JSON from stdin (tolerating missing fields and invalid JSON), builds the view, and prints at most three lines within 150 ms (the view is cached in `usage/statusline.cache.json` for 2 s so a fast refresh never re-reads every log).

**Line 1, the host** (on by default, `--no-host` to omit): reproduces the owner's format from the stdin fields, so the roundtable can be the only status line command:

```
Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%
```

model display name | project directory basename | 5-hour window used % → reset time (local `HH:MM`) | 7-day window used %. A field the host did not send is left out with its separator.

**Line 2, the roundtable at a glance** (only when there is something to show):

```
◆ roundtable  heads-down exe-1a2b3c 4/7 tasks · $1.62 meas + ≈$0.22 estimated of $20 · table 2 agents ≈$0.05 estimated
```

**Line 3, the busiest agents** (up to `--agents N`, default 4, highest spend first, by platform):

```
  builder $0.92 meas [claude-code] · fixer $0.40 meas [claude-code] · cfo 4.1k tok meas ≈$0.03 estimated [<provider>] · stop: agent-roundtable stop <agent>
```

Details:
- Width-aware: the line is fitted to `COLUMNS` (or 120), dropping agents before dropping labels; it never drops a provenance label.
- Colour with ANSI by default, none with `NO_COLOR` or `--plain`. Status colours: working = cyan, stopped = amber, over 80% of a cap = red; colour always duplicates information that is also in text.
- Nothing to show → only line 1. No roundtable home → only line 1, never an error.
- The stop hint names the exact command when one agent is unambiguous, else the generic form.
- Any failure prints line 1 (or nothing) and exits 0: a status line must never show a stack trace.

## 6. Stopping an agent

A stop is a request with a durable record, applied by the process that owns the agent, then acted on by the orchestrator.

**Heads-down.**
1. Any surface emits `agent.stop_requested {agent, by, surface: "dashboard" | "cli" | "tool", reason?}` through `store.transact`. Refused (with a plain message) for an unknown agent, a terminal run, an agent with no live process, or an external agent (which is told to stop through its inbox instead: a directive with `requires_ack`).
2. The runner applies it on its next tick, before scheduling, as a `kill_worker` operation (`stopGroup`), exactly like a reassign stop. When the dashboard served the request (the dashboard runs inside the runner), it wakes the tick immediately.
3. The worker's `agent.exited` carries `reason: "stopped"`; the runner then emits `agent.stopped {agent, task?, request}` and, when the agent held a task, `escalation.raised {kind: "blocker", with: "orchestrator", summary: "<agent> was stopped by <by>", blocking: true}` + `task.blocked`. The task is not retried automatically, and its WIP branch and worktree are kept.
4. The watcher wakes the orchestrator (`reason: "agent_stopped"`, the existing escalation wake) with two choices in its message: **rework** around the stopped agent with `resolve_escalation` (reassign, retry, amend or decide), or **write a handoff** with `control_execution(action: "handoff")`.

`control_execution(action: "handoff")` pauses the run (if live) and writes `executions/<exe>/HANDOFF.md`: generated from the blackboard only (contract summary, goal, every task with its state, owner, branch and last progress note, stopped agents and why, open escalations, budget with provenance split, and the exact commands to resume). It contains no confirmation, original prompt, diff or command output, and every string is scrubbed. The path and the document are returned.

`control_execution(action: "stop_agent", targets: [...])` is the tool form of step 1.

**At the table.**
1. The surface writes a stop request file into the owning server's `usage/stops/<server-id>/` directory (found through `usage/live/`).
2. The orchestrator server checks that directory every second; for each request naming one of its sessions, it aborts the session's in-flight turn (an `AbortSignal` threaded into the provider call, and the existing process-group stop for local meetings), ends the session with reason "stopped", records `stopped` in the table ledger and the activity log, and removes the request.
3. The orchestrator picks it up: the next tool call that names that session returns `{status: "stopped", by, at, next: …}` describing the same two choices (continue without the agent, or write a handoff with `usage(action: "handoff", session)`, which writes a session handoff under `sessions/<id>.handoff.md` from the archived transcript summary, scrubbed). `usage(action: "report")` also lists recent stops, so a host that asks "what happened?" sees it.

The host agent itself cannot be stopped from here (the human has their harness's own stop).

**Every stop is audited** (`agent.stop_requested` in the audit log with surface, agent, scope and `by`).

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

## 7. Dashboard Usage page

A new `Usage` page in the run dashboard (nav: Overview · Tasks · Usage · Escalations · Events · Contract), and a compact usage card on Overview.

Look and feel:
- A friendly header: "Here's who's working and what it's cost so far", with the run total split by provenance and a small legend that explains measured / reported / estimated in one sentence each.
- One **card per agent**: initials avatar in a stable colour from the agent id, name and platform chip (provider · model), status pill (working / idle / stopped / done), tokens in/out/cache, money with its provenance chip, the agent's share of the budget as a bar, and a sparkline of spend over time (server-rendered SVG like the DAG).
- A **by platform** table: provider, models, tokens, money (split).
- A **Stop** button on every stoppable card. It opens a native `<dialog>` ("Stop builder? Its task will pause and the orchestrator will be asked to rework or write a handoff.") with Cancel focused by default. After stopping, the card shows "Stopping…" then "Stopped" via the existing SSE stream.
- Empty states with warm copy ("No usage yet. Agents will show up here as soon as they start.").
- Light and dark from `prefers-color-scheme`, WCAG AA contrast, visible focus rings, keyboard reachable, `aria-live` for status changes, no layout jump on update, works at 360 px wide.

Security (the dashboard gains its **first mutating route**; heads-down.md §14 is updated in the same PR):
- `POST <token>/agents/<agent>/stop` only. The shared secure server's GET/HEAD-only rule gains an explicit per-route method allowlist; every other route stays GET/HEAD.
- CSRF: the request must carry `X-Roundtable-Action: <nonce>`, where the nonce is a second `randomBytes(18)` value generated per dashboard start, delivered only inside the page as a `<meta>` element and compared with `timingSafeEqual` on digests. A custom header forces a CORS preflight that the server never approves, so no cross-origin page can send it. `Origin`, when present, must equal the dashboard's own origin; `Sec-Fetch-Site`, when present, must be `same-origin`. Bodies are refused (`Content-Length` must be 0).
- `form-action 'none'` stays in the CSP; the button uses `fetch` from the static script (`connect-src 'self'`). No inline script or handler.
- The agent id must match the id pattern and name a registered agent; the response is a small JSON status. At most 10 stop requests per minute per dashboard.
- The nonce and token are never logged.

## 8. Tool and CLI surface

- New orchestrator tool **`usage`**: action (report, the default; stop; handoff), execution_id, session_id, agent, reason. `report` returns the §4 view (redacted), `stop` stops a heads-down or at-the-table agent, `handoff` writes the at-the-table handoff. `additionalProperties: false`, MCP annotations (stop is destructive).
- `control_execution` gains actions `stop_agent` and `handoff`.
- `post_update` gains `kind: "usage"` (external workers only).
- New CLI subcommands: `statusline`, `usage [--json] [--watch]` (a friendly table, refreshed every 2 s with `--watch`), `stop <agent> [--execution <exe> | --session <id>] [--reason <text>]` (an unambiguous agent needs no scope).
- `budget.usage_recorded` gains `provenance` and `provider`; new events `agent.stop_requested`, `agent.stopped`.

The README gains one CLI row per subcommand and one tool row, and links a new `docs/usage.md` guide (status line setup, provenance vocabulary, stopping, handoffs). Detailed explanations stay in docs.

## 9. Security

- The statusline, usage CLI and table ledger never read or print message text, prompts, diffs or command output. Every agent name, model and reason is scrubbed and, in the dashboard, redacted and escaped.
- Reported figures are clamped (non-negative, finite, at most $10,000 and 10^10 tokens per report) and labelled; they cannot lower measured spend.
- Stop requests are files under the 0700 roundtable home, validated (ids, sizes) before use; a malformed request is renamed `.bad`.
- The dashboard's mutating route follows §7 exactly; tests cover missing/wrong nonce, cross-origin `Origin`, `Sec-Fetch-Site: cross-site`, bodies, other methods, unknown agents and rate limits.
- No new dependencies.

## 10. Tests

Provenance mapping for old and new `budget.usage_recorded`; reducer per-agent/per-model sums; table ledger writes from the usage sink (fake provider); live-file staleness; `collectUsage` grouping and splits; statusline rendering from sample host JSON (the owner's exact line 1), missing fields, invalid JSON, `NO_COLOR`, width fitting that never drops labels, no-home behaviour, exit 0 on failure; stop flows for heads-down (event → kill op → exited → escalation → watcher wake) and at the table (request → abort → stopped result); handoff documents contain no confirmation, prompt, diff or output; dashboard Usage page escaping, nonce/Origin/method/body/rate-limit checks; external `post_update(kind: "usage")` accepted and runner-managed refused.

## 11. As built (WS15)

The implementation follows the sections above. Where it adds to or narrows them, it does so here, so this file stays the spec:

- **Per-model token provenance.** `by_agent_usage[agent].models[model]` also carries `tokens_prov: {measured, reported, estimated}` (total tokens by provenance), because a view must show tokens with their provenance and the flat `tokens` cannot. Spend that names no agent (huddles, consent rounds, the lead, contract structuring) is filed under `"[huddle]"`, `"[consent]"`, `"[lead]"`, `"[structuring]"` and shown as an entry that cannot be stopped.
- **The view** (`src/usage/types.ts`) also has `runs` (each heads-down run at a glance: tasks, money, budget) and `table` (the day's at-the-table totals), which the status line's second line needs. An agent entry also has `models`, `task`, `budget_share`, `stopping`, `label` and `last_at`. The host agent is listed with `where: "host"` and labelled reported, and is never part of `totals` or `platforms`; the status line saves the host's figures to `usage/host.json` so `usage` and the tool can show them (for 30 minutes).
- **Table ledger.** Lines are `{at, server, session, kind, agent, provider, model, tokens: {input, output, cache_read, cache_write}, tokens_prov, usd?, usd_prov?}`; a stop is a line with `event: "stopped"` and `by`. A provider call that reported no usage is estimated from the lengths of the request and the reply (`UsageReport.chars`; lengths only, never text). A local meeting runs the CLI in text mode, so its turns are estimated the same way and have no price. A heads-down huddle's formats run at the table inside a usage meter: that outer sink keeps the spend, so it is never counted in both ledgers. The ledger is pruned when an orchestrator server starts (`ROUNDTABLE_SESSION_RETENTION_DAYS`), not by the retention sweep. A live file's sessions also carry `busy` while a turn is in flight.
- **Stop requests.** `agent.stopped` also carries `escalation` (the id of the escalation raised for the task), and the watcher recognises it: the `escalation.routed` wake for that escalation has `reason: "agent_stopped"` and the two choices in its message. The escalation is raised only when the agent held a task that was not finished, and the task is blocked only while it is claimed or in progress (a submitted task is left to the merge queue). `by` reads "the human (dashboard)", "the human (command line)" or "<orchestrator> (for the human)". An external agent is refused with the message that tells it to be steered. Agent names at the table are persona names (a path reads as its name).
- **A stop is durable in the log.** Any `agent.exited` after a waiting `agent.stop_requested` settles it (`agent.stopped`, the blocker, `task.blocked`), whatever the exit reason, so a runner that died mid-stop, or a stop asked for while no runner ran, is finished by the next one. A waiting stop is kept across re-registration, the runner never starts a worker for an agent whose stop is waiting (so reconcile and the watchdog's retries cannot undo it), and the watchdog leaves such an agent alone. A worker stopped before its init line is not an attestation failure.
- **At the table.** Tool calls that name a stopped session by `meeting_id`, `collaboration_id` or `ultraplan_id` get the stopped answer from the tool layer; the `usage` tool is exempt so its handoff works. A stopped session is archived with `stopped: {by, at, reason?}` and its activity entry reads "Stopped by …".
- **Dashboard.** `Origin` may be `http://127.0.0.1:<port>` or `http://localhost:<port>`, the two Host values the server answers on. The Usage page replaces the content of its `#swap` element in place when the run moves (no reload, so an open dialog and the scroll position stay), the nonce `<meta>` is printed only on that page, and an agent id outside the route's pattern gets no button.
- **`post_update`** takes `tokens: {input, output, cache_read, cache_write}`, `usd` and `model` for `kind: "usage"`, and `text` is no longer required for that kind.
- **Tool count.** The orchestrator server lists 40 tools, including `usage` and the two WS16 dissent tools. `REDUCER_VERSION` is 10 to combine usage visibility with WS16 dissent state and holds; version 9 is reserved for another workstream.
- **One rule for a model that shows no money** (`src/usage/format.ts`, used by the report, the status line, the dashboard, the tool and the handoff). A known price of zero (a local model) reads `$0.00 free (local model)`; an unknown price reads `no price` (the dashboard adds a `tokens only` chip). `Money` carries `free` or `unpriced` to say which, and any spend clears both; one unknown price makes a sum unknown. The dashboard card for a free model says a local model costs nothing so it has no share of the budget; the copy "appears with its first spend" is kept for an agent that has used nothing yet. A test renders both cases on every surface and compares the words.
