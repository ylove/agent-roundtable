import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

// Set every configurable directory before importing modules that read config.
const root = mkdtempSync(join(tmpdir(), "roundtable-conversation-"));
const workspace = join(root, "workspace");
const home = join(root, "home");
const agentsDir = join(root, "agents");
const activityPath = join(root, "activity.jsonl");
process.env.ROUNDTABLE_WORKSPACE_DIR = workspace;
process.env.ROUNDTABLE_AGENTS_DIR = agentsDir;
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_ACTIVITY_LOG = activityPath;
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
process.env.ROUNDTABLE_NTFY_URL = "http://ntfy.test";
process.env.ROUNDTABLE_PUBLISHER = "ntfy";
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
put(join(workspace, "README.md"), "READ-MARKER: We build a scheduling product.");
put(join(workspace, "CLAUDE.md"), "CLAUDE-MARKER: Keep offline scheduling reliable.");
put(join(workspace, "AGENTS.md"), "IGNORED-MARKER: fallback instructions.");
put(join(workspace, "package.json"), JSON.stringify({ name: "schedule-lab", description: "Scheduling for small teams" }));
put(join(agentsDir, "alpha.md"), "---\nname: Alpha Engineer\n---\nYou are Alpha, responsible for calendar sync.\n");
put(join(agentsDir, "beta.md"), "You are Beta, responsible for product design.\n");
put(join(workspace, ".claude", "agent-memory", "alpha", "MEMORY.md"), "MEMORY-MARKER: Calendar sync needs clearer retries.");
put(join(workspace, ".claude", "agent-memory-local", "beta", "MEMORY.md"), "BETA-MARKER: Exploring the calendar layout.");
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], {
  encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-git-config"),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" },
  stdio: ["ignore", "pipe", "pipe"],
});
git("init", "--initial-branch=conversation-fixture");
for (let n = 0; n < 13; n++) git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", `Project step ${n}`);

const modes = await import("../../dist/sessions/modes.js");
const grounding = await import("../../dist/sessions/grounding.js");
const sessions = await import("../../dist/sessions/collaborations.js");
const { loadAgent } = await import("../../dist/agents.js");
const { readActivity } = await import("../../dist/activity.js");
const { publicLabel } = await import("../../dist/publishers/index.js");
const opts = { mode: "conversation", provider: "openai_compatible", model: "test", baseUrl: "http://llm.test/v1" };
const alpha = join(agentsDir, "alpha.md");
const beta = join(agentsDir, "beta.md");
const system = (call) => call.body.messages[0].content;
const user = (call) => call.body.messages[1].content;
const llmCalls = (calls) => calls.filter((call) => call.url.startsWith(opts.baseUrl));
const stub = (t) => stubFetch(t, (url, init) => {
  if (url.startsWith(opts.baseUrl)) return json(200, { choices: [{ message: { content: "A short colleague response." } }] });
  assert.ok(url.startsWith("http://ntfy.test"), `Unexpected request: ${url}`);
  return init.method === "POST" ? json(200, { id: "test", time: 1 }) : new Response("");
});
const activity = (overrides = {}) => ({ at: "2026-10-01T12:00:00Z", session: "previous-session", kind: "collaboration",
  mode: "debate", agents: ["alpha", "beta"], topic: "sync retries", outcome: "ACTIVITY-MARKER: Clarify retry states", public: false, ...overrides });
beforeEach(() => {
  sessions.collaborations.clear();
  sessions.setCollaborationRecordHook(undefined);
  writeFileSync(activityPath, JSON.stringify(activity()) + "\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("conversation prompt helpers", () => {
  test("mode order and truthfulness directive", () => {
    assert.deepEqual(modes.COLLABORATION_MODES, ["collaborate", "debate", "waffle-house", "conversation"]);
    modes.assertCollaborationMode("conversation");
    const text = modes.buildConversationDirective();
    for (const part of ["## Conversation mode", "no agenda or deliverable", "TRUTHFULNESS", "persona", '"Your context"',
      "don't know", "guesses as guesses", "Never invent past events, metrics or decisions", "2-6 sentences", "No headings", "no bullet lists", "no summaries", "unless asked"]) {
      assert.ok(text.includes(part), part);
    }
  });

  test("deterministic weighted angles with and without sources", () => {
    const cases = [
      [{ activity: true, memory: false, workspace: true }, 9, ["recent-work", "recent-work", "recent-work", "product", "product", "founder", "open-problem", "open-problem", "cross-team"]],
      [{ activity: false, memory: true, workspace: false }, 8, ["recent-work", "recent-work", "recent-work", "product", "founder", "open-problem", "open-problem", "cross-team"]],
      [{ activity: false, memory: false, workspace: false }, 5, ["product", "founder", "open-problem", "open-problem", "cross-team"]],
      [{ activity: false, memory: false, workspace: true }, 6, ["product", "product", "founder", "open-problem", "open-problem", "cross-team"]],
    ];
    for (const [available, total, expected] of cases) {
      expected.forEach((angle, i) => assert.equal(modes.pickOpeningAngle(available, " ", () => (i + 0.5) / total), angle));
    }
    assert.equal(modes.pickOpeningAngle({}, " a theme ", () => { throw new Error("random must not be used"); }), "theme");
  });

  test("opening angles, turn prompt and summary", () => {
    const phrases = {
      "recent-work": "something you worked on recently", product: "something about the product you're building",
      founder: "something about the founder or the person you work for", "open-problem": "an open problem in your area",
      "cross-team": "something another participant's area is doing", theme: "your honest take on the theme",
    };
    for (const [angle, phrase] of Object.entries(phrases)) {
      const prompt = modes.buildConversationOpeningPrompt(angle, ["Alpha", "Beta"], "reliability");
      assert.ok(prompt.startsWith("You're starting a conversation with: Alpha, Beta."));
      assert.ok(prompt.includes(phrase));
      assert.equal(prompt.includes("Loose theme:"), angle === "theme");
    }
    assert.ok(modes.buildConversationOpeningPrompt("theme", [], "reliability").includes("It's a starting point, not an agenda."));
    assert.match(modes.buildConversationTurnPrompt(), /move to a new thread.*2-6 sentences/);
    const summary = modes.buildConversationSummaryPrompt();
    for (const phrase of ["short recap", "Threads that came up", "who raised them", "whoever you report to"]) assert.ok(summary.includes(phrase));
    assert.ok(!summary.includes("loose theme"));
    assert.match(modes.buildConversationSummaryPrompt("reliability"), /loose theme: reliability/);
  });
});

describe("private grounding", () => {
  test("snapshot reads package, instructions, README, branch and last twelve subjects", () => {
    const text = grounding.workspaceSnapshot(workspace);
    for (const part of ["schedule-lab", "Scheduling for small teams", "CLAUDE-MARKER", "READ-MARKER", "conversation-fixture", "Project step 12", "Project step 1"]) assert.ok(text.includes(part), part);
    assert.ok(!text.includes("Project step 0 ("));
    assert.match(text, /Project step 12 \(.+ ago\)/);
    assert.ok(!text.includes("IGNORED-MARKER"));
    put(join(workspace, "README.md"), "Changed after snapshot");
    assert.equal(grounding.workspaceSnapshot(workspace), text, "cached within sixty seconds");
  });

  test("missing parts are omitted; AGENTS fallback and excerpt caps", () => {
    const dir = join(root, "fallback-project");
    put(join(dir, "package.json"), "invalid JSON");
    put(join(dir, "AGENTS.md"), "FALLBACK" + "a".repeat(3000) + "OUTSIDE-INSTRUCTIONS-CAP");
    put(join(dir, "README.md"), "README" + "b".repeat(3000) + "OUTSIDE-README-CAP");
    const text = grounding.workspaceSnapshot(dir);
    assert.ok(text.includes("FALLBACK"));
    assert.ok(!text.includes("OUTSIDE-"));
    assert.ok(!text.includes("Recent commits"));
    assert.equal(grounding.workspaceSnapshot(join(root, "missing")), undefined);
  });

  test("cache expires after sixty seconds", (t) => {
    const dir = join(root, "expiry");
    put(join(dir, "README.md"), "before expiry");
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    assert.ok(grounding.workspaceSnapshot(dir).includes("before expiry"));
    put(join(dir, "README.md"), "after expiry");
    t.mock.method(Date, "now", () => now + 60_001);
    assert.ok(grounding.workspaceSnapshot(dir).includes("after expiry"));
  });

  test("memory tries canonical key, name and slug across all three scopes", () => {
    const dir = join(root, "memory-scopes");
    put(join(dir, ".claude", "agent-memory", "Alpha Engineer", "MEMORY.md"), "EXACT-NAME");
    put(join(dir, ".claude", "agent-memory-local", "alpha-engineer", "MEMORY.md"), "SLUG-NAME");
    put(join(home, ".claude", "agent-memory", "alpha", "MEMORY.md"), "HOME-NAME");
    const text = grounding.agentMemory("alpha", "Alpha Engineer", { workspaceDir: dir, homeDir: home });
    for (const marker of ["EXACT-NAME", "SLUG-NAME", "HOME-NAME"]) assert.ok(text.includes(marker));
    assert.equal(grounding.agentMemory("missing", undefined, { workspaceDir: dir, homeDir: home }), undefined);
    assert.equal(grounding.agentMemory("../../outside", "../outside", { workspaceDir: dir, homeDir: home }), undefined);
    put(join(dir, ".claude", "agent-memory", "same", "MEMORY.md"), "ONCE");
    assert.equal(grounding.agentMemory("same", "same", { workspaceDir: dir, homeDir: home }), "ONCE");
  });

  test("memory caps each excerpt at 200 lines and 3000 characters", () => {
    const dir = join(root, "memory-caps");
    const path = join(dir, ".claude", "agent-memory", "cap", "MEMORY.md");
    put(path, Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"));
    const text = grounding.agentMemory("cap", undefined, { workspaceDir: dir, homeDir: home });
    assert.ok(text.includes("line 199"));
    assert.ok(!text.includes("line 200"));
    put(path, "x".repeat(4000));
    assert.equal(grounding.agentMemory("cap", undefined, { workspaceDir: dir, homeDir: home }).length, 3000);
    put(path, "\n".repeat(200) + "BEYOND-FIRST-200-LINES");
    assert.equal(grounding.agentMemory("cap", undefined, { workspaceDir: dir, homeDir: home }), undefined);
  });

  test("activity uses the five most recent sessions and excludes self from colleagues", () => {
    const path = join(root, "history.jsonl");
    put(path, Array.from({ length: 7 }, (_, i) => JSON.stringify(activity({ topic: `topic-${i}` }))).join("\n") + "\ninvalid\n");
    const text = grounding.recentActivityText("alpha", { activityPath: path });
    assert.equal(text.split("\n").length, 5);
    assert.ok(text.startsWith('- 2026-10-01 collaboration (debate) with beta on "topic-6" — ACTIVITY-MARKER'));
    assert.ok(!text.includes("topic-1"));
    assert.equal(grounding.recentActivityText("missing", { activityPath: path }), undefined);
    assert.equal(grounding.recentActivityText("alpha", { activityPath: null }), undefined);
    put(path, JSON.stringify(activity({ mode: undefined, outcome: undefined })));
    assert.equal(grounding.recentActivityText("alpha", { activityPath: path }), '- 2026-10-01 collaboration with beta on "sync retries"');
  });

  test("packet assembles sources and intro, with empty and oversized inputs", async () => {
    const loaded = await loadAgent(alpha);
    const packet = await grounding.buildGrounding(loaded, { workspaceDir: workspace, homeDir: home, activityPath });
    assert.deepEqual(packet.sources, ["workspace", "memory", "activity"]);
    for (const part of ["## Your context", "background you already know", "don't dump or quote", "### The project you work on", "### Your notes (agent memory)", "### Your recent roundtable sessions"]) assert.ok(packet.text.includes(part));
    assert.deepEqual(await grounding.buildGrounding({ key: "missing" }, { workspaceDir: join(root, "empty"), homeDir: join(root, "empty-home"), activityPath: null }), { text: "", sources: [] });
    const dir = join(root, "oversized");
    put(join(dir, "README.md"), "r".repeat(5000));
    put(join(dir, "CLAUDE.md"), "c".repeat(5000));
    put(join(dir, ".claude", "agent-memory", "alpha", "MEMORY.md"), "m".repeat(5000));
    const capped = await grounding.buildGrounding({ key: "alpha" }, { workspaceDir: dir, homeDir: home, activityPath });
    assert.ok(capped.text.length <= 8000);
    assert.ok(capped.sources.includes("workspace"));
    assert.ok(capped.sources.includes("memory"));
  });
});

describe("conversation sessions", () => {
  test("other modes reject every empty topic before loading agents or calling LLM", async (t) => {
    const calls = stub(t);
    for (const mode of ["collaborate", "debate", "waffle-house"]) {
      for (const topic of [undefined, "", " \n "]) {
        await assert.rejects(sessions.startCollaboration(["missing-one", "missing-two"], topic, { ...opts, mode }),
          { message: 'topic is required (only mode "conversation" may omit it)' });
      }
    }
    assert.equal(calls.length, 0);
    assert.equal(sessions.collaborations.size, 0);
  });

  test("conversation accepts omitted, empty and whitespace topics", async (t) => {
    stub(t);
    for (const topic of [undefined, "", " \n "]) {
      const started = await sessions.startCollaboration([alpha, beta], topic, opts);
      const session = sessions.collaborations.get(started.collaborationId);
      assert.equal(session.topic, "");
      const row = sessions.listCollaborations().find((c) => c.id === started.collaborationId);
      assert.equal(row.topic, "(open conversation)");
      assert.equal(row.mode, "conversation");
      assert.ok(row.conversationAngle);
      assert.deepEqual(row.grounding, ["workspace", "memory", "activity"]);
      await sessions.endCollaboration(started.collaborationId);
    }
  });

  test("every agent receives directive, own grounding, informal turns and requested recap", async (t) => {
    const calls = stub(t);
    const seen = [];
    sessions.setCollaborationRecordHook((_c, m) => seen.push(m.agent));
    const started = await sessions.startCollaboration([alpha, beta], "reliability", { ...opts, context: "PRIVATE-BACKGROUND", maxRounds: 2 });
    await sessions.nudgeCollaboration(started.collaborationId, "Tell me more about retries");
    await sessions.continueCollaboration(started.collaborationId, 2);
    const row = sessions.listCollaborations().find((c) => c.id === started.collaborationId);
    assert.equal(row.status, "completed");
    assert.equal(row.currentRound, 2);
    assert.equal(row.conversationAngle, "theme");
    assert.deepEqual(seen, [alpha, "ORCHESTRATOR", beta, alpha, beta]);
    const ended = await sessions.endCollaboration(started.collaborationId, true);
    assert.equal(ended.transcript.length, 5);
    const llm = llmCalls(calls);
    assert.equal(llm.length, 5);
    for (const call of llm) {
      assert.ok(system(call).includes("## Conversation mode"));
      assert.ok(system(call).includes("TRUTHFULNESS"));
      assert.ok(system(call).includes("## Your context"));
      assert.ok(system(call).includes("CLAUDE-MARKER"));
    }
    assert.ok(system(llm[0]).includes("MEMORY-MARKER"));
    assert.ok(system(llm[0]).includes("ACTIVITY-MARKER"));
    assert.ok(system(llm[1]).includes("BETA-MARKER"));
    assert.ok(!system(llm[1]).includes("MEMORY-MARKER"));
    assert.ok(user(llm[0]).includes("Loose theme: reliability"));
    assert.ok(user(llm[0]).includes("PRIVATE-BACKGROUND"));
    for (const call of llm.slice(1, -1)) {
      const prompt = user(call);
      for (const part of ["You are in an informal conversation.", "Participants:", "Loose theme: reliability", "PRIVATE-BACKGROUND", "Conversation so far:", "Tell me more about retries", "---", modes.buildConversationTurnPrompt()]) assert.ok(prompt.includes(part), part);
      assert.ok(!prompt.includes("actionable conclusions"));
    }
    assert.ok(user(llm.at(-1)).startsWith(modes.buildConversationSummaryPrompt("reliability")));
    const entry = readActivity(activityPath).at(-1);
    assert.equal(entry.mode, "conversation");
    assert.deepEqual(entry.agents, ["alpha", "beta"]);
  });

  test("opening angle uses only the first agent's sources; grounding false bypasses context", async (t) => {
    const calls = stub(t);
    const gamma = join(agentsDir, "gamma.md");
    put(gamma, "You are Gamma.");
    // Workspace contributes weight 2, while only the second agent has memory and activity.
    t.mock.method(Math, "random", () => 0);
    const started = await sessions.startCollaboration([gamma, alpha], undefined, opts);
    assert.equal(sessions.collaborations.get(started.collaborationId).conversationAngle, "product");
    assert.ok(user(llmCalls(calls)[0]).includes("something about the product"));
    await sessions.endCollaboration(started.collaborationId);
    const disabled = await sessions.startCollaboration([alpha, beta], undefined, { ...opts, grounding: false });
    const session = sessions.collaborations.get(disabled.collaborationId);
    assert.deepEqual(session.groundingSources, []);
    for (const agent of session.agents) {
      assert.ok(!agent.systemPrompt.includes("## Your context"));
      assert.ok(!agent.systemPrompt.includes("MARKER"));
      assert.ok(agent.systemPrompt.includes("TRUTHFULNESS"));
    }
    await sessions.continueCollaboration(disabled.collaborationId, 1);
    await sessions.endCollaboration(disabled.collaborationId, true);
    for (const call of llmCalls(calls).slice(1)) assert.ok(!system(call).includes("## Your context"));
  });

  test("public conversation skips grounding, sanitizes labels and never publishes background", async (t) => {
    const calls = stub(t);
    const started = await sessions.startCollaboration([alpha, beta], undefined, { ...opts, public: true, context: "PRIVATE-BACKGROUND", maxRounds: 1 });
    const session = sessions.collaborations.get(started.collaborationId);
    assert.deepEqual(session.groundingSources, []);
    await sessions.continueCollaboration(started.collaborationId, 1);
    await sessions.nudgeCollaboration(started.collaborationId, "public nudge");
    const ended = await sessions.endCollaboration(started.collaborationId, true);
    for (const call of llmCalls(calls)) {
      assert.ok(system(call).includes("PUBLIC SESSION NOTICE"));
      assert.ok(system(call).includes("## Conversation mode"));
      assert.ok(!system(call).includes("## Your context"));
      assert.ok(!system(call).includes("MARKER"));
      for (const message of call.body.messages) assert.ok(!message.content.includes(agentsDir));
    }
    assert.ok(user(llmCalls(calls)[0]).includes(publicLabel(alpha)));
    const posts = calls.filter((call) => call.url.startsWith("http://ntfy.test") && call.init.method === "POST");
    assert.ok(posts.length >= 5);
    assert.ok(JSON.stringify(posts[0].body).includes("(open conversation)"));
    for (const post of posts) {
      const text = JSON.stringify(post.body);
      for (const privateText of [agentsDir, "PRIVATE-BACKGROUND", "MARKER", "## Conversation mode", "## Your context"]) assert.ok(!text.includes(privateText), privateText);
    }
    assert.ok(ended.publicBlock.includes("Public transcript:"));
    const saved = /Saved: (.+?) ·/.exec(ended.publicBlock)[1];
    const transcript = readFileSync(saved, "utf-8");
    assert.ok(!transcript.includes("PRIVATE-BACKGROUND"));
    assert.ok(!transcript.includes("MARKER"));
  });
});
