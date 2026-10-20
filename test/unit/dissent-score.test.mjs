import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRun, task } from "../fixtures/workers/run.mjs";
import { mkdirSync, rmSync } from "node:fs";

import { join } from "node:path";

const { handleToolCall, tools } = await import("../../dist/tools.js");
const { contractHash } = await import("../../dist/execution/contract.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const spec = { id: "risk", by: "critic", source: { kind: "manual" }, claim: "Concern", predicted_failure: "Regression", tripwire: { kind: "task_state", task: "a", state: "blocked" }, on_fire: "notify" };

test("score_dissent is orchestrator-only, validates references and outcomes, and never changes contract or consent", async (t) => {
  const run = await makeRun({ contract: { tasks: [task("a")], dissents: [spec] } });
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  mkdirSync(join(run.store.dir, "contracts", run.contract.id), { recursive: true });
  const args = { contract_id: run.contract.id, orchestrator: "main", dissent_id: "risk", outcome: "vindicated" };
  const before = await run.store.state();
  const hash = contractHash(before.contract);
  const tool = tools.find((tool) => tool.name === "score_dissent");
  assert.match(tool.description, /never weight votes/);
  for (const outcome of ["vindicated", "refuted", "untested"]) {
    const result = await handleToolCall("score_dissent", { ...args, outcome });
    assert.ok(!result.isError, result.content[0].text);
    assert.deepEqual(JSON.parse(result.content[0].text), { dissent_id: "risk", outcome, advisory: true });
    const state = await run.store.state();
    assert.equal(state.dissents.risk.score, outcome);
    assert.equal(contractHash(state.contract), hash);
    assert.deepEqual(state.contract.consent, before.contract.consent);
    assert.deepEqual(state.contract.participants, before.contract.participants);
    assert.deepEqual(state.tasks, before.tasks);
  }
  const events = await run.store.events({ types: ["dissent.scored"] });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].source, { kind: "orchestrator", id: "main", pid: process.pid });
  assert.deepEqual(await (await openExecutionStore(run.store.id)).state(), await run.store.state());
  for (const [patch, mode] of [[{ orchestrator: "other" }], [{ dissent_id: "missing" }], [{ outcome: "trusted" }], [{}, "worker"]]) {
    const result = await handleToolCall("score_dissent", { ...args, ...patch }, mode);
    assert.equal(result.isError, true, result.content[0].text);
  }
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 3);
});

test("shared scoring validates direct callers and deduplicates retries without reverting a later assessment", async (t) => {
  const { scoreDissent } = await import("../../dist/execution/dissent-scoring.js");
  const run = await makeRun({ contract: { tasks: [task("a")], dissents: [spec] } });
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  const input = { contractId: run.contract.id, orchestrator: "main", dissentId: "risk", outcome: "vindicated" };
  for (const patch of [{ outcome: "trusted" }, { orchestrator: "other" }, { dissentId: "constructor" }, { contractId: "other" }]) {
    await assert.rejects(scoreDissent(run.store, { ...input, ...patch }));
  }
  await Promise.all([scoreDissent(run.store, input), scoreDissent(run.store, input)]);
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 1);
  const operation = { ...input, outcome: "untested", operationKey: "postmortem:retry" };
  await scoreDissent(run.store, operation);
  await scoreDissent(run.store, { ...input, outcome: "refuted" });
  await scoreDissent(run.store, operation);
  assert.equal((await run.store.state()).dissents.risk.score, "refuted");
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 3);
  await assert.rejects(scoreDissent(run.store, { ...operation, outcome: "refuted" }), /identity was reused/);
  const state = await run.store.state();
  const { validateDissentScore } = await import("../../dist/execution/dissent-scoring.js");
  assert.throws(() => validateDissentScore({ ...state, contract: { ...state.contract, status: "draft" } }, input), /frozen/);
});
