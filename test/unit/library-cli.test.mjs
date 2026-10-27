import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFrontmatter, assertReadableFrontmatter } from "../../dist/agents.js";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const pack = new URL("../../examples/starter-pack/", import.meta.url);
function env(t) {
  const root = mkdtempSync(join(tmpdir(), "library-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { ...process.env, ROUNDTABLE_HOME: root, ROUNDTABLE_AGENTS_DIR: join(root, "configured"), ROUNDTABLE_DOTENV: "off" };
}
function run(args, env, cwd = tmpdir()) { return spawnSync(process.execPath, [cli, "agents", ...args], { env, cwd, encoding: "utf8", timeout: 15_000 }); }

test("all eight starter personas parse with descriptions, read-only tools and no model pin", () => {
  const names = readdirSync(pack).sort();
  assert.deepEqual(names, ["cfo.md", "data-analyst.md", "designer.md", "product-lead.md", "security-reviewer.md", "skeptic.md", "staff-engineer.md", "user-advocate.md"]);
  for (const filename of names) {
    const content = readFileSync(new URL(filename, pack), "utf8");
    const meta = readFrontmatter(content);
    assert.doesNotThrow(() => assertReadableFrontmatter(meta, filename));
    assert.equal(meta.data.name, filename.slice(0, -3));
    assert.ok(typeof meta.data.description === "string" && meta.data.description.length > 0);
    assert.equal(meta.data.tools, "Read, Grep, Glob");
    assert.equal(Object.hasOwn(meta.data, "model"), false);
    assert.ok(meta.body.trim());
    const lines = content.trimEnd().split("\n").length;
    assert.ok(lines >= 40 && lines <= 60, `${filename}: ${lines} lines`);
    assert.match(meta.body, /boundaries/i);
    assert.match(meta.body, /dissent/i);
  }
});

test("starter installs from outside the package and a second run skips all eight", t => {
  const environment = env(t);
  const first = run(["starter"], environment);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.split(": imported").length - 1, 8);
  const files = readdirSync(join(environment.ROUNDTABLE_HOME, "agents"));
  const before = files.map(file => readFileSync(join(environment.ROUNDTABLE_HOME, "agents", file), "utf8"));
  const second = run(["starter"], environment);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.split(": exists (skipped)").length - 1, 8);
  assert.deepEqual(files.map(file => readFileSync(join(environment.ROUNDTABLE_HOME, "agents", file), "utf8")), before);
  const json = run(["--json"], environment);
  assert.equal(json.status, 0, json.stderr);
  const agents = JSON.parse(json.stdout);
  assert.equal(agents.length, 8);
  assert.ok(agents.every(agent => agent.source === "library" && agent.warnings.length === 0));
  const table = run([], environment);
  assert.equal(table.status, 0);
  assert.match(table.stdout, /KEY\s+SOURCE\s+DESCRIPTION\s+WARNINGS/);
  assert.match(table.stdout, /staff-engineer/);
});

test("CLI import reports warnings and refused files; usage failures exit 2", t => {
  const environment = env(t);
  const path = join(environment.ROUNDTABLE_HOME, "worker.json");
  writeFileSync(path, JSON.stringify({ name: "worker", prompt: "Work.", tools: "Bash", model: "model-20260101" }));
  const imported = run(["import", path], environment);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /requests Bash/);
  assert.match(imported.stdout, /may be unavailable/);
  assert.match(imported.stdout, /blank role/);
  writeFileSync(path, JSON.stringify({ name: "worker", prompt: "Work.", unknown: true }));
  const refused = run(["import", path], environment);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /refused/);
  for (const args of [["import"], ["import", "relative.md"], ["starter", "extra"], ["--unknown"], ["--json", "--json"], ["--json", "--open"], ["--no-hold"]]) {
    const result = run(args, environment);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Usage: roundtable agents/);
  }
  const help = run(["--help"], environment);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agents --open/);
});
