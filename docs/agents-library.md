# Agents library

The library is a private collection of reusable personas at `ROUNDTABLE_HOME/agents`
(normally `~/.agent-roundtable/agents`). It complements the project's configured
agents directory. Importing adds persona text; it does not run it or call a provider.

```sh
roundtable agents
roundtable agents --json
roundtable agents import /absolute/path/to/persona.md
roundtable agents import /absolute/path/to/personas
roundtable agents starter
roundtable agents --open
```

Names resolve first in `ROUNDTABLE_AGENTS_DIR`: `<name>.md`, `subagent-<name>.md`,
then `<name>/AGENT.md`. Next come the library's `<name>.md` and `<name>/AGENT.md`.
Configured personas always win. The library lists both copies and marks the
imported copy as shadowed. File references still follow the [containment rules](agents.md).
A library root must exist and must not be a symlink; file realpaths stay inside
approved roots. Discovery exposes basenames, never absolute file paths.

## Import rules

Markdown uses the existing frontmatter reader and must have a non-empty body.
Its key comes from frontmatter `name`, or the filename stem when no name is present.
JSON must be an object with a non-empty `name` and exactly one non-empty string
prompt field: `prompt`, `instructions`, `system_prompt`, or `body`. Other supported
keys are `description`, `model`, `provider`, `tools`, and `skills`. Tools and skills
accept a comma-separated string or an array of strings. Unknown JSON keys are
refused. JSON becomes Markdown with YAML frontmatter that must round-trip through
the persona reader without changing metadata.

Each file is limited to 128 KiB. Names become lowercase slugs, with empty and
reserved names refused; filenames must be basenames, never paths. Imports write
`<key>.md` with exclusive creation and mode 0600. The library is created with mode
0700 on its first write. An existing file is reported as `exists` and skipped;
imports never overwrite it. Folder imports inspect top-level `.md` and `.json`
files and `<name>/AGENT.md`, skip symlinks, and import at most 200 files.

Warnings explain choices without refusing them:

- Tools beyond `Read`, `Grep`, `Glob`: a heads-down worker using this persona
  gets the requested tools. Review powerful tools before using the persona.
- A model ending in an eight-digit date may be unavailable and falls back to
  the provider default.
- Missing descriptions leave a blank role in Casting Call and the library.

The terminal and browser both show these warnings. The terminal table includes
key, source, a shortened description, and warnings; `--json` returns full entries.
Import commands exit 1 if any file is refused, 0 for imported or existing files,
and 2 for usage errors.

## Drop zone and starter pack

`roundtable agents --open` prints a capability URL, opens a local page, and holds
until Ctrl-C. `--no-hold` closes it immediately for command checks. Search filters
cards by name, key, source, description, tools, or skills. Drop `.md` or `.json`
files onto the import zone or use the file picker. Each upload accepts at most
50 files and 2 MiB of JSON, reports each result, and refreshes the cards.

When Casting Call's `ROUNDTABLE_HOME/casting/latest.json` is readable, cards also
show its verdict and role for matching keys. Missing or invalid reports are ignored.

`roundtable agents starter` installs eight generic personas from the packaged
`examples/starter-pack/`: `cfo`, `product-lead`, `skeptic`, `staff-engineer`,
`designer`, `security-reviewer`, `user-advocate`, and `data-analyst`. All have
descriptions, request only `Read, Grep, Glob`, and leave the model unpinned.
The pack is located relative to the installed package, so the command works from
any directory. Repeating it skips existing files and reports each skip.

## Security

The page binds to loopback and every route requires a random capability token.
Keep its URL private. Imports additionally require the page's per-server action
nonce, same-origin headers when present, and `application/json`. The server
enforces a hard 2 MiB body cap and a limit of 20 import requests per minute.
Scripts and styles come only from this server under a strict CSP; untrusted text
enters the DOM through `textContent`. No imported content is executed or logged
during import. Persona instructions, provider choices, skills, and requested tools
still affect later sessions: review an unfamiliar persona before assigning it work.
