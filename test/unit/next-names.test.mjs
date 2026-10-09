import { test } from "node:test";
import assert from "node:assert/strict";
const { tools } = await import("../../dist/tools.js");
const workshop = await import("../../dist/sessions/agent-creation.js");
const ultraplan = await import("../../dist/sessions/ultraplan.js");

// These are session status values and a Claude Code Agent-tool parameter.
const known = new Set(["awaiting_plan", "awaiting_revision", "subagent_type"]);
const descriptions = [];
function schema(node) {
  if (!node || typeof node !== "object") return;
  if (node.description) descriptions.push(node.description);
  for (const key of Object.keys(node.properties ?? {})) known.add(key);
  for (const value of node.enum ?? []) if (typeof value === "string") known.add(value);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(schema);
    else if (value && typeof value === "object") schema(value);
  }
}
for (const tool of tools) {
  known.add(tool.name);
  descriptions.push(tool.description);
  schema(tool.inputSchema);
}
function unknown(text) {
  return [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(m => m[0]).filter(name => !known.has(name));
}

test("all workshop and ultraplan next variants and tool descriptions mention registered names", () => {
  const texts = [
    workshop.buildWorkshopNext({ written: false, agentName: "new-agent" }),
    workshop.buildWorkshopNext({ written: true, agentName: "new-agent", targetPath: "target.md", proposedPath: "proposal.txt" }),
    workshop.buildWorkshopNext({ written: true, agentName: "new-agent", targetPath: "target.md", backupPath: "backup.txt" }),
    workshop.buildWorkshopNext({ written: true, agentName: "new-agent" }),
    workshop.buildWorkshopNext({ written: true, agentName: "new-agent", meetingId: "meeting-1" }),
    ultraplan.NEXT_AFTER_INPUT, ultraplan.NEXT_AFTER_REVIEW,
    ultraplan.buildUnreviewedNext(2), ultraplan.buildPlannerStoppedError("review of v2", "phase failed"),
    ...descriptions,
  ];
  for (const text of texts) assert.deepEqual(unknown(text), [], text);
  assert.deepEqual(unknown("Continue with continue_meeting."), ["continue_meeting"]);
});
