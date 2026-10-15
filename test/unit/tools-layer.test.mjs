import { test } from "node:test";
import assert from "node:assert/strict";
const { tools, toolsFor, handleToolCall } = await import("../../dist/tools.js");
const names = await import("../../dist/tools/names.js");
const { deliberationTools } = await import("../../dist/tools/deliberation.js");

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

test("every tool has a title and all four MCP hints", () => {
  assert.equal(tools.length, 22);
  for (const tool of tools) {
    assert.equal(typeof tool.annotations?.title, "string", tool.name);
    assert.ok(tool.annotations.title.length > 0, tool.name);
    for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name}.${hint}`);
  }
});

test("annotation values: read-only diagnostics and listings, file-writing workshops, destructive ends", () => {
  for (const name of ["debug_env", "list_meetings", "list_local_meetings", "list_collaborations", "get_collaboration_transcript"]) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.equal(byName[name].annotations.openWorldHint, false, name);
  }
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

test("the mode filter: every existing tool is orchestrator-only, the worker list is empty", () => {
  assert.deepEqual(toolsFor("orchestrator"), tools);
  assert.deepEqual(toolsFor("worker"), []);
  for (const def of deliberationTools) assert.deepEqual([...def.modes], ["orchestrator"], def.name);
});

test("listed tools carry no internal fields or schema extensions", () => {
  const serialized = JSON.stringify(tools);
  assert.doesNotMatch(serialized, /"modes"|"x-[a-z-]+"/);
  for (const tool of tools) assert.deepEqual(Object.keys(tool).sort(), ["annotations", "description", "inputSchema", "name"], tool.name);
});

test("a tool not offered in a mode is unknown there", async () => {
  const r = await handleToolCall("list_meetings", {}, "worker");
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Error: Unknown tool: list_meetings");
  assert.equal((await handleToolCall("no_such_tool", {})).content[0].text, "Error: Unknown tool: no_such_tool");
  assert.equal((await handleToolCall("list_meetings", {})).content[0].text, "No active meetings.");
});

test("names.ts: mode labels and one constant per deliberation tool", () => {
  assert.equal(names.AT_THE_TABLE, "at the table");
  assert.equal(names.HEADS_DOWN, "heads-down");
  assert.deepEqual(names.MODE_LABELS, { deliberation: "at the table", execution: "heads-down" });
  const constants = Object.entries(names).filter(([k, v]) => typeof v === "string" && /^[A-Z_]+$/.test(k) && !["AT_THE_TABLE", "HEADS_DOWN"].includes(k));
  assert.deepEqual(constants.map(([, v]) => v).sort(), tools.map((t) => t.name).sort());
});
