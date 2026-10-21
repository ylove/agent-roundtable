import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";

const root = fs.mkdtempSync(join(tmpdir(), "rt-grounding-"));
process.env.HOME = join(root, "home");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
// Personas in this test live directly under its temp root.
process.env.ROUNDTABLE_AGENT_PATHS = [process.env.ROUNDTABLE_AGENT_PATHS, root].filter(Boolean).join(delimiter);
const grounding = await import("../../dist/sessions/grounding.js");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const put = (path, text) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text); return path; };

test("grounding looks up canonical activity keys without stripping a remaining prefix", async () => {
  const { recordActivity, recentActivityFor } = await import("../../dist/activity.js");
  const { loadAgent } = await import("../../dist/agents.js");
  const activityPath = join(root, "prefix-history.jsonl");
  const path = put(join(root, "subagent-subagent-alpha.md"), "You are Alpha.");
  recordActivity({ session: "double", kind: "meeting", agents: ["subagent-alpha"], topic: "OWN-HISTORY", public: false }, activityPath);
  recordActivity({ session: "single", kind: "meeting", agents: ["alpha"], topic: "OTHER-HISTORY", public: false }, activityPath);
  const agent = await loadAgent(path);
  assert.equal(agent.key, "subagent-alpha");
  const text = grounding.recentActivityText(agent.key, { activityPath });
  assert.ok(text.includes("OWN-HISTORY"));
  assert.ok(!text.includes("OTHER-HISTORY"));
  const other = grounding.recentActivityText("alpha", { activityPath });
  assert.ok(other.includes("OTHER-HISTORY"));
  assert.ok(!other.includes("OWN-HISTORY"));
  assert.deepEqual(recentActivityFor(path, 5, activityPath).map(entry => entry.session), ["double"]);
});

test("memory deduplicates canonical paths and identical content but keeps distinct scopes", () => {
  const ws = join(root, "memory");
  const home = join(root, "memory-home");
  const lower = put(join(ws, ".claude/agent-memory/cfo/MEMORY.md"), "MEMORY-ONCE");
  const upper = join(ws, ".claude/agent-memory/CFO/MEMORY.md");
  if (!fs.existsSync(upper) || fs.realpathSync.native(lower) !== fs.realpathSync.native(upper)) put(upper, "MEMORY-ONCE");
  put(join(home, ".claude/agent-memory/cfo/MEMORY.md"), "DISTINCT-HOME");
  const text = grounding.agentMemory("cfo", "CFO", { workspaceDir: ws, homeDir: home });
  assert.equal(text.split("MEMORY-ONCE").length - 1, 1);
  assert.ok(text.includes("DISTINCT-HOME"));
});

test("bounded reads preserve small files and flag truncation", () => {
  const small = put(join(root, "small"), "whole text");
  assert.deepEqual(grounding.readHead(small), { text: "whole text", truncated: false });
  assert.deepEqual(grounding.readHead(small, 5), { text: "whole", truncated: true });
  assert.equal(grounding.readHead(join(root, "missing")), undefined);
});

test("5 MB README and memory use bounded reads, never readFileSync", (t) => {
  const ws = join(root, "large");
  const readme = put(join(ws, "README.md"), "DISTINCT-README\n" + "r".repeat(5 * 1024 * 1024));
  const memory = put(join(ws, ".claude/agent-memory/cfo/MEMORY.md"), "DISTINCT-MEMORY\n" + "m".repeat(5 * 1024 * 1024));
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    assert.ok(![readme, memory].includes(String(path)), "grounding must not read the entire file");
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const snapshot = grounding.workspaceSnapshot(ws);
  assert.ok(snapshot.includes("DISTINCT-README"));
  assert.ok(snapshot.length <= 2510);
  assert.equal(grounding.readHead(readme).text.length, 64 * 1024);
  assert.equal(grounding.readHead(readme).truncated, true);
  const excerpt = grounding.agentMemory("cfo", undefined, { workspaceDir: ws, homeDir: join(root, "empty") });
  assert.ok(excerpt.startsWith("DISTINCT-MEMORY"));
  assert.equal(excerpt.length, 3000);
});

test("truncated package metadata is skipped while small metadata is used", () => {
  const large = join(root, "large-package");
  put(join(large, "package.json"), JSON.stringify({ name: "OMIT-LARGE", filler: "x".repeat(70 * 1024) }));
  put(join(large, "README.md"), "README-PRESENT");
  const snapshot = grounding.workspaceSnapshot(large);
  assert.ok(snapshot.includes("README-PRESENT"));
  assert.ok(!snapshot.includes("OMIT-LARGE"));
  const small = join(root, "small-package");
  put(join(small, "package.json"), JSON.stringify({ name: "KEEP-SMALL", description: "Small metadata" }));
  assert.ok(grounding.workspaceSnapshot(small).includes("KEEP-SMALL"));
});

test("workspace context skips escaping links and non-files", { skip: process.platform === "win32" }, () => {
  const outside = put(join(root, "outside-context.md"), "OUTSIDE-CONTEXT");
  for (const name of ["CLAUDE.md", "AGENTS.md", "README.md", "package.json"]) {
    const ws = fs.mkdtempSync(join(root, "context-"));
    const target = name === "package.json"
      ? put(join(root, "outside-package.json"), JSON.stringify({ name: "OUTSIDE-CONTEXT" })) : outside;
    fs.symlinkSync(target, join(ws, name));
    if (name === "CLAUDE.md") put(join(ws, "AGENTS.md"), "LOCAL-INSTRUCTIONS");
    const text = grounding.workspaceSnapshot(ws) ?? "";
    assert.ok(!text.includes("OUTSIDE-CONTEXT"), name);
    if (name === "CLAUDE.md") assert.ok(text.includes("LOCAL-INSTRUCTIONS"));
  }
  const ws = fs.mkdtempSync(join(root, "context-"));
  const local = put(join(ws, "notes.md"), "LOCAL-CONTEXT");
  fs.symlinkSync(local, join(ws, "CLAUDE.md"));
  fs.mkdirSync(join(ws, "README.md"));
  assert.ok(grounding.workspaceSnapshot(ws).includes("LOCAL-CONTEXT"));
  assert.equal(grounding.readHead(join(ws, "README.md")), undefined);
});

test("memory skips escaping file and directory links in each scope", { skip: process.platform === "win32" }, () => {
  const outside = join(root, "outside-memory");
  const target = put(join(outside, "alpha", "MEMORY.md"), "OUTSIDE-MEMORY");
  for (const kind of ["file", "agent", "scope", "parent", "directory"]) {
    for (const scope of ["workspace", "local", "home"]) {
      const base = fs.mkdtempSync(join(root, "memory-links-"));
      const ws = join(base, "workspace");
      const home = join(base, "home");
      const parent = scope === "home" ? home : ws;
      const memoryDir = scope === "local" ? "agent-memory-local" : "agent-memory";
      const dir = join(parent, ".claude", memoryDir);
      fs.mkdirSync(parent, { recursive: true });
      if (kind === "parent") {
        const externalParent = join(base, "external-parent");
        put(join(externalParent, memoryDir, "alpha", "MEMORY.md"), "OUTSIDE-MEMORY");
        fs.symlinkSync(externalParent, join(parent, ".claude"));
      } else if (kind === "scope") {
        fs.mkdirSync(join(parent, ".claude"));
        fs.symlinkSync(outside, dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        if (kind === "agent") fs.symlinkSync(join(outside, "alpha"), join(dir, "alpha"));
        else {
          fs.mkdirSync(join(dir, "alpha"));
          if (kind === "file") fs.symlinkSync(target, join(dir, "alpha", "MEMORY.md"));
          else fs.mkdirSync(join(dir, "alpha", "MEMORY.md"));
        }
      }
      assert.equal(grounding.agentMemory("alpha", undefined, { workspaceDir: ws, homeDir: home }), undefined, `${scope}: ${kind}`);
    }
  }
});

test("memory preserves contained links", { skip: process.platform === "win32" }, () => {
  const ws = join(root, "contained-memory");
  const scope = join(ws, ".claude", "agent-memory");
  put(join(scope, "alpha", "MEMORY.md"), "LOCAL-MEMORY");
  fs.symlinkSync("alpha", join(scope, "alias"));
  assert.equal(grounding.agentMemory("alias", undefined, { workspaceDir: ws, homeDir: join(root, "empty") }), "LOCAL-MEMORY");
  const other = put(join(ws, "notes", "MEMORY.md"), "OTHER-SCOPE");
  fs.symlinkSync(dirname(other), join(scope, "other"));
  assert.equal(grounding.agentMemory("other", undefined, { workspaceDir: ws, homeDir: join(root, "empty") }), undefined);
});
