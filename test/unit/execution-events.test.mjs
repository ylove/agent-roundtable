import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { canonicalJSON, hashEvent, chainHash, sha256Hex } = await import("../../dist/execution/chain.js");
const { validateDraft, isEventType, PAYLOAD_SPECS, PAYLOAD_LIMIT_BYTES } = await import("../../dist/execution/events.js");
const { createExecutionStore } = await import("../../dist/execution/store.js");
const { EVENT_TYPES, GENESIS_HASH } = await import("../../dist/execution/types.js");

const src = { kind: "agent", id: "w1", pid: 42 };
const note = (payload, extra = {}) => ({ type: "note.posted", source: src, payload: { topic: "t", text: "hello", refs: [], ...payload }, ...extra });
const newStore = () => createExecutionStore({ repoRoot: "/srv/repo", baseSha: "abc", agentsDir: "/srv/agents" });
const FAKE_KEY = "sk-ant-test-0123456789abcdefghij";

// ---------------------------------------------------------------------------
// canonicalJSON and hashing
// ---------------------------------------------------------------------------

test("canonicalJSON sorts keys recursively and has no whitespace", () => {
  assert.equal(canonicalJSON({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }));
  assert.equal(canonicalJSON("é\n "), JSON.stringify("é\n "));
  assert.equal(canonicalJSON({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJSON(-0), "0");
});

test("canonicalJSON rejects values that do not round-trip through JSON", () => {
  for (const bad of [NaN, Infinity, -Infinity, { x: NaN }, [1, undefined], new Date(0), new Map(), 1n, () => 1, Symbol("s")]) {
    assert.throws(() => canonicalJSON(bad), TypeError, String(bad?.toString?.() ?? bad));
  }
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJSON(cyclic), /cyclic/);
  const shared = { x: 1 };
  assert.equal(canonicalJSON({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}', "shared references are not cycles");
});

test("hashEvent is sha256(prev + canonical envelope without hash)", () => {
  const env = { v: 1, seq: 1, prev: GENESIS_HASH, type: "task.ready", payload: { task: "a" } };
  const expected = createHash("sha256").update(GENESIS_HASH + canonicalJSON(env)).digest("hex");
  assert.equal(hashEvent(GENESIS_HASH, env), expected);
  assert.equal(hashEvent(GENESIS_HASH, { ...env, hash: "ignored" }), expected);
  assert.equal(chainHash(GENESIS_HASH, env), expected);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("every catalog type has a payload spec, and nothing else does", () => {
  assert.deepEqual(Object.keys(PAYLOAD_SPECS).sort(), [...EVENT_TYPES].sort());
  for (const t of EVENT_TYPES) assert.equal(isEventType(t), true);
  for (const t of ["task.exploded", "constructor", "__proto__", "toString", 7, null]) assert.equal(isEventType(t), false);
});

test("unknown types are rejected", () => {
  assert.throws(() => validateDraft({ type: "task.exploded", source: src, payload: {} }), /Unknown event type "task\.exploded"/);
  assert.throws(() => validateDraft({ type: "constructor", source: src, payload: {} }), /Unknown event type/);
});

test("bad payloads are rejected with the field path", () => {
  const cases = [
    [{ type: "task.claimed", source: src, payload: { task: "a", agent: "w1", attempt: 1.5, ttl_s: 0 } }, /payload\.attempt must be an integer/],
    [{ type: "task.claimed", source: src, payload: { task: "a", agent: "w1", ttl_s: 0 } }, /payload\.attempt is required/],
    [{ type: "task.ready", source: src, payload: { task: "" } }, /payload\.task must be a non-empty string/],
    [{ type: "task.ready", source: src, payload: { task: "a", extra: 1 } }, /payload\.extra is not a known field/],
    [{ type: "task.ready", source: src, payload: "a" }, /payload must be an object/],
    [{ type: "check.failed", source: src, payload: { command_id: "t", scope: "repo", exit: 1, signature: "s" } }, /payload\.scope must be "task" or "integration"/],
    [{ type: "lease.granted", source: src, payload: { lease: { id: "L", agent: "w", task: "a", paths: ["x"], mode: "rw", branch: "b", reason: "r", granted_seq: 0 } } }, /payload\.lease\.mode/],
    [{ type: "task.split", source: src, payload: { task: "a", into: [{ id: "a1" }] } }, /payload\.into\[0\]\.title is required/],
    [{ type: "execution.paused", source: src, payload: { scope: "some", reason: "r" } }, /payload\.scope must be "all" or an array/],
    [{ type: "budget.usage_recorded", source: src, payload: { source: "worker", model: "m", tokens: { inputTokens: 1, outputTokens: 1 }, usd: Infinity, estimated: false } }, /payload\.usd must be a finite number/],
    [{ type: "task.ready", payload: { task: "a" } }, /draft\.source is required/],
    [{ type: "task.ready", source: "w1", payload: { task: "a" } }, /draft\.source must be an object/],
    [{ type: "task.ready", source: { kind: "robot", id: "x", pid: 1 }, payload: { task: "a" } }, /draft\.source\.kind/],
    [{ type: "task.ready", source: src, payload: { task: "a" }, mode: "fast" }, /draft\.mode/],
    [{ type: "task.ready", source: src, payload: { task: "a" }, seq: 9 }, /draft\.seq is not a known field/],
  ];
  for (const [draft, re] of cases) assert.throws(() => validateDraft(draft), re, JSON.stringify(draft));
});

test("valid drafts come back as sanitized copies", () => {
  const draft = { type: "execution.paused", source: src, payload: { scope: ["a", "b"], reason: "lunch" }, correlation: "c1", causation: undefined };
  const out = validateDraft(draft);
  assert.deepEqual(out, { type: "execution.paused", source: src, correlation: "c1", payload: { scope: ["a", "b"], reason: "lunch" } });
  assert.notEqual(out.payload.scope, draft.payload.scope);
  assert.deepEqual(validateDraft({ type: "execution.paused", source: src, payload: { scope: "all", reason: "r" } }).payload.scope, "all");
  assert.equal(validateDraft({ type: "check.failed", source: src, payload: { command_id: "t", scope: "task", exit: null, signature: "s" } }).payload.exit, null);
  assert.equal(validateDraft(note({ text: "" })).payload.text, "", "free text may be empty");
});

test("text fields are scrubbed of secrets; identifiers are left alone", () => {
  const out = validateDraft({
    type: "escalation.raised",
    source: src,
    payload: {
      escalation: {
        id: "E1", agent: "w1", kind: "blocker", with: "orchestrator", summary: `the key is ${FAKE_KEY}`,
        options: [`use ${FAKE_KEY}`, "wait"], blocking: true, status: "open", raised_seq: 0,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-test/);
  assert.match(out.payload.escalation.summary, /\[redacted:api_key\]/);
  assert.equal(out.payload.escalation.options[1], "wait");
  assert.equal(out.payload.escalation.id, "E1");
});

test("secrets are scrubbed before hashing, so the log never holds them and still verifies", async () => {
  const store = await newStore();
  const { events } = await store.transact(() => ({ events: [note({ text: `token is ${FAKE_KEY}` })] }));
  assert.match(events[0].payload.text, /^token is \[redacted:api_key\]$/);
  assert.equal(events[0].hash, hashEvent(events[0].prev, events[0]));
  const raw = readFileSync(join(store.dir, "events.jsonl"), "utf8");
  assert.doesNotMatch(raw, /sk-ant-test/);
  assert.deepEqual(await store.verify(), { ok: true, seq: 1 });
});

test("payloads over 8 KB are refused with a pointer to blobs", async () => {
  assert.equal(PAYLOAD_LIMIT_BYTES, 8192);
  assert.doesNotThrow(() => validateDraft(note({ text: "x".repeat(8000) })));
  assert.throws(() => validateDraft(note({ text: "x".repeat(8200) })), /payload is \d+ bytes; the limit is 8192\. Store large content with putBlob\(\)/);
  const store = await newStore();
  await assert.rejects(store.transact(() => ({ events: [note({ text: "ü".repeat(4100) })] })), /limit is 8192/);
  assert.equal((await store.state()).seq, 0, "nothing was written");
  assert.throws(() => validateDraft(note({}, { correlation: "c".repeat(3000) })), /outside the payload/);
});

test("a batch with one bad draft writes nothing", async () => {
  const store = await newStore();
  await assert.rejects(store.transact(() => ({ events: [note({}), { type: "task.ready", source: src, payload: {} }] })), /payload\.task is required/);
  assert.equal(readFileSync(join(store.dir, "events.jsonl"), "utf8"), "");
});
