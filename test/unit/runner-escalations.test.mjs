// WS10's hooks in the real runner: a fake claude escalates (with: orchestrator, blocking), the
// runner's escalation router routes it, and it is resolved by the orchestrator (watch, then
// resolve_escalation) or, with no watcher alive, by the contract's lead after the grace period.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRun, nodeCommand, task } from "../fixtures/workers/run.mjs";
import { createServer } from "node:net";

// The process harness starts a provider listener. Keep hook-only smoke tests runnable offline.
const canListen = await new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", (err) => {
    if (err.code === "EPERM" || err.code === "EACCES") resolve(false);
    else throw err;
  });
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
});
const { cli, fakeClaude, killFakes, localSandboxSkip, provider, RUNNER_ENV, startRunner, waitFor } =
  canListen ? await import("../fixtures/runner/harness.mjs") : {};
const ofType = (events, type) => events.filter((e) => e.type === type);
import { json, stubFetch } from "./helpers.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { runRunner } = await import("../../dist/execution/runner.js");
const { AUDIT_DIR } = await import("../../dist/config.js");
const { readdirSync, readFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");

const skip = canListen ? localSandboxSkip() : "localhost listeners are unavailable in this sandbox";

const ESCALATE = { kind: "ambiguity", with: "orchestrator", summary: "REST or GraphQL for the API?", question: "Which API style should task a use?", blocking: true };
const oneTask = () => ({
  tasks: [task("a", { checks: ["unit"] })],
  validation: { commands: [nodeCommand("unit", "process.exit(0)")], final: [] },
});

function within(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out: ${what()}`)), ms)))]).finally(() => clearTimeout(timer));
}

test("the real hooks route a blocking escalation, watch wakes the orchestrator, resolve_escalation resumes the task, and the run completes", { skip, timeout: 240_000 }, async (t) => {
  const fake = fakeClaude(t, { "w-a": { escalate: ESCALATE } });
  const run = await makeRun({ contract: oneTask() });
  const exe = run.store.id;
  const r = startRunner(exe);
  t.after(() => {
    r.child.kill("SIGKILL");
    killFakes(fake);
  });

  // The runner's escalation router (WS10) routes it to the contract's orchestrator, waking it.
  const routed = await waitFor(async () => ofType(await run.store.events(), "escalation.routed")[0], 120_000, "escalation.routed");
  const id = routed.payload.id;
  assert.deepEqual(routed.payload, { id, to: "main", wake: true }, r.stderr());
  const raised = (await run.store.state()).escalations[id];
  assert.equal(raised.agent, "w-a");
  assert.equal(raised.blocking, true);
  assert.equal((await run.store.state()).tasks.a.state, "blocked");

  // The orchestrator's watcher exits with that escalation.
  const w = await cli(["watch", exe, "--as", "main", "--timeout-min", "2"]);
  assert.equal(w.code, 0, w.stderr);
  const wake = JSON.parse(w.stdout.trim().split("\n").at(-1));
  assert.equal(wake.reason, "escalation");
  assert.equal(wake.escalation.id, id);
  assert.match(wake.escalation.summary, /REST or GraphQL/);

  // resolve_escalation (WS11) decides; the runner resumes the worker with the resolution.
  const res = JSON.parse((await handleToolCall("resolve_escalation", { execution_id: exe, escalation_id: id, action: "decide", decision: "Use REST for the API." })).content[0].text);
  assert.equal(res.applied, "decide");
  assert.deepEqual(res.handed_to_runner, [{ type: "resume_worker", task: "a", agent: "w-a" }]);

  const exit = await within(r.exited, 200_000, () => `the run to finish; runner log:\n${r.stderr()}`);
  assert.equal(exit.code, 0, r.stderr());
  const state = await run.store.state();
  assert.equal(state.status, "completed");
  assert.equal(state.tasks.a.state, "accepted");
  assert.equal(state.escalations[id].status, "resolved");
  assert.deepEqual(state.escalations[id].resolution, { action: "decide", decision: "Use REST for the API.", by: "main" });
  const launches = fake.launches("w-a");
  assert.ok(launches.length >= 2, "launched again after the resolution");
  assert.equal(launches[1].resume, true, "the session is resumed");
  assert.ok(launches.slice(1).some((l) => l.input.includes("Use REST for the API.")), "the resolution is on the resumed card");
  // The real goal review ran (through the harness's stub provider) before completion.
  assert.ok(provider.calls.some((b) => JSON.stringify(b.messages).includes("Verdict:")));
});

test("with no watcher alive, the lead fallback runs after the grace period and decides within its authority", { skip, timeout: 240_000 }, async (t) => {
  const env = { ...RUNNER_ENV, ROUNDTABLE_EXECUTION_PROVIDER: "openai_compatible", ROUNDTABLE_EXECUTION_MODEL: "gpt-4o-mini", ROUNDTABLE_EXECUTION_BASE_URL: "http://localhost:4141/v1" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const fake = fakeClaude(t, { "w-a": { escalate: ESCALATE } });
  t.after(() => killFakes(fake));
  const calls = stubFetch(t, async (url, init) => {
    assert.equal(url, "http://localhost:4141/v1/chat/completions");
    const body = JSON.parse(init.body);
    const text = body.messages[0].content.includes("## Lead fallback")
      ? "Action: decide\nDecision: Use REST for the API; the orchestrator can revisit it."
      : "Verdict: COMPLETE\nGaps: None";
    return json(200, { model: body.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const run = await makeRun({ contract: oneTask() });
  const exe = run.store.id;

  // The real runner in this process (runRunner installs createRunnerHooks), with a short grace.
  const code = await within(runRunner(exe, { tickMs: 100, lockTimeoutMs: 10, watchdog: { leadGraceMs: 500 } }), 200_000, () => "the run to finish");
  assert.equal(code, 0);

  const events = await run.store.events();
  const id = ofType(events, "escalation.raised")[0].payload.escalation.id;
  assert.deepEqual(ofType(events, "escalation.routed").map((e) => e.payload), [
    { id, to: "main", wake: true },
    { id, to: "lead", wake: false },
  ]);
  const state = await run.store.state();
  assert.equal(state.status, "completed");
  assert.equal(state.tasks.a.state, "accepted");
  assert.deepEqual(state.escalations[id].resolution, { action: "decide", decision: "Use REST for the API; the orchestrator can revisit it.", by: "lead" });
  assert.equal(ofType(events, "escalation.resolved")[0].source.id, "lead");
  // One lead call (obs.leadInFlight while it ran), at the configured provider; the lead's usage is on the ledger.
  assert.equal(calls.filter((c) => c.body.messages[0].content.includes("## Lead fallback")).length, 1);
  assert.equal(calls[0].body.model, "gpt-4o-mini");
  assert.ok(ofType(events, "budget.usage_recorded").some((e) => e.payload.source === "lead"));
  const audit = existsSync(AUDIT_DIR) ? readdirSync(AUDIT_DIR).filter((p) => p.endsWith(".jsonl")).flatMap((p) => readFileSync(join(AUDIT_DIR, p), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)) : [];
  const decision = audit.find((e) => e.action === "escalation.lead_decision" && e.details.execution === exe);
  assert.equal(decision.details.applied, "decide");
  assert.ok(fake.launches("w-a").length >= 2, "the worker ran again after the lead's decision");
});

const { createRunnerHooks } = await import("../../dist/execution/escalation.js");
const { actionsToDrafts, evaluate, escalationId } = await import("../../dist/execution/watchdog.js");
const { openExecutionStore } = await import("../../dist/execution/store.js");
const { writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { mkdtempSync } = await import("node:fs");

for (const funded of [true, false]) {
  test(`runner dissent smoke: check failure delivers inbox and ${funded ? "huddle transcript plus tripper resume" : "budget fallback wake"}`, async (t) => {
    const personas = mkdtempSync(join(tmpdir(), "rt-dissent-personas-"));
    const critic = join(personas, "critic.md");
    const builder = join(personas, "builder.md");
    for (const [file, name] of [[critic, "critic"], [builder, "builder"]]) writeFileSync(file, `---\nname: ${name}\ndescription: Test persona\n---\nYou are ${name}.\n`);
    const oldPaths = process.env.ROUNDTABLE_AGENT_PATHS;
    process.env.ROUNDTABLE_AGENT_PATHS = `${oldPaths}:${personas}`;
    const run = await makeRun({ contract: {
      tasks: [task("a", { persona: builder })],
      dissents: [{ id: "check-risk", by: critic, source: { kind: "manual" }, claim: "The unit check will fail", predicted_failure: "Regression", tripwire: { kind: "check_failed", check: "unit", task: "a" }, on_fire: "pause_and_huddle" }],
      validation: { commands: [nodeCommand("unit", "process.exit(1)")], final: [] },
    } });
    t.after(() => {
      process.env.ROUNDTABLE_AGENT_PATHS = oldPaths;
      rmSync(personas, { recursive: true, force: true });
      rmSync(run.root, { recursive: true, force: true });
    });
    const source = { kind: "runner", id: "runner", pid: process.pid };
    const events = [
      { type: "agent.registered", source, payload: { agent: "tripper", persona: builder, driver: "claude-code", external: false, token_sha256: "a".repeat(64) } },
      { type: "task.claimed", source, payload: { task: "a", agent: "tripper", attempt: 1, ttl_s: 0 } },
      { type: "check.failed", source, payload: { task: "a", scope: "task", command_id: "unit", exit: 1, signature: "regression" } },
    ];
    if (!funded) events.push({ type: "budget.usage_recorded", source, payload: { source: "worker", model: "test", tokens: { inputTokens: 0, outputTokens: 0 }, usd: run.contract.budget.usd, estimated: false } });
    await run.store.transact(() => ({ events }));
    await run.store.transact(({ state }) => ({ events: actionsToDrafts(evaluate(state, Date.now()).filter((a) => a.rule === "dissent_tripwire")) }));
    // Reopen to exercise the runner's recovery path from the durable log.
    const store = await openExecutionStore(run.store.id);
    let state = await store.state();
    const id = escalationId("tripwire:check-risk:a");
    assert.equal(ofType(await store.events(), "dissent.tripwire_fired").length, 1);
    assert.equal(state.inbox[critic].length, 1);
    assert.match(state.inbox[critic][0].text, /Claim:\nThe unit check will fail/);
    const calls = stubFetch(t, async (_url, init, index) => {
      assert.ok(funded, "no provider call without budget");
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content, /You are critic/);
      assert.equal(index, 0, "only the dissenter's conclusion uses a persona call");
      return json(200, { model: body.model, choices: [{ message: { content: "Outcome: AGREED\nDecision: Repair the check failure" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    let answers = 0;
    const hooks = createRunnerHooks({ llm: { provider: "openai_compatible", model: "gpt-4o-mini", baseUrl: "http://localhost:4141/v1" } });
    const ctx = {
      execution: store.id, store, header: store.header(), source, log() {},
      worker: (agent) => agent === "tripper" ? { driver: "claude-code" } : undefined,
      driver: () => ({ id: "claude-code", answer: async (_worker, prompt, cap) => {
        answers++;
        assert.match(prompt, /The unit check will fail/);
        assert.ok(cap > 0 && cap <= 0.5);
        return { text: "I will repair the regression" };
      } }),
    };
    const ops = await hooks.escalationRouter(ctx, state.escalations[id]);
    state = await store.state();
    if (funded) {
      assert.equal(answers, 1);
      assert.equal(calls.length, 1);
      const turns = ofType(await store.events(), "huddle.turn");
      assert.deepEqual(turns.map((e) => e.payload.seat), ["critic", "tripper", "critic"]);
      const transcript = await Promise.all(turns.map(async (e) => (await store.getBlob(e.payload.blob)).toString("utf8")));
      assert.match(transcript.join("\n"), /Claim:\nThe unit check will fail/);
      assert.match(transcript[2], /Outcome: AGREED/);
      assert.equal(state.tasks.a.state, "in_progress");
      assert.deepEqual(ops.map((op) => [op.type, op.task, op.agent]), [["resume_worker", "a", "tripper"]]);
    } else {
      assert.equal(answers, 0);
      assert.equal(calls.length, 0);
      assert.equal(state.tasks.a.state, "claimed");
      assert.equal(state.escalations[id].routed_to, "main");
      assert.equal(ofType(await store.events(), "escalation.routed")[0].payload.wake, true);
    }
    assert.equal(evaluate(state, Date.now()).filter((a) => a.rule === "dissent_tripwire").length, 0);
  });
}
