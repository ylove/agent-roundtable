import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN, T0, applyDrafts, contract, escalations, eventTypes, makeState, ofType } from "../fixtures/execution-state.mjs";

const { classifyFailure, backoffMs, circuitStatus, circuitRules, outcomesFromEvents, CIRCUIT_DEFAULTS } = await import("../../dist/execution/circuit.js");
const { actionsToDrafts } = await import("../../dist/execution/watchdog-actions.js");

const settle = (state, actions) => applyDrafts(state, actionsToDrafts(actions));
const fail = (minutesAgo, kind = "error", message = "boom", driver = "claude-code") => ({ driver, at: T0 - minutesAgo * MIN, kind, message });
const ok = (minutesAgo, driver = "claude-code") => ({ driver, at: T0 - minutesAgo * MIN, kind: "success" });
const opened = (actions) => ofType(actions, "watchdog.circuit_opened").map((e) => e.payload);

test("classifyFailure recognizes provider-shaped credit, auth and rate-limit failures", () => {
  const D = "driver";
  const P = "provider";
  const cases = [
    // The claude CLI (driver layer)
    ["Credit balance is too low", D, "credit"],
    ["Invalid API key · Please run /login", D, "auth"],
    ["Not logged in · Please run /login", D, "auth"],
    ["OAuth token has expired. Please run /login", D, "auth"],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', D, "rate_limit"],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', D, "rate_limit"],
    ["Claude AI usage limit reached|1760000000", D, "rate_limit"],
    ["API Error: 401 authentication_error", D, "auth"],
    ["error_during_execution", D, "error"],
    // Provider API error bodies and SDK error lines
    ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', P, "auth"],
    ['{"type":"error","error":{"type":"permission_error","message":"..."}}', P, "auth"],
    ["Error code: 429 - {'error': {'message': 'You exceeded your current quota', 'code': 'insufficient_quota'}}", P, "credit"],
    ["Error code: 401 - {'error': {'code': 'invalid_api_key'}}", P, "auth"],
    ["Error code: 402", P, "credit"],
    ["Error code: 429 - {'error': {'code': 'rate_limit_exceeded'}}", P, "rate_limit"],
    ['{"type":"error","error":{"type":"overloaded_error"}}', P, "rate_limit"],
    // CLI phrasing is not accepted from the provider layer
    ["Not logged in · Please run /login", P, "error"],
    ["Claude AI usage limit reached|1760000000", P, "error"],
    // Ordinary command and test output never counts, from either layer
    ["expected status 401", D, "error"],
    ["GET /admin 403 Forbidden", D, "error"],
    ["returns 429 Too Many Requests", D, "error"],
    ["credit balance is shown on the invoice page", D, "error"],
    ["AssertionError: expected 'Not logged in' to be hidden", D, "error"],
    ["TypeError at src/billing/invoice.ts:402", P, "error"],
    ["HTTP 401 Unauthorized", P, "error"],
    ["rate limit exceeded in RateLimiter.test.ts", D, "error"],
    ["", D, "error"],
  ];
  for (const [msg, source, want] of cases) assert.equal(classifyFailure(msg, { source }), want, `${source}: ${msg}`);
});

test("backoff doubles from 1 minute and caps at 30", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs(n) / MIN), [1, 2, 4, 8, 16, 30, 30]);
  assert.equal(CIRCUIT_DEFAULTS.failures, 5);
});

test("circuitStatus reads closed, open and half-open from the blackboard", () => {
  const s = makeState();
  assert.equal(circuitStatus(s, "codex", T0), "closed");
  s.watchdog.circuits.codex = { open: true, until: new Date(T0 + MIN).toISOString() };
  assert.equal(circuitStatus(s, "codex", T0), "open");
  assert.equal(circuitStatus(s, "codex", T0 + MIN), "half_open");
  s.watchdog.circuits.codex = { open: false };
  assert.equal(circuitStatus(s, "codex", T0), "closed");
});

test("a closed circuit opens after 5 failures in 10 minutes, or on any rate limit", () => {
  const cases = [
    { name: "5 errors in the window", outcomes: [9, 7, 5, 3, 1].map((m) => fail(m)), open: true },
    { name: "4 errors", outcomes: [7, 5, 3, 1].map((m) => fail(m)), open: false },
    { name: "5 errors, one outside the window", outcomes: [11, 7, 5, 3, 1].map((m) => fail(m)), open: false },
    { name: "a success in between resets the count", outcomes: [9, 7, 6, 5, 3, 1].map((m) => (m === 6 ? ok(m) : fail(m))), open: false },
    { name: "one rate limit", outcomes: [fail(2, "rate_limit", "429 Too Many Requests")], open: true },
    { name: "a rate limit before the last success", outcomes: [fail(5, "rate_limit"), ok(2)], open: false },
    { name: "another driver's failures", outcomes: [9, 7, 5, 3, 1].map((m) => fail(m, "error", "x", "codex")), open: false, driver: "claude-code" },
    { name: "future outcomes are ignored", outcomes: [fail(-1, "rate_limit")], open: false },
  ];
  for (const c of cases) {
    const s = makeState();
    const actions = circuitRules(s, T0, { outcomes: c.outcomes });
    const forDriver = opened(actions).filter((p) => p.driver === (c.driver ?? p.driver));
    assert.equal(forDriver.length > 0 && (c.driver === undefined || forDriver[0].driver === c.driver), c.open, c.name);
    if (c.open) {
      assert.equal(forDriver[0].until, new Date(T0 + MIN).toISOString(), `${c.name}: 1 minute`);
      assert.deepEqual(circuitRules(settle(s, actions), T0 + 1000, { outcomes: c.outcomes }), [], `${c.name}: idempotent`);
    }
  }
  const [p] = opened(circuitRules(makeState(), T0, { outcomes: [9, 7, 5, 3, 1].map((m) => fail(m, "error", "segfault")) }));
  assert.match(p.reason, /5 failures in 10 min; last error: segfault/);
});

test("half-open: the first outcome after `until` closes the circuit or reopens it with a doubled backoff", () => {
  const openState = (untilMinutesAgo) => {
    const s = makeState();
    s.watchdog.circuits["claude-code"] = { open: true, until: new Date(T0 - untilMinutesAgo * MIN).toISOString(), reason: "429" };
    return s;
  };
  const tripped = fail(5, "rate_limit");

  assert.deepEqual(circuitRules(openState(-1), T0, { outcomes: [tripped] }), [], "still open");
  assert.deepEqual(circuitRules(openState(2), T0, { outcomes: [tripped] }), [], "half-open, no trial yet");

  const closing = circuitRules(openState(2), T0, { outcomes: [tripped, ok(1)] });
  assert.deepEqual(eventTypes(closing), ["watchdog.circuit_closed"]);
  const closed = settle(openState(2), closing);
  assert.equal(circuitStatus(closed, "claude-code", T0), "closed");
  assert.deepEqual(circuitRules(closed, T0 + 1000, { outcomes: [tripped, ok(1)] }), [], "old failures do not reopen it");

  const reopening = circuitRules(openState(2), T0, { outcomes: [tripped, fail(1, "error", "still down")], history: { "claude-code": { opens: 1 } } });
  const [p] = opened(reopening);
  assert.equal(p.until, new Date(T0 + 2 * MIN).toISOString());
  assert.match(p.reason, /half-open trial failed: error: still down/);
  assert.equal(opened(circuitRules(openState(2), T0, { outcomes: [tripped, fail(1)], history: { "claude-code": { opens: 5 } } }))[0].until, new Date(T0 + 30 * MIN).toISOString());
  assert.deepEqual(circuitRules(settle(openState(2), reopening), T0 + 1000, { outcomes: [tripped, fail(1)] }), []);
});

test("auth and credit failures are emergencies that list alternatives", () => {
  const cases = [
    ["Invalid API key · Please run /login", "credentials", /Sign claude-code in again/],
    ["Credit balance is too low", "money", /Add credit/],
  ];
  for (const [message, cls, hint] of cases) {
    const s = makeState();
    const outcomes = [fail(1, classifyFailure(message, { source: "driver" }), message)];
    const actions = circuitRules(s, T0, { outcomes });
    const [esc] = escalations(actions);
    assert.equal(esc.kind, "emergency");
    assert.equal(esc.emergency, cls);
    assert.equal(esc.target, "main");
    const [waiting] = ofType(actions, "escalation.awaiting_human");
    assert.equal(waiting.payload.class, cls);
    assert.match(waiting.payload.message, /Workers on claude-code cannot run/);
    assert.deepEqual(waiting.payload.alternatives.slice(0, 2), ["Switch workers to the codex driver", "Use the fallback model claude-sonnet-5-5"]);
    assert.match(waiting.payload.alternatives[2], hint);
    assert.equal(opened(actions).length, 1, "the circuit opens too");
    assert.equal(actions.find((a) => a.rule === "circuit_emergency").diagnostics.error_output, message);

    // Once raised, a repeat of the same incident (no success since) is the same emergency.
    const after = settle(s, actions);
    after.watchdog.circuits["claude-code"].until = new Date(T0 - 1000).toISOString();
    const again = circuitRules(after, T0 + 5000, { outcomes: [...outcomes, { ...outcomes[0], at: T0 + 2000 }] });
    assert.deepEqual(escalations(again), []);
    assert.equal(opened(again).length, 1, "the half-open trial failed: reopened");
  }
});

test("an open circuit on another driver is not offered as an alternative; no fallback model, none listed", () => {
  const s = makeState({ contract: contract({ workers: { driver: "claude-code" } }) });
  s.watchdog.circuits.codex = { open: true, until: new Date(T0 + 10 * MIN).toISOString() };
  const [waiting] = ofType(circuitRules(s, T0, { outcomes: [fail(1, "auth", "Not logged in")] }), "escalation.awaiting_human");
  assert.deepEqual(waiting.payload.alternatives, ["Sign claude-code in again (or fix its API key), then resume the run"]);
});

test("outcomesFromEvents reads exits and circuit history from the log", () => {
  const ev = (minutesAgo, type, payload) => ({ ts: new Date(T0 - minutesAgo * MIN).toISOString(), type, payload, source: { kind: "runner", id: "runner", pid: 1 } });
  const { outcomes, history } = outcomesFromEvents([
    ev(30, "agent.registered", { agent: "w1", persona: "p", driver: "codex", token_sha256: "x", external: false }),
    ev(20, "agent.exited", { agent: "w1", code: 1, reason: "error", result_subtype: "error_during_execution" }),
    ev(19, "agent.exited", { agent: "w1", code: 0, reason: "completed" }),
    ev(18, "agent.exited", { agent: "w2", code: 0, reason: "killed" }),
    ev(17, "agent.exited", { agent: "ghost", code: 1, reason: "error" }),
    ev(15, "watchdog.circuit_opened", { driver: "codex", reason: "x", until: "" }),
    ev(10, "watchdog.circuit_opened", { driver: "codex", reason: "x", until: "" }),
    ev(9, "watchdog.circuit_opened", { driver: "anthropic", reason: "x", until: "" }),
    ev(5, "watchdog.circuit_closed", { driver: "anthropic" }),
  ]);
  assert.deepEqual(outcomes, [
    { driver: "codex", at: T0 - 20 * MIN, kind: "error", message: "error_during_execution" },
    { driver: "codex", at: T0 - 19 * MIN, kind: "success" },
  ]);
  assert.deepEqual(history, { codex: { opens: 2, openedAt: T0 - 10 * MIN }, anthropic: { opens: 0, closedAt: T0 - 5 * MIN } });
});

test("the open count lives on the blackboard: backoff keeps doubling without the log's history", () => {
  const s = makeState();
  let state = settle(s, circuitRules(s, T0, { outcomes: [fail(0.5, "rate_limit")] }));
  assert.equal(state.watchdog.circuits["claude-code"].opens, 1);
  const untils = [];
  let now = T0;
  for (let i = 0; i < 6; i++) {
    now = Date.parse(state.watchdog.circuits["claude-code"].until) + 1000;
    const trial = { driver: "claude-code", at: now - 500, kind: "error", message: "still down" };
    const actions = circuitRules(state, now, { outcomes: [trial] }); // no history passed
    state = settle(state, actions);
    untils.push((Date.parse(state.watchdog.circuits["claude-code"].until) - now) / MIN);
  }
  assert.deepEqual(untils, [2, 4, 8, 16, 30, 30]);
  assert.equal(state.watchdog.circuits["claude-code"].opens, 7);
});

test("a closed circuit does not reopen on the incident it already handled, even without history", () => {
  const s = makeState();
  s.watchdog.circuits["claude-code"] = { open: true, until: new Date(T0 - 2 * MIN).toISOString(), reason: "429", opens: 1 };
  const outage = [fail(5, "rate_limit"), fail(4, "rate_limit"), fail(3, "error")];
  const closing = circuitRules(s, T0, { outcomes: [...outage, ok(1)] });
  assert.deepEqual(eventTypes(closing), ["watchdog.circuit_closed"]);
  const closed = settle(s, closing);
  assert.deepEqual(closed.watchdog.circuits["claude-code"], { open: false, until: new Date(T0 - 2 * MIN).toISOString() });
  // Later, without the success (a synthetic trial success is not in the log) and without history:
  assert.deepEqual(circuitRules(closed, T0 + MIN, { outcomes: outage }), []);
  // A new failure after the close opens it again, starting the backoff over.
  const fresh = circuitRules(closed, T0 + MIN, { outcomes: [...outage, { driver: "claude-code", at: T0 + 30_000, kind: "rate_limit" }] });
  assert.deepEqual(opened(fresh).map((p) => [p.opens, (Date.parse(p.until) - (T0 + MIN)) / MIN]), [[1, 1]]);
});
