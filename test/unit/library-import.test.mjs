import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { importAgent, importAgentPath, MAX_AGENT_BYTES } from "../../dist/library/import.js";
import { readFrontmatter } from "../../dist/agents.js";
import { LIBRARY_DIR } from "../../dist/config.js";

function destination(t) {
  const root = mkdtempSync(join(tmpdir(), "library-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "agents");
}
const md = "---\nname: Quiet Reader\ndescription: Reads carefully.\ntools: Read, Grep, Glob\n---\n\nRead before making a recommendation.\n";

test("Markdown imports use name or filename, preserve content and create private files", t => {
  const dir = destination(t);
  const result = importAgent({ filename: "ignored.md", content: md }, { dir });
  assert.deepEqual(result, { key: "quiet-reader", status: "imported", warnings: [] });
  assert.equal(readFileSync(join(dir, "quiet-reader.md"), "utf8"), md);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "quiet-reader.md")).mode & 0o777, 0o600);
  const plain = importAgent({ filename: "Other Reader.MD", content: "Just read." }, { dir });
  assert.equal(plain.key, "other-reader");
  assert.equal(plain.status, "imported");
});

test("JSON accepts each prompt spelling and round-trips metadata", t => {
  const dir = destination(t);
  for (const prompt of ["prompt", "instructions", "system_prompt", "body"]) {
    const data = { name: `reader-${prompt}`, description: "Checks: input # carefully", provider: "openai", model: "custom-model", tools: ["Read", "Grep"], skills: "review, testing" };
    const result = importAgent({ filename: "persona.json", content: JSON.stringify({ ...data, [prompt]: "Read and explain." }) }, { dir });
    assert.equal(result.status, "imported");
    const parsed = readFrontmatter(readFileSync(join(dir, `${result.key}.md`), "utf8"));
    assert.deepEqual(parsed.data, data);
    assert.equal(parsed.body.trim(), "Read and explain.");
  }
});

test("invalid inputs are refused without returning prompt content", t => {
  const dir = destination(t);
  for (const input of [
    { filename: "bad.json", content: '{"name":"reader","prompt":"PRIVATE_INPUT","extra":true}' },
    { filename: "bad.json", content: '{"name":"reader"}' },
    { filename: "bad.json", content: '{"name":"reader","prompt":"one","body":"two"}' },
    { filename: "bad.json", content: '{"name":"reader","prompt":42}' },
    { filename: "bad.json", content: '{"name":"reader","prompt":"yes","tools":[42]}' },
    { filename: "bad.json", content: "[]" },
    { filename: "bad.json", content: "{" },
    { filename: "bad.json", content: '{"name":"reader","prompt":"yes","description":"has --- fence"}' },
    { filename: "empty.md", content: "---\nname: empty\n---\n  " },
    { filename: "fence.md", content: '---\nname: reader\ndescription: "PRIVATE_INPUT --- ambiguous"\n---\nPrompt' },
    { filename: "oversize.md", content: "x".repeat(MAX_AGENT_BYTES + 1) },
    { filename: "unicode.md", content: "é".repeat(MAX_AGENT_BYTES / 2 + 1) },
    { filename: "../escape.md", content: "Prompt" },
    { filename: "folder\\escape.md", content: "Prompt" },
    { filename: "name.txt", content: "Prompt" },
    { filename: "!!!.md", content: "Prompt" },
    { filename: "con.md", content: "Prompt" },
    { filename: "constructor.md", content: "Prompt" },
    { filename: "empty-name.md", content: '---\nname: ""\n---\nPrompt' },
  ]) {
    const result = importAgent(input, { dir });
    assert.equal(result.status, "refused", input.filename);
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_INPUT"));
  }
});

test("existing files and symlink targets are never overwritten", t => {
  const dir = destination(t);
  assert.equal(importAgent({ filename: "reader.md", content: "Original" }, { dir }).status, "imported");
  assert.equal(importAgent({ filename: "reader.md", content: "Replacement" }, { dir }).status, "exists");
  assert.equal(readFileSync(join(dir, "reader.md"), "utf8"), "Original");
  const outside = join(dir, "outside");
  writeFileSync(outside, "Unchanged");
  symlinkSync(outside, join(dir, "linked.md"));
  assert.equal(importAgent({ filename: "linked.md", content: "Replacement" }, { dir }).status, "exists");
  assert.equal(readFileSync(outside, "utf8"), "Unchanged");
  const linkedDir = dir + "-link";
  symlinkSync(dir, linkedDir);
  assert.equal(importAgent({ filename: "new.md", content: "No" }, { dir: linkedDir }).status, "refused");
});

test("warnings preserve requested tools and dated model pins", t => {
  const dir = destination(t);
  const result = importAgent({ filename: "worker.json", content: JSON.stringify({ name: "worker", prompt: "Work carefully.", model: "model-20260101", tools: "Read, Bash, Write" }) }, { dir });
  assert.equal(result.status, "imported");
  assert.deepEqual(result.warnings, [
    "requests Bash, Write: a heads-down worker using this persona gets them",
    "dated model pin may be unavailable; falls back to the provider default",
    "no description: Casting Call and the library show a blank role",
  ]);
  assert.equal(readFrontmatter(readFileSync(join(dir, "worker.md"), "utf8")).data.tools, "Read, Bash, Write");
});

test("path imports inspect one level, skip symlinks and cap file reads", t => {
  const root = destination(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "folder-reader.md"), "Read.");
  writeFileSync(join(root, "folder-json.json"), JSON.stringify({ name: "folder-json", body: "Read JSON." }));
  mkdirSync(join(root, "directory-reader"));
  writeFileSync(join(root, "directory-reader", "AGENT.md"), "Read a directory persona.");
  writeFileSync(join(root, "directory-reader", "ignored.md"), "Ignored");
  mkdirSync(join(root, "linked-agent"));
  symlinkSync(join(root, "folder-reader.md"), join(root, "linked-agent", "AGENT.md"));
  symlinkSync(join(root, "folder-reader.md"), join(root, "linked.md"));
  symlinkSync(join(root, "directory-reader"), join(root, "linked-directory"));
  writeFileSync(join(root, "large.md"), "x".repeat(MAX_AGENT_BYTES + 1));
  const results = importAgentPath(root);
  assert.deepEqual(results.filter(r => r.status === "imported").map(r => r.key).sort(), ["directory-reader", "folder-json", "folder-reader"]);
  assert.equal(results.length, 4);
  assert.equal(results.find(r => r.filename === "large.md").status, "refused");
  assert.equal(importAgentPath("relative.md")[0].status, "refused");
  assert.equal(importAgentPath(join(root, "missing.md"))[0].status, "refused");
  assert.equal(importAgentPath(join(root, "folder-json.json"))[0].status, "exists");
});

test("folder import writes at most 200 personas", t => {
  const root = destination(t);
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < 201; i++) writeFileSync(join(root, `bounded-${i}.md`), "Read.");
  const results = importAgentPath(root);
  assert.equal(results.filter(r => r.status === "imported").length, 200);
  assert.match(results.at(-1).error, /at most 200/);
  assert.equal(readdirSync(LIBRARY_DIR).filter(name => name.startsWith("bounded-")).length, 200);
});

test("a subagent- filename imports under its listed key and leaves no temp files", t => {
  const dir = destination(t);
  const result = importAgent({ filename: "subagent-auditor.md", content: "Audit carefully.\n" }, { dir });
  assert.equal(result.key, "auditor");
  assert.deepEqual(readdirSync(dir), ["auditor.md"]);
  assert.equal(importAgent({ filename: "subagent-auditor.md", content: "Audit carefully.\n" }, { dir }).status, "exists");
  assert.deepEqual(readdirSync(dir), ["auditor.md"]);
});
