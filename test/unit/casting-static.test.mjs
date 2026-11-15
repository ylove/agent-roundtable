import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintAgent } from "../../dist/casting/lint.js";
import { findSimilarity } from "../../dist/casting/similarity.js";
import { duelLine, renderRoster, renderCastingMarkdown } from "../../dist/casting/report.js";
import { firstJsonObject, parseCastingVerdict } from "../../dist/casting/casting.js";
import { parseCastArgs, runCastCli } from "../../dist/cli-cast.js";

const agent = (key, body = "", frontmatter = {}) => ({ key, ref: key, path: "", raw: body, body, frontmatter, skills: [] });
const base = () => ({ id: "cast-test", createdAt: new Date().toISOString(), brief: "Brief", agents: ["a", "b", "c", "d"].map(key => ({ key, verdict: "cast", strengths: [], risks: [], overlapsWith: [], lint: [] })), redundancy: [], gaps: [], recommended: { seats: ["a", "b", "c", "d"] } });

test("lint checks missing description, empty and short bodies, tools, dated pins and duplicate names", () => {
  const a = agent("a", "", { name: "Same", tools: ["Read", "Write", "Bash"], model: "claude-sonnet-20260101" });
  const b = agent("b", "A tiny persona.", { name: "same" });
  assert.deepEqual(lintAgent(a, [a, b]).map(l => l.code), ["no-description", "empty-body", "broad-tools", "dated-model", "duplicate-name"]);
  assert.equal(lintAgent(a)[3].level, "info");
  assert.match(lintAgent(a)[2].message, /Write, Bash/);
  assert.ok(lintAgent(b).some(l => l.code === "short-body"));
  assert.deepEqual(lintAgent(agent("good", "word ".repeat(40), { description: "Clear", tools: "Read, Grep, Glob", model: "inherit" })), []);
});

test("similarity uses Jaccard, stop words and connected clusters in input order", () => {
  const a = agent("a", "apple berry cherry date");
  const b = agent("b", "APPLE berry cherry date elder fig");
  const c = agent("c", "cherry date elder fig");
  assert.deepEqual(findSimilarity([a, b, c, agent("d", "ocean wind")]), [{ keys: ["a", "b", "c"], reason: "similar descriptions (0.67)" }]);
  assert.deepEqual(findSimilarity([agent("a", "the and of"), agent("b", "and the of")]), []);
  assert.equal(findSimilarity([agent("a", "", { description: "Bright purple orchids" }), agent("b", "", { description: "bright purple orchids" })])[0].reason, "similar descriptions (1.00)");
  assert.deepEqual(findSimilarity([agent("a", "apple ".repeat(400) + "pear plum"), agent("b", "pear plum")]), []);
});

test("director parser accepts fenced objects, drops unknown keys and rejects missing or ill-shaped verdicts", () => {
  assert.deepEqual(firstJsonObject('Here: ```json\n{"a":"brace } and \\" quote"}\n```'), { a: 'brace } and " quote' });
  const report = base();
  const result = parseCastingVerdict(JSON.stringify({ ...report, agents: [...report.agents, { key: "unknown" }], redundancy: [{ keys: ["a", "b", "unknown"], reason: "Overlap" }], recommended: { seats: ["a", "b", "unknown"], teamA: ["a", "unknown"], teamB: ["b"], judges: ["unknown"] } }), report, 4);
  assert.equal(result.agents.length, 4);
  assert.deepEqual(result.redundancy[0].keys, ["a", "b"]);
  assert.deepEqual(result.recommended.seats, ["a", "b"]);
  assert.doesNotMatch(JSON.stringify(result), /unknown/);
  assert.throws(() => parseCastingVerdict('{"agents":[]}', report, 4), /shape/);
  assert.throws(() => parseCastingVerdict(JSON.stringify({ ...report, agents: [] }), report, 4), /every persona/);
});

test("recommended teams render a shell-safe duel command in terminal and markdown", () => {
  const report = base();
  report.brief = "Owner's $(touch /tmp/nope) `echo bad`\nnext line";
  report.recommended = { seats: ["a", "b", "c", "d"], teamA: ["a", "b"], teamB: ["c"], judges: ["d"] };
  const directory = "/tmp/owner's $(echo ignored) personas";
  const command = duelLine(report, directory);
  const args = JSON.parse(execFileSync("/bin/sh", ["-c", command.replace("roundtable duel", 'node -e \'process.stdout.write(JSON.stringify(process.argv.slice(1)))\' --')], { encoding: "utf8" }));
  assert.deepEqual(args, [report.brief, "--team-a", "a,b", "--team-b", "c", "--judges", "d", "--agents-dir", directory]);
  assert.ok(renderRoster(report, directory).includes(command));
  assert.match(renderCastingMarkdown(report), /roundtable duel/);
});

test("fallback and dry-run notes render at the top, escape markdown and say gaps were not assessed", () => {
  const report = { ...base(), note: "Director [verdict] unavailable; *static* roster." };
  assert.match(renderRoster(report), /^Casting Call\nNote: Director \[verdict\] unavailable; \*static\* roster\./);
  assert.match(renderCastingMarkdown(report), /^## Casting Call\n\n\*\*Note: Director \\\[verdict\\\] unavailable; \\\*static\\\* roster\.\*\*/);
  for (const render of [renderRoster, renderCastingMarkdown]) {
    assert.match(render(report), /Gaps: not assessed/);
    assert.match(render({ ...report, dryRun: true }), /Gaps: not assessed/);
    assert.match(render({ ...report, gaps: ["no on-call owner"] }), /Gaps: no on-call owner/);
    assert.match(render(base()), /Gaps: none/);
  }
});

test("priced usage and estimates keep their wording without an unpriced suffix", () => {
  for (const render of [renderRoster, renderCastingMarkdown]) {
    assert.match(render({ ...base(), usage: { totalCostUsd: 0.1234 } }), /Usage: \$0\.1234(?:\n|$)/);
    const text = render({ ...base(), usage: { totalCostUsd: 0.1234, estimated: true } });
    assert.match(text, /Usage: \$0\.1234 \(estimated\)/);
    assert.doesNotMatch(text, /unpriced/);
  }
});

test("CLI parsing rejects bad values with usage exit codes and provides help", async () => {
  for (const args of [[], ["brief", "--agents", "a"], ["brief", "--seats", "1.5"], ["brief", "--max-seconds", "-1"], ["brief", "--mix", "bad"], ["brief", "--agents-dir", "relative"], ["brief", "--unknown"]]) {
    assert.throws(() => parseCastArgs(args), error => error.exitCode === 2);
  }
  let out = "";
  assert.equal(await runCastCli(["--help"], { output: { write: s => { out += s; } } }), 0);
  assert.match(out, /roundtable cast/);
});

test("CLI cast --dry-run --json runs offline against casting fixtures", () => {
  const fixtures = fileURLToPath(new URL("../fixtures/casting", import.meta.url));
  const text = execFileSync(process.execPath, ["dist/index.js", "cast", "Build a queue", "--agents-dir", fixtures, "--dry-run", "--json"], { encoding: "utf8", env: { ...process.env, ROUNDTABLE_DOTENV: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", TOGETHER_API_KEY: "", REPLICATE_API_TOKEN: "", OPENAI_COMPATIBLE_BASE_URL: "" } });
  const lines = text.trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "start");
  assert.equal(lines[0].mode, "casting");
  assert.equal(lines.at(-2).type, "end");
  assert.equal(lines.at(-1).dryRun, true);
  assert.equal(lines.at(-1).agents.length, 4);
});

test("CLI cast with no --agents casts the agents dir plus the imported library and skips shadowed entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-lib-"));
  const persona = (n) => `---\nname: ${n}\ndescription: ${n} persona\n---\n${n} owns a distinct area. `.concat("word ".repeat(45));
  mkdirSync(join(dir, "agents"));
  mkdirSync(join(dir, "home", "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "alpha.md"), persona("alpha"));
  writeFileSync(join(dir, "agents", "shared.md"), persona("shared"));
  writeFileSync(join(dir, "home", "agents", "shared.md"), persona("shared").replace("word", "other"));
  writeFileSync(join(dir, "home", "agents", "imported.md"), persona("imported"));
  const text = execFileSync(process.execPath, ["dist/index.js", "cast", "Build a queue", "--dry-run", "--json"], { encoding: "utf8", env: { ...process.env, ROUNDTABLE_DOTENV: "off", ROUNDTABLE_HOME: join(dir, "home"), ROUNDTABLE_AGENTS_DIR: join(dir, "agents") } });
  const report = JSON.parse(text.trim().split("\n").at(-1));
  assert.deepEqual(report.agents.map(a => a.key).sort(), ["alpha", "imported", "shared"]);
  rmSync(dir, { recursive: true, force: true });
});
