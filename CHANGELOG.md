# Changelog

## 0.3.0

- Ultraplan: the orchestrator writes plans shaped by specialist input, independent version reviews and final sign-offs; an optional planner persona runs the entire loop in one call. Final documents include input, sign-offs and revision history, with optional public mirroring. `submit_plan` can omit `plan` to review or sign off the latest version as-is without adding a version; stopped planner runs return unreviewed versions with `phase: "plan"` and earlier reviews in `previousReviews` when available, for recovery with `submit_plan` or `end_ultraplan`.
- Conversation mode: informal agent chat with an optional theme, short turns and truthfulness guidance. Private sessions can draw on workspace, agent-memory and local activity excerpts; `grounding: false` disables this, and public conversations never receive grounding or open on the founder angle, and their directive does not ask about the founder or whoever agents report to.
- Agent creation and refinement: specialists contribute expertise and skills, an architect drafts the definition, and participants review it. Supports live-session context, dry-run previews, optional task delegation, collision-safe creation, refinement backups and restricted generated frontmatter.
- Refinement reads malformed frontmatter leniently, preserves recovered keys and rewrites valid YAML; unrecoverable frontmatter is refused. Per-target improve locks prevent concurrent runs. Edits made during a run produce `.proposed-` files; replacements are atomic and keep the original mode after a `.bak-` backup.
- Generated tools fail closed: no allowlist matches or the wrong type triggers one architect retry; omitted tools warn that the agent inherits all tools.
- Public workshops post contributions, reviews and redacted definition summaries without system prompts or skill instructions. Public improve prompts omit recent activity and ask participants to point to passages rather than reproduce them; private contributor prompts include local activity topics and outcomes.
- Personas inline skills from frontmatter. Lookup follows personal, project, then configured skills precedence; found skills are reused without overwrites or shadowing. Creation writes new skills to the configured directory; refinement writes beside a target in its project's `.claude/skills` when it sits in `.claude/agents`, otherwise to the configured directory. Results report actual paths. Completed sessions record best-effort local activity, used for conversation grounding and refinement.
- Five new tools bring the total to 22 and validate argument types before routing or engine calls. `debug_env` and startup diagnostics report skills/workspace directories and activity settings; diagnostics also report parallel turn limits and active ultraplans. Package version is now 0.3.0.
- New environment variables: `ROUNDTABLE_SKILLS_DIR`, `ROUNDTABLE_WORKSPACE_DIR`, `ROUNDTABLE_ACTIVITY_LOG`, `ROUNDTABLE_PARALLEL_TURNS`.

## 0.2.0

- Public sessions: `public: true` on `start_meeting`, `start_local_meeting` and `start_collaboration` mirrors the session live to a public channel (ntfy by default, or a webhook), saves a Markdown transcript locally when the session ends, and reports the URL, saved path and delivery counts in the `end_*` results. Includes redaction, chunking, rate-limit handling, and a privacy notice added to every agent's system prompt. Publishing never blocks or fails a session. The `context` argument is never posted.
- New modes: `debate` for meetings, local meetings and collaborations (with `debate_focus`), and `waffle-house` for collaborations (one defender, the rest attackers; always ends on the defender).
- Fix: round counting now ignores orchestrator nudges, so a nudge no longer brings the end of a collaboration forward.
- `list_*` results include `mode` and `public`; `debug_env` reports the publisher settings (presence only for secrets).
- New environment variables: `ROUNDTABLE_PUBLISHER`, `ROUNDTABLE_NTFY_URL`, `ROUNDTABLE_NTFY_TOKEN`, `ROUNDTABLE_NTFY_USER`, `ROUNDTABLE_NTFY_PASSWORD`, `ROUNDTABLE_WEBHOOK_URL`, `ROUNDTABLE_WEBHOOK_VIEW_URL`, `ROUNDTABLE_WEBHOOK_AUTH_HEADER`, `ROUNDTABLE_PUBLIC_TOPIC_PREFIX`, `ROUNDTABLE_TRANSCRIPTS_DIR`, `ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS`.
- README: `debug_env` no longer described as showing a key prefix (it reports presence only).

## 0.1.0

- Initial release: MCP server with API-backed meetings, local (CLI) meetings, agent-to-agent collaborations, and direct chat completions across Anthropic, OpenAI, Together AI, Replicate, Ollama and any OpenAI-compatible endpoint. 17 tools.
