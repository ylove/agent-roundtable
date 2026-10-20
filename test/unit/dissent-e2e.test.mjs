// Drive a real submission check and the runner's watchdog/huddle hooks with a scripted worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { write } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, nodeCommand, task } from "../fixtures/workers/run.mjs";
import { scriptedDriver } from "../fixtures/runner/driver.mjs";
import { json, stubFetch } from "./helpers.mjs";
import { Runner } from "../../dist/execution/runner.js";
import { createRunnerHooks } from "../../dist/execution/escalation.js";
import { openExecutionStore } from "../../dist/execution/store.js";
import { handleToolCall } from "../../dist/tools.js";
import { resetWorkerTools } from "../../dist/tools/worker.js";

test("dissent end to end: a failed submission check notifies the dissenter and opens a micro-huddle with the tripper", { timeout: 120_000 }, async (t) => {
  const personas = mkdtempSync(join(tmpdir(), "rt-dissent-e2e-"));
  const critic = join(personas, "critic.md");
  const builder = join(personas, "builder.md");
  for (const [file, name] of [[critic, "critic"], [builder, "builder"]]) {
    writeFileSync(file, `---\nname: ${name}\ndescription: Test persona\n---\nYou are ${name}.\n`);
  }
  const oldPaths = process.env.ROUNDTABLE_AGENT_PATHS;
  process.env.ROUNDTABLE_AGENT_PATHS = [oldPaths, personas].filter(Boolean).join(delimiter);
  let run;
  let driver;
  let r;
  t.after(async () => {
    if (r) { r.stop("test cleanup"); await r.run(); }
    if (driver) await Promise.all(driver.calls.map((worker) => driver.stop(worker)));
    if (oldPaths === undefined) delete process.env.ROUNDTABLE_AGENT_PATHS;
    else process.env.ROUNDTABLE_AGENT_PATHS = oldPaths;
    resetWorkerTools();
    rmSync(personas, { recursive: true, force: true });
    if (run) rmSync(run.root, { recursive: true, force: true });
  });

  const claim = "The unit check will reject the submitted implementation.";
  const failure = "dissent-e2e validation failure";
  run = await makeRun({ contract: {
    participants: [{ agent: critic }, { agent: builder }],
    tasks: [task("a", { persona: builder, checks: ["unit"] })],
    validation: { commands: [nodeCommand("unit", `console.error(${JSON.stringify(failure)}); process.exit(1)`)], final: [] },
    dissents: [{ id: "check-risk", by: critic, source: { kind: "manual" }, claim,
      predicted_failure: "The unit validation fails after submission.",
      tripwire: { kind: "check_failed", check: "unit", task: "a" }, on_fire: "huddle" }],
  } });
  driver = scriptedDriver(t);
  let answers = 0;
  driver.answer = async (worker, prompt, cap) => {
    answers++;
    assert.equal(worker.agent, "w-a", "the live tripper answers as the counterpart");
    assert.ok(prompt.includes(claim));
    assert.ok(cap > 0 && cap <= 0.5);
    return { text: "I agree to repair the failing implementation before submitting again." };
  };
  const calls = stubFetch(t, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /You are critic/);
    return json(200, { model: body.model, choices: [{ message: { content: "Outcome: AGREED\nDecision: Repair the implementation and rerun the unit check." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  r = new Runner(run.store.id, { drivers: { "claude-code": driver }, tickMs: 10, lockTimeoutMs: 10,
    hooks: createRunnerHooks({ llm: { provider: "openai_compatible", model: "test-model", baseUrl: "http://localhost:4141/v1" } }) });
  await r.start();
  assert.equal((await run.store.state()).contract.status, "frozen");
  await r.tick();
  const [worker] = driver.calls;
  assert.ok(worker, "the runner launches the fake worker");
  assert.equal(worker.agent, "w-a");
  // Wait for init to be consumed before exercising the worker's authenticated submission tool.
  const deadline = Date.now() + 30_000;
  while (!existsSync(worker.outputPath) || !readFileSync(worker.outputPath, "utf8").includes('"subtype":"init"')) {
    assert.ok(Date.now() < deadline, "the fake worker emits init");
    await delay(20);
  }
  await r.tick();
  write(worker.cwd, "src/a/a.txt", "implementation with a failing unit check\n");
  const result = await handleToolCall("submit_work", {
    execution_id: run.store.id,
    agent_token: readFileSync(join(run.store.dir, "agents", worker.agent, "token"), "utf8").trim(),
    summary: "Submit the implementation for validation", ready: true,
  });
  assert.ok(!result.isError, result.content[0].text);
  const submission = JSON.parse(result.content[0].text);
  assert.equal(submission.checks_passed, false);
  assert.equal(submission.checks[0].command_id, "unit");
  assert.equal(submission.checks[0].exit, 1);
  assert.ok(submission.checks[0].output_tail.includes(failure), "the declared check actually ran");

  // Tick the real runner; do not insert a check failure, tripwire event or huddle by hand.
  const huddleDeadline = Date.now() + 30_000;
  while (!(await run.store.events()).some((e) => e.type === "huddle.concluded")) {
    assert.ok(Date.now() < huddleDeadline, "the runner concludes the dissent micro-huddle");
    await r.tick();
    await delay(20);
  }
  r.stop("observed dissent huddle");
  await r.run();
  const events = await run.store.events();
  const failed = events.find((e) => e.type === "check.failed" && e.payload.command_id === "unit" && e.payload.task === "a");
  assert.ok(failed);
  const fires = events.filter((e) => e.type === "dissent.tripwire_fired" && e.payload.dissent_id === "check-risk");
  assert.equal(fires.length, 1);
  assert.equal(fires[0].payload.task, "a");
  assert.equal(fires[0].payload.tripped_by, worker.agent);
  assert.ok(failed.seq < fires[0].seq);

  const directive = events.find((e) => e.type === "directive.issued" && e.payload.to.includes(critic) && e.payload.text.includes("check-risk"));
  assert.ok(directive, "the dissenter is explicitly notified");
  const state = await run.store.state();
  const inbox = state.inbox[critic].find((item) => item.kind === "directive" && item.id === directive.payload.id);
  assert.ok(inbox, "the directive reaches the dissenter's blackboard inbox");
  assert.equal(inbox.text, directive.payload.text);
  assert.ok(inbox.text.includes(claim));

  const raised = events.find((e) => e.type === "escalation.raised" && e.payload.escalation.dissent_id === "check-risk");
  assert.ok(raised);
  assert.equal(raised.payload.escalation.agent, critic);
  assert.equal(raised.payload.escalation.target, worker.agent);
  const started = events.find((e) => e.type === "huddle.started" && e.payload.escalation === raised.payload.escalation.id);
  assert.ok(started);
  assert.equal(started.payload.format, "micro");
  assert.deepEqual(started.payload.seats, ["critic", worker.agent]);
  const turns = events.filter((e) => e.type === "huddle.turn" && e.payload.id === started.payload.id);
  assert.deepEqual(turns.map((e) => e.payload.seat), ["critic", worker.agent, "critic"]);
  const opener = (await run.store.getBlob(turns[0].payload.blob)).toString("utf8");
  assert.ok(opener.includes(claim), "the dissenter opens with the retained concern");
  assert.equal(state.huddles[started.payload.id].outcome, "AGREED");
  assert.equal(answers, 1);
  assert.equal(calls.length, 1, "the dissenter makes the concluding persona call");
  // Reopening reads the same durable events and blackboard projection.
  assert.deepEqual(await (await openExecutionStore(run.store.id)).state(), state);
});
