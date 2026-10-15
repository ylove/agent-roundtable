import { test } from "node:test";
import assert from "node:assert/strict";
const { tools, toolsFor, handleToolCall } = await import("../../dist/tools.js");
const names = await import("../../dist/tools/names.js");
const { deliberationTools } = await import("../../dist/tools/deliberation.js");
const { workerTools } = await import("../../dist/tools/worker.js");

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test("every tool has a title and all four MCP hints", () => {
  assert.equal(tools.length, 33, "22 at the table, 3 contract tools, join_execution and the 7 worker tools");
  assert.equal(toolsFor("worker").length, 7);
  for (const tool of tools) {
    assert.equal(typeof tool.annotations?.title, "string", tool.name);
    assert.ok(tool.annotations.title.length > 0, tool.name);
    for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint}`);
  }
});

test("annotation values: read-only diagnostics and listings, file-writing workshops, destructive ends", () => {
  for (const name of ["list_meetings", "list_local_meetings", "list_collaborations", "get_collaboration_transcript"]) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.equal(byName[name].annotations.openWorldHint, false, name);
  }
  // debug_env changes nothing but probes Ollama over the network.
  assert.equal(byName.debug_env.annotations.readOnlyHint, true);
  assert.equal(byName.debug_env.annotations.openWorldHint, true);
  for (const name of ["create_agent", "improve_agent"]) {
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.equal(byName[name].annotations.openWorldHint, true, name);
  }
  assert.equal(byName.create_agent.annotations.destructiveHint, false, "create never overwrites");
  assert.equal(byName.improve_agent.annotations.destructiveHint, true, "improve replaces the target");
  for (const name of ["end_meeting", "end_local_meeting", "end_collaboration", "end_ultraplan"]) {
    assert.equal(byName[name].annotations.destructiveHint, true, name);
  }
  for (const name of ["start_meeting", "say", "start_collaboration", "continue_collaboration", "start_ultraplan", "submit_plan"]) {
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.equal(byName[name].annotations.openWorldHint, true, name);
  }
});

test("the mode filter: deliberation tools and join_execution are orchestrator-only; the worker server lists the seven worker tools", () => {
  assert.deepEqual(toolsFor("orchestrator"), tools);
  for (const def of deliberationTools) assert.deepEqual([...def.modes], ["orchestrator"], def.name);
  assert.deepEqual(toolsFor("worker").map((t) => t.name), [...names.WORKER_TOOL_NAMES]);
  for (const def of workerTools) {
    assert.deepEqual([...def.modes], def.name === "join_execution" ? ["orchestrator"] : ["worker", "orchestrator"], def.name);
  }
  // The same tool, two schemas: the orchestrator's copy authenticates with agent_token.
  const w = Object.fromEntries(toolsFor("worker").map((t) => [t.name, t]));
  for (const name of names.WORKER_TOOL_NAMES) {
    assert.equal(w[name].inputSchema.properties.agent_token, undefined, name);
    assert.deepEqual(byName[name].inputSchema.required.slice(0, 2), ["execution_id", "agent_token"], name);
  }
});

test("listed tools carry no internal fields or schema extensions", () => {
  for (const list of [tools, toolsFor("worker")]) {
    const serialized = JSON.stringify(list);
    assert.doesNotMatch(serialized, /"modes"|"inputSchemaByMode"|"x-[a-z-]+"/);
    for (const tool of list) assert.deepEqual(Object.keys(tool).sort(), ["annotations", "description", "inputSchema", "name"], tool.name);
  }
});

test("a tool not offered in a mode is unknown there", async () => {
  const r = await handleToolCall("list_meetings", {}, "worker");
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Error: Unknown tool: list_meetings");
  assert.equal((await handleToolCall("join_execution", { execution_id: "exe-0000000000abcdef", agent: "x" }, "worker")).content[0].text, "Error: Unknown tool: join_execution");
  assert.equal((await handleToolCall("no_such_tool", {})).content[0].text, "Error: Unknown tool: no_such_tool");
  assert.equal((await handleToolCall("list_meetings", {})).content[0].text, "No active meetings.");
});

test("contract tools: orchestrator only, strict schemas, and annotations that match what they do", async () => {
  const { contractTools } = await import("../../dist/tools/contract.js");
  assert.deepEqual(contractTools.map((d) => d.name), [names.PROPOSE_CONTRACT, names.AMEND_CONTRACT, names.FREEZE_CONTRACT]);
  for (const def of contractTools) {
    assert.deepEqual([...def.modes], ["orchestrator"], def.name);
    assert.equal(def.inputSchema.additionalProperties, false, def.name);
    assert.equal(byName[def.name].annotations.readOnlyHint, false, def.name);
  }
  assert.equal(byName.propose_contract.annotations.openWorldHint, true, "propose may call a provider");
  assert.equal(byName.amend_contract.annotations.destructiveHint, true, "amend can cancel tasks");
  assert.equal(byName.freeze_contract.annotations.openWorldHint, false, "freeze is local");
  assert.equal(byName.freeze_contract.inputSchema.properties.excuse.items.additionalProperties, false);
});

test("names.ts: mode labels and one constant per tool", () => {
  assert.equal(names.AT_THE_TABLE, "at the table");
  assert.equal(names.HEADS_DOWN, "heads-down");
  assert.deepEqual(names.MODE_LABELS, { deliberation: "at the table", execution: "heads-down" });
  const constants = Object.entries(names).filter(([k, v]) => typeof v === "string" && /^[A-Z_]+$/.test(k) && !["AT_THE_TABLE", "HEADS_DOWN"].includes(k));
  assert.deepEqual(constants.map(([, v]) => v).sort(), tools.map((t) => t.name).sort());
});
