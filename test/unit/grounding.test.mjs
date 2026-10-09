import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const root = fs.mkdtempSync(join(tmpdir(), "rt-grounding-"));
process.env.HOME = join(root, "home");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
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
