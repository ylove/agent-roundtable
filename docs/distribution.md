# Distribution

Four ways to get Roundtable. Until the package is published, the npm, `npx`, plugin and registry paths below do not resolve; a source checkout works today (see [getting started](getting-started.md)).

| Path | Command | Status |
| --- | --- | --- |
| npm | `npm install -g agent-roundtable` | once published |
| `npx` | `claude mcp add --scope user roundtable -- npx -y agent-roundtable mcp` | once published |
| Docker | `docker run -i --rm -e ANTHROPIC_API_KEY agent-roundtable mcp` | build from the `Dockerfile`; no image is published |
| Claude Code plugin | `claude plugin marketplace add ylove/agent-roundtable`, then `claude plugin install agent-roundtable@agent-roundtable` | the plugin runs the npm package, so it works once published |
| MCP registry | listed as `io.github.ylove/agent-roundtable` | once the owner publishes `server.json` |

## Docker

```sh
docker build -t agent-roundtable .
docker run -i --rm -e ANTHROPIC_API_KEY -v roundtable-home:/home/node/.agent-roundtable agent-roundtable mcp
```

`-e NAME` with no value passes the variable through from your shell; `--env-file <path>` works for a file you control. The image contains no keys and the build takes none. It runs as the unprivileged `node` user, keeps state under `ROUNDTABLE_HOME` (`/home/node/.agent-roundtable`, a volume), and includes `git` and CA certificates only.

Register it with an MCP client: `claude mcp add roundtable -- docker run -i --rm -e ANTHROPIC_API_KEY agent-roundtable mcp`.

What works in the container:

- the stdio MCP server and the at-the-table modes (meetings, collaborations, duels, debates, waffles) against API providers
- the CLI verbs (`docker run --rm agent-roundtable help`)

What does not:

- Heads-down workers launch worker CLIs (claude, codex and others), which are not in the image. Run heads-down on the host.
- The room, board and dashboards bind to 127.0.0.1 inside the container, so the host cannot reach them. They are not opened to other interfaces.
- Local-CLI meetings and runtime seats need those CLIs on the host for the same reason.

The base image is pinned by digest in the `Dockerfile`, and Dependabot's `docker` ecosystem keeps it current. CI builds the image and runs `help` once; it never pushes.

## Claude Code plugin

`.claude-plugin/marketplace.json` lists one plugin, in `plugins/agent-roundtable/`. Its `.mcp.json` runs `npx -y agent-roundtable@<version> mcp`, pinned to the plugin version, and carries no keys: provider keys come from your environment or from `roundtable config set env-file <path>`. The `.mcp.json` lives inside the plugin directory, not the repository root, so opening this repository registers no server.

## MCP registry

`server.json` follows the [registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) and lists the npm package with the four optional provider keys as secret environment variables. `package.json` carries `mcpName`, which the registry checks against the `name` in `server.json`. There is no container entry until an image is published; to add one, append a package to `server.json`:

```json
{ "registryType": "oci", "identifier": "<registry>/<owner>/agent-roundtable:<version>", "transport": { "type": "stdio" } }
```

The Dockerfile already carries the `io.modelcontextprotocol.server.name` label the registry verifies for images.

## Versions

`package.json` is the one source. `npm version <x.y.z>` runs `scripts/sync-version.mjs`, which writes the version into `server.json`, the plugin manifest, the marketplace entry, the pinned `.mcp.json` argument and the `VERSION` constant in `src/config.ts`. A unit test fails if any of them disagree.

## Owner release checklist

Automation never publishes; every step below is run by the owner.

1. Bump: `npm version <x.y.z>` (this also syncs the distribution files and `VERSION` in `src/config.ts`).
2. Merge, tag `v<x.y.z>`, then run the manual Release workflow or `npm publish` locally.
3. Build and push the image to the chosen registry yourself (`docker build`, `docker push`), then add the OCI entry to `server.json`.
4. `mcp-publisher login github`, then `mcp-publisher publish`.
5. Check: `claude plugin marketplace add ylove/agent-roundtable`, `claude plugin install agent-roundtable@agent-roundtable`, `claude mcp list`, and `docker run --rm <image> help`.
