# Providers

| Provider id | Backend | Default model | Notes |
| --- | --- | --- | --- |
| `anthropic` | Anthropic Messages API | `claude-sonnet-5-5` | Aliases `opus`, `sonnet` and `haiku` resolve to `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`. `temperature` is never sent. |
| `openai` | OpenAI Chat Completions | `gpt-5.6-luna` | Uses `max_completion_tokens`. |
| `together` | Together AI | `zai-org/GLM-5.3` | Any Together model id, e.g. `Qwen/Qwen3.8-2.4T-A95B`. |
| `replicate` | Replicate predictions API | `qwen/qwen3-235b-a22b-instruct-2507` | `model` accepts `owner/name`, `owner/name:version`, or a `https://replicate.com/owner/name` URL. The server reads the model's input schema once and only sends fields the model declares (`prompt`, `system_prompt`, `max_tokens` or `max_new_tokens`, `temperature`). Cold starts are covered by the request timeout. |
| `ollama` | Local Ollama at `OLLAMA_URL` | `qwen3:14b` | Only usable when `GET $OLLAMA_URL/api/tags` answers within 1 s. |
| `openai_compatible` | Any `/v1/chat/completions` server (LM Studio, vLLM, llama.cpp server, OpenRouter, Groq, Fireworks, …) | `OPENAI_COMPATIBLE_MODEL` | Base URL from `OPENAI_COMPATIBLE_BASE_URL` or the `base_url` argument. API key optional — the `Authorization` header is omitted when `OPENAI_COMPATIBLE_API_KEY` is unset; when it is set it is sent only to `OPENAI_COMPATIBLE_BASE_URL`'s origin (and `ROUNDTABLE_OPENAI_COMPATIBLE_TRUSTED_ORIGINS`). A per-call `base_url` may not target cloud metadata or, unless `ROUNDTABLE_ALLOW_PRIVATE_BASE_URLS=1`, private addresses, and must be https except to loopback (and, with that setting, to private addresses such as a LAN LM Studio or vLLM server). |

Every provider call is bounded by `ROUNDTABLE_LLM_TIMEOUT_MS` (default 600000 = 10 min). Empty replies are errors, never blank messages. Unknown provider ids are rejected. Missing keys fail per call with a message naming the variable — the server itself always starts.

See [provider configuration](configuration.md) and [direct completion examples](tools.md#tool-call-examples).

## Provider judgment

When you omit a provider, a deterministic router chooses each seat's provider and model without an LLM call. It applies to `duel`, `debate`, `waffle` and `meeting` in the terminal, and to `start_meeting`, `start_collaboration`, `start_duel` and `start_ultraplan`. Those MCP tools also accept `"provider": "auto"`. Local meetings through the `claude` CLI are unchanged. Runtime seats always require an explicit assignment.

Precedence is:

1. Explicit `--seat`, `seats`, or tool provider/model arguments; per-seat arguments win over session arguments.
2. Persona frontmatter provider/model, while that provider is configured and passes health checks. An unknown persona model retains the existing one-time fallback to that provider's default.
3. `--mix auto` and `--mix cheap`: aliases for the router with a cost bias.
4. Automatic role, health, performance and spread judgment.

The built-in role defaults are below. Environment model defaults still apply, except that the judge tier uses the smaller model shown for `anthropic`. Routing overrides take priority over these defaults.

| Role | anthropic | openai | together | replicate | ollama | openai_compatible |
| --- | --- | --- | --- | --- | --- | --- |
| Builder / long output | claude-sonnet-5-5 | gpt-5.6-luna | zai-org/GLM-5.3¹ | qwen/qwen3-235b-a22b-instruct-2507 | qwen3:14b | configured model |
| Judge / critique / short turn | claude-haiku-5-5 | gpt-5.6-luna | zai-org/GLM-5.3 | qwen/qwen3-235b-a22b-instruct-2507 | qwen3:14b | configured model |
| Balanced / designer / persona chat | claude-sonnet-5-5 | gpt-5.6-luna | zai-org/GLM-5.3 | qwen/qwen3-235b-a22b-instruct-2507 | qwen3:14b | configured model |

¹ Reasoning models are excluded for automatic builds when an eligible non-reasoning candidate remains. A duel team's last member uses the builder tier; judges and critique roles use the judge tier. Other seats use balanced. Output limits share the duel's provider ceilings; an operator override can lower a ceiling but cannot raise it. Explicit assignments retain their chosen model.

Automatic choices preflight each selected provider/model pair and try another provider after a failure. Successful pairs and provider health are cached in the process for ten minutes, keyed by provider, endpoint identity and credential identity. Only actual call and preflight outcomes update health; tool arguments and ledger data cannot assert health. Changing a key or endpoint invalidates its cached health. `--no-preflight` skips probes but still respects known failures. If nothing remains, startup fails with every provider tried and its local reason, including the unavailable legacy `anthropic` fallback; it does not start a doomed session.

Recent call outcomes and latency are retained in the usage ledger without prompts or response bodies. The last 50 outcome-bearing calls per provider/model, from the last seven days, determine failure rate and median latency. Failures rank below successful alternatives; role capability, cost bias and spreading seats across providers guide the remaining choices. Final ties use provider identifier order. The two duel teams use different eligible providers where possible.

With a remaining budget, a candidate's per-call cost must fit within it. A known price (the built-in table, or an override) is used as is. A provider with no known price (Together, Replicate, Ollama, `openai_compatible` and others) stays eligible: its cost is counted from a conservative token estimate (USD 15 per million input tokens and USD 75 per million output tokens), labelled "estimated" in the reason, the same provenance label the usage views use. A candidate is excluded only when its known or estimated cost exceeds the remaining budget. The estimate uses the requested input/output bounds, or a default input allowance and the role's output limit. Explicit and persona pins, and the persona missing-model fallback, pass the same budget gate before they are probed or accepted. Heads-down calls retain their existing per-call reservations and token bounds against the blackboard budget. Price overrides use the existing `ROUNDTABLE_PRICING_FILE`; routing configuration cannot change prices or health. A price from that file replaces the estimate.

Routing history and health are scoped to the endpoint. Outcomes for `openai_compatible` and Ollama carry a short hash of the endpoint's origin and path, never a URL, credentials or a key, and only outcomes for the operator-configured endpoint count toward routing. Calls that name another `base_url` do not affect it.

The output ceiling a routed seat was given stays in force for the whole session: meeting continuations, summaries and dissent summaries use the same cap as the opening call.

When `ROUNDTABLE_EXECUTION_PROVIDER` is unset, heads-down goal review, lead and huddle calls use the judge tier. The `execute` preflight checks the routed choice. Setting that variable keeps the explicit provider path. Worker CLI drivers remain explicit runtime choices.

For automatic `openai_compatible` selection, configure `OPENAI_COMPATIBLE_BASE_URL` as an operator setting. Automatic routing accepts HTTPS or loopback HTTP and rejects URLs containing credentials, query strings or fragments. A caller's `base_url` requires explicit `provider: "openai_compatible"`; it cannot steer an automatic choice. The existing explicit-call origin checks and key binding still apply.

Override models by provider and tier in `~/.agent-roundtable/config.json` (or under `ROUNDTABLE_HOME`):

```json
{
  "routing": {
    "replicate": {
      "builder": {
        "model": "qwen/qwen3-235b-a22b-instruct-2507",
        "reasoning": false,
        "maxOutputTokens": 12000
      }
    },
    "anthropic": {
      "judge": { "model": "claude-haiku-5-5" }
    }
  }
}
```

Only provider identifiers, the tiers `builder`, `judge`, `balanced`, and model entries containing `model`, optional boolean `reasoning`, and optional positive integer `maxOutputTokens` are accepted. Unknown routing fields are errors. No endpoint, health or budget override is accepted there.

```sh
roundtable duel "A short policy" --kind text --team-a editor --team-b reviewer --judges critic
roundtable debate "A spending limit" --agents designer,skeptic --mix cheap
```

```json
{"agent":"reviewer","agenda":"Review the draft","provider":"auto"}
```

Every selected seat carries a short `reason`. It appears in the terminal seat line, NDJSON `start` event, room seat cards and MCP start results' `routing` array. For example: `replicate/... chosen: healthy, non-reasoning, 0 recent failures`. Exclusions for reasoning models, failed health or budget limits appear alongside the choice.
