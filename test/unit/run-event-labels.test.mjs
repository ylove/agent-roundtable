import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES } from "../../dist/execution/types.js";
import { describeEvent } from "../../dist/dashboard/event-labels.js";
import { eventSummary, renderEvents } from "../../dist/dashboard/render.js";
import { frozenRun, makeContract, taskSpec } from "../fixtures/execution/run.mjs";
import { inlineProblems } from "./helpers.mjs";

const task = { task: "api" }, id = { id: "item-1" };
const examples = {
  "execution.created": [{ contract: "ctr-1", contract_version: 2 }, "Run created for contract ctr-1, version 2"],
  "execution.started": [{ budget: { usd: 10 }, lead: "lead" }, "Run started with a $10.00 budget and lead leading"],
  "execution.paused": [{ reason: "human review" }, "Run paused: human review"],
  "execution.resumed": [{ reason: "review complete" }, "Run resumed: review complete"],
  "execution.steered": [{ targets: ["w-a"], message: "Keep focus" }, "Instructions sent to w-a: Keep focus"],
  "execution.mode_changed": [{ from: "deliberation", to: "execution", reason: "approved" }, "Run changed from deliberation to execution: approved"],
  "execution.completed": [{ integration_sha: "abc" }, "Run completed at commit abc"],
  "execution.failed": [{ reason: "check failed" }, "Run failed: check failed"],
  "execution.aborted": [{ reason: "cancelled by owner" }, "Run aborted: cancelled by owner"],
  "contract.proposed": [{ contract: "ctr-1", version: 2 }, "Contract ctr-1, version 2, proposed"],
  "contract.consent_requested": [{ contract: "ctr-1", participants: ["builder", "critic"] }, "Agreement requested on contract ctr-1 from builder, critic"],
  "contract.consent_recorded": [{ agent: "critic", verdict: "AGREE", contract: "ctr-1" }, "critic recorded AGREE on contract ctr-1"],
  "contract.objection_resolved": [{ agent: "critic", contract: "ctr-1", how: "amended", reason: "clarified" }, "critic's objection to ctr-1 was amended: clarified"],
  "contract.frozen": [{ contract: "ctr-1", version: 2, by: "main" }, "Contract ctr-1, version 2, approved for execution by main"],
  "contract.amended": [{ contract: "ctr-1", version: 3, reason: "clarified" }, "Contract ctr-1 amended to version 3: clarified"],
  "contract.superseded": [{ contract: "ctr-1", by_contract: "ctr-2" }, "Contract ctr-1 replaced by ctr-2"],
  "runner.started": [{ pid: 42 }, "Scheduler process 42 started"],
  "runner.takeover": [{ previous_pid: 42 }, "Scheduler took over from process 42"],
  "runner.stopped": [{ reason: "finished" }, "Scheduler stopped: finished"],
  "agent.registered": [{ agent: "w-a", driver: "codex", persona: "builder" }, "Worker w-a registered with runtime codex as builder"],
  "agent.spawned": [{ ...task, agent: "w-a", attempt: 2 }, "Worker w-a started on task Build navigation (api) (attempt 2)"],
  "agent.attested": [{ agent: "w-a", ok: false }, "Worker w-a failed its tool access check"],
  "agent.exited": [{ ...task, agent: "w-a", reason: "error", code: 1 }, "Worker w-a exited on task Build navigation (api): error (exit 1)"],
  "agent.left": [{ agent: "w-a", reason: "finished" }, "Worker w-a left: finished"],
  "agent.stop_requested": [{ agent: "w-a", by: "owner" }, "owner requested a stop for worker w-a"],
  "agent.stopped": [{ ...task, agent: "w-a" }, "Worker w-a stopped on task Build navigation (api)"],
  "task.ready": [task, "Task Build navigation (api) is ready for a worker"],
  "task.claimed": [{ ...task, agent: "w-a", attempt: 2 }, "Task Build navigation (api) claimed by worker w-a (attempt 2)"],
  "task.released": [{ ...task, agent: "w-a", note: "handoff" }, "Task Build navigation (api) released by worker w-a: handoff"],
  "task.progress": [{ ...task, percent: 40, note: "keyboard done" }, "Task Build navigation (api) reached 40%: keyboard done"],
  "task.submitted": [{ ...task, summary: "Ready for review" }, "Task Build navigation (api) submitted for review: Ready for review"],
  "task.checks_passed": [{ ...task, commands: ["test"] }, "Task Build navigation (api) passed checks: test"],
  "task.rejected": [{ ...task, reasons: ["focus lost"] }, "Task Build navigation (api) returned for changes: focus lost"],
  "task.merged": [{ ...task, integration_sha: "abc" }, "Task Build navigation (api) merged into integration at abc"],
  "task.accepted": [task, "Task Build navigation (api) completed and accepted"],
  "task.blocked": [{ ...task, escalation: "esc-1" }, "Task Build navigation (api) blocked by escalation esc-1"],
  "task.unblocked": [task, "Task Build navigation (api) can continue"],
  "task.retried": [{ ...task, attempt: 2, why: "focus lost" }, "Task Build navigation (api) retried (attempt 2): focus lost"],
  "task.reassigned": [{ ...task, from: "builder", to: "designer" }, "Task Build navigation (api) reassigned from builder to designer"],
  "task.split": [{ ...task, into: [{ id: "child", title: "Keyboard checks" }] }, "Task Build navigation (api) split into Keyboard checks (child)"],
  "task.spawned": [{ ...task, by: "w-a", into: [{}] }, "Task Build navigation (api) delegated 1 subtasks by w-a"],
  "task.subtasks_awaited": [task, "Task Build navigation (api) is waiting for its subtasks"],
  "task.subtasks_joined": [{ ...task, children: ["b"] }, "Task Build navigation (api) combined completed subtasks: untitled task (b)"],
  "task.failed": [{ ...task, why: "attempts exhausted" }, "Task Build navigation (api) failed: attempts exhausted"],
  "task.cancelled": [{ ...task, why: "scope reduced" }, "Task Build navigation (api) cancelled: scope reduced"],
  "lease.granted": [{ lease: { ...task, agent: "w-a", paths: ["src/**"] } }, "Write access granted to w-a for task Build navigation (api): src/**"],
  "lease.queued": [{ request: { ...task, agent: "w-a", paths: ["src/**"] } }, "File access queued for w-a on task Build navigation (api): src/**"],
  "lease.released": [{ lease_id: "lease-1" }, "File access reservation lease-1 released"],
  "lease.expired": [{ lease_id: "lease-1" }, "File access reservation lease-1 expired"],
  "lease.revoked": [{ lease_id: "lease-1", by: "owner", reason: "pause" }, "File access reservation lease-1 revoked by owner: pause"],
  "lease.violation": [{ ...task, agent: "w-a", paths: ["secret/**"] }, "Worker w-a wrote outside task Build navigation (api)'s allowed paths: secret/**"],
  "artifact.published": [{ ...task, kind: "interface", name: "NavigationProps" }, "interface artifact NavigationProps published by task Build navigation (api)"],
  "artifact.changed": [{ name: "NavigationProps", version: 2 }, "Artifact NavigationProps updated to version 2"],
  "dependency.requested": [{ ...task, need: { kind: "interface", ref: "Props" } }, "Task Build navigation (api) needs interface Props"],
  "dependency.satisfied": [{ ...task, need: { kind: "interface", ref: "Props" } }, "Task Build navigation (api) received interface Props"],
  "check.started": [{ ...task, command_id: "test" }, "Check test started on task Build navigation (api)"],
  "check.passed": [{ ...task, command_id: "test", duration_ms: 1200 }, "Check test passed on task Build navigation (api) (1.2 seconds)"],
  "check.failed": [{ ...task, command_id: "test", exit: 1 }, "Check test failed on task Build navigation (api) (exit 1)"],
  "check.timed_out": [{ ...task, command_id: "test" }, "Check test timed out on task Build navigation (api)"],
  "command.completed": [{ ...task, argv: ["npm", "test"], exit: 0 }, "Command npm test finished on task Build navigation (api) (exit 0)"],
  "merge.succeeded": [{ ...task, sha: "abc" }, "Task Build navigation (api) merged successfully at abc"],
  "merge.conflicted": [{ ...task, files: ["nav.ts"] }, "Task Build navigation (api) has merge conflicts in nav.ts"],
  "note.posted": [{ topic: "focus", text: "Restore focus" }, "Note on focus: Restore focus"],
  "decision.recorded": [{ decision: { by: "main", text: "Keep focus" } }, "main decided: Keep focus"],
  "directive.issued": [{ ...id, to: ["w-a"], text: "Keep focus" }, "Instruction item-1 sent to w-a: Keep focus"],
  "directive.acknowledged": [{ ...id, agent: "w-a" }, "w-a acknowledged instruction item-1"],
  "dissent.tripwire_fired": [{ ...task, dissent_id: "focus", evidence: "Focus check failed" }, "Concern focus matched recorded evidence on task Build navigation (api): Focus check failed"],
  "dissent.scored": [{ dissent_id: "focus", outcome: "vindicated" }, "Concern focus assessed as vindicated"],
  "escalation.raised": [{ escalation: { ...task, emergency: "money", summary: "$5.00 more" } }, "Budget extension requested for task Build navigation (api): $5.00 more"],
  "escalation.routed": [{ ...id, to: "main" }, "Escalation item-1 sent to main"],
  "escalation.auto_resolved": [{ ...id, rule: "dependency ready" }, "Escalation item-1 resolved automatically: dependency ready"],
  "escalation.resolved": [{ ...id, by: "main", action: "decide", decision: "Approved" }, "Escalation item-1 resolved by main (decide): Approved"],
  "escalation.awaiting_human": [{ ...id, message: "Approve more budget?" }, "Escalation item-1 needs a human: Approve more budget?"],
  "escalation.withdrawn": [{ ...id, reason: "no longer needed" }, "Escalation item-1 withdrawn: no longer needed"],
  "huddle.started": [{ ...id, escalation: "esc-1", seats: ["builder", "critic"] }, "Discussion item-1 started for escalation esc-1 with builder, critic"],
  "huddle.turn": [{ ...id, seat: "critic" }, "critic spoke in discussion item-1"],
  "huddle.concluded": [{ ...id, outcome: "NEEDS_ORCHESTRATOR", decision: "Ask owner" }, "Discussion item-1 concluded: needs orchestrator: Ask owner"],
  "budget.usage_recorded": [{ ...task, agent: "w-a", usd: 1.5, estimated: false }, "$1.50 recorded for w-a on task Build navigation (api)"],
  "budget.threshold_crossed": [{ pct: 80, spent_usd: 8, budget_usd: 10 }, "Budget reached 80%: $8.00 used of $10.00"],
  "budget.exhausted": [{ scope: "task", ref: "api" }, "Budget exhausted for task Build navigation (api)"],
  "budget.extended": [{ by: "owner", usd: 5 }, "Budget increased by $5.00 by owner"],
  "watchdog.action": [{ rule: "stalled", action: "retry_task", target: "api" }, "Run monitor applied retry task to api: stalled"],
  "watchdog.circuit_opened": [{ driver: "codex", reason: "three failures" }, "Runtime codex temporarily suspended after repeated failures: three failures"],
  "watchdog.circuit_closed": [{ driver: "codex" }, "Runtime codex can accept work again"],
  "watchdog.deadlock_detected": [{ cycle: ["api", "b"] }, "Tasks are waiting on one another: Build navigation (api), untitled task (b)"],
  "watchdog.stall_detected": [{ ...task, agent: "w-a" }, "Worker w-a stopped making progress on task Build navigation (api)"],
  "sandbox.degraded": [{ backend: "docker", reason: "unavailable" }, "Sandbox docker has reduced isolation: unavailable"],
  "postmortem.finding_recorded": [{ ...id, summary: "Focus reset" }, "Review finding item-1 recorded: Focus reset"],
  "postmortem.fix_updated": [{ ...id, status: "fixed", by: "builder" }, "Review finding item-1 marked fixed by builder"],
  "postmortem.started": [{ ...id, seats: ["builder", "critic"] }, "Retrospective item-1 started with builder, critic"],
  "postmortem.concluded": [{ ...id, flagged: 2 }, "Retrospective item-1 concluded with 2 artifacts flagged for review"],
};

test("every event type has a sentence using its fields, with a human time and actor in the page", async t => {
  assert.deepEqual(Object.keys(examples).sort(), [...EVENT_TYPES].sort(), "new event types need a sentence fixture");
  const { store } = await frozenRun(makeContract({ tasks: [taskSpec("api", [], { title: "Build navigation" }), taskSpec("b", [], { title: "" })] }));
  const state = await store.state();
  const c = { state, header: store.header(), base: "/cap/", runner: { status: "unknown", detail: "No record" } };
  for (const type of EVENT_TYPES) await t.test(type, () => {
    const [payload, expected] = examples[type];
    const ev = { type, payload, seq: 25, ts: "2026-01-01T12:30:00.000Z", source: { kind: "runner", id: "actor-fixture" } };
    assert.equal(describeEvent(ev, state), expected);
    const summary = eventSummary(ev, 1200, state);
    assert.doesNotMatch(summary, /Event 25|undefined|\[object Object\]|^\{/);
    const html = renderEvents(c, {}, [ev], false);
    assert.match(html, /actor-fixture/);
    assert.match(html, /<time datetime="2026-01-01T12:30:00.000Z"/);
    assert.match(html, /id="event-25"/);
    assert.match(html, /class="event-seq"[^>]*>#25<\/a>/);
    assert.deepEqual(inlineProblems(html), []);
  });
});

test("future event types keep a readable fallback and redact before truncation", () => {
  const ev = { type: "worker.new_signal", seq: 25, payload: { task: "api", reason: "Needs review", percent: 40, output_blob: "not-for-summary", token: "never-show" } };
  assert.equal(describeEvent(ev), "worker new signal: task: api; reason: Needs review; percent: 40");
  assert.doesNotMatch(eventSummary(ev), /Event 25|not-for-summary|never-show/);
  const note = { type: "note.posted", payload: { topic: "test", text: "private.person@example.com" } };
  assert.doesNotMatch(eventSummary(note, 25), /private\.person|example\.com/);
});
