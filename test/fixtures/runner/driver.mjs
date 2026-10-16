// Scripted detached workers for runner integration tests that do not need a sandbox backend.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { write } from "../execution/git-fixture.mjs";

const { spawnWorker, stopGroup } = await import("../../../dist/workers/process.js");
const { parseClaudeLine } = await import("../../../dist/workers/claude-code.js");
const { commitLeasedPaths, diffForTask } = await import("../../../dist/execution/worktrees.js");
const { integrationBranch } = await import("../../../dist/execution/git.js");
const { leasesFor } = await import("../../../dist/execution/leases.js");

export const goodInit = { type: "system", subtype: "init", tools: ["Read", "Edit", "Write", "Glob", "Grep", "mcp__roundtable__lease"], mcp_servers: [{ name: "roundtable", status: "connected" }] };
export const resultLine = (cost = 0.05) => ({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 20 } });
export const stream = (handle, lines) => appendFileSync(handle.outputPath, lines.map((l) => JSON.stringify(l) + "\n").join(""));

export function scriptedDriver(t, behavior = () => ({})) {
  const calls = [];
  const driver = {
    id: "claude-code",
    calls,
    detect: async () => ({ ok: true, missing: [] }),
    async launch(l) { return start(l, false); },
    async resume(_rec, l) { return start(l, true); },
    parse: parseClaudeLine,
    async stop(h) { await stopGroup(h.pid, 30, h.started); },
  };
  async function start(l, resume) {
    const b = behavior(l, calls.length);
    const init = b.init ?? goodInit;
    const script = b.sessionGone && resume ? `process.stderr.write("No conversation found with session ID\\n"); process.exit(1);` : `process.stdin.resume(); console.log(${JSON.stringify(JSON.stringify(init))}); ${b.result ? `console.log(${JSON.stringify(JSON.stringify(b.result))});` : ""} ${b.exit ? "setTimeout(() => process.exit(1), 20)" : "setInterval(() => {}, 1000)"};`;
    const { pid, started } = await spawnWorker({ file: process.execPath, args: ["-e", script], cwd: l.cwd, env: { PATH: process.env.PATH, ...l.env }, prompt: l.prompt, outputPath: l.outputPath });
    const handle = { ...l, pid, pgid: pid, started, startedAt: new Date().toISOString(), resume };
    calls.push(handle);
    return handle;
  }
  t.after(async () => { await Promise.all(calls.map((h) => driver.stop(h))); });
  return driver;
}

export const sandbox = (onRun = async () => {}) => ({
  id: "local",
  available: async () => ({ ok: true }),
  async run(req) {
    await onRun(req);
    return { exit: 0, timedOut: false, durationMs: 1, output: "passed", truncated: false, backend: "local" };
  },
});

/** Simulate a worker submission through the same git/lease APIs used by the worker tools. */
export async function submit(store, handle, { checks = true, content } = {}) {
  const state = await store.state();
  write(handle.cwd, `src/${handle.task}/${handle.task}.txt`, content ?? `${handle.task}\n`);
  const committed = await commitLeasedPaths(handle.cwd, leasesFor(state, handle.task), { message: "task done", trailers: { execution: store.id, task: handle.task, agent: handle.agent }, summaryBase: integrationBranch(store.id) });
  const diff = await store.putBlob(await diffForTask(handle.cwd, integrationBranch(store.id)));
  const source = { kind: "agent", id: handle.agent, task: handle.task, pid: handle.pid };
  await store.transact(({ state: current }) => ({ events: [
    { type: "task.submitted", source, payload: { task: handle.task, commit: committed.commit, diff_blob: diff, stat: committed.stat, files: committed.files, rewrites: committed.rewrites } },
    ...(checks ? [{ type: "task.checks_passed", source, payload: { task: handle.task, commands: state.tasks[handle.task].spec.checks, commit: committed.commit, submitted_seq: current.seq + 1 } }] : []),
  ] }));
}
