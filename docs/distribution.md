# Distribution

Four ways to get Roundtable. Until the package is published, the npm, `npx`, plugin and registry paths below do not resolve; a source checkout works today (see [getting started](getting-started.md)).

| Path | Command | Status |
| --- | --- | --- |
| npm | `npm install -g agent-roundtable` | once published |
| `npx` | `claude mcp add --scope user roundtable -- npx -y agent-roundtable@2.0.0 mcp` | once published |
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

The base image is pinned by digest in the `Dockerfile`, and Dependabot's `docker` ecosystem proposes updates. The command sandbox and install-egress proxy also use digest-pinned defaults (`DEFAULT_SANDBOX_IMAGE` and `DEFAULT_PROXY_IMAGE` in `src/sandbox/common.ts`). Maintainers refresh these digests deliberately after reviewing and testing the selected images. Operators can set the image overrides documented in [configuration](configuration.md). CI builds the image and runs `help` once; it never pushes.

The Docker build installs dependencies with `npm ci --ignore-scripts`, then runs `npm run build` explicitly. A newly created `ROUNDTABLE_HOME` has mode 0700; existing home directory modes are preserved.

## Claude Code plugin

`.claude-plugin/marketplace.json` lists one plugin, in `plugins/agent-roundtable/`. Its `.mcp.json` runs `npx --prefix "${CLAUDE_PLUGIN_ROOT}" -y agent-roundtable@2.0.0 mcp`, pinned to the plugin version. Claude Code expands `${CLAUDE_PLUGIN_ROOT}` in plugin MCP configuration. The absolute plugin prefix selects package resolution independently of the opened project; the server keeps that project as its working directory. The plugin carries no keys: provider keys come from your environment or from `roundtable config set env-file <path>`. The `.mcp.json` lives inside the plugin directory, not the repository root, so opening this repository registers no server.

Manual resolution check (requires registry access and a published version): open a directory with a `node_modules/agent-roundtable` package of the same version as the plugin. Give that local package's bin a distinctive marker, start the plugin, and call an MCP tool. The marker must not appear and the plugin must run the published package. Also confirm that project-relative agent paths still resolve from the opened directory. This check is manual because the offline tests assert the command structure without fetching npm packages.

## CLI bin check

`roundtable doctor` and `roundtable up` report a non-essential `bin` check, labelled "roundtable on PATH". It compares the first executable's realpath with this package's bin, then checks the nearest package manifest name for another installation of the same package. An absent PATH entry is fine for npx or direct Node usage. If another package supplies the first `roundtable`, the advice is to uninstall it, reorder PATH, use `npx -y agent-roundtable@2.0.0`, or invoke this package's bin by absolute path.

## MCP registry

`server.json` follows the [registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) and lists the npm package with the four optional provider keys as secret environment variables. `package.json` carries `mcpName`, which the registry checks against the `name` in `server.json`. There is no container entry until an image is published; to add one, append a package to `server.json`:

```json
{ "registryType": "oci", "identifier": "<registry>/<owner>/agent-roundtable:<version>", "transport": { "type": "stdio" } }
```

The Dockerfile already carries the `io.modelcontextprotocol.server.name` label the registry verifies for images.

## Versions

`package.json` is the one source. `npm version <x.y.z>` runs `scripts/sync-version.mjs`, which writes the version into `server.json`, the plugin manifest, the marketplace entry, the pinned `.mcp.json` argument, the `VERSION` constant in `src/config.ts`, and npx package commands in `README.md`, `docs/getting-started.md` and this document. A unit test fails if any of them disagree.

## Release workflow

The Release workflow runs only by manual dispatch on a tag; pushing a tag or opening a PR does not trigger it. The `build` job checks that the tag matches `package.json`, installs dependencies, checks dependencies and hygiene, builds, tests, packs the tarball and generates a CycloneDX SBOM. It has read-only repository permissions, no npm token and no OIDC permission. It uploads the tarball, its exact filename and `sbom.cdx.json` as `release-files`.

The dependent `publish` job runs in the protected `release` environment, limited to `v*` tags with a required reviewer. It downloads those artifacts without checking out source. Only this job has `contents: write` and `id-token: write`; `NPM_TOKEN` is available only to the npm publish step. It publishes the tarball with provenance and install scripts disabled, then attaches the tarball and SBOM to the GitHub release. Workflow actions are pinned to full commit SHAs before release.

## Owner release checklist

1. The npm name and every registry or image name the manifests point to must be owned by the maintainer before the release PR merges.
2. Confirm private vulnerability reporting, default-branch and version-tag rulesets, dependency alerts and security updates are enabled. Confirm the `release` environment is on, limited to `v*` tags and requires a reviewer.
3. Bump: `npm version <x.y.z>` (this also syncs the distribution files, documented npx commands and `VERSION` in `src/config.ts`). Review the image digests and confirm every workflow action uses a full commit SHA.
4. Merge, tag `v<x.y.z>`, then run the manual Release workflow and approve the `release` environment job. Confirm the published package's provenance and the release's tarball and SBOM attachments.
5. Build and push the image to the chosen registry yourself (`docker build`, `docker push`), then add the OCI entry to `server.json`.
6. `mcp-publisher login github`, then `mcp-publisher publish`.
7. Check: `claude plugin marketplace add ylove/agent-roundtable`, `claude plugin install agent-roundtable@agent-roundtable`, `claude mcp list`, and `docker run --rm <image> help`. Complete the plugin resolution check above.
