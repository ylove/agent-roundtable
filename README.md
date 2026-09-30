# agent-roundtable

An MCP server (stdio) that lets Claude Code — or any MCP client — convene meetings and collaborations between AI agent personas and LLMs from six providers, run local meetings on your own `claude` CLI, and call any provider directly.

## Why

Agents that can convene other agents. A persona is a markdown file; a meeting is a conversation between the caller and one persona on a chosen model; a collaboration is two or more personas taking turns on a topic. All of it runs over a plain MCP server, provider-agnostic: the same persona can sit on Anthropic today, a Together-hosted open model tomorrow, and a local Ollama model when you are offline. Debates and other multi-agent formats are natural extensions of the same primitives. State is in memory; there is no database and nothing to host.

## Tools (17)

### Meetings (API-backed)

The caller talks to one agent persona. Provider and model are fixed at `start_meeting` (default provider `anthropic`).

| Tool | Arguments |
| --- | --- |
| `start_meeting` | `{ agent, agenda, context?, mode?, debate_focus?, public?, provider?, model?, base_url? }` |
| `say` | `{ meeting_id, message }` |
| `end_meeting` | `{ meeting_id, request_summary? }` |
| `list_meetings` | — |

### Local meetings (no API spend)

Spawns the local `claude` CLI with `--system-prompt-file`, so the conversation runs on your Claude subscription. The persona file is passed verbatim. The CLI is stateless, so the whole transcript is re-sent each turn — keep local meetings short.

| Tool | Arguments |
| --- | --- |
| `start_local_meeting` | `{ agent, agenda, context?, mode?, debate_focus?, public? }` |
| `say_local` | `{ meeting_id, message }` |
| `end_local_meeting` | `{ meeting_id, request_summary? }` |
| `list_local_meetings` | — |

### Collaborations (agent-to-agent)

Two or more personas take turns on a topic. One provider/model is used for the whole session.

| Tool | Arguments |
| --- | --- |
| `start_collaboration` | `{ agents[], topic, context?, max_rounds?, auto_run_rounds?, mode?, debate_focus?, public?, provider?, model?, base_url? }` |
| `continue_collaboration` | `{ collaboration_id, rounds? }` |
| `nudge_collaboration` | `{ collaboration_id, message }` |
| `pause_collaboration` | `{ collaboration_id }` |
| `end_collaboration` | `{ collaboration_id, request_summary? }` |
| `get_collaboration_transcript` | `{ collaboration_id }` |
| `list_collaborations` | — |

### LLM

| Tool | Arguments |
| --- | --- |
| `chat_completion` | `{ messages[], provider?, model?, max_tokens?, temperature?, base_url? }` (default provider `openai`) |

### Diagnostics

| Tool | Returns |
| --- | --- |
| `debug_env` | version, whether each key is configured (presence only, never any part of the value), Ollama reachability, default models, agents dir, active sessions, public-session publisher settings |

## Modes

- **debate** (meetings, local meetings, collaborations): the agent, or every agent after `agents[0]`, acts as a challenger that stress-tests a position instead of helping build it. `agents[0]` is the proponent. `debate_focus` optionally narrows the challenge.
- **waffle-house** (collaborations only): an adversarial gauntlet. `agents[0]` defends an idea, every other agent attacks it. Each round every attacker attacks, then the defender answers the whole volley (rebut, concede or revise) and restates its "Current position (vN)". A session runs `1 + max_rounds x N` agent turns and always ends on the defender's rebuttal; the defender writes the summary (final form of the idea, what changed and which attack forced it, unanswered attacks, confidence). Needs 2+ agents. Attackers may be blunt about the idea; identity attacks, threats and slurs are out of bounds.

Nudges from the caller never count as agent turns, so they do not shorten a session or change whose turn it is.

> Have a waffle-house on the roundtable with the product-lead defending "we should ship without onboarding", and the skeptic and cfo attacking. Three rounds, make it public.

## Public sessions

Pass `public: true` to `start_meeting`, `start_local_meeting` or `start_collaboration` (default `false`) and the session is mirrored live to a public channel. The start result includes `public: { url, topic }` so you can watch it while it runs. When you end the session, the server flushes pending posts, downloads the public record, and saves a Markdown transcript under `ROUNDTABLE_TRANSCRIPTS_DIR`. `end_*` results then end with a line such as `Public transcript: <url> (live ~12h on the public server) · Saved: <path> · Published 9/9`, followed by warnings if anything was not delivered, the channel was rate limited, or the history was truncated. `list_*` results include `public` and `mode`.

**Privacy rules.** A public channel is readable by anyone who has the link.

- Posted: a header (mode, participants, topic or agenda), every agent reply, your `say` and `nudge` messages, and the summary if you asked for one.
- Never posted: the `context` argument, system prompts, and persona files. Agents may still paraphrase context in their replies, so keep `context` generic in public sessions. The tool description tells the calling model to set `public` only when you ask for it.
- Every agent's system prompt gets a notice that the session is public, telling it to work at the level of ideas and never reproduce private context, code, credentials or personal information.
- Outgoing text passes through a mechanical redaction filter (emails, phone numbers, API-key and token patterns, home-directory paths, private IP addresses, card numbers that pass a Luhn check, US SSNs). It is a backstop only and cannot catch personal names or unusual secrets.
- Channel names are random (`<prefix>-<session id>-<22 random characters>`) and never derived from the topic. Unlisted is not private: anyone with the link can read it. Do not put anything in a public session that you would not put on a billboard.
- Publishing never fails or blocks a session. If posting fails, the session continues and the failure shows up in the end-of-session block; the local transcript marks undelivered entries.
- If a server exits before a public session is ended, the transcript is not saved; the public channel just expires.

**ntfy (default).** Messages go to `ROUNDTABLE_NTFY_URL` (default `https://ntfy.sh`) as JSON with `Firebase: no`, so they are not forwarded to Google. Open `<server>/<topic>` in a browser to watch; the page renders Markdown. Limits on the anonymous `ntfy.sh` server: 250 messages per day, a burst of 60 requests then one every 5 seconds, and messages are cached for 12 hours. Replies longer than about 3.8 KB are split into ordered parts. The server retries on 429 (honoring `Retry-After`) and stops posting for the session if the daily limit is reached or auth is rejected, then marks the channel degraded. Self-host ntfy or set a token to lift the limits.

**Webhook alternative.** Set `ROUNDTABLE_PUBLISHER=webhook` and `ROUNDTABLE_WEBHOOK_URL` to receive each entry as a JSON POST `{session, turn, part, parts, agent, content, timestamp}`, optionally with `ROUNDTABLE_WEBHOOK_AUTH_HEADER` and a `ROUNDTABLE_WEBHOOK_VIEW_URL` template containing `{channel}`. A webhook cannot return history, so the saved transcript is built from the local copy.

## Providers

| Provider id | Backend | Default model | Notes |
| --- | --- | --- | --- |
| `anthropic` | Anthropic Messages API | `claude-opus-5` | Aliases `opus` / `sonnet` resolve to `claude-opus-5` / `claude-sonnet-5`. `temperature` is never sent. |
| `openai` | OpenAI Chat Completions | `gpt-5.6-luna` | Uses `max_completion_tokens`. |
| `together` | Together AI | `zai-org/GLM-5.3` | Any Together model id, e.g. `Qwen/Qwen3.8-2.4T-A95B`. |
| `replicate` | Replicate predictions API | `qwen/qwen3-235b-a22b-instruct-2507` | `model` accepts `owner/name`, `owner/name:version`, or a `https://replicate.com/owner/name` URL. The server reads the model's input schema once and only sends fields the model declares (`prompt`, `system_prompt`, `max_tokens` or `max_new_tokens`, `temperature`). Cold starts are covered by the request timeout. |
| `ollama` | Local Ollama at `OLLAMA_URL` | `qwen3:14b` | Only usable when `GET $OLLAMA_URL/api/tags` answers within 1 s. |
| `openai_compatible` | Any `/v1/chat/completions` server (LM Studio, vLLM, llama.cpp server, OpenRouter, Groq, Fireworks, …) | `OPENAI_COMPATIBLE_MODEL` | Base URL from `OPENAI_COMPATIBLE_BASE_URL` or the `base_url` argument. API key optional — the `Authorization` header is omitted when `OPENAI_COMPATIBLE_API_KEY` is unset; when it is set it is sent to whichever base URL is used, including a per-call `base_url`. |

Every provider call is bounded by `ROUNDTABLE_LLM_TIMEOUT_MS` (default 600000 = 10 min). Empty replies are errors, never blank messages. Unknown provider ids are rejected. Missing keys fail per call with a message naming the variable — the server itself always starts.

## Environment variables

| Variable | Required for | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `anthropic` | — |
| `OPENAI_API_KEY` | `openai` | — |
| `TOGETHER_API_KEY` | `together` | — |
| `REPLICATE_API_TOKEN` | `replicate` | — |
| `OPENAI_COMPATIBLE_BASE_URL` | `openai_compatible` (unless `base_url` is passed) | — |
| `OPENAI_COMPATIBLE_API_KEY` | optional | — |
| `OPENAI_COMPATIBLE_MODEL` | `openai_compatible` | `default` |
| `OLLAMA_URL` | `ollama` | `http://localhost:11434` |
| `ROUNDTABLE_AGENTS_DIR` | agent prompt lookup | `.claude/agents` (relative to the server's working directory — use an absolute path) |
| `ROUNDTABLE_ANTHROPIC_MODEL` | default Anthropic model (id or alias) | `claude-opus-5` |
| `ROUNDTABLE_OPENAI_MODEL` | default OpenAI model | `gpt-5.6-luna` |
| `ROUNDTABLE_TOGETHER_MODEL` | default Together model | `zai-org/GLM-5.3` |
| `ROUNDTABLE_REPLICATE_MODEL` | default Replicate model | `qwen/qwen3-235b-a22b-instruct-2507` |
| `ROUNDTABLE_OLLAMA_MODEL` | default Ollama model | `qwen3:14b` |
| `ROUNDTABLE_MAX_TOKENS` | max output tokens (thinking tokens count) | `8192` |
| `ROUNDTABLE_LLM_TIMEOUT_MS` | per-request timeout | `600000` |
| `ROUNDTABLE_PUBLISHER` | public sessions: `ntfy` or `webhook` | `ntfy` |
| `ROUNDTABLE_NTFY_URL` | ntfy server | `https://ntfy.sh` |
| `ROUNDTABLE_NTFY_TOKEN` | ntfy access token (`tk_...`), if the server needs auth | — |
| `ROUNDTABLE_NTFY_USER` / `ROUNDTABLE_NTFY_PASSWORD` | ntfy basic auth, alternative to the token | — |
| `ROUNDTABLE_WEBHOOK_URL` | webhook publisher: URL that receives each entry as JSON | — |
| `ROUNDTABLE_WEBHOOK_VIEW_URL` | webhook publisher: URL template for the viewing page, `{channel}` is replaced | — |
| `ROUNDTABLE_WEBHOOK_AUTH_HEADER` | webhook publisher: value sent as the `Authorization` header | — |
| `ROUNDTABLE_PUBLIC_TOPIC_PREFIX` | prefix of the generated public channel name | `roundtable` |
| `ROUNDTABLE_TRANSCRIPTS_DIR` | where public-session transcripts are saved | `~/.agent-roundtable/transcripts` |
| `ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS` | max wait for pending posts when a public session ends | `30000` |

`.env` is loaded from the package directory (next to `package.json`) with `override: true`, so values there win over anything the MCP host passes in its `env` block. `.env` is gitignored and is the single source of truth for secrets. See `.env.example`.

## Agent prompt resolution

The `agent` argument is resolved, in order, as:

1. a literal path;
2. `<ROUNDTABLE_AGENTS_DIR>/<agent>.md`;
3. `<ROUNDTABLE_AGENTS_DIR>/subagent-<agent>.md`;
4. `<ROUNDTABLE_AGENTS_DIR>/<agent>/AGENT.md`.

A leading YAML frontmatter block (`--- ... ---` with at least one `key: value` line, as in Claude Code agent files) is stripped before the text becomes the system prompt; a body that merely opens with a markdown horizontal rule is left intact. Three generic personas ship in `examples/` (`cfo.md`, `product-lead.md`, `skeptic.md`); copy them into your agents directory or point `ROUNDTABLE_AGENTS_DIR` at `examples/` to try them.

## Setup

Requires Node 20+.

```sh
git clone <repository-url> agent-roundtable
cd agent-roundtable
cp .env.example .env   # fill in the keys you have
npm install
npm run build          # dist/ is gitignored — a fresh clone must build
npm test               # offline: unit tests with stubbed fetch + a stdio smoke test, zero API spend
```

Opt-in live check (one tiny `chat_completion` per provider; costs well under a cent):

```sh
ROUNDTABLE_LIVE_TEST=1 npm run test:live
# providers default to anthropic,openai,together; replicate is billed per second, so it is opt-in:
ROUNDTABLE_LIVE_TEST=1 ROUNDTABLE_LIVE_PROVIDERS=replicate npm run test:live
```

## Registering with Claude Code

Use absolute paths. Any of the three forms works.

**(a) `claude mcp add`** (add `--scope user` to make it global):

```sh
claude mcp add agent-roundtable \
  -e ROUNDTABLE_AGENTS_DIR=/absolute/path/to/.claude/agents \
  -- node /absolute/path/to/agent-mcp/dist/index.js
```

**(b) `claude mcp add-json`:**

```sh
claude mcp add-json agent-roundtable '{"type":"stdio","command":"node","args":["/absolute/path/to/agent-mcp/dist/index.js"],"env":{"ROUNDTABLE_AGENTS_DIR":"/absolute/path/to/.claude/agents"}}'
```

**(c) A project `.mcp.json`:**

```json
{
  "mcpServers": {
    "agent-roundtable": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-mcp/dist/index.js"],
      "env": {
        "ROUNDTABLE_AGENTS_DIR": "${ROUNDTABLE_AGENTS_DIR:-.claude/agents}"
      }
    }
  }
}
```

Tools then appear as `mcp__agent-roundtable__<tool>`. After a rebuild, reload with `/mcp` → Reconnect.

Any other MCP client: run `node dist/index.js` over stdio.

## Using it from a chat session

Once the server is registered you do not call the tools yourself: you ask for what you want in plain language and the model calls them. Claude Code lists them as `mcp__agent-roundtable__<tool>`, so naming the server ("via agent-roundtable", "using the roundtable") is enough to steer the model to it when several MCP servers are connected. Persona names are file names in `ROUNDTABLE_AGENTS_DIR` — the shipped `examples/` give you `cfo`, `product-lead` and `skeptic` — and a file path works too.

**Meetings** — one persona, back and forth. Each prompt is one message in the chat:

> Start a meeting via agent-roundtable with the cfo agent. Agenda: Q3 budget review. Use Anthropic Sonnet.

> Tell the CFO that runway is 14 months at current burn and ask what they would cut first.

> End the meeting and give me the summary.

**Local meetings** — the same conversation on your own `claude` CLI, no API spend:

> Start a local meeting with the product-lead agent about the onboarding redesign. Context: the spec in docs/onboarding.md.

> Ask them what they would cut to ship two weeks earlier, then end the meeting with a summary.

**Collaborations** — two or more personas take turns on a topic:

> Run a collaboration on agent-roundtable between cfo and skeptic on "Should we raise now?", three rounds max, and run the first round immediately.

> Continue the collaboration for two more rounds.

> Nudge the collaboration: assume the round closes at a flat valuation. Then run one more round.

> Give me the full transcript of that collaboration.

**Direct completions** — any provider, no persona:

> Using the together provider on agent-roundtable, summarize the tradeoffs of a four-day work week in three bullets.

> Send this to the replicate provider with model https://replicate.com/qwen/qwen3-235b-a22b-instruct-2507: "Explain CRDTs to a product manager."

> Use the openai_compatible provider with base URL http://localhost:1234/v1 and model local-model to answer: what is the capital of Australia?

**Debate, waffle-house and public sessions:**

> Have a waffle-house on the roundtable with the skeptic defending "pineapple belongs on pizza" against the cfo and product-lead. Two rounds, make it public.

> Start a debate meeting with the cfo about our pricing agenda.

**Diagnostics:**

> Run debug_env on agent-roundtable and tell me which providers are configured.

What to expect: every `start_*` call returns a session id together with the first reply, and the model keeps that id for the follow-ups, so "tell the CFO…" and "end the meeting" need nothing from you. Sessions live in the server's memory and end when it restarts. Claude Code asks before each tool call unless you allow the server in its permission settings: the rule `mcp__agent-roundtable` allows every tool on it, `mcp__agent-roundtable__start_meeting` allows one.

## Tool call reference

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

## Notes

- State is in memory. A rebuild + reconnect drops every meeting and collaboration.
- Local meetings require the `claude` CLI on `PATH`.
- The smoke test assumes `.env` sets neither `OLLAMA_URL` nor `OPENAI_COMPATIBLE_BASE_URL` (`.env` is loaded with `override: true`, so it beats the values the harness pins): it points Ollama at an unreachable port on purpose to exercise the unreachable path, and the "openai_compatible without a base URL" check would otherwise send a request to your configured server.
- Provider errors (missing key, empty reply, timeout, unknown model) surface as tool errors with the reason; they never abort the server.

## Contributing

`npm test` must pass before a pull request. CI runs the build and tests on Node 20 and 22 and enforces that no absolute user paths are committed.

## License

MIT — see `LICENSE`.
