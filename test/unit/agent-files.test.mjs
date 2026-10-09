import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";

const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "roundtable-agent-files-")));
const oldHome = process.env.HOME;
process.env.HOME = join(root, "home");
for (const [key, value] of Object.entries({
  AGENTS_DIR: "agents",
  SKILLS_DIR: "skills",
  WORKSPACE_DIR: "workspace",
  ACTIVITY_LOG: "activity.jsonl",
  TRANSCRIPTS_DIR: "transcripts"
})) {
  process.env[`ROUNDTABLE_${key}`] = join(root, value);
}
after(() => {
  if (oldHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = oldHome;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
const f = await import("../../dist/agent-files.js");
const { readFrontmatter } = await import("../../dist/agents.js");
const raw = (extra = {}) => ({
  name: "budget",
  description: "Plans budgets.",
  system_prompt: "You plan budgets.",
  skills: [],
  contributions: [],
  ...extra
});
const validate = (extra = {}, ctx = {}) =>
  f.validateAgentSpec(raw(extra), { mode: "create", existingSkills: [], ...ctx });
const spec = (extra = {}) => validate(extra).spec;
const skill = (name, extra = {}) => ({
  name,
  description: "Check budgets.",
  instructions: "Check each number. Then report.",
  contributed_by: ["cfo"],
  ...extra
});
const date = "2026-10-08";
let seq = 0;

function dirs() {
  const base = join(root, `case-${++seq}`);
  return { agentsDir: join(base, "agents"), skillsDir: join(base, "skills"), createdFrom: ["cfo"], date };
}

function fixture(p, text) {
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function listing(base) {
  return fs.existsSync(base) ? fs.readdirSync(base, { recursive: true }).sort() : [];
}

test("slugify normalizes punctuation, marks, dashes, colons and maximum length", () => {
  for (const [input, expected] of [
    ["Hello World", "hello-world"],
    ["Café: Déjà Vu!", "cafe-deja-vu"],
    ["--- A__B ---", "a-b"],
    [":", ""],
    ["Straße", "stra-e"]
  ]) {
    assert.equal(f.slugify(input), expected);
  }
  assert.equal(f.slugify("abc-def", 4), "abc");
  assert.equal(f.slugify("a".repeat(80)).length, 64);
  assert.equal(f.slugify("name", 0), "");
});

test("validation rejects non-objects and missing required strings", () => {
  for (const input of [null, [], "x", new Date(), 1]) {
    assert.throws(() => f.validateAgentSpec(input, { mode: "create", existingSkills: [] }), /plain object/);
  }
  for (const field of ["name", "description", "system_prompt"]) {
    for (const value of [undefined, " ", 12]) {
      assert.throws(() => validate({ [field]: value }), new RegExp(field));
    }
  }
  assert.throws(() => validate({ name: ":---" }), /name/);
});

test("name is a bounded slug and warns when normalized", () => {
  const r = validate({ name: " -Café: Finance- " });
  assert.equal(r.spec.name, "cafe-finance");
  assert.match(r.warnings.join(" "), /normalized/);
  assert.equal(validate({ name: "a".repeat(100) }).spec.name.length, 64);
});

test("description collapses whitespace and truncates with warning", () => {
  assert.equal(validate({ description: " a\n\t b " }).spec.description, "a b");
  const r = validate({ description: "a".repeat(1001) });
  assert.equal(r.spec.description.length, 1000);
  assert.match(r.warnings.join(" "), /description truncated/);
});

test("model canonicalization accepts all choices and drops invalid types", () => {
  for (const model of f.MODEL_CHOICES) {
    assert.equal(validate({ model: ` ${model.toUpperCase()} ` }).spec.model, model);
  }
  for (const model of ["unknown", 1]) {
    const r = validate({ model });
    assert.ok(!("model" in r.spec));
    assert.match(r.warnings.join(" "), /model dropped/);
  }
  for (const model of [null, "", " \t "]) {
    const r = validate({ model });
    assert.ok(!("model" in r.spec));
    assert.deepEqual(r.warnings, ["tools omitted: the agent inherits all tools"]);
  }
});

test("tools accept arrays and comma strings, canonicalize, dedupe and drop unknowns", () => {
  const r = validate({ tools: ["read", "READ", "grep", "Teleport", 5] });
  assert.deepEqual(r.spec.tools, ["Read", "Grep"]);
  assert.match(r.warnings.join(" "), /Teleport, 5/);
  assert.deepEqual(validate({ tools: " bash, websearch, WebFetch " }).spec.tools, ["Bash", "WebSearch", "WebFetch"]);
  assert.deepEqual(validate({ tools: f.TOOL_ALLOWLIST }).spec.tools, [...f.TOOL_ALLOWLIST]);
  for (const tools of [[], "", null]) {
    assert.ok(!("tools" in validate({ tools }).spec));
  }
  assert.throws(() => validate({ tools: ["unknown"] }), /tools must list tool names from/);
  for (const tools of [null, "", " \t ", ",, ,"]) {
    const r = validate({ tools });
    assert.ok(!("tools" in r.spec));
    assert.deepEqual(r.warnings, ["tools omitted: the agent inherits all tools"]);
  }
  const commaTools = validate({ tools: "Read,,Grep, ," });
  assert.deepEqual(commaTools.spec.tools, ["Read", "Grep"]);
  assert.deepEqual(commaTools.warnings, []);
});

test("system prompt is trimmed and capped", () => {
  assert.equal(validate({ system_prompt: " hi \n" }).spec.system_prompt, "hi");
  const r = validate({ system_prompt: "x".repeat(40001) });
  assert.equal(r.spec.system_prompt.length, 40000);
  assert.match(r.warnings.join(" "), /system_prompt truncated/);
});

test("skills reject invalid containers and entries and normalize names", () => {
  assert.deepEqual(validate({ skills: "bad" }).spec.skills, []);
  assert.match(validate({ skills: "bad" }).warnings.join(" "), /array/);
  const r = validate({ skills: [null, "x", skill(":"), skill(" Café Steps ")] });
  assert.equal(r.spec.skills[0].name, "cafe-steps");
  assert.ok(r.warnings.length >= 3);
});

test("reserved skill names receive the skill suffix", () => {
  const r = validate({ skills: f.RESERVED_SKILL_NAMES.map(n => skill(n)) });
  assert.deepEqual(r.spec.skills.map(s => s.name), ["synced-skill", "anthropic-skills-skill"]);
  assert.equal(r.warnings.length, 3);
});

test("duplicate skills merge the first non-empty text and contributor union", () => {
  const r = validate({
    skills: [
      skill("check", { description: "", instructions: "", contributed_by: [" cfo ", "", 3] }),
      skill("CHECK", { contributed_by: ["cfo", "reviewer"] }),
      skill("check", { description: "later", instructions: "later" })
    ]
  });
  assert.equal(r.spec.skills.length, 1);
  assert.equal(r.spec.skills[0].description, "Check budgets.");
  assert.equal(r.spec.skills[0].instructions, "Check each number. Then report.");
  assert.deepEqual(r.spec.skills[0].contributed_by, ["cfo", "reviewer"]);
  assert.match(r.warnings.join(" "), /Duplicate/);
});

test("existing skills reuse exact spelling and ignore instructions", () => {
  const r = validate({ skills: [skill("checking", { description: "" })] }, { existingSkills: ["Checking"] });
  assert.equal(r.spec.skills[0].name, "Checking");
  assert.equal(r.spec.skills[0].description, "");
  assert.equal(r.spec.skills[0].instructions, undefined);
  assert.match(r.warnings.join(" "), /instructions ignored; existing skills are never overwritten/);
  assert.deepEqual(validate({ skills: [{ name: "checking" }] }, { existingSkills: ["checking"] }).warnings, ["tools omitted: the agent inherits all tools"]);
});

test("existing skill names are resolved before slugification without conflating names", () => {
  const r = validate({ skills: [
    { name: "budget_check" },
    skill("budget-check"),
    skill("Budget_Check"),
    { name: "audit.v2" },
    { name: "synced" },
    skill("New Procedure"),
  ] }, { existingSkills: ["budget_check", "budget-check", "audit.v2", "synced"] });
  assert.deepEqual(r.spec.skills.map(s => s.name), ["budget_check", "budget-check", "audit.v2", "synced", "new-procedure"]);
  assert.ok(r.spec.skills.slice(0, 4).every(s => s.instructions === undefined));
  assert.match(r.warnings.join(" "), /Duplicate skill "budget_check" merged/);
  const exact = validate({ skills: [{ name: "Budget_Check" }] }, { existingSkills: ["budget_check", "Budget_Check"] });
  assert.equal(exact.spec.skills[0].name, "Budget_Check");
  const o = dirs();
  const original = fixture(join(o.skillsDir, "budget_check", "SKILL.md"), "Existing budget procedure");
  const attached = validate({ skills: [skill("budget_check")] }, { existingSkills: ["budget_check"] }).spec;
  const saved = f.writeNewAgent(attached, o);
  assert.equal(saved.skills[0].status, "reused");
  assert.deepEqual(readFrontmatter(fs.readFileSync(saved.agentPath, "utf8")).data.skills, ["budget_check"]);
  assert.equal(fs.readFileSync(original, "utf8"), "Existing budget procedure");
  assert.equal(fs.existsSync(join(o.skillsDir, "budget-check")), false);
});

test("previews and saves reuse shared symlinked skills without writing to the library", () => {
  const o = dirs();
  const shared = join(root, "shared-library", "shared-audit");
  const original = fixture(join(shared, "SKILL.md"), "Shared audit procedure");
  fs.mkdirSync(o.skillsDir, { recursive: true });
  fs.symlinkSync(shared, join(o.skillsDir, "shared-audit"));
  const s = spec({ skills: [skill("shared-audit")] });
  const preview = f.previewFiles(s, { ...o, mode: "create" });
  assert.equal(preview.length, 1);
  assert.equal(fs.existsSync(o.agentsDir), false);
  const saved = f.writeNewAgent(s, o);
  assert.equal(saved.skills[0].status, "reused");
  assert.equal(saved.skills[0].path, fs.realpathSync.native(original));
  const improve = { ...o, mode: "improve", targetPath: saved.agentPath, timestamp: "shared", originalContent: fs.readFileSync(saved.agentPath, "utf8") };
  assert.equal(f.previewFiles(s, improve).length, 1);
  assert.equal(f.writeImprovedAgent(s, improve).skills[0].status, "reused");
  const reused = { ...s, skills: [{ name: "shared-audit", description: "", contributed_by: [] }] };
  assert.equal(f.previewFiles(reused, { ...o, mode: "create" }).length, 1);
  assert.equal(fs.readFileSync(original, "utf8"), "Shared audit procedure");
  assert.deepEqual(fs.readdirSync(shared), ["SKILL.md"]);
});

test("new skills need instructions, cap text and derive missing descriptions", () => {
  const dropped = validate({ skills: [skill("check", { instructions: " " })] });
  assert.equal(dropped.spec.skills.length, 0);
  assert.match(dropped.warnings.join(" "), /non-empty instructions/);
  const r = validate({
    skills: [
      skill("check", { description: "", instructions: "First step. Second step." }),
      skill("long", { description: "d".repeat(1001), instructions: "x".repeat(20001) })
    ]
  });
  assert.equal(r.spec.skills[0].description, "First step.");
  assert.equal(r.spec.skills[1].description.length, 1000);
  assert.equal(r.spec.skills[1].instructions.length, 20000);
  assert.match(r.warnings.join(" "), /derived/);
  assert.equal(validate({ skills: [skill("check", { description: " a\n b " })] }).spec.skills[0].description, "a b");
});

test("only six processed skills remain, with a warning naming extras", () => {
  const r = validate({ skills: Array.from({ length: 8 }, (_, i) => skill(`skill-${i}`)) });
  assert.equal(r.spec.skills.length, 6);
  assert.match(r.warnings.join(" "), /skill-6, skill-7/);
});

test("contributions require strings, collapse summaries and cap both fields", () => {
  const r = validate({
    contributions: [
      null,
      { agent: "", summary: "x" },
      { agent: "cfo", summary: 1 },
      { agent: " cfo ", summary: " a\n b " },
      { agent: "x".repeat(101), summary: "y".repeat(501) }
    ]
  });
  assert.deepEqual(r.spec.contributions[0], { agent: "cfo", summary: "a b" });
  assert.equal(r.spec.contributions[1].agent.length, 100);
  assert.equal(r.spec.contributions[1].summary.length, 500);
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(validate().spec.contributions, []);
});

test("open questions and improve changes filter and cap; create ignores changes", () => {
  const extra = {
    open_questions: [null, "", ...Array.from({ length: 12 }, (_, i) => ` q${i} `)],
    changes: Array.from({ length: 35 }, (_, i) => ` change${i} `)
  };
  const r = validate(extra, { mode: "improve" });
  assert.equal(r.spec.open_questions.length, 10);
  assert.equal(r.spec.open_questions[0], "q0");
  assert.equal(r.spec.changes.length, 30);
  assert.ok(!("changes" in validate(extra).spec));
  assert.ok(!("open_questions" in validate({ open_questions: [" "] }).spec));
  assert.ok(!("changes" in validate({ changes: [] }, { mode: "improve" }).spec));
});

test("unmanaged model keys never enter a new spec or rendered frontmatter", () => {
  const forbidden = {
    permissionMode: "bypassPermissions",
    hooks: {},
    mcpServers: {},
    memory: "project",
    isolation: "worktree",
    background: true,
    color: "red",
    surprise: 1
  };
  const s = validate(forbidden).spec;
  const rendered = readFrontmatter(f.renderAgentFile(s, { createdFrom: [], date }));
  for (const key of Object.keys(forbidden)) {
    assert.ok(!(key in s));
    assert.ok(!(key in rendered.data));
  }
});

test("agent and skill YAML safely round-trip hostile descriptions", () => {
  const hostile = `---\nvalue: # both 'single' and "double"\npermissionMode: bypassPermissions\n---`;
  const s = spec({
    description: hostile,
    model: "opus",
    tools: ["Read"],
    skills: [skill("check", { description: hostile })]
  });
  const a = readFrontmatter(f.renderAgentFile(s, { createdFrom: ["cfo-->", "reviewer"], date }));
  assert.equal(a.data.description, hostile.replace(/\s+/g, " ").trim().replace(/-{3,}/g, "—"));
  assert.deepEqual(Object.keys(a.data), ["name", "description", "model", "tools", "skills"]);
  assert.ok(a.body.startsWith(s.system_prompt));
  assert.ok(!a.body.includes("cfo-->"));
  const k = readFrontmatter(f.renderSkillFile(s.skills[0], { date }));
  assert.equal(k.data.description, a.data.description);
  assert.deepEqual(Object.keys(k.data), ["name", "description"]);
  assert.match(k.body, /^# Check/);
});

test("rendering removes old creation comments, sanitizes credits, and labels reused skills", () => {
  const s = validate({
    system_prompt: "You plan.\n<!-- Created by agent-roundtable create_agent old -->\nKeep this.",
    skills: [skill("check"), { name: "existing", description: "Existing", contributed_by: [] }],
    open_questions: ["Why?"],
    contributions: [{ agent: "cfo", summary: "math" }]
  }, { existingSkills: ["existing"] }).spec;
  assert.equal((f.renderAgentFile(s, { createdFrom: [], date }).match(/<!-- Created by/g) ?? []).length, 1);
  assert.match(f.renderSkillFile({ ...s.skills[0], contributed_by: [] }, { date }), /contributed by: \(unknown\)/);
  const markdown = f.renderSpecMarkdown({ ...s, changes: ["Clearer instructions"] });
  for (const text of [
    "inherit (not set)",
    "all tools (inherited)",
    "check (new)",
    "existing (existing skill, reused)",
    "## Open questions",
    "## Changes"
  ]) {
    assert.ok(markdown.includes(text));
  }
  assert.equal(f.formatBackupTimestamp(new Date("2026-01-02T03:04:05Z")), "20260102-030405");
});

test("prefix detection counts only regular markdown files, with strict majority", () => {
  const o = dirs();
  assert.equal(f.detectAgentFilePrefix(o.agentsDir), "");
  fs.mkdirSync(o.agentsDir, { recursive: true });
  assert.equal(f.detectAgentFilePrefix(o.agentsDir), "");
  fixture(join(o.agentsDir, "subagent-a.md"), "A");
  fixture(join(o.agentsDir, "SUBAGENT-b.MD"), "B");
  fixture(join(o.agentsDir, "c.md"), "C");
  fs.mkdirSync(join(o.agentsDir, "subagent-fake.md"));
  fixture(join(o.agentsDir, "ignored.txt"), "x");
  assert.equal(f.detectAgentFilePrefix(o.agentsDir), "subagent-");
  fixture(join(o.agentsDir, "d.md"), "D");
  assert.equal(f.detectAgentFilePrefix(o.agentsDir), "");
});

test("collisions by filename, directory and frontmatter identity suffix both name and file", () => {
  for (const filename of ["cfo.md", "subagent-cfo.md", "cfo/AGENT.md", "x.md"]) {
    const o = dirs();
    fixture(join(o.agentsDir, filename), "---\nname: cfo\n---\nOriginal");
    const r = f.writeNewAgent(spec({ name: "cfo" }), o);
    assert.equal(r.agentName, "cfo-2");
    assert.equal(readFrontmatter(fs.readFileSync(r.agentPath, "utf8")).data.name, "cfo-2");
    assert.equal(relative(o.agentsDir, r.agentPath), filename === "subagent-cfo.md" ? "subagent-cfo-2.md" : "cfo-2.md");
    assert.match(r.warnings.join(" "), /already exists/);
  }
  const o = dirs();
  const name = "a".repeat(64);
  fixture(join(o.agentsDir, name + ".md"), "x");
  fixture(join(o.agentsDir, name.slice(0, 62) + "-2.md"), "x");
  assert.equal(f.writeNewAgent(spec({ name }), o).agentName, name.slice(0, 62) + "-3");
});

test("exclusive creation reuses an existing skill and handles skill and agent races", (t) => {
  const o = dirs();
  const s = spec({ skills: [skill("check")] });
  const p = fixture(join(o.skillsDir, "check", "SKILL.md"), "Original skill");
  const r = f.writeNewAgent(s, o);
  assert.equal(r.skills[0].status, "reused");
  assert.equal(fs.readFileSync(p, "utf8"), "Original skill");
  const race = dirs();
  const originalWrite = fs.writeFileSync;
  let agentRace = true;
  let skillRace = true;
  t.mock.method(fs, "writeFileSync", function (p, text, options) {
    if (options?.flag === "wx" && (String(p).endsWith("SKILL.md") ? skillRace : agentRace)) {
      if (String(p).endsWith("SKILL.md")) {
        skillRace = false;
      } else {
        agentRace = false;
      }
      originalWrite(p, "Racing file");
    }
    return originalWrite(p, text, options);
  });
  const raced = f.writeNewAgent(spec({ skills: [skill("check"), skill("created-here")] }), race);
  assert.equal(raced.agentName, "budget-2");
  assert.equal(raced.skills[0].status, "reused");
  assert.equal(raced.skills[1].status, "created");
  assert.ok(!raced.warnings.some(warning => warning.includes('Skill "created-here" already exists; reused')));
  assert.equal(fs.readFileSync(join(race.agentsDir, "budget.md"), "utf8"), "Racing file");
  assert.equal(fs.readFileSync(join(race.skillsDir, "check", "SKILL.md"), "utf8"), "Racing file");
});

test("improve backs up exact bytes, preserves identity and unmanaged keys, and unions skills", () => {
  const o = dirs();
  const original = [
    "---",
    "name: original-identity",
    "description: old",
    "model: sonnet",
    "tools: Read, Grep",
    "skills: old, check",
    "permissionMode: plan",
    "color: red",
    "memory: project",
    "hooks: {Stop: []}",
    "---",
    "Original bytes.",
    "",
  ].join("\n");
  const targetPath = fixture(join(o.agentsDir, "budget.md"), original);
  const opts = {
    targetPath,
    skillsDir: o.skillsDir,
    createdFrom: o.createdFrom,
    date,
    timestamp: "20261008-120000"
  };
  const r = f.writeImprovedAgent(spec({ name: "different", skills: [skill("check"), skill("new")] }), opts);
  assert.equal(r.backupPath, targetPath + ".bak-20261008-120000");
  assert.equal(fs.readFileSync(r.backupPath, "utf8"), original);
  const data = readFrontmatter(fs.readFileSync(targetPath, "utf8")).data;
  assert.equal(data.name, "original-identity");
  assert.equal(r.agentName, data.name);
  assert.equal(data.model, "sonnet");
  assert.equal(data.tools, "Read, Grep");
  assert.deepEqual(data.skills, ["old", "check", "new"]);
  for (const key of ["permissionMode", "color", "memory", "hooks"]) {
    assert.deepEqual(data[key], readFrontmatter(original).data[key]);
  }
  const secondBytes = fs.readFileSync(targetPath, "utf8");
  const second = f.writeImprovedAgent(spec({ model: "haiku", tools: ["Bash"] }), opts);
  assert.equal(second.backupPath, r.backupPath + "-2");
  assert.equal(fs.readFileSync(second.backupPath, "utf8"), secondBytes);
  const replaced = readFrontmatter(fs.readFileSync(targetPath, "utf8")).data;
  assert.equal(replaced.model, "haiku");
  assert.equal(replaced.tools, "Bash");
  assert.deepEqual(replaced.skills, data.skills);
});

test("improve validates target and timestamp; identity falls back to agentKey", () => {
  const o = dirs();
  const opts = {
    mode: "improve",
    targetPath: join(o.agentsDir, "missing.md"),
    skillsDir: o.skillsDir,
    createdFrom: [],
    date,
    timestamp: "ok"
  };
  assert.throws(() => f.planAgentFiles(spec(), opts), /existing .md/);
  fixture(opts.targetPath.replace(".md", ".txt"), "x");
  assert.throws(
    () => f.planAgentFiles(spec(), { ...opts, targetPath: opts.targetPath.replace(".md", ".txt") }),
    /existing .md/,
  );
  fixture(opts.targetPath, "Plain");
  assert.throws(() => f.planAgentFiles(spec(), { ...opts, timestamp: "../escape" }), /timestamp/);
  assert.equal(f.planAgentFiles(spec(), opts).agentName, "missing");
});

test("creation warns about directories Claude Code did not watch at startup", () => {
  const r = f.writeNewAgent(spec({ skills: [skill("check")] }), dirs());
  assert.match(r.warnings.join(" "), /agent directories.*restart/);
  assert.match(r.warnings.join(" "), /skill directories.*restart/);
});

test("preview and plan write nothing and match subsequent creation and improvement", () => {
  const o = dirs();
  const s = spec({ skills: [skill("check")] });
  const before = listing(root);
  const opts = { ...o, mode: "create" };
  const preview = f.previewFiles(s, opts);
  const plan = f.planAgentFiles(s, opts);
  assert.deepEqual(listing(root), before);
  assert.deepEqual(preview, plan.files.map(({ path, content }) => ({ path, content })));
  assert.deepEqual(plan.files.map(f => f.kind), ["skill", "agent"]);
  const written = f.writeNewAgent(s, o);
  assert.equal(written.agentPath, plan.agentPath);
  for (const file of preview) {
    assert.equal(fs.readFileSync(file.path, "utf8"), file.content);
  }
  const improvement = {
    mode: "improve",
    targetPath: written.agentPath,
    skillsDir: o.skillsDir,
    createdFrom: [],
    date,
    timestamp: "preview"
  };
  const listingBefore = listing(root);
  const previewImprovement = f.previewFiles(spec(), improvement);
  const improvementPlan = f.planAgentFiles(spec(), improvement);
  assert.deepEqual(listing(root), listingBefore);
  assert.ok(!fs.existsSync(improvementPlan.backupPath));
  const changed = f.writeImprovedAgent(spec(), improvement);
  assert.equal(changed.backupPath, improvementPlan.backupPath);
  for (const file of previewImprovement) {
    assert.equal(fs.readFileSync(file.path, "utf8"), file.content);
  }
});

test("path safety rejects traversal and links escaping a base directory", () => {
  const o = dirs();
  assert.throws(() => f.planAgentFiles({ ...spec(), name: "../../escape" }, { ...o, mode: "create" }), /Unsafe/);
  assert.throws(
    () => f.planAgentFiles({ ...spec(), skills: [skill("../../escape")] }, { ...o, mode: "create" }),
    /Unsafe/,
  );
  fs.mkdirSync(o.skillsDir, { recursive: true });
  const outside = join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(o.skillsDir, "check"));
  assert.throws(() => f.writeNewAgent(spec({ skills: [skill("check")] }), o), /Unsafe/);
  assert.deepEqual(listing(outside), []);
});

test("improve refuses a symbolic link and tells the caller to pass the real file", () => {
  const o = dirs();
  const realFile = fixture(join(root, "real-agent.md"), "Original agent bytes.");
  const link = join(o.agentsDir, "linked-agent.md");
  fs.mkdirSync(o.agentsDir, { recursive: true });
  fs.symlinkSync(realFile, link);
  const realPath = fs.realpathSync(realFile);
  const before = listing(root);
  const opts = {
    targetPath: link,
    skillsDir: o.skillsDir,
    createdFrom: [],
    date,
    timestamp: "20261008-120000"
  };
  assert.throws(() => f.writeImprovedAgent(spec(), opts), {
    message: `improve_agent will not edit ${link}: it is a symbolic link to ${realPath}. ` +
      `Pass the real file instead (agent: "${realPath}").`
  });
  assert.equal(fs.readFileSync(realFile, "utf8"), "Original agent bytes.");
  assert.deepEqual(listing(root), before);
});

test("Claude-compatible improve preserves visible keys and collisions see the identity", async () => {
  const { generatorFrontmatter, unreadableFrontmatter } = await import("../fixtures/file-layer.mjs");
  const o = dirs();
  const targetPath = fixture(join(o.agentsDir, "old-filename.md"), generatorFrontmatter);
  const options = { ...o, mode: "improve", targetPath, timestamp: "now" };
  const plan = f.planAgentFiles(spec(), options);
  assert.deepEqual(plan.warnings, []);
  const r = f.writeImprovedAgent(spec(), options);
  assert.equal(r.agentName, "code-reviewer");
  assert.deepEqual(r.warnings, []);
  const data = readFrontmatter(fs.readFileSync(targetPath, "utf8")).data;
  assert.equal(data.name, "code-reviewer");
  for (const key of ["tools", "permissionMode", "color", "model"]) {
    assert.equal(data[key], readFrontmatter(generatorFrontmatter).data[key]);
  }
  assert.deepEqual(data.skills, ["ledger"]);
  // Restore the generator file so the collision test exercises recovery too.
  fs.writeFileSync(targetPath, generatorFrontmatter);
  assert.equal(f.writeNewAgent(spec({ name: "code-reviewer" }), o).agentName, "code-reviewer-2");
  fs.writeFileSync(targetPath, unreadableFrontmatter);
  assert.throws(() => f.planAgentFiles(spec(), options), /Claude Code cannot parse the frontmatter.*fix the frontmatter first/s);
  assert.throws(() => f.previewFiles(spec(), options), /Claude Code cannot parse the frontmatter/);
  assert.throws(() => f.writeImprovedAgent(spec(), options), /Claude Code cannot parse the frontmatter/);
  assert.equal(fs.readFileSync(targetPath, "utf8"), unreadableFrontmatter);
});

test("tools fail closed on malformed or entirely unknown restrictions", () => {
  for (const tools of ["Read Grep", "Read; Grep", ["TodoWrite"], ["mcp__x"], [5], 5, {}]) {
    assert.throws(() => validate({ tools }), /tools must list tool names from: Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch.*got:/);
  }
  for (const tools of [undefined, [], null, "", " \t "]) {
    const created = validate({ tools });
    assert.equal(created.spec.tools, undefined);
    assert.ok(created.warnings.includes("tools omitted: the agent inherits all tools"));
    assert.deepEqual(validate({ tools }, { mode: "improve" }).warnings, []);
  }
  const o = dirs();
  const targetPath = fixture(join(o.agentsDir, "inherit.md"), "Body");
  const options = { ...o, mode: "improve", targetPath, timestamp: "now" };
  assert.ok(f.planAgentFiles(spec(), options).warnings.includes("tools omitted: the agent inherits all tools"));
  fs.writeFileSync(targetPath, "---\ntools: Read\n---\nBody");
  assert.ok(!f.planAgentFiles(spec(), options).warnings.includes("tools omitted: the agent inherits all tools"));
});

test("concurrent edits preserve the original and save an exclusive proposal plus skills", () => {
  const o = dirs();
  const originalContent = "---\nname: original-identity\ntools: Read\ncolor: red\n---\nOriginal";
  const targetPath = fixture(join(o.agentsDir, "target.md"), originalContent);
  const edited = "---\nname: edited-identity\n---\nUser edit";
  fs.writeFileSync(targetPath, edited);
  const options = { ...o, targetPath, timestamp: "now", originalContent };
  fixture(targetPath + ".proposed-now", "Previous proposal");
  const r = f.writeImprovedAgent(spec({ system_prompt: "Proposed body", skills: [skill("preserved-work")] }), options);
  assert.equal(fs.readFileSync(targetPath, "utf8"), edited);
  assert.equal(r.proposedPath, targetPath + ".proposed-now-2");
  assert.equal(r.backupPath, undefined);
  assert.ok(!listing(o.agentsDir).some(p => p.includes(".bak-")));
  const proposed = readFrontmatter(fs.readFileSync(r.proposedPath, "utf8"));
  assert.equal(proposed.data.name, "original-identity");
  assert.equal(proposed.data.tools, "Read");
  assert.equal(proposed.data.color, "red");
  assert.match(proposed.body, /Proposed body/);
  assert.ok(r.warnings.includes(`${targetPath} changed while improve_agent was running, so it was not overwritten; the proposed definition is at ${r.proposedPath}`));
  assert.ok(fs.existsSync(r.skills[0].path));
  assert.equal(fs.readFileSync(targetPath + ".proposed-now", "utf8"), "Previous proposal");
});

test("atomic improve flushes its temp file and preserves mode", (t) => {
  const o = dirs();
  const targetPath = fixture(join(o.agentsDir, "mode.md"), "Original bytes");
  fs.chmodSync(targetPath, 0o640);
  let flushed = false;
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", fd => { flushed = true; return sync(fd); });
  const r = f.writeImprovedAgent(spec(), { ...o, targetPath, timestamp: "now" });
  assert.equal(flushed, true);
  assert.equal(fs.statSync(targetPath).mode & 0o7777, 0o640);
  assert.equal(fs.readFileSync(r.backupPath, "utf8"), "Original bytes");
  assert.ok(!listing(o.agentsDir).some(p => p.includes(".tmp-")));
});

test("rename failure leaves original byte-identical and removes temp file", (t) => {
  const o = dirs();
  const original = "---\nname: kept\n---\nOriginal bytes\n";
  const targetPath = fixture(join(o.agentsDir, "safe.md"), original);
  t.mock.method(fs, "renameSync", () => { throw new Error("Simulated rename failure"); });
  assert.throws(() => f.writeImprovedAgent(spec(), { ...o, targetPath, timestamp: "now" }), /Simulated rename failure/);
  assert.equal(fs.readFileSync(targetPath, "utf8"), original);
  assert.ok(!listing(o.agentsDir).some(p => p.includes(".tmp-")));
});

test("personal-only skills are reused at their actual path and other projects receive new skills", async () => {
  const { skillSearchDirs, projectSkillsDir } = await import("../../dist/agents.js");
  const o = dirs();
  const personal = fixture(join(process.env.HOME, ".claude", "skills", "personal-only", "SKILL.md"), "Personal procedure");
  const r = f.writeNewAgent(spec({ skills: [skill("personal-only")] }), { ...o, searchDirs: skillSearchDirs() });
  assert.deepEqual(r.skills[0], { name: "personal-only", path: personal, status: "reused" });
  assert.equal(fs.existsSync(join(o.skillsDir, "personal-only", "SKILL.md")), false);
  assert.equal(fs.readFileSync(personal, "utf8"), "Personal procedure");
  const targetPath = fixture(join(root, "other-project", ".claude", "agents", "reviewer.md"), "Body");
  const improved = f.writeImprovedAgent(spec({ skills: [skill("new-procedure")] }), {
    ...o, targetPath, timestamp: "now", skillsDir: projectSkillsDir(targetPath), searchDirs: skillSearchDirs(targetPath)
  });
  assert.equal(improved.skills[0].path, join(root, "other-project", ".claude", "skills", "new-procedure", "SKILL.md"));
  assert.ok(fs.existsSync(improved.skills[0].path));
});

test("tool type errors always include the allowlist, including non-JSON values", () => {
  const circular = {};
  circular.self = circular;
  for (const tools of [1n, circular]) {
    assert.throws(() => validate({ tools }), /tools must list tool names from: Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch/);
  }
});
