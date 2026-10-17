import { test } from "node:test";
import assert from "node:assert/strict";
const { checkArgs, handleToolCall, formatAgentWorkshopResult, tools } = await import("../../dist/tools.js");

// Keep these lists independent of the schemas so omitted fields cannot pass silently.
const fields = {
  start_ultraplan: {
    string: ["task", "context", "draft_plan", "planner", "provider", "model", "base_url"],
    array: ["agents"], number: ["revision_rounds"], boolean: ["public", "execution_ready"],
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
  propose_contract: {
    string: ["goal", "orchestrator", "title", "original_prompt", "from_session", "plan", "parent_contract", "parent_task", "repo_dir", "base_ref", "provider", "model", "base_url"],
    array: ["artifacts", "participants"], boolean: ["consent"], object: ["contract"],
  },
  amend_contract: {
    string: ["contract_id", "reason", "orchestrator", "from_session", "provider", "model", "base_url"],
    boolean: ["consent", "override_consent"], object: ["patch"],
  },
  freeze_contract: { string: ["contract_id", "orchestrator"], boolean: ["abandon_round"], objects: ["excuse"] },
  execute: {
    string: ["contract_id", "confirmation", "lead", "worker_model"], usd: ["budget_usd"], integer: ["max_parallel"],
    visibility: ["visibility"], sandbox: ["sandbox"], driver: ["worker_driver"],
  },
  execution_status: { exe: ["execution_id"], string: ["focus"], view: ["view"], integer: ["since_seq", "limit"] },
  control_execution: {
    exe: ["execution_id"], control: ["action"], string: ["reason", "message", "session"],
    array: ["task_ids", "targets"], boolean: ["confirm", "to_table"],
  },
  resolve_escalation: {
    exe: ["execution_id"], string: ["escalation_id", "decision", "resolved_by", "provider", "model", "base_url"],
    resolution: ["action"], format: ["format"], array: ["participants"], object: ["amendment"],
  },
};
// Run-tool fields whose valid values are narrower (ids, enums, ranges): wrong types still fail the same way.
const typed = (valid, message = "a string", invalid = [5, false, [], {}]) => ({ valid, invalid, message });
const rules = {
  string: { valid: ["text", "", " "], invalid: [5, false, [], {}], message: "a string" },
  array: {
    valid: [[], ["cfo"], [" cfo ", "skeptic"]],
    invalid: ["cfo", 5, {}, [""], [" \t"], ["cfo", 5], [null], [undefined], new Array(1)],
    message: "an array of non-empty strings",
  },
  number: { valid: [0, -1, 2.5], invalid: ["2", "two", NaN, Infinity, -Infinity, false, {}], message: "a finite number" },
  boolean: { valid: [true, false], invalid: ["true", 0, 1, [], {}], message: "a boolean" },
  object: { valid: [{}, { tasks: [] }], invalid: ["{}", 5, [], false], message: "an object" },
  objects: { valid: [[], [{ agent: "cfo", reason: "out of scope" }]], invalid: ["cfo", 5, {}, false], message: "an array" },
  exe: typed(["exe-0123456789abcdef"]),
  view: typed(["summary", "context"]),
  control: typed(["pause", "purge"]),
  resolution: typed(["decide", "await_human"]),
  format: typed(["micro", "waffle-house"]),
  sandbox: typed(["docker", "local"]),
  driver: typed(["claude-code", "codex"]),
  usd: typed([0.5, 25], "a finite number", ["2", "two", NaN, Infinity, false, {}]),
  integer: typed([1, 3], "an integer", ["2", 2.5, NaN, false, {}]),
  visibility: typed([{}, { dashboard: true }, { chat_only: true }, { github: { repo: "acme/shop", project_number: 3 } }], "an object", ["x", 5, [], false]),
};

for (const [tool, groups] of Object.entries(fields)) {
  test(`${tool} validates every declared argument before routing or engine calls`, async (t) => {
    const schema = tools.find((entry) => entry.name === tool).inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.values(groups).flat().sort());
    assert.equal(typeof checkArgs, "function", "export a pure argument validator");
    for (const args of [undefined, {}]) assert.doesNotThrow(() => checkArgs(tool, args));
    // Heads-down tools reject unknown arguments (additionalProperties: false); the older ones ignore them.
    if (schema.additionalProperties === false) assert.throws(() => checkArgs(tool, { ignored: 42 }), { message: new RegExp(`^${tool}: "ignored" is not allowed`) });
    else assert.doesNotThrow(() => checkArgs(tool, { ignored: 42 }));
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

test("every tool's arguments are validated before routing, with nested paths for new rules", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected provider call"); });
  for (const [tool, args, message] of [
    ["say", { meeting_id: "m", message: 5 }, 'say: "message" must be a string'],
    ["say_local", { meeting_id: 7, message: "hi" }, 'say_local: "meeting_id" must be a string'],
    ["end_meeting", { meeting_id: "m", request_summary: "yes" }, 'end_meeting: "request_summary" must be a boolean'],
    ["start_collaboration", { agents: "cfo", topic: "t" }, 'start_collaboration: "agents" must be an array of non-empty strings'],
    ["continue_collaboration", { collaboration_id: "c", rounds: "2" }, 'continue_collaboration: "rounds" must be a finite number'],
    ["chat_completion", { messages: "hi" }, 'chat_completion: "messages" must be an array'],
    ["chat_completion", { messages: ["hi"] }, 'chat_completion: "messages[0]" must be an object'],
    ["chat_completion", { messages: [{ role: "bot", content: "hi" }] }, 'chat_completion: "messages[0].role" must be one of: system, user, assistant'],
    ["chat_completion", { messages: [{ role: "user" }] }, 'chat_completion: "messages[0].content" is required'],
    ["chat_completion", { messages: [{ role: "user", content: "hi" }], max_tokens: "8" }, 'chat_completion: "max_tokens" must be a finite number'],
    // Required fields are now enforced for the legacy tools too (after type and provider checks).
    ["say", {}, 'say: "meeting_id" is required'],
    ["improve_agent", { agent: " " }, 'improve_agent: "agent" is required: pass the agent name or .md path to improve'],
    ["start_ultraplan", { agents: ["cfo"], task: " \n" }, 'start_ultraplan: "task" is required: describe what the plan is for'],
    ["end_local_meeting", {}, 'end_local_meeting: "meeting_id" is required'],
    ["nudge_collaboration", { collaboration_id: "c" }, 'nudge_collaboration: "message" is required'],
    ["end_collaboration", { collaboration_id: null }, 'end_collaboration: "collaboration_id" is required'],
    ["start_meeting", { agent: "cfo" }, 'start_meeting: "agenda" is required'],
    ["start_collaboration", { topic: "t" }, 'start_collaboration: "agents" is required'],
    ["chat_completion", {}, 'chat_completion: "messages" is required'],
    ["submit_plan", {}, 'submit_plan: "ultraplan_id" is required'],
    ["start_ultraplan", { agents: ["cfo"] }, 'start_ultraplan: "task" is required: describe what the plan is for'],
    ["start_ultraplan", { task: "Plan", provider: "openai", base_url: "http://x.test/v1" }, 'base_url is only supported with provider "openai_compatible" (got "openai")'],
  ]) {
    const result = await handleToolCall(tool, args);
    assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.equal(result.content[0].text, `Error: ${message}`);
  }
  assert.equal(calls, 0);
});

test("legacy enums stay with the engines, so their messages (with the valid list) are unchanged", async () => {
  const meeting = await handleToolCall("start_meeting", { agent: "x", agenda: "y", mode: "Debate" });
  assert.match(meeting.content[0].text, /^Error: Unknown mode "Debate"\. Valid modes: standard, debate$/);
  const collab = await handleToolCall("start_collaboration", { agents: ["x", "y"], topic: "t", mode: "waffle_house" });
  assert.match(collab.content[0].text, /Unknown mode "waffle_house"\. Valid modes: collaborate, debate, waffle-house, conversation/);
  const chat = await handleToolCall("chat_completion", { messages: [{ role: "user", content: "hi" }], provider: "grok" });
  assert.match(chat.content[0].text, /^Error: Unknown provider "grok"\. Valid providers: /);
  // minItems is not part of the subset: the engines keep their own participant-count messages.
  const ultra = await handleToolCall("start_ultraplan", { agents: [], task: "Plan" });
  assert.equal(ultra.content[0].text, "Error: Ultraplan requires at least 1 agent");
  const pair = await handleToolCall("start_collaboration", { agents: ["solo"], topic: "t" });
  assert.equal(pair.content[0].text, "Error: Collaboration requires at least 2 agents");
});

test("blank strings stay valid wherever the engines accepted them", async () => {
  // Only improve_agent.agent and start_ultraplan.task (x-nonblank) treat a blank string as missing.
  assert.doesNotThrow(() => checkArgs("chat_completion", { messages: [{ role: "assistant", content: "" }, { role: "user", content: "hi" }] }));
  const nudge = await handleToolCall("nudge_collaboration", { collaboration_id: "collab-none", message: "" });
  assert.equal(nudge.content[0].text, "Error: Collaboration not found: collab-none");
  const say = await handleToolCall("say", { meeting_id: "meeting-none", message: "  " });
  assert.equal(say.content[0].text, "Error: Meeting not found: meeting-none");
});

test("checkArgs checks given values only and never reports a missing field", () => {
  for (const tool of tools.map((entry) => entry.name)) {
    assert.doesNotThrow(() => checkArgs(tool, {}), tool);
    assert.doesNotThrow(() => checkArgs(tool, undefined), tool);
  }
  assert.throws(() => checkArgs("chat_completion", { messages: [{ role: "user" }] }), { message: 'chat_completion: "messages[0].content" is required' });
  assert.doesNotThrow(() => checkArgs("no_such_tool", { anything: 1 }));
});

test("worker tools validate their arguments in both modes; the worker copy takes no token", async () => {
  const token = "a".repeat(64);
  assert.throws(() => checkArgs("read_blackboard", { agent_token: "short" }), { message: 'read_blackboard: "agent_token" must match the pattern ^[0-9a-f]{64}$' });
  assert.throws(() => checkArgs("read_blackboard", { execution_id: "exe-1" }), /"execution_id" must match the pattern/);
  assert.throws(() => checkArgs("read_blackboard", { agent_token: token }, "worker"), /"agent_token" is not allowed/);
  assert.doesNotThrow(() => checkArgs("read_blackboard", { section: "query", query: "nav" }, "worker"));
  assert.throws(() => checkArgs("read_blackboard", { section: "everything" }, "worker"), /"section" must be one of: summary, goal/);
  assert.throws(() => checkArgs("lease", { action: "grab" }), /"action" must be one of: request, release/);
  assert.throws(() => checkArgs("lease", { paths: [""] }), /"paths" must be an array of non-empty strings/);
  assert.throws(() => checkArgs("post_update", { percent: 101 }), /"percent" must be at most 100/);
  assert.throws(() => checkArgs("escalate", { diagnostics: { secret: "x" } }), /"diagnostics.secret" is not allowed/);
  assert.throws(() => checkArgs("escalate", { emergency: "panic" }), /"emergency" must be one of: money, credentials, scope, human_action/);
  assert.throws(() => checkArgs("submit_work", { ready: "yes" }), /"ready" must be a boolean/);
  assert.throws(() => checkArgs("run_command", { timeout_s: 901 }), /"timeout_s" must be at most 900/);
  assert.throws(() => checkArgs("join_execution", { agent: "Not An Id" }), /"agent" must match the pattern/);
  const r = await handleToolCall("submit_work", { summary: "x" }, "worker");
  assert.equal(r.content[0].text, 'Error: submit_work: "ready" is required');
  const r2 = await handleToolCall("post_update", { kind: "ack", text: "ok" }, "worker");
  assert.equal(r2.content[0].text, 'Error: post_update: kind ack needs "directive_id"');
});

test("run tools check ranges, enums and nested visibility, and are orchestrator-only", async () => {
  assert.throws(() => checkArgs("execute", { budget_usd: 0 }), { message: 'execute: "budget_usd" must be at least 0.01' });
  assert.throws(() => checkArgs("execute", { max_parallel: 17 }), /"max_parallel" must be at most 16/);
  assert.throws(() => checkArgs("execute", { visibility: { github: {} } }), { message: 'execute: "visibility.github.repo" is required' });
  assert.throws(() => checkArgs("execute", { visibility: { github: { repo: "a/b", project_number: 0 } } }), /"visibility.github.project_number" must be at least 1/);
  assert.throws(() => checkArgs("execute", { visibility: { slack: true } }), /"visibility.slack" is not allowed/);
  assert.throws(() => checkArgs("execute", { sandbox: "vm" }), /"sandbox" must be one of: docker, local/);
  assert.throws(() => checkArgs("execution_status", { view: "everything" }), /"view" must be one of: summary, tasks, escalations, events, budget, context/);
  assert.throws(() => checkArgs("execution_status", { execution_id: "exe-1" }), /"execution_id" must match the pattern/);
  assert.throws(() => checkArgs("control_execution", { action: "restart" }), /"action" must be one of: pause, resume, steer, abort, purge/);
  assert.throws(() => checkArgs("resolve_escalation", { format: "brainstorm" }), /"format" must be one of: micro, meeting/);
  const missing = await handleToolCall("execute", { contract_id: "ctr-abcdef-1" });
  assert.equal(missing.content[0].text, "Error: execute: \"confirmation\" is required: quote the human's words asking you to execute");
  const r = await handleToolCall("resolve_escalation", { execution_id: "exe-0123456789abcdef", escalation_id: "esc-1", action: "decide", provider: "openai", base_url: "http://x.test/v1" });
  assert.match(r.content[0].text, /base_url is only supported with provider "openai_compatible"/);
  for (const name of ["execute", "execution_status", "control_execution", "resolve_escalation"]) {
    const w = await handleToolCall(name, {}, "worker");
    assert.equal(w.content[0].text, `Error: Unknown tool: ${name}`);
  }
});
