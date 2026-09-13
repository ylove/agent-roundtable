# agent-roundtable

An MCP server (stdio) that lets Claude Code — or any MCP client — convene meetings and collaborations between AI agent personas and LLMs from six providers, run local meetings on your own `claude` CLI, and call any provider directly.

## Why

Agents that can convene other agents. A persona is a markdown file; a meeting is a conversation between the caller and one persona on a chosen model; a collaboration is two or more personas taking turns on a topic. All of it runs over a plain MCP server, provider-agnostic: the same persona can sit on Anthropic today, a Together-hosted open model tomorrow, and a local Ollama model when you are offline. Debates and other multi-agent formats are natural extensions of the same primitives. State is in memory; there is no database and nothing to host.

## Tools (17)

### Meetings (API-backed)

The caller talks to one agent persona. Provider and model are fixed at `start_meeting` (default provider `anthropic`).

| Tool | Arguments |
| --- | --- |
| `start_meeting` | `{ agent, agenda, context?, provider?, model?, base_url? }` |
| `say` | `{ meeting_id, message }` |
| `end_meeting` | `{ meeting_id, request_summary? }` |
| `list_meetings` | — |

### Local meetings (no API spend)

Spawns the local `claude` CLI with `--system-prompt-file`, so the conversation runs on your Claude subscription. The persona file is passed verbatim. The CLI is stateless, so the whole transcript is re-sent each turn — keep local meetings short.

| Tool | Arguments |
| --- | --- |
| `start_local_meeting` | `{ agent, agenda, context? }` |
| `say_local` | `{ meeting_id, message }` |
| `end_local_meeting` | `{ meeting_id, request_summary? }` |
| `list_local_meetings` | — |

### Collaborations (agent-to-agent)

Two or more personas take turns on a topic. One provider/model is used for the whole session.

| Tool | Arguments |
| --- | --- |
| `start_collaboration` | `{ agents[], topic, context?, max_rounds?, auto_run_rounds?, provider?, model?, base_url? }` |
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
| `debug_env` | version, which keys are configured (6-character prefix only), Ollama reachability, default models, agents dir, active sessions |

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

## Examples

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
