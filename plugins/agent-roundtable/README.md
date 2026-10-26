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
