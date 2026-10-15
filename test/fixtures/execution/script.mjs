// Shared fixtures for the execution store tests: a two-task contract and a scripted run.
import { scrubbedJSON } from "../../../dist/execution/blobs.js";

export const CONTRACT_ID = "ctr-abc123-1";

export const taskSpec = (id, deps = [], extra = {}) => ({
  id,
  title: `Task ${id}`,
  persona: "dev",
  kind: "build",
  depends_on: deps,
  paths: { write: [`src/${id}/**`] },
  acceptance: ["it works"],
  checks: ["test"],
  ...extra,
});

export function makeContract(over = {}) {
  return {
    schema: "roundtable.contract/1",
    id: CONTRACT_ID,
    version: 1,
    status: "consenting",
    title: "Nav bar",
    goal: { ultimate: "Ship the nav bar", original_prompt: "build a nav bar", artifacts: [] },
    scope: { orchestrator: "main", repo_root: "/srv/repo", base_ref: "main", paths: ["src/**"] },
    participants: [{ agent: "w1", team: "core" }, { agent: "w2", team: "ui" }],
    teams: [{ id: "core", lead: "w1", members: ["w1"] }],
    tasks: [taskSpec("a", [], { team: "core" }), taskSpec("b", ["a"])],
    interfaces: [{ name: "NavProps", kind: "type", owner: "a", description: "props of the nav bar" }],
    decisions: [{ id: "d0", scope: "contract", text: "Use CSS modules", by: "main" }],
    validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 600 }], final: ["test"] },
    budget: { usd: 10, per_task_usd: 5, wall_clock_min: 60, max_parallel: 3, max_attempts: 3 },
    authority: { lead: "w1", may: ["retry"], budget_extension_pct: 0 },
    sandbox: { backend: "docker", image: "node:22" },
    workers: { driver: "claude-code" },
    consent: [{ agent: "w1", verdict: "AGREE" }],
    ...over,
  };
}

export const src = (id = "runner", kind = "runner") => ({ kind, id, pid: process.pid });

/** Append one event through transact; returns the appended envelope. */
export async function emit(store, type, payload, extra = {}) {
  const { events } = await store.transact(() => ({ events: [{ type, payload, source: src(), ...extra }] }));
  return events[0];
}

/**
 * The scripted run from the reducer test: proposed → frozen (b depends on a) → claims → leases
 * granted, queued and expired → submitted → check failed twice (same signature) → submitted again
 * → merged (b becomes ready) → usage → decision and directive → escalation raised and resolved.
 * `stopAfter` ends the script early (for snapshot tests); returns the seq of each named step.
 */
export async function runScript(store, { from = 0, stopAfter = Infinity } = {}) {
  const steps = [];
  const blob = await store.putBlob(scrubbedJSON(makeContract()), { redact: false });
  const lease = { id: "L1", agent: "w1", task: "a", paths: ["src/a/**"], mode: "exclusive", branch: "rt/abc123/a", reason: "edit the nav", granted_seq: 0 };
  const request = { id: "R1", agent: "w2", task: "b", paths: ["src/a/x.ts"], mode: "shared", reason: "read the props", requested_seq: 0, blocking: ["L1"] };
  // Two different diffs: only a changed diff_blob counts as a new patch.
  const diffs = { c1: `sha256:${"1".repeat(64)}`, c2: blob };
  const submitted = (commit) => ({ task: "a", commit, diff_blob: diffs[commit], stat: "1 file changed", files: ["src/a/x.ts"], rewrites: [] });
  const failed = { command_id: "test", scope: "task", task: "a", exit: 1, signature: "sig-1" };
  const escalation = {
    id: "E1", task: "b", agent: "w2", kind: "ambiguity", with: "orchestrator", summary: "Which props?",
    blocking: true, status: "open", raised_seq: 0,
  };
  const script = [
    ["created", "execution.created", { repo_root: "/srv/repo", base_sha: "abc", contract: CONTRACT_ID, contract_version: 1 }, { mode: "deliberation" }],
    ["proposed", "contract.proposed", { contract: CONTRACT_ID, version: 1, source: "explicit", blob }, { mode: "deliberation" }],
    ["frozen", "contract.frozen", { contract: CONTRACT_ID, version: 1, by: "main", hash: "h1", blob }, { mode: "deliberation", source: src("main", "orchestrator") }],
    ["started", "execution.started", {
      confirmation: "go ahead", visibility: { dashboard: true, chat_only: false }, budget: makeContract().budget,
      lead: "w1", sandbox: "docker", drivers: ["claude-code"],
    }],
    ["reg1", "agent.registered", { agent: "w1", persona: "dev", team: "core", driver: "claude-code", token_sha256: "t1", external: false }],
    ["reg2", "agent.registered", { agent: "w2", persona: "dev", team: "ui", driver: "claude-code", token_sha256: "t2", external: false }],
    ["claimed", "task.claimed", { task: "a", agent: "w1", attempt: 1, ttl_s: 0 }],
    ["granted", "lease.granted", { lease }, { source: src("w1", "agent") }],
    ["queued", "lease.queued", { request }, { source: src("w2", "agent") }],
    ["progress", "task.progress", { task: "a", percent: 50, note: "halfway" }, { source: src("w1", "agent") }],
    ["expired", "lease.expired", { lease_id: "L1" }, { source: src("watchdog", "watchdog") }],
    ["submitted1", "task.submitted", submitted("c1"), { source: src("w1", "agent") }],
    ["check-started", "check.started", { command_id: "test", scope: "task", task: "a" }],
    ["fail1", "check.failed", failed],
    ["fail2", "check.failed", failed],
    ["submitted2", "task.submitted", submitted("c2"), { source: src("w1", "agent") }],
    ["checks-passed", "task.checks_passed", { task: "a", commands: ["test"] }],
    ["merged", "task.merged", { task: "a", integration_sha: "i1" }],
    ["usage1", "budget.usage_recorded", { source: "worker", agent: "w1", task: "a", model: "m", tokens: { inputTokens: 10, outputTokens: 5 }, usd: 0.25, estimated: false }],
    ["usage2", "budget.usage_recorded", { source: "huddle", model: "m", tokens: { inputTokens: 1, outputTokens: 1 }, usd: 0.5, estimated: true }],
    ["decision", "decision.recorded", { decision: { id: "d1", scope: "contract", text: "Use flexbox", by: "main" } }],
    ["directive", "directive.issued", { id: "dir1", to: ["core"], text: "Re-read the contract", requires_ack: true }],
    ["ack", "directive.acknowledged", { id: "dir1", agent: "w1" }, { source: src("w1", "agent") }],
    ["raised", "escalation.raised", { escalation }, { source: src("w2", "agent") }],
    ["resolved", "escalation.resolved", { id: "E1", action: "decide", decision: "Use the existing props", by: "main" }],
  ];
  const seqs = {};
  for (const [i, [name, type, payload, extra]] of script.entries()) {
    if (i < from) continue;
    if (i >= stopAfter) break;
    const ev = await emit(store, type, payload, extra ?? {});
    seqs[name] = ev.seq;
    steps.push(ev);
  }
  return { seqs, blob, steps, length: script.length };
}
