import { test } from "node:test";
import assert from "node:assert/strict";
const { findProblem, assertValid, publicSchema } = await import("../../dist/validate.js");

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "visibility"],
  properties: {
    goal: { type: "string", minLength: 3, maxLength: 10, "x-hint": "say what the run must achieve" },
    count: { type: "integer", minimum: 1, maximum: 5 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    level: { type: "string", enum: ["low", "high"] },
    advisory: { type: "string", enum: ["a", "b"], "x-advisory-enum": true },
    id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 2 },
    visibility: {
      type: "object",
      additionalProperties: false,
      properties: {
        chat_only: { type: "boolean" },
        github: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string", pattern: "^[^/]+/[^/]+$" }, project_number: { type: "integer" } },
        },
      },
    },
    items: {
      type: "array",
      maxItems: 3,
      items: { type: "object", required: ["id"], properties: { id: { type: "string" }, n: { type: "number" } } },
    },
  },
};
const ok = { goal: "ship it", visibility: {} };

test("a valid object has no problem, in either phase", () => {
  assert.equal(findProblem(schema, ok), null);
  assert.equal(findProblem(schema, { ...ok, count: 3, ratio: 0.5, level: "low", tags: ["x"], items: [{ id: "a", n: 1 }] }), null);
  assert.equal(findProblem(schema, { ...ok, visibility: { github: { repo: "o/r", project_number: 2 } } }), null);
});

test("legacy type messages are unchanged and never carry a hint", () => {
  assert.equal(findProblem(schema, { ...ok, goal: 5 }), '"goal" must be a string');
  assert.equal(findProblem(schema, { ...ok, ratio: Infinity }), '"ratio" must be a finite number');
  assert.equal(findProblem(schema, { ...ok, ratio: "1" }), '"ratio" must be a finite number');
  assert.equal(findProblem(schema, { ...ok, visibility: { chat_only: "yes" } }), '"visibility.chat_only" must be a boolean');
  for (const bad of ["x", [""], [" "], ["x", 5], [null], new Array(1)]) {
    assert.equal(findProblem(schema, { ...ok, tags: bad }), '"tags" must be an array of non-empty strings', JSON.stringify(bad));
  }
});

test("new type messages: integer, object, array of objects", () => {
  assert.equal(findProblem(schema, { ...ok, count: 1.5 }), '"count" must be an integer');
  assert.equal(findProblem(schema, { ...ok, visibility: [] }), '"visibility" must be an object');
  assert.equal(findProblem(schema, { ...ok, items: {} }), '"items" must be an array');
  assert.equal(findProblem(schema, { ...ok, items: [null] }), '"items[0]" must be an object');
  assert.equal(findProblem(schema, { ...ok, items: [{ id: "a" }, { id: "b", n: "1" }] }), '"items[1].n" must be a finite number');
});

test("constraints name the path and append the field's hint", () => {
  assert.equal(findProblem(schema, { ...ok, goal: "go" }), '"goal" must be at least 3 characters: say what the run must achieve');
  assert.equal(findProblem(schema, { ...ok, goal: "much too long" }), '"goal" must be at most 10 characters: say what the run must achieve');
  assert.equal(findProblem(schema, { ...ok, count: 0 }), '"count" must be at least 1');
  assert.equal(findProblem(schema, { ...ok, count: 6 }), '"count" must be at most 5');
  assert.equal(findProblem(schema, { ...ok, level: "mid" }), '"level" must be one of: low, high');
  assert.equal(findProblem(schema, { ...ok, id: "Bad" }), '"id" must match the pattern ^[a-z][a-z0-9-]*$');
  assert.equal(findProblem(schema, { ...ok, tags: ["x", "y", "x"] }), '"tags" must have at most 2 items');
  assert.equal(findProblem(schema, { ...ok, tags: ["z"] }), '"tags[0]" must be one of: x, y');
  assert.equal(findProblem(schema, { ...ok, items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] }), '"items" must have at most 3 items');
  assert.equal(
    findProblem(schema, { ...ok, visibility: { github: { repo: "no-slash" } } }),
    '"visibility.github.repo" must match the pattern ^[^/]+/[^/]+$'
  );
});

test("an advisory enum is listed but not enforced (the engine owns that message)", () => {
  assert.equal(findProblem(schema, { ...ok, advisory: "zzz" }), null);
  assert.equal(findProblem(schema, { ...ok, advisory: 5 }), '"advisory" must be a string');
});

test("required: undefined, null and blank strings are missing; nested required runs with values", () => {
  assert.equal(findProblem(schema, { visibility: {} }), '"goal" is required: say what the run must achieve');
  assert.equal(findProblem(schema, { goal: null, visibility: {} }), '"goal" is required: say what the run must achieve');
  assert.equal(findProblem(schema, { goal: " \n", visibility: {} }), '"goal" is required: say what the run must achieve');
  assert.equal(findProblem(schema, { goal: "ship it" }), '"visibility" is required');
  assert.equal(findProblem(schema, { ...ok, visibility: { github: {} } }, ["values"]), '"visibility.github.repo" is required');
  assert.equal(findProblem(schema, { ...ok, items: [{ n: 1 }] }, ["values"]), '"items[0].id" is required');
});

test("phases: values alone skip top-level required; required alone skips values; order is honored", () => {
  assert.equal(findProblem(schema, {}, ["values"]), null);
  assert.equal(findProblem(schema, { goal: 5 }, ["required"]), '"visibility" is required');
  assert.equal(findProblem(schema, { goal: 5 }), '"goal" must be a string');
  assert.equal(findProblem(schema, undefined, ["values"]), null);
  assert.equal(findProblem(schema, undefined), '"goal" is required: say what the run must achieve');
});

test("additionalProperties: false rejects unknown keys at any depth and lists the known ones", () => {
  assert.equal(findProblem(schema, { ...ok, extra: 1 }), '"extra" is not allowed (expected: goal, count, ratio, level, advisory, id, tags, visibility, items)');
  assert.equal(findProblem(schema, { ...ok, visibility: { dashboard: true } }), '"visibility.dashboard" is not allowed (expected: chat_only, github)');
  // Without the keyword, unknown keys pass (the legacy tools never declare it).
  assert.equal(findProblem({ type: "object", properties: {} }, { anything: 1 }), null);
});

test("prototype keys are not arguments; non-object arguments are rejected", () => {
  const s = { type: "object", required: ["constructor"], properties: { constructor: { type: "string" } } };
  assert.equal(findProblem(s, {}), '"constructor" is required');
  assert.equal(findProblem(schema, ["goal"]), "arguments must be an object");
  assert.equal(findProblem(schema, "goal"), "arguments must be an object");
});

test("assertValid throws a plain Error prefixed with the label", () => {
  assert.throws(() => assertValid("execute", schema, { ...ok, count: 9 }), { name: "Error", message: 'execute: "count" must be at most 5' });
  assert.doesNotThrow(() => assertValid("execute", schema, ok));
});

test("publicSchema strips x- extensions, keeps field names and leaves the source untouched", () => {
  const s = {
    type: "object",
    "x-internal": true,
    properties: { "x-field": { type: "string", "x-hint": "h" }, list: { type: "array", items: { type: "string", "x-hint": "i" } } },
  };
  const out = publicSchema(s);
  assert.deepEqual(out, { type: "object", properties: { "x-field": { type: "string" }, list: { type: "array", items: { type: "string" } } } });
  assert.equal(s.properties["x-field"]["x-hint"], "h");
  assert.notEqual(out.properties, s.properties);
});
