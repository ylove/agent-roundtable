import { installProcessIdentity } from "../fixtures/execution/process-identity.mjs";
installProcessIdentity();
// WS11: process operations an orchestrator tool hands to the runner (handoff.ts). The runner takes
// them before its watchdog pass and scheduler, applies each once, and deletes the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRun, task } from "../fixtures/workers/run.mjs";
import { sandbox, scriptedDriver } from "../fixtures/runner/driver.mjs";

const { Runner } = await import("../../dist/execution/runner.js");
const { writeHandoff, takeHandoffs, acknowledgeHandoff, handoffDir } = await import("../../dist/execution/handoff.js");

test("the runner applies a handed-over retry before scheduling, once, and removes the file", async (t) => {
  const run = await makeRun({ contract: { tasks: [task("a"), task("b")] } });
  const driver = scriptedDriver(t);
  const r = new Runner(run.store.id, { drivers: { "claude-code": driver }, sandbox: sandbox(), lockTimeoutMs: 10, tickMs: 10 });
  await r.start();
  t.after(async () => {
    r.stop("test cleanup");
    await r.run();
  });
  const op = { type: "spawn_retry", rule: "escalation", key: "esc-1:retry", target: "b", task: "b", attempt: 1 };
  assert.ok(writeHandoff(run.store.id, [op, op], "main"));
  await r.tick();
  // Contract order would start a first: b came from the handoff, ahead of the scheduler.
  assert.equal(driver.calls[0].task, "b");
  assert.deepEqual(driver.calls.map((c) => c.task).sort(), ["a", "b"]);
  assert.deepEqual(readdirSync(handoffDir(run.store.id)), []);
  writeHandoff(run.store.id, [op], "main");
  await r.tick();
  assert.equal(driver.calls.length, 2, "the same op key is applied once");
});

test("handoff files: only well-formed operations are handed over; a corrupt file is set aside", async () => {
  const run = await makeRun({ contract: { tasks: [task("a")] } });
  const exe = run.store.id;
  assert.equal(writeHandoff(exe, [{ type: "shell", key: "k", target: "x", rule: "escalation" }], "main"), null);
  writeHandoff(exe, [
    { type: "resume_worker", rule: "escalation", key: "e:resume", target: "w-a", agent: "w-a", task: "a", why: "Resolved", card: "card" },
    { type: "kill_worker", rule: "escalation", key: "e:kill", target: "w-b", agent: "w-b", reason: "Reassigned" },
  ], "main");
  writeFileSync(join(handoffDir(exe), `${"f".repeat(24)}.json`), "{not json");
  const ops = takeHandoffs(exe);
  assert.deepEqual(ops.map((o) => o.type), ["kill_worker", "resume_worker"], "stops before starts");
  assert.ok(existsSync(join(handoffDir(exe), `${"f".repeat(24)}.json.bad`)));
  assert.deepEqual(takeHandoffs(exe), ops, "a crash after reading loses no operation");
  for (const op of ops) acknowledgeHandoff(exe, op);
  assert.deepEqual(takeHandoffs(exe), []);
});
