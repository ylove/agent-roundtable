import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "roundtable-workshop-"));
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
process.env.ROUNDTABLE_AGENTS_DIR = join(root, "agents");
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));

const { mapLimit, extractJsonObject, notFoundError, truncate, parseVerdict } = await import("../../dist/sessions/workshop.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapLimit preserves order and bounds concurrency even with out-of-order completions", async () => {
  let active = 0;
  let peak = 0;
  const finished = [];
  const values = await mapLimit([30, 5, 1, 2], 2, async (ms, index) => {
    peak = Math.max(peak, ++active);
    await delay(ms);
    active--;
    finished.push(index);
    return `result ${index}`;
  });
  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.notDeepEqual(finished, [0, 1, 2, 3]);
  assert.deepEqual(values, ["result 0", "result 1", "result 2", "result 3"]);
});

test("mapLimit settles all items before throwing the earliest indexed rejection", async () => {
  const first = new Error("first by index");
  const second = new Error("first in time");
  const finished = [];
  await assert.rejects(mapLimit([0, 1, 2, 3], 2, async (_, index) => {
    await delay(index === 0 ? 25 : 1);
    finished.push(index);
    if (index === 0) throw first;
    if (index === 1) throw second;
    return index;
  }), (error) => error === first);
  assert.deepEqual(finished.sort(), [0, 1, 2, 3]);
});

test("mapLimit handles empty input, invalid limits, synchronous throws, and undefined rejections", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => assert.fail("empty input")), []);
  for (const limit of [0, -1, NaN, 1.9]) {
    let active = 0;
    await mapLimit([1, 2], limit, async (value) => {
      assert.equal(++active, 1);
      await delay(1);
      active--;
      return value;
    });
  }
  const finished = [];
  let rejected = false;
  try {
    await mapLimit([0, 1], 1, (value) => {
      finished.push(value);
      if (value === 0) throw undefined;
      return Promise.resolve(value);
    });
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.ok(rejected);
  assert.deepEqual(finished, [0, 1]);
});

test("extractJsonObject accepts fenced, inline, nested, and prose-wrapped objects", () => {
  for (const text of [
    '```json\n{"ok": true}\n```',
    '```{"ok": true}```',
    'Here is the answer:\n{"ok": true}\nDone.',
  ]) assert.deepEqual(extractJsonObject(text), { ok: true });
  assert.deepEqual(extractJsonObject('Before {"nested":{"value":1}} after'), { nested: { value: 1 } });
  assert.deepEqual(extractJsonObject('```json\n{"code":"```json"}\n```'), { code: "```json" });
  assert.throws(() => extractJsonObject("no object"), /No JSON object/);
  assert.throws(() => extractJsonObject('{"unfinished":'), /Invalid JSON object/);
  assert.throws(() => extractJsonObject("{not JSON}"), /Invalid JSON object/);
  assert.deepEqual(extractJsonObject('{"a":1} {"b":2}'), { a: 1 });
});

test("notFoundError lists active ids or none, and truncate marks a cut", () => {
  assert.equal(notFoundError("Workshop", "w0", ["w1", "w2"]).message, "Workshop not found: w0. Active workshops: w1, w2");
  assert.equal(notFoundError("agent-creation", "a0", []).message, "agent-creation not found: a0. Active agent-creations: none");
  assert.equal(truncate("hello", 5), "hello");
  assert.equal(truncate("hello", 3), "hel\n…[truncated]");
  assert.equal(truncate("hello", 0), "\n…[truncated]");
});

test("parseVerdict tolerates bold, case, and leading lines; longest option wins", () => {
  const options = ["APPROVE", "APPROVE WITH CHANGES", "OBJECT"];
  for (const line of [
    "Verdict: APPROVE WITH CHANGES",
    "**Verdict:** approve with changes",
    "**Verdict**: **APPROVE WITH CHANGES** — revise the plan",
    "\n\n\n\n  verdict: APPROVE WITH CHANGES.",
  ]) assert.equal(parseVerdict(line, "Verdict", options), "APPROVE WITH CHANGES");
  assert.equal(parseVerdict("**Sign-off:** OBJECT", "Sign-off", options), "OBJECT");
  assert.equal(parseVerdict("Verdict: APPROVE. Looks good", "Verdict", options), "APPROVE");
  assert.equal(parseVerdict("Verdict: APPROVED", "Verdict", options), "UNCLEAR");
  assert.equal(parseVerdict("Prose mentioning Verdict: OBJECT", "Verdict", options), "UNCLEAR");
  assert.equal(parseVerdict("\n\n\n\n\nVerdict: OBJECT", "Verdict", options), "OBJECT");
  assert.equal(parseVerdict("Sign-off: MAYBE", "Sign-off", options), "UNCLEAR");
  assert.equal(parseVerdict("Review (final): OBJECT", "Review (final)", options), "OBJECT");
});

test("JSON extraction ignores prose braces and tracks strings inside objects", () => {
  for (const text of [
    'Sure! I filled {name}:\n{"a":1}',
    '```json\n{"a":1}\n```\nLet me know if {x} needs changes.',
    'Here\'s a "draft: {"a":1}',
    'Unclosed { prose before {"a":1}',
  ]) assert.deepEqual(extractJsonObject(text), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"s":"} and \\" {", "a":1}\n```'), { s: '} and " {', a: 1 });
  assert.deepEqual(extractJsonObject('prose {x} {"nested":{"a":1}} {"b":2}'), { nested: { a: 1 } });
  for (const text of ['[1,2]', 'null']) assert.throws(() => extractJsonObject(text), /No JSON object/);
});

test("verdict normalization supports markdown, Unicode and five non-empty lines", () => {
  const signoffs = ["APPROVE", "APPROVE WITH RESERVATIONS", "OBJECT"];
  for (const text of ["__Sign-off:__ OBJECT", "Sign‑off: OBJECT", "## Sign-off: OBJECT", "- Sign-off: OBJECT",
    "Sign-off: `OBJECT`", "*Sign-off:* OBJECT", "> Sign-off: OBJECT", "+ Sign-off: OBJECT", "1) Sign-off: OBJECT",
    "Sign off: OBJECT", "SIGNOFF: OBJECT", "> ## - 1. __Sign-off:__ OBJECT",
    ...["‐", "‑", "‒", "–", "—", "−"].map(h => `Sign${h}off: OBJECT`)]) {
    assert.equal(parseVerdict(text, "Sign-off", signoffs), "OBJECT", text);
  }
  const reviews = ["APPROVE", "APPROVE WITH CHANGES", "OBJECT"];
  assert.equal(parseVerdict("1. Verdict: APPROVE WITH CHANGES", "Verdict", reviews), "APPROVE WITH CHANGES");
  assert.equal(parseVerdict("a\n\nb\nc\n\nd\nVerdict: APPROVE WITH CHANGES", "Verdict", reviews), "APPROVE WITH CHANGES");
  assert.equal(parseVerdict("a\nb\nc\nd\ne\nVerdict: OBJECT", "Verdict", reviews), "UNCLEAR");
});


test("JSON extraction scans braces only, so brackets around an object cannot hide it", () => {
  for (const text of ['[{"a":1}]', '```json\n[{"a":1}]\n```', 'Here is the spec [see below: {"a":1}]', 'Tags [cfo] then {"a":1} [end']) {
    assert.deepEqual(extractJsonObject(text), { a: 1 }, text);
  }
  assert.throws(() => extractJsonObject('[{"a":}]'), /Invalid JSON object/);
});
