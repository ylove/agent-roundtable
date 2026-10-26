# MCP tool reference

Generated from the registered definitions in `src/tools/*.ts` after building: **49 orchestrator tools**, of which **8** are also exposed by worker servers. Names, descriptions, argument types, nested fields, required fields and constraints below come from those schemas. Examples use placeholders for ids and complete plan text.

Use these through your MCP client; Claude Code names them `mcp__<server name>__<tool>`, for example `mcp__roundtable__start_meeting`. Omitted optional fields use the behavior described below. A nested field marked required is required only when its enclosing object/item is supplied. Null optional values are treated as absent. New contract, run and worker tools reject unknown arguments.

Worker examples below use the **worker server** schema, bound to its startup identity. On the orchestrator server each of the 7 execution worker tools additionally requires `execution_id` and `agent_token` from `join_execution`; keep that token private. The eighth worker tool is `file_dissent`, which also accepts orchestrator authority on the orchestrator server; see the [dissent guide](dissents.md). `join_execution` itself exists only on the orchestrator server. Every execution worker response carries new inbox decisions/directives, including errors; acknowledge directives with `post_update(kind: "ack", directive_id, text)`.

## Casting Call

### casting_call

Audition 2 to 24 personas for any brief, cross-examine them through a neutral casting director, and return redundancy, gaps and a recommended cast. Sends progress notifications on every visible step. No duel or heads-down run is started. See [Casting Call](modes/casting-call.md).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `brief` | string | yes | Brief of 1 to 4000 characters. |
| `agents` | array of string | no | 2 to 24 persona identifiers; default every persona in the directory. |
| `agents_dir` | string | no | Absolute persona directory. |
| `seats` | number | no | Whole number from 1 to persona count, at most 24; default min(5, persona count). |
| `examine` | boolean | no | Default true; ask and answer one probing question per persona. |
| `dry_run` | boolean | no | Static lint and similarity only; zero provider calls, no keys needed. |
| `provider` | string | no | `auto` (default), `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Provider model override, as in `start_duel`. |
| `seat` | object | no | Assignments keyed by persona, with `agent`, `provider` and `model` fields as in duel's `seats`. The director's key is `casting-director`. |
| `mix` | string | no | `auto` or `cheap` for cost-aware routing. |
| `turn_timeout_s` | number | no | 1 to 3600 seconds; default 90. |
| `max_seconds` | number | no | 1 to 3600 seconds; default 300. |

Returns report markdown, `archive_id`, `archive: "casting/<id>.json"`, the structured report, usage and per-seat routing reasons. The report contains `agents` (verdicts, roles, strengths, risks, overlaps and lint), `redundancy`, `gaps`, and `recommended.seats`. With at least four requested seats the director is asked for `recommended.teamA`, `teamB` and `judges`; these render a ready-to-run, shell-quoted duel command. Aborts and time limits archive available results. Invalid director JSON retries once then falls back to static checks; a failed persona is `unclear` and excluded from recommendations. The latest report and scrubbed transcript are copied to `ROUNDTABLE_HOME/casting/latest.json`.

```json
casting_call { "brief": "Build a queue module", "agents": ["architect", "engineer", "researcher", "reviewer"], "seats": 4 }
casting_call { "brief": "Draft a policy", "agents_dir": "/absolute/path/to/agents", "dry_run": true }
```

## Meetings

### start_meeting

Omitting `provider`, or passing `"provider": "auto"`, routes eligible seats automatically. The result includes `routing`, an array of seat identifiers, providers, models and short `reason` strings. Explicit seat assignments take priority; runtime seats stay explicit. Caller `base_url` requires an explicit compatible provider. See [Provider judgment](providers.md#provider-judgment).

Start a meeting with an agent. Returns a meeting ID for follow-up messages. Use this to begin a synchronous conversation with another agent (CFO, FP&A, Product, etc.). Pass mode: "debate" to have the agent stress-test your agenda as a challenger instead. Pass prototype: true to have the agent show its proposals as ephemeral prototypes that you assess.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agent` | string | yes | Agent identifier or path to prompt file. Examples: "cfo", "fpa", "product" |
| `agenda` | string | yes | The topic, question, or task to discuss with the agent. |
| `context` | string | no | Optional additional context, document content, or data to share. |
| `mode` | string | no | debate: the agent acts as a challenger and stress-tests your agenda instead of helping execute it. Default: standard. Values: `standard`, `debate`. |
| `debate_focus` | string | no | Optional: what the challenge should concentrate on (only used with mode debate). |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `prototype` | boolean | no | Default false. Prototype mode: agents show proposals as ephemeral artifacts — a scaled-down page shown in a sandboxed frame on a localhost board, the code/IaC that would produce the proposal (never executed), a Mermaid diagram, or a text draft — and the other participants (in meetings: you) give verdicts; the proposer then revises, scraps or shortlists. Results include a prototypes block with the board URL: show it to the human. Prototypes are destroyed as soon as assessment completes. Do not relay the human's feedback on prototypes into the session until it ends; end_* lists outcomes and the shortlist for the human. Combinable with public (public posts get code, diagram links and screenshots of web prototypes, never the localhost board). Not supported with mode conversation. |
| `duel` | string | no | Optional duel id (duel-...) from ROUNDTABLE_HOME/duels to make the focus of this session: a scrubbed, size-capped brief of the duel (teams, artifacts, verdicts, tally, dissents) is added to the context every participant sees, as untrusted content to discuss. An unknown or invalid id is an error before any provider call. See [a duel as a meeting's focus](modes/duel.md#a-duel-as-a-meetings-focus). |
| `duel_source` | boolean | no | Default true; only with duel. The duel brief is resent on every turn to every participant (a full brief can be about 20k tokens per turn). Set false to leave out artifact file contents and keep titles, file names and sizes, verdicts, tally and dissents. |
| `provider` | string | no | Omit or use `auto` for [provider judgment](providers.md#provider-judgment). Explicit providers retain their defaults. Values: `auto`, `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `start_meeting`

```json
{
  "agent": "cfo",
  "agenda": "Q3 budget review",
  "model": "sonnet"
}
```

### say

Continue a conversation in an active meeting. In a prototype meeting you assess the agent's prototypes: give `Verdict on Pn: APPROVE|REVISE|REJECT — reason` on its own line, grounded in the artifact and its demo; the reply ends with a Prototypes block (the board URL, live prototypes and those destroyed this call).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `meeting_id` | string | yes | The meeting ID from start_meeting. |
| `message` | string | yes | Your message to the agent. |

Example: `say`

```json
{
  "meeting_id": "<id>",
  "message": "What should we cut first?"
}
```

### end_meeting

End a meeting and optionally get a summary. Prototype meetings also return the prototype outcomes and the shortlist for the human.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `meeting_id` | string | yes | The meeting ID to close. |
| `request_summary` | boolean | no | If true, ask the agent for a summary before ending. |

Example: `end_meeting`

```json
{
  "meeting_id": "<id>",
  "request_summary": true
}
```

### list_meetings

List all active meetings.

No arguments.

Example: `list_meetings`

```json
{}
```

## Local meetings

### start_local_meeting

Start a LOCAL meeting with an agent using the installed Claude CLI. This uses your Claude Pro/Max subscription instead of API credits. Returns a meeting ID for follow-up messages. Ideal for cost-conscious lengthy conversations. Pass mode: "debate" to have the agent stress-test your agenda as a challenger instead. Pass prototype: true to have the agent show its proposals as ephemeral prototypes that you assess.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agent` | string | yes | Agent identifier or path to prompt file. Examples: "cfo", "fpa", "product" |
| `agenda` | string | yes | The topic, question, or task to discuss with the agent. |
| `context` | string | no | Optional additional context, document content, or data to share. |
| `mode` | string | no | debate: the agent acts as a challenger and stress-tests your agenda instead of helping execute it. Default: standard. Values: `standard`, `debate`. |
| `debate_focus` | string | no | Optional: what the challenge should concentrate on (only used with mode debate). |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `prototype` | boolean | no | Default false. Prototype mode: agents show proposals as ephemeral artifacts — a scaled-down page shown in a sandboxed frame on a localhost board, the code/IaC that would produce the proposal (never executed), a Mermaid diagram, or a text draft — and the other participants (in meetings: you) give verdicts; the proposer then revises, scraps or shortlists. Results include a prototypes block with the board URL: show it to the human. Prototypes are destroyed as soon as assessment completes. Do not relay the human's feedback on prototypes into the session until it ends; end_* lists outcomes and the shortlist for the human. Combinable with public (public posts get code, diagram links and screenshots of web prototypes, never the localhost board). Not supported with mode conversation. |
| `duel` | string | no | Optional duel id (duel-...) from ROUNDTABLE_HOME/duels to make the focus of this session: a scrubbed, size-capped brief of the duel (teams, artifacts, verdicts, tally, dissents) is added to the context every participant sees, as untrusted content to discuss. An unknown or invalid id is an error before any provider call. See [a duel as a meeting's focus](modes/duel.md#a-duel-as-a-meetings-focus). |
| `duel_source` | boolean | no | Default true; only with duel. The duel brief is resent on every turn to every participant (a full brief can be about 20k tokens per turn). Set false to leave out artifact file contents and keep titles, file names and sizes, verdicts, tally and dissents. |

Example: `start_local_meeting`

```json
{
  "agent": "product-lead",
  "agenda": "Onboarding redesign"
}
```

### say_local

Continue a conversation in an active LOCAL meeting (CLI-based). In a prototype meeting give `Verdict on Pn: APPROVE|REVISE|REJECT — reason` for the agent's prototypes; the reply ends with a Prototypes block.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `meeting_id` | string | yes | The local meeting ID from start_local_meeting. |
| `message` | string | yes | Your message to the agent. |

Example: `say_local`

```json
{
  "meeting_id": "<id>",
  "message": "What can ship this week?"
}
```

### end_local_meeting

End a LOCAL meeting and optionally get a summary. Prototype meetings also return the prototype outcomes and the shortlist for the human.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `meeting_id` | string | yes | The local meeting ID to close. |
| `request_summary` | boolean | no | If true, ask the agent for a summary before ending. |

Example: `end_local_meeting`

```json
{
  "meeting_id": "<id>",
  "request_summary": true
}
```

### list_local_meetings

List all active LOCAL meetings (CLI-based).

No arguments.

Example: `list_local_meetings`

```json
{}
```

## Collaborations

### start_collaboration

Omitting `provider`, or passing `"provider": "auto"`, routes eligible seats automatically. The result includes `routing`, an array of seat identifiers, providers, models and short `reason` strings. Explicit seat assignments take priority; runtime seats stay explicit. Caller `base_url` requires an explicit compatible provider. See [Provider judgment](providers.md#provider-judgment).

Start a collaboration where agents take turns responding; returns a collaboration ID. Default collaborate builds on ideas. Debate has agents[0] defend a position against challengers; waffle-house distills an idea through repeated attacks and rebuttals. Conversation is an informal chat from each agent's own situation, with short turns and no agenda or deliverable; topic is optional only in conversation mode. In conversation mode, put what you know about the agents' current situation in context (what was just built, what each agent last did). Private conversations default to grounding from workspace, memory and local activity; public conversations never get grounding, never open on the founder angle, and their directive does not ask agents to talk about the founder or whoever they report to. Pass prototype: true (not with conversation) to have agents show proposals as ephemeral prototypes that the other agents assess. Continue, nudge, inspect or end with the collaboration tools.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agents` | array of string | yes | Array of agent identifiers. Examples: ["cfo", "fpa"], ["product", "engineering", "design"] minItems: `2`. |
| `seats` | object | no | Optional assignments keyed by exact agent identifier: {"designer":{"provider":"anthropic","model":"sonnet"}}. Each entry accepts agent, provider (an API provider or explicit [CLI runtime](runtimes.md) name) and model. |
| `topic` | string | no | Required except in conversation mode, where it is an optional loose theme, not an agenda. |
| `context` | string | no | Optional background for all agents. In conversation mode, share what you know about their current situation: what was just built, what each agent last did, and current problems. |
| `grounding` | boolean | no | Conversation only, default true: send workspace, agent-memory and local activity excerpts to the session's provider as background. Set false to disable. Always disabled in public conversations. |
| `max_rounds` | number | no | Maximum rounds of discussion (each round = each agent speaks once). Default: 5 maximum: `20`. |
| `auto_run_rounds` | number | no | If set, automatically run this many rounds before returning. Otherwise returns after first agent speaks. |
| `mode` | string | no | debate: agents[0] is the proponent; every other agent is a challenger that stress-tests the proponent. waffle-house: agents[0] is the defender of an idea (the topic) and every other agent is an adversarial attacker (needs 2+ agents); each round every attacker attacks, then the defender answers the whole volley, and the session always ends on the defender's rebuttal. Speaking order is the same as collaborate; a session runs 1 + max_rounds x N agent turns. conversation: informal colleague chat grounded in each agent's own context, usually 2-6 sentences, no agenda or deliverable; topic may be omitted. Default: collaborate. Values: `collaborate`, `debate`, `waffle-house`, `conversation`. |
| `debate_focus` | string | no | Optional: what the challenge should concentrate on (only used with mode debate). |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `prototype` | boolean | no | Default false. Prototype mode: agents show proposals as ephemeral artifacts — a scaled-down page shown in a sandboxed frame on a localhost board, the code/IaC that would produce the proposal (never executed), a Mermaid diagram, or a text draft — and the other participants (in meetings: you) give verdicts; the proposer then revises, scraps or shortlists. Results include a prototypes block with the board URL: show it to the human. Prototypes are destroyed as soon as assessment completes. Do not relay the human's feedback on prototypes into the session until it ends; end_* lists outcomes and the shortlist for the human. Combinable with public (public posts get code, diagram links and screenshots of web prototypes, never the localhost board). Not supported with mode conversation. |
| `duel` | string | no | Optional duel id (duel-...) from ROUNDTABLE_HOME/duels to make the focus of this session: a scrubbed, size-capped brief of the duel (teams, artifacts, verdicts, tally, dissents) is added to the context every participant sees, as untrusted content to discuss. An unknown or invalid id is an error before any provider call. See [a duel as a meeting's focus](modes/duel.md#a-duel-as-a-meetings-focus). |
| `duel_source` | boolean | no | Default true; only with duel. The duel brief is resent on every turn to every participant (a full brief can be about 20k tokens per turn). Set false to leave out artifact file contents and keep titles, file names and sizes, verdicts, tally and dissents. |
| `provider` | string | no | Omit or use `auto` for [provider judgment](providers.md#provider-judgment). Explicit providers retain their defaults. Values: `auto`, `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `start_collaboration`

```json
{
  "agents": [
    "cfo",
    "skeptic"
  ],
  "topic": "Should we raise now?",
  "max_rounds": 3,
  "auto_run_rounds": 1
}
```

### start_duel

Omitting `provider`, or passing `"provider": "auto"`, routes eligible seats automatically. The result includes `routing`, an array of seat identifiers, providers, models and short `reason` strings. Explicit seat assignments take priority; runtime seats stay explicit. Caller `base_url` requires an explicit compatible provider. See [Provider judgment](providers.md#provider-judgment).

Run a duel and return its result: two teams each build an artifact for the same brief (a web page, code, a Mermaid diagram or a text document), judges assess both against a rubric, and the losing side files dissents. The call runs the whole duel, which can take several minutes. The result has the duel id, winner, tally, each team's artifact title, kind and ok flag, the judges' verdicts, the dissents, a usage summary and the archive id (duels/<id>.json, replayable with roundtable duel --replay). It never includes artifact source. The tool sends an MCP progress notification on every turn, artifact and verdict, so a host must either allow a long request timeout (default 600 seconds of duel, more for large teams) or reset its timeout on progress; a client with a fixed 60-second timeout will cancel the duel. No room is opened. Orchestrator server only. See [duel](modes/duel.md).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `provider` | string | no | Omit or use `auto` for [provider judgment](providers.md#provider-judgment). Explicit providers retain their defaults. Values: `auto`, `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Optional explicit model pin. |
| `topic` | string | yes | The brief both teams answer, for example a landing page for a product, a module with a given interface, or a written policy. maxLength: `4000`. |
| `team_a` | array of string | yes | Team A personas, 1 to 4. The first writes the concept, the last builds, anyone between critiques the concept. A one-person team does both. |
| `team_b` | array of string | yes | Team B personas, 1 to 4. Same roles as team_a. No persona may appear twice across both teams and the judges. |
| `judges` | array of string | yes | Judge personas, 1 to 5. |
| `kind` | string | no | What the teams build: web (a self-contained index.html, inline CSS, optional inline JS; default), code (source files, shown as read-only text and never executed), diagram (Mermaid source) or text (markdown or plain text). Values: `web`, `code`, `diagram`, `text`. |
| `criteria` | array of string | no | Judging rubric. Default: fit to the brief, quality, usability and accessibility, and risk or safety within the judge's own remit. maxItems: `8`; each item up to 120 characters. |
| `rounds` | number | no | 1 (default) judges once; 2 lets a team the judges did not approve revise once and keeps the original tally. minimum: `1`, maximum: `2`. |
| `seats` | object | no | Optional assignments keyed by exact persona identifier: {"designer":{"provider":"anthropic","model":"sonnet"}}. Each entry accepts agent, provider (an API provider or explicit [CLI runtime](runtimes.md) name) and model. |
| `turn_timeout_s` | number | no | Seconds allowed for each turn. Default 90 (builds get at least 240). maximum: `3600`. |
| `max_seconds` | number | no | Time limit for the whole duel before it moves to closings. Default 600, plus 120 per member beyond two on the larger team. minimum: `1`, maximum: `3600`. |

Example: `start_duel`

```json
{
  "topic": "One-page remote-work expenses policy",
  "team_a": ["counsel"],
  "team_b": ["hr-lead", "editor"],
  "judges": ["cfo", "employee-advocate"],
  "kind": "text",
  "criteria": ["legal accuracy", "plain language"]
}
```

### continue_collaboration

Continue an active collaboration for additional rounds. Agents take turns responding. In a prototype session it also resumes a paused session while a prototype is under assessment.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `collaboration_id` | string | yes | The collaboration ID from start_collaboration. |
| `rounds` | number | no | Number of additional rounds to run. Default: 1 maximum: `20`. |

Example: `continue_collaboration`

```json
{
  "collaboration_id": "<id>",
  "rounds": 1
}
```

### nudge_collaboration

Inject a message from the orchestrator into the collaboration. Use to redirect discussion, ask clarifying questions, or provide additional context. In a prototype session nudges are refused while a prototype is under assessment; never use a nudge to relay the human's feedback on prototypes before the session ends.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `collaboration_id` | string | yes | The collaboration ID. |
| `message` | string | yes | Your message to inject into the discussion. Will appear as from ORCHESTRATOR. |

Example: `nudge_collaboration`

```json
{
  "collaboration_id": "<id>",
  "message": "Assume a flat valuation."
}
```

### pause_collaboration

Pause a running collaboration. Resume it with nudge_collaboration (continue_collaboration only advances a running collaboration).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `collaboration_id` | string | yes | The collaboration ID to pause. |

Example: `pause_collaboration`

```json
{
  "collaboration_id": "<id>"
}
```

### end_collaboration

End a collaboration and optionally get a summary of the discussion. Prototype sessions also return the prototype outcomes and the shortlist for the human (resolved prototypes appear as stubs in the transcript).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `collaboration_id` | string | yes | The collaboration ID to end. |
| `request_summary` | boolean | no | If true, ask an agent to summarize key agreements, disagreements, and action items. |

Example: `end_collaboration`

```json
{
  "collaboration_id": "<id>",
  "request_summary": true
}
```

### get_collaboration_transcript

Get the full transcript of a collaboration without ending it.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `collaboration_id` | string | yes | The collaboration ID. |

Example: `get_collaboration_transcript`

```json
{
  "collaboration_id": "<id>"
}
```

### list_collaborations

List all active collaborations.

No arguments.

Example: `list_collaborations`

```json
{}
```

## Ultraplan

### start_ultraplan

Omitting `provider`, or passing `"provider": "auto"`, routes eligible seats automatically. The result includes `routing`, an array of seat identifiers, providers, models and short `reason` strings. Explicit seat assignments take priority; runtime seats stay explicit. Caller `base_url` requires an explicit compatible provider. See [Provider judgment](providers.md#provider-judgment).

Plan with specialist agents: you (the orchestrator) own and write the plan; agents give input before the draft, review each version, then sign off. With no draft_plan, returns input and awaiting_plan: write v1 with contributor tags such as [cfo], then call submit_plan. With draft_plan, reviews it as v1 and returns awaiting_revision. Revise in response to amendments, explaining rejected advice; call submit_plan with final: true to collect sign-offs and close. Alternatively set planner to a persona to draft/revise/sign off server-side in one call. If that run returns a step with error, the session remains open. A step with phase: "plan" returns the unreviewed latest version and previousReviews when an earlier version was reviewed. Continue with submit_plan: omit plan to review or sign off that version as-is, or pass a full revised plan; or close with end_ultraplan. Show the final document to the user verbatim, including every agent's input and sign-off. The final result ends with a JSON trailer {ultraplan_id, archived, tally}; signed off means no OBJECT and no UNCLEAR sign-off. With execution_ready: true, plans end with a roundtable-tasks block and sign-offs check it, so propose_contract { from_session: ultraplan_id } can build a contract from it. Public runs post the task and phase outputs, never context.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agents` | array of string | yes | Specialists contributing input, independent reviews and sign-offs. A planner may also be a participant. minItems: `1`. |
| `task` | string | yes | What the plan must accomplish; required and non-empty. |
| `context` | string | no | Optional background shared with the agents; never posted publicly. |
| `draft_plan` | string | no | Optional full draft: becomes v1 by orchestrator and skips the input phase. Whitespace-only counts as absent. |
| `planner` | string | no | Optional persona that owns drafting and revision server-side; runs the whole loop in one call. |
| `repo_dir` | string | no | A directory inside the repository the plan is for. When earlier postmortems of that project left lessons, a bounded "Lessons from past postmortems" section (misreadings first) is added to the context the agents plan with. Never posted publicly. |
| `duel` | string | no | Optional duel id (duel-...) from ROUNDTABLE_HOME/duels to make the focus of this session: a scrubbed, size-capped brief of the duel (teams, artifacts, verdicts, tally, dissents) is added to the context every participant sees, as untrusted content to discuss. An unknown or invalid id is an error before any provider call. See [a duel as a meeting's focus](modes/duel.md#a-duel-as-a-meetings-focus). |
| `duel_source` | boolean | no | Default true; only with duel. The duel brief is resent on every turn to every participant (a full brief can be about 20k tokens per turn). Set false to leave out artifact file contents and keep titles, file names and sizes, verdicts, tally and dissents. |
| `revision_rounds` | number | no | Planner only: review/revise cycles before sign-off, default 1, clamped to 1..3. |
| `execution_ready` | boolean | no | Default false. True when the plan will be executed heads-down: planner drafts and revisions (and your next steps) must end with a fenced roundtable-tasks JSON block of tasks, commands and interfaces, and sign-offs check it. |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `provider` | string | no | Omit or use `auto` for [provider judgment](providers.md#provider-judgment). Explicit providers retain their defaults. Values: `auto`, `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `start_ultraplan`

```json
{
  "agents": [
    "product-lead",
    "cfo",
    "skeptic"
  ],
  "task": "Plan the launch",
  "execution_ready": true
}
```

### submit_plan

Submit a full next plan version, or omit plan to review or sign off the latest version as-is without creating a version. This also recovers a stopped planner run with phase: "plan". If no version exists yet, pass plan. You write revised plans from agent input/reviews; tag contributing agents on steps and explain which amendments you accepted or rejected and why. Default final: false collects independent reviews and leaves the session awaiting_revision. Set final: true to collect sign-offs, close, and return the final markdown document; with a supplied plan this is allowed straight after input without a review. Show that final document to the user verbatim, including input and sign-offs. A failed phase leaves the previous state intact so you can retry.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `ultraplan_id` | string | yes | The ultraplanId from start_ultraplan. |
| `plan` | string | no | Optional: omit to have the latest version reviewed as-is (final false) or signed off as-is (final true), without creating a version. Pass the full next version, not a patch. If no version exists yet: No plan version exists yet; pass plan. |
| `final` | boolean | no | Default false: review and leave open. True: collect sign-offs and finalize. |

Example: `submit_plan`

```json
{
  "ultraplan_id": "<id>",
  "plan": "<complete revised plan>",
  "final": true
}
```

### end_ultraplan

Close an ultraplan WITHOUT collecting sign-offs. Returns a markdown document marked not signed off with the latest plan, agent input and revision history (or no plan if none was submitted). Show the document to the user verbatim. Use submit_plan with final: true instead when you want sign-off.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `ultraplan_id` | string | yes | The ultraplanId to close without sign-off. |

Example: `end_ultraplan`

```json
{
  "ultraplan_id": "<id>"
}
```

## Agent workshops

### create_agent

Have specialists design a new Claude Code subagent in one call: sequential contributions, architect draft, independent reviews, then revision if needed. Pass agents and task, or from_session (the id of a live collaboration or meeting, e.g. collab-4k9q2mzt, or of any ended session in the archive) to inherit participants, topic and discussion; explicit agents are combined with inherited ones. Each contributes expertise, guardrails and skills. Default write: true saves the agent to ROUNDTABLE_AGENTS_DIR and new skills to ROUNDTABLE_SKILLS_DIR; existing agents are never overwritten. write: false previews files without writes. Creation includes the destination project's .claude/skills in lookup even when the configured skills directory differs. Skill lookup follows Claude Code precedence: personal ~/.claude/skills, then .claude/skills beside the agent file when it is in .claude/agents, then ROUNDTABLE_SKILLS_DIR. Any skill found is reused, never overwritten or shadowed. Tools fail closed: a list with no allowlisted matches or a value of the wrong type is rejected and the architect retries once. Omitting tools gives the new agent tools: Read, Grep, Glob. The result reports actual paths, warnings and next delegation instructions: use Claude Code's Agent tool with the returned agent.name as subagent_type when saved in .claude/agents, or start_meeting. perform_task: true with writes starts a private meeting on the task; follow its next instructions with say and end_meeting. Public workshops post contributions, reviews and a redacted summary of the final definition (name, description, model, tools, skill names and status, contribution credits, changes and open questions), without its system prompt, skill instructions or descriptions derived from instructions; copied private passages in summary fields are withheld. They never post context, personas, fleet listings or source-session transcripts. 

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agents` | array of string | no | Contributing personas; combined with from_session participants and deduplicated. At least one participant is required. |
| `task` | string | no | What the new agent should do; required unless from_session supplies a topic. |
| `context` | string | no | Optional background for the design; never posted publicly. |
| `from_session` | string | no | Id of a live collaboration or meeting (collab-…, meeting-…) or of any ended session in the archive, whose participants and discussion should shape the agent. |
| `name` | string | no | Optional agent name hint; normalized to a slug, with a suffix on collision. |
| `rounds` | number | no | Contribution rounds, default 1, clamped to 1..3; reviews follow the architect draft. |
| `write` | boolean | no | Default true: save agent and new skills. False: return preview files and write nothing. |
| `perform_task` | boolean | no | Create + write only: start a private meeting with the new agent on its task. Default false. |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `create_agent`

```json
{
  "agents": [
    "cfo",
    "product-lead"
  ],
  "task": "Own the launch budget",
  "write": false
}
```

### improve_agent

Refine an existing Claude Code agent in one call, preserving its identity and useful instructions. By default the target reviews itself candidly; add specialists with with or inherit participants/discussion via from_session (the id of a live collaboration or meeting, or of any ended session in the archive). They suggest gaps, replacements, skills and cuts; an architect drafts the definition, participants review independently, and the architect revises if needed. The target is an agent name or a .md path inside the agents directory, <workspace>/.claude/agents, ~/.claude/agents or a directory listed in ROUNDTABLE_AGENT_PATHS. write: false previews without writes. Frontmatter is read the way Claude Code reads it, including one quoting and leading-tab recovery pass. Exactly the keys Claude Code sees are preserved; improve refuses files Claude Code cannot parse or whose frontmatter contains '---' inside a value, with an error asking you to fix the file first. Identity collision checks use the same metadata view. Model output only supplies name/description/model/tools/skills. Only one improve run per target is allowed; a second fails fast: improve_agent is already running for <key>; wait for it to finish. Default write: true saves <target>.bak-<timestamp>, then atomically replaces via a temp file and rename, keeping the original mode. If the target changed, was renamed or was deleted during the run it is not overwritten: changes go to <target>.proposed-<timestamp>, which is not an agent file and keeps the original mode; next explains recovery. Creation includes the destination project's .claude/skills in lookup even when the configured skills directory differs. Skill lookup follows Claude Code precedence: personal ~/.claude/skills, then .claude/skills beside the agent file when it is in .claude/agents, then ROUNDTABLE_SKILLS_DIR. Any skill found is reused, never overwritten or shadowed. New skills go beside a target in .claude/agents to its project's .claude/skills only if neither .claude nor .claude/skills is a symlink and the skills realpath stays inside the project. Otherwise they fall back to ROUNDTABLE_SKILLS_DIR with a warning. Results report file realpaths, warnings and next instructions. Tools fail closed: a list with no allowlisted matches or a value of the wrong type is rejected and the architect retries once. Omitting tools keeps the target's own tools line; a target without one keeps inheriting every tool, and the result warns: tools omitted: the target has no tools line, so it still inherits every tool; list tools to restrict it. Public workshops post contributions, reviews and a redacted summary of the final definition (name, description, model, tools, skill names and status, contribution credits, changes and open questions), without its system prompt, skill instructions or descriptions derived from instructions; copied private passages in summary fields are withheld. They never post context, personas, fleet listings or source-session transcripts. Public improve runs never include the target's recent activity in any prompt; contributors, reviewers and the architect point to passages rather than reproduce them. Private improve contributor prompts include recent topics and outcomes from the local activity log.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `agent` | string | yes | Existing agent name, or a .md file path inside an allowed agents directory (ROUNDTABLE_AGENTS_DIR, <workspace>/.claude/agents, ~/.claude/agents or ROUNDTABLE_AGENT_PATHS). Written targets are backed up first. |
| `with` | array of string | no | Additional specialists; combined with target (when include_self) and from_session participants. |
| `include_self` | boolean | no | Default true: the target contributes to its own refinement. If false, supply at least one participant via with or from_session. |
| `focus` | string | no | Optional aspect to improve, such as escalation rules, output quality or missing skills. |
| `context` | string | no | Optional background for refinement; never posted publicly. |
| `from_session` | string | no | Id of a live collaboration or meeting (collab-…, meeting-…) or of any ended session in the archive, supplying participants and discussion. |
| `rounds` | number | no | Contribution rounds, default 1, clamped to 1..3. |
| `write` | boolean | no | Default true: back up and update the target. False: preview files and write nothing. |
| `public` | boolean | no | Default false. Only set true when the human explicitly asks for a public session. When true, the whole session is posted live to the configured public channel and is world-readable: the topic/agenda, every agent reply, every message you send with say/nudge, and the summary. The context argument is never posted, but agents may paraphrase it in their replies, so keep context generic. Never include personal information, credentials, or private code anywhere in a public session. The result includes public.url so the human can watch live. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `improve_agent`

```json
{
  "agent": "cfo",
  "with": [
    "skeptic"
  ],
  "focus": "Escalation rules",
  "write": false
}
```

## Contracts

### propose_contract

Turn an agreed plan into a heads-down contract: a draft v1 in a new execution, which workers build in parallel once every participant consents and you freeze it. The structure comes from, in order: contract (an explicit object with tasks: the most reliable route), the last ```roundtable-tasks JSON block in plan or in the archived from_session (an ultraplan started with execution_ready: true ends with one), or a structuring call on the plan text (one retry quoting the validation errors). A contract object without tasks overlays the structure (budget, sandbox, workers, authority, scope.paths, ...). original_prompt is the human's request, verbatim (default: the session's task). repo_dir (default the workspace) resolves to its git top level and base_ref (default HEAD) to a commit. Participants default to the session's agents plus every task persona. consent: true asks each participant for `Consent: AGREE | OBJECT` (an unclear answer is re-asked once, then counts as an objection). Nothing is written to the repository: the contract lives under ROUNDTABLE_HOME/executions. Returns the contract as markdown and a JSON summary (contract_id, version, status, warnings, consent, next). Show the contract to the human before freezing.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `goal` | string | yes | The ultimate goal the contract delivers. |
| `orchestrator` | string | yes | Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it. |
| `title` | string | no | Short title; default the goal's first line. |
| `original_prompt` | string | no | The human's request, verbatim (default: from_session's task or topic). Workers see it on every task card. |
| `artifacts` | array of string | no | Repository paths or URLs the goal refers to. |
| `from_session` | string | no | Id of an archived session (an ultraplan, collaboration or meeting that has ended) whose roundtable-tasks block or plan to build from, or of an archived duel (duel-<id>): its winning artifact title becomes a decision and its dissents become draft concerns (a tie or no winner imports no decision). A duel with no contract tasks or plan gets a deterministic task plan drafted from its winning artifact (see draft_plan; no model call); a tie, no winner or no artifact drafts none. |
| `plan` | string | no | Plan text: its last roundtable-tasks block is used, else a structuring call turns it into tasks. |
| `draft_plan` | boolean | no | Duel from_session only, default true: when neither contract (with tasks) nor plan is given, draft a task plan from the winning artifact, the judges' reasons and the dissents (deterministic, no model call). False imports only the decision and dissents, and then contract or plan is required. A tie, no winner or no artifact drafts no plan. |
| `contract` | object | no | An explicit contract (roundtable.contract/1 fields: title, scope.paths, participants, teams, tasks, interfaces, decisions, validation {commands, final}, budget, authority, sandbox, workers). id, version, status and consent are set for you. |
| `parent_contract` | string | no | For a child contract: the parent contract id (with parent_task, a subcontract task of it). |
| `parent_task` | string | no | For a child contract: the parent's subcontract task this contract carries out. |
| `participants` | array of string | no | Agents who must consent (names or .md paths); task personas are always added. |
| `repo_dir` | string | no | A directory inside the repository to build in; default ROUNDTABLE_WORKSPACE_DIR. |
| `base_ref` | string | no | The commit or ref the run starts from; default HEAD. Stored as the resolved sha. |
| `consent` | boolean | no | Default false. True: ask every participant for consent right away. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `propose_contract`

```json
{
  "goal": "Ship the onboarding launch",
  "orchestrator": "main",
  "from_session": "ultraplan-<id>",
  "consent": true
}
```

### amend_contract

Amend a contract with an RFC 7396 merge patch (objects merge, arrays replace, null deletes) to produce v(N+1). Only its orchestrator may. A draft gets a new proposal; a frozen contract is amended in force: removed tasks are cancelled and the agents of affected tasks get a directive to re-read it. from_session (an archived replan or ultraplan) first replaces the structure with that session's roundtable-tasks block (pass patch: {}). id, version, status, consent, frozen, the scope's orchestrator, repository, base commit and parent, and the goal's original_prompt cannot change. Consent counts only for the version it was given on. A draft amendment needs every participant's consent again before a freeze: consent: true asks them all, and an objector who now agrees has the objection resolved by the amendment. On a frozen contract, a run-wide change (budget, scope, sandbox, authority, validation, workers, goal) needs consent: true (everyone is asked about it first, and it applies only if all agree) or override_consent: true (audited); other changes apply at once, and consent: true then asks the personas of affected tasks. patch: {} with consent: true just asks everyone without an agreement on the current version. Returns the affected tasks, the consent outcome and the contract markdown.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `contract_id` | string | yes | The contract id (ctr-<6 characters>-<n>) from propose_contract. |
| `patch` | object | yes | RFC 7396 merge patch over the latest version, e.g. {"budget": {"usd": 40}} or {"tasks": [...the full new task list...]}. |
| `reason` | string | yes | Why the contract changes; recorded and sent to affected agents. |
| `orchestrator` | string | yes | Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it. |
| `from_session` | string | no | Id of an archived replan or ultraplan whose roundtable-tasks block replaces the tasks, commands and interfaces, or of an archived duel (duel-<id>): its winning decision and dissents are added to the contract (tasks untouched, repeats skipped). A frozen contract cannot hold a concern without a tripwire: the amend is then refused whole, naming the dissents and the next call (patch.dissents with tripwires); a decision-only duel applies at once. |
| `consent` | boolean | no | Default false. True: ask participants about the new version: everyone for a draft or a run-wide change, the personas of affected tasks otherwise. |
| `override_consent` | boolean | no | Frozen contracts only, default false: apply a run-wide change (budget, scope, sandbox, authority, validation, workers, goal) without everyone's consent. Audited. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `amend_contract`

```json
{
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main",
  "patch": {
    "budget": {
      "usd": 30
    }
  },
  "reason": "Human approved the revised cap",
  "consent": true
}
```

### freeze_contract

Freeze a contract so it can be executed. Only its orchestrator can, and only once every participant has agreed to its current version. Refuses, listing every reason, while an objection or UNCLEAR answer is unresolved, a participant has not answered about the current version, a consent round is in flight (abandon_round declares a dead one abandoned), the source session is busy, or, for a child contract, while the parent is not frozen or the caller is neither the parent task's persona nor the parent's orchestrator. excuse sets objections aside, each with a reason; excusals and the frozen sha256 go to the audit log. Freezing starts nothing: the run starts with execute, when the human asks.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `contract_id` | string | yes | The contract id (ctr-<6 characters>-<n>) from propose_contract. |
| `orchestrator` | string | yes | Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it. |
| `abandon_round` | boolean | no | Default false. True: declare an unfinished consent round abandoned (its process died or hangs): its missing answers are recorded as unclear, which still need excusing, and the abandonment is audited. |
| `excuse` | array of object | no | Objections (or missing answers) to set aside: [{agent, reason}]. Each is recorded and audited. maxItems: `50`. |
| `excuse[].agent` | string | yes | The participant whose objection is excused. |
| `excuse[].reason` | string | yes | Why the run may go ahead despite it. |

Example: `freeze_contract`

```json
{
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main"
}
```

### file_dissent

File or update a structured dissent on a draft contract, creating a new version. Tripwires are data only. An agent files as its authenticated identity; an orchestrator may file for any participant. A dissent needs a tripwire before freeze or explicit excusal with a reason. Frozen contracts require `amend_contract` and consent. Available on both servers: the orchestrator server accepts `orchestrator`, or `execution_id` and `agent_token`; the worker server is already bound to its agent and accepts neither credential argument (only `contract_id`, `dissent`, `resolve_objection` and `excuse_reason`). Full behavior, tripwire kinds and freeze rules: the [dissent guide](dissents.md#file-or-update-a-concern).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `contract_id` | string | yes | The contract id (ctr-<6 characters>-<n>) from propose_contract. |
| `dissent` | object | yes | Structured concern. Omit tripwire only for a draft. With excuse_reason, pass just {id}. by is bound to an authenticated agent; orchestrators specify a participant. |
| `dissent.id` | string | yes | Stable id; filing an existing id replaces that concern. pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `dissent.by` | string | no | The dissenting participant. Filled from the identity of an authenticated agent. |
| `dissent.source` | object | no | Provenance of the concern. |
| `dissent.source.kind` | string | yes | Values: `ultraplan`, `consent`, `debate`, `waffle_house`, `duel`, `manual`. |
| `dissent.source.ref` | string | no | The session or duel id the concern came from. |
| `dissent.claim` | string | no | The concern. maxLength: `500`. |
| `dissent.predicted_failure` | string | no | What the dissenter predicts will fail. maxLength: `500`. |
| `dissent.tripwire` | object | no | The evidence that should wake the dissenter. |
| `dissent.tripwire.kind` | string | yes | Values: `check_failed`, `path_touched`, `task_state`. |
| `dissent.tripwire.check` | string | no | `check_failed`: a validation command id. |
| `dissent.tripwire.task` | string | no | A task id; limits `check_failed` and `path_touched`, and names the task for `task_state`. |
| `dissent.tripwire.paths` | array of string | no | `path_touched`: nonempty relative globs. maxItems: `64`. |
| `dissent.tripwire.state` | string | no | `task_state`: Values: `rejected`, `blocked`. |
| `dissent.on_fire` | string | no | Default huddle. Values: `notify`, `huddle`, `pause_and_huddle`. |
| `resolve_objection` | boolean | no | The objector explicitly consents to the new version with how: dissented, retaining this dissent. Other participants must re-consent. |
| `excuse_reason` | string | no | Orchestrator only: explicitly excuse this dissent by id. Its concern and this reason remain in version history and the audit log. Creates a new draft requiring re-consent. |
| `orchestrator` | string | no | Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it. Orchestrator server only. |
| `execution_id` | string | no | With agent_token: the agent's execution. Orchestrator server only. |
| `agent_token` | string | no | Authenticate as an agent instead of an orchestrator. Orchestrator server only. pattern: `^[0-9a-f]{64}$`. |

Example: `file_dissent`

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

### score_dissent

Record or revise an advisory dissent outcome on a frozen contract. Only its orchestrator may score. Scores are display-only and never weight votes or consent. Orchestrator server only. See [advisory scores](dissents.md#advisory-scores).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `contract_id` | string | yes | The contract id (ctr-<6 characters>-<n>) from propose_contract. |
| `orchestrator` | string | yes | Your name as this contract's orchestrator (e.g. main). Only the orchestrator that proposed a contract can amend or freeze it. |
| `dissent_id` | string | yes | The dissent to score. pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `outcome` | string | yes | `vindicated` (evidence supports the prediction), `refuted` (evidence contradicts it) or `untested` (the run did not establish an outcome). Values: `vindicated`, `refuted`, `untested`. |

Example: `score_dissent`

```json
{
  "contract_id": "ctr-abc123-1",
  "orchestrator": "main",
  "dissent_id": "retry-risk",
  "outcome": "vindicated"
}
```

## Runs

### execute

Start a heads-down run of a frozen contract, ONLY when the human has asked for it in this chat: confirmation is their words, verbatim (recorded in the event log and the audit log). A preflight runs first. When something is missing it returns {status: "needs_input", questions[]} and starts nothing: ask the human each question in plain words and call again with the answers. It asks when no visibility is chosen (dashboard, GitHub, or chat_only; ROUNDTABLE_DEFAULT_VISIBILITY sets a default), when no budget is set (here, in the contract, or ROUNDTABLE_DEFAULT_BUDGET_USD), when no sandbox is available (Docker down and the local sandbox not allowed with sandbox: "local"), when the worker CLI is missing or lacks flags (codex needs worker_driver: "codex"), when GitHub was asked for but gh lacks scopes or access, and when the repository has submodules. A dirty main worktree only warns. Settings given here that differ from the contract (budget_usd, max_parallel, lead, sandbox, worker_driver, worker_model) are applied to it first as one audited amendment. Then the runner starts in the background, and the result has the execution_id, the runner's pid, the dashboard URL (when there is one) and watch {argv, command, instructions}: start watch.command as a background shell command right away, re-arm it after handling each wake, and answer progress questions with execution_status. Calling it again for a started run returns the run's current info.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `contract_id` | string | yes | The frozen contract (ctr-<6 characters>-<n>). |
| `confirmation` | string | yes | The human's own words asking you to execute, quoted verbatim (e.g. "yes, go ahead and build it"). Never invent it. maxLength: `2000`. |
| `visibility` | object | no | How the human follows the run: dashboard (a local web page), github (issues and a project board), or chat_only (neither). Ask the human; dashboard and github may be combined. No unknown fields. |
| `visibility.dashboard` | boolean | no | A read-only dashboard on 127.0.0.1, served by the runner; its URL is a private capability. |
| `visibility.chat_only` | boolean | no | No dashboard and no GitHub: you keep the human posted here. |
| `visibility.github` | object | no | Mirror the run to GitHub through the gh CLI: a parent issue, one issue per task, a project board, needs-human labels and comments. No unknown fields. |
| `visibility.github.repo` | string | yes | owner/name of a repository the gh account can write to. |
| `visibility.github.project_owner` | string | no | The project's owner (default: the repository owner). |
| `visibility.github.project_number` | integer | no | An existing GitHub project to add the task issues to. minimum: `1`. |
| `visibility.github.create_project` | boolean | no | Create a project when no project_number is given. |
| `visibility.github.pr` | boolean | no | Open a pull request for the integration branch at the end. |
| `budget_usd` | number | no | The run's total budget in US dollars, as the human set it (applied to the contract). minimum: `0.01`. maximum: `100000`. |
| `max_parallel` | integer | no | Workers at once (1–16; applied to the contract). minimum: `1`. maximum: `16`. |
| `lead` | string | no | The persona that decides escalations when you are away (the contract's authority.lead). |
| `sandbox` | string | no | docker (default) or local. local is weaker than a container and counts as the human's opt-in to it. Values: `docker`, `local`. |
| `worker_driver` | string | no | Worker CLI: claude-code (default) or codex (an explicit opt-in). Values: `claude-code`, `codex`. |
| `worker_model` | string | no | Model for the workers (the CLI's model name). |

Example: `execute`

```json
{
  "contract_id": "ctr-abc123-1",
  "confirmation": "Yes, build it with a $20 cap and a dashboard.",
  "budget_usd": 20,
  "visibility": {
    "dashboard": true
  }
}
```

### execution_status

How a heads-down run is doing. Without execution_id: every run with its status. With one, view summary (default) gives weighted completion (accepted 1, submitted 0.8, otherwise the worker's percent or 0.4), blockers, the latest checks, a rough ETA, the budget, runner health, the dashboard URL and GitHub sync health; tasks, escalations, events (since_seq, limit), budget and context are the other views. focus answers questions such as "how close is the nav?": fuzzy words and prefixes matched against task ids, titles, teams, paths and interface names ("nav" finds build-nav-bar and src/components/nav/**); an escalation id as focus picks that escalation for view context. view context returns a redacted bundle (no chat, no secrets) to pass to a format at the table. Restarts the runner of a live run that lost it.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `execution_id` | string | no | The heads-down run (exe-…), as execute or execution_status returned it. pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `focus` | string | no | What the human asked about, in their words ("the nav", "api client", a task id, or an escalation id). maxLength: `200`. |
| `view` | string | no | summary (default), tasks, escalations, events, budget or context. Values: `summary`, `tasks`, `escalations`, `events`, `budget`, `context`. |
| `since_seq` | integer | no | view events: start after this sequence number (default: the latest limit events). minimum: `0`. |
| `limit` | integer | no | How many runs, tasks, escalations or events (default 20 runs, 50 otherwise). minimum: `1`. maximum: `200`. |

Example: `execution_status`

```json
{
  "execution_id": "exe-0123456789abcdef",
  "focus": "nav",
  "view": "summary"
}
```

### control_execution

Steer a heads-down run when the human asks. pause / resume: the whole run, or only task_ids (paused work starts nothing new; running workers finish their turn). steer: a directive (message) to targets (agents, teams or tasks; default every agent), which workers must acknowledge. abort: stop the run and its workers, keeping the worktrees, branches and log. purge: delete a finished (completed, failed or aborted) run's worktrees, branches and log; needs confirm: true, which only the human's agreement justifies, and is audited. stop_agent: stop the live workers named in targets (the human asked, in plain words or from the dashboard): the runner stops each worker, keeps its branch and worktree and blocks its task, and the watcher wakes you with two choices: rework around the stopped agent with resolve_escalation, or write a handoff. An external worker is told to stop through steer instead. handoff: pause the run (if live) and write executions/<exe>/HANDOFF.md from the blackboard (contract summary, goal, every task with its state, owner, branch and last note, stopped agents, open escalations, budget with provenance split, resume commands); returns its path and the document. Back to the table: pause with to_table: true (recorded in the log as a mode change), run the format with execution_status(view: "context"), amend_contract(from_session), then resume with to_table: true.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `execution_id` | string | yes | The heads-down run (exe-…), as execute or execution_status returned it. pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `action` | string | yes | pause, resume, steer, abort, purge, stop_agent or handoff. Values: `pause`, `resume`, `steer`, `abort`, `purge`, `stop_agent`, `handoff`. |
| `reason` | string | no | Why (recorded on the event). maxLength: `1000`. |
| `message` | string | no | steer: the directive, in plain words. maxLength: `4000`. |
| `task_ids` | array of string | no | pause / resume: only these tasks (default the whole run). maxItems: `100`. |
| `targets` | array of string | no | steer: agent, team or task ids (default every agent of the run). stop_agent: the agents to stop (required). maxItems: `50`. |
| `confirm` | boolean | no | purge: true once the human agreed to delete the run's worktrees, branches and log. |
| `to_table` | boolean | no | pause: going back to the table; resume: coming back. Records the mode change in the log. |
| `session` | string | no | With to_table: the at-the-table session id, recorded with the mode change. maxLength: `200`. |

Example: `control_execution`

```json
{
  "execution_id": "exe-0123456789abcdef",
  "action": "pause",
  "to_table": true,
  "reason": "Review the API design"
}
```

Stopping and handing off:

```json
{
  "execution_id": "exe-0123456789abcdef",
  "action": "stop_agent",
  "targets": [
    "w-build-nav-bar"
  ],
  "reason": "The human asked to stop it"
}
```

### resolve_escalation

Answer an escalation the watcher woke you for (execution_status(view: "escalations") lists them). action: decide (decision is the answer, delivered to the requester, who resumes), huddle (a format with participants: micro by default, or meeting, collaborate, debate, waffle-house, conversation, replan, ultraplan; calls the provider), retry, reassign (participants[0] takes the task over), amend (amendment is a merge patch of the contract), dismiss, or await_human (only when the human must act). resolved_by defaults to the contract's orchestrator. An escalation already resolved is returned unchanged. The runner applies any resume, retry or stop on its next tick.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `execution_id` | string | yes | The heads-down run (exe-…), as execute or execution_status returned it. pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `escalation_id` | string | yes | The escalation (esc-…). maxLength: `128`. |
| `action` | string | yes | decide, huddle, retry, reassign, amend, dismiss or await_human. Values: `decide`, `huddle`, `retry`, `reassign`, `amend`, `dismiss`, `await_human`. |
| `decision` | string | no | decide: the answer; otherwise the resolution text the requester sees. maxLength: `2000`. |
| `format` | string | no | huddle: the format (default micro). Values: `micro`, `meeting`, `collaborate`, `debate`, `waffle-house`, `conversation`, `replan`, `ultraplan`. |
| `participants` | array of string | no | huddle: the personas taking part; reassign: [the persona taking the task over]. maxItems: `12`. |
| `amendment` | object | no | amend: an RFC 7396 merge patch of the contract (as for amend_contract). |
| `resolved_by` | string | no | Who resolves: the contract's orchestrator (default) or its lead. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `resolve_escalation`

```json
{
  "execution_id": "exe-0123456789abcdef",
  "escalation_id": "esc-example",
  "action": "decide",
  "decision": "Keep the existing response schema."
}
```

### join_execution

Register an external worker (for example this chat, or another host) in a heads-down run. Returns an agent_token ONCE: pass it with execution_id to every worker tool (read_blackboard, claim_task, lease, post_update, run_command, submit_work, escalate, spawn_subtasks, await_subtasks). With task_id, the task's worktree is created (or reused) and its task card returned. External workers are not sandboxed: their leases are checked when they submit.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `execution_id` | string | yes |  pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `agent` | string | yes | Your agent id in the run. pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `team` | string | no | An existing team of the contract. maxLength: `64`. |
| `task_id` | string | no |  pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |

Example: `join_execution`

```json
{
  "execution_id": "exe-0123456789abcdef",
  "agent": "reviewer"
}
```

## Previews

Orchestrator server only. A task's build or a duel prototype runs its dev server in a locked-down Docker container published on `127.0.0.1` only; see [previews](previews.md) for what is isolated and the limits.

### start_preview

Runs `npm run <script>` (`dev`, `start` or `preview`; never a free-form command) for a task's worktree (`execution_id` and `task_id`) or a prototype directory under the prototype root (`prototype`, absolute). Installs dependencies in a container, with scripts off and only the npm registry reachable, when the source has no installed `node_modules` directory. Returns `preview_id`, `url`, `shows`, `script`, `container_port`, `started_at`, `idle_ttl_min` and the `page_check` record.

| Field | Type | Notes |
| --- | --- | --- |
| `execution_id` | string `exe-…` | With `task_id`. |
| `task_id` | string | The task whose worktree to preview. |
| `prototype` | string | Instead of a task: an absolute prototype directory. |
| `script` | `dev` \| `start` \| `preview` | Default: the first the package defines. |
| `port` | integer 1024–65535 | Container port; default the dev server's usual port, else 3000. |

```json
start_preview { "execution_id": "exe-0123456789abcdef", "task_id": "frontend" }
start_preview { "prototype": "<prototype root>/<session>/P2v1", "script": "start", "port": 8080 }
```

### list_previews

Takes no arguments. Lists the running previews and counts as use (restarts their idle time).

### stop_preview

`{ "preview_id": "prv-…" }` stops the preview and removes its containers and network.

## Usage

### usage

Who is using what, on which platform, for the heads-down runs and the sessions at the table. action report (default) returns the usage view: totals, platforms (provider and models), and one entry per agent with its tokens and money, where it works (heads-down, at-the-table or the host), its state and whether it can be stopped, plus recent stops. Every figure says whether it is measured (counted by whoever did the work), reported (told to us by an agent or the host) or estimated (worked out by us); a total that mixes them shows the split. Money for a model with no price is absent: you get its tokens instead. Narrow it with execution_id, session_id or agent ("what has cfo cost so far?"). Nothing in it is message text, a prompt, a diff or command output. stop (only when the human asks you to stop an agent): stops agent, a heads-down worker (the runner stops it, keeps its work, and wakes you with two choices) or an at-the-table session (its turn in flight is cut and the session ends; name execution_id or session_id when the agent is in more than one place). A stopped session answers {status: "stopped", …} to its next tool call. handoff: write a handoff document, for a stopped or ended session (session_id: sessions/<id>.handoff.md) or for a heads-down run (execution_id: HANDOFF.md, without pausing it; control_execution(action: "handoff") pauses first).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `action` | string | no | report (default), stop or handoff. Values: `report`, `stop`, `handoff`. |
| `execution_id` | string | no | Only this heads-down run (exe-…). pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `session_id` | string | no | Only this at-the-table session. maxLength: `100`. |
| `agent` | string | no | report: only this agent (persona or worker id). stop: the agent to stop (required). maxLength: `100`. |
| `reason` | string | no | stop: why (recorded on the stop and shown to the orchestrator). maxLength: `1000`. |

Example: `usage`

```json
{
  "action": "report"
}
```

Stop an agent and write a handoff:

```json
{
  "action": "stop",
  "agent": "cfo",
  "reason": "The human asked to stop it"
}
```

```json
{
  "action": "handoff",
  "session_id": "meeting-4k9q2mzt"
}
```

## Postmortem

[Postmortem mode](modes/postmortem.md) is off by default. Both tools reject unknown arguments and exist only on the orchestrator server.

### postmortem

Postmortem mode: while testing sends fixers back, you keep a running draft of every finding; when all fixers are done the agents that did the work meet with you (hold_postmortem) and leave actionable artifacts, kept per project and read back before the next plan. Off by default: action enable turns it on for a project ONLY when the human asked for postmortem meetings, retrospectives, or agents improving themselves or each other; reason quotes their words verbatim (recorded in the project's log and the audit log). Nothing infers it. A heads-down run inherits it from its contract (propose_contract sets it); the runner then records a finding by itself when a submission is sent back after testing. disable turns it off and keeps stored postmortems. record adds a finding to the draft of a scope (execution_id for a run, or work for at-the-table work): {summary, detected_by, responsible[] (persona names, or "orchestrator"), category, task?, evidence[] (refs only: sha256: blob refs, event ids, commit shas, paths)}. fix sets a finding's fix {status: pending|fixed|abandoned, by?, ref?}; in a run, retries, merges and failures update fixes by themselves. draft returns the findings, what is still pending and whether the meeting can be held. lessons returns the active lessons of a project (always, whether or not the mode is on); list shows its drafts and postmortems; read returns a postmortem's full record (every turn) for you to show the human verbatim.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `action` | string | yes | enable, disable, record, fix, draft, lessons, list or read. Values: `enable`, `disable`, `record`, `fix`, `draft`, `lessons`, `list`, `read`. |
| `project` | string | no | The project: a directory inside its git repository (resolved with git rev-parse --show-toplevel; refused outside a git work tree or with submodules), or a project key returned earlier. maxLength: `1000`. |
| `execution_id` | string | no | The heads-down run (exe-…) the draft belongs to. Give this or work. pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `work` | string | no | A short label for at-the-table work (for example "checkout redesign") when there is no run. Give this or execution_id. maxLength: `200`. |
| `reason` | string | no | enable / disable: the human's own words asking for it (or for turning it off), quoted verbatim. Never invent it. maxLength: `2000`. |
| `finding` | object | no | record: the finding. No unknown fields. |
| `finding.summary` | string | yes | What went wrong, in at most 600 characters. maxLength: `600`. |
| `finding.detected_by` | string | yes | The check, test or reviewer that caught it. maxLength: `300`. |
| `finding.responsible` | array of string | yes | The agents whose work was sent back: persona names, or "orchestrator" for your own part. maxItems: `20`. |
| `finding.category` | string | yes | prompt_misread, project_misread, contract_ambiguity, implementation, test_gap or process. The first three are flagged and warn future plans. Values: `prompt_misread`, `project_misread`, `contract_ambiguity`, `implementation`, `test_gap`, `process`. |
| `finding.task` | string | no | The heads-down task id, when the finding is about one. |
| `finding.evidence` | array of string | no | Refs only: sha256: blob refs, event ids, commit shas or repository paths. Command output is refused. maxItems: `20`. |
| `finding_id` | string | no | fix: the finding (pmf-…). maxLength: `40`. |
| `fix` | object | no | fix: the finding's fix. No unknown fields. |
| `fix.by` | string | no | Who fixes it (an agent, a task, or yourself). maxLength: `200`. |
| `fix.status` | string | yes | pending, fixed or abandoned. Values: `pending`, `fixed`, `abandoned`. |
| `fix.ref` | string | no | A ref to the fix: a commit sha, an event id or a path. maxLength: `300`. |
| `pm` | string | no | read: the postmortem (pm-…) hold_postmortem returned. pattern: `^pm-[0-9a-hjkmnp-tv-z]{8}$`. |

Example: `postmortem`

```json
{
  "action": "record",
  "project": "/work/checkout",
  "execution_id": "exe-0123456789abcdef",
  "finding": {
    "summary": "The nav bar ignored the mobile breakpoint",
    "detected_by": "check unit",
    "responsible": ["builder"],
    "category": "implementation",
    "task": "build-nav-bar"
  }
}
```

### hold_postmortem

Hold the postmortem meeting for a draft, then conclude it. Refused while any finding's fix is pending or a task with a finding is still running (the error names what); a draft with no findings closes with no meeting. action hold (default): every agent named in a finding, every agent that did the original work in the run (or the participants you pass), and you sit at the table. opening is your account of what happened, including your own part: turn 0. The format is waffle-house when exactly one agent is responsible for every finding (it defends, the others challenge, your opening is the charge), otherwise collaborate for rounds (default 2, 1-4); format forces either. The meeting is private and takes no outside input: the human has no seat, nothing they type reaches it, and its context never carries their chat, confirmation or original request. It ends with an artifact block, one line each: Artifact: <kind> | <target> | <finding ids> | <text>. Kinds: fix (follow-up), rule and contract rule (project lessons, read before the next plan and contract), persona addendum (appended to an agent's persona file under ## Postmortem addenda, with a backup), agent rule (shown in that agent's task card), memory (the agent's memory file; memory_target: "claude" also writes the repository's .claude/agent-memory). For a dissent assessment: `Artifact: dissent_score | <dissent id> | <finding ids> | <vindicated/refuted/untested> | <evidence>`. The reviewed run’s dissents are included. Accepting one requires project opt-in and `orchestrator` (the reviewed contract’s orchestrator identity); it uses the same scoring path as `score_dissent`, with an audit per application and retry deduplication. Scores are advisory and never change votes, consent thresholds or routing. The result has the transcript, the proposed artifacts and any lines that could not be used. action conclude: pm, your closing statement, and accept[] (artifact ids) / reject[{id, why}]. Only accepted artifacts take effect, each audited. The result has a summary and the record path to relay to the human, who can read every turn (postmortem read).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `action` | string | no | hold (default) or conclude. Values: `hold`, `conclude`. |
| `project` | string | no | The project: a directory inside its git repository (resolved with git rev-parse --show-toplevel; refused outside a git work tree or with submodules), or a project key returned earlier. |
| `execution_id` | string | no | The heads-down run (exe-…) the draft belongs to. Give this or work. pattern: `^exe-[0-9a-hjkmnp-tv-z]{16}$`. |
| `work` | string | no | A short label for at-the-table work (for example "checkout redesign") when there is no run. Give this or execution_id. maxLength: `200`. |
| `opening` | string | no | hold: your account of what happened, including your own part. Do not paste the human's words. maxLength: `8000`. |
| `participants` | array of string | no | hold: agents to seat in addition to those named in findings (for at-the-table work: everyone who did it). maxItems: `12`. |
| `format` | string | no | hold: force a format (default: waffle-house for a single responsible agent, else collaborate). Values: `collaborate`, `waffle-house`. |
| `rounds` | integer | no | hold: rounds (default 2). minimum: `1`. maximum: `4`. |
| `memory_target` | string | no | hold: with "claude", accepted memory artifacts are also appended to `<repo>/.claude/agent-memory/<agent>/MEMORY.md` (refused through symlinks). Values: `claude`. |
| `pm` | string | no | conclude: the postmortem (pm-…) hold returned. pattern: `^pm-[0-9a-hjkmnp-tv-z]{8}$`. |
| `orchestrator` | string | conditional | conclude: required when accepting `dissent_score` artifacts; the reviewed contract’s orchestrator identity, as for `score_dissent`. |
| `closing` | string | no | conclude: your closing statement, the last turn of the record. maxLength: `4000`. |
| `accept` | array of string | no | conclude: ids of the artifacts to apply (a1, a2, …). maxItems: `20`. |
| `reject` | array of object | no | conclude: artifacts you turn down, each with why. maxItems: `20`. |
| `reject[].id` | string | yes | The artifact id. maxLength: `16`. |
| `reject[].why` | string | yes | Why not. maxLength: `400`. |
| `provider` | string | no | LLM provider. Default: anthropic. Options: anthropic, openai, together, replicate, ollama (local, when reachable), openai_compatible (set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `hold_postmortem`

```json
{
  "project": "/work/checkout",
  "execution_id": "exe-0123456789abcdef",
  "opening": "I wrote the brief loosely and the builder read it as desktop only; I also merged without a layout check."
}
```

Then conclude it:

```json
{
  "action": "conclude",
  "pm": "pm-0123abcd",
  "closing": "Agreed: breakpoints go into every acceptance list from now on.",
  "accept": ["a1", "a2"],
  "reject": [{ "id": "a3", "why": "the tester already does this" }]
}
```

## Workers (both servers)

### read_blackboard

Read the shared blackboard of this heads-down run: what every task, team and agent is doing. section: summary (default), goal, contract, tasks, task (task_id, default yours), interfaces, decisions, leases, claims, files, diffs, checks, escalations, notes, inbox, budget, agents, teams, events (filters: since_seq, limit, task_id, query = event type prefix), blob (ref: a sha256:… ref from an event; redacted, at most 16 KB), or query: fuzzy matching over tasks, teams, paths and interfaces ("is the nav done?").

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `section` | string | no | Default summary (query when only query is given, blob when only ref is). Values: `summary`, `goal`, `contract`, `tasks`, `task`, `interfaces`, `decisions`, `leases`, `claims`, `files`, `diffs`, `checks`, `escalations`, `notes`, `inbox`, `budget`, `agents`, `teams`, `events`, `blob`, `query`. |
| `query` | string | no | Free text for section query or tasks/files filters; an event type prefix for events. maxLength: `500`. |
| `task_id` | string | no | A task (task, checks, diffs, escalations and events filter on it). pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `ref` | string | no | Blob ref for section blob. pattern: `^sha256:[0-9a-f]{64}$`. |
| `since_seq` | integer | no | events and notes: only after this seq. minimum: `0`. |
| `limit` | integer | no | Default 50. minimum: `1`. maximum: `200`. |

Example: `read_blackboard`

```json
{
  "section": "tasks",
  "limit": 20
}
```

### claim_task

External agents only: claim a ready task (all dependencies accepted, nobody holding it) or, with release: true, give yours back (its leases are released; the work stays in the worktree). Without task_id, the first ready task (your team's first) is claimed. Returns the task card and the worktree to work in. External workers' claims expire after 15 minutes without a tool call.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `task_id` | string | no |  pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `release` | boolean | no | Release your claim instead. |
| `note` | string | no | Why you release it (recorded). maxLength: `2000`. |

Example: `claim_task`

```json
{
  "task_id": "nav"
}
```

### lease

Request or release leases on repository paths (globs: **, * and ?; no braces). You may edit only what your leases cover; .git* metadata needs a lease that names it. A request that conflicts with another agent's lease is queued (FIFO), and the response names the holders: then escalate(with: "path_owner"). release takes lease ids or globs ("**" releases all of yours).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `action` | string | yes |  Values: `request`, `release`. |
| `paths` | array of string | yes |  maxItems: `64`. |
| `mode` | string | no | Default exclusive. Shared leases conflict only with exclusive ones. Values: `exclusive`, `shared`. |
| `reason` | string | no |  maxLength: `500`. |

Example: `lease`

```json
{
  "action": "request",
  "paths": [
    "src/components/nav/**"
  ],
  "reason": "Build the nav"
}
```

### post_update

Post to the blackboard. kind progress: percent and text. note: a broadcast note (topic, refs). interface: publish an interface you own (name, text = its definition, path), which unblocks tasks waiting on it. need: say you are waiting for a task, interface or artifact (name; topic = task | interface | artifact), which blocks your task until it arrives. ack: acknowledge a directive (directive_id). usage (external workers only): report what you have used since your last report (tokens, usd, model); it is recorded as reported, not measured, and counts toward the budget.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `kind` | string | yes |  Values: `progress`, `note`, `interface`, `need`, `ack`, `usage`. |
| `text` | string | no | Required for every kind except usage. maxLength: `16000`. |
| `tokens` | object | no | usage: tokens used since your last report. |
| `tokens.input` | integer | no |  minimum: `0`. |
| `tokens.output` | integer | no |  minimum: `0`. |
| `tokens.cache_read` | integer | no |  minimum: `0`. |
| `tokens.cache_write` | integer | no |  minimum: `0`. |
| `usd` | number | no | usage: the cost in US dollars since your last report, if you know it (else it is priced from the table). minimum: `0`. |
| `model` | string | no | usage: the model that did the work. maxLength: `200`. |
| `percent` | number | no |  minimum: `0`. maximum: `100`. |
| `topic` | string | no |  maxLength: `100`. |
| `name` | string | no | interface: its name; need: the task, interface or artifact you wait for. maxLength: `200`. |
| `owner` | string | no | need: expected publishing task. pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `path` | string | no | interface: where it lives in the repository. maxLength: `512`. |
| `refs` | array of string | no |  maxItems: `20`. |
| `directive_id` | string | no |  maxLength: `100`. |

Example: `post_update`

```json
{
  "kind": "progress",
  "percent": 50,
  "text": "Keyboard navigation works; checking focus order."
}
```

An external worker reports what it has used (recorded as reported, never measured; counts toward the budget):

```json
{
  "kind": "usage",
  "tokens": {
    "input": 12000,
    "output": 1800
  },
  "usd": 0.4,
  "model": "my-model"
}
```

### run_command

Run a command in the sandbox, in your task worktree (there is no shell). command_id runs a contract command (recorded as a check of your task); argv runs an ad-hoc program with its arguments. Returns the exit code, a failure signature and the last ~8 KB of output; the full output is stored as a blob (read_blackboard section blob).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `command_id` | string | no | A contract validation command. pattern: `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `argv` | array of string | no | Program and arguments (no shell strings). maxItems: `256`. |
| `timeout_s` | number | no | Default the command's own timeout, or 600 s for argv. minimum: `1`. maximum: `900`. |

Example: `run_command`

```json
{
  "command_id": "test-nav"
}
```

### submit_work

Commit your leased changes and submit them. ready: true submits the task: the diff is recorded and your task's checks run in the sandbox (at most 15 minutes); if they pass, the runner merges it; if one fails, fix it and submit again. Changes outside your leases reject the submission. ready: false only saves a checkpoint commit.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `summary` | string | yes | What you did: the commit message and the submission note. maxLength: `16000`. |
| `ready` | boolean | yes |  |

Example: `submit_work`

```json
{
  "summary": "Add accessible primary navigation",
  "ready": true
}
```

### spawn_subtasks

Delegate through the runner, authenticated like the other worker tools. Requires a frozen contract with `budget.max_agents >= 2`. Returns `{children: ["parent.child", ...]}` and records `task.spawned` on the blackboard.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `subtasks` | array | yes | 1–8 objects with `id`, `title`, `instructions`, `paths`, and optional `depends_on`. |
| `subtasks[].id` | string | yes | Slug of lowercase letters, digits, `_` or `-`; namespaced under the parent, at most 64 characters including the prefix. |
| `subtasks[].title` | string | yes | At most 200 characters. |
| `subtasks[].instructions` | string | yes | At most 4000 characters. |
| `subtasks[].paths` | string[] | yes | Nonempty relative globs inside the parent's current leases, without sibling overlaps. |
| `subtasks[].depends_on` | string[] | no | Other sibling slugs in this call, without cycles. |

Children inherit checks and use ordinary workers under `max_agents`. Depth is limited to one; open children, exhausted budgets and `max_subtasks` refuse further spawns. Delegated paths cannot be written or released by the parent until the children finish. Worker `Task` and `Agent` tools stay disallowed.

### await_subtasks

Wait for the latest child batch and request fan-in through the runner. Each child has `id`, `status`, `files`, `merged`, and a scrubbed `summary` when finished. `still_running: true` means call again. `ready: true` means every child merged and the runner merged integration into the parent's worktree. Failed or cancelled children are returned for the parent to retry with new ids or escalate. Merge conflicts escalate. The parent cannot submit before open children finish and merged work is brought back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `timeout_s` | number | no | Seconds to wait, default 30, between 0 and 120. A timeout returns current status. |

On the orchestrator server, both tools also require `execution_id` and `agent_token`; the worker server binds them to its token identity.

### escalate

Raise an escalation when you are blocked or something is unclear. kind: blocker, ambiguity, resource, conflict, assistance or emergency; with: orchestrator, management, team, agent or path_owner (target: the agent or path). blocking: true blocks your task: end your turn with a one-line summary and you will be resumed with the resolution. emergency: money, credentials, scope or human_action.

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `kind` | string | yes |  Values: `blocker`, `ambiguity`, `resource`, `conflict`, `assistance`, `emergency`. |
| `with` | string | yes |  Values: `orchestrator`, `management`, `team`, `agent`, `path_owner`. |
| `summary` | string | yes |  maxLength: `4000`. |
| `target` | string | no |  maxLength: `200`. |
| `question` | string | no |  maxLength: `4000`. |
| `options` | array of string | no |  maxItems: `10`. |
| `diagnostics` | object | no |  No unknown fields. |
| `diagnostics.error_output` | string | no |  maxLength: `64000`. |
| `diagnostics.command_id` | string | no |  maxLength: `100`. |
| `diagnostics.files` | array of string | no |  maxItems: `200`. |
| `diagnostics.notes` | string | no |  maxLength: `8000`. |
| `blocking` | boolean | no | Default false. |
| `emergency` | string | no |  Values: `money`, `credentials`, `scope`, `human_action`. |

Example: `escalate`

```json
{
  "kind": "assistance",
  "with": "path_owner",
  "target": "src/api/navigation.ts",
  "summary": "Need the response shape",
  "blocking": true
}
```

## Completion

### chat_completion

Call an LLM for text completion. Providers: anthropic (claude-opus-5-5 / claude-sonnet-5-5), openai (gpt-5.6-luna), together (Together AI), replicate (any Replicate text model), ollama (local, optional), openai_compatible (any /v1/chat/completions server).

| Argument | Type | Required | Meaning and constraints |
| --- | --- | --- | --- |
| `messages` | array of object | yes | Array of messages in the conversation. |
| `messages[].role` | string | yes |  Values: `system`, `user`, `assistant`. |
| `messages[].content` | string | yes |  |
| `provider` | string | no | LLM provider to use. Default: openai. Options: anthropic; openai; together (Together AI — any Together model id, e.g. zai-org/GLM-5.3 or Qwen/...); replicate (owner/name, owner/name:version, or https://replicate.com/owner/name); ollama (local, only when reachable); openai_compatible (any /v1/chat/completions server — set OPENAI_COMPATIBLE_BASE_URL or pass base_url). Values: `anthropic`, `openai`, `together`, `replicate`, `ollama`, `openai_compatible`. |
| `model` | string | no | Model id. Defaults: claude-sonnet-5-5 (anthropic), gpt-5.6-luna (openai), zai-org/GLM-5.3 (together), qwen/qwen3-235b-a22b-instruct-2507 (replicate), qwen3:14b (ollama), default (openai_compatible). Model aliases: "opus" (claude-opus-5-5), "sonnet" (claude-sonnet-5-5), "haiku" (claude-haiku-5-5). Replicate accepts owner/name, owner/name:version, or a https://replicate.com/owner/name URL. |
| `max_tokens` | integer | no | Maximum tokens in the response, 1–32768; values outside the range are refused. Default: ROUNDTABLE_MAX_TOKENS (8192). Thinking/reasoning tokens count against this. |
| `temperature` | number | no | Sampling temperature (0-2); values outside the range are refused. Ignored for anthropic (current Claude models reject it); some OpenAI reasoning models reject it too. Replicate: sent only when the model's schema declares it. |
| `base_url` | string | no | Only with provider "openai_compatible": base URL of an OpenAI-compatible /v1 endpoint (e.g. http://localhost:1234/v1). Overrides OPENAI_COMPATIBLE_BASE_URL for this session/call. OPENAI_COMPATIBLE_API_KEY, if set, is sent only to the OPENAI_COMPATIBLE_BASE_URL origin or one listed in ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS; any other base URL gets no Authorization header and must be https (http only to loopback, or to private addresses with ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1), never a cloud metadata or (without that setting) private address. |

Example: `chat_completion`

```json
{
  "provider": "openai_compatible",
  "base_url": "http://localhost:1234/v1",
  "model": "local-model",
  "messages": [
    {
      "role": "user",
      "content": "Hello."
    }
  ]
}
```

## Diagnostics

### debug_env

Debug tool to check server environment and API key status.

No arguments.

Example: `debug_env`

```json
{}
```

## Workflow notes

### Meetings (API-backed)

The caller talks to one agent persona. Provider and model are fixed at `start_meeting` (automatic provider judgment when omitted).


### Local meetings (no API spend)

Spawns the local `claude` CLI with `--system-prompt-file`, so the conversation runs on your Claude subscription. The persona file is passed verbatim. The CLI is stateless, so the whole transcript is re-sent each turn — keep local meetings short. The transcript goes in on stdin; the agent gets read-only tools (`Read`, `Glob`, `Grep`), no MCP servers and no permission prompts, and the CLI gets no provider keys unless `ROUNDTABLE_WORKER_AUTH=api_key`. The CLI runs in `ROUNDTABLE_WORKSPACE_DIR`, so relative tool paths start in that project (cwd is not an OS read boundary); when the workspace is `/` or your home directory (an MCP host may start the server in `/`), it runs in an empty directory instead. Server shutdown stops any CLI still running.


### Collaborations (agent-to-agent)

Two or more personas take turns on a topic. One provider/model is used for the whole session.


`max_rounds` and `rounds` are capped at 20.

One turn runs per session at a time. While a turn is in flight, `continue_collaboration`, `nudge_collaboration`, `end_collaboration`, `say`, `end_meeting`, `say_local` and `end_local_meeting` on that session fail at once with `<Session> <id> is busy: a turn is still running. Wait for it to finish, then retry.`, without queueing. `pause_collaboration` and the list and transcript tools still work.

### Ultraplan tools


### Agent workshop tools


### Contracts (heads-down)

A contract is what a heads-down run builds: the goal and the human's request verbatim, tasks (persona, dependencies, write paths, acceptance criteria, checks), interfaces, decisions, validation commands (structured argv), budget and the lead's authority. Every participant must answer `Consent: AGREE` or `Consent: OBJECT` on its current version before the orchestrator that proposed it can freeze it: an agreement to an earlier version does not count. Contracts live under `ROUNDTABLE_HOME/executions/<exe>/contracts/<ctr>/` (`v<N>.json` and `CONTRACT.md`); nothing is written to the repository. These tools take no unknown arguments.


- `propose_contract` takes the structure from an explicit `contract` object with tasks, then from the last `roundtable-tasks` block in `plan` or in the archived `from_session`, then from a structuring call on the plan (one retry quoting the errors). It resolves `repo_dir` to its git top level and `base_ref` (default `HEAD`) to a commit. `consent: true` asks every participant right away; an unclear answer is re-asked once, then counts as an objection. When the repository's project has [postmortem](modes/postmortem.md) lessons, the result gains a `postmortem_lessons` section, every active contract rule becomes a `decisions` entry (`by: "postmortem:<pm>"`) and every flag a warning; with the mode on, the draft contract carries `postmortem: {enabled: true}`.
- `amend_contract` applies an RFC 7396 merge patch and makes v(N+1). Amending a draft makes a new proposal that everyone must consent to again (`consent: true` asks them all). Amending a frozen contract cancels the tasks it removes and tells the agents of affected tasks to re-read the contract; a change to its budget, scope, sandbox, authority, validation, workers or goal needs `consent: true` (everyone is asked first, and it applies only if all agree) or `override_consent: true` (audited). `patch: {}` with `consent: true` asks everyone who has not agreed to the current version.
- `freeze_contract` lists every reason it refuses: an unresolved objection or unclear answer, a participant who has not answered about the current version, a consent round in flight, a busy source session, or, for a child contract, a parent that is not frozen. `excuse` sets these aside with a reason, and `abandon_round` ends a consent round whose process died. Excusals, abandoned rounds and the frozen sha256 are written to the audit log. Freezing starts nothing.
- `file_dissent` files, completes or excuses a draft concern; `score_dissent` records an advisory outcome after freeze. Neither changes consent weight. See the [dissent guide](dissents.md).

### Heads-down runs

- `execute` starts a frozen contract when the human asks; it returns `needs_input` questions until visibility, budget, sandbox and the worker CLI are settled, then the runner and the `watch` command to run in the background.
- `execution_status` reports progress (`focus: "nav"` answers "how close is the nav?") with the views summary, tasks, escalations, events, budget and context.
- `control_execution` pauses, resumes, steers, aborts or purges a run; `to_table: true` marks a trip back to the table. `stop_agent` stops live workers the human named, and `handoff` pauses the run and writes `HANDOFF.md`.
- `resolve_escalation` answers an escalation: decide, huddle, retry, reassign, amend, dismiss or await_human.

Arguments and behaviour: [heads-down design, §13 and §15](design/heads-down.md#13-orchestrator-experience).

### Usage

- `usage` answers "what has cfo cost so far?" (`action: "report"`, narrowed with `agent`, `execution_id` or `session_id`), stops an agent when the human asks (`action: "stop"`) and writes a handoff for a stopped session or a run (`action: "handoff"`). Every figure is labelled measured, reported or estimated. A stopped at-the-table session answers `{status: "stopped", …}` to the next call that names it. See the [usage guide](usage.md). Its `agents[].calls` entries include bounded call ids, dissent micro-huddle source, dissent id, execution/task, charged requester, provider/model, USD, `estimated`, `reservation` and provenance. `agents[].platforms` keeps driver and persona platform totals distinct. Settlements replace outstanding estimates by call id. Stop on either micro-huddle participant routes the unresolved huddle and preserves dissent holds for explicit escalation resolution.

### Postmortem

- `postmortem` turns the mode on for a project (only when the human asks, quoting their words), keeps the running draft of findings, and returns lessons, listings and records. `hold_postmortem` runs the meeting once every fix has settled and concludes it with your decisions. A postmortem session takes no outside input: `nudge_collaboration`, `continue_collaboration`, `say` and `say_local` refuse it and `list_collaborations` does not show it. See [Postmortem mode](modes/postmortem.md).

### LLM


### Diagnostics


`debug_env` returns version, whether each key is configured (presence only, never any part of the value), Ollama reachability, default models, agents/skills/workspace dirs, activity log path or `off`, `sessions_dir` (the session archive), parallel turn limit, active sessions including ultraplans, public-session publisher settings, a `prototypes` block: `dir`, `chrome` (the detected binary or `null`), `screenshots`, `open_browser`, `ttl_ms`, `active_boards`.

## Tool call examples

A meeting with one persona on Anthropic Sonnet:

```json
start_meeting { "agent": "cfo", "agenda": "Q3 budget review", "provider": "anthropic", "model": "sonnet" }
say           { "meeting_id": "<id>", "message": "Runway is 14 months at current burn. What would you cut first?" }
end_meeting   { "meeting_id": "<id>", "request_summary": true }
```

A collaboration between two personas, one round run immediately, then continued:

```json
start_collaboration    { "agents": ["cfo", "skeptic"], "topic": "Should we raise now?", "max_rounds": 3, "auto_run_rounds": 1 }
continue_collaboration { "collaboration_id": "<id>", "rounds": 2 }
```

A direct completion on Replicate, addressing the model by its page URL:

```json
chat_completion {
  "provider": "replicate",
  "model": "https://replicate.com/qwen/qwen3-235b-a22b-instruct-2507",
  "messages": [{ "role": "user", "content": "Summarize the tradeoffs of a four-day work week in three bullets." }]
}
```

A direct completion against a local OpenAI-compatible server (LM Studio on its default port):

```json
chat_completion {
  "provider": "openai_compatible",
  "base_url": "http://localhost:1234/v1",
  "model": "local-model",
  "messages": [{ "role": "user", "content": "Hello." }]
}
```

### Ultraplan tool calls

Orchestrator-owned planning; replace the plan placeholders with the complete text you write:

```json
start_ultraplan { "agents": ["product-lead", "cfo", "skeptic"], "task": "Plan the onboarding launch" }
submit_plan    { "ultraplan_id": "<id>", "plan": "<full v1 plan with contributor tags>" }
submit_plan    { "ultraplan_id": "<id>", "plan": "<full revised plan, including amendment decisions>", "final": true }
```

Autonomous planner variant:

```json
start_ultraplan { "agents": ["cfo", "skeptic"], "task": "Plan the onboarding launch", "planner": "product-lead", "revision_rounds": 2 }
```

To review or sign off the latest version again without creating a new version, omit `plan`:

```json
submit_plan { "ultraplan_id": "<id>" }
submit_plan { "ultraplan_id": "<id>", "final": true }
```

Passing `plan` submits the full next version. Without any version yet, omitting it fails with `No plan version exists yet; pass plan.` To review an existing draft at startup, add `draft_plan`. A stopped planner run can return `phase: "plan"`, the unreviewed latest version, with `previousReviews` when an earlier version was reviewed. Recover with `submit_plan` with or without a full revised `plan`; use `final: true` for sign-off. To close without sign-off, use `end_ultraplan { "ultraplan_id": "<id>" }`.

### Conversation tool calls

```json
start_collaboration { "agents": ["cfo", "product-lead"], "mode": "conversation", "context": "We just shipped the onboarding redesign; cfo last reviewed the launch budget.", "auto_run_rounds": 2 }
continue_collaboration { "collaboration_id": "<id>", "rounds": 1 }
end_collaboration { "collaboration_id": "<id>", "request_summary": true }
```

Add `topic` for a loose theme, or `grounding: false` to skip workspace, memory and activity excerpts.

### Prototype tool calls

```json
start_collaboration { "agents": ["product-lead", "skeptic"], "topic": "Checkout redesign", "prototype": true, "max_rounds": 2, "auto_run_rounds": 1 }
```

The start and `continue_collaboration` JSON results carry a `prototypes` block. `destroyed_this_call` lists what was destroyed since the previous result; `url` is the prototype's page on the board (use it as returned):

```json
"prototypes": {
  "board_url": "http://127.0.0.1:<port>/<token>/",
  "live": [
    {
      "label": "P2 v1",
      "title": "Inline coupon field",
      "kind": "web",
      "proposer": "product-lead",
      "url": "http://127.0.0.1:<port>/<token>/p/P2v1/",
      "awaiting_verdicts_from": ["skeptic"]
    }
  ],
  "destroyed_this_call": ["P1 v1"],
  "notice": "Show the human the board URL. Prototypes exist only until the other participants finish assessing them. Do not relay the human's feedback on prototypes into this session until it ends."
}
```

Continue as usual; a prototype may be proposed, assessed and destroyed inside one call. If the session is paused while a prototype is under assessment, `continue_collaboration` resumes it:

```json
continue_collaboration { "collaboration_id": "<id>", "rounds": 1 }
```

In a prototype meeting you are the assessor. Reply to the agent's prototype with a verdict line; the reply ends with a `Prototypes:` block of the same shape:

```json
start_meeting { "agent": "product-lead", "agenda": "Pricing page", "prototype": true }
say           { "meeting_id": "<id>", "message": "Verdict on P1: REVISE — the annual toggle is easy to miss on mobile." }
```

`nudge_collaboration` is refused while a prototype is under assessment; `pause_collaboration`, `nudge_collaboration` and `get_collaboration_transcript` carry no `prototypes` block. Ending returns the outcomes and the shortlist:

```json
end_collaboration { "collaboration_id": "<id>", "request_summary": true }
```

The result adds a **Prototype outcomes** section and a **Shortlist for the human** with the final source, diagram or draft of each shortlisted prototype.

### Agent workshop tool calls

```json
create_agent { "agents": ["cfo", "product-lead"], "task": "Own marketing budgets and tradeoffs", "name": "marketing-budget", "perform_task": true }
create_agent { "from_session": "collab-4k9q2mzt", "write": false }
improve_agent { "agent": "cfo", "with": ["skeptic"], "focus": "Assumptions and escalation rules" }
improve_agent { "agent": "cfo", "with": ["product-lead"], "include_self": false, "write": false }
```

### Page-check option

`start_duel` accepts `page_check: false` to skip headless checks of web builds and revisions (default on when Chrome/Chromium exists). Prototype-mode `start_collaboration`, `start_meeting` and `start_local_meeting` accept the same option alongside `prototype: true`. Check metadata includes load status, capped/scrubbed console errors and exceptions, failed-request count and an optional reason. No browser means not checked, never a failed artifact. Duel results include each team's check and the version of each verdict; screenshots stay local and outside the result/archive.
