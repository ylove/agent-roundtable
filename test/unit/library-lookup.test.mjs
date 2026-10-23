import { test } from "node:test";
import assert from "node:assert/strict";
import { join, basename } from "node:path";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { AGENTS_DIR, LIBRARY_DIR, ROUNDTABLE_HOME } from "../../dist/config.js";
import { allowedAgentRoots, loadAgent } from "../../dist/agents.js";
import { listLibrary } from "../../dist/library/catalog.js";

test("configured candidates precede library candidates and both appear in discovery", async () => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(LIBRARY_DIR, { recursive: true });
  mkdirSync(join(AGENTS_DIR, "shared"));
  writeFileSync(join(AGENTS_DIR, "shared", "AGENT.md"), "---\nname: Configured\ndescription: Project role\n---\nConfigured body.");
  writeFileSync(join(LIBRARY_DIR, "shared.md"), "---\nname: Imported\ntools: Bash\n---\nImported body.");
  writeFileSync(join(LIBRARY_DIR, "library-only.md"), "Library body.");
  mkdirSync(join(LIBRARY_DIR, "directory-only"));
  writeFileSync(join(LIBRARY_DIR, "directory-only", "AGENT.md"), "Directory library body.");
  assert.equal((await loadAgent("shared")).body.trim(), "Configured body.");
  assert.equal((await loadAgent("library-only")).body.trim(), "Library body.");
  assert.equal((await loadAgent("directory-only")).body.trim(), "Directory library body.");
  const entries = listLibrary();
  const shared = entries.filter(entry => entry.key === "shared");
  assert.equal(shared.length, 2);
  assert.equal(shared[0].source, "agents-dir");
  assert.equal(shared[0].shadowed, undefined);
  assert.equal(shared[1].source, "library");
  assert.equal(shared[1].shadowed, true);
  assert.match(shared[1].warnings[0], /requests Bash/);
  for (const entry of entries) {
    assert.equal(entry.file, basename(entry.file));
    assert.equal(Object.hasOwn(entry, "path"), false);
    assert.ok(Array.isArray(entry.tools) && Array.isArray(entry.skills));
  }
});

test("library file realpaths must stay inside approved roots", async () => {
  const outside = join(ROUNDTABLE_HOME, "outside.md");
  writeFileSync(outside, "Outside body.");
  symlinkSync(outside, join(LIBRARY_DIR, "escaped.md"));
  await assert.rejects(loadAgent("escaped"), /outside the allowed/);
  assert.equal(listLibrary().some(entry => entry.key === "escaped"), false);
});

test("a symlinked library is not a root or a source of named personas", async () => {
  rmSync(LIBRARY_DIR, { recursive: true });
  const outside = join(ROUNDTABLE_HOME, "outside-library");
  mkdirSync(outside);
  writeFileSync(join(outside, "unapproved.md"), "Not approved.");
  symlinkSync(outside, LIBRARY_DIR);
  assert.ok(!allowedAgentRoots().includes(LIBRARY_DIR));
  await assert.rejects(loadAgent("unapproved"), /not found/);
  await assert.rejects(loadAgent(join(LIBRARY_DIR, "unapproved.md")), /outside the allowed/);
  assert.equal(listLibrary().some(entry => entry.source === "library"), false);
});

test("a library subagent- file loads by its listed key", async () => {
  rmSync(LIBRARY_DIR, { recursive: true, force: true });
  mkdirSync(LIBRARY_DIR, { recursive: true });
  writeFileSync(join(LIBRARY_DIR, "subagent-prefixed.md"), "Prefixed body.");
  assert.ok(listLibrary().some(entry => entry.key === "prefixed"));
  assert.equal((await loadAgent("prefixed")).body.trim(), "Prefixed body.");
});
