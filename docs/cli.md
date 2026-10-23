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
| `statusline` | `[--agents N] [--plain] [--no-host]` | A Claude Code `statusLine` command: the host's line, the roundtable's spend, the busiest agents. Always exits 0. |
| `usage` | `[--json] [--watch]` | Who is using what, on which platform, with measured / reported / estimated labels. `--watch` refreshes every 2 s. |
| `stop` | `<agent> [--execution <exe> \| --session <id>] [--reason <text>]` | Stop one agent: a heads-down worker or an at-the-table session. |
| `runtimes` | `[--json]` | List installed CLI runtimes, paths and versions. See [CLI runtimes](runtimes.md). |
| `agents` | `[--json]`, `import <absolute file\|dir>`, `starter`, or `--open [--no-hold]` | Browse and import personas or open the local drop zone. See [agents library](agents-library.md). |
| `help` | none | Print usage. |

These are the **13 named subcommands** for heads-down runs, usage, runtime detection and the agents library of `src/cli.ts`; no arguments is an alias for `mcp`. The binary also dispatches six table commands, listed next. Unknown, repeated and valueless flags are refused. Execution ids are the `exe-…` values returned by the tools, not contract ids.

```sh
agent-roundtable help
agent-roundtable usage
agent-roundtable stop cfo --reason "that is enough"
agent-roundtable status <execution-id> --json
agent-roundtable watch <execution-id> --as main --timeout-min 50
agent-roundtable verify <execution-id> --json
```

`watch` waits for at most 50 minutes by default, accepts a positive timeout up to 1440 minutes, and exits after each wake. Run the exact command returned by `execute` in the background and re-arm it after handling the result. Errors go to stderr. See the [heads-down guide](heads-down.md#watch-and-status).

`statusline` reads the host's JSON on stdin, prints at most three lines within about 150 ms and exits 0 whatever happens (a status line must never show a stack trace); it ignores unknown flags and keeps a 2-second cache. `usage` prints a friendly report, or the usage view as JSON for scripts. `stop` needs no scope when the agent name is unambiguous; otherwise it names the places (`--execution`, `--session`) and exits 1. Setup, vocabulary and examples: the [usage guide](usage.md).

`run` is detached when started by the tools and survives MCP shutdown. It recovers state before scheduling work and exits when finished or after six hours fully paused. `status` inspects the run; the MCP `execution_status` tool provides the richer focused views and ensures runner liveness.

The generated worker configuration invokes `mcp --worker`; its token file is single-use and must be in the execution's expected agent directory. You normally never invoke it manually. The worker server has 8 tools and skips dotenv. The default and explicit orchestrator `mcp` forms have 44 tools and keep the host's umask. Heads-down processes (`run`, `watch`, `status`, `verify`, `purge`, worker MCP and hook) use umask 0077 and explicit private state modes.

Exit status of the subcommands above is 0 for success, 1 for a refusal or failed verification, and 2 for usage errors or a denied hook. `statusline` always exits 0. The hook fails closed on errors. `verify` reports incomplete trailing writes separately from chain corruption. `purge` refuses running or paused runs; the confirmation flag authorizes deleting the terminal run and is audited. Abort or resume a live run through `control_execution` first.

## Table commands

`roundtable` and `agent-roundtable` are the same binary (`bin` in `package.json`); the table commands are written with `roundtable` in these docs. They run at the table from a terminal and are described in [at the table from the terminal](table-cli.md).

| Command | Arguments | Purpose |
| --- | --- | --- |
| `cast` | `"<brief>" [--agents a,b,...] [--agents-dir <abs>] [--seats N] [--dry-run] [--json]` | Audition personas and recommend a cast; see [Casting Call](modes/casting-call.md). |
| `duel` | `<brief> --team-a <a,...> --team-b <c,...> --judges <j,...> [--kind web\|code\|diagram\|text] [--criteria "a,b"] [--rounds 1\|2] [--open] [--no-room] [--no-hold] [--json] [--seat ...] [--mix auto\|cheap] [--preflight\|--no-preflight] [--turn-timeout S] [--max-seconds S] [--agents-dir DIR]`; or `--dry-run`; or `--replay <archive> [--speed N]` | Two teams build competing artifacts, judges assess them, dissents are recorded. See [duel](modes/duel.md). |
| `debate`, `waffle`, `meeting` | `<topic> --agents <a,b,...> [--rounds N] [--seat ...] [--mix ...] [--duel duel-<id> [--no-duel-source]] [--json]` | Stream a collaboration (debate, waffle-house, collaborate) with per-seat models and spend. With `--duel` the topic may be omitted. |
| `config` | `show`, or `set env-file\|agents-dir <absolute-path>` | Save the env-file and persona-directory settings; `show` prints only set or unset. See [configuration](configuration.md#saved-cli-settings-and-env-files). |

Every table command accepts `--help`. Exit codes are 0 for completion or tie, 1 for failure or interruption, and 2 for usage errors or missing credentials.

See [configuration](configuration.md), [contracts and execution](heads-down.md), and [registration examples](getting-started.md#registering-with-claude-code).
