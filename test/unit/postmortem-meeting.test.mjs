// Postmortem mode (WS14): seats, formats, the bounded context, artifacts, conclude and the no-outside-input rule.
// Provider calls are faked through fetch (an openai_compatible endpoint), as in the collaboration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo } from "../fixtures/execution/git-fixture.mjs";
import { makeRun, runner, task } from "../fixtures/workers/run.mjs";
import { json, stubFetch } from "./helpers.mjs";

const { handleToolCall } = await import("../../dist/tools.js");
const { AGENTS_DIR, AUDIT_DIR } = await import("../../dist/config.js");
const { collaborations } = await import("../../dist/sessions/collaborations.js");
const { readActivity } = await import("../../dist/activity.js");
const { loadRecord, loadLessons, recordPath, projectDir } = await import("../../dist/postmortem/store.js");
const { parseArtifactBlock } = await import("../../dist/postmortem/artifacts.js");
const { appendPersonaAddendum } = await import("../../dist/agent-files.js");
const { buildPostmortemContext, withholdHumanWords } = await import("../../dist/postmortem/context.js");

const BASE = "http://localhost:4141/v1";
const LLM = { provider: "openai_compatible", model: "test", base_url: BASE };
const ok = async (name, args) => {
  const r = await handleToolCall(name, args);
  assert.equal(r.isError, undefined, r.content[0].text);
  const text = r.content[0].text;
  return text.startsWith("{") ? JSON.parse(text) : text;
};
const fails = async (name, args) => {
  const r = await handleToolCall(name, args);
  assert.equal(r.isError, true, r.content[0].text);
  return r.content[0].text;
};

mkdirSync(AGENTS_DIR, { recursive: true });
const PERSONA = (name) => `---\nname: ${name}\ndescription: ${name} persona\n---\nYou are ${name}. PERSONA-${name.toUpperCase()}\n`;
for (const n of ["builder", "tester", "designer"]) writeFileSync(join(AGENTS_DIR, `${n}.md`), PERSONA(n[0].toUpperCase() + n.slice(1)));

const FINDING = { summary: "The nav bar ignored the mobile breakpoint", detected_by: "check unit", responsible: ["builder"], category: "implementation" };

async function enabled(repo = makeRepo()) {
  await ok("postmortem", { action: "enable", project: repo.root, reason: "Yes, let's hold postmortem meetings for this project" });
  return repo;
}

/**
 * Fake the provider. `reply({system, user, index, persona})` returns the turn text; the default is a
 * short turn, and `block` (text) is appended to the turn number `last`.
 */
function provider(t, { total, block = "", reply } = {}) {
  const requests = [];
  stubFetch(t, async (url, init) => {
    assert.ok(url.startsWith(BASE), `unexpected request: ${url}`);
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const index = requests.length;
    requests.push({ system, user, index });
    const persona = /PERSONA-([A-Z]+)/.exec(system)?.[1]?.toLowerCase() ?? "unknown";
    let content = reply ? await reply({ system, user, index, persona }) : `Turn ${index} from ${persona}.`;
    if (total !== undefined && index === total - 1) content += `\n\n${block}`;
    return json(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
  return requests;
}

const artifactBlock = (ids, extra = "") =>
  [
    `Artifact: rule | project | ${ids[0]} | Check the mobile breakpoint before submitting any layout work`,
    `Artifact: persona_addendum | builder | ${ids[0]} | Run the responsive check before you submit`,
    `Artifact: agent_rule | tester | ${ids.join(", ")} | Always resize the window in layout tests`,
    `Artifact: contract_rule | project | ${ids[0]} | State the supported breakpoints in the acceptance criteria`,
    `Artifact: memory | builder | ${ids[0]} | The nav bar lives in src/components/nav`,
    `Artifact: fix | src/components/nav/index.js | ${ids[0]} | Add the breakpoint test to the nav suite`,
    extra,
  ].join("\n");

async function atTheTable(t, { work = "checkout redesign", responsible = [["builder"]], rounds = 1, participants = ["tester"], reply, fixed = true } = {}) {
  const repo = await enabled();
  const ids = [];
  for (const [i, who] of responsible.entries()) {
    const r = await ok("postmortem", { action: "record", project: repo.root, work, finding: { ...FINDING, summary: `${FINDING.summary} (${i})`, responsible: who } });
    ids.push(r.recorded);
    if (fixed) await ok("postmortem", { action: "fix", project: repo.root, work, finding_id: r.recorded, fix: { status: "fixed", by: who[0] } });
  }
  return { repo, ids, work, rounds, participants };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a meeting is refused while a fix is pending, naming it; an empty draft closes with no meeting", async (t) => {
  const { repo, ids, work } = await atTheTable(t, { fixed: false });
  const requests = provider(t);
  const msg = await fails("hold_postmortem", { project: repo.root, work, opening: "What happened", ...LLM });
  assert.match(msg, /refused/);
  assert.match(msg, new RegExp(ids[0]));
  assert.match(msg, /fix still pending/);
  assert.equal(requests.length, 0, "no provider call");
  const none = await ok("hold_postmortem", { project: repo.root, work: "nothing recorded here", opening: "x", ...LLM });
  assert.equal(none.status, "nothing_to_learn");
  assert.equal(requests.length, 0);
});

test("a run's meeting is refused while a task with a finding is not terminal; the error names the task", async (t) => {
  const run = await makeRun({ contract: { postmortem: { enabled: true } } });
  await enabled(run);
  const f = await ok("postmortem", { action: "record", project: run.root, execution_id: run.store.id, finding: { ...FINDING, task: "api" } });
  await ok("postmortem", { action: "fix", project: run.root, execution_id: run.store.id, finding_id: f.recorded, fix: { status: "fixed" } });
  const requests = provider(t);
  const msg = await fails("hold_postmortem", { project: run.root, execution_id: run.store.id, opening: "What happened", ...LLM });
  assert.match(msg, /task with a finding is not finished \(api\)/);
  assert.equal(requests.length, 0);
});

test("a meeting needs two agents besides the orchestrator and loadable personas", async (t) => {
  const { repo, work } = await atTheTable(t, { participants: [] });
  provider(t);
  assert.match(await fails("hold_postmortem", { project: repo.root, work, opening: "x", ...LLM }), /at least two agents/);
  assert.match(await fails("hold_postmortem", { project: repo.root, work, opening: "x", participants: ["no-such-agent"], ...LLM }), /cannot be loaded as personas: no-such-agent/);
  assert.match(await fails("hold_postmortem", { project: repo.root, work, participants: ["tester"], ...LLM }), /"opening" is required/);
});

// ---------------------------------------------------------------------------
// The meeting
// ---------------------------------------------------------------------------

test("one responsible agent means a waffle-house with that agent as defender; the artifact block is read from the last turn only", async (t) => {
  const { repo, ids, work } = await atTheTable(t);
  // waffle-house with 2 agents and 1 round: the defender opens, then one volley of two turns
  const requests = provider(t, {
    total: 3,
    block: [
      artifactBlock([ids[0]]),
      "> Artifact: rule | project | " + ids[0] + " | quoted from another seat, so ignored",
      "```",
      `Artifact: rule | project | ${ids[0]} | inside a fence, so ignored`,
      "```",
      `Artifact: rule | nowhere | ${ids[0]} | bad target`,
      "Artifact: rule | project | pmf-doesnotexist | unknown finding",
      `Artifact: wish | project | ${ids[0]} | bad kind`,
    ].join("\n"),
  });
  const out = await ok("hold_postmortem", { project: repo.root, work, opening: "I wrote the brief too loosely and the builder missed the breakpoint.", participants: ["tester"], rounds: 1, ...LLM });
  assert.equal(out.status, "held");
  assert.equal(out.format, "waffle-house");
  assert.deepEqual(out.seats, ["orchestrator", "builder", "tester"]);
  assert.equal(requests.length, 3);
  assert.match(requests[0].system, /PERSONA-BUILDER/, "the defender speaks first");
  assert.match(requests[0].user, /defender/);
  assert.match(requests[0].user, /charge/);
  assert.match(requests[0].user, /I wrote the brief too loosely/, "the orchestrator's opening is in the context");
  assert.match(requests[0].user, new RegExp(ids[0]));
  assert.match(requests[0].user, /blameless/);
  assert.deepEqual(out.transcript.map((x) => x.seat), ["orchestrator", "builder", "tester", "builder"]);
  assert.deepEqual(out.proposed_artifacts.map((a) => `${a.id}:${a.kind}:${a.target}`), ["a1:rule:project", "a2:persona_addendum:builder", "a3:agent_rule:tester", "a4:contract_rule:project", "a5:memory:builder", "a6:fix:src/components/nav/index.js"]);
  assert.equal(out.rejected_lines.length, 3, JSON.stringify(out.rejected_lines));
  assert.match(out.rejected_lines.join("\n"), /rule targets "project"/);
  assert.match(out.rejected_lines.join("\n"), /unknown finding id pmf-doesnotexist/);
  assert.match(out.rejected_lines.join("\n"), /unknown kind/);
  assert.ok(!out.rejected_lines.join("\n").includes("quoted from another seat"), "blockquotes and fences are not artifact lines");
  // The record is on disk, private, and holds every turn.
  const rec = loadRecord(out.project, out.pm);
  assert.equal(rec.status, "held");
  assert.equal(rec.transcript.length, 3);
  assert.equal(statSync(recordPath(out.project, out.pm)).mode & 0o777, 0o600);
  const md = readFileSync(recordPath(out.project, out.pm, "md"), "utf8");
  assert.match(md, /Turn 0 from builder/);
  assert.match(md, /Turn 2 from builder/);
  assert.equal(existsSync(join(projectDir(out.project), "postmortems", "drafts", `${out.pm}.json`)), false, "the draft is consumed");
  const read = await ok("postmortem", { action: "read", pm: out.pm });
  assert.equal(read, md);
  assert.match((await ok("postmortem", { action: "list", project: repo.root })).postmortems[0].status, /held/);
  // Activity carries the origin.
  assert.ok(readActivity().some((e) => e.origin === `postmortem:${out.pm}` && e.kind === "collaboration"));
});

test("findings with different responsible agents run a collaborate meeting, the most responsible first; a format can be forced", async (t) => {
  const { repo, ids, work } = await atTheTable(t, { responsible: [["tester"], ["builder", "tester"], ["orchestrator"]] });
  const requests = provider(t, { total: 4, block: artifactBlock([ids[0]]) });
  const out = await ok("hold_postmortem", { project: repo.root, work, opening: "We shipped too fast", participants: ["designer"], rounds: 1, ...LLM });
  assert.equal(out.format, "collaborate");
  assert.deepEqual(out.seats, ["orchestrator", "tester", "builder", "designer"]);
  assert.equal(requests.length, 3 * 1, "3 agents, 1 round");
  assert.match(requests[0].system, /PERSONA-TESTER/);
  assert.match(out.next, /conclude/);
  const forced = await atTheTable(t, { work: "forced", responsible: [["builder"]] });
  const r2 = provider(t, { total: 2 });
  const f = await ok("hold_postmortem", { project: forced.repo.root, work: "forced", opening: "again", participants: ["tester"], format: "collaborate", rounds: 1, ...LLM });
  assert.equal(f.format, "collaborate");
  assert.equal(r2.length, 2);
  assert.deepEqual(f.proposed_artifacts, []);
  assert.ok(f.warnings.some((w) => /no artifact block/.test(w)));
});

test("a run's meeting seats the registered agents' personas, records its events and usage, and never carries the human's words", async (t) => {
  const run = await makeRun({ start: false, contract: { postmortem: { enabled: true }, tasks: [task("api"), task("ui", { persona: "tester" })] } });
  const confirmation = "yes, build the whole checkout flow with the big red button please";
  await run.store.transact(() => ({
    events: [
      { type: "execution.started", source: runner, payload: { confirmation, visibility: { dashboard: false, chat_only: true }, budget: run.contract.budget, lead: "lead", sandbox: "local", drivers: ["claude-code"] } },
      { type: "agent.registered", source: runner, payload: { agent: "w1", persona: "builder", driver: "claude-code", token_sha256: "t".repeat(64), external: false } },
      { type: "agent.registered", source: runner, payload: { agent: "w2", persona: "tester", driver: "claude-code", token_sha256: "u".repeat(64), external: false } },
    ],
  }));
  await enabled(run);
  const exe = run.store.id;
  const a = await ok("postmortem", { action: "record", project: run.root, execution_id: exe, finding: { ...FINDING, task: "api", category: "prompt_misread", summary: "The brief said responsive; the builder read it as desktop only" } });
  const b = await ok("postmortem", { action: "record", project: run.root, execution_id: exe, finding: { ...FINDING, task: "ui", responsible: ["tester"], category: "test_gap", summary: "No layout test existed" } });
  assert.equal(b.ready, false);
  await run.store.transact(() => ({
    events: [
      { type: "task.merged", source: runner, payload: { task: "api", integration_sha: "a".repeat(40) } },
      { type: "task.merged", source: runner, payload: { task: "ui", integration_sha: "b".repeat(40) } },
    ],
  }));
  const ready = await ok("postmortem", { action: "draft", project: run.root, execution_id: exe });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.pending_fixes, []);

  const requests = provider(t, { total: 4, block: artifactBlock([a.recorded, b.recorded]) });
  const opening = `The human asked: ${run.contract.goal.original_prompt} and then said "${confirmation}". We built it too fast.`;
  const out = await ok("hold_postmortem", { project: run.root, execution_id: exe, opening, rounds: 2, ...LLM });
  assert.equal(out.format, "collaborate");
  assert.deepEqual(out.seats, ["orchestrator", "builder", "tester"]);
  assert.equal(requests.length, 4);
  const everything = requests.map((r) => `${r.system}\n${r.user}`).join("\n=====\n");
  assert.ok(!everything.includes(run.contract.goal.original_prompt), "the original prompt never reaches a seat");
  assert.ok(!everything.includes(confirmation), "the confirmation never reaches a seat");
  assert.match(everything, /Ship the test app/, "the contract's goal does");
  assert.match(everything, /the human's words, withheld/);
  assert.match(everything, /Task cards of the affected tasks/);
  assert.match(everything, /Task api/);
  assert.ok(!readFileSync(recordPath(out.project, out.pm, "md"), "utf8").includes(confirmation), "nor the record");
  assert.ok(!JSON.stringify(out).includes(confirmation));

  const events = await run.store.events({ types: ["postmortem.started", "budget.usage_recorded"] });
  const started = events.find((e) => e.type === "postmortem.started");
  assert.deepEqual(started.payload, { id: out.pm, format: "collaborate", seats: ["orchestrator", "builder", "tester"] });
  assert.ok(events.filter((e) => e.type === "budget.usage_recorded").length >= 4, "the meeting's usage is on the run's ledger");
  const state = await run.store.state();
  assert.equal(state.postmortem.meetings[out.pm].format, "collaborate");
  assert.equal(state.postmortem.findings[a.recorded].pm, out.pm, "the meeting covers the findings");
  const after = await ok("postmortem", { action: "draft", project: run.root, execution_id: exe });
  assert.deepEqual(after.findings, [], "a new draft starts empty");
});

// ---------------------------------------------------------------------------
// Conclude
// ---------------------------------------------------------------------------

test("conclude applies only the accepted artifacts, with a backup, audit entries and lessons; flagged findings become lessons", async (t) => {
  const run = await makeRun({ start: false, contract: { postmortem: { enabled: true } } });
  await enabled(run);
  const exe = run.store.id;
  await run.store.transact(() => ({
    events: [
      { type: "execution.started", source: runner, payload: { confirmation: "go ahead", visibility: { dashboard: false, chat_only: true }, budget: run.contract.budget, lead: "lead", sandbox: "local", drivers: ["claude-code"] } },
    ],
  }));
  const f = await ok("postmortem", { action: "record", project: run.root, execution_id: exe, finding: { ...FINDING, task: "api", category: "contract_ambiguity", summary: "acceptance said fast; nobody knew how fast" } });
  await run.store.transact(() => ({ events: [{ type: "task.merged", source: runner, payload: { task: "api", integration_sha: "a".repeat(40) } }, { type: "task.failed", source: runner, payload: { task: "build-nav-bar", why: "x" } }] }));
  provider(t, { total: 3, block: artifactBlock([f.recorded]) });
  const held = await ok("hold_postmortem", { project: run.root, execution_id: exe, opening: "my part: I wrote 'fast' without a number", participants: ["tester"], rounds: 1, ...LLM });
  assert.equal(held.format, "waffle-house");
  const before = readFileSync(join(AGENTS_DIR, "builder.md"), "utf8");
  const lessonsBefore = loadLessons(held.project).length;

  assert.match(await fails("hold_postmortem", { action: "conclude", pm: held.pm, closing: "done", accept: ["a99"] }), /unknown artifact id a99/);
  assert.match(await fails("hold_postmortem", { action: "conclude", pm: held.pm, closing: "done", accept: ["a1"], reject: [{ id: "a1", why: "no" }] }), /both accept and reject/);
  assert.equal(loadLessons(held.project).length, lessonsBefore, "a refused conclude changes nothing");

  const done = await ok("hold_postmortem", {
    action: "conclude", pm: held.pm, closing: "Agreed. We state numbers from now on.",
    accept: ["a1", "a2", "a4", "a6"], reject: [{ id: "a3", why: "the tester already does this" }],
  });
  assert.equal(done.status, "concluded");
  assert.deepEqual(done.accepted, ["a1", "a2", "a4", "a6"]);
  assert.deepEqual(done.rejected, [{ id: "a3", why: "the tester already does this" }]);
  assert.deepEqual(done.not_accepted, ["a5"], "a5 (memory) was neither accepted nor rejected, so it did not apply");
  assert.deepEqual(done.follow_ups.map((x) => x.id), ["a6"]);
  assert.equal(done.flagged.length, 1);
  assert.equal(done.flagged[0].category, "contract_ambiguity");
  assert.match(done.flagged[0].clearer, /Check the mobile breakpoint/);
  assert.match(done.summary, /you were not at the table/);
  assert.match(done.tell_the_human, /record is at/);

  // The persona got its addendum; the copy before it is next to it; the frontmatter is untouched.
  const after = readFileSync(join(AGENTS_DIR, "builder.md"), "utf8");
  assert.ok(after.startsWith(before.slice(0, before.indexOf("You are"))), "frontmatter preserved byte for byte");
  assert.match(after, /## Postmortem addenda\n\n- Run the responsive check before you submit \(postmortem pm-/);
  const backups = readdirSync(AGENTS_DIR).filter((n) => n.startsWith("builder.md.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(AGENTS_DIR, backups[0]), "utf8"), before);
  assert.equal(statSync(join(AGENTS_DIR, "builder.md")).mode & 0o777, statSync(join(AGENTS_DIR, backups[0])).mode & 0o777, "the mode is kept");
  // Lessons: the accepted rule and contract rule, plus the flag. The rejected agent rule is not there.
  const lessons = loadLessons(held.project);
  assert.deepEqual(lessons.map((l) => l.kind).sort(), ["contract_rule", "flag", "rule"]);
  assert.ok(!lessons.some((l) => l.kind === "agent_rule"));
  assert.ok(lessons.every((l) => l.pm === held.pm));
  // The memory artifact was not accepted, so nothing was written.
  assert.equal(existsSync(join(projectDir(held.project), "memory")), false);
  // Audit: one postmortem.applied per accepted artifact, with the artifact's hash and the target path.
  const audit = readdirSync(AUDIT_DIR).map((n) => readFileSync(join(AUDIT_DIR, n), "utf8")).join("\n").split("\n").filter((l) => l.includes("postmortem.applied") && l.includes(held.pm));
  assert.equal(audit.length, 4);
  assert.ok(audit.some((l) => l.includes(join(AGENTS_DIR, "builder.md")) && /"hash":"[0-9a-f]{64}"/.test(l)));
  // The run's log records the conclusion with counts, and the record blob holds the readable record.
  const concluded = (await run.store.events({ types: ["postmortem.concluded"] }))[0];
  assert.deepEqual(concluded.payload.artifacts, { rule: 1, persona_addendum: 1, contract_rule: 1, fix: 1 });
  assert.equal(concluded.payload.flagged, 1);
  assert.match((await run.store.getBlob(concluded.payload.record)).toString("utf8"), /Agreed\. We state numbers from now on\./);
  assert.equal((await run.store.state()).postmortem.meetings[held.pm].concluded.flagged, 1);
  // The record on disk shows statuses and the closing statement.
  const md = await ok("postmortem", { action: "read", pm: held.pm });
  assert.match(md, /rejected: the tester already does this/);
  assert.match(md, /Agreed\. We state numbers from now on\./);
  // Concluding again returns the same conclusion and writes nothing more.
  const again = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "again", accept: ["a5"] });
  assert.equal(again.already_concluded, true);
  assert.equal(readFileSync(join(AGENTS_DIR, "builder.md"), "utf8"), after);
  assert.equal(readdirSync(AGENTS_DIR).filter((n) => n.startsWith("builder.md.bak-")).length, 1);
  assert.equal((await run.store.events({ types: ["postmortem.concluded"] })).length, 1);
});

test("a persona seated by path gets its addendum in that file, and a persona addendum for a seat that cannot be written is reported", async (t) => {
  const { WORKSPACE_DIR } = await import("../../dist/config.js");
  const dir = join(WORKSPACE_DIR, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const scout = join(dir, "scout.md");
  writeFileSync(scout, PERSONA("Scout"));
  const { repo, ids, work } = await atTheTable(t, { participants: [scout] });
  provider(t, { total: 3, block: `Artifact: persona_addendum | scout | ${ids[0]} | Say what you skipped\nArtifact: persona_addendum | builder | ${ids[0]} | Read the brief twice` });
  const held = await ok("hold_postmortem", { project: repo.root, work, opening: "x", participants: [scout], rounds: 1, ...LLM });
  assert.deepEqual(held.seats, ["orchestrator", "builder", "scout"]);
  // Make the builder persona unreadable as a persona (damaged frontmatter): that artifact fails, the other still lands.
  const builder = join(AGENTS_DIR, "builder.md");
  const good = readFileSync(builder, "utf8");
  const copies = () => readdirSync(AGENTS_DIR).filter((n) => n.startsWith("builder.md.bak-")).length;
  const copiesBefore = copies();
  writeFileSync(builder, "---\ndescription:\n   indented: [unclosed\n---\nBody");
  const done = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "ok", accept: ["a1", "a2"] });
  writeFileSync(builder, good);
  assert.match(readFileSync(scout, "utf8"), /## Postmortem addenda\n\n- Say what you skipped \(postmortem pm-/);
  assert.equal(done.warnings.length, 1);
  assert.match(done.warnings[0], /a2 \(persona_addendum → builder\) was accepted but not applied: Claude Code cannot parse the frontmatter/);
  assert.match(done.applied.find((a) => a.id === "a2").note, /^failed/);
  assert.equal(copies(), copiesBefore, "nothing was copied or changed");
  assert.match(readFileSync(recordPath(held.project, held.pm, "md"), "utf8"), /accepted, not applied/);
});

test("a responsible agent that is seated by path (outside the agents directory) is loaded from that path", async (t) => {
  const { WORKSPACE_DIR } = await import("../../dist/config.js");
  const dir = join(WORKSPACE_DIR, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const ranger = join(dir, "ranger.md");
  writeFileSync(ranger, PERSONA("Ranger"));
  const { repo, ids, work } = await atTheTable(t, { responsible: [["ranger"]] });
  const requests = provider(t, { total: 3, block: `Artifact: persona_addendum | ranger | ${ids[0]} | Check the trail twice` });
  const held = await ok("hold_postmortem", { project: repo.root, work, opening: "x", participants: [ranger, "tester"], rounds: 1, ...LLM });
  assert.equal(held.format, "waffle-house");
  assert.match(requests[0].system, /PERSONA-RANGER/, "the defender was loaded from its path");
  await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "ok", accept: ["a1"] });
  assert.match(readFileSync(ranger, "utf8"), /Check the trail twice/);
});

test("a damaged lessons.json fails conclude before any file is written; a differently spelled participant does not replace a working seat", async (t) => {
  const { lessonsPath } = await import("../../dist/postmortem/store.js");
  const { repo, ids, work } = await atTheTable(t, { responsible: [["builder", "tester"]] });
  provider(t, { total: 2, block: `Artifact: persona_addendum | builder | ${ids[0]} | Never ship untested\nArtifact: rule | project | ${ids[0]} | A rule` });
  // "Tester" is another spelling of the seat "tester": the working bare key stays (a file named Tester.md may not exist).
  const held = await ok("hold_postmortem", { project: repo.root, work, opening: "x", participants: ["Tester"], rounds: 1, ...LLM });
  assert.deepEqual(held.seats, ["orchestrator", "builder", "tester"]);
  assert.equal(loadRecord(held.project, held.pm).refs.tester, "tester");
  const before = readFileSync(join(AGENTS_DIR, "builder.md"), "utf8");
  const auditCount = () => readdirSync(AUDIT_DIR).map((n) => readFileSync(join(AUDIT_DIR, n), "utf8")).join("\n").split("\n").filter((l) => l.includes(held.pm)).length;
  const audits = auditCount();
  mkdirSync(join(lessonsPath(held.project), ".."), { recursive: true });
  writeFileSync(lessonsPath(held.project), "{ not json");
  assert.match(await fails("hold_postmortem", { action: "conclude", pm: held.pm, closing: "ok", accept: ["a1", "a2"] }), /damaged/);
  assert.equal(readFileSync(join(AGENTS_DIR, "builder.md"), "utf8"), before, "no persona was written");
  assert.equal(auditCount(), audits);
  assert.equal(loadRecord(held.project, held.pm).status, "held");
  writeFileSync(lessonsPath(held.project), JSON.stringify({ v: 1, lessons: [] }));
  const done = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "ok", accept: ["a1", "a2"] });
  assert.equal(done.applied.length, 2);
  assert.equal(auditCount() - audits, 2, "each applied artifact is audited once");
});

test("hold_postmortem refuses when the project's mode is off, and finding.task must be a task id", async (t) => {
  const { repo, work } = await atTheTable(t);
  await ok("postmortem", { action: "disable", project: repo.root, reason: "stop" });
  provider(t);
  assert.match(await fails("hold_postmortem", { project: repo.root, work, opening: "x", participants: ["tester"], ...LLM }), /Postmortem mode is off/);
  const on = await enabled();
  assert.match(await fails("postmortem", { action: "record", project: on.root, work: "w", finding: { ...FINDING, task: "a`b" } }), /task/);
  assert.match(await fails("hold_postmortem", { project: on.root, work: "w", opening: "x", participants: ["x".repeat(201)], ...LLM }), /participants/);
});

test("memory artifacts go to the project's memory, and with memory_target claude into the repository, never through a link", async (t) => {
  const { repo, ids, work } = await atTheTable(t);
  provider(t, { total: 3, block: `Artifact: memory | builder | ${ids[0]} | The nav bar lives in src/components/nav\nArtifact: memory | tester | ${ids[0]} | Resize the window` });
  const held = await ok("hold_postmortem", { project: repo.root, work, opening: "x", participants: ["tester"], rounds: 1, memory_target: "claude", ...LLM });
  const done = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "ok", accept: ["a1", "a2"] });
  const mem = join(projectDir(held.project), "memory", "builder.md");
  assert.match(readFileSync(mem, "utf8"), /The nav bar lives in src\/components\/nav \(postmortem pm-/);
  assert.equal(statSync(mem).mode & 0o777, 0o600);
  const inRepo = join(repo.root, ".claude", "agent-memory", "builder", "MEMORY.md");
  assert.match(readFileSync(inRepo, "utf8"), /The nav bar lives in src\/components\/nav/);
  assert.ok(done.applied.every((a) => !a.note.startsWith("failed")));

  // .claude as a symbolic link out of the repository: the claude copy is refused, the project's memory still lands.
  const repo2 = await enabled();
  const outside = join(repo2.root, "..", `outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(repo2.root, ".claude"));
  const r = await ok("postmortem", { action: "record", project: repo2.root, work: "linked", finding: FINDING });
  await ok("postmortem", { action: "fix", project: repo2.root, work: "linked", finding_id: r.recorded, fix: { status: "fixed" } });
  provider(t, { total: 3, block: `Artifact: memory | builder | ${r.recorded} | linked note` });
  const held2 = await ok("hold_postmortem", { project: repo2.root, work: "linked", opening: "x", participants: ["tester"], rounds: 1, memory_target: "claude", ...LLM });
  const done2 = await ok("hold_postmortem", { action: "conclude", pm: held2.pm, closing: "ok", accept: ["a1"] });
  assert.match(done2.warnings[0], /symbolic link/);
  assert.equal(readdirSync(outside).length, 0, "nothing was written through the link");
  assert.deepEqual(done2.accepted, ["a1"]);
  assert.match(done2.applied[0].note, /^failed/);
  rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No outside input
// ---------------------------------------------------------------------------

test("a postmortem session takes no outside input and is not listed, while it runs and after", async (t) => {
  const { repo, ids, work } = await atTheTable(t);
  const seen = [];
  provider(t, {
    total: 3, block: artifactBlock([ids[0]]),
    reply: async ({ index }) => {
      if (index === 1) {
        const [live] = [...collaborations.values()];
        seen.push(live.id);
        for (const [tool, args] of [
          ["nudge_collaboration", { collaboration_id: live.id, message: "hello from the human" }],
          ["continue_collaboration", { collaboration_id: live.id }],
          ["say", { meeting_id: live.id, message: "hello" }],
          ["say_local", { meeting_id: live.id, message: "hello" }],
        ]) {
          const r = await handleToolCall(tool, args);
          assert.equal(r.isError, true, tool);
          assert.match(r.content[0].text, /postmortem meetings take no outside input/, tool);
        }
        const list = await handleToolCall("list_collaborations", {});
        assert.equal(list.content[0].text, "No active collaborations.");
        assert.equal(live.messages.some((m) => m.content.includes("hello from the human")), false);
      }
      return `Turn ${index}.`;
    },
  });
  const held = await ok("hold_postmortem", { project: repo.root, work, opening: "x", participants: ["tester"], rounds: 1, ...LLM });
  assert.equal(seen.length, 1);
  // After it has ended the id is still refused with the same reason.
  const msg = await fails("nudge_collaboration", { collaboration_id: seen[0], message: "late" });
  assert.match(msg, /postmortem meetings take no outside input/);
  assert.equal(loadRecord(held.project, held.pm).session, seen[0]);
});

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

test("artifact parsing: limits, targets and findings", () => {
  const ids = new Set(["pmf-aaaaaaaa"]);
  const seats = ["builder", "tester"];
  const line = (text, kind = "rule", target = "project") => `Artifact: ${kind} | ${target} | pmf-aaaaaaaa | ${text}`;
  const many = Array.from({ length: 23 }, (_, i) => line(`rule number ${i}`)).join("\n");
  const r = parseArtifactBlock(many, seats, ids);
  assert.equal(r.artifacts.length, 20);
  assert.equal(r.rejected.length, 3);
  assert.match(r.rejected[0], /over the limit of 20 artifacts/);
  assert.equal(parseArtifactBlock(line("x".repeat(601)), seats, ids).rejected.length, 1);
  assert.equal(parseArtifactBlock(line("x".repeat(600)), seats, ids).artifacts.length, 1);
  assert.match(parseArtifactBlock(line("t", "agent_rule", "nobody"), seats, ids).rejected[0], /must target a seat/);
  assert.match(parseArtifactBlock(line("t", "persona_addendum", "project"), seats, ids).rejected[0], /must target a seat/);
  assert.match(parseArtifactBlock("Artifact: rule | project | pmf-aaaaaaaa", seats, ids).rejected[0], /expected: Artifact/);
  assert.match(parseArtifactBlock("Artifact: rule | project | | no ids", seats, ids).rejected[0], /name at least one finding id/);
  assert.match(parseArtifactBlock(line("a fix", "fix", "two words"), seats, ids).rejected[0], /a fix targets a path or a task id/);
  // Text may contain the separator; duplicates collapse; markdown decoration on the label and a bullet are tolerated.
  const ok1 = parseArtifactBlock(`- **Artifact:** rule | project | pmf-aaaaaaaa | use a | b\n${line("use a | b")}`, seats, ids);
  assert.equal(ok1.artifacts.length, 1);
  assert.equal(ok1.artifacts[0].text, "use a | b");
  assert.match(ok1.artifacts[0].hash, /^[0-9a-f]{64}$/);
  // Secrets are scrubbed out of the text.
  assert.ok(!parseArtifactBlock(line("key tk_Abcdefghij0123456789"), seats, ids).artifacts[0].text.includes("tk_Abcdefghij"));
});

test("the human's words are withheld wherever the orchestrator's text repeats them", () => {
  const prompt = "Build me a checkout flow with a big red button\nand make it fast for mobile users";
  const out = withholdHumanWords(`He said: ${prompt}. Also "and make it fast for mobile users".`, [prompt]);
  assert.ok(!out.includes("big red button"));
  assert.ok(!out.includes("make it fast for mobile users"));
  assert.match(out, /withheld/);
  assert.equal(withholdHumanWords("short", ["go"]), "short");
  const ctx = buildPostmortemContext({
    scope: { work: "w" }, format: "collaborate", seats: ["builder", "tester"], opening: "x".repeat(5000),
    findings: Array.from({ length: 30 }, (_, i) => ({ id: `pmf-${String(i).padStart(8, "0")}`, at: "t", summary: "s".repeat(600), detected_by: "d", responsible: ["builder"], category: "process", fix: { status: "fixed" } })),
  });
  assert.ok(ctx.length <= 12_000, `the bundle is bounded (${ctx.length})`);
  assert.match(ctx, /How this postmortem runs/);
});

test("a persona addendum extends an existing section, is idempotent, keeps the mode, and refuses damaged frontmatter", () => {
  const dir = join(AGENTS_DIR, "..", "addenda");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "p.md");
  const text = "---\nname: P\n---\nBody.\n\n```\n## Postmortem addenda\n```\n\n## Postmortem addenda\n\n- first\n\n## Later\n\nMore.\n";
  writeFileSync(file, text, { mode: 0o640 });
  const r = appendPersonaAddendum(file, "- second", { timestamp: "20260101-000000" });
  assert.equal(r.changed, true);
  const now = readFileSync(file, "utf8");
  assert.ok(now.includes("- first\n- second\n"), now);
  assert.ok(now.includes("## Later\n\nMore."));
  assert.equal(readFileSync(r.backupPath, "utf8"), text);
  assert.equal(statSync(file).mode & 0o777, 0o640);
  const again = appendPersonaAddendum(file, "- second", { timestamp: "20260101-000001" });
  assert.equal(again.changed, false);
  assert.equal(readdirSync(dir).filter((n) => n.includes(".bak-")).length, 1);
  const bad = join(dir, "bad.md");
  writeFileSync(bad, "---\ndescription:\n   indented: [unclosed\n---\nBody");
  assert.throws(() => appendPersonaAddendum(bad, "- x", { timestamp: "20260101-000002" }), /Claude Code cannot parse the frontmatter/);
  assert.throws(() => appendPersonaAddendum(join(dir, "x.txt"), "- x", { timestamp: "t" }), /\.md/);
  const plain = join(dir, "plain.md");
  writeFileSync(plain, "No frontmatter here.\n");
  appendPersonaAddendum(plain, "- note", { timestamp: "20260101-000003" });
  assert.equal(readFileSync(plain, "utf8"), "No frontmatter here.\n\n## Postmortem addenda\n\n- note\n");
});

test("hold_postmortem and postmortem are listed with strict schemas on the orchestrator server only", async () => {
  const { tools, toolsFor } = await import("../../dist/tools.js");
  for (const name of ["postmortem", "hold_postmortem"]) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.title, "string");
    assert.equal(toolsFor("worker").some((x) => x.name === name), false);
  }
  assert.match(await fails("postmortem", { action: "enable", bogus: 1 }), /not a known|bogus/i);
  assert.match(await fails("hold_postmortem", { action: "conclude", pm: "pm-0123abcd" }), /"closing" is required/);
  assert.match(await fails("hold_postmortem", { action: "conclude", pm: "pm-0123abcd", closing: "x" }), /No held postmortem/);
});
