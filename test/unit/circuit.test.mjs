import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN, T0, applyDrafts, contract, escalations, eventTypes, makeState, ofType } from "../fixtures/execution-state.mjs";

const { classifyFailure, backoffMs, circuitStatus, circuitRules, outcomesFromEvents, CIRCUIT_DEFAULTS } = await import("../../dist/execution/circuit.js");
const { actionsToDrafts } = await import("../../dist/execution/watchdog-actions.js");

const settle = (state, actions) => applyDrafts(state, actionsToDrafts(actions));
const fail = (minutesAgo, kind = "error", message = "boom", driver = "claude-code") => ({ driver, at: T0 - minutesAgo * MIN, kind, message });
const ok = (minutesAgo, driver = "claude-code") => ({ driver, at: T0 - minutesAgo * MIN, kind: "success" });
const opened = (actions) => ofType(actions, "watchdog.circuit_opened").map((e) => e.payload);

test("classifyFailure recognizes credit, auth and rate-limit messages", () => {
  const cases = [
    ["Your credit balance is too low to access the Anthropic API", "credit"],
    ["Error code: 429 - insufficient_quota", "credit"],
    ["You exceeded your current quota, please check your plan and billing details", "credit"],
    ["Invalid API key · Please run /login", "auth"],
    ["Not logged in", "auth"],
    ["HTTP 401 Unauthorized", "auth"],
    ["403 Forbidden", "auth"],
    ["authentication_error: invalid x-api-key", "auth"],
    ["OAuth token has expired", "auth"],
    ["429 Too Many Requests", "rate_limit"],
    ["rate_limit_error: Number of request tokens has exceeded your per-minute rate limit", "rate_limit"],
    ["overloaded_error", "rate_limit"],
    ["Claude AI usage limit reached|1760000000", "rate_limit"],
    ["error_during_execution", "error"],
    ["exit code 1 after 4013 ms", "error"],
    ["", "error"],
    // Words and numbers in ordinary error output are not provider failures.
    ["TypeError at src/billing/invoice.ts:402", "error"],
    ["AssertionError: expected 401 to equal 200", "error"],
    ["src/login.ts: Forbidden import of fs", "error"],
    ["line 429: unexpected token", "error"],
    ["RateLimiter test failed", "error"],
    ["HTTP/1.1 403", "auth"],
    ["status: 529", "rate_limit"],
    ["Error code: 402 Payment Required", "credit"],
  ];
  for (const [msg, want] of cases) assert.equal(classifyFailure(msg), want, msg);
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
    ["Your credit balance is too low", "money", /Add credit/],
  ];
  for (const [message, cls, hint] of cases) {
    const s = makeState();
    const outcomes = [fail(1, classifyFailure(message), message)];
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
