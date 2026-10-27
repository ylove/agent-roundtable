# agent-roundtable plugin for Claude Code

Registers the `roundtable` MCP server, which runs the published `agent-roundtable` npm package over stdio.
The package version in `.mcp.json` is pinned to this plugin's version. The plugin works once that version is published to npm.

```sh
claude plugin marketplace add ylove/agent-roundtable
claude plugin install agent-roundtable@agent-roundtable
```

The plugin carries no keys. Provider keys come from your environment, or from a private env file you point to with
`roundtable config set env-file <path>`. See [distribution](../../docs/distribution.md) and
[configuration](../../docs/configuration.md).

Package resolution uses `--prefix "${CLAUDE_PLUGIN_ROOT}"`, which Claude Code expands to the plugin's absolute directory in `.mcp.json`. The MCP server still uses the opened project as its working directory.

Manual check (requires registry access and a published version): open a directory containing a `node_modules/agent-roundtable` package of the same version as the plugin, with a distinctive marker in that local package's bin. Start the plugin and call an MCP tool. The local marker must not appear; the plugin must run the published package. Confirm project-relative agent paths still resolve from the opened directory.
