# Getting started

## Why

Agents that can convene other agents. A persona is a markdown file; a meeting is a conversation between the caller and one persona on a chosen model; a collaboration is two or more personas taking turns on a topic. All of it runs over a plain MCP server, provider-agnostic: the same persona can sit on Anthropic today, a Together-hosted open model tomorrow, and a local Ollama model when you are offline. Debates and other multi-agent formats are natural extensions of the same primitives. Active at-the-table sessions are in memory and archived when ended; heads-down runs persist in a local event log and can resume after restarts. There is no database service or hosted component to operate.

## Setup

Requires Node 22+.

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

**Prototype mode** — agents show their proposals instead of only describing them:

> Run a prototype collaboration on agent-roundtable between product-lead and skeptic on the checkout redesign; have them prototype their proposals.

> Start a meeting with the product-lead about the pricing page, with prototypes on. Ask them to show me the page.

> Run a public prototype waffle-house on the roundtable: the skeptic defends "one-click checkout" against the cfo and product-lead, with prototypes.

**Diagnostics:**

> Run debug_env on agent-roundtable and tell me which providers are configured.

What to expect: meetings and collaborations return a session id together with the first reply, and the model keeps that id for the follow-ups, so "tell the CFO…" and "end the meeting" need nothing from you. Sessions live in the server's memory and end when it restarts. Claude Code asks before each tool call unless you allow the server in its permission settings: the rule `mcp__agent-roundtable` allows every tool on it, `mcp__agent-roundtable__start_meeting` allows one.

See the [mode index](../README.md#modes), [tool reference](tools.md), and [configuration](configuration.md).
