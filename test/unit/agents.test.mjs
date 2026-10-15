import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, isAbsolute } from "node:path";

const { stripFrontmatter, loadAgent, loadAgentPrompt, loadAgentPromptWithPath, allowedAgentRoots } = await import("../../dist/agents.js");

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../fixtures/agents/sample.md");

describe("stripFrontmatter", () => {
  test("strips a leading block", () => {
    assert.equal(stripFrontmatter("---\nname: x\n---\nBody"), "Body");
    assert.equal(stripFrontmatter("---\nname: x\n---\n\n\nBody\nMore"), "Body\nMore");
  });
  test("handles CRLF", () => {
    assert.equal(stripFrontmatter("---\r\nname: x\r\n---\r\nBody\r\nMore"), "Body\nMore");
  });
  test("leaves text without frontmatter unchanged", () => {
    assert.equal(stripFrontmatter("Body"), "Body");
    const late = "a\nb\nc\nd\n---\nname: x\n---\nBody";
    assert.equal(stripFrontmatter(late), late);
  });
  test("leaves a body that opens with a markdown horizontal rule unchanged", () => {
    const hr = "---\nYou are a persona.\n---\nMore text";
    assert.equal(stripFrontmatter(hr), hr);
    const empty = "---\n---\nBody";
    assert.equal(stripFrontmatter(empty), empty);
    const prose = "---\nfirst section: not yaml\n---\nBody";
    assert.equal(stripFrontmatter(prose), prose);
  });
  test("strips a block whose key line is not the first line", () => {
    assert.equal(stripFrontmatter("---\n# comment\nname: x\n---\nBody"), "Body");
  });
  test("leaves an unterminated block unchanged", () => {
    const open = "---\nname: x\nBody";
    assert.equal(stripFrontmatter(open), open);
  });
  test("empty string", () => {
    assert.equal(stripFrontmatter(""), "");
  });
});

describe("loadAgentPromptWithPath", () => {
  test("returns stripped content and an absolute path for a literal file path", async () => {
    const { path, content } = await loadAgentPromptWithPath(sample);
    assert.ok(isAbsolute(path));
    assert.equal(path, sample);
    assert.equal(content, "You are Sample.\n");
    assert.equal(await loadAgentPrompt(sample), "You are Sample.\n");
  });
  test("unknown agent lists the three candidate paths, all in the agents directory", async () => {
    await assert.rejects(loadAgentPromptWithPath("no-such-agent-xyz"), (e) => {
      assert.match(e.message, /Agent prompt not found for "no-such-agent-xyz"/);
      const lines = e.message.split("\n").filter((l) => l.startsWith("  - "));
      assert.equal(lines.length, 3, e.message);
      assert.ok(lines.every((l) => l.startsWith(`  - ${resolve(process.env.ROUNDTABLE_AGENTS_DIR)}`)), e.message);
      assert.ok(lines.some((l) => l.endsWith("/no-such-agent-xyz.md")));
      assert.ok(lines.some((l) => l.endsWith("/subagent-no-such-agent-xyz.md")));
      assert.ok(lines.some((l) => l.endsWith("/no-such-agent-xyz/AGENT.md")));
      return true;
    });
  });
});

describe("agent ref containment", () => {
  const put = (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  const outside = mkdtempSync(join(tmpdir(), "rt-outside-"));
  const OUTSIDE = /outside the allowed agent directories.*ROUNDTABLE_AGENT_PATHS/s;
  after(() => rmSync(outside, { recursive: true, force: true }));

  test("bare names load from the agents directory; path refs from every allowed root", async (t) => {
    put(join(process.env.ROUNDTABLE_AGENTS_DIR, "bare-name.md"), "You are Bare.");
    assert.equal((await loadAgent("bare-name")).body, "You are Bare.");
    assert.equal((await loadAgent(sample)).path, sample); // ROUNDTABLE_AGENT_PATHS (test/fixtures)
    const home = put(join(homedir(), ".claude", "agents", "personal.md"), "You are Personal.");
    assert.equal((await loadAgent(home)).body, "You are Personal.");
    const ws = put(join(process.env.ROUNDTABLE_WORKSPACE_DIR, ".claude", "agents", "project.md"), "You are Project.");
    assert.equal((await loadAgent(ws)).body, "You are Project.");
    const roots = allowedAgentRoots();
    assert.ok(roots.includes(resolve(process.env.ROUNDTABLE_AGENTS_DIR)) && roots.includes(resolve(here, "../fixtures")));
  });

  test("a path outside the roots is refused with the same error whether or not it exists", async () => {
    const real = put(join(outside, "persona.md"), "You are Outside.");
    await assert.rejects(loadAgent(real), OUTSIDE);
    await assert.rejects(loadAgent(join(outside, "missing.md")), OUTSIDE);
    await assert.rejects(loadAgent(resolve(here, "../../README.md")), OUTSIDE);
    await assert.rejects(loadAgent(join(resolve(here, "../fixtures"), "..", "..", "README.md")), OUTSIDE, "no .. escape");
  });

  test("a path-like ref must be a .md file", async () => {
    for (const ref of ["/etc/passwd", "../package.json", resolve(here, "../fixtures/review2.mjs"), "agents/sub/dir"]) {
      await assert.rejects(loadAgent(ref), /is a path but not a \.md file.*ROUNDTABLE_AGENT_PATHS/s, ref);
    }
  });

  test("a symlink inside a root that points outside is refused", { skip: process.platform === "win32" }, async () => {
    const target = put(join(outside, "secret.md"), "secret persona");
    const link = join(process.env.ROUNDTABLE_AGENTS_DIR, "linked.md");
    symlinkSync(target, link);
    await assert.rejects(loadAgent(link), /through a symlink/);
    // A bare name is looked up in the operator's own agents directory, whose symlinks are the operator's.
    assert.equal((await loadAgent("linked")).body, "secret persona");
  });

  test("ROUNDTABLE_AGENT_PATHS takes several directories; bare names cannot climb out", async (t) => {
    const a = mkdtempSync(join(tmpdir(), "rt-paths-a-"));
    const b = mkdtempSync(join(tmpdir(), "rt-paths-b-"));
    const saved = process.env.ROUNDTABLE_AGENT_PATHS;
    process.env.ROUNDTABLE_AGENT_PATHS = [saved, a, b].join(delimiter);
    t.after(() => {
      process.env.ROUNDTABLE_AGENT_PATHS = saved;
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    });
    assert.equal((await loadAgent(put(join(b, "nested", "x.md"), "You are B."))).body, "You are B.");
    assert.equal((await loadAgent(put(join(a, "y.md"), "You are A."))).body, "You are A.");
    put(join(dirname(process.env.ROUNDTABLE_AGENTS_DIR), "AGENT.md"), "parent");
    await assert.rejects(loadAgent(".."), /Agent prompt not found/);
  });
});
