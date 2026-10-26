import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { initialState } from "../../dist/execution/blackboard.js";
import { newExecutionId } from "../../dist/ids.js";
import { registerSecretLiteral } from "../../dist/security/secrets.js";
import { buildCheckIn, checkInKind } from "../../dist/serve/messages.js";
import { Notifier, planCheckIns, enqueue, readyPush, readNotifyState } from "../../dist/serve/notifier.js";
import { emit, frozenRun } from "../fixtures/execution/run.mjs";

const temps = [];
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }); });
function temporary(prefix) { const path = mkdtempSync(join(tmpdir(), prefix)); temps.push(path); return path; }

const event = (type, seq, payload) => ({ type, seq, payload, ts: "2026-01-01T00:00:00Z" });
const state = () => initialState(newExecutionId());

test("serve notifier shares current-state watch classification", () => {
  const s = state();
  const fixtures = [
    ["escalation.awaiting_human", { id: "e1", class: "money", message: "approve" }, "awaiting_human"],
    ["budget.threshold_crossed", { pct: 80, spent_usd: 8, budget_usd: 10 }, "budget"],
    ["budget.threshold_crossed", { pct: 50, spent_usd: 5, budget_usd: 10 }, null],
    ["execution.completed", { integration_sha: "a" }, "completed"],
    ["execution.failed", { reason: "x" }, "failed"],
    ["execution.aborted", { reason: "x" }, "aborted"],
    ["note.posted", { text: "x" }, null],
    ["escalation.routed", { id: "e1", to: "main", wake: true }, null],
  ];
  for (const [type, payload, expected] of fixtures) assert.equal(checkInKind(s, event(type, 1, payload)), expected, type);
  s.escalations.e1 = { id: "e1", status: "resolved" };
  assert.equal(checkInKind(s, event("escalation.awaiting_human", 2, { id: "e1" })), null);
  s.budget.thresholds_budget_usd = 20;
  assert.equal(checkInKind(s, event("budget.threshold_crossed", 2, { pct: 90, spent_usd: 9, budget_usd: 10 })), null);
  s.postmortem = { findings: {}, meetings: {}, ready_seq: 5 };
  assert.equal(checkInKind(s, event("note.posted", 5, {})), "postmortem_ready");
});

test("serve notifier first sight skips backlog but reports each current human escalation once", async () => {
  const { store } = await frozenRun();
  await emit(store, "escalation.raised", { escalation: { id: "e1", agent: "a", kind: "emergency", with: "orchestrator", summary: "Approve spend", blocking: true, status: "open", raised_seq: 0 } });
  await emit(store, "escalation.awaiting_human", { id: "e1", class: "money", message: "approve" });
  const s = await store.state(), events = await store.events();
  const plan = planCheckIns(s, events);
  assert.equal(plan.cursor.cursor, s.seq);
  assert.equal(plan.messages.length, 1);
  assert.match(plan.messages[0].body, /Approve spend/);
  assert.deepEqual(planCheckIns(s, events, plan.cursor).messages, []);
  assert.equal(planCheckIns(s, events, undefined, []).messages.length, 0);
});

test("serve notifier persists cursor and queue across restarts, dedupes ids and coalesces", async () => {
  const path = join(temporary("serve-notify-"), "notify-state.json");
  const sent = [];
  const sender = { name: "test", send: async m => { sent.push(m); return { ok: true }; } };
  const s = state();
  let notifier = new Notifier(path, [sender]);
  notifier.observe(s, [event("execution.completed", 1, { integration_sha: "a" })]);
  assert.equal(sent.length, 0, "no historical completion");
  const events = [event("execution.failed", 1, { reason: "x" })];
  s.seq = 1;
  notifier.observe(s, events);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  notifier = new Notifier(path, [sender]);
  notifier.observe(s, events);
  await notifier.flush(0);
  assert.equal(sent.length, 1);
  for (const seq of [2, 3]) {
    s.seq = seq;
    notifier.observe(s, [event("execution.failed", seq, { reason: "x" })]);
  }
  await notifier.flush(9999);
  assert.equal(sent.length, 1);
  notifier = new Notifier(path, [sender]);
  await notifier.flush(10_000);
  assert.equal(sent[1].title, "2 more updates");
  assert.equal(readNotifyState(path).executions[s.execution].cursor, 3);
  assert.equal(JSON.parse(readFileSync(path)).channels.test.count, 0);
  // A later awaiting event for an already reported id cannot repeat after restart.
  s.escalations.e1 = { id: "e1", status: "awaiting_human", summary: "a" };
  notifier.observe(s, [event("escalation.awaiting_human", 4, { id: "e1" })]);
  notifier = new Notifier(path, [sender]);
  notifier.observe(s, [event("escalation.awaiting_human", 5, { id: "e1" })]);
  assert.equal(notifier.state.channels.test.count, 1);
});

test("serve rate limit retries only retryable failures and never loses arrivals during a send", async () => {
  const path = join(temporary("serve-queue-"), "state.json");
  let calls = 0;
  let release;
  const sender = { name: "test", send: async () => {
    calls++;
    if (calls === 1) return { ok: false, retryable: true, error: "network", retryAfterMs: 20_000 };
    if (calls === 2) await new Promise(r => { release = r; });
    return { ok: true };
  } };
  const notifier = new Notifier(path, [sender], () => {}), m = buildCheckIn(state(), "completed", 1);
  notifier.queue(m);
  await notifier.flush(0);
  await notifier.flush(10_000);
  assert.equal(calls, 1);
  const pending = notifier.flush(20_000);
  await new Promise(r => setImmediate(r));
  notifier.queue(m);
  release();
  await pending;
  assert.equal(notifier.state.channels.test.count, 1);
  await notifier.flush(30_000);
  assert.equal(calls, 3);
  let q = enqueue(undefined, m);
  q = enqueue(q, m);
  assert.equal(readyPush(q, 0).title, "2 more updates");
});

test("serve message is scrubbed, capped and excludes access URLs, tokens, paths and prompt/persona text", () => {
  const s = state();
  s.goal = { original_prompt: "my original prompt", ultimate: "ship", artifacts: [] };
  s.tasks.a = { spec: { persona: "my-persona" }, state: "ready" };
  const token = "abcdefghijklmnopqrstuvwx", secret = "unique-sensitive-value";
  registerSecretLiteral(secret);
  const text = `${secret} my original prompt my-persona http://100.64.1.2:1234/${token}/ ${token} ${homedir()}/notes /Users/person/private /home/person/file ${"long ".repeat(150)}`;
  const m = buildCheckIn(s, "awaiting_human", 1, text);
  assert.ok(m.body.length <= 300);
  for (const forbidden of [secret, token, "http://", "/Users/", "/home/", homedir(), "my original prompt", "my-persona"]) assert.ok(!m.body.includes(forbidden), forbidden);
  assert.match(m.body, /Answer it from your chat, or run: roundtable status [a-z0-9]{6}$/);
  assert.ok(!m.body.includes("\n"));
});

test("serve notifier refuses malformed persisted state rather than replaying backlog", () => {
  const path = join(temporary("serve-bad-state-"), "state.json");
  writeFileSync(path, "{}");
  assert.throws(() => readNotifyState(path), /refusing to reset/);
});
