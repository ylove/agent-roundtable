// Offline smoke test: no provider is called, zero API spend. Run: npm test
import { startServer, assert } from "./mcp-client.mjs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "./unit/helpers.mjs";

const EXPECTED_PROVIDERS = ["anthropic", "openai", "together", "replicate", "ollama", "openai_compatible"];
const PROVIDER_TOOLS = ["start_meeting", "chat_completion", "start_collaboration", "start_ultraplan", "create_agent", "improve_agent"];
const NEW_START_TOOLS = ["start_ultraplan", "create_agent", "improve_agent"];
const root = mkdtempSync(join(tmpdir(), "roundtable-smoke-"));
const agentsDir = join(root, "agents");
mkdirSync(agentsDir);
for (const name of ["cfo", "product-lead", "skeptic"]) {
  writeFileSync(join(agentsDir, `${name}.md`), readFileSync(new URL(`../examples/${name}.md`, import.meta.url)));
}
writeFileSync(join(root, "README.md"), "Smoke project: ship the onboarding launch.");
// Keys are deliberately absent/unset so no provider can be reached even by accident; a fake
// REPLICATE_API_TOKEN is set only to prove debug_env never echoes any part of a configured key.
const smokeEnv = {
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  TOGETHER_API_KEY: "",
  OLLAMA_URL: "http://127.0.0.1:9",
  OPENAI_COMPATIBLE_BASE_URL: "",
  OPENAI_COMPATIBLE_API_KEY: "",
  REPLICATE_API_TOKEN: "r8_test",
  ROUNDTABLE_AGENTS_DIR: agentsDir,
  ROUNDTABLE_SKILLS_DIR: join(root, "skills"),
  ROUNDTABLE_WORKSPACE_DIR: root,
  ROUNDTABLE_ACTIVITY_LOG: join(root, "activity.jsonl"),
  ROUNDTABLE_TRANSCRIPTS_DIR: join(root, "transcripts"),
  ROUNDTABLE_PARALLEL_TURNS: "2",
};
// Load .env once, then pin test config before index.js imports config.ts. Stub every child fetch,
// including Ollama reachability; a developer's .env must never enable network or home-directory writes.
const preload = join(root, "offline.mjs");
writeFileSync(preload, `await import(${JSON.stringify(new URL("../dist/env.js", import.meta.url).href)});
Object.assign(process.env, ${JSON.stringify(smokeEnv)});
globalThis.fetch = async () => { throw new Error("Offline smoke: network disabled"); };
`);
const server = startServer({
  env: {
    ...smokeEnv,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(preload).href}`,
  },
});
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

// Exercise the dispatch boundary as well as stdio schemas: all provider replies are scripted.
async function checkDispatch() {
  Object.assign(process.env, smokeEnv, {
    ROUNDTABLE_PUBLISHER: "webhook",
    ROUNDTABLE_WEBHOOK_URL: "http://publisher.test/post",
    ROUNDTABLE_WEBHOOK_VIEW_URL: "http://publisher.test/{channel}",
    ROUNDTABLE_WEBHOOK_AUTH_HEADER: "",
  });
  const { handleToolCall, formatUltraplanResult, formatAgentWorkshopResult } = await import("../dist/tools.js");
  const { ultraplans } = await import("../dist/sessions/ultraplan.js");
  const { meetings } = await import("../dist/sessions/meetings.js");
  const { collaborations } = await import("../dist/sessions/collaborations.js");
  const realFetch = globalThis.fetch;
  const providerArgs = { provider: "openai_compatible", model: "smoke-model", base_url: "http://llm.test/v1" };
  let calls = [];
  let replies = [];
  const script = (...outputs) => { calls = []; replies = outputs; };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "http://publisher.test/post") return json(200, {});
    assert(String(url) === "http://llm.test/v1/chat/completions", `Unexpected fetch: ${url}`);
    const body = JSON.parse(init.body);
    assert(body.model === "smoke-model", JSON.stringify(body));
    calls.push(body);
    assert(replies.length, "Unexpected provider call");
    const output = replies.shift();
    return output instanceof Response ? output : json(200, { choices: [{ message: { content: output } }] });
  };
  const call = async (name, args) => {
    const r = await handleToolCall(name, args);
    assert(!r.isError, r.content[0].text);
    return r.content[0].text;
  };
  const workshopResult = (text) => JSON.parse(text.slice(text.indexOf("\n{")));
  const spec = JSON.stringify({
    name: "launch-owner",
    description: "Own launch acceptance checks",
    system_prompt: "You own launch readiness. Verify acceptance checks.",
    skills: [{ name: "launch-checks", description: "Check launch readiness", instructions: "Check acceptance criteria.", contributed_by: ["cfo"] }],
    contributions: [{ agent: "cfo", summary: "Define budget guardrails" }],
    changes: ["Clarify acceptance checks"],
  });
  try {
    console.log("offline dispatch");
    script("Input from cfo", "Input from product", "Verdict: APPROVE", "Verdict: OBJECT", "Sign-off: APPROVE", "Sign-off: APPROVE WITH RESERVATIONS");
    const start = JSON.parse(await call("start_ultraplan", { ...providerArgs, agents: ["cfo", "product-lead"], task: "Launch", context: "Private launch context" }));
    const debug = JSON.parse(await call("debug_env", {}));
    check("dispatch start_ultraplan maps context and tracks active sessions", () => {
      assert(start.status === "awaiting_plan" && start.input.length === 2 && debug.active_ultraplans === 1, JSON.stringify(start));
      assert(calls[0].messages[1].content.includes("Private launch context"), JSON.stringify(calls[0]));
    });
    const review = JSON.parse(await call("submit_plan", { ultraplan_id: start.ultraplanId, plan: "v1 [cfo]" }));
    const final = await call("submit_plan", { ultraplan_id: start.ultraplanId, plan: "v2 [cfo, product-lead]", final: true });
    check("dispatch submit_plan reviews then returns the final document verbatim", () => {
      assert(review.status === "awaiting_revision" && review.version === 1 && review.tally.OBJECT === 1, JSON.stringify(review));
      assert(final.startsWith("# Ultraplan: Launch") && final.includes("v2 [cfo, product-lead]") && final.includes("## Sign-offs") && final.includes("## Agent input"), final);
      assert(!ultraplans.has(start.ultraplanId) && replies.length === 0, "session did not close or calls were skipped");
    });

    script("Verdict: APPROVE");
    const draft = JSON.parse(await call("start_ultraplan", { ...providerArgs, agents: ["cfo"], task: "Draft launch", draft_plan: "Existing draft", public: true }));
    const unsigned = await call("end_ultraplan", { ultraplan_id: draft.ultraplanId });
    check("dispatch maps draft_plan/public and end_ultraplan returns unsigned markdown plus public block", () => {
      assert(draft.phase === "review" && draft.version === 1 && draft.public.url.startsWith("http://publisher.test/"), JSON.stringify(draft));
      assert(unsigned.includes("Not signed off") && unsigned.includes("Existing draft") && unsigned.includes("Public transcript:"), unsigned);
    });

    script("Input", "Plan v1", "Verdict: APPROVE", "Plan v2", "Verdict: APPROVE", "Plan v3", "Sign-off: APPROVE");
    const autonomous = await call("start_ultraplan", { ...providerArgs, agents: ["cfo"], task: "Planner launch", planner: "product-lead", revision_rounds: 2 });
    check("dispatch maps planner/revision_rounds and returns one-call final markdown", () =>
      assert(autonomous.includes("Plan v3") && autonomous.includes("Plan versions: 3") && calls.length === 7 && replies.length === 0, autonomous));

    script("Input", json(500, { error: { message: "draft failed" } }));
    const stopped = JSON.parse(await call("start_ultraplan", { ...providerArgs, agents: ["cfo"], task: "Recover launch", planner: "product-lead" }));
    check("dispatch returns a recoverable planner error as a normal JSON step", () =>
      assert(stopped.error.includes("The session is open") && ultraplans.has(stopped.ultraplanId), JSON.stringify(stopped)));
    await call("end_ultraplan", { ultraplan_id: stopped.ultraplanId });

    script("Colleague reply");
    const conversation = JSON.parse(await call("start_collaboration", { ...providerArgs, agents: ["cfo", "product-lead"], mode: "conversation", grounding: false, context: "Just shipped onboarding" }));
    check("dispatch conversation accepts no topic and maps context/grounding:false", () => {
      const system = calls[0].messages[0].content;
      assert(system.includes("## Conversation mode") && !system.includes("## Your context"), system);
      assert(calls[0].messages[1].content.includes("Just shipped onboarding"), JSON.stringify(calls[0]));
    });
    script("CFO contribution", "Product contribution", "CFO second contribution", "Product second contribution", spec, "Verdict: READY", "Verdict: READY");
    const previewText = await call("create_agent", { ...providerArgs, from_session: conversation.collaborationId, task: "Own launch checks", name: "launch-owner", context: "Design context", rounds: 2, write: false, perform_task: true });
    const preview = workshopResult(previewText);
    check("dispatch create_agent maps source session, rounds and preview/delegation flags", () => {
      assert(preview.files.length === 2 && preview.agent.path === null && !existsSync(join(agentsDir, "launch-owner.md")), previewText);
      assert(calls.length === 7 && calls[0].messages[1].content.includes("Colleague reply") && calls[0].messages[1].content.includes("Design context"), JSON.stringify(calls));
      assert(preview.warnings.some((w) => w.includes("perform_task was skipped")) && previewText.includes("(preview, not written)") && previewText.includes("launch-checks (preview)"), previewText);
    });
    await call("end_collaboration", { collaboration_id: conversation.collaborationId });

    script("Contribution", spec, "Verdict: READY", "Task started");
    const createdText = await call("create_agent", { ...providerArgs, agents: ["cfo"], task: "Own launch checks", perform_task: true });
    const created = workshopResult(createdText);
    check("dispatch create_agent writes files and perform_task starts a private meeting", () =>
      assert(existsSync(created.agent.path) && created.meeting.response === "Task started" && createdText.includes(created.agent.path), createdText));
    await call("end_meeting", { meeting_id: created.meeting.meetingId });

    const original = readFileSync(join(agentsDir, "cfo.md"), "utf8");
    script("Product contribution", "Product second contribution", spec, "Verdict: READY");
    const improvedText = await call("improve_agent", { ...providerArgs, agent: "cfo", with: ["product-lead"], include_self: false, focus: "Acceptance", context: "Refinement context", rounds: 2 });
    const improved = workshopResult(improvedText);
    check("dispatch improve_agent maps specialists/self/focus/rounds and reports backup", () => {
      assert(calls.length === 4 && calls[0].messages[1].content.includes("Acceptance") && calls[0].messages[1].content.includes("Refinement context"), JSON.stringify(calls));
      assert(!calls[0].messages[1].content.includes("You are the agent being improved"), JSON.stringify(calls[0]));
      assert(readFileSync(improved.backupPath, "utf8") === original && improvedText.includes(`Backup: ${improved.backupPath}`), improvedText);
    });
    check("result formatters preserve final markdown/public blocks and workshop warnings", () => {
      assert(formatUltraplanResult({ status: "finalized", finalPlan: "Exact markdown\n", publicBlock: "Public block" }) === "Exact markdown\n\n\nPublic block", "final document changed");
      const text = formatAgentWorkshopResult({ ...improved, warnings: ["Review this warning"], publicBlock: "Public block" });
      assert(text.includes("\n- Review this warning\n") && text.endsWith("\n\nPublic block"), text);
    });
  } finally {
    globalThis.fetch = realFetch;
    ultraplans.clear();
    meetings.clear();
    collaborations.clear();
  }
}

try {
  await server.init();
  const tools = await server.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const serialized = JSON.stringify(tools);

  console.log("tools/list");
  check("exposes 22 distinct tools", () => assert(tools.length === 22 && new Set(tools.map((t) => t.name)).size === 22, `got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`));
  for (const name of PROVIDER_TOOLS) {
    check(`${name}.provider enum = ${EXPECTED_PROVIDERS.join("|")}`, () => {
      const e = byName[name]?.inputSchema?.properties?.provider?.enum;
      assert(JSON.stringify(e) === JSON.stringify(EXPECTED_PROVIDERS), `got ${JSON.stringify(e)}`);
    });
    check(`${name}.model description names both Claude ids + aliases`, () => {
      const d = byName[name]?.inputSchema?.properties?.model?.description || "";
      assert(d.includes("claude-opus-5") && d.includes("claude-sonnet-5") && d.includes('"opus"'), d);
    });
    check(`${name}.model description explains Replicate ref forms`, () => {
      const d = byName[name]?.inputSchema?.properties?.model?.description || "";
      assert(d.includes("owner/name:version") && d.includes("https://replicate.com/owner/name"), d);
    });
    check(`${name}.base_url is a string parameter scoped to openai_compatible`, () => {
      const p = byName[name]?.inputSchema?.properties?.base_url;
      assert(p && p.type === "string" && /openai_compatible/.test(p.description), JSON.stringify(p));
    });
    check(`${name}.provider description lists all six providers`, () => {
      const d = byName[name]?.inputSchema?.properties?.provider?.description || "";
      for (const id of EXPECTED_PROVIDERS) assert(d.includes(id), `missing ${id} in: ${d}`);
    });
  }
  for (const name of tools.map((t) => t.name)) {
    if (PROVIDER_TOOLS.includes(name)) continue;
    check(`${name} has no base_url parameter`, () =>
      assert(!byName[name]?.inputSchema?.properties?.base_url, "unexpected base_url"));
  }
  check("start_meeting / start_local_meeting mode enum = standard|debate, plus debate_focus", () => {
    for (const name of ["start_meeting", "start_local_meeting"]) {
      const p = byName[name]?.inputSchema?.properties;
      assert(JSON.stringify(p?.mode?.enum) === JSON.stringify(["standard", "debate"]), `${name}: ${JSON.stringify(p?.mode)}`);
      assert(p?.debate_focus?.type === "string", `${name} missing debate_focus`);
    }
  });
  check("start_collaboration mode enum = collaborate|debate|waffle-house|conversation, plus debate_focus", () => {
    const p = byName.start_collaboration?.inputSchema?.properties;
    assert(JSON.stringify(p?.mode?.enum) === JSON.stringify(["collaborate", "debate", "waffle-house", "conversation"]), JSON.stringify(p?.mode));
    assert(p?.debate_focus?.type === "string", "missing debate_focus");
  });
  check("all session starters have a boolean public parameter", () => {
    for (const name of ["start_meeting", "start_local_meeting", "start_collaboration", ...NEW_START_TOOLS]) {
      const p = byName[name]?.inputSchema?.properties?.public;
      assert(p?.type === "boolean", `${name} missing public`);
      assert(/context/.test(p.description) && /world-readable/.test(p.description), `${name} public description`);
    }
  });
  for (const [name, required] of [
    ["start_collaboration", ["agents"]],
    ["start_ultraplan", ["agents", "task"]],
    ["submit_plan", ["ultraplan_id", "plan"]],
    ["end_ultraplan", ["ultraplan_id"]],
    ["create_agent", []],
    ["improve_agent", ["agent"]],
  ]) {
    check(`${name} required arguments = ${required.join(", ") || "none (runtime validated)"}`, () =>
      assert(JSON.stringify(byName[name]?.inputSchema?.required || []) === JSON.stringify(required), JSON.stringify(byName[name]?.inputSchema)));
  }
  check("conversation schema exposes grounding and explains optional topic/current context", () => {
    const p = byName.start_collaboration.inputSchema.properties;
    assert(p.grounding?.type === "boolean" && p.topic.description.includes("Required except"), JSON.stringify(p));
    assert(p.context.description.includes("what each agent last did"), p.context.description);
  });
  check("ultraplan agent list requires at least one specialist", () => {
    const p = byName.start_ultraplan.inputSchema.properties;
    assert(p.agents.minItems === 1 && p.agents.items.type === "string", JSON.stringify(p.agents));
    assert(p.revision_rounds.type === "number" && p.planner.type === "string" && p.draft_plan.type === "string", JSON.stringify(p));
    assert(byName.submit_plan.inputSchema.properties.final.type === "boolean", "missing final");
  });
  check("workshop schemas expose preview, delegation and refinement controls", () => {
    const c = byName.create_agent.inputSchema.properties;
    const i = byName.improve_agent.inputSchema.properties;
    for (const p of [c, i]) {
      assert(p.from_session.type === "string" && p.write.type === "boolean" && p.rounds.type === "number", JSON.stringify(p));
    }
    assert(c.perform_task.type === "boolean" && c.name.type === "string" && c.agents.items.type === "string", JSON.stringify(c));
    assert(i.include_self.type === "boolean" && i.with.items.type === "string" && i.focus.type === "string", JSON.stringify(i));
  });
  // The forbidden names are assembled from fragments so this file itself passes the repo hygiene grep
  // (which rejects any file containing the legacy project name or the removed image-tool names).
  const forbidden = new RegExp(["vo" + "uch", "generate_" + "image", "list_image_" + "models"].join("|"), "i");
  check("tool schemas carry no legacy names or image tools", () =>
    assert(!forbidden.test(serialized), "found legacy/image text in tool schemas"));

  console.log("tools/call");
  const unknown = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "grok",
  });
  check("unknown provider is rejected (no silent fallthrough to OpenAI)", () =>
    assert(unknown.isError && /Unknown provider "grok"/.test(unknown.text), unknown.text));
  check("unknown provider error lists the six valid ids", () =>
    assert(unknown.text.includes(`Valid providers: ${EXPECTED_PROVIDERS.join(", ")}`), unknown.text));

  for (const [tool, args, valid] of [
    ["start_meeting", { agent: "x", agenda: "y", mode: "Debate" }, "standard, debate"],
    ["start_local_meeting", { agent: "x", agenda: "y", mode: "waffle-house" }, "standard, debate"],
    ["start_collaboration", { agents: ["x", "y"], topic: "t", mode: "waffle_house" }, "collaborate, debate, waffle-house, conversation"],
  ]) {
    const r = await server.callTool(tool, args);
    check(`${tool} rejects unknown mode with the valid list`, () =>
      assert(r.isError && r.text.includes(`Unknown mode "${args.mode}". Valid modes: ${valid}`), r.text));
  }
  for (const [tool, args, expected] of [
    ["start_ultraplan", { agents: [], task: "Plan a launch" }, "Ultraplan requires at least 1 agent"],
    ["submit_plan", { ultraplan_id: "missing", plan: "Plan" }, "Ultraplan not found: missing. Active ultraplans: none"],
    ["end_ultraplan", { ultraplan_id: "missing" }, "Ultraplan not found: missing. Active ultraplans: none"],
    ["create_agent", { agents: ["cfo"] }, "create_agent needs a task"],
    ["create_agent", {}, "create_agent needs at least one participant"],
    ["improve_agent", { agent: "missing-agent" }, 'Agent prompt not found for "missing-agent"'],
    ["improve_agent", { agent: "cfo", include_self: false }, "improve_agent needs at least one participant"],
    ["start_collaboration", { agents: ["cfo", "skeptic"] }, 'topic is required (only mode "conversation" may omit it)'],
  ]) {
    const r = await server.callTool(tool, args);
    check(`${tool} validates ${expected} without calling a provider`, () => assert(r.isError && r.text.includes(expected), r.text));
  }
  for (const tool of NEW_START_TOOLS) {
    const badProvider = await server.callTool(tool, { provider: "grok" });
    check(`${tool} rejects provider before persona loading`, () =>
      assert(badProvider.isError && badProvider.text.includes('Unknown provider "grok"'), badProvider.text));
    const badBase = await server.callTool(tool, { provider: "openai", base_url: "http://offline.test/v1" });
    check(`${tool} rejects base_url misuse before persona loading`, () =>
      assert(badBase.isError && badBase.text.includes('base_url is only supported with provider "openai_compatible"'), badBase.text));
  }

  const baseUrlMisuse = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "openai",
    base_url: "http://127.0.0.1:9/v1",
  });
  check("base_url is rejected for providers other than openai_compatible", () =>
    assert(baseUrlMisuse.isError && /base_url is only supported with provider "openai_compatible" \(got "openai"\)/.test(baseUrlMisuse.text), baseUrlMisuse.text));

  const noBase = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "openai_compatible",
  });
  check("openai_compatible without a base URL explains what to set", () =>
    assert(noBase.isError && /OPENAI_COMPATIBLE_BASE_URL/.test(noBase.text) && /base_url/.test(noBase.text), noBase.text));

  const badRef = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "replicate",
    model: "not-a-ref",
  });
  check("replicate rejects a malformed model ref before any request", () =>
    assert(badRef.isError && /Invalid Replicate model "not-a-ref"/.test(badRef.text), badRef.text));

  const ollama = await server.callTool("chat_completion", {
    messages: [{ role: "user", content: "hi" }],
    provider: "ollama",
  });
  check("ollama provider reports unreachable host clearly", () =>
    assert(ollama.isError && /Ollama is not reachable at http:\/\/127\.0\.0\.1:9/.test(ollama.text), ollama.text));

  const debug = await server.callTool("debug_env");
  check("debug_env reports version 0.3.0", () => assert(/"version": "0\.3\.0"/.test(debug.text), debug.text.slice(0, 200)));
  check("debug_env reports integration config and active ultraplans", () => {
    const d = JSON.parse(debug.text);
    assert(d.skills_dir === smokeEnv.ROUNDTABLE_SKILLS_DIR && d.workspace_dir === root, debug.text);
    assert(d.activity_log === smokeEnv.ROUNDTABLE_ACTIVITY_LOG && d.parallel_turns === 2 && d.active_ultraplans === 0, debug.text);
  });
  check("startup banner includes skills, workspace and activity paths", () => {
    const banner = server.stderr();
    assert(banner.includes(`Skills dir: ${smokeEnv.ROUNDTABLE_SKILLS_DIR}`) && banner.includes(`Workspace dir: ${root}`), banner);
    assert(banner.includes(`Activity log: ${smokeEnv.ROUNDTABLE_ACTIVITY_LOG}`), banner);
  });
  check("debug_env does not leak key material", () =>
    assert(!/sk-[A-Za-z0-9_-]{8,}|r8_[A-Za-z0-9]{8,}/.test(debug.text), "key-like string in debug_env output"));
  check("debug_env reports a configured key as exactly \"configured\" (no prefix, no length)", () =>
    assert(!debug.text.includes("r8_test") && !debug.text.includes("r8_") && /"replicate_api_token": "configured"/.test(debug.text), debug.text.slice(0, 600)));
  check("debug_env lists together_api_key and ollama status", () =>
    assert(/together_api_key/.test(debug.text) && /"reachable": false/.test(debug.text), debug.text.slice(0, 400)));
  check("debug_env reports replicate_api_token and openai_compatible", () =>
    assert(/"replicate_api_token"/.test(debug.text) && /"openai_compatible": \{/.test(debug.text) && /"base_url"/.test(debug.text), debug.text.slice(0, 600)));
  check("debug_env default_models covers all six providers", () => {
    const parsed = JSON.parse(debug.text);
    assert(JSON.stringify(Object.keys(parsed.default_models)) === JSON.stringify(EXPECTED_PROVIDERS), JSON.stringify(parsed.default_models));
  });
  check("server writes only JSON-RPC to stdout (stdio transport is the MCP channel)", () => {
    const noise = server.noise();
    assert(noise.length === 0, `non-JSON stdout lines: ${JSON.stringify(noise)}`);
  });
  await checkDispatch();
} catch (e) {
  failures++;
  console.log(`  FAIL harness: ${e.message}`);
  console.log(server.stderr());
} finally {
  server.stop();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : "\nall offline smoke checks passed");
process.exit(failures ? 1 : 0);
