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

When `OLLAMA_URL` is unset, seat preparation and the execution preflight look for Ollama at `http://localhost:11434`. One `GET /api/tags` request has a one-second timeout. Concurrent preparations share it. The process caches successful discovery and model sizes for ten minutes, and failures for one minute. An explicit `OLLAMA_URL` keeps its existing eligibility. `roundtable doctor` reports the URL, configured model and whether it is pulled. Model names match exactly; a bare name selects only its `:latest` tag.

Any process listening on `localhost:11434` can receive prompts routed to discovered Ollama, including a process run by another user on a shared machine. Set `ROUNDTABLE_OLLAMA_DISCOVERY=off` to disable default discovery and require an explicit `OLLAMA_URL`. The values `0`, `false` and `no` also disable it; values are trimmed and case-insensitive.

Ollama sizes come from `details.parameter_size` in that response. Small means below 30 billion parameters. Large means 30 billion or more. Missing or unparseable sizes are unknown. For `openai_compatible`, a whole size token in the model id supplies the size, such as `8b` in `llama-3.1-8b-instruct` or `32b` in `qwen2.5-32b`. Unknown sizes have no penalty, since a compatible service may host a frontier model.

Small local models rank behind every healthy hosted candidate for judge and builder seats, including heads-down execution calls. This penalty comes before cost. It keeps a free model eligible when it is the only healthy choice. Balanced persona chat and cost-biased seats, including `--mix cheap`, have no size penalty and keep the usual spread rules. Explicit seats, persona pins and `ROUNDTABLE_EXECUTION_PROVIDER` retain their choices. A provider-level `size: "small"` or `size: "large"` routing override wins over detection.

Recent call outcomes and latency are retained in the usage ledger without prompts or response bodies. The last 50 outcome-bearing calls per provider/model, from the last seven days, determine failure rate and median latency. Failures rank below successful alternatives; role capability, cost bias and spreading seats across providers guide the remaining choices. Final ties use provider identifier order. The two duel teams use different eligible providers where possible.

With a remaining budget, a candidate's per-call cost must fit within it. A known price (the built-in table, or an override) is used as is. Ollama costs $0 per token and its price is known. A provider with no known price (Together, Replicate, `openai_compatible` and others) stays eligible. Its cost uses a conservative estimate of USD 15 per million input tokens and USD 75 per million output tokens, labelled "estimated" in the reason. A candidate is excluded only when its known or estimated cost exceeds the remaining budget. The estimate uses the requested input/output bounds, or a default input allowance and the role's output limit. Explicit and persona pins, and the persona missing-model fallback, pass the same budget gate before they are probed or accepted. Heads-down calls retain their existing per-call reservations and token bounds against the blackboard budget. Price overrides use `ROUNDTABLE_PRICING_FILE`; routing configuration cannot change prices or health. A price from that file replaces the estimate.

Set `ROUNDTABLE_OPENAI_COMPATIBLE_FREE=1` to price calls to the operator-configured `OPENAI_COMPATIBLE_BASE_URL` at $0 with a known price. This is off by default because a loopback endpoint may proxy a paid API. A per-call `base_url` never receives this free price, even when it names the same URL.

An Ollama call is still an API call, metered in the ledger and counted toward caps at $0; a local meeting runs the `claude` CLI.

After the size penalty, recent failure rate ranks first. Judge seats compare cost before spread. Other seats compare spread first. Reasoning models add a spread penalty on balanced and judge seats because they are slow for live turns. On duel team seats they count as half a seat already used. Known prices rank before unknown prices; unknown prices share a rank independent of the budget estimate. Remaining ties use output capacity for builds, median latency and provider order. `--mix auto` and `--mix cheap` compare spread before cost, so four seats on four healthy providers land on four providers. A model given without a provider is only offered to providers that can serve it. A Claude id goes to `anthropic`, and a `gpt-` id goes to `openai`.

Failures count only for six hours, and only under the credential they happened with: the ledger stores a short hash of the key, never the key, so a rotated key starts clean. A timeout or rate limit excludes a provider from automatic choice for one minute; a rejected credential for ten.

Routing history and health are scoped to the endpoint. Outcomes for `openai_compatible` and Ollama carry a short hash of the endpoint's origin and path, never a URL, credentials or a key, and only outcomes for the operator-configured endpoint count toward routing. Calls that name another `base_url` do not affect it.

The output ceiling a routed seat was given stays in force for the whole session: meeting continuations, summaries and dissent summaries use the same cap as the opening call.

When `ROUNDTABLE_EXECUTION_PROVIDER` is unset, heads-down goal review, lead and huddle calls use the judge tier. The `execute` preflight probes the routed choice to warm the health cache but never refuses a run for automatic judgment (heads-down with claude-code workers needs no API key); only an explicit provider's rejected credentials refuse. The runner probes once at start, and retries a failed escalation route after 30 s, 60 s, 120 s and so on, handing it to the human after five attempts. Setting that variable keeps the explicit provider path. Worker CLI drivers remain explicit runtime choices.

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
    },
    "ollama": {
      "size": "large"
    }
  }
}
```

Each provider accepts an optional `size` of `"small"` or `"large"` next to the tiers `builder`, `judge` and `balanced`. Each tier accepts `model`, optional boolean `reasoning`, and optional positive integer `maxOutputTokens`. Unknown routing fields are errors. No endpoint, health or budget override is accepted there.

```sh
roundtable duel "A short policy" --kind text --team-a editor --team-b reviewer --judges critic
roundtable debate "A spending limit" --agents designer,skeptic --mix cheap
```

```json
{"agent":"reviewer","agenda":"Review the draft","provider":"auto"}
```

Every selected seat carries a short `reason`. It appears in the terminal seat line, NDJSON `start` event, room seat cards and MCP start results' `routing` array. For example: `replicate/... chosen: healthy, non-reasoning, 0 recent failures`. Exclusions for reasoning models, failed health or budget limits appear alongside the choice.
