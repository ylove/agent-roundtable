import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { json, stubFetch } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "roundtable-agent-creation-"));
const agentsDir = join(root, "agents");
const skillsDir = join(root, "skills");
const oldHome = process.env.HOME;
process.env.HOME = join(root, "home");
for (const [key, value] of Object.entries({
  AGENTS_DIR: agentsDir,
  SKILLS_DIR: skillsDir,
  WORKSPACE_DIR: root,
  ACTIVITY_LOG: join(root, "activity.jsonl"),
  TRANSCRIPTS_DIR: join(root, "transcripts")
})) {
  process.env[`ROUNDTABLE_${key}`] = value;
}
process.env.ROUNDTABLE_PUBLISHER = "ntfy";
process.env.ROUNDTABLE_NTFY_URL = "http://publisher.test";
process.env.ROUNDTABLE_PUBLISH_FLUSH_TIMEOUT_MS = "5000";
process.env.ROUNDTABLE_PARALLEL_TURNS = "4";
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
after(() => {
  if (oldHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = oldHome;
  }
  rmSync(root, { recursive: true, force: true });
});

function fixture(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}
fixture(join(agentsDir, "cfo.md"), [
  "---",
  "name: cfo-identity",
  "description: Financial planning",
  "model: sonnet",
  "tools: Read, Grep",
  "skills: [audit]",
  "color: green",
  "---",
  "You are the CFO.",
  "",
].join("\n"));
fixture(join(agentsDir, "marketing-coordinator.md"), [
  "---",
  "name: marketing-coordinator",
  "description: Marketing planning",
  "---",
  "You coordinate marketing.",
  "",
].join("\n"));
fixture(join(skillsDir, "audit", "SKILL.md"), [
  "---",
  "name: audit",
  "description: Verify numbers",
  "---",
  "Audit step: check arithmetic.",
  "",
].join("\n"));
const {
  createAgent,
  improveAgent,
  buildArchitectSystemPrompt,
  buildContributionPrompt,
  buildImproveContributionPrompt,
  buildArchitectPrompt,
  buildArchitectRevisePrompt,
  buildSpecReviewPrompt,
} = await import("../../dist/sessions/agent-creation.js");
const { readFrontmatter } = await import("../../dist/agents.js");
const { startCollaboration, collaborations, ORCHESTRATOR } = await import("../../dist/sessions/collaborations.js");
const { startMeeting, meetings } = await import("../../dist/sessions/meetings.js");
const { readActivity, recordActivity } = await import("../../dist/activity.js");
const opts = { provider: "openai_compatible", model: "m", baseUrl: "http://llm.test/v1" };
const two = ["cfo", "marketing-coordinator"];
const definition = (extra = {}) => ({
  name: "marketing-budget",
  description: "Plan marketing budgets",
  model: "sonnet",
  tools: ["Read", "Grep"],
  system_prompt: "You plan a marketing budget. Check all totals and report the allocation.",
  skills: [
    { name: "audit", instructions: "Do not overwrite audit", contributed_by: ["cfo"] },
    {
      name: "allocation",
      description: "Allocate money",
      instructions: "List costs. Allocate money. Check the totals.",
      contributed_by: two
    }
  ],
  contributions: two.map(agent => ({ agent, summary: `${agent} contributed expertise` })),
  ...extra
});

function llmReply(content) {
  return json(200, { choices: [{ message: { content } }] });
}

function harness(t, options = {}) {
  const requests = { contributions: [], architect: [], reviews: [], other: [] };
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = [];
  const calls = stubFetch(t, async (url, init) => {
    if (url.startsWith("http://publisher.test")) {
      return init.method === "POST" ? json(200, { id: "x", time: 1 }) : new Response("", { status: 200 });
    }
    assert.equal(url, "http://llm.test/v1/chat/completions", "Unexpected network destination");
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages.at(-1).content;
    assert.equal(body.model, "m");
    if (system.includes(buildArchitectSystemPrompt())) {
      requests.architect.push(body);
      const response = options.architect
        ? await options.architect(requests.architect.length, body)
        : JSON.stringify(definition(options.spec));
      return llmReply(response);
    }
    if (user.includes("Verdict: READY | NEEDS CHANGES")) {
      requests.reviews.push(body);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (options.concurrent) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Reviews did not run concurrently")), 2000);
          pending.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (pending.length === options.concurrent) {
            pending.forEach(done => done());
          }
        });
      }
      inFlight--;
      const verdict = options.review
        ? options.review(requests.reviews.length, body)
        : "Verdict: READY\nMy contribution is represented accurately.";
      return llmReply(verdict);
    }
    if (user.includes("Contribute under these headings")) {
      requests.contributions.push(body);
      const expertise = system.includes("CFO") ? "check arithmetic" : "allocate campaigns";
      return llmReply(`EXPERTISE-${requests.contributions.length}: ${expertise}`);
    }
    requests.other.push(body);
    if (options.other) {
      return options.other(body);
    }
    return llmReply("Seed discussion about the allocation.");
  });
  return { calls, requests, maxInFlight: () => maxInFlight };
}

function files() {
  return [
    readdirSync(agentsDir, { recursive: true }).sort(),
    readdirSync(skillsDir, { recursive: true }).sort()
  ];
}

test("create happy path: sequential expertise, concurrent reviews, exact calls, saved definition", async (t) => {
  const h = harness(t, { concurrent: 2 });
  const r = await createAgent({ ...opts, agents: two, task: "Allocate campaign budget" });
  assert.equal(h.calls.length, 5);
  assert.equal(h.requests.architect.length, 1);
  assert.equal(h.requests.contributions.length, 2);
  assert.equal(h.requests.reviews.length, 2);
  assert.equal(h.maxInFlight(), 2);
  const first = h.requests.contributions[0].messages.at(-1).content;
  const second = h.requests.contributions[1].messages.at(-1).content;
  assert.ok(!first.includes("EXPERTISE-1"));
  assert.ok(second.includes("EXPERTISE-1"));
  assert.ok(h.requests.contributions[0].messages[0].content.includes("Audit step"));
  assert.ok(h.requests.architect[0].messages.at(-1).content.includes("EXPERTISE-2"));
  assert.equal(r.mode, "create");
  assert.match(r.sessionId, /^create-\d+$/);
  assert.equal(dirname(r.agent.path), agentsDir);
  assert.ok(existsSync(r.agent.path));
  const parsed = readFrontmatter(readFileSync(r.agent.path, "utf8"));
  assert.equal(parsed.data.name, r.agent.name);
  assert.equal(parsed.data.description, r.agent.description);
  assert.equal(r.agent.model, "sonnet");
  assert.deepEqual(r.agent.tools, ["Read", "Grep"]);
  assert.deepEqual(r.agent.skills.map(s => s.status), ["reused", "created"]);
  assert.equal(r.contributions.length, 2);
  assert.deepEqual(r.reviews, two.map(agent => ({ agent, verdict: "READY" })));
  assert.ok(r.next.includes(`subagent_type "${r.agent.name}"`));
  assert.match(r.warnings.join(" "), /instructions ignored/);
});

test("architect retries invalid JSON once with previous assistant output and correction", async (t) => {
  const h = harness(t, {
    architect: n => n === 1 ? "Not a definition." : JSON.stringify(definition({ name: "retry-agent" }))
  });
  const r = await createAgent({ ...opts, agents: ["cfo"], task: "Check a budget" });
  assert.equal(h.calls.length, 4);
  assert.equal(r.agent.name, "retry-agent");
  const retry = h.requests.architect[1].messages;
  assert.deepEqual(retry.map(m => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(retry[2].content, "Not a definition.");
  assert.match(retry[3].content, /^Your output was not usable:/);
});

test("double architect failure throws clearly and writes nothing", async (t) => {
  const before = files();
  const h = harness(t, { architect: n => n === 1 ? "garbage" : JSON.stringify({ name: "broken" }) });
  await assert.rejects(
    createAgent({ ...opts, agents: two, task: "Check" }),
    /did not return a usable agent definition after one retry: description/,
  );
  assert.equal(h.requests.architect.length, 2);
  assert.equal(h.requests.reviews.length, 0);
  assert.deepEqual(files(), before);
});

test("a NEEDS CHANGES review invokes one architect revision and returns final fields", async (t) => {
  const h = harness(t, {
    review: n => n === 1 ? "Verdict: NEEDS CHANGES\nReplace check totals with reconcile totals." : "Verdict: READY",
    architect: n => JSON.stringify(definition({
      name: "revised-agent",
      system_prompt: n === 1 ? "Check totals." : "Reconcile totals.",
      open_questions: n === 1 ? [] : ["Confirm cap"]
    }))
  });
  const r = await createAgent({ ...opts, agents: two, task: "Reconcile" });
  assert.equal(h.calls.length, 6);
  assert.equal(h.requests.architect.length, 2);
  assert.match(h.requests.architect[1].messages.at(-1).content, /Previous JSON[\s\S]*NEEDS CHANGES/);
  assert.match(readFileSync(r.agent.path, "utf8"), /Reconcile totals/);
  assert.deepEqual(r.openQuestions, ["Confirm cap"]);
  assert.equal(r.reviews[0].verdict, "NEEDS CHANGES");
});

test("UNCLEAR review also revises and revise JSON receives the same retry policy", async (t) => {
  const h = harness(t, {
    review: () => "Looks fine.",
    architect: n => n === 2 ? "invalid revision" : JSON.stringify(definition({ name: "unclear-agent" }))
  });
  const r = await createAgent({ ...opts, agents: ["cfo"], task: "Check", write: false });
  assert.equal(r.reviews[0].verdict, "UNCLEAR");
  assert.equal(h.requests.architect.length, 3);
  assert.equal(h.requests.architect[2].messages[2].content, "invalid revision");
});

test("from_session collaboration seeds task, participants and discussion with deduplication", async (t) => {
  const h = harness(t, { spec: { name: "from-collab" } });
  const c = await startCollaboration(two, "Plan a marketing budget", { ...opts, maxRounds: 1 });
  collaborations.get(c.collaborationId).messages.push({
    agent: ORCHESTRATOR,
    content: "Keep the cap fixed.",
    timestamp: new Date(),
  });
  const r = await createAgent({
    ...opts,
    fromSession: c.collaborationId,
    agents: [join(agentsDir, "cfo.md")],
    write: false,
  });
  assert.equal(h.requests.contributions.length, 2);
  const prompt = h.requests.contributions[0].messages.at(-1).content;
  assert.match(prompt, /Design a new agent for this task:\nPlan a marketing budget/);
  assert.match(prompt, /Discussion that led here[\s\S]*Seed discussion/);
  assert.match(prompt, /\*\*orchestrator:\*\* Keep the cap fixed/);
  assert.deepEqual(r.reviews.map(r => r.agent), two);
  const activity = readActivity().find(e => e.session === r.sessionId);
  assert.equal(activity.topic, "Plan a marketing budget");
  collaborations.delete(c.collaborationId);
});

test("from_session meeting supplies a participant, agenda and caller/agent transcript", async (t) => {
  const h = harness(t, { spec: { name: "from-meeting" } });
  const m = await startMeeting(
    "cfo", "Check spending", "Private previous context", opts.provider, opts.model, opts.baseUrl,
  );
  await createAgent({ ...opts, fromSession: m.meetingId, write: false });
  const prompt = h.requests.contributions[0].messages.at(-1).content;
  assert.match(prompt, /Check spending/);
  assert.match(prompt, /\*\*caller:\*\*/);
  assert.match(prompt, /\*\*cfo:\*\*/);
  meetings.delete(m.meetingId);
});

test("validation happens before any fetch, with accepted session kinds in errors", async (t) => {
  const h = harness(t);
  await assert.rejects(createAgent({ ...opts, task: "Check" }), /create_agent needs at least one participant/);
  await assert.rejects(createAgent({ ...opts, agents: ["cfo"] }), /create_agent needs a task/);
  const missingSessionPattern = new RegExp(
    "from_session not found: collab-missing.*live collaboration \\(collab-N\\) " +
      "or meeting \\(meeting-N\\).*Active sessions:",
  );
  await assert.rejects(createAgent({ ...opts, fromSession: "collab-missing" }), missingSessionPattern);
  await assert.rejects(
    improveAgent({ ...opts, agent: "cfo", includeSelf: false }),
    /improve_agent needs at least one participant/,
  );
  await assert.rejects(
    createAgent({ ...opts, agents: ["cfo", "missing-persona"], task: "Check", public: true }),
    /Agent prompt not found/,
  );
  const txt = fixture(join(root, "not-markdown.txt"), "You check.");
  await assert.rejects(improveAgent({ ...opts, agent: txt }), /can only edit a .md agent file/);
  assert.equal(h.calls.length, 0);
});

test("improve includes self candor, activity, backup and original identity and effective tools", async (t) => {
  recordActivity({
    at: "2026-01-02T00:00:00Z",
    session: "past",
    kind: "meeting",
    mode: "standard",
    agents: two,
    topic: "Spending",
    outcome: "checked",
    public: false
  });
  const original = readFileSync(join(agentsDir, "cfo.md"), "utf8");
  const h = harness(t, {
    spec: {
      name: "renamed-by-model",
      model: undefined,
      tools: undefined,
      changes: ["Clarify arithmetic checks because totals were ambiguous"]
    }
  });
  const r = await improveAgent({ ...opts, agent: "cfo", with: ["marketing-coordinator"] });
  assert.equal(h.calls.length, 5);
  assert.equal(r.mode, "improve");
  assert.match(r.sessionId, /^improve-\d+$/);
  assert.equal(r.agent.name, "cfo-identity");
  assert.equal(r.agent.model, "sonnet");
  assert.deepEqual(r.agent.tools, ["Read", "Grep"]);
  assert.equal(readFileSync(r.backupPath, "utf8"), original);
  assert.ok(r.next.includes(r.backupPath));
  const prompts = h.requests.contributions.map(b => b.messages.at(-1).content);
  const candor = "You are the agent being improved. " +
    "Be candid about where your current instructions make you worse at your job.";
  assert.ok(prompts[0].includes(candor));
  assert.ok(!prompts[1].includes(candor));
  assert.match(prompts[0], /2026-01-02 meeting \(standard\) with marketing-coordinator on "Spending" — checked/);
  assert.match(prompts[0], /Current system prompt[\s\S]*You are the CFO/);
  const data = readFrontmatter(readFileSync(r.agent.path, "utf8")).data;
  assert.equal(data.color, "green");
  assert.equal(data.name, "cfo-identity");
  assert.deepEqual(r.changes, ["Clarify arithmetic checks because totals were ambiguous"]);
});

test("includeSelf false with another participant omits self and recent empty history is explicit", async (t) => {
  fixture(join(agentsDir, "fresh.md"), "You check fresh budgets.");
  const h = harness(t, { spec: { name: "fresh", skills: [] } });
  const r = await improveAgent({
    ...opts,
    agent: "fresh",
    with: ["marketing-coordinator"],
    includeSelf: false,
    focus: "Clarity",
    context: "Private context",
    write: false
  });
  assert.deepEqual(r.reviews.map(r => r.agent), ["marketing-coordinator"]);
  assert.match(
    h.requests.contributions[0].messages.at(-1).content,
    /Focus: Clarity[\s\S]*\(no recorded sessions\)[\s\S]*Private context/,
  );
  assert.equal(r.agent.path, null);
});

test("performTask starts a private meeting with the newly written agent prompt", async (t) => {
  const h = harness(t, { spec: { name: "delegated-agent" } });
  const r = await createAgent({
    ...opts,
    agents: ["cfo"],
    task: "Do the budget",
    context: "Delegation context",
    performTask: true
  });
  assert.ok(r.meeting.meetingId);
  assert.equal(r.meeting.response, "Seed discussion about the allocation.");
  assert.equal(h.calls.length, 4);
  assert.match(h.requests.other[0].messages[0].content, /You plan a marketing budget/);
  assert.match(h.requests.other[0].messages[0].content, /Allocate money/);
  assert.match(h.requests.other[0].messages.at(-1).content, /Do the budget[\s\S]*Delegation context/);
  assert.equal(meetings.get(r.meeting.meetingId).publicChannel, undefined);
  assert.ok(r.next.includes(`continue_meeting`));
  meetings.delete(r.meeting.meetingId);
});

test("performTask failure returns saved files and a warning", async (t) => {
  harness(t, { spec: { name: "failed-task-agent" }, other: () => json(500, { error: "task unavailable" }) });
  const r = await createAgent({ ...opts, agents: ["cfo"], task: "Check", performTask: true });
  assert.ok(existsSync(r.agent.path));
  assert.equal(r.meeting, undefined);
  assert.match(r.warnings.join(" "), /perform_task failed:.*task unavailable/);
});

test("write false previews files, writes nothing, applies name hint and skips performTask", async (t) => {
  const h = harness(t);
  const before = files();
  const r = await createAgent({
    ...opts,
    agents: ["cfo"],
    task: "Check",
    name: "Custom Finance!",
    write: false,
    performTask: true
  });
  assert.equal(r.agent.path, null);
  assert.equal(r.agent.name, "custom-finance");
  assert.ok(r.files.length >= 1);
  assert.ok(r.agent.skills.every(s => s.path === null && s.status === "preview"));
  assert.deepEqual(files(), before);
  assert.ok(r.files.every(f => !f.path.endsWith("custom-finance.md") || f.content.includes("name: custom-finance")));
  assert.match(r.warnings.join(" "), /Name hint applied/);
  assert.match(r.warnings.join(" "), /perform_task was skipped because write is false/);
  assert.equal(h.requests.other.length, 0);
  assert.match(r.next, /Nothing was written/);
});

test("rounds clamp to 1..3, keep earlier contributions across rounds and normalize NaN", async (t) => {
  const h = harness(t);
  await createAgent({ ...opts, agents: ["cfo"], task: "Check", rounds: 8, write: false });
  assert.equal(h.requests.contributions.length, 3);
  assert.match(h.requests.contributions[2].messages.at(-1).content, /Round 3 of 3[\s\S]*EXPERTISE-1[\s\S]*EXPERTISE-2/);
  for (const rounds of [NaN, -2, 1.9]) {
    const before = h.requests.contributions.length;
    await createAgent({ ...opts, agents: ["cfo"], task: "Check", rounds, write: false });
    assert.equal(h.requests.contributions.length - before, 1);
  }
});

test("public mirror orders header, contributions, reviews and summary with no private material", async (t) => {
  const h = harness(t, { concurrent: 2, spec: { name: "public-budget", skills: [] } });
  const contextMarker = "PRIVATE_CONTEXT_987";
  const r = await createAgent({
    ...opts,
    agents: two.map(n => join(agentsDir, n + ".md")),
    task: "Public budget",
    context: contextMarker,
    public: true,
    write: false
  });
  assert.ok(r.publicBlock);
  const posts = h.calls.filter(c => c.url.startsWith("http://publisher.test") && c.init.method === "POST");
  assert.equal(posts.length, 6);
  assert.match(posts[0].body.message, /agent-creation/);
  assert.match(posts[1].body.title, /cfo contribution/);
  assert.match(posts[2].body.title, /marketing-coordinator contribution/);
  assert.match(posts[3].body.title, /cfo review/);
  assert.match(posts[4].body.title, /marketing-coordinator review/);
  assert.match(posts[5].body.message, /# public-budget/);
  for (const p of posts) {
    assert.ok(!p.body.message.includes(contextMarker));
    assert.ok(!p.body.message.includes("## Existing agents"));
    assert.ok(!p.body.message.includes("## Existing skills"));
    assert.ok(!p.body.title.includes(agentsDir));
  }
  for (const call of h.calls.filter(c => c.url.startsWith("http://llm.test"))) {
    assert.match(call.body.messages[0].content, /PUBLIC SESSION NOTICE/);
    assert.ok(call.body.messages.every(m => !m.content.includes(agentsDir)));
  }
});

test("public from_session transcript uses labels but remains private to prompts", async (t) => {
  const h = harness(t, { spec: { name: "public-discussion", skills: [] } });
  const c = await startCollaboration(two.map(n => join(agentsDir, n + ".md")), "Discuss budget", { ...opts });
  collaborations.get(c.collaborationId).messages.push({
    agent: join(agentsDir, "marketing-coordinator.md"),
    content: "DISCUSSION_PRIVATE_MARKER",
    timestamp: new Date()
  });
  await createAgent({ ...opts, fromSession: c.collaborationId, public: true, write: false });
  const prompt = h.requests.contributions[0].messages.at(-1).content;
  assert.match(prompt, /\*\*marketing-coordinator:\*\* DISCUSSION_PRIVATE_MARKER/);
  assert.ok(!prompt.includes(agentsDir));
  for (const p of h.calls.filter(c => c.url.startsWith("http://publisher.test") && c.init.method === "POST")) {
    assert.ok(!p.body.message.includes("DISCUSSION_PRIVATE_MARKER"));
  }
  collaborations.delete(c.collaborationId);
});

test("activity records create, improve and preview kinds, keys, topics and outcomes", async (t) => {
  harness(t, { spec: { name: "activity-agent", skills: [], changes: ["Clear scope"] } });
  const created = await createAgent({ ...opts, agents: two, task: "Activity task" });
  const improved = await improveAgent({ ...opts, agent: "activity-agent", with: ["cfo"] });
  const preview = await createAgent({ ...opts, agents: ["cfo"], task: "Preview task", write: false });
  const refinementPreview = await improveAgent({ ...opts, agent: "activity-agent", write: false });
  const find = r => readActivity().find(e => e.session === r.sessionId);
  assert.deepEqual(find(created).agents, two);
  assert.equal(find(created).kind, "agent-creation");
  assert.equal(find(created).topic, "Activity task");
  assert.equal(find(created).outcome, "created activity-agent (no skills)");
  assert.equal(find(created).public, false);
  assert.equal(find(improved).kind, "agent-refinement");
  assert.deepEqual(find(improved).agents, ["activity-agent", "cfo"]);
  assert.equal(find(improved).topic, "improve activity-agent");
  assert.equal(find(improved).outcome, "improved activity-agent: 1 changes");
  assert.match(find(preview).outcome, /^preview: drafted .* \(no skills\)$/);
  assert.equal(find(refinementPreview).outcome, "preview: drafted activity-agent: 1 changes");
});

test("pure builders document the contract and bound the current prompt", () => {
  const common = {
    participants: two,
    existingAgents: "fleet text",
    existingSkills: "skill text",
    contributions: [],
    context: "Context text",
    discussion: "Earlier discussion"
  };
  const contribution = buildContributionPrompt({ ...common, task: "Check", round: 2, rounds: 3 });
  const createFraming = "You are one of several specialists designing a new Claude Code subagent for the task below. " +
    "An architect will turn every contribution into the final definition (system prompt, skills, tools). " +
    "Contribute from your own expertise; say plainly when something is outside it.";
  assert.ok(contribution.startsWith(createFraming));
  assert.ok(contribution.includes("## Earlier contributions"));
  for (const text of [
    "Expertise",
    "Skills",
    "Guardrails",
    "Deliverable",
    "Discussion that led here",
    "Round 2 of 3",
    "(you are the first contributor)",
    "Don't repeat"
  ]) {
    assert.ok(contribution.includes(text));
  }
  const improve = buildImproveContributionPrompt({
    ...common,
    target: "cfo",
    description: "Desc",
    systemPrompt: "x".repeat(30010),
    skills: [],
    isSelf: false
  });
  assert.ok(!improve.includes("x".repeat(30001)));
  assert.ok(improve.includes("…[truncated]"));
  const improveFraming = "You are one of several specialists improving the existing Claude Code subagent cfo. " +
    "An architect will turn every contribution into the revised definition.";
  assert.ok(improve.startsWith(improveFraming));
  assert.ok(improve.includes("## Earlier contributions"));
  const architect = buildArchitectPrompt({
    ...common,
    mode: "improve",
    task: "Check",
    identityName: "cfo-identity",
    currentDefinition: "Current",
    focus: "Scope"
  });
  assert.ok(architect.includes("## Contributions from the participants"));
  assert.ok(!architect.includes("## Earlier contributions"));
  assert.ok(!architect.includes("(you are the first contributor)"));
  assert.ok(architect.includes("- name: keep exactly: cfo-identity"));
  for (const text of [
    "name:",
    "description:",
    "model:",
    "tools:",
    "system_prompt:",
    "skills:",
    "contributions:",
    "open_questions:",
    "changes:",
    "keep the agent's identity",
    "40000",
    "20000",
    "opus|sonnet|haiku|inherit",
    "Return only the JSON object."
  ]) {
    assert.ok(architect.includes(text), text);
  }
  const revised = buildArchitectRevisePrompt({
    ...common,
    mode: "create",
    task: "Check",
    spec: definition(),
    reviews: [{ agent: "cfo", content: "NEEDS CHANGES" }]
  });
  assert.match(revised, /Address each NEEDS CHANGES point or say in open_questions why not/);
  assert.ok(revised.includes("## Contributions from the participants"));
  assert.ok(!revised.includes("## Earlier contributions"));
  assert.ok(!revised.includes("(you are the first contributor)"));
  assert.match(
    buildSpecReviewPrompt({ task: "Check", draft: "Draft", contributions: [] }),
    /Verdict: READY \| NEEDS CHANGES/,
  );
});

test("directory personas have distinct public labels and each reviewer receives its own contributions", async (t) => {
  const refs = [
    fixture(join(agentsDir, "directory-cfo", "AGENT.md"), "You are the directory CFO."),
    fixture(join(agentsDir, "directory-marketing", "AGENT.md"), "You coordinate directory marketing.")
  ];
  const h = harness(t, { spec: { name: "directory-draft", skills: [] } });
  await createAgent({ ...opts, agents: refs, task: "Check", public: true, write: false });
  const own = h.requests.reviews.map(r => r.messages.at(-1).content.split("## Your contributions in this run")[1]);
  assert.ok(own[0].includes("EXPERTISE-1"));
  assert.ok(!own[0].includes("EXPERTISE-2"));
  assert.ok(own[1].includes("EXPERTISE-2"));
  assert.ok(!own[1].includes("EXPERTISE-1"));
  const posts = h.calls.filter(call => call.url.startsWith("http://publisher.test") && call.init.method === "POST");
  assert.match(posts[1].body.title, /directory-cfo contribution/);
  assert.match(posts[2].body.title, /directory-marketing contribution/);
  assert.match(posts[3].body.title, /directory-cfo review/);
  assert.match(posts[4].body.title, /directory-marketing review/);
});

test("participant deduplication keeps the first reference, including the improve target", async (t) => {
  const first = fixture(join(agentsDir, "dedupe-first", "cfo.md"), "You are DEDUPE_FIRST_PERSONA.");
  const duplicate = fixture(join(agentsDir, "dedupe-last", "cfo.md"), "You are DEDUPE_WRONG_PERSONA.");
  const h = harness(t, { spec: { name: "dedupe", skills: [] } });
  const r = await improveAgent({ ...opts, agent: first, with: [duplicate], write: false });
  assert.equal(h.requests.contributions.length, 1);
  assert.match(h.requests.contributions[0].messages[0].content, /DEDUPE_FIRST_PERSONA/);
  assert.ok(!h.requests.contributions[0].messages[0].content.includes("DEDUPE_WRONG_PERSONA"));
  assert.deepEqual(r.reviews.map(review => review.agent), ["cfo"]);
});

test("improve fills a missing or empty architect name without spending a retry", async (t) => {
  const target = fixture(join(agentsDir, "identity-target.md"), [
    "---",
    "name: kept-identity",
    "description: Original definition",
    "---",
    "You keep this identity."
  ].join("\n"));
  const h = harness(t, { spec: { name: undefined, skills: [] } });
  const r = await improveAgent({ ...opts, agent: target, write: false });
  assert.equal(h.requests.architect.length, 1);
  assert.equal(h.calls.length, 3);
  assert.equal(r.agent.name, "kept-identity");
  const prompt = h.requests.architect[0].messages.at(-1).content;
  assert.match(prompt, /- name: keep exactly: kept-identity/);
  assert.match(prompt, /Name: kept-identity/);
  assert.deepEqual(r.warnings, []);
  for (const name of [null, "", " \t ", 7]) {
    t.mock.restoreAll();
    const next = harness(t, { spec: { name, skills: [] } });
    await improveAgent({ ...opts, agent: target, write: false });
    assert.equal(next.requests.architect.length, 1);
  }
  const unnamed = fixture(join(agentsDir, "unnamed-target.md"), "You have no frontmatter identity.");
  t.mock.restoreAll();
  const fallback = harness(t, { spec: { name: undefined, skills: [] } });
  const result = await improveAgent({ ...opts, agent: unnamed, write: false });
  assert.equal(result.agent.name, "unnamed-target");
  assert.equal(fallback.requests.architect.length, 1);
});

test("improve reports inherited YAML-list tools as an array of strings", async (t) => {
  const target = fixture(join(agentsDir, "list-tools.md"), [
    "---",
    "name: list-tools",
    "tools: [Read, Grep, 7]",
    "---",
    "You inspect budgets."
  ].join("\n"));
  harness(t, { spec: { name: "list-tools", tools: null, model: null, skills: [] } });
  const r = await improveAgent({ ...opts, agent: target, write: false });
  assert.deepEqual(r.agent.tools, ["Read", "Grep"]);
  assert.equal(r.agent.model, undefined);
  assert.deepEqual(r.warnings, []);
});

test("improve refuses unreadable frontmatter before fetch or a public channel", async (t) => {
  const { unreadableFrontmatter } = await import("../fixtures/file-layer.mjs");
  const target = fixture(join(agentsDir, "unreadable.md"), unreadableFrontmatter);
  const h = harness(t);
  await assert.rejects(improveAgent({ ...opts, agent: target, public: true }), /cannot read the frontmatter.*Quote values.*retry; nothing was written/s);
  assert.equal(h.calls.length, 0);
  assert.equal(readFileSync(target, "utf8"), unreadableFrontmatter);
});

test("improve lock rejects a concurrent preview and releases after completion", async (t) => {
  const target = fixture(join(agentsDir, "locked.md"), "Original");
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { architect: async n => {
    if (n === 1) { entered(); await gate; }
    return JSON.stringify(definition({ name: "locked", skills: [] }));
  } });
  const first = improveAgent({ ...opts, agent: target, write: false });
  await waiting;
  try {
    await assert.rejects(improveAgent({ ...opts, agent: target, write: false, public: true }), {
      message: "improve_agent is already running for locked; wait for it to finish"
    });
    assert.equal(h.calls.length, 2);
  } finally {
    release();
    await first;
  }
  await improveAgent({ ...opts, agent: target, write: false });
  assert.equal(h.requests.architect.length, 2);
});

test("failed improve releases the target lock", async (t) => {
  const target = fixture(join(agentsDir, "failed-lock.md"), "Original");
  harness(t, { architect: () => "invalid" });
  await assert.rejects(improveAgent({ ...opts, agent: target, write: false }), /after one retry/);
  t.mock.restoreAll();
  harness(t, { spec: { skills: [] } });
  await improveAgent({ ...opts, agent: target, write: false });
});

test("mid-run edits produce a proposal result and preserve workshop metadata", async (t) => {
  const target = fixture(join(agentsDir, "edited-during-run.md"), "---\nname: initial-identity\ntools: Read\n---\nOriginal");
  const edited = "---\nname: user-identity\n---\nUSER EDIT";
  harness(t, { architect: () => {
    writeFileSync(target, edited);
    return JSON.stringify(definition({ name: "initial-identity", tools: undefined, skills: [] }));
  } });
  const r = await improveAgent({ ...opts, agent: target });
  assert.equal(readFileSync(target, "utf8"), edited);
  assert.equal(r.agent.path, null);
  assert.equal(r.backupPath, undefined);
  assert.ok(r.proposedPath.startsWith(target + ".proposed-"));
  assert.equal(readFrontmatter(readFileSync(r.proposedPath, "utf8")).data.name, "initial-identity");
  assert.equal(readFrontmatter(readFileSync(r.proposedPath, "utf8")).data.tools, "Read");
  assert.equal(r.next, `${target} changed while improve_agent was running, so it was not overwritten. The proposed definition is at ${r.proposedPath} (a non-.md file, never loaded as an agent): compare it with the current file and merge by hand, or run improve_agent again.`);
  assert.equal(readActivity().find(e => e.session === r.sessionId).outcome, "proposed changes to edited-during-run (target changed during the run)");
});

test("workshops list and reuse personal skills by name without recreating them", async (t) => {
  const personal = fixture(join(process.env.HOME, ".claude", "skills", "personal-ledger", "SKILL.md"), "---\ndescription: Personal ledger procedure\n---\nPERSONAL PROCEDURE");
  const h = harness(t, { spec: { name: "personal-consumer", skills: [{ name: "personal-ledger" }] } });
  const r = await createAgent({ ...opts, agents: ["cfo"], task: "Reuse the ledger" });
  assert.match(h.requests.architect[0].messages.at(-1).content, /## Existing skills[\s\S]*- personal-ledger: Personal ledger procedure/);
  assert.match(h.requests.contributions[0].messages.at(-1).content, /- personal-ledger: Personal ledger procedure/);
  assert.deepEqual(r.agent.skills, [{ name: "personal-ledger", path: personal, status: "reused" }]);
  assert.equal(existsSync(join(skillsDir, "personal-ledger", "SKILL.md")), false);
  assert.match(readFileSync(personal, "utf8"), /PERSONAL PROCEDURE/);
});

test("improve writes new skills alongside a target in another project", async (t) => {
  const target = fixture(join(root, "other-project", ".claude", "agents", "external.md"), "---\nname: external\n---\nExternal persona");
  const existing = fixture(join(root, "other-project", ".claude", "skills", "external-existing", "SKILL.md"), "---\ndescription: External procedure\n---\nExisting procedure");
  const h = harness(t, { spec: { skills: [{ name: "external-existing" }, { name: "external-new", instructions: "Check external details." }] } });
  const r = await improveAgent({ ...opts, agent: target });
  assert.match(h.requests.architect[0].messages.at(-1).content, /external-existing: External procedure/);
  assert.equal(r.agent.skills[0].path, existing);
  assert.equal(r.agent.skills[0].status, "reused");
  assert.equal(r.agent.skills[1].path, join(root, "other-project", ".claude", "skills", "external-new", "SKILL.md"));
  assert.ok(existsSync(r.agent.skills[1].path));
  assert.equal(existsSync(join(skillsDir, "external-new", "SKILL.md")), false);
});

test("invalid tool restrictions spend the architect retry with the allowlist", async (t) => {
  const h = harness(t, { architect: n => JSON.stringify(definition({ name: "retry-tools", tools: n === 1 ? ["TodoWrite"] : "Read, Grep", skills: [] })) });
  const r = await createAgent({ ...opts, agents: ["cfo"], task: "Check", write: false });
  assert.equal(h.requests.architect.length, 2);
  assert.match(h.requests.architect[1].messages.at(-1).content, /tools must list tool names from: Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch/);
  assert.deepEqual(r.agent.tools, ["Read", "Grep"]);
});
