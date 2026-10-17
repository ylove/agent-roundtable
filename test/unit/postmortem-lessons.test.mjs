// Postmortem mode (WS14): lessons are kept per project and read back before the next plan: propose_contract,
// start_ultraplan with repo_dir, heads-down task cards and postmortem(action: lessons).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRepo } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, task } from "../fixtures/workers/run.mjs";
import { json, stubFetch } from "./helpers.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { addLessons, activeLessons, ultraplanSection, cardSection, cardLessons, contractLessons } = await import("../../dist/postmortem/lessons.js");
const { loadLessons, lessonsPath } = await import("../../dist/postmortem/store.js");
const { buildTaskCard } = await import("../../dist/execution/task-card.js");
const { checkContract, contractHash } = await import("../../dist/execution/contract.js");

const BASE = "http://localhost:4141/v1";
const LLM = { provider: "openai_compatible", model: "test", base_url: BASE };
const fixture = (name) => fileURLToPath(new URL(`../fixtures/ultraplan/${name}.md`, import.meta.url));
const cfo = fixture("cfo");
const skeptic = fixture("skeptic");

const call = async (name, args) => handleToolCall(name, args);
const ok = async (name, args) => {
  const r = await call(name, args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return r.content[0].text;
};
const tail = (text) => JSON.parse(/```json\n([\s\S]*?)\n```\s*$/.exec(text)[1]);

async function projectWithLessons({ enabled = true } = {}) {
  const repo = makeRepo();
  const enable = JSON.parse(await ok("postmortem", { action: "enable", project: repo.root, reason: "retrospectives please" }));
  const key = enable.project;
  addLessons(key, [
    { kind: "rule", target: "project", text: "Run the responsive check before submitting layout work", pm: "pm-aaaaaaaa", findings: ["pmf-1"] },
    { kind: "agent_rule", target: "Builder", text: "Resize the window in every layout test", pm: "pm-aaaaaaaa", findings: ["pmf-1"] },
    { kind: "agent_rule", target: "tester", text: "Never skip the nightly suite", pm: "pm-aaaaaaaa", findings: ["pmf-2"] },
    { kind: "contract_rule", target: "project", text: "State the supported breakpoints in the acceptance criteria", pm: "pm-aaaaaaaa", findings: ["pmf-1"] },
    { kind: "flag", target: "project", flag: true, text: "the brief said responsive and the builder read desktop only. Clearer: list the breakpoints", pm: "pm-aaaaaaaa", findings: ["pmf-1"] },
  ]);
  if (!enabled) await ok("postmortem", { action: "disable", project: repo.root, reason: "no more please" });
  return { repo, key };
}

const explicit = () => ({
  tasks: [
    { id: "api", title: "Orders API", persona: cfo, paths: { write: ["src/api/**"] }, acceptance: ["GET /orders works"], checks: ["test"] },
    { id: "ui", title: "Orders page", persona: skeptic, depends_on: ["api"], paths: { write: ["src/ui/**"] }, acceptance: ["renders orders"], checks: ["test"] },
  ],
  validation: { commands: [{ id: "test", argv: ["npm", "test"], timeout_s: 60 }] },
  decisions: [{ id: "d1", text: "REST, not GraphQL" }],
  budget: { usd: 10, per_task_usd: 5, wall_clock_min: 30 },
});
const propose = async (repo) =>
  tail(await ok("propose_contract", { goal: "Ship the orders page", orchestrator: "main", original_prompt: "please ship the orders page", repo_dir: repo.root, contract: explicit(), ...LLM }));

test("propose_contract carries the project's opt-in and turns lessons into decisions and warnings without refusing", async () => {
  const { repo } = await projectWithLessons();
  const out = await propose(repo);
  assert.equal(out.status, "draft");
  assert.ok(out.warnings.some((w) => /^Earlier work misread the brief said responsive.*; state it explicitly \(postmortem pm-aaaaaaaa\)$/.test(w)), out.warnings.join("\n"));
  assert.equal(out.postmortem_lessons.contract_rules.length, 1);
  assert.equal(out.postmortem_lessons.flags.length, 1);
  assert.equal(out.postmortem_lessons.rules, 1);
  assert.equal(out.postmortem_lessons.agent_rules, 2);
  const contract = JSON.parse(readFileSync(out.files.json, "utf8"));
  assert.deepEqual(contract.postmortem, { enabled: true });
  const rule = contract.decisions.find((d) => d.by === "postmortem:pm-aaaaaaaa");
  assert.ok(rule, "a decision for the contract rule");
  assert.equal(rule.scope, "contract");
  assert.match(rule.text, /State the supported breakpoints/);
  assert.ok(contract.decisions.some((d) => d.id === "d1"), "the contract's own decisions stay");
  assert.equal(contract.decisions.length, 2, "flags and plain rules are not decisions");
  // The flag is part of the consent hash like any other contract field.
  const { postmortem: _p, ...without } = contract;
  assert.notEqual(contractHash(contract), contractHash(without));
});

test("lessons are read when the mode is off now, and a project without lessons or opt-in gets neither", async () => {
  const off = await projectWithLessons({ enabled: false });
  const out = await propose(off.repo);
  const contract = JSON.parse(readFileSync(out.files.json, "utf8"));
  assert.equal(contract.postmortem, undefined, "no flag when the mode is off");
  assert.equal(out.postmortem_lessons.contract_rules.length, 1, "but the lessons that were learned are read");
  assert.ok(contract.decisions.some((d) => d.by === "postmortem:pm-aaaaaaaa"));
  const plain = tail(await ok("propose_contract", { goal: "Ship it", orchestrator: "main", original_prompt: "ship it", repo_dir: makeRepo().root, contract: explicit(), ...LLM }));
  assert.equal(plain.postmortem_lessons, undefined);
  assert.equal(JSON.parse(readFileSync(plain.files.json, "utf8")).postmortem, undefined);
  assert.ok(!plain.warnings.some((w) => /Earlier work misread/.test(w)));
});

test("a contract's postmortem field is validated", () => {
  const base = { schema: "roundtable.contract/1" };
  const bad = checkContract({ ...base, postmortem: { enabled: "yes" } });
  assert.ok(bad.errors.some((e) => /postmortem.enabled must be true or false/.test(e)));
  assert.ok(checkContract({ ...base, postmortem: { enabled: true, extra: 1 } }).errors.some((e) => /postmortem.extra is not a known field/.test(e)));
  const good = checkContract({ ...base, postmortem: { enabled: true } });
  assert.ok(!good.errors.some((e) => /postmortem/.test(e)));
  assert.deepEqual(good.contract.postmortem, { enabled: true });
  assert.equal(checkContract({ ...base, postmortem: { enabled: false } }).contract.postmortem, undefined, "off is the absence of the field");
});

test("start_ultraplan with repo_dir appends a bounded lessons section to the planners' context, misreadings first", async (t) => {
  const { repo, key } = await projectWithLessons();
  const seen = [];
  stubFetch(t, async (url, init) => {
    assert.ok(url.startsWith(BASE));
    seen.push(JSON.parse(init.body).messages[1].content);
    return json(200, { choices: [{ message: { content: "Input from the agent." } }] });
  });
  await ok("start_ultraplan", { agents: [cfo], task: "Plan the orders page", context: "Our users are on phones.", repo_dir: repo.root, ...LLM });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Our users are on phones\./);
  const at = seen[0].indexOf("## Lessons from past postmortems");
  assert.ok(at > 0);
  const section = seen[0].slice(at);
  assert.ok(section.indexOf("Earlier work misread these") < section.indexOf("Rules the team agreed"), "flags first");
  assert.match(section, /list the breakpoints/);
  assert.match(section, /Run the responsive check before submitting layout work/);
  assert.match(section, /\[Builder\] Resize the window/);
  // Nothing is added without repo_dir, or for a project without lessons.
  seen.length = 0;
  await ok("start_ultraplan", { agents: [cfo], task: "Plan it", ...LLM });
  await ok("start_ultraplan", { agents: [cfo], task: "Plan it", repo_dir: makeRepo().root, ...LLM });
  assert.ok(seen.every((x) => !x.includes("Lessons from past postmortems")));
  // Bounded: a hundred flags still fit in 3000 characters and say how many were left out.
  addLessons(key, Array.from({ length: 100 }, (_, i) => ({ kind: "flag", target: "project", flag: true, text: `misreading number ${i} ${"x".repeat(200)}`, pm: "pm-bbbbbbbb", findings: [`pmf-${i}`] })));
  const big = ultraplanSection(repo.root);
  assert.ok(big.length <= 3000, String(big.length));
  assert.match(big, /and \d+ more/);
  assert.equal(ultraplanSection(makeRepo().root), "");
});

test("task cards carry the project's rules and the persona's own agent rules, capped at 4 KB, before the protocol", async () => {
  const { repo, key } = await projectWithLessons();
  const run = await makeRun({ contract: { tasks: [task("api"), task("review", { persona: "tester" })] } });
  const state = await run.store.state();
  state.contract.scope.repo_root = repo.root;
  const builderCard = buildTaskCard(state, "api", cardLessons(state, "api"));
  assert.match(builderCard, /## Lessons from earlier postmortems/);
  assert.match(builderCard, /Run the responsive check before submitting layout work \(this project, postmortem pm-aaaaaaaa\)/);
  assert.match(builderCard, /Resize the window in every layout test \(for you, postmortem pm-aaaaaaaa\)/);
  assert.ok(!builderCard.includes("Never skip the nightly suite"), "another persona's rule");
  assert.ok(!builderCard.includes("State the supported breakpoints"), "contract rules are for contracts");
  assert.ok(builderCard.indexOf("## Lessons from earlier postmortems") < builderCard.indexOf("## Protocol"));
  const testerCard = buildTaskCard(state, "review", cardLessons(state, "review"));
  assert.match(testerCard, /Never skip the nightly suite/);
  assert.ok(!testerCard.includes("Resize the window in every layout test"));
  // No lessons, no section.
  state.contract.scope.repo_root = makeRepo().root;
  assert.deepEqual(cardLessons(state, "api"), {});
  assert.ok(!buildTaskCard(state, "api", cardLessons(state, "api")).includes("Lessons from earlier"));
  // Capped.
  addLessons(key, Array.from({ length: 80 }, (_, i) => ({ kind: "rule", target: "project", text: `rule ${i} ${"y".repeat(300)}`, pm: "pm-cccccccc", findings: [] })));
  const capped = cardSection(repo.root, "builder");
  assert.ok(capped.length <= 4096, String(capped.length));
  assert.match(capped, /and \d+ more/);
});

test("lessons supersede restatements, stay newest first, and postmortem(action: lessons) returns the active ones", async () => {
  const { repo, key } = await projectWithLessons();
  const [again] = addLessons(key, [{ kind: "rule", target: "project", text: "Run the responsive  check before submitting layout work", pm: "pm-dddddddd", findings: ["pmf-9"] }]);
  const all = loadLessons(key);
  assert.equal(all[0].id, again.id, "newest first");
  const old = all.find((l) => l.pm === "pm-aaaaaaaa" && l.kind === "rule");
  assert.equal(old.superseded_by, again.id, "the restated lesson stays, marked superseded");
  assert.equal(activeLessons(key).filter((l) => l.kind === "rule").length, 1);
  const view = JSON.parse(await ok("postmortem", { action: "lessons", project: repo.root }));
  assert.equal(view.project, key);
  assert.equal(view.rules.length, 1);
  assert.equal(view.rules[0].pm, "pm-dddddddd");
  assert.deepEqual(view.flags.map((l) => l.kind), ["flag"]);
  assert.equal(view.contract_rules.length, 1);
  assert.equal(view.agent_rules.length, 2);
  assert.equal(view.postmortem_mode, "on");
  assert.match(readFileSync(lessonsPath(key), "utf8"), /superseded_by/);
  assert.equal(contractLessons(makeRepo().root), undefined);
});
