// buildTaskCard: goal and original prompt (capped), the task, dependencies, interfaces and
// decisions in force, the immediate context, and the protocol (which always survives the cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { contractFor, nodeCommand, task } from "../fixtures/workers/run.mjs";

const { buildTaskCard, CARD_LIMITS } = await import("../../dist/execution/task-card.js");
const { initialState, apply } = await import("../../dist/execution/blackboard.js");

const exe = "exe-0000000000abcdef";
let seq = 0;
const ev = (type, payload) => ({ v: 1, id: `evt-${++seq}`, seq, ts: "2026-10-15T00:00:00.000Z", execution: exe, mode: "execution", source: { kind: "runner", id: "runner", pid: 1 }, type, payload, prev: "0".repeat(64), hash: "h" });

function stateWith(contract, extra = []) {
  seq = 0;
  let s = apply(initialState(exe), ev("contract.frozen", { contract: contract.id, version: 1, by: "main", hash: "x", blob: "sha256:" + "0".repeat(64) }), { contract });
  for (const [type, payload] of extra) s = apply(s, ev(type, payload));
  return s;
}

const base = () =>
  contractFor("ctr-abcdef-1", {
    tasks: [
      task("api", { checks: ["unit"] }),
      task("build-nav-bar", { team: "web", depends_on: ["api"], paths: { write: ["src/components/nav/**"], read: ["src/api/**"] }, acceptance: ["Nav renders", "Links work"], checks: ["unit"], budget_usd: 4 }),
    ],
    interfaces: [{ name: "NavProps", kind: "type", owner: "build-nav-bar", description: "Props of the nav bar", consumers: ["api"] }, { name: "ApiClient", kind: "api", owner: "api", description: "HTTP client", consumers: ["build-nav-bar"] }],
    decisions: [{ id: "dec-1", scope: "contract", text: "Use plain CSS", rationale: "no build step", by: "main" }, { id: "dec-2", scope: "web", text: "Mobile first", by: "lead" }, { id: "dec-3", scope: "other-team", text: "Not for you", by: "lead" }],
    validation: { commands: [nodeCommand("unit", "process.exit(0)", { cwd: "src" })], final: [] },
  });

test("a card has every section of heads-down.md §9", () => {
  const s = stateWith(base(), [
    ["task.progress", { task: "api", percent: 100, note: "Client and routes done" }],
    ["task.submitted", { task: "api", commit: "c".repeat(40), diff_blob: "sha256:" + "1".repeat(64), stat: "3 files changed, 40 insertions(+)", files: ["src/api/client.js", "src/api/routes.js"], rewrites: [] }],
    ["task.merged", { task: "api", integration_sha: "d".repeat(40) }],
    ["artifact.published", { name: "ApiClient", kind: "interface", blob: "sha256:" + "2".repeat(64), task: "api", path: "src/api/client.js" }],
  ]);
  const card = buildTaskCard(s, "build-nav-bar", { immediate: { kind: "failure", text: "check unit failed: TypeError at nav.js:3" } });
  assert.match(card, /^# Task build-nav-bar: Task build-nav-bar/);
  assert.match(card, /## Ultimate goal\n\nShip the test app/);
  assert.match(card, /## The original request \(verbatim\)\n\n```\nPlease build the test app, with a nav bar\.\n```/);
  assert.match(card, /- Nav renders\n- Links work/);
  assert.match(card, /Write: `src\/components\/nav\/\*\*`/);
  assert.match(card, /Read: `src\/api\/\*\*`/);
  assert.match(card, /`unit`: `.+ -e process\.exit\(0\)` in `src`/);
  assert.match(card, /Budget for this task: \$4/);
  assert.match(card, /## Dependencies\n\n- `api` \(accepted\): Task api\n  Last note: Client and routes done\n  Changes: 3 files changed, 40 insertions\(\+\)\n  Files: src\/api\/client\.js, src\/api\/routes\.js/);
  assert.match(card, /`NavProps` \(type, owner build-nav-bar\), version 0: you own it/);
  assert.match(card, /`ApiClient` \(api, owner api\), version 1: you consume it\n  HTTP client; path `src\/api\/client\.js`; published as sha256:2{64}/);
  assert.match(card, /Use plain CSS \(why: no build step\) \[dec-1, contract\]/);
  assert.match(card, /Mobile first \[dec-2, web\]/);
  assert.doesNotMatch(card, /Not for you/, "decisions of other scopes are left out");
  assert.match(card, /## What failed\n\n```\ncheck unit failed: TypeError at nav\.js:3\n```/);
  assert.match(card, /## Protocol\n\n- Do not message other agents/);
  assert.match(card, /submit_work\(summary, ready: true\)/);
  assert.doesNotMatch(card, /agent_token/, "spawned workers are bound to their token");
});

test("external workers get the token and submit-time lease notes; text is scrubbed; unknown tasks throw", () => {
  const s = stateWith(base());
  const card = buildTaskCard(s, "api", { external: true, worktree: "/wt/api", immediate: "Resume with token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.match(card, /Worktree: \/wt\/api/);
  assert.match(card, /agent_token/);
  assert.match(card, /checked when you submit/);
  assert.doesNotMatch(card, /sk-ant-api03-abcdefghijklmnop/);
  assert.throws(() => buildTaskCard(s, "nope"), /Unknown task/);
});

test("the goal and the original prompt are capped, and the protocol survives the total cap", () => {
  const c = base();
  c.goal = { ultimate: "G".repeat(10_000), original_prompt: "P".repeat(20_000), artifacts: [] };
  const s = stateWith(c);
  const card = buildTaskCard(s, "api", { immediate: { kind: "note", text: "I".repeat(50_000) } });
  assert.ok(card.length <= CARD_LIMITS.total, `${card.length}`);
  assert.ok(!card.includes("G".repeat(CARD_LIMITS.goal + 1)));
  assert.ok(!card.includes("P".repeat(CARD_LIMITS.originalPrompt + 1)));
  assert.match(card, /… \[truncated\]/);
  assert.match(card, /## Protocol\n\n- Do not message other agents/);

  const huge = base();
  huge.tasks[0].acceptance = Array.from({ length: 200 }, (_, i) => `criterion ${i} ${"x".repeat(400)}`);
  const big = buildTaskCard(stateWith(huge), "api");
  assert.ok(big.length <= CARD_LIMITS.total);
  assert.match(big, /\[task card truncated\]\n\n## Protocol/);
});
