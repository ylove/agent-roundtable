# Agent personas and skills

An `agent` argument that contains `/` or `\`, or ends in `.md`, is a path: it must be a `.md` file whose real path is inside `ROUNDTABLE_AGENTS_DIR`, `<ROUNDTABLE_WORKSPACE_DIR>/.claude/agents`, `~/.claude/agents`, the existing non-symlink library directory, or a directory listed in `ROUNDTABLE_AGENT_PATHS`. Any other `agent` is a name, resolved in order as:

1. `<ROUNDTABLE_AGENTS_DIR>/<agent>.md`;
2. `<ROUNDTABLE_AGENTS_DIR>/subagent-<agent>.md`;
3. `<ROUNDTABLE_AGENTS_DIR>/<agent>/AGENT.md`;
4. `<ROUNDTABLE_HOME>/agents/<agent>.md`;
5. `<ROUNDTABLE_HOME>/agents/<agent>/AGENT.md`.

Configured personas always win over imported ones. A symlinked library directory is not an allowed root.

Either way the file's real path must stay inside those directories: an agent file that is a symlink to somewhere else (dotfiles, say) needs that directory in `ROUNDTABLE_AGENT_PATHS`.

A leading YAML frontmatter block (`--- ... ---` with at least one `key: value` line, as in Claude Code agent files) is stripped before the text becomes the system prompt; a body that merely opens with a markdown horizontal rule is left intact. Metadata is read the way Claude Code reads it: the first following `---` ends the block, even inside a line, and a failed YAML parse gets one quoting and leading-tab recovery pass. Refinement preserves exactly the keys Claude Code sees and refuses files Claude Code cannot parse or whose frontmatter contains `---` inside a value. Identity collision checks use this same metadata view.

When frontmatter lists `skills` (a name, comma-separated names, or a YAML list), skill bodies are appended to the persona under `## Skills`. Lookup tries `~/.claude/skills/<name>/SKILL.md`, then `<project>/.claude/skills/<name>/SKILL.md` beside an agent in `<project>/.claude/agents`, then `<ROUNDTABLE_SKILLS_DIR>/<name>/SKILL.md`: personal skills take precedence over project skills. Any found skill is reused and never overwritten or shadowed. Creation includes the destination project's `.claude/skills` in lookup even when `ROUNDTABLE_SKILLS_DIR` points elsewhere. New skills from creation go to `ROUNDTABLE_SKILLS_DIR`; refinement writes them beside its target in the project's `.claude/skills` when the target sits in `.claude/agents` and neither `.claude` nor `.claude/skills` is a symlink, with the skills realpath inside the project. Unsafe project skills directories fall back to `ROUNDTABLE_SKILLS_DIR` with a warning. Results report actual paths. Plugin names containing `:` are skipped and missing skills warn and are skipped. Each skill is capped at 12,000 characters, 40,000 total, with explicit truncation notes. Personas without skills keep their existing prompt text. Local meetings append skill instructions alongside mode/public directives.

Eight generic personas ship in `examples/starter-pack/`; install them with `roundtable agents starter` or point `ROUNDTABLE_AGENTS_DIR` at that directory. See the [agents library](agents-library.md) for imports, warnings and the browser drop zone.

See [agent workshops](modes/agent-workshops.md) for creating and refining agents, and [configuration](configuration.md) for allowed roots.
