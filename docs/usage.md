# Usage visibility

Who is spending what, on which platform, and a big friendly stop button for any one agent. The roundtable shows the same picture in four places, so they never disagree:

| Where | What it is for |
| --- | --- |
| The **status line** (`agent-roundtable statusline`) | Always on, inside your Claude Code session. |
| The **dashboard Usage page** | The rich view of one heads-down run, with a **Stop** button on every card. |
| `agent-roundtable usage` | A friendly report for any terminal; `--json` for scripts. |
| The `usage` tool | The same view for the host model: "what has cfo cost so far?", "stop the builder". |

Design: [usage-visibility.md](design/usage-visibility.md).

## Measured, reported, estimated

Every token count and every cost carries its provenance, and the words are always spelled out. Tokens and cost of the same call can differ: a provider can report tokens (measured) while the cost is computed from the price table (estimated).

| Word | Meaning | Where it comes from |
| --- | --- | --- |
| **measured** | Counted by the system that did the work and read by us directly. | A heads-down worker's own result line (tokens and `total_cost_usd`), the token usage in a provider's response. |
| **reported** | Told to us by an agent or the host, so we cannot check it. | The host's status line JSON (its session cost); an external worker's `post_update(kind: "usage")`. |
| **estimated** | Worked out by us. | Cost from the price table (`ROUNDTABLE_PRICING_FILE` can override it) when no cost was measured; tokens from text length (4 characters a token) when a provider reported none, and for local meetings, which run the CLI in text mode. |

How figures are written: measured is plain (`$0.92`), reported carries `rep` (`$0.40 rep`) and estimated carries `≈` (`≈$0.12`). A total that mixes them shows the split (`$1.84 = $1.62 measured + ≈$0.22 estimated`), never one number without a label. Cost is shown whenever any is known; for a model with no price (a local model, say) you get its tokens and "no price" instead of a misleading `$0.00`. The status line abbreviates the words to `meas` and `rep`, while **estimated** stays spelled out; colour is never the only signal.

Two limits to know. The host agent itself (your main chat) is not metered by the roundtable: its only figures come from the host's own status line JSON and are always labelled reported (host). And a **reported** figure can raise a total but never lower measured spend; one report is clamped to $10,000 and 10^10 tokens.

Live capped sessions show **spent $x of $cap cap** in the usage report and dashboard; JSON/tool agent entries include `max_usd`, `spent_usd` and `cap_reached`. These values describe the whole session, so each participant shows the same cap and cumulative spend. The live duel/casting registry and room metrics show them too. Unpriced tokens count toward `spent_usd` using provider judgment’s estimate; known free models count as zero. A spend cap stops a meeting, collaboration or ultraplan as stopped by "spend cap". A duel saves a resumable checkpoint; use `roundtable duel --resume <id> --max-usd <higher-cap>` to continue.

## The status line

Add this to your Claude Code settings (`~/.claude/settings.json`, or the project's `.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "agent-roundtable statusline" } }
```

From a source checkout use `node /path/to/agent-roundtable/dist/index.js statusline`. The command reads the host's JSON on stdin and prints up to three lines:

```
Opus 5.5 | agent-mcp | 5h 0%→21:50 | 7d 82%
◆ roundtable  heads-down exe-4cc7wh 4/7 tasks · $1.62 meas + ≈$0.22 estimated of $20 · table 2 agents ≈$0.05 estimated
  builder $0.92 meas [claude-code] · fixer $0.40 meas [claude-code] · stop: agent-roundtable stop <agent>
```

1. **The host**: model name, project directory, the 5-hour window (used % and when it resets, local time) and the 7-day window. A field the host did not send is left out with its separator. `--no-host` leaves this line out, if another tool already draws it.
2. **The roundtable at a glance**: the live heads-down run with its tasks, spend (with its split) and budget, then today's at-the-table sessions. It turns red and says so in words (`of $20 (91%)`) past 80% of the budget.
3. **The busiest agents**, highest spend first, each with its platform in brackets. A status line cannot be clicked, so it ends with the stop command: the exact one when a single agent could be stopped, `<agent>` otherwise.

Details: it is fitted to `COLUMNS` (or 120) by dropping agents before anything else and never drops a provenance label; `--agents N` (default 4) sets how many agents; colour is ANSI by default and off with `--plain` or `NO_COLOR`. With nothing to show it prints only line 1, and with no roundtable home yet, only line 1. It answers within about 150 ms (the view is cached for 2 seconds), never prints message text, prompts, diffs or command output, and **always exits 0**: any failure prints line 1, or nothing, never a stack trace.

## The usage report

```sh
agent-roundtable usage            # a friendly report
agent-roundtable usage --json     # the view, for scripts
agent-roundtable usage --watch    # refreshed every 2 seconds
```

The report opens with the total and its split, a one-line legend, then a card per agent (state with a mark and a word, platform, what it has used, where it works), the platforms, the heads-down runs and recent stops. With nothing yet it says "No usage yet. Agents will show up here as soon as they start." The JSON is the same `UsageView` every surface renders: `totals`, `platforms`, `agents` (each with `where`, `scope`, `provider`, `model`, `tokens`, `money`, `state`, `stoppable`), `stops`, `runs` and `table`.

Dissent micro-huddles appear under the requesting identity charged for both persona and driver calls. Each call lists **dissent micro-huddle**, its dissent id, execution, task, provider, model and cost provenance. JSON and the tool expose this as `agents[].calls`, including `call_id`, `estimated` and `reservation`; `agents[].platforms` splits a requester’s spend across its driver and persona platforms. An outstanding paid reservation is estimated spend and reduces the budget available to new work. The watchdog waits for settlement or retention before raising permanent budget escalations. A usage report replaces it, including token counts, so it never counts twice. If a paid call fails, times out or returns without usage, its dispatched allowance remains estimated; free local providers stay free.

## The dashboard Usage page

A heads-down run started with `visibility: {dashboard: true}` has a **Usage** page (and a compact usage card on Overview). It opens with "Here's who's working and what it's cost so far", the total split by provenance and a legend. Below it, one card per agent: initials avatar in a stable colour, platform chip (provider · model), a status pill (working, idle, stopped, done), tokens in and out and cached, money with provenance chips, the agent's share of the budget, and a sparkline of its spend over time. A by-platform table follows. The page works in light and dark, at 360 px wide, with visible focus rings, `aria-live` announcements for status changes and no layout jump when it updates.

Every stoppable card has a **Stop** button. It opens a native dialog: "Stop builder? Its task will pause and the orchestrator will be asked to rework or write a handoff." Cancel is focused by default. After confirming, the card says "Stopping…" and then "Stopped" as the run moves on. This is the dashboard's only control, and it is protected like one: see [the threat model](THREAT_MODEL.md#dashboard--browser). Anyone who holds the dashboard URL can read the run and stop its agents, so keep it private.

## Stopping an agent

Three ways, one effect:

```sh
agent-roundtable stop builder                                 # an unambiguous name needs no scope
agent-roundtable stop cfo --session meeting-4k9q2mzt --reason "that is enough"
agent-roundtable stop builder --execution exe-01m55xb3xsh72cgp
```

In chat, ask the orchestrator: it calls `usage(action: "stop", agent: "builder")` or `control_execution(action: "stop_agent", targets: ["builder"])`. On the dashboard, press **Stop**.

**Heads-down.** The request is an `agent.stop_requested` event. The runner stops the worker on its next tick, before scheduling anything; its exit is recorded as `stopped`; its branch and worktree are kept; and its task is blocked, not retried. The orchestrator is woken (watcher reason `agent_stopped`) with two choices: **rework** around the stopped agent with `resolve_escalation` (reassign, retry, amend or decide), or **write a handoff** with `control_execution(action: "handoff")`. An external worker cannot be stopped by the roundtable; you are told to steer it through its inbox instead.

**Dissent micro-huddles during heads-down work.** Stop on either participant, or the affected task's worker, aborts the huddle and routes its unresolved escalation to the orchestrator. Before dispatch, unused reservations are released. After dispatch, reported usage is charged and unreported paid allowance stays **estimated**; only unused allowance is released. Late usage replaces that estimate without restarting the huddle. The runner also recovers a Stop after interruption with the same conservative charge and routing. Stop never releases a `pause_and_huddle` hold: resolve that escalation explicitly. Resolving it removes only its own reason; other dissent holds, Stop blockers, dependencies and needs remain. Agreement wins only if its resolution commits before Stop; otherwise the huddle routes with its hold intact.

**At the table.** The orchestrator server holding the session aborts the turn in flight (the provider call, or a local meeting's CLI process group), ends the session as stopped, and records it. The next tool call that names the session answers `{status: "stopped", by, at, next}` with the same two choices: continue without the agent, or write a handoff with `usage(action: "handoff", session_id: …)`. Stopping an agent in a collaboration ends the whole session. The host agent (your main chat) cannot be stopped from here; use your harness's own stop.

**Handoffs.** `HANDOFF.md` of a run (in `executions/<exe>/`) is generated from the blackboard only: the contract summary and goal, every task with its state, owner, branch and last progress note, the stopped agents and why, the open escalations, the budget with its provenance split, and the exact commands to resume. A session's handoff (`sessions/<id>.handoff.md`) comes from its archived record. Neither contains the confirmation, the original prompt, a diff or command output, and every string is scrubbed.

Every stop is audited: `agent.stop_requested` in the audit log with the surface (dashboard, cli, tool), the agent, the scope and who asked.

## Reporting usage as an external worker

An external worker (registered with `join_execution`) can report what it has used since its last report:

```json
{ "kind": "usage", "tokens": { "input": 12000, "output": 1800 }, "usd": 0.4, "model": "my-model" }
```

It is recorded as **reported**, counts toward the budget like any other spend (fail toward caution), and is refused for workers the runner started, whose usage is measured. Without `usd` the cost is estimated from the price table.

## What is stored

Heads-down figures live in the run's event log (`budget.usage_recorded` carries the provenance and provider) and the blackboard (`budget.by_agent_usage` and current bounded-call entries in `budget.calls`). At the table, each provider call appends one line to `usage/table-YYYY-MM-DD.jsonl` under the roundtable home: time, server, session, kind, agent, provider, model, token counts, cost and provenance, **no message text**. Orchestrator servers also write `usage/live/<server-id>.json` every 5 seconds (and remove it on a clean exit; a dead pid or an old heartbeat reads as gone) and look in `usage/stops/<server-id>/` every second for stop requests. Files are 0600 in 0700 directories, written atomically, validated on the way back in, and the ledger follows `ROUNDTABLE_SESSION_RETENTION_DAYS`.
