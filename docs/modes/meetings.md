# Meetings

At the table, a meeting is a back-and-forth conversation between you and one persona. Provider and model are fixed at `start_meeting` (default provider `anthropic`).

> Start a meeting via agent-roundtable with the cfo agent. Agenda: Q3 budget review. Use Anthropic Sonnet.

Follow with “Tell the CFO that runway is 14 months at current burn and ask what they would cut first,” then “End the meeting and give me the summary.”

`mode: "debate"` makes the persona a challenger; `debate_focus` narrows the challenge. Add `prototype: true` for [prototypes](prototype-mode.md), or explicitly ask for a [public session](public-sessions.md).

## Local meetings

> Start a local meeting with product-lead about the onboarding redesign. Context: the spec in docs/onboarding.md.

Spawns the local `claude` CLI with `--system-prompt-file`, so the conversation runs on your Claude subscription. The persona file is passed verbatim. The CLI is stateless, so the whole transcript is re-sent each turn — keep local meetings short. The transcript goes in on stdin; the agent gets read-only tools (`Read`, `Glob`, `Grep`), no MCP servers and no permission prompts, and the CLI gets no provider keys unless `ROUNDTABLE_WORKER_AUTH=api_key`. The CLI runs in `ROUNDTABLE_WORKSPACE_DIR`, so relative tool paths start in that project (cwd is not an OS read boundary); when the workspace is `/` or your home directory (an MCP host may start the server in `/`), it runs in an empty directory instead. Server shutdown stops any CLI still running.


Requires `claude` on `PATH` and its own login. Follow up with `say_local` and close with `end_local_meeting`. API meetings use `say` and `end_meeting`; `list_meetings` and `list_local_meetings` list their respective active sessions.

One turn runs per session at a time; overlapping turns fail with a busy error. See [tool calls and concurrency](../tools.md) and [session archives](../sessions.md).
