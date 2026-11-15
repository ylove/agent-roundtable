import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

const root = fs.mkdtempSync(join(tmpdir(), "rt-session-scope-"));
const agents = join(root, "agents");
const workspace = join(root, "workspace");
process.env.ROUNDTABLE_AGENTS_DIR = agents;
process.env.ROUNDTABLE_AGENT_PATHS = agents;
process.env.ROUNDTABLE_WORKSPACE_DIR = workspace;
process.env.HOME = join(root, "home");
process.env.ROUNDTABLE_ACTIVITY_LOG = "off";
for (const path of [agents, workspace, process.env.HOME]) fs.mkdirSync(path);
const put = (path, text) => { fs.mkdirSync(join(path, ".."), { recursive: true }); fs.writeFileSync(path, text); return path; };
const alpha = put(join(agents, "alpha.md"), "You are Alpha.");
const beta = put(join(agents, "beta.md"), "You are Beta.");
const { startMeeting, meetings } = await import("../../dist/sessions/meetings.js");
const { startCollaboration, collaborations } = await import("../../dist/sessions/collaborations.js");
const { buildGrounding } = await import("../../dist/sessions/grounding.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const options = { provider: "openai_compatible", model: "fixture", baseUrl: "http://localhost:1234/v1" };

test("meetings and collaborations enforce the same persona path scope", { skip: process.platform === "win32" }, async t => {
  const outside = put(join(root, "outside.md"), "OUTSIDE-PERSONA");
  const link = join(agents, "linked.md");
  fs.symlinkSync(outside, link);
  const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: "ok" } }] }));
  for (const ref of [outside, link]) {
    const why = ref === link ? /through a symlink/ : /outside the allowed agent directories/;
    await assert.rejects(startMeeting(ref, "scope", undefined, options.provider, options.model, options.baseUrl), why);
    for (const mode of ["collaborate", "debate", "waffle-house", "conversation"]) {
      await assert.rejects(startCollaboration([ref, beta], "scope", { ...options, mode }), why);
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(meetings.size, 0);
  assert.equal(collaborations.size, 0);
  const meeting = await startMeeting(alpha, "scope", undefined, options.provider, options.model, options.baseUrl);
  assert.ok(meeting.meetingId);
  meetings.clear();
});

test("conversation grounding keeps workspace and memory containment and size caps", { skip: process.platform === "win32" }, async t => {
  const outside = put(join(root, "outside-context.md"), "OUTSIDE-CONTEXT");
  fs.symlinkSync(outside, join(workspace, "CLAUDE.md"));
  fs.symlinkSync(outside, join(workspace, "AGENTS.md"));
  put(join(workspace, "README.md"), "WORKSPACE-CONTEXT\n" + "r".repeat(5 * 1024 * 1024));
  const memory = join(workspace, ".claude", "agent-memory");
  put(join(memory, "alpha", "MEMORY.md"), "MEMORY-CONTEXT\n" + "m".repeat(5 * 1024 * 1024));
  fs.mkdirSync(join(memory, "beta"));
  fs.symlinkSync(outside, join(memory, "beta", "MEMORY.md"));
  const packet = await buildGrounding({ key: "alpha" });
  assert.ok(packet.text.length <= 8000);
  assert.ok(packet.text.includes("WORKSPACE-CONTEXT"));
  assert.ok(packet.text.includes("MEMORY-CONTEXT"));
  assert.ok(!packet.text.includes("OUTSIDE-CONTEXT"));
  const calls = stubFetch(t, () => json(200, { choices: [{ message: { content: "ok" } }] }));
  const started = await startCollaboration([alpha, beta], "scope", { ...options, mode: "conversation" });
  const session = collaborations.get(started.collaborationId);
  const prompts = session.agents.map(agent => agent.systemPrompt);
  assert.ok(prompts[0].includes(packet.text));
  assert.ok(prompts.every(prompt => !prompt.includes("OUTSIDE-CONTEXT")));
  assert.ok(!prompts[1].includes("MEMORY-CONTEXT"));
  assert.ok(calls.length > 0);
  collaborations.clear();
});
