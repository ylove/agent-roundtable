# agent-roundtable

**Agents talk it out at the table, then go heads-down.**
An MCP server for multi-agent collaboration across six LLM providers: discuss, challenge and agree on a plan, then execute a contract with parallel workers, budgets and human oversight.
Runs locally over stdio with Claude Code or any MCP client. Requires Node 22+.

## Install and register with Claude Code

```sh
npm install -g agent-roundtable
claude mcp add agent-roundtable \
  -e ROUNDTABLE_AGENTS_DIR="$HOME/my-project/.claude/agents" \
  -- agent-roundtable
```

Create personas in that directory or copy the [examples](examples/). Set keys for the [providers](docs/providers.md) you use; local meetings use your Claude CLI login. For source installs, `.env`, `add-json` and project `.mcp.json` registration, see [getting started](docs/getting-started.md) and [configuration](docs/configuration.md). After a rebuild, reconnect with `/mcp`.

## Modes

### At the table

Ask in chat; the host calls the tools and keeps session ids for follow-ups.

| Format | What it does | Example prompt |
| --- | --- | --- |
| [Meeting](docs/modes/meetings.md) | Talk with one persona on a chosen provider/model. | “Start a meeting via agent-roundtable with cfo about our Q3 budget.” |
| [Local meeting](docs/modes/meetings.md#local-meetings) | Talk with a persona through your installed Claude CLI and login. | “Start a local meeting with product-lead about onboarding.” |
| [Collaboration: collaborate](docs/modes/collaborations.md) | Personas take turns building a shared idea. | “Have cfo and product-lead collaborate on launch priorities for three rounds.” |
| [Collaboration: debate](docs/modes/collaborations.md#formats) | One proponent faces challengers. | “Have cfo defend our pricing plan against skeptic in a roundtable debate.” |
| [Collaboration: waffle-house](docs/modes/collaborations.md#formats) | A defender refines an idea through repeated attacks and rebuttals. | “Run a two-round waffle-house: product-lead defends one-click checkout against cfo and skeptic.” |
| [Collaboration: conversation](docs/modes/collaborations.md#conversation-mode) | Informal colleague chat with an optional theme and private grounding. | “Let cfo and product-lead chat about the launch in conversation mode.” |
| [Ultraplan](docs/modes/ultraplan.md) | Collect input, review revisions and record sign-offs on a plan. | “Ultraplan the launch with product-lead, cfo and skeptic; show the final document verbatim.” |
| [Agent workshops](docs/modes/agent-workshops.md) | Specialists create or improve an agent and reusable skills. | “Have cfo and skeptic create a budget agent, then improve product-lead's escalation rules; preview both.” |
| [Prototype mode](docs/modes/prototype-mode.md) | Show ephemeral proposals on a local blackboard for assessment. | “Run a prototype collaboration on checkout with product-lead and skeptic.” |
| [Public sessions](docs/modes/public-sessions.md) | Mirror an explicitly public session to ntfy or a webhook. | “Make that pricing debate public and give me the viewing link.” |

### Heads-down

[Heads-down runs](docs/heads-down.md) execute an agreed, frozen contract in parallel task worktrees with leases, checks, a watchdog and escalations. Example: “Execute the approved contract with a $20 budget and a dashboard; keep me posted here.” See the [example contract](examples/contract.example.json).

## Tools

**37 tools on the orchestrator server; 7 on worker servers.** Worker tools appear in both; the orchestrator's copies also require `execution_id` and `agent_token`. The table follows the registered definitions in `src/tools/*.ts`; [full arguments and examples](docs/tools.md).

| Group | Tool | Purpose |
| --- | --- | --- |
| Meetings | [`start_meeting`](docs/tools.md#start_meeting) | Start a conversation with one persona. |
| Meetings | [`say`](docs/tools.md#say) | Send a message in an API meeting. |
| Meetings | [`end_meeting`](docs/tools.md#end_meeting) | End an API meeting, optionally with a summary. |
| Meetings | [`list_meetings`](docs/tools.md#list_meetings) | List active API meetings. |
| Local meetings | [`start_local_meeting`](docs/tools.md#start_local_meeting) | Start a persona meeting on the local Claude CLI. |
| Local meetings | [`say_local`](docs/tools.md#say_local) | Send a message in a local meeting. |
| Local meetings | [`end_local_meeting`](docs/tools.md#end_local_meeting) | End a local meeting, optionally with a summary. |
| Local meetings | [`list_local_meetings`](docs/tools.md#list_local_meetings) | List active local meetings. |
| Collaborations | [`start_collaboration`](docs/tools.md#start_collaboration) | Start a discussion between two or more personas. |
| Collaborations | [`continue_collaboration`](docs/tools.md#continue_collaboration) | Run additional rounds. |
| Collaborations | [`nudge_collaboration`](docs/tools.md#nudge_collaboration) | Inject guidance without consuming an agent turn. |
| Collaborations | [`pause_collaboration`](docs/tools.md#pause_collaboration) | Pause after the current turn. |
| Collaborations | [`end_collaboration`](docs/tools.md#end_collaboration) | End a discussion and return its transcript and optional summary. |
| Collaborations | [`get_collaboration_transcript`](docs/tools.md#get_collaboration_transcript) | Read a discussion without ending it. |
| Collaborations | [`list_collaborations`](docs/tools.md#list_collaborations) | List active collaborations. |
| Ultraplan | [`start_ultraplan`](docs/tools.md#start_ultraplan) | Collect input and begin a reviewed plan. |
| Ultraplan | [`submit_plan`](docs/tools.md#submit_plan) | Review a full plan version or collect final sign-offs. |
| Ultraplan | [`end_ultraplan`](docs/tools.md#end_ultraplan) | Close a plan without sign-offs. |
| Agent workshops | [`create_agent`](docs/tools.md#create_agent) | Have specialists design and optionally save a new agent. |
| Agent workshops | [`improve_agent`](docs/tools.md#improve_agent) | Review and optionally update an agent with a backup. |
| Contracts | [`propose_contract`](docs/tools.md#propose_contract) | Turn a plan into a draft execution contract. |
| Contracts | [`amend_contract`](docs/tools.md#amend_contract) | Apply a versioned contract merge patch. |
| Contracts | [`freeze_contract`](docs/tools.md#freeze_contract) | Freeze the current contract after consent. |
| Runs | [`execute`](docs/tools.md#execute) | Preflight and start an authorized frozen contract. |
| Runs | [`execution_status`](docs/tools.md#execution_status) | Report progress, blockers, budget and context. |
| Runs | [`control_execution`](docs/tools.md#control_execution) | Pause, resume, steer, abort or purge a run. |
| Runs | [`resolve_escalation`](docs/tools.md#resolve_escalation) | Decide, huddle, retry, reassign or amend after an escalation. |
| Runs | [`join_execution`](docs/tools.md#join_execution) | Register an external worker and return its token once. |
| Workers (both servers) | [`read_blackboard`](docs/tools.md#read_blackboard) | Read shared run state and your inbox. |
| Workers (both servers) | [`claim_task`](docs/tools.md#claim_task) | Claim or release an external worker task. |
| Workers (both servers) | [`lease`](docs/tools.md#lease) | Request or release path leases. |
| Workers (both servers) | [`post_update`](docs/tools.md#post_update) | Post progress, notes, interfaces, needs or acknowledgements. |
| Workers (both servers) | [`run_command`](docs/tools.md#run_command) | Run structured argv or a contract check in the sandbox. |
| Workers (both servers) | [`submit_work`](docs/tools.md#submit_work) | Checkpoint or submit leased changes for checks and merging. |
| Workers (both servers) | [`escalate`](docs/tools.md#escalate) | Raise a blocker, question, conflict or emergency. |
| Completion | [`chat_completion`](docs/tools.md#chat_completion) | Call any of the six text providers directly. |
| Diagnostics | [`debug_env`](docs/tools.md#debug_env) | Inspect configuration and key presence without key values. |

## CLI

No arguments starts the orchestrator MCP server. The **8 subcommands** are documented in the [CLI reference](docs/cli.md).

| Subcommand | Purpose |
| --- | --- |
| `mcp` | Start an orchestrator or token-bound worker stdio server. |
| `hook pre-tool-use` | Check worker file access and leases using stdin hook JSON. |
| `run <exe>` | Run or recover a heads-down runner. |
| `watch <exe> --as <name>` | Wait for one orchestrator wake, printing JSON. |
| `status <exe> [--json]` | Inspect a run's tasks, budget and health. |
| `verify <exe> [--json]` | Verify execution and audit chains. |
| `purge <exe> --confirm` | Delete a finished run's worktrees, branches and log. |
| `help` | Print usage. |

## Docs

- [Getting started and registration](docs/getting-started.md)
- [Mode guides](docs/modes/meetings.md): [collaborations](docs/modes/collaborations.md), [ultraplan](docs/modes/ultraplan.md), [agent workshops](docs/modes/agent-workshops.md), [prototypes](docs/modes/prototype-mode.md), [public sessions](docs/modes/public-sessions.md)
- [Heads-down user guide](docs/heads-down.md) and [design specification](docs/design/heads-down.md)
- [Dissents and tripwires](docs/dissents.md)
- [Tool reference](docs/tools.md) and [CLI reference](docs/cli.md)
- [Configuration](docs/configuration.md) and [providers](docs/providers.md)
- [Agent personas and skills](docs/agents.md) and [session archives](docs/sessions.md)
- [Changelog](CHANGELOG.md), [threat model](docs/THREAT_MODEL.md), [security controls](docs/SECURITY_CONTROLS.md)

## Security

Read the [security policy and private reporting instructions](SECURITY.md).

## Contributing

Build and run `npm test` before a pull request. See [contributing](docs/contributing.md) for test isolation and checks.

## License

[MIT](LICENSE).
