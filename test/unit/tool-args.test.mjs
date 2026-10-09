import { test } from "node:test";
import assert from "node:assert/strict";
const { checkArgs, handleToolCall, formatAgentWorkshopResult, tools } = await import("../../dist/tools.js");

// Keep these lists independent of the schemas so omitted fields cannot pass silently.
const fields = {
  start_ultraplan: {
    string: ["task", "context", "draft_plan", "planner", "provider", "model", "base_url"],
    array: ["agents"], number: ["revision_rounds"], boolean: ["public"],
  },
  submit_plan: { string: ["ultraplan_id", "plan"], boolean: ["final"] },
  end_ultraplan: { string: ["ultraplan_id"] },
  create_agent: {
    string: ["task", "context", "from_session", "name", "provider", "model", "base_url"],
    array: ["agents"], number: ["rounds"], boolean: ["write", "perform_task", "public"],
  },
  improve_agent: {
    string: ["agent", "focus", "context", "from_session", "provider", "model", "base_url"],
    array: ["with"], number: ["rounds"], boolean: ["include_self", "write", "public"],
  },
};
const rules = {
  string: { valid: ["text", "", " "], invalid: [5, false, [], {}], message: "a string" },
  array: {
    valid: [[], ["cfo"], [" cfo ", "skeptic"]],
    invalid: ["cfo", 5, {}, [""], [" \t"], ["cfo", 5], [null], [undefined], new Array(1)],
    message: "an array of non-empty strings",
  },
  number: { valid: [0, -1, 2.5], invalid: ["2", "two", NaN, Infinity, -Infinity, false, {}], message: "a finite number" },
  boolean: { valid: [true, false], invalid: ["true", 0, 1, [], {}], message: "a boolean" },
};

for (const [tool, groups] of Object.entries(fields)) {
  test(`${tool} validates every declared argument before routing or engine calls`, async (t) => {
    const schema = tools.find((entry) => entry.name === tool).inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.values(groups).flat().sort());
    assert.equal(typeof checkArgs, "function", "export a pure argument validator");
    for (const args of [undefined, {}, { ignored: 42 }]) assert.doesNotThrow(() => checkArgs(tool, args));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected provider call"); });
    for (const [type, names] of Object.entries(groups)) {
      const rule = rules[type];
      for (const field of names) {
        for (const value of [undefined, null, ...rule.valid]) {
          assert.doesNotThrow(() => checkArgs(tool, { [field]: value }), `${tool}.${field}: ${String(value)}`);
        }
        for (const value of rule.invalid) {
          const message = `${tool}: "${field}" must be ${rule.message}`;
          assert.throws(() => checkArgs(tool, { [field]: value }), { name: "Error", message });
          const result = await handleToolCall(tool, { [field]: value });
          assert.equal(result.isError, true);
          assert.equal(result.content[0].text, `Error: ${message}`);
        }
      }
    }
    const field = Object.values(groups).flat().find((name) => name !== "provider");
    const result = await handleToolCall(tool, { provider: "unknown", [field]: 42 });
    assert.equal(result.content[0].text, `Error: ${tool}: "${field}" must be a string`);
    assert.equal(calls, 0);
  });
}

test("improve_agent without an agent fails with an actionable error after provider checks", async () => {
  for (const args of [undefined, {}, { agent: null }, { agent: " " }]) {
    const result = await handleToolCall("improve_agent", args);
    assert.equal(result.content[0].text, 'Error: improve_agent: "agent" is required: pass the agent name or .md path to improve');
  }
  const badProvider = await handleToolCall("improve_agent", { provider: "grok" });
  assert.match(badProvider.content[0].text, /Unknown provider "grok"/);
});

test("submit_plan requires only the session id and describes reuse of the latest version", () => {
  const tool = tools.find((entry) => entry.name === "submit_plan");
  assert.deepEqual(tool.inputSchema.required, ["ultraplan_id"]);
  assert.match(tool.inputSchema.properties.plan.description, /optional/i);
  assert.match(tool.inputSchema.properties.plan.description, /as-is/);
  assert.match(tool.inputSchema.properties.plan.description, /No plan version exists yet; pass plan\./);
});

test("workshop proposals report an unchanged agent and retain recovery details", () => {
  const result = {
    mode: "improve", sessionId: "workshop-1",
    agent: { name: "cfo", path: null, description: "Budget advice", skills: [] },
    proposedPath: "cfo.md.proposed-20261008-120000",
    warnings: ["Target changed during the run"],
    contributions: [], reviews: [],
    next: "Compare the proposal with the current target before applying it.",
    publicBlock: "Public transcript: test channel",
  };
  const text = formatAgentWorkshopResult(result);
  assert.ok(text.startsWith("## Proposed changes for agent: cfo\n"));
  assert.match(text, /Agent: not updated \(the file changed during the run\)/);
  assert.ok(text.includes(`Proposed: ${result.proposedPath}\n`));
  assert.doesNotMatch(text, /Improved agent|\(preview, not written\)/);
  assert.ok(text.includes("- Target changed during the run"));
  assert.ok(text.includes(result.next));
  assert.ok(text.includes(JSON.stringify(result, null, 2)));
  assert.ok(text.endsWith(result.publicBlock));
});
