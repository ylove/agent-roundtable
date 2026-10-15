// Generated worker files: mcp.json and settings.json (snapshots), prompt.md, the single-use token,
// leases.json, and their permissions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRun, registerWorker, runner } from "../fixtures/workers/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const files = await import("../../dist/workers/files.js");
const { taskBranch } = await import("../../dist/execution/git.js");
const { ROUNDTABLE_HOME } = await import("../../dist/config.js");

const EXEC = "/opt/node/bin/node";
const CLI = "/opt/agent roundtable/dist/index.js";

test("buildMcpConfig: one server, the worker CLI, a keyless env and nothing else (snapshot)", () => {
  assert.deepEqual(
    files.buildMcpConfig({ execPath: EXEC, cli: CLI, execution: "exe-0000000000abcdef", agent: "builder-1", tokenFile: "/state/agents/builder-1/token", home: "/state" }),
    {
      mcpServers: {
        roundtable: {
          type: "stdio",
          command: EXEC,
          args: [CLI, "mcp", "--worker", "--execution", "exe-0000000000abcdef", "--agent", "builder-1", "--token-file", "/state/agents/builder-1/token"],
          env: { ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME: "/state" },
        },
      },
    }
  );
  assert.throws(() => files.buildMcpConfig({ execPath: "node", cli: CLI, execution: "exe-0000000000abcdef", agent: "a", tokenFile: "/t", home: "/s" }), /absolute/);
  assert.throws(() => files.buildMcpConfig({ execPath: EXEC, cli: CLI, execution: "exe-0000000000abcdef", agent: "../x", tokenFile: "/t", home: "/s" }), /Not an agent id/);
});

test("buildWorkerSettings: denials (nested .git and .gitmodules too) and the lease hook (snapshot)", () => {
  assert.deepEqual(files.buildWorkerSettings({ execPath: EXEC, cli: CLI }), {
    permissions: {
      deny: [
        "Read(./.env*)", "Read(./**/.env*)",
        "Edit(./.git)", "Write(./.git)", "Edit(./.git/**)", "Write(./.git/**)",
        "Edit(./**/.git)", "Write(./**/.git)", "Edit(./**/.git/**)", "Write(./**/.git/**)",
        "Edit(./.gitmodules)", "Edit(./**/.gitmodules)",
        "Bash",
      ],
    },
    hooks: {
      PreToolUse: [{
        matcher: "Edit|Write|NotebookEdit|MultiEdit",
        hooks: [{ type: "command", command: `"${EXEC}" "${CLI}" hook pre-tool-use`, timeout: 30 }],
      }, {
        matcher: "Read|Glob|Grep",
        hooks: [{ type: "command", command: `"${EXEC}" "${CLI}" hook pre-tool-use`, timeout: 30 }],
      }],
    },
  });
});

test("shellQuotePath: paths a shell would interpret are refused", () => {
  assert.equal(files.shellQuotePath("/a b/c-d_e.f@1:2,3+4=5%6~"), '"/a b/c-d_e.f@1:2,3+4=5%6~"');
  for (const bad of ["/a$b", "/a`b`", '/a"b', "/a\\b", "/a\nb", "/a;b", "/a'b", "/a!b", "relative/path", "/a*b", "/a(b)"]) {
    assert.throws(() => files.shellQuotePath(bad), /Refusing/, JSON.stringify(bad));
  }
});

test("prepareWorkerFiles: 0600 files in 0700 dirs, a fresh token per call, the prompt, and leases.json", async () => {
  const run = await makeRun();
  const persona = { body: "You are the builder persona.", skills: [{ name: "css", path: "/x", body: "Use plain CSS." }] };
  const f = await files.prepareWorkerFiles({ store: run.store, agent: "builder-1", persona, task: "api", execPath: EXEC, cliPath: CLI });
  assert.equal(f.dir, join(run.store.dir, "agents", "builder-1"));
  for (const d of [join(run.store.dir, "agents"), f.dir, f.runsDir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  for (const p of [f.mcpConfigPath, f.settingsPath, f.promptPath, f.tokenPath, f.leasesPath]) assert.equal(statSync(p).mode & 0o777, 0o600, p);

  const mcp = JSON.parse(readFileSync(f.mcpConfigPath, "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["roundtable"]);
  const server = mcp.mcpServers.roundtable;
  assert.deepEqual(server.env, { ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME });
  assert.deepEqual(server.args.slice(-2), ["--token-file", f.tokenPath]);
  assert.ok(!JSON.stringify(mcp).match(/KEY|TOKEN=|SECRET|sk-/), "no secret in mcp.json");

  const token = readFileSync(f.tokenPath, "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(f.token_sha256, createHash("sha256").update(token).digest("hex"));
  assert.equal(f.token_sha256, files.tokenSha256(token));

  const prompt = readFileSync(f.promptPath, "utf8");
  assert.ok(prompt.startsWith("You are the builder persona."));
  assert.match(prompt, /### Skill: css/);
  assert.match(prompt, /Heads-down worker protocol/);
  assert.match(prompt, /task `api`/);
  assert.match(prompt, /run_command/);

  const leases = JSON.parse(readFileSync(f.leasesPath, "utf8"));
  assert.deepEqual(leases, { v: 1, execution: run.store.id, agent: "builder-1", seq: (await run.store.state()).seq, leases: [], task: "api", worktree: join(ROUNDTABLE_HOME, "worktrees", run.store.id, "api") });

  const again = await files.prepareWorkerFiles({ store: run.store, agent: "builder-1", persona, task: "api", execPath: EXEC, cliPath: CLI });
  assert.notEqual(again.token_sha256, f.token_sha256, "the token rotates on every prepare");
});

test("prepareWorkerFiles: a persona ref is loaded with loadAgent; unusable paths are refused before writing", async () => {
  const run = await makeRun();
  const sample = resolve(here, "../fixtures/agents/sample.md");
  const f = await files.prepareWorkerFiles({ store: run.store, agent: "builder-2", persona: sample, task: "api" });
  assert.match(readFileSync(f.promptPath, "utf8"), /Heads-down worker protocol/);
  assert.equal(JSON.parse(readFileSync(f.mcpConfigPath, "utf8")).mcpServers.roundtable.command, process.execPath);
  await assert.rejects(files.prepareWorkerFiles({ store: run.store, agent: "builder-3", persona: sample, task: "api", cliPath: "/tmp/$(evil)/index.js" }), /Refusing/);
  await assert.rejects(files.prepareWorkerFiles({ store: run.store, agent: "Builder", persona: sample, task: "api" }), /Not an agent id/);
});

test("writeAgentLeases: projects the agent's live leases and its task from the claim", async () => {
  const run = await makeRun();
  await registerWorker(run.store, "builder-1", "api");
  const lease = (id, agent, task, paths) => ({ type: "lease.granted", source: runner, payload: { lease: { id, agent, task, paths, mode: "exclusive", branch: taskBranch(run.store.id, task), reason: "", granted_seq: 0 } } });
  await run.store.transact(() => ({ events: [lease("lease-a", "builder-1", "api", ["src/api/**"]), lease("lease-b", "other", "build-nav-bar", ["src/components/nav/**"])] }));
  const f = await files.writeAgentLeases(run.store, "builder-1");
  assert.equal(f.task, "api");
  assert.deepEqual(f.leases, [{ id: "lease-a", task: "api", paths: ["src/api/**"], mode: "exclusive" }]);
  const onDisk = files.readAgentLeases(join(run.store.dir, "agents", "builder-1", "leases.json"));
  assert.deepEqual(onDisk, f);
  await assert.rejects(files.writeAgentLeases({ id: "exe-0000000000zzzzzz", state: run.store.state.bind(run.store) }, "builder-1"), /not found/, "never recreates a missing execution");
});
