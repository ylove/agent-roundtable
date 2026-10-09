import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { frontmatterCases, guard, definition, newSkill, derivedMarker, dashVerdicts, privatePassage, quotedPrivateMetadata } from "../fixtures/review2.mjs";
import { stubFetch, json } from "./helpers.mjs";

// The required preload supplies disposable home and configured directories before imports.
const root = fs.realpathSync.native(process.env.ROUNDTABLE_WORKSPACE_DIR);
process.env.ROUNDTABLE_AGENTS_DIR = path.join(root, "project", ".claude", "agents");
delete process.env.ROUNDTABLE_PUBLISHER;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;
delete process.env.OPENAI_COMPATIBLE_API_KEY;
const agents = await import("../../dist/agents.js");
const files = await import("../../dist/agent-files.js");
const sessions = await import("../../dist/sessions/agent-creation.js");
const { parseVerdict } = await import("../../dist/sessions/workshop.js");
const config = await import("../../dist/config.js");
let seq = 0;
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const example = name => frontmatterCases.find(c => c.name === name).text;
const validated = extra => files.validateAgentSpec({ ...definition, ...extra }, { mode: "improve", existingSkills: [] });
const options = targetPath => ({ targetPath, skillsDir: config.SKILLS_DIR, createdFrom: ["reviewer"], date: "2026-10-08", timestamp: "now" });
const target = (text = example("strict")) => put(path.join(root, `case-${++seq}`, ".claude", "agents", "reviewer.md"), text);
const llm = { provider: "openai_compatible", model: "m", baseUrl: "http://llm.test/v1" };
function harness(t, { architect, review } = {}) {
  const requests = [];
  stubFetch(t, async (url, init) => {
    assert.equal(url, "http://llm.test/v1/chat/completions");
    const body = JSON.parse(init.body);
    requests.push(body);
    const prompt = body.messages.at(-1).content;
    const content = body.messages[0].content.includes(sessions.buildArchitectSystemPrompt())
      ? JSON.stringify(architect ? await architect() : { ...definition, description: "Review work" })
      : prompt.includes("Verdict: READY |") ? review ?? "Verdict: READY" : "Improve guardrails.";
    return json(200, { choices: [{ message: { content } }] });
  });
  return requests;
}

for (const fixture of frontmatterCases) {
  test(`Claude-compatible parser: ${fixture.name}`, () => {
    const parsed = agents.parseAgentFrontmatter(fixture.text);
    assert.deepEqual(parsed.data, fixture.data);
    assert.equal(parsed.hasFrontmatter, fixture.hasFrontmatter ?? true);
    assert.equal(!!parsed.parseError, !!fixture.parseError);
    assert.equal(parsed.fenceMismatch, !!fixture.fenceMismatch);
    assert.equal(agents.readFrontmatter(fixture.text).parseError, parsed.parseError);
    assert.deepEqual(agents.readFrontmatter(fixture.text).data, fixture.data);
    if (parsed.hasFrontmatter) assert.ok(parsed.blockEnd > 0);
  });
}

test("description fences are normalized before agent and skill writes", () => {
  const { spec, warnings } = validated({ skills: [newSkill] });
  assert.equal(spec.description, "Review — shell — work");
  assert.equal(spec.skills[0].description, "Release — checklist");
  assert.equal(warnings.filter(w => /---/.test(w)).length, 2);
  const p = target();
  files.writeImprovedAgent(spec, options(p));
  assert.equal(agents.parseAgentFrontmatter(fs.readFileSync(p, "utf8")).data.tools, "Read");
  assert.throws(() => files.renderAgentFile({ ...spec, description: "unsafe---value" }, options(p)), /---/);
  assert.throws(() => files.renderSkillFile(newSkill, options(p)), /---/);
  assert.throws(() => files.assertFrontmatterRoundTrip('---\nname: other\n---\n', { name: "reviewer" }), /round.trip/i);
});

for (const name of ["dormant", "embedded-fence"]) {
  test(`improve refuses ${name} before providers and in planning`, async t => {
    const p = target(example(name));
    const requests = harness(t);
    const error = name === "dormant" ? /Claude Code cannot parse.*fix the frontmatter first/s : /has '---' inside.*fix it first/s;
    await assert.rejects(sessions.improveAgent({ ...llm, agent: p }), error);
    assert.equal(requests.length, 0);
    assert.throws(() => files.planAgentFiles(validated().spec, { ...options(p), mode: "improve" }), error);
  });
}

for (const name of ["tab-hooks", "bracket-hooks"]) {
  test(`improve keeps Claude-visible hooks: ${name}`, async t => {
    const p = target(example(name));
    harness(t);
    const result = await sessions.improveAgent({ ...llm, agent: p });
    const data = agents.parseAgentFrontmatter(fs.readFileSync(result.agent.path, "utf8")).data;
    assert.deepEqual(data.hooks, guard);
    assert.equal(data.name, "reviewer");
  });
}

test("public summaries withhold descriptions derived from private instructions", () => {
  const { spec } = validated({ skills: [{ ...newSkill, description: undefined, instructions: `${derivedMarker}: account details. Check release.` }] });
  assert.equal(spec.skills[0].descriptionDerived, true);
  const summary = sessions.renderPublicSpecSummary(spec);
  assert.ok(!summary.includes(derivedMarker));
  assert.match(summary, /\(no description provided\)/);
});

test("public architecture and revision include the privacy rule only when public", () => {
  const rule = "This run is public: in changes, open_questions, contribution summaries and descriptions, refer to passages of the current definition by heading or paraphrase; never reproduce its text, and never include personal information, credentials or private details.";
  for (const publicRun of [true, false]) {
    const o = { mode: "improve", task: "Review", participants: [], existingAgents: "", existingSkills: "", contributions: [], public: publicRun };
    assert.equal(sessions.buildArchitectPrompt(o).includes(rule), publicRun);
    assert.equal(sessions.buildArchitectRevisePrompt({ ...o, spec: validated().spec, reviews: [] }).includes(rule), publicRun);
  }
});

for (const link of ["skills", ".claude"]) {
  test(`new skills fall back when project ${link} is a symlink`, async t => {
    const base = path.join(root, `links-${++seq}`);
    const outside = path.join(root, `outside-${seq}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(base, { recursive: true });
    if (link === ".claude") fs.symlinkSync(outside, path.join(base, ".claude"));
    else {
      fs.mkdirSync(path.join(base, ".claude"));
      fs.symlinkSync(outside, path.join(base, ".claude", "skills"));
    }
    const p = put(path.join(base, ".claude", "agents", "reviewer.md"), example("strict"));
    const skill = { ...newSkill, name: `linked-${seq}`, description: "Check releases" };
    harness(t, { architect: () => ({ ...definition, skills: [skill] }) });
    const r = await sessions.improveAgent({ ...llm, agent: p });
    assert.equal(r.agent.skills[0].path, fs.realpathSync.native(path.join(config.SKILLS_DIR, skill.name, "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(base, ".claude", "skills", skill.name, "SKILL.md")));
    assert.ok(r.warnings.includes(`project skills dir ${path.join(base, ".claude", "skills")} is a symlink; new skills were written to ${config.SKILLS_DIR} instead`));
    assert.equal(r.agent.path, fs.realpathSync.native(p));
  });
}

test("create search and planning reuse destination project skills with a different configured dir", async t => {
  put(path.join(config.AGENTS_DIR, "reviewer.md"), example("strict"));
  const projectSkill = put(path.join(path.dirname(config.AGENTS_DIR), "skills", "destination-skill", "SKILL.md"), "Existing project skill.");
  const skill = { ...newSkill, name: "destination-skill", description: "Existing project procedure" };
  const spec = validated({ name: "created", skills: [skill] }).spec;
  const plan = files.planAgentFiles(spec, { mode: "create", agentsDir: config.AGENTS_DIR, skillsDir: config.SKILLS_DIR, createdFrom: [], date: "today" });
  assert.equal(plan.skills[0].path, projectSkill);
  assert.equal(plan.skills[0].status, "reused");
  const requests = harness(t, { architect: () => ({ ...definition, name: "created", skills: [{ name: skill.name }] }) });
  const r = await sessions.createAgent({ ...llm, agents: ["reviewer"], task: "Review" });
  assert.equal(r.agent.skills[0].path, projectSkill);
  assert.ok(requests[0].messages.at(-1).content.includes(skill.name));
});

for (const action of ["delete", "rename"]) {
  test(`mid-run ${action} produces a proposal from captured content with mode 0600`, async t => {
    const p = target();
    fs.chmodSync(p, 0o600);
    harness(t, { architect: () => {
      if (action === "delete") fs.unlinkSync(p); else fs.renameSync(p, p + ".moved");
      return { ...definition, tools: undefined };
    } });
    const r = await sessions.improveAgent({ ...llm, agent: p });
    assert.equal(r.agent.path, null);
    assert.equal(r.backupPath, undefined);
    assert.ok(r.proposedPath.startsWith(p + ".proposed-"));
    assert.equal(fs.statSync(r.proposedPath).mode & 0o777, 0o600);
    assert.equal(agents.readFrontmatter(fs.readFileSync(r.proposedPath, "utf8")).data.tools, "Read");
    assert.match(r.next, /changed while.*proposed definition/s);
    assert.match(r.warnings.join(" "), /changed while.*proposed definition/s);
  });
}

test("changed proposals preserve mode 0600 despite umask", () => {
  const p = target();
  fs.chmodSync(p, 0o600);
  const old = fs.readFileSync(p, "utf8");
  fs.appendFileSync(p, "Edited");
  const mask = process.umask(0o777);
  try {
    const r = files.writeImprovedAgent(validated().spec, { ...options(p), originalContent: old });
    assert.equal(fs.statSync(r.proposedPath).mode & 0o777, 0o600);
  } finally { process.umask(mask); }
});

test("case variants share an improve lock on case-insensitive filesystems", async t => {
  const p = target();
  const variant = path.join(path.dirname(p), "Reviewer.md");
  if (!fs.existsSync(variant)) { t.skip("case-sensitive filesystem"); return; }
  let enter, release;
  const entered = new Promise(r => { enter = r; });
  const gate = new Promise(r => { release = r; });
  let firstArchitect = true;
  harness(t, { architect: async () => { if (firstArchitect) { firstArchitect = false; enter(); await gate; } return { ...definition }; } });
  const first = sessions.improveAgent({ ...llm, agent: p, write: false });
  await entered;
  try { await assert.rejects(sessions.improveAgent({ ...llm, agent: variant, write: false }), /already running/); }
  finally { release(); await first; }
});

for (const [text, label, choices, expected] of dashVerdicts) {
  test(`dash boundary: ${text}`, () => {
    assert.equal(parseVerdict(text, label, choices), expected);
    assert.equal(parseVerdict(text.replace(/[—–]/g, "-"), label, choices), expected);
  });
}

test("dash verdicts survive review and signoff in an offline ultraplan", async t => {
  const { startUltraplan, submitPlan } = await import("../../dist/sessions/ultraplan.js");
  const one = target();
  const two = put(path.join(path.dirname(one), "ops.md"), "You handle operations.");
  stubFetch(t, async (url, init) => {
    assert.equal(url, "http://llm.test/v1/chat/completions");
    const body = JSON.parse(init.body);
    const prompt = body.messages.at(-1).content;
    const content = prompt.includes("Sign-off: APPROVE |")
      ? body.messages[0].content.includes("operations") ? "Sign-off: OBJECT—the budget" : "Sign-off: APPROVE WITH RESERVATIONS–timeline"
      : prompt.includes("Verdict: APPROVE |") ? "Verdict: APPROVE WITH CHANGES—see amendments" : "Add a rollback step.";
    return json(200, { choices: [{ message: { content } }] });
  });
  const r = await startUltraplan([one, two], "Release", { ...llm, draftPlan: "Check then release." });
  assert.equal(r.tally["APPROVE WITH CHANGES"], 2);
  const final = await submitPlan(r.ultraplanId, undefined, true);
  assert.equal(final.tally.OBJECT, 1);
  assert.equal(final.tally["APPROVE WITH RESERVATIONS"], 1);
});

test("public summary withholds copied private passages in all metadata fields", () => {
  const spec = validated({ ...quotedPrivateMetadata, skills: [{ ...newSkill, description: privatePassage }] }).spec;
  const summary = sessions.renderPublicSpecSummary(spec, { privateTexts: [`# Treasury\n${privatePassage}\n`] });
  assert.ok(!summary.includes(privatePassage));
  assert.match(summary, /private passage withheld/);
  assert.ok(sessions.renderPublicSpecSummary(spec).includes(privatePassage));
  assert.ok(spec.changes[0].includes(privatePassage));
});
