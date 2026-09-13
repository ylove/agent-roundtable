import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

const { stripFrontmatter, loadAgentPrompt, loadAgentPromptWithPath } = await import("../../dist/agents.js");

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
  test("unknown agent lists the four candidate paths", async () => {
    await assert.rejects(loadAgentPromptWithPath("no-such-agent-xyz"), (e) => {
      assert.match(e.message, /Agent prompt not found for "no-such-agent-xyz"/);
      const lines = e.message.split("\n").filter((l) => l.startsWith("  - "));
      assert.equal(lines.length, 4, e.message);
      assert.ok(lines.some((l) => l.endsWith("/no-such-agent-xyz.md")));
      assert.ok(lines.some((l) => l.endsWith("/subagent-no-such-agent-xyz.md")));
      assert.ok(lines.some((l) => l.endsWith("/no-such-agent-xyz/AGENT.md")));
      return true;
    });
  });
});
