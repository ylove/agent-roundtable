import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = fs.mkdtempSync(join(tmpdir(), "rt-agent-roots-"));
const workspace = join(root, "workspace");
const home = join(root, "home");
const cwd = process.cwd();
fs.mkdirSync(workspace);
fs.mkdirSync(home);
process.chdir(workspace);
process.env.HOME = home;
process.env.ROUNDTABLE_WORKSPACE_DIR = workspace;
delete process.env.ROUNDTABLE_AGENTS_DIR;
delete process.env.ROUNDTABLE_AGENT_PATHS;
const agents = await import("../../dist/agents.js");
const { previewFiles, writeNewAgent } = await import("../../dist/agent-files.js");
after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});
const put = (path, text = "---\nname: sample\n---\nPersona.") => {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
  return path;
};
const spec = { name: "sample", description: "Sample persona.", system_prompt: "Persona.", skills: [], contributions: [] };

test("agent loading and writing reject symlinked automatic roots", { skip: process.platform === "win32" }, async () => {
  const outside = join(root, "outside");
  const target = put(join(outside, "sample.md"));
  for (const parent of [workspace, home]) {
    for (const intermediate of [false, true]) {
      const claude = join(parent, ".claude");
      const dir = join(claude, "agents");
      const link = intermediate ? claude : dir;
      if (intermediate) put(join(outside, "agents", "sample.md"));
      else fs.mkdirSync(claude, { recursive: true });
      fs.symlinkSync(outside, link);
      try {
        assert.ok(!agents.allowedAgentRoots().includes(resolve(dir)));
        await assert.rejects(agents.loadAgent(join(dir, "sample.md")), /outside the allowed agent directories/);
        await assert.rejects(agents.loadAgent(target), /outside the allowed agent directories/);
        if (parent === workspace) await assert.rejects(agents.loadAgent("sample"), /outside the allowed agent directories/);
        assert.deepEqual(agents.listAgents(dir), []);
        const opts = { agentsDir: dir, skillsDir: join(root, "skills"), createdFrom: [], date: "2026-10-20" };
        assert.throws(() => previewFiles(spec, { ...opts, mode: "create" }), /Unapproved agent write root/);
        assert.throws(() => writeNewAgent(spec, opts), /Unapproved agent write root/);
      } finally {
        fs.unlinkSync(link);
        fs.rmSync(claude, { recursive: true, force: true });
      }
    }
  }
  assert.deepEqual(fs.readdirSync(outside).sort(), ["agents", "sample.md"]);
});

test("agent discovery applies containment to file and directory candidates", { skip: process.platform === "win32" }, async () => {
  const dir = join(workspace, ".claude", "agents");
  const local = put(join(dir, "local.md"));
  const outside = join(root, "discovery-outside");
  const externalFile = put(join(outside, "external.md"));
  put(join(outside, "AGENT.md"));
  fs.symlinkSync(externalFile, join(dir, "file-link.md"));
  fs.symlinkSync(outside, join(dir, "dir-link"));
  fs.mkdirSync(join(dir, "nested"));
  fs.symlinkSync(externalFile, join(dir, "nested", "AGENT.md"));
  fs.symlinkSync("local.md", join(dir, "alias.md"));
  put(join(dir, "regular", "AGENT.md"));
  assert.deepEqual(agents.listAgents().map(agent => agent.key), ["alias", "local", "regular"]);
  assert.equal((await agents.loadAgent("alias")).raw, fs.readFileSync(local, "utf8"));
  for (const name of ["file-link", "dir-link", "nested"]) {
    await assert.rejects(agents.loadAgent(name), /outside the allowed agent directories/);
  }
});

test("explicit agent paths retain trusted root aliases", { skip: process.platform === "win32" }, async () => {
  const outside = join(root, "configured");
  const file = put(join(outside, "configured.md"));
  const alias = join(root, "configured-alias");
  fs.symlinkSync(outside, alias);
  process.env.ROUNDTABLE_AGENT_PATHS = alias;
  try {
    assert.equal((await agents.loadAgent(join(alias, "configured.md"))).raw, fs.readFileSync(file, "utf8"));
    assert.deepEqual(agents.listAgents(alias).map(agent => agent.key), ["configured"]);
  } finally {
    delete process.env.ROUNDTABLE_AGENT_PATHS;
  }
});

test("agent writers can create missing automatic roots", async () => {
  const dir = join(home, ".claude", "agents");
  assert.ok(agents.allowedAgentRoots().includes(dir));
  const result = writeNewAgent(spec, { agentsDir: dir, skillsDir: join(root, "skills"), createdFrom: [], date: "2026-10-20" });
  assert.equal((await agents.loadAgent(result.agentPath)).frontmatter.name, "sample");
});
