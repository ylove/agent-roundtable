# CLI reference

The `agent-roundtable` binary is `dist/index.js`. With no arguments it starts the orchestrator MCP stdio server. From a source checkout, replace `agent-roundtable` with `node dist/index.js`. Requires Node 22+.

| Subcommand | Arguments | Purpose |
| --- | --- | --- |
| `mcp` | none, or `--worker --execution <exe> --agent <id> --token-file <path>` | Start an orchestrator or authenticated worker MCP server. |
| `hook` | `pre-tool-use` | Run the worker lease hook on hook JSON from stdin. |
| `run` | `<exe>` | Run a heads-down runner; normally started by `execute`. |
| `watch` | `<exe> --as <orchestrator> [--timeout-min 50]` | Wait for one orchestrator wake and print one JSON line. |
| `status` | `<exe> [--json]` | Show tasks, budget, escalations, runner and watchers. |
| `verify` | `<exe> [--json]` | Verify execution and global audit chains. |
| `purge` | `<exe> --confirm` | Delete a terminal run's worktrees, branches and log. |
| `help` | none | Print usage. |

These are the **8 named subcommands** dispatched by `src/cli.ts`; no arguments is an alias for `mcp`. Unknown, repeated and valueless flags are refused. Execution ids are the `exe-…` values returned by the tools, not contract ids.

```sh
agent-roundtable help
agent-roundtable status <execution-id> --json
agent-roundtable watch <execution-id> --as main --timeout-min 50
agent-roundtable verify <execution-id> --json
```

`watch` waits for at most 50 minutes by default, accepts a positive timeout up to 1440 minutes, and exits after each wake. Run the exact command returned by `execute` in the background and re-arm it after handling the result. Errors go to stderr. See the [heads-down guide](heads-down.md#watch-and-status).

`run` is detached when started by the tools and survives MCP shutdown. It recovers state before scheduling work and exits when finished or after six hours fully paused. `status` inspects the run; the MCP `execution_status` tool provides the richer focused views and ensures runner liveness.

The generated worker configuration invokes `mcp --worker`; its token file is single-use and must be in the execution's expected agent directory. You normally never invoke it manually. The worker server has 7 tools and skips dotenv. The default and explicit orchestrator `mcp` forms have 39 tools and keep the host's umask. Heads-down processes (`run`, `watch`, `status`, `verify`, `purge`, worker MCP and hook) use umask 0077 and explicit private state modes.

Exit status is 0 for success, 1 for a refusal or failed verification, and 2 for usage errors or a denied hook. The hook fails closed on errors. `verify` reports incomplete trailing writes separately from chain corruption. `purge` refuses running or paused runs; the confirmation flag authorizes deleting the terminal run and is audited. Abort or resume a live run through `control_execution` first.

See [configuration](configuration.md), [contracts and execution](heads-down.md), and [registration examples](getting-started.md#registering-with-claude-code).
