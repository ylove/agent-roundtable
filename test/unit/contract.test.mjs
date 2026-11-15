// Contract schema: normalization, the validation matrix (heads-down.md §7), hashing, merge patches, diffs, rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  checkContract, validateContract, contractHash, applyMergePatch, createMergePatch, affectedTasks, renderContractMarkdown,
  contractPath, contractMarkdownPath, contractIdFor, contractTag, globWithin, normalizeGlob, findCycle, BUDGET_FALLBACK, RESERVED_TASK_IDS,
  CONTRACT_SECRET_ENV_RE, childBudgetCap,
} = await import("../../dist/execution/contract.js");
const { CONTRACT_DEFAULTS } = await import("../../dist/execution/types.js");

const fixture = (name) => fileURLToPath(new URL(`../fixtures/ultraplan/${name}.md`, import.meta.url));
const task = (id, deps = [], extra = {}) => ({
  id, title: `Task ${id}`, persona: "dev", depends_on: deps, paths: { write: [`src/${id}/**`] }, acceptance: ["it works"], checks: ["test"], ...extra,
});
const valid = (over = {}) => ({
  schema: "roundtable.contract/1",
  id: "ctr-abc123-1",
  title: "Nav bar",
  goal: { ultimate: "Ship the nav bar", original_prompt: "build a nav bar" },
  scope: { orchestrator: "main", repo_root: "/srv/repo", base_ref: "abc", paths: ["src/**"] },
  tasks: [task("a"), task("b", ["a"])],
  validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 60 }] },
  budget: { usd: 10, per_task_usd: 5, wall_clock_min: 60 },
  ...over,
});
const check = (over, opts) => checkContract(valid(over), opts);
const dissent = (over = {}) => ({
  id: "retry-risk", by: "dev", source: { kind: "manual" },
  claim: "Retries may duplicate writes.", predicted_failure: "The repeated request check fails.",
  tripwire: { kind: "check_failed", check: "test", task: "a" }, ...over,
});
/** The contract is refused with an error matching `re`. */
function refused(over, re, opts) {
  const r = check(over, opts);
  assert.equal(r.ok, false, `expected an error matching ${re}`);
  assert.ok(r.errors.some((e) => re.test(e)), `no error matches ${re}: ${JSON.stringify(r.errors)}`);
  return r;
}

test("a minimal contract normalizes with every default", () => {
  const r = check();
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  const c = r.contract;
  assert.equal(c.version, 1);
  assert.equal(c.status, "draft");
  assert.deepEqual(c.participants, [{ agent: "dev" }], "participants default to the task personas");
  assert.equal(c.authority.lead, "dev");
  assert.deepEqual(c.authority.may, CONTRACT_DEFAULTS.authority_may);
  assert.equal(c.authority.budget_extension_pct, 0);
  assert.equal(c.budget.max_parallel, 3);
  assert.equal(c.budget.max_attempts, 3);
  assert.equal(c.sandbox.backend, "docker");
  assert.equal(typeof c.sandbox.image, "string");
  assert.deepEqual(c.workers, { driver: "claude-code" });
  assert.equal(c.tasks[0].kind, "build");
  assert.deepEqual(c.validation.final, ["test"], "final defaults to every command");
  assert.deepEqual(c.goal.artifacts, []);
  assert.deepEqual(c.consent, []);
  assert.deepEqual(c.dissents, []);
  assert.deepEqual([c.teams, c.interfaces, c.decisions], [[], [], []]);
  // The normalized contract validates to itself.
  assert.deepEqual(checkContract(c).contract, c);
});

test("dissents normalize defaults, change both consent and contract hashes, and render as data", async () => {
  const { consentHash } = await import("../../dist/execution/contract.js");
  const empty = check().contract;
  const r = check({ dissents: [dissent()] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.contract.dissents[0].on_fire, "huddle");
  assert.deepEqual(checkContract(r.contract).contract, r.contract);
  assert.notEqual(contractHash(empty), contractHash(r.contract));
  assert.notEqual(consentHash(empty), consentHash(r.contract));
  for (const patch of [
    { claim: "A different claim" }, { predicted_failure: "Another failure" }, { on_fire: "notify" },
    { tripwire: { kind: "task_state", task: "b", state: "blocked" } },
  ]) assert.notEqual(contractHash(r.contract), contractHash(check({ dissents: [dissent(patch)] }).contract));
  const md = renderContractMarkdown(r.contract);
  for (const text of ["## Dissents", "retry-risk (armed)", "Retries may duplicate writes.", "predicted_failure", "check_failed", "huddle", "manual", '"by": "dev"']) assert.ok(md.includes(text), text);
  const draft = check({ dissents: [dissent({ tripwire: undefined })] });
  assert.equal(draft.ok, true);
  assert.match(renderContractMarkdown(draft.contract), /draft: needs a tripwire or explicit excusal/);
  refused({ status: "frozen", dissents: [dissent({ tripwire: undefined })] }, /tripwire is required before freeze/);
});

test("postmortem mode and dissents survive contract normalization together", () => {
  const r = check({ postmortem: { enabled: true }, dissents: [dissent()] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.contract.postmortem.enabled, true);
  assert.equal(r.contract.dissents[0].id, "retry-risk");
  assert.deepEqual(checkContract(r.contract).contract, r.contract);
});

test("dissents reject unknown participants, commands and task references in every predicate", () => {
  refused({ dissents: [dissent({ by: "missing" })] }, /by "missing" is not a participant/);
  refused({ dissents: [dissent({ tripwire: { kind: "check_failed", check: "missing" } })] }, /check names unknown command/);
  for (const tripwire of [
    { kind: "check_failed", check: "test", task: "missing" },
    { kind: "path_touched", paths: ["src/**"], task: "missing" },
    { kind: "task_state", task: "missing", state: "rejected" },
  ]) refused({ dissents: [dissent({ tripwire })] }, /task names unknown task/);
  for (const state of ["rejected", "blocked"]) assert.equal(check({ dissents: [dissent({ tripwire: { kind: "task_state", task: "a", state } })] }).ok, true);
});

test("dissent globs reject absolute and parent paths on either platform", () => {
  for (const path of ["/etc/**", "../**", "src/../**", "src\\..\\**", "C:/private/**", "C:\\private\\**", "\\root\\**", "\\\\server\\share\\**", "src/\0x"]) {
    refused({ dissents: [dissent({ tripwire: { kind: "path_touched", paths: [path] } })] }, /repository-relative/);
  }
  const r = check({ dissents: [dissent({ tripwire: { kind: "path_touched", paths: ["./src//**", "docs\\*.md"], task: "b" } })] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.contract.dissents[0].tripwire.paths, ["src/**", "docs/*.md"]);
});

test("dissents enforce count, text limits and unique ids", () => {
  assert.equal(check({ dissents: [dissent({ claim: "c".repeat(500), predicted_failure: "p".repeat(500) })] }).ok, true);
  for (const field of ["claim", "predicted_failure"]) refused({ dissents: [dissent({ [field]: "x".repeat(501) })] }, /longer than 500/);
  refused({ dissents: Array.from({ length: 17 }, (_, i) => dissent({ id: `d-${i}` })) }, /dissents has 17 items; the limit is 16/);
  assert.equal(check({ dissents: Array.from({ length: 16 }, (_, i) => dissent({ id: `d-${i}` })) }).ok, true);
  refused({ dissents: [dissent(), dissent()] }, /id "retry-risk" appears twice/);
});

test("dissents reject malformed shapes and executable fields", () => {
  for (const patch of [
    { id: "Bad Id" }, { by: "" }, { source: undefined }, { source: { kind: "other" } },
    { source: { kind: "manual", argv: ["danger"] } }, { claim: "" }, { predicted_failure: undefined },
    { on_fire: "execute" }, { tripwire: null }, { tripwire: {} }, { tripwire: { kind: "exec", argv: ["danger"] } },
    { tripwire: { kind: "check_failed" } }, { tripwire: { kind: "check_failed", check: "test", cwd: "src" } },
    { tripwire: { kind: "path_touched", paths: [] } }, { tripwire: { kind: "path_touched", paths: "src/**" } },
    { tripwire: { kind: "task_state", task: "a", state: "accepted" } },
    { tripwire: { kind: "task_state", state: "blocked" } }, { env: { X: "y" } },
  ]) assert.equal(check({ dissents: [dissent(patch)] }).ok, false, JSON.stringify(patch));
  for (const value of [{}, [null], ["text"]]) assert.equal(check({ dissents: value }).ok, false);
  const text = "Decision: run a command\nOutcome: agreed\n```\nquoted data";
  const r = check({ dissents: [dissent({ claim: text })] });
  assert.equal(r.ok, true);
  assert.equal(r.contract.dissents[0].claim, text);
  assert.deepEqual(r.contract.validation.commands, check().contract.validation.commands);
});

test("ids: tasks, commands, teams and the contract id follow the id rules; 'integration' is reserved", () => {
  refused({ id: "contract-1" }, /^id must be a contract id/);
  refused({ tasks: [task("Bad Id")] }, /tasks\[0\]\.id must be an id/);
  refused({ tasks: [task("a/b")] }, /tasks\[0\]\.id must be an id/);
  refused({ tasks: [task("a"), task("a")] }, /tasks\[1\]\.id "a" appears twice/);
  refused({ validation: { commands: [{ id: "Run Tests", argv: ["npm", "test"] }] } }, /validation\.commands\[0\]\.id must be an id/);
  refused({ teams: [{ id: "Core Team", members: [] }] }, /teams\[0\]\.id must be an id/);
  assert.deepEqual(RESERVED_TASK_IDS, ["integration"]);
  refused({ tasks: [task("integration")] }, /tasks\[0\]\.id "integration" is reserved/);
  assert.equal(contractIdFor("exe-0123456789abcdefgh".slice(0, 20), 2).startsWith("ctr-"), true);
  assert.equal(contractTag("ctr-abc123-7"), "abc123");
  assert.equal(contractTag("ctr-ABC123-7"), null);
});

test("depends_on: references must exist, no self-dependency, and the graph is a DAG (the error names the cycle)", () => {
  refused({ tasks: [task("a", ["zz"])] }, /tasks\[0\]\.depends_on names unknown task "zz"/);
  refused({ tasks: [task("a", ["a"])] }, /"a" depends on itself/);
  const r = refused({ tasks: [task("a", ["c"]), task("b", ["a"]), task("c", ["b"]), task("d", ["c"])] }, /depends_on has a cycle/);
  const cycle = r.errors.find((e) => /cycle/.test(e)).split(": ")[1].split(" → ");
  assert.equal(cycle[0], cycle.at(-1));
  assert.deepEqual([...new Set(cycle)].sort(), ["a", "b", "c"]);
  assert.equal(findCycle([{ id: "x", depends_on: [] }, { id: "y", depends_on: ["x"] }]), null);
  assert.deepEqual(findCycle([{ id: "x", depends_on: ["y"] }, { id: "y", depends_on: ["x"] }]), ["x", "y", "x"]);
  // Duplicates are dropped, not errors.
  assert.deepEqual(check({ tasks: [task("a"), task("b", ["a", "a"])] }).contract.tasks[1].depends_on, ["a"]);
});

test("write globs: relative, normalized, ** * ? only, ** a whole segment, inside scope.paths", () => {
  refused({ tasks: [task("a", [], { paths: { write: ["/etc/passwd"] } })] }, /no absolute path/);
  refused({ tasks: [task("a", [], { paths: { write: ["src/../../x"] } })] }, /'\.\.'/);
  refused({ tasks: [task("a", [], { paths: { write: ["src/a\0b"] } })] }, /NUL/);
  refused({ tasks: [task("a", [], { paths: { write: ["src/{a,b}/**"] } })] }, /only the wildcards/);
  refused({ tasks: [task("a", [], { paths: { write: ["src/[ab].ts"] } })] }, /only the wildcards/);
  refused({ tasks: [task("a", [], { paths: { write: ["src/a**"] } })] }, /must be a whole segment/);
  refused({ tasks: [task("a", [], { paths: { write: ["!src/a"] } })] }, /negated/);
  refused({ tasks: [task("a", [], { paths: { write: ["lib/**"] } })] }, /tasks\[0\]\.paths\.write\[0\] "lib\/\*\*" is outside scope\.paths \(src\/\*\*\)/);
  refused({ scope: { orchestrator: "main", repo_root: "/srv/repo", base_ref: "abc", paths: [] } }, /scope\.paths must list at least one/);
  const ok = check({ tasks: [task("a", [], { paths: { write: ["./src//a/x.ts/", "src/a/*.ts", "src/a/?.md"], read: ["docs/**"] } })] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.contract.tasks[0].paths, { write: ["src/a/x.ts", "src/a/*.ts", "src/a/?.md"], read: ["docs/**"] });
  assert.deepEqual(check({ scope: { orchestrator: "m", repo_root: "/r", base_ref: "h" } }).contract.scope.paths, ["**"]);
  assert.equal(normalizeGlob("src\\win\\path").glob, "src/win/path");
  for (const [inner, outer, expected] of [
    ["src/a/**", "src/**", true], ["src/a/x.ts", "src/*/x.ts", true], ["src/a/*.ts", "src/**/*.ts", true], ["src/**", "src/a/**", false],
    ["lib/x", "src/**", false], ["src/a/b.ts", "**", true], ["src/a/b.test.ts", "src/a/*.ts", true], ["src/a/b.ts", "src/a/*.js", false],
    ["src/a/*.ts", "src/a/*s", true], ["src/**", "src/*", false], ["src", "src/**", true],
  ]) assert.equal(globWithin(inner, outer), expected, `${inner} within ${outer}`);
});

test("commands: argv strings only; a shell command line is an error on local and a warning on docker", () => {
  refused({ validation: { commands: [{ id: "test", argv: [] }] } }, /validation\.commands\[0\]\.argv/);
  refused({ validation: { commands: [{ id: "test", argv: "npm test" }] } }, /validation\.commands\[0\]\.argv/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", 5] }] } }, /validation\.commands\[0\]\.argv/);
  refused({ validation: { commands: [{ id: "test" }] } }, /validation\.commands\[0\]\.argv is required/);
  for (const argv of [["sh", "-c", "npm test"], ["bash", "-lc", "x"], ["/bin/zsh", "-c", "x"], ["dash", "-c", "x"], ["env", "A=1", "bash", "-c", "x"]]) {
    const local = refused({ sandbox: { backend: "local" }, validation: { commands: [{ id: "test", argv }] } }, /shell command lines are refused on the local sandbox backend/);
    assert.equal(local.ok, false);
    const docker = check({ validation: { commands: [{ id: "test", argv }] } });
    assert.equal(docker.ok, true, JSON.stringify(docker.errors));
    assert.ok(docker.warnings.some((w) => /allowed only because the sandbox backend is docker/.test(w)), argv.join(" "));
  }
  assert.deepEqual(check({ validation: { commands: [{ id: "test", argv: ["sh", "scripts/test.sh"] }] } }).warnings.filter((w) => /shell/.test(w)), []);
  refused({ sandbox: { backend: "local", install: { argv: ["sh", "-c", "npm ci"], egress: [] } } }, /sandbox\.install\.argv runs a shell/);
});

test("commands: no secret-shaped env keys, timeout_s between 1 and 900 (default 300), relative cwd", () => {
  for (const key of ["API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "MY_PASS", "PASSWD", "AUTHORIZATION", "NPM_CONFIG__AUTH",
    "CREDENTIALS", "MY_CREDS", "COOKIE", "SESSION", "SESSION_ID", "GH_PAT", "DATABASE_URL", "SENTRY_DSN", "PGPASS", "GIT_AUTHOR_NAME"]) {
    refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { [key]: "x" } }] } }, new RegExp(`env\\.${key} looks like a credential`));
  }
  assert.match(String(CONTRACT_SECRET_ENV_RE), /DATABASE_URL\|DSN/);
  // A value that scrubbing would change is refused too, so the stored command is the validated one.
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { FOO: "ghp_" + "a".repeat(36) } }] } }, /env\.FOO has a value that looks like a credential/);
  process.env.CONTRACT_TEST_DEPLOY_TOKEN = "Q7x9Lm2Pz8Rt4Vw6";
  try {
    refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { TARGET: "Q7x9Lm2Pz8Rt4Vw6" } }] } }, /env\.TARGET has a value that looks like a credential/);
  } finally {
    delete process.env.CONTRACT_TEST_DEPLOY_TOKEN;
  }
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { "bad name": "x" } }] } }, /is not a valid variable name/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { NODE_ENV: 1 } }] } }, /env\.NODE_ENV must be a string/);
  const env = check({ validation: { commands: [{ id: "test", argv: ["npm", "test"], env: { NODE_ENV: "test", LOG_LEVEL: "debug" } }] } });
  assert.deepEqual(env.contract.validation.commands[0].env, { NODE_ENV: "test", LOG_LEVEL: "debug" });
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 0 }] } }, /timeout_s must be at least 1/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 901 }] } }, /timeout_s must be at most 900/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: "60" }] } }, /timeout_s must be a finite number/);
  assert.equal(check({ validation: { commands: [{ id: "test", argv: ["npm", "test"] }] } }).contract.validation.commands[0].timeout_s, 300);
  assert.equal(check({ validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 900 }] } }).ok, true);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], cwd: "/abs" }] } }, /cwd/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"], cwd: "../up" }] } }, /cwd/);
  assert.equal(check({ validation: { commands: [{ id: "test", argv: ["npm", "test"], cwd: "./pkg/" }] } }).contract.validation.commands[0].cwd, "pkg");
  assert.equal(check({ validation: { commands: [{ id: "test", argv: ["npm", "test"], cwd: "." }] } }).contract.validation.commands[0].cwd, undefined);
});

test("checks and validation.final reference existing commands", () => {
  refused({ tasks: [task("a", [], { checks: ["lint"] })] }, /tasks\[0\]\.checks\[0\] names unknown command "lint"/);
  refused({ validation: { commands: [{ id: "test", argv: ["npm", "test"] }], final: ["lint"] } }, /validation\.final\[0\] names unknown command "lint"/);
  refused({ validation: { commands: [{ id: "test", argv: ["a"] }, { id: "test", argv: ["b"] }] } }, /"test" appears twice/);
  const c = check({ validation: { commands: [{ id: "test", argv: ["npm", "test"] }, { id: "lint", argv: ["npm", "run", "lint"] }], final: ["lint"] } }).contract;
  assert.deepEqual(c.validation.final, ["lint"]);
});

test("budgets are greater than 0 and max_parallel is 1..16; a missing budget defaults with a warning", () => {
  refused({ budget: { usd: 0 } }, /budget\.usd must be greater than 0/);
  refused({ budget: { usd: -5 } }, /budget\.usd must be greater than 0/);
  refused({ budget: { usd: 10, per_task_usd: 0 } }, /budget\.per_task_usd must be greater than 0/);
  refused({ budget: { usd: 10, per_agent_usd: -1 } }, /budget\.per_agent_usd must be greater than 0/);
  refused({ budget: { usd: 10, wall_clock_min: 0 } }, /budget\.wall_clock_min must be greater than 0/);
  refused({ budget: { usd: 10, max_parallel: 0 } }, /budget\.max_parallel must be at least 1/);
  refused({ budget: { usd: 10, max_parallel: 17 } }, /budget\.max_parallel must be at most 16/);
  refused({ budget: { usd: 10, max_parallel: 2.5 } }, /budget\.max_parallel must be an integer/);
  refused({ budget: { usd: 10, max_attempts: 0 } }, /budget\.max_attempts must be at least 1/);
  refused({ budget: { usd: 4, per_task_usd: 5 } }, /per_task_usd \(\$5\) must not exceed budget\.usd \(\$4\)/);
  refused({ tasks: [task("a", [], { budget_usd: 0 })] }, /tasks\[0\]\.budget_usd must be greater than 0/);
  assert.equal(check({ budget: { usd: 10, max_parallel: 16 } }).contract.budget.max_parallel, 16);
  const missing = check({ budget: undefined });
  assert.equal(missing.ok, true);
  assert.equal(missing.contract.budget.usd, BUDGET_FALLBACK.usd);
  assert.ok(missing.warnings.some((w) => /budget\.usd was not given; defaulted/.test(w)));
  refused({ tasks: [task("a", [], { budget_usd: 9 })] }, /tasks\[0\]\.budget_usd \(\$9\) must not exceed budget\.per_task_usd \(\$5\)/);
  assert.equal(check({ tasks: [task("a", [], { budget_usd: 5 })] }).ok, true);
});

test("sudo and doas are refused on every backend; wildcard egress needs two labels; glob lists are capped", () => {
  for (const argv of [["sudo", "npm", "test"], ["doas", "make"], ["env", "-S", "sudo ls"], ["time", "sudo", "ls"]]) {
    refused({ validation: { commands: [{ id: "test", argv }] } }, /commands never change identity/);
    refused({ sandbox: { backend: "local" }, validation: { commands: [{ id: "test", argv }] } }, /commands never change identity/);
  }
  const install = (egress) => ({ sandbox: { backend: "docker", install: { argv: ["npm", "ci"], egress } } });
  refused(install(["*.com"]), /"\*\.com" is too broad/);
  refused(install(["*.co:443"]), /is too broad/);
  refused(install(["*"]), /must be a host name/);
  assert.equal(check(install(["*.npmjs.org", "registry.npmjs.org", "pypi.org:443"])).ok, true);
  const many = Array.from({ length: 65 }, (_, i) => `src/a/f${i}.ts`);
  refused({ tasks: [task("a", [], { paths: { write: many } })] }, /tasks\[0\]\.paths\.write has 65 items; the limit is 64/);
  refused({ scope: { orchestrator: "main", repo_root: "/srv/repo", base_ref: "abc", paths: many } }, /scope\.paths has 65 items; the limit is 64/);
  assert.equal(check({ tasks: [task("a", [], { paths: { write: many.slice(0, 64) } })] }).ok, true);
});

test("personas resolve through loadAgent; names are warnings only while the agents directory is unavailable", async () => {
  const dir = process.env.ROUNDTABLE_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
  const unavailable = await validateContract(valid());
  assert.equal(unavailable.ok, true);
  assert.ok(unavailable.warnings.some((w) => /persona "dev" could not be checked: the agents directory .* is unavailable/.test(w)), JSON.stringify(unavailable.warnings));
  const fixtures = await validateContract(valid({ tasks: [task("a", [], { persona: fixture("cfo") })], participants: [fixture("cfo"), fixture("skeptic")] }));
  assert.deepEqual(fixtures.errors, []);
  assert.deepEqual(fixtures.warnings, []);
  // A path is always checked: outside the allowed roots it is an error even without an agents directory.
  const escaped = await validateContract(valid({ tasks: [task("a", [], { persona: "/etc/hosts.md" })] }));
  assert.ok(escaped.errors.some((e) => /persona "\/etc\/hosts\.md" does not resolve/.test(e)), JSON.stringify(escaped.errors));
  mkdirSync(dir, { recursive: true });
  try {
    const missing = await validateContract(valid());
    assert.ok(missing.errors.some((e) => /persona "dev" does not resolve: Agent prompt not found/.test(e)), JSON.stringify(missing.errors));
    assert.equal((await validateContract(valid(), { personas: false })).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interfaces: owners and consumers are task ids", () => {
  const iface = (extra) => ({ interfaces: [{ name: "NavProps", kind: "type", owner: "a", description: "props", ...extra }] });
  refused(iface({ owner: "zz" }), /interfaces\[0\]\.owner must be a task id/);
  refused(iface({ consumers: ["b", "zz"] }), /interfaces\[0\]\.consumers\[1\] must be a task id/);
  refused(iface({ kind: "protocol" }), /interfaces\[0\]\.kind must be one of/);
  refused(iface({ path: "../x.ts" }), /interfaces\[0\]\.path/);
  refused({ interfaces: [{ name: "X", owner: "a" }, { name: "X", owner: "b" }] }, /"X" appears twice/);
  assert.deepEqual(check(iface({ consumers: ["b"] })).contract.interfaces[0], { name: "NavProps", kind: "type", owner: "a", description: "props", consumers: ["b"] });
  assert.equal(check({ interfaces: [{ name: "X", owner: "a" }] }).contract.interfaces[0].kind, "other");
});

test("teams and members are consistent; authority.lead is a participant", () => {
  const people = { participants: [{ agent: "dev", team: "core" }, { agent: "qa" }] };
  refused({ ...people, teams: [{ id: "core", members: ["dev", "ghost"] }] }, /teams\[0\]\.members\[1\] "ghost" is not a participant/);
  refused({ ...people, teams: [] }, /participants\[0\]\.team names unknown team "core"/);
  refused({ ...people, teams: [{ id: "core", members: ["dev"] }], tasks: [task("a", [], { team: "web" })] }, /tasks\[0\]\.team names unknown team "web"/);
  refused({ ...people, teams: [{ id: "core", members: [] }, { id: "core", members: [] }] }, /teams\[1\]\.id "core" appears twice/);
  const joined = check({ ...people, teams: [{ id: "core", lead: "qa", members: [] }] });
  assert.deepEqual(joined.errors, []);
  assert.deepEqual(joined.contract.teams[0].members, ["qa", "dev"], "the lead and the participant's team are added to members");
  assert.ok(check({ ...people, teams: [{ id: "web", members: ["qa"] }], tasks: [task("a", [], { team: "web" })] }).warnings.some((w) => /"dev" is not a member of team "web"/.test(w)));
  refused({ ...people, teams: [{ id: "core", members: ["dev"] }], authority: { lead: "ghost" } }, /authority\.lead "ghost" is not a participant/);
  refused({ authority: { may: ["retry", "nuke"] } }, /authority\.may\[1\] must be one of/);
  refused({ authority: { budget_extension_pct: 150 } }, /budget_extension_pct must be at most 100/);
  refused({ participants: ["dev", "dev"] }, /participants\[1\]\.agent "dev" appears twice/);
  const added = check({ participants: ["qa"] });
  assert.deepEqual(added.contract.participants.map((p) => p.agent), ["qa", "dev"]);
  assert.ok(added.warnings.some((w) => /did not include task persona "dev"/.test(w)));
  assert.equal(added.contract.authority.lead, "qa", "the lead defaults to the first participant");
});

test("a child contract fits its parent task's write paths and budget; depth is bounded", () => {
  const parent = checkContract(valid({
    id: "ctr-parent-1",
    tasks: [task("sub", [], { kind: "subcontract", paths: { write: ["src/sub/**"] }, budget_usd: 4 }), task("plain")],
  })).contract;
  const child = (over = {}) => valid({
    id: "ctr-chd123-1",
    scope: { orchestrator: "dev", repo_root: "/srv/repo", base_ref: "abc", parent: { contract: "ctr-parent-1", task: "sub" }, paths: ["src/sub/**"] },
    tasks: [task("x", [], { paths: { write: ["src/sub/x/**"] } })],
    budget: { usd: 3, per_task_usd: 1 },
    ...over,
  });
  const ok = checkContract(child(), { parent: { contract: parent, depth: 0 } });
  assert.deepEqual(ok.errors, []);
  const asChild = (over, depth = 0) => checkContract(child(over), { parent: { contract: parent, depth } });
  assert.ok(asChild({ scope: { orchestrator: "dev", repo_root: "/srv/repo", base_ref: "abc", parent: { contract: "ctr-parent-1", task: "sub" }, paths: ["src/other/**"] } })
    .errors.some((e) => /scope\.paths\[0\] "src\/other\/\*\*" is outside the parent task's write paths/.test(e)));
  assert.ok(asChild({ budget: { usd: 5, per_task_usd: 1 } }).errors.some((e) => /budget\.usd \(\$5\) exceeds what the parent task may spend \(\$4/.test(e)));
  // The cap is also bounded by what the parent has left, and shared with the task's other children.
  const scoped = (over) => checkContract(child(), { parent: { contract: parent, depth: 0, ...over } });
  assert.ok(scoped({ remainingUsd: 2 }).errors.some((e) => /exceeds what the parent task may spend \(\$2/.test(e)));
  assert.ok(scoped({ siblingsUsd: 2 }).errors.some((e) => /plus the task's other child contracts \(\$2\) exceeds what the parent task may spend \(\$4\)/.test(e)));
  assert.equal(scoped({ siblingsUsd: 1, remainingUsd: 4 }).ok, true);
  assert.equal(childBudgetCap({ contract: parent, depth: 0, remainingUsd: 100 }, "sub"), 4);
  assert.equal(childBudgetCap({ contract: parent, depth: 0 }, "plain"), 5, "a task without budget_usd: the parent's per-task cap");
  assert.ok(asChild({}, CONTRACT_DEFAULTS.max_subcontract_depth).errors.some((e) => /would nest sub-orchestration 3 levels deep; the limit is 2/.test(e)));
  assert.equal(asChild({}, CONTRACT_DEFAULTS.max_subcontract_depth - 1).ok, true);
  assert.ok(asChild({ scope: { orchestrator: "dev", repo_root: "/elsewhere", base_ref: "abc", parent: { contract: "ctr-parent-1", task: "sub" } } })
    .errors.some((e) => /must be the parent's repository/.test(e)));
  const build = checkContract(child({ scope: { orchestrator: "dev", repo_root: "/srv/repo", base_ref: "abc", parent: { contract: "ctr-parent-1", task: "plain" }, paths: ["src/plain/**"] } }), { parent: { contract: parent, depth: 0 } });
  assert.ok(build.errors.some((e) => /is a build task; only subcontract tasks get child contracts/.test(e)));
  assert.ok(checkContract(child()).errors.some((e) => /scope\.parent contract ctr-parent-1 could not be loaded/.test(e)));
  // Defaults inside a parent: scope.paths are the parent task's write paths, the budget its cap.
  const defaults = checkContract(child({ scope: { orchestrator: "dev", repo_root: "/srv/repo", base_ref: "abc", parent: { contract: "ctr-parent-1", task: "sub" } }, budget: undefined }),
    { parent: { contract: parent, depth: 0 } });
  assert.deepEqual(defaults.contract.scope.paths, ["src/sub/**"]);
  assert.equal(defaults.contract.budget.usd, 4);
  assert.deepEqual(defaults.warnings.filter((w) => /budget\.usd was not given/.test(w)), []);
});

test("unknown fields and wrong shapes are named", () => {
  refused({ owner: "x" }, /^owner is not a known field/);
  refused({ tasks: [{ ...task("a"), dependencies: ["b"] }] }, /tasks\[0\]\.dependencies is not a known field/);
  refused({ goal: { ultimate: "x" } }, /goal\.original_prompt is required/);
  refused({ tasks: [] }, /tasks must list at least one task/);
  refused({ scope: { orchestrator: "main", repo_root: "relative/path", base_ref: "abc" } }, /scope\.repo_root must be an absolute path/);
  refused({ schema: "roundtable.contract/2" }, /schema must be/);
  assert.equal(checkContract("not an object").ok, false);
  assert.equal(checkContract([1, 2]).ok, false);
});

test("contractHash covers the content, not consent or the freeze record", () => {
  const c = check().contract;
  const h = contractHash(c);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(contractHash({ ...c, consent: [{ agent: "dev", verdict: "AGREE" }], frozen: { by: "main", at: "t", hash: h } }), h);
  assert.notEqual(contractHash({ ...c, title: "Other" }), h);
  assert.equal(contractHash(JSON.parse(JSON.stringify({ ...c, title: c.title }))), h, "key order does not matter");
});

test("applyMergePatch follows RFC 7396 (the appendix examples) and createMergePatch inverts it", () => {
  for (const [target, patch, result] of [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [["a", "b"], ["c", "d"], ["c", "d"]],
    [{ a: "b" }, ["c"], ["c"]],
    [{ a: "foo" }, null, null],
    [{ a: "foo" }, "bar", "bar"],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: "b", c: null }, { a: "b" }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ]) assert.deepEqual(applyMergePatch(target, patch), result, JSON.stringify([target, patch]));
  const polluted = applyMergePatch({}, JSON.parse('{"__proto__": {"x": 1}}'));
  assert.equal({}.x, undefined);
  assert.deepEqual(Object.keys(polluted), ["__proto__"]);
  const before = check().contract;
  const after = check({ title: "New", tasks: [task("a"), task("c")], budget: { usd: 20, per_task_usd: 5, wall_clock_min: 60 } }).contract;
  const patch = createMergePatch(before, after);
  assert.deepEqual(applyMergePatch(before, patch), after);
  assert.deepEqual(createMergePatch(before, before), {});
});

test("affectedTasks: changed specs, added and removed tasks, interface owners and consumers, changed checks", () => {
  const ifaces = [{ name: "Api", kind: "api", owner: "a", consumers: ["c"], description: "v1" }];
  const old = check({ tasks: [task("a"), task("b"), task("c"), task("d")], interfaces: ifaces }).contract;
  const next = check({
    tasks: [task("a"), task("b", [], { acceptance: ["more"] }), task("c"), task("e")],
    interfaces: [{ ...ifaces[0], description: "v2" }],
  }).contract;
  const a = affectedTasks(old, next);
  assert.deepEqual(a.changed, ["b"]);
  assert.deepEqual(a.added, ["e"]);
  assert.deepEqual(a.removed, ["d"]);
  assert.deepEqual(a.dependents, ["a", "c"]);
  assert.deepEqual(a.all, ["a", "b", "c", "d", "e"]);
  const cmd = check({ tasks: [task("a"), task("b", [], { checks: [] })], validation: { commands: [{ id: "test", argv: ["npm", "run", "test:ci"] }] } }).contract;
  assert.deepEqual(affectedTasks(check({ tasks: [task("a"), task("b", [], { checks: [] })] }).contract, cmd).all, ["a"], "a changed check command affects the tasks that run it");
  assert.deepEqual(affectedTasks(old, old).all, []);
  // Added and removed interfaces and commands count as changes too.
  const bare = check({ tasks: [task("a"), task("b"), task("c"), task("d")] }).contract;
  assert.deepEqual(affectedTasks(old, bare).all, ["a", "c"]);
  assert.deepEqual(affectedTasks(bare, old).all, ["a", "c"]);
  const more = check({ validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 60 }, { id: "lint", argv: ["npm", "run", "lint"] }] } }).contract;
  assert.deepEqual(affectedTasks(check().contract, more).all, []);
});

test("renderContractMarkdown shows every section and marks a participant's own tasks", () => {
  const c = check({
    participants: [{ agent: "dev", role: "builder", team: "core" }, { agent: "qa" }],
    teams: [{ id: "core", lead: "dev", members: ["dev"] }],
    tasks: [task("a"), task("b", ["a"], { persona: "qa", effort: "high", budget_usd: 2 })],
    interfaces: [{ name: "NavProps", kind: "type", owner: "a", consumers: ["b"], description: "props" }],
    decisions: [{ id: "d1", scope: "contract", text: "Use CSS modules", rationale: "existing setup" }],
  }).contract;
  const md = renderContractMarkdown(c, { mark: "qa" });
  for (const part of ["# Contract: Nav bar", "`ctr-abc123-1` v1 · status: draft", "## Goal", "> build a nav bar", "## Scope", "`src/**`", "## Participants",
    "- dev — builder · team core", "- qa (you)", "## Teams", "## Tasks", "### 2. `b` — Task b (yours)", "- Depends on: `a`", "- Writes: `src/b/**`",
    "  - it works", "- Checks: `test`", "## Interfaces", "**NavProps** (type) — owner `a`; consumers `b` — props", "## Decisions", "**d1** (contract, by main): Use CSS modules — existing setup",
    "## Validation", "- `test`: `npm test` (timeout 60 s)", "Final validation: `test`", "## Budget and authority", "$10 total · $5 per task", "Lead dev may: retry, reassign, resolve_merge", "## Consent"]) {
    assert.ok(md.includes(part), `missing ${JSON.stringify(part)}\n${md}`);
  }
  assert.ok(!md.includes("### 1. `a` — Task a (yours)"));
  assert.ok(!renderContractMarkdown(c, { omitConsent: true }).includes("## Consent"));
});

test("contractPath and contractMarkdownPath live under the execution's contracts directory", () => {
  const store = { dir: "/state/executions/exe-x" };
  assert.equal(contractPath(store, "ctr-abc123-1", 2), join("/state/executions/exe-x", "contracts", "ctr-abc123-1", "v2.json"));
  assert.equal(contractMarkdownPath(store, "ctr-abc123-1"), join("/state/executions/exe-x", "contracts", "ctr-abc123-1", "CONTRACT.md"));
  assert.throws(() => contractPath(store, "../x", 1), /Not a contract id/);
  assert.throws(() => contractPath(store, "ctr-abc123-1", 0), /Not a contract version/);
});

test("page_loads predicates normalize, render, affect consent and reject unsafe paths", () => {
  const r = check({ tasks: [task("a", [], { verify: [{ page_loads: { path: "src/a/index.html" } }] })] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(checkContract(r.contract).contract, r.contract);
  assert.match(renderContractMarkdown(r.contract), /page_loads `src\/a\/index.html`/);
  const before = check({ tasks: [task("a")] }).contract;
  assert.notEqual(contractHash(before), contractHash(r.contract));
  assert.deepEqual(affectedTasks(before, r.contract).changed, ["a"]);
  for (const path of ["../page.html", "/etc/passwd", "src/*.html", "src/a\0.html"]) refused({ tasks: [task("a", [], { verify: [{ page_loads: { path } }] })] }, /repository-relative file path/);
  refused({ tasks: [task("a", [], { verify: [{ unknown: {} }] })] }, /unknown/);
});

test("drafted web duel plans include an executable page-load acceptance predicate", async () => {
  const { draftDuelPlan } = await import("../../dist/sessions/duel-import.js");
  const plan = draftDuelPlan({ id: "duel-web", topic: "A page", dissents: [], artifact: {
    kind: "web", title: "Page", team: "A", files: [{ path: "index.html", bytes: 20 }], approvals: [], fixes: [],
  } }, { build: "dev", review: "reviewer" });
  assert.deepEqual(plan.tasks[0].verify, [{ page_loads: { path: "index.html" } }]);
  assert.ok(plan.tasks[0].acceptance.some(s => /without exceptions/.test(s)));
});
