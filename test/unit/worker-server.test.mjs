// The worker MCP server over stdio (`agent-roundtable mcp --worker …`): the single-use token, the
// draft dissent filing, execution tools, and events stamped with the worker's agent id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../mcp-client.mjs";
import { makeRun, runner } from "../fixtures/workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../dist/index.js");
const { prepareWorkerFiles } = await import("../../dist/workers/files.js");
const { ensureTaskWorktree } = await import("../../dist/execution/worktrees.js");
const childEnvironment = await import("../../dist/security/child-env.js");

async function setup() {
  const run = await makeRun();
  const files = await prepareWorkerFiles({ store: run.store, agent: "builder-1", persona: { body: "Builder.", skills: [] }, task: "build-nav-bar" });
  await run.store.transact(() => ({
    events: [
      { type: "agent.registered", source: runner, payload: { agent: "builder-1", persona: "builder", team: "web", driver: "claude-code", token_sha256: files.token_sha256, external: false } },
      { type: "task.claimed", source: runner, payload: { task: "build-nav-bar", agent: "builder-1", attempt: 1, ttl_s: 0 } },
    ],
  }));
  await ensureTaskWorktree(run.header, "build-nav-bar");
  const args = ["mcp", "--worker", "--execution", run.store.id, "--agent", "builder-1", "--token-file", files.tokenPath];
  return { run, files, args };
}

/** Start a worker server that must refuse: its exit code and stderr. */
function refuse(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input: "", env: { ...process.env, ROUNDTABLE_DOTENV: "off" }, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stderr: r.stderr };
}

test("a good token starts the server, is unlinked, and binds 10 tools to the agent; a reused token refuses", { skip: process.platform === "win32" }, async () => {
  const { run, files, args } = await setup();
  const token = readFileSync(files.tokenPath, "utf8").trim();
  const server = startServer({ args, env: { ROUNDTABLE_DOTENV: "off" } });
  try {
    await server.init();
    assert.equal(existsSync(files.tokenPath), false, "the token file is consumed");
    const tools = await server.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["file_dissent", "read_blackboard", "claim_task", "lease", "post_update", "run_command", "submit_work", "escalate", "spawn_subtasks", "await_subtasks"]);
    assert.ok(tools.every((t) => !t.inputSchema.properties.agent_token), "no token arguments on the worker server");
    const sum = JSON.parse((await server.callTool("read_blackboard", {})).text);
    assert.equal(sum.you.agent, "builder-1");
    assert.equal(sum.you.task, "build-nav-bar");
    const seq = (await run.store.state()).seq;
    const r = await server.callTool("post_update", { kind: "progress", text: "started", percent: 5 });
    assert.equal(r.isError, false, r.text);
    const [ev] = await run.store.events({ sinceSeq: seq });
    assert.deepEqual(ev.source, { kind: "agent", id: "builder-1", team: "web", task: "build-nav-bar", pid: server.pid });
    assert.equal((await server.callTool("join_execution", { execution_id: run.store.id, agent: "x" })).text, "Error: Unknown tool: join_execution");
    assert.deepEqual(server.noise(), [], "stdout carries only JSON-RPC");
    assert.match(server.stderr(), /worker server: agent builder-1/);
  } finally {
    server.stop();
    await server.exited();
  }

  const again = refuse(args);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /refused to start: no token file: it is missing or was already used/);

  writeFileSync(files.tokenPath, token + "\n", { mode: 0o600 });
  const replay = refuse(args);
  assert.equal(replay.code, 1);
  assert.match(replay.stderr, /this token was already used/);
});

test("a wrong, misplaced, malformed or public token refuses to start", { skip: process.platform === "win32" }, async () => {
  const { run, files, args } = await setup();
  writeFileSync(files.tokenPath, "f".repeat(64) + "\n", { mode: 0o600 });
  const wrong = refuse(args);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /does not match the agent's registration/);
  assert.equal(existsSync(files.tokenPath), false, "a refused token is consumed too");

  const elsewhere = join(run.store.dir, "token");
  writeFileSync(elsewhere, "f".repeat(64), { mode: 0o600 });
  const misplaced = refuse([...args.slice(0, -1), elsewhere]);
  assert.match(misplaced.stderr, /--token-file must be/);
  assert.equal(existsSync(elsewhere), true, "a file outside the agent directory is never read or unlinked");

  writeFileSync(files.tokenPath, "not a token\n", { mode: 0o600 });
  assert.match(refuse(args).stderr, /does not hold a token/);
  writeFileSync(files.tokenPath, "f".repeat(64), { mode: 0o644 });
  assert.match(refuse(args).stderr, /not a private regular file/);
  assert.match(refuse(["mcp", "--worker", "--execution", run.store.id]).stderr, /needs --execution, --agent and --token-file/);
  assert.equal(refuse(["mcp", "--bogus"]).code, 2);
  assert.match(refuse(["mcp", "--execution", run.store.id]).stderr, /go with --worker/);
});


test("entrypoint preserves the orchestrator umask and confines private defaults to heads-down", () => {
  const { childEnv } = childEnvironment;
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    process.umask(0o022);
    process.on("exit", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-umask-"));
      writeFileSync(join(root, "file"), "created");
      mkdirSync(join(root, "dir"));
      process.stderr.write("DEFAULT_MODES=" + JSON.stringify([statSync(join(root, "file")).mode & 0o777, statSync(join(root, "dir")).mode & 0o777]) + "\\n");
      rmSync(root, { recursive: true });
    });
  `);
  for (const args of [[], ["mcp"], ["mcp", "--worker"], ["hook", "pre-tool-use"], ["status"]]) {
    const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
      input: "", encoding: "utf8", timeout: 15_000, env: childEnv("runner", { ROUNDTABLE_DOTENV: "off" }),
    });
    assert.equal(result.error, undefined, result.stderr);
    const modes = /DEFAULT_MODES=(\[[^\]]+\])/.exec(result.stderr)?.[1];
    assert.ok(modes, result.stderr);
    const privateDefaults = args.includes("--worker") || args[0] === "hook" || args[0] === "status";
    assert.deepEqual(JSON.parse(modes), privateDefaults ? [0o600, 0o700] : [0o644, 0o755], args.join(" "));
  }
});
