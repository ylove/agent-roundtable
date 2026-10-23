# Worker connectors

Heads-down Claude Code workers can use extra stdio MCP servers, such as an issue tracker. Configure each connector locally, then opt in by name in the contract:

```sh
roundtable config set connector issues \
  --command /absolute/path/to/issue-mcp \
  --arg --stdio \
  --env ISSUE_TOKEN=secret://keychain/roundtable/issues \
  --env REGION=us
roundtable config show
roundtable secrets check
roundtable config unset connector issues
```

Equivalent user config:

```json
{
  "connectors": {
    "issues": {
      "command": "/absolute/path/to/issue-mcp",
      "args": ["--stdio"],
      "env": {
        "ISSUE_TOKEN": "secret://op/Work/Issues/token",
        "REGION": "us"
      }
    }
  }
}
```

`config show` lists connector names and env variable names only. It never shows the command, arguments, locators or values. Environment names that look like credentials (`SECRET_NAME_RE`, including KEY, TOKEN, SECRET, PASSWORD and AUTH segments) require a `secret://` reference. See [secrets](secrets.md) for backends and safe diagnostics.

## Contract opt-in

Add `"connectors": ["issues"]` to the contract object passed to `propose_contract`. Names appear in the contract summary and dashboard Contract page. They are part of the frozen contract and its consent hash. A connector change is run-wide and follows the usual consent or audited override rules. Propose and freeze refuse unknown names; execute refuses a connector missing from the local config before it starts anything. The contract contains names only, never connector credentials or commands.

Codex workers explicitly refuse contracts with connectors. Use `workers.driver: "claude-code"`. Seat connectors at the table are not yet supported.

## What the worker sees

The MCP config includes `roundtable` and the opted-in connector names. Claude's tool allowlist and server attestation include exactly those names. Connector env references resolve asynchronously before the worker starts. Each connector runs through a small trusted stdio launcher that removes the environment inherited from Claude, then launches the configured absolute executable without a shell. The connector receives BASE plus only its configured env variables. It does not inherit provider keys or unrelated process variables. The connector's tools and responses are visible to the worker.

The resolved MCP config is mode 0600 in the worker's mode-0700 private directory, beside its single-use token. It is outside the task worktree and sandbox mounts. The relay removes it on worker exit; the runner removes it when reaping or recovering a dead worker and before an interrupted launch is discarded. A hard crash can leave it until recovery or purge, so protect the state root and its backups. Each resume prepares fresh files.

Resolved credentials are registered for scrubbing before spawn. The trusted output relay and trusted roundtable worker server receive private scrub literals so both CLI output and direct tool writes are scrubbed before persistence. Event logs, blackboard text, notifications and artifacts use the same scrubbers. Recovery re-registers active connector env values before adopting a worker. Credentials are never added to the contract or session archive.

## Limits and trust

- Connector names match `[a-z][a-z0-9-]{0,31}` and cannot be `roundtable`.
- Commands must be absolute executable paths; shell executables are refused.
- Each connector has at most 16 arguments, each at most 4 KiB, and 32 env entries.
- A contract can opt in to at most 8 distinct connectors.

Connectors are trusted host processes, outside the command sandbox. Their tools may contact external services or change remote data with the supplied credentials. Contract opt-in grants access to those tools; it is not a per-operation permission prompt. Review each server and scope its credentials accordingly. Scrubbing prevents accidental exact-value disclosure; it does not contain a malicious server or protect against deliberate credential transformation. Blackboard means heads-down state; the prototype board is separate.
