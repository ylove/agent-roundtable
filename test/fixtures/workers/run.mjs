// A heads-down run for the worker tests: a temp repository, an execution, and a frozen contract
// built from direct contract.proposed / contract.frozen events (the contract tools are WS04's).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeExecution } from "../execution/git-fixture.mjs";

const { scrubbedJSON } = await import("../../../dist/execution/blobs.js");
const { tokenSha256, newAgentToken } = await import("../../../dist/workers/files.js");

export const runner = { kind: "runner", id: "runner", pid: process.pid };

/** node -e <code> as a contract command. */
export const nodeCommand = (id, code, extra = {}) => ({ id, argv: [process.execPath, "-e", code], timeout_s: 60, ...extra });

export function task(id, over = {}) {
  return {
    id,
    title: `Task ${id}`,
    persona: "builder",
    kind: "build",
    depends_on: [],
    paths: { write: [`src/${id}/**`] },
    acceptance: [`${id} works`],
    checks: [],
    ...over,
  };
}

export function contractFor(id, over = {}) {
  return {
    schema: "roundtable.contract/1",
    id,
    version: 1,
    status: "frozen",
    title: "Test contract",
    goal: { ultimate: "Ship the test app", original_prompt: "Please build the test app, with a nav bar.", artifacts: [] },
    scope: { orchestrator: "main", repo_root: "/repo", base_ref: "main", paths: ["src/**", "docs/**", ".gitattributes"] },
    participants: [],
    teams: [{ id: "web", lead: "lead", members: [] }],
    tasks: [task("api"), task("build-nav-bar", { team: "web", paths: { write: ["src/components/nav/**"] } })],
    interfaces: [],
    decisions: [{ id: "dec-1", scope: "contract", text: "Use plain CSS", by: "main" }],
    validation: { commands: [nodeCommand("pass", "process.exit(0)")], final: [] },
    budget: { usd: 50, per_task_usd: 10, wall_clock_min: 60, max_parallel: 3, max_attempts: 3 },
    authority: { lead: "lead", may: ["retry"], budget_extension_pct: 0 },
    sandbox: { backend: "local", image: "" },
    workers: { driver: "claude-code" },
    consent: [],
    ...over,
  };
}

/** A repository plus an execution with a frozen contract, started (status running) on the local sandbox. */
export async function makeRun({ files, contract: over = {}, start = true } = {}) {
  const exe = await makeExecution(files ?? { "README.md": "readme\n", "src/api/index.js": "export const api = 1;\n" });
  const ctrId = `ctr-${exe.store.id.slice(-6)}-1`;
  const contract = contractFor(ctrId, over);
  const blob = await exe.store.putBlob(scrubbedJSON(contract), { redact: false });
  const hash = createHash("sha256").update(scrubbedJSON(contract)).digest("hex");
  const events = [
    { type: "contract.proposed", source: runner, payload: { contract: ctrId, version: 1, source: "test", blob } },
    { type: "contract.frozen", source: runner, payload: { contract: ctrId, version: 1, by: "main", hash, blob } },
  ];
  if (start) {
    events.push({
      type: "execution.started",
      source: runner,
      payload: {
        confirmation: "go",
        visibility: { dashboard: false, chat_only: true },
        budget: contract.budget,
        lead: "lead",
        sandbox: "local",
        drivers: ["claude-code"],
      },
    });
  }
  await exe.store.transact(() => ({ events }));
  return { ...exe, contract };
}

/** Register a runner-managed worker (as the runner would) and pre-claim its task. Returns its token. */
export async function registerWorker(store, agent, taskId, { team, claim = true } = {}) {
  const { token, sha256 } = newAgentToken();
  const events = [
    { type: "agent.registered", source: runner, payload: { agent, persona: "builder", driver: "claude-code", token_sha256: sha256, external: false, ...(team && { team }) } },
  ];
  if (claim) events.push({ type: "task.claimed", source: runner, payload: { task: taskId, agent, attempt: 1, ttl_s: 0 } });
  await store.transact(() => ({ events }));
  return { token, sha256: tokenSha256(token) };
}

/** A fake program on PATH. `script` is the body of a node script; it must answer --help itself if needed. */
export function fakeBin(t, name, script) {
  const bin = mkdtempSync(join(tmpdir(), "rt-fake-bin-"));
  mkdirSync(bin, { recursive: true });
  const p = join(bin, name);
  writeFileSync(p, `#!${process.execPath}\n${script}\n`);
  chmodSync(p, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  t.after(() => {
    process.env.PATH = old;
  });
  return p;
}
