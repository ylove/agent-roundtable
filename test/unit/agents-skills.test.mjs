import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { json, stubFetch } from "./helpers.mjs";

const root = mkdtempSync(join(tmpdir(), "roundtable-agents-skills-"));
const agentsDir = join(root, ".claude", "agents");
const skillsDir = join(root, ".claude", "skills");
const fakeHome = join(root, "home");
const previousHome = process.env.HOME;
process.env.HOME = fakeHome;
process.env.ROUNDTABLE_AGENTS_DIR = agentsDir;
process.env.ROUNDTABLE_SKILLS_DIR = skillsDir;
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
delete process.env.OPENAI_COMPATIBLE_API_KEY;
process.env.ROUNDTABLE_PUBLISHER = "ntfy";
process.env.ROUNDTABLE_NTFY_URL = "http://publisher.test";
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function fixture(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const plainText = "Plain persona.\r\nNo metadata.\r\n";
fixture(join(agentsDir, "plain.md"), plainText);
fixture(join(agentsDir, "subagent-reviewer.md"), '---\nname: Reviewer\ndescription: "Checks: quality"\n---\nReviewer body.\n');
fixture(join(agentsDir, "designer", "AGENT.md"), '---\nname: Designer\nskills:\n  - drafting\n---\nDesign body.\n');
fixture(join(agentsDir, "deep", "nested", "AGENT.md"), "Do not discover me.");
fixture(join(agentsDir, "ignored.txt"), "Ignore me.");
fixture(join(skillsDir, "drafting", "SKILL.md"), '---\nname: Different Display Name\ndescription: "Draft: clear prose"\n---\nDrafting instructions.\n');
fixture(join(skillsDir, "checking", "SKILL.md"), "Checking instructions.");
fixture(join(skillsDir, "deep", "nested", "SKILL.md"), "Do not discover me.");
fixture(join(fakeHome, ".claude", "skills", "fallback", "SKILL.md"), "Fallback instructions.");
fixture(join(fakeHome, ".claude", "skills", "drafting", "SKILL.md"), "Personal drafting instructions.");

const agents = await import("../../dist/agents.js");
const local = await import("../../dist/sessions/local-meetings.js");
const { readActivity } = await import("../../dist/activity.js");

test("config derives workspace, skills, activity, parallel turns, and version", () => {
  function config(env = {}) {
    const childEnv = { ...process.env, ...env };
    for (const name of ["ROUNDTABLE_SKILLS_DIR", "ROUNDTABLE_WORKSPACE_DIR", "ROUNDTABLE_ACTIVITY_LOG", "ROUNDTABLE_PARALLEL_TURNS"]) {
      if (!(name in env)) delete childEnv[name];
    }
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", 'const c = await import("./dist/config.js"); process.stdout.write(JSON.stringify(c));'], {
      cwd: process.cwd(), env: childEnv, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  const defaults = config();
  assert.equal(defaults.VERSION, "0.3.0");
  assert.equal(defaults.SKILLS_DIR, skillsDir);
  assert.equal(defaults.WORKSPACE_DIR, root);
  assert.equal(defaults.ACTIVITY_LOG_PATH, join(fakeHome, ".agent-roundtable", "activity.jsonl"));
  assert.equal(defaults.ACTIVITY_LOG_MAX_ENTRIES, 500);
  assert.equal(defaults.PARALLEL_TURNS, 4);
  assert.equal(config({ ROUNDTABLE_AGENTS_DIR: join(root, "custom") }).WORKSPACE_DIR, process.cwd());
  assert.equal(config({ ROUNDTABLE_AGENTS_DIR: ".claude/agents" }).WORKSPACE_DIR, process.cwd());
  assert.equal(config({ ROUNDTABLE_AGENTS_DIR: "" }).SKILLS_DIR, ".claude/skills");
  const overridden = config({ ROUNDTABLE_SKILLS_DIR: "custom-skills", ROUNDTABLE_WORKSPACE_DIR: "custom-workspace", ROUNDTABLE_ACTIVITY_LOG: "custom.jsonl" });
  assert.equal(overridden.SKILLS_DIR, "custom-skills");
  assert.equal(overridden.WORKSPACE_DIR, "custom-workspace");
  assert.equal(overridden.ACTIVITY_LOG_PATH, "custom.jsonl");
  for (const value of ["off", "OFF", "false", "False", "0", "no", "NO"]) {
    assert.equal(config({ ROUNDTABLE_ACTIVITY_LOG: value }).ACTIVITY_LOG_PATH, null);
  }
  assert.equal(config({ ROUNDTABLE_ACTIVITY_LOG: "" }).ACTIVITY_LOG_PATH, defaults.ACTIVITY_LOG_PATH);
  for (const [value, expected] of [["8", 8], ["0", 4], ["-3", 1], ["bad", 4], ["2.5", 2]]) {
    assert.equal(config({ ROUNDTABLE_PARALLEL_TURNS: value }).PARALLEL_TURNS, expected);
  }
});

test("agentKey canonicalizes names, paths, prefixes, and directory-style agents", () => {
  for (const [ref, key] of [
    ["Reviewer", "reviewer"], ["subagent-Reviewer.md", "reviewer"],
    ["/project/private/subagent-Reviewer.MD", "reviewer"],
    ["/project/private/Designer/AGENT.md", "designer"],
    ["C:\\private\\Designer\\AGENT.md", "designer"],
    ["./subagent-Designer/AGENT.md", "designer"], ["name/", "name"],
  ]) {
    assert.equal(agents.agentKey(ref), key);
    assert.ok(!/[\\/]/.test(agents.agentKey(ref)));
  }
});

test("readFrontmatter uses Claude-compatible metadata and keeps persona body extraction", () => {
  const parsed = agents.readFrontmatter('\ufeff---\r\nname: "A: B"\r\nskills: [drafting, checking]\r\n---\r\n\r\nBody\r\n');
  assert.deepEqual(parsed.data, { name: "A: B", skills: ["drafting", "checking"] });
  assert.equal(parsed.body, "Body\n");
  assert.equal(parsed.hasFrontmatter, true);
  const unclosed = agents.readFrontmatter('---\nname: "unclosed\n---\nBody');
  assert.deepEqual(unclosed.data, {});
  assert.equal(unclosed.body, "Body");
  assert.equal(unclosed.hasFrontmatter, true);
  assert.ok(unclosed.parseError);
  for (const text of ["Plain\r\n", "---\nA horizontal rule\n---\nBody", "---\nfirst section: prose\n---\nBody", "---\nname: x\nBody", "---\n---\nBody"]) {
    assert.equal(agents.readFrontmatter(text).body, text);
    assert.equal(agents.stripFrontmatter(text), text);
  }
});

test("loadSkills prefers personal skills, falls back to project skills, warns once, and skips plugins", async (t) => {
  const warnings = [];
  t.mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  const loaded = await agents.loadSkills(["drafting", "fallback", "missing", "plugin:skill"]);
  assert.deepEqual(loaded.map((s) => s.name), ["drafting", "fallback"]);
  assert.equal(loaded[0].description, undefined);
  assert.equal(loaded[0].body, "Personal drafting instructions.");
  assert.equal(loaded[0].path, join(fakeHome, ".claude", "skills", "drafting", "SKILL.md"));
  assert.equal(loaded[1].path, join(fakeHome, ".claude", "skills", "fallback", "SKILL.md"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing.*not found/);
  assert.equal((await agents.loadSkills(["checking"], skillsDir))[0].body, "Checking instructions.");
});

test("renderSkillsSection includes metadata and applies per-skill and total caps with notes", () => {
  assert.equal(agents.renderSkillsSection([]), "");
  const basic = agents.renderSkillsSection([{ name: "drafting", description: "Description", path: "unused", body: "Instructions" }]);
  assert.equal(basic, "\n\n## Skills\n\n### Skill: drafting\n\nDescription\n\nInstructions");
  const large = { name: "large", description: "Description", path: "unused", body: "x".repeat(20_000) };
  const one = agents.renderSkillsSection([large]);
  assert.equal(one.slice(one.indexOf("### Skill:")).length, 12_000);
  assert.ok(one.endsWith("…[truncated]"));
  const many = agents.renderSkillsSection(Array.from({ length: 5 }, (_, index) => ({ ...large, name: `large-${index}` })));
  assert.equal(many.length, 40_000);
  assert.ok(many.endsWith("…[truncated]"));
  assert.ok(!many.includes("large-4"));
});

test("loadAgent and prompt APIs inline string, comma-string, and list skills without changing plain agents", async () => {
  assert.equal(await agents.loadAgentPrompt("plain"), plainText);
  assert.deepEqual(await agents.loadAgentPromptWithPath("plain"), { path: join(agentsDir, "plain.md"), content: plainText });
  assert.equal(await agents.loadAgentPrompt("reviewer"), "Reviewer body.\n");
  for (const [name, metadata, expected] of [["single", "drafting", ["drafting"]], ["comma", '"drafting, checking"', ["drafting", "checking"]], ["list", "\n  - drafting\n  - checking", ["drafting", "checking"]]]) {
    const path = fixture(join(agentsDir, `${name}.md`), `---\nskills: ${metadata}\n---\nPersona.\n`);
    const loaded = await agents.loadAgent(name);
    assert.equal(loaded.ref, name);
    assert.equal(loaded.key, name);
    assert.equal(loaded.path, path);
    assert.equal(loaded.raw, readFileSync(path, "utf8"));
    assert.equal(loaded.body, "Persona.\n");
    assert.deepEqual(loaded.skills.map((s) => s.name), expected);
    assert.equal(await agents.loadAgentPrompt(name), loaded.body + agents.renderSkillsSection(loaded.skills));
  }
  const directoryAgent = await agents.loadAgent("designer");
  assert.equal(directoryAgent.key, "designer");
  assert.equal(directoryAgent.path, join(agentsDir, "designer", "AGENT.md"));
  await assert.rejects(agents.loadAgent("absent"), /Agent prompt not found.*absent/);
});

test("listAgents and listSkills scan only the contracted depth and extract YAML metadata", () => {
  const listedAgents = agents.listAgents();
  assert.ok(listedAgents.some((a) => a.key === "plain" && a.name === undefined));
  assert.deepEqual(listedAgents.find((a) => a.key === "reviewer"), { key: "reviewer", name: "Reviewer", description: "Checks: quality", path: join(agentsDir, "subagent-reviewer.md") });
  assert.ok(listedAgents.some((a) => a.key === "designer"));
  assert.ok(!listedAgents.some((a) => a.key === "nested" || a.key === "ignored"));
  assert.deepEqual(agents.listSkills(skillsDir), [
    { name: "checking", path: join(skillsDir, "checking", "SKILL.md") },
    { name: "drafting", description: "Draft: clear prose", path: join(skillsDir, "drafting", "SKILL.md") },
  ]);
  assert.deepEqual(agents.listAgents(join(root, "missing")), []);
  assert.deepEqual(agents.listSkills(join(root, "missing")), []);
});

test("local meetings append skills on every CLI call with debate/public directives, and omit the flag without skills", async (t) => {
  const bin = join(root, "bin");
  const log = join(root, "cli-argv.jsonl");
  const script = fixture(join(bin, "claude"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("local reply");\n`);
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  stubFetch(t, (_url, init) => init.method === "POST" ? json(200, { id: "post" }) : new Response("", { status: 200 }));
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);

  const standard = await local.startLocalMeeting("designer", "agenda", "private-context");
  await local.continueLocalMeeting(standard.meetingId, "more");
  await local.endLocalMeeting(standard.meetingId, true);
  for (const argv of calls()) {
    assert.equal(argv[1], join(agentsDir, "designer", "AGENT.md"));
    const section = argv[argv.indexOf("--append-system-prompt") + 1];
    assert.ok(section.startsWith("## Skills"));
    assert.match(section, /Personal drafting instructions/);
    assert.ok(!section.includes("skills:"));
  }
  assert.equal(readActivity().find((e) => e.session === standard.meetingId).outcome, "local reply");
  assert.equal(readActivity().find((e) => e.session === standard.meetingId).topic, "agenda");

  const debate = await local.startLocalMeeting("designer", "public-agenda", undefined, "debate", "quality", true);
  const argv = calls().at(-1);
  const appended = argv[argv.indexOf("--append-system-prompt") + 1];
  assert.match(appended, /## Skills/);
  assert.match(appended, /Debate role: challenger/);
  assert.match(appended, /PUBLIC SESSION NOTICE/);
  await local.endLocalMeeting(debate.meetingId);
  assert.equal(readActivity().find((e) => e.session === debate.meetingId).public, true);

  const plain = await local.startLocalMeeting("plain", "plain-agenda");
  assert.ok(!calls().at(-1).includes("--append-system-prompt"));
  await local.endLocalMeeting(plain.meetingId);
  assert.equal(readActivity().find((e) => e.session === plain.meetingId).kind, "local-meeting");
});

test("Claude-compatible frontmatter recovers generator metadata and remains visible to loaders", async () => {
  const { generatorFrontmatter, unreadableFrontmatter } = await import("../fixtures/file-layer.mjs");
  const parsed = agents.readFrontmatter(generatorFrontmatter);
  assert.deepEqual(parsed.data, {
    name: "code-reviewer",
    description: "Use this agent when: the user asks. Examples: <example>Context: x</example>",
    tools: "Read, Grep", model: "opus", permissionMode: "plan", color: "red", skills: "ledger"
  });
  assert.equal(parsed.parseError, undefined);
  const typed = agents.readFrontmatter(generatorFrontmatter.replace("color: red", "background: true\ncount: 12\nratio: 1.5\nempty: null"));
  assert.equal(typed.data.background, true);
  assert.equal(typed.data.count, 12);
  assert.equal(typed.data.ratio, 1.5);
  assert.equal(typed.data.empty, null);
  const unreadable = agents.readFrontmatter(unreadableFrontmatter);
  assert.deepEqual(unreadable.data, {});
  assert.ok(unreadable.parseError);
  fixture(join(skillsDir, "ledger", "SKILL.md"), "Ledger instructions.");
  const p = fixture(join(agentsDir, "generator.md"), generatorFrontmatter);
  assert.equal((await agents.loadAgent(p)).skills[0].name, "ledger");
  assert.equal(agents.listAgents().find(a => a.path === p).name, "code-reviewer");
});

test("broken nested YAML stays dormant rather than falling back to top-level keys", async () => {
  const { frontmatterCases } = await import("../fixtures/review2.mjs");
  const dormant = frontmatterCases.find(fixture => fixture.name === "dormant");
  const parsed = agents.readFrontmatter(dormant.text);
  assert.deepEqual(parsed.data, dormant.data);
  assert.ok(parsed.parseError);
});

test("skill search uses personal, target project, then configured directories, deduplicated", async () => {
  const homeSkills = join(fakeHome, ".claude", "skills");
  const target = join(root, "other", ".claude", "agents", "reviewer.md");
  const sibling = join(root, "other", ".claude", "skills");
  assert.equal(agents.projectSkillsDir(target), sibling);
  assert.equal(agents.projectSkillsDir(join(root, "agents", "reviewer.md")), undefined);
  assert.equal(agents.projectSkillsDir(join(root, ".claude", "agents", "reviewer", "AGENT.md")), undefined);
  assert.deepEqual(agents.skillSearchDirs(target), [homeSkills, sibling, skillsDir]);
  assert.deepEqual(agents.skillSearchDirs(join(agentsDir, "reviewer.md")), [homeSkills, skillsDir]);
  assert.deepEqual(agents.skillSearchDirs(join(homeSkills, "..", "agents", "reviewer.md")), [homeSkills, skillsDir]);
  fixture(join(sibling, "checking", "SKILL.md"), "Other project instructions.");
  const loaded = await agents.loadSkills(["drafting", "checking"], agents.skillSearchDirs(target));
  assert.equal(loaded[0].path, join(homeSkills, "drafting", "SKILL.md"));
  assert.equal(loaded[1].path, join(sibling, "checking", "SKILL.md"));
  const listed = agents.listSkills(agents.skillSearchDirs(target));
  assert.equal(listed.filter(s => s.name === "drafting").length, 1);
  assert.equal(listed.find(s => s.name === "drafting").path, loaded[0].path);
  assert.equal(listed.find(s => s.name === "checking").path, loaded[1].path);
  fixture(target, "---\nskills: checking\n---\nBody");
  assert.equal((await agents.loadAgent(target)).skills[0].body, "Other project instructions.");
  assert.deepEqual(await agents.loadSkills(["fallback"], skillsDir), []);
});

test("retry preserves the literal quotes and comment in a recovered scalar", () => {
  const parsed = agents.readFrontmatter('---\nname: "bad\\q" # identity\nbroken: [unclosed\n---\nBody');
  assert.deepEqual(parsed.data, { name: '"bad\\q" # identity', broken: "[unclosed" });
  assert.equal(parsed.parseError, undefined);
});
