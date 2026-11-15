// Postmortem mode (WS14): seats, formats, the bounded context, artifacts, conclude and the no-outside-input rule.
// Provider calls are faked through fetch (an openai_compatible endpoint), as in the collaboration tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const { day, readTableLines } = await import("../../dist/usage/table.js");
const { collectUsage, filterView } = await import("../../dist/usage/model.js");
const { renderStatusline } = await import("../../dist/usage/statusline.js");

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
function provider(t, { total, block = "", reply, reportTokens = true } = {}) {
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
    return json(200, { choices: [{ message: { content } }], ...(reportTokens && { usage: { prompt_tokens: 100, completion_tokens: 20 } }) });
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

async function assertUsageSurfaces(view, filter, personas) {
  const args = { ...(filter.execution && { execution_id: filter.execution }), ...(filter.session && { session_id: filter.session }) };
  const tool = await ok("usage", args);
  const cli = filterView(JSON.parse(execFileSync(process.execPath, [new URL("../../dist/index.js", import.meta.url).pathname, "usage", "--json"], { encoding: "utf8" })), filter);
  for (const surface of [tool, cli]) {
    assert.deepEqual(surface.totals, view.totals);
    assert.deepEqual(surface.agents.filter((a) => a.tokens.input > 0).map((a) => a.id).sort(), [...personas].sort());
    assert.deepEqual(surface.agents.map((a) => a.calls), view.agents.map((a) => a.calls));
  }
  const statusline = renderStatusline(view, {}, { host: false, agents: 4, color: false, cols: 300 }).join("\n");
  assert.match(statusline, /estimated/);
  assert.doesNotMatch(statusline, /\[huddle\]/);
  if (filter.execution) for (const persona of personas) assert.ok(statusline.includes(persona), statusline);
  else assert.match(statusline, new RegExp(`table ${personas.length} agents?`));
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

test("a standalone postmortem records each persona's spend in the table ledger and usage surfaces", async (t) => {
  const { repo, work } = await atTheTable(t);
  provider(t);
  const out = await ok("hold_postmortem", { project: repo.root, work, opening: "We missed the breakpoint check.", participants: ["tester"], rounds: 1, ...LLM, model: "claude-sonnet-4" });
  const session = loadRecord(out.project, out.pm).session;
  const lines = readTableLines([day()]).filter((line) => line.session === session);
  assert.equal(lines.length, 3, "every provider call is retained once");
  assert.deepEqual(lines.map((line) => line.agent), ["builder", "tester", "builder"]);
  assert.ok(lines.every((line) => line.tokens_prov === "measured" && line.usd_prov === "estimated" && line.usd > 0));
  const view = filterView(await collectUsage({ executions: [] }), { session });
  assert.equal(view.totals.tokens.by.measured, 360);
  assert.ok(view.totals.estimated > 0);
  const report = await ok("usage", { session_id: session });
  assert.deepEqual(report.totals, view.totals);
  const cli = JSON.parse(execFileSync(process.execPath, [new URL("../../dist/index.js", import.meta.url).pathname, "usage", "--json"], { encoding: "utf8" }));
  assert.deepEqual(filterView(cli, { session }).totals, view.totals);
  const statusline = renderStatusline(view, {}, { host: false, agents: 4, color: false, cols: 200 }).join("\n");
  assert.match(statusline, /table 2 agents 360 tok meas/);
  assert.match(statusline, /estimated/);
});

for (const runBacked of [true, false]) {
  for (const { failureAt, reportTokens } of [{ failureAt: 0, reportTokens: true }, { failureAt: 1, reportTokens: true }, { failureAt: 1, reportTokens: false }]) {
    test(`${runBacked ? "run-backed" : "standalone"} postmortem retains ${reportTokens ? "reported" : "estimated"} spend and an estimated failed call at turn ${failureAt} across usage surfaces`, async (t) => {
      let scope;
      if (runBacked) {
        const run = await makeRun({ contract: { postmortem: { enabled: true } } });
        await enabled(run);
        scope = { project: run.root, execution_id: run.store.id };
        const finding = await ok("postmortem", { action: "record", ...scope, finding: FINDING });
        await ok("postmortem", { action: "fix", ...scope, finding_id: finding.recorded, fix: { status: "fixed" } });
      } else {
        const { repo, work } = await atTheTable(t);
        scope = { project: repo.root, work };
      }
      const before = readTableLines([day()]).length;
      const requests = provider(t, { reportTokens, reply: ({ index }) => {
        if (index === failureAt) throw new Error("scripted paid call failure");
        return "The breakpoint check was missing.";
      } });
      const error = await fails("hold_postmortem", { ...scope, opening: "We missed a layout check.", participants: ["tester"], rounds: 1, ...LLM, model: "claude-sonnet-4" });
      assert.match(error, /scripted paid call failure/);
      assert.equal(requests.length, failureAt + 1);
      assert.equal((await ok("postmortem", { action: "draft", ...scope })).findings.length, 1, "failure leaves the draft available to retry");
      let view;
      let filter;
      if (runBacked) {
        const { openExecutionStore } = await import("../../dist/execution/store.js");
        const store = await openExecutionStore(scope.execution_id);
        const events = await store.events({ types: ["budget.usage_recorded"] });
        assert.equal(events.length, failureAt + 1, "each attempted call is retained once");
        assert.ok(events.every((e) => e.payload.source === "postmortem" && e.correlation.startsWith("pm-")));
        assert.deepEqual(events.map((e) => e.payload.agent), ["builder", "tester"].slice(0, failureAt + 1));
        const failed = events.at(-1).payload;
        assert.ok(failed.usd > 0);
        assert.deepEqual(failed.provenance, { tokens: "estimated", usd: "estimated" });
        assert.equal((await store.events({ types: ["postmortem.started"] })).length, 0);
        assert.equal(readTableLines([day()]).length, before, "the execution and table ledgers do not charge the same call twice");
        filter = { execution: store.id };
        view = filterView(await collectUsage({ executions: [store.id], table: false }), filter);
      } else {
        const lines = readTableLines([day()]).slice(before);
        assert.equal(lines.length, failureAt + 1);
        assert.ok(lines.at(-1).usd > 0);
        assert.equal(lines.at(-1).tokens_prov, "estimated");
        assert.equal(lines.at(-1).usd_prov, "estimated");
        filter = { session: lines[0].session };
        view = filterView(await collectUsage({ executions: [] }), filter);
      }
      assert.equal(view.totals.tokens.by.measured, reportTokens ? failureAt * 120 : 0);
      assert.ok(view.totals.tokens.by.estimated > 0);
      assert.ok(view.totals.estimated > 0);
      await assertUsageSurfaces(view, filter, ["builder", "tester"].slice(0, failureAt + 1));
    });
  }
}

for (const meetingFails of [true, false]) {
  test(`a usage flush failure ${meetingFails ? "preserves the meeting error and is logged without secrets" : "propagates when the meeting succeeded"}`, async (t) => {
    const run = await makeRun({ contract: { postmortem: { enabled: true } } });
    await enabled(run);
    const scope = { project: run.root, execution_id: run.store.id };
    const finding = await ok("postmortem", { action: "record", ...scope, finding: FINDING });
    await ok("postmortem", { action: "fix", ...scope, finding_id: finding.recorded, fix: { status: "fixed" } });
    provider(t, { reply: () => {
      if (meetingFails) throw new Error("original meeting failure");
      return "The layout check was missing.";
    } });
    const secret = "tk_Abcdefghij0123456789";
    const proto = Object.getPrototypeOf(run.store);
    const transact = proto.transact;
    t.mock.method(proto, "transact", function (fn) {
      return transact.call(this, async (ctx) => {
        const result = await fn(ctx);
        if (result.events.some((e) => e.type === "budget.usage_recorded" && e.payload.source === "postmortem")) throw new Error(`usage flush unavailable ${secret}`);
        return result;
      });
    });
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
    const error = await fails("hold_postmortem", { ...scope, opening: "We missed a layout check.", participants: ["tester"], rounds: 1, ...LLM });
    if (meetingFails) {
      assert.match(error, /stopped: original meeting failure/);
      assert.doesNotMatch(error, /usage flush unavailable/);
      assert.match(logs.join("\n"), /usage flush unavailable/);
    } else {
      assert.match(error, /usage flush unavailable/);
    }
    assert.ok(!error.includes(secret) && !logs.join("\n").includes(secret));
  });
}

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
  const beforeTable = readTableLines([day()]).length;
  const out = await ok("hold_postmortem", { project: run.root, execution_id: exe, opening, rounds: 2, ...LLM, model: "claude-sonnet-4" });
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
  const charges = events.filter((e) => e.type === "budget.usage_recorded");
  assert.equal(charges.length, 4);
  assert.deepEqual(charges.map((e) => e.payload.agent), ["builder", "tester", "builder", "tester"]);
  assert.ok(charges.every((e) => e.payload.source === "postmortem" && e.correlation === out.pm));
  assert.ok(charges.every((e) => e.payload.provenance.tokens === "measured" && e.payload.provenance.usd === "estimated"));
  assert.equal(readTableLines([day()]).length, beforeTable, "run spend is not duplicated on the table ledger");
  const usage = await collectUsage({ executions: [exe], table: false });
  assert.equal(usage.totals.tokens.by.measured, 480);
  assert.ok(Math.abs(usage.totals.estimated - 0.0024) < 1e-9);
  assert.ok(!usage.agents.some((a) => a.id === "[huddle]"));
  await assertUsageSurfaces(usage, { execution: exe }, ["builder", "tester"]);
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

// WS14/WS16 integration: a finding proposes an assessment, acceptance uses the shared scorer,
// and replay/display consume exactly the existing dissent projection.
const dissentSpec = (id) => ({
  id, by: "builder", source: { kind: "manual" }, claim: `Concern ${id} \\| remains data`,
  predicted_failure: `Prediction ${id}`, tripwire: { kind: "task_state", task: "api", state: "blocked" }, on_fire: "notify",
});

test("postmortem persistence preserves auth-prefixed persona refs and dissent ids through conclusion", async (t) => {
  const { WORKSPACE_DIR } = await import("../../dist/config.js");
  const dir = join(WORKSPACE_DIR, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const reviewer = join(dir, "auth-reviewer.md");
  writeFileSync(reviewer, PERSONA("Auth-reviewer"));
  const run = await makeRun({ contract: {
    tasks: [task("api")], dissents: [dissentSpec("auth-check")], postmortem: { enabled: true },
  } });
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  await enabled(run);
  const finding = await ok("postmortem", {
    action: "record", project: run.root, execution_id: run.store.id,
    finding: { ...FINDING, responsible: ["auth-reviewer"] },
  });
  await ok("postmortem", {
    action: "fix", project: run.root, execution_id: run.store.id,
    finding_id: finding.recorded, fix: { status: "fixed" },
  });
  provider(t, { total: 3, block: `Artifact: persona_addendum | auth-reviewer | ${finding.recorded} | Review login checks before submitting` });
  const held = await ok("hold_postmortem", {
    project: run.root, execution_id: run.store.id, opening: "Review the login checks",
    participants: [reviewer, "tester"], rounds: 1, ...LLM,
  });
  const before = loadRecord(held.project, held.pm);
  assert.equal(before.refs["auth-reviewer"], reviewer);
  assert.deepEqual(before.dissents, (await run.store.state()).dissents);
  assert.equal(before.dissents["auth-check"].spec.claim, dissentSpec("auth-check").claim);
  const result = await ok("hold_postmortem", {
    action: "conclude", pm: held.pm, closing: "Keep the login checks", accept: ["a1"], orchestrator: "main",
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.applied[0].path, reviewer);
  assert.match(readFileSync(reviewer, "utf8"), /Review login checks before submitting/);
  const after = loadRecord(held.project, held.pm);
  assert.equal(after.status, "concluded");
  assert.deepEqual(after.refs, before.refs);
  assert.deepEqual(after.dissents, before.dissents);
});

test("secret-scanner persona refs survive persistence and route an accepted addendum through conclusion", async (t) => {
  const { WORKSPACE_DIR } = await import("../../dist/config.js");
  const dir = join(WORKSPACE_DIR, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const reviewer = join(dir, "secret-scanner.md");
  writeFileSync(reviewer, PERSONA("Secret-scanner"));
  t.after(() => rmSync(reviewer, { force: true }));
  const { repo, ids, work } = await atTheTable(t, { responsible: [["secret-scanner"]] });
  provider(t, { total: 3, block: `Artifact: persona_addendum | secret-scanner | ${ids[0]} | Review credential handling before submitting` });
  const held = await ok("hold_postmortem", {
    project: repo.root, work, opening: "Review credential handling",
    participants: [reviewer, "tester"], rounds: 1, ...LLM,
  });
  const before = loadRecord(held.project, held.pm);
  assert.equal(before.refs["secret-scanner"], reviewer);
  const result = await ok("hold_postmortem", {
    action: "conclude", pm: held.pm, closing: "Keep the credential checks", accept: ["a1"],
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.applied[0].path, reviewer);
  assert.match(readFileSync(reviewer, "utf8"), /Review credential handling before submitting/);
  const after = loadRecord(held.project, held.pm);
  assert.equal(after.status, "concluded");
  assert.deepEqual(after.refs, before.refs);
});

async function dissentMeeting(t, { outcomes = ["vindicated", "refuted", "untested"], malformed = false } = {}) {
  const specs = ["fired", "quiet", "unresolved", "unassessed"].map(dissentSpec);
  const run = await makeRun({ contract: { tasks: [task("api")], dissents: specs, postmortem: { enabled: true } } });
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  await enabled(run);
  await run.store.transact(() => ({ events: [
    { type: "dissent.tripwire_fired", source: runner, payload: { dissent_id: "fired", task: "api", tripped_by: "builder", evidence: "A blocked task is a signal \\| not proof" } },
    { type: "dissent.scored", source: { kind: "orchestrator", id: "main", pid: process.pid }, payload: { dissent_id: "quiet", outcome: "untested" } },
  ] }));
  const finding = await ok("postmortem", { action: "record", project: run.root, execution_id: run.store.id, finding: FINDING });
  await ok("postmortem", { action: "fix", project: run.root, execution_id: run.store.id, finding_id: finding.recorded, fix: { status: "fixed" } });
  const block = outcomes.map((outcome, n) => `Artifact: dissent_score | ${specs[n].id} | ${finding.recorded} | ${outcome} | src/api/index.js supports ${outcome} \\| evidence`).join("\n");
  const requests = provider(t, { total: 3, block: block + (malformed ? `\nArtifact: dissent_score | missing | ${finding.recorded} | vindicated | bad target` : "") });
  const held = await ok("hold_postmortem", { project: run.root, execution_id: run.store.id, opening: "Review the predictions against the evidence", participants: ["tester"], rounds: 1, ...LLM });
  return { run, held, finding, requests };
}

test("postmortem finding → accepted assessments → dissent.scored → replay, with evidence, audit and display-only semantics", async (t) => {
  const { run, held, finding, requests } = await dissentMeeting(t, { malformed: true });
  const before = await run.store.state();
  const rec = loadRecord(held.project, held.pm);
  assert.deepEqual(rec.dissents, before.dissents);
  assert.deepEqual(held.dissents, before.dissents);
  assert.equal(held.rejected_lines.length, 1);
  assert.equal(held.proposed_artifacts.length, 3);
  assert.ok(held.proposed_artifacts.every((a) => a.findings.includes(finding.recorded) && a.text.includes("src/api/index.js")));
  assert.match(requests[0].user, /## Dissents/);
  for (const id of ["fired", "quiet", "unresolved", "unassessed"]) {
    assert.ok(requests[0].user.includes(`Prediction ${id}`));
    assert.equal(rec.dissents[id].spec.claim, dissentSpec(id).claim);
  }
  const heldMd = await ok("postmortem", { action: "read", pm: held.pm });
  assert.match(heldMd, /not assessed/);
  assert.ok(heldMd.includes("Concern fired " + "\\\\\\|" + " remains data"), "backslashes are escaped before pipes");
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 1, "holding never invents a score");
  for (const orchestrator of [undefined, "other"]) {
    assert.match(await fails("hold_postmortem", { action: "conclude", pm: held.pm, closing: "Assessed", accept: ["a1"], ...(orchestrator && { orchestrator }) }), /only the contract's orchestrator/);
    assert.equal(loadRecord(held.project, held.pm).status, "held");
  }
  await ok("postmortem", { action: "disable", project: run.root, reason: "Stop postmortem meetings" });
  assert.match(await fails("hold_postmortem", { action: "conclude", pm: held.pm, closing: "Assessed", accept: ["a1"], orchestrator: "main" }), /off/);
  await enabled(run);
  const args = { action: "conclude", pm: held.pm, closing: "The evidence supports these assessments", accept: ["a1", "a2", "a3"], orchestrator: "main" };
  const done = await ok("hold_postmortem", args);
  assert.deepEqual(done.warnings, []);
  assert.equal(done.lessons_added, 0, "assessments never become planning rules");
  const events = await run.store.events({ types: ["dissent.scored"] });
  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(1).map((e) => e.payload.outcome), ["vindicated", "refuted", "untested"]);
  assert.ok(events.slice(1).every((e) => e.source.id === "main" && e.source.kind === "orchestrator" && e.correlation.startsWith(`postmortem:${held.pm}:`)));
  const state = await run.store.state();
  assert.equal(state.dissents.unassessed.score, undefined);
  assert.deepEqual(state.contract, before.contract);
  for (const key of ["tasks", "escalations", "inbox", "paused_tasks"]) assert.deepEqual(state[key], before[key], key);
  assert.equal(state.postmortem.meetings[held.pm].concluded.artifacts.dissent_score, 3);
  const { openExecutionStore } = await import("../../dist/execution/store.js");
  assert.deepEqual((await (await openExecutionStore(run.store.id)).state()).dissents, state.dissents);
  assert.equal((await run.store.verify()).ok, true);
  const { dissentTripwireRules } = await import("../../dist/execution/watchdog.js");
  assert.deepEqual(dissentTripwireRules(state), dissentTripwireRules(before), "scores do not change routing actions");
  const { wakeFor } = await import("../../dist/execution/watch.js");
  assert.equal(wakeFor(state, events[1], "main"), null, "a score does not wake or route");
  const { readArchivedSession } = await import("../../dist/sessions/archive.js");
  const archived = readArchivedSession(rec.session);
  assert.equal(archived.origin, `postmortem:${held.pm}`);
  assert.match(archived.transcript, /Artifact: dissent_score/);
  const { renderDissents, renderPostmortems } = await import("../../dist/dashboard/render.js");
  const pageContext = { state, header: run.store.header(), base: "/test/", runner: { status: "unknown", detail: "" } };
  assert.match(renderDissents(pageContext), /Score: vindicated/);
  assert.match(renderDissents(pageContext), /Score: not assessed/);
  const markdown = await ok("postmortem", { action: "read", pm: held.pm });
  const page = renderPostmortems(pageContext, { [held.pm]: { markdown } });
  assert.match(page, /3 dissent score/);
  assert.match(page, /Dissents/);
  assert.match(page, /Prediction unassessed/);

  const appliedAudit = readdirSync(AUDIT_DIR).flatMap((n) => readFileSync(join(AUDIT_DIR, n), "utf8").split("\n")).filter((l) => l.includes("postmortem.applied") && l.includes(held.pm));
  assert.equal(appliedAudit.length, 3);
  assert.ok(appliedAudit.every((l) => l.includes('"kind":"dissent_score"') && /"hash":"[0-9a-f]{64}"/.test(l)));
  const conclusion = (await run.store.events({ types: ["postmortem.concluded"] }))[0];
  assert.match((await run.store.getBlob(conclusion.payload.record)).toString(), /vindicated: src\/api\/index.js/);
  assert.equal((await ok("hold_postmortem", args)).already_concluded, true);
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 4);
});

test("rejected and omitted dissent assessments never score; firing does not determine the proposed outcome", async (t) => {
  const { run, held } = await dissentMeeting(t, { outcomes: ["refuted", "vindicated"] });
  const before = (await run.store.state()).dissents;
  const result = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "Insufficient evidence", reject: [{ id: "a1", why: "Not established" }] });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.not_accepted, ["a2"]);
  assert.deepEqual((await run.store.state()).dissents, before);
  assert.equal((await run.store.events({ types: ["dissent.scored"] })).length, 1);
});

test("dissent assessment parsing requires a reviewed dissent, finding, supported outcome and evidence on own lines", () => {
  const findings = new Set(["pmf-00000001"]);
  const dissents = new Set(["risk"]);
  const line = (target, outcome, text = "src/check.js confirms it") => `Artifact: dissent_score | ${target} | pmf-00000001 | ${outcome} | ${text}`;
  for (const candidate of [line("missing", "vindicated"), line("risk", "trusted"), line("risk", "refuted", ""), line("risk", "refuted").replace("pmf-00000001", "pmf-00000002")]) {
    const parsed = parseArtifactBlock(candidate, ["builder"], findings, dissents);
    assert.equal(parsed.artifacts.length, 0);
    assert.equal(parsed.rejected.length, 1);
  }
  assert.equal(parseArtifactBlock(line("risk", "refuted"), ["builder"], findings).artifacts.length, 0, "at-the-table work has no reviewed run");
  const parsed = parseArtifactBlock(["> " + line("risk", "vindicated"), "~~~", line("risk", "untested"), "~~~", line("risk", "refuted")].join("\n"), ["builder"], findings, dissents);
  assert.equal(parsed.artifacts.length, 1);
  assert.equal(parsed.artifacts[0].outcome, "refuted");
  assert.equal(parsed.artifacts[0].text, "src/check.js confirms it");
  assert.notEqual(parsed.artifacts[0].hash, parseArtifactBlock(line("risk", "vindicated"), ["builder"], findings, dissents).artifacts[0].hash);
});

test("dissent snapshots preserve historical firing evidence, distinguish current generations, scrub secrets and keep every dissent in bounded input", async () => {
  const { reviewedDissents, dissentsSection } = await import("../../dist/postmortem/dissents.js");
  const { initialState } = await import("../../dist/execution/blackboard.js");
  const state = { ...initialState("exe-test"), dissents: Object.fromEntries(Array.from({ length: 16 }, (_, n) => {
    const id = `risk-${String(n).padStart(2, "0")}-${"a".repeat(56)}`;
    return [id, { spec: { ...dissentSpec(id), by: "a".repeat(200), claim: "\\|".repeat(250), predicted_failure: "\\|".repeat(250) }, generation: 10, fires: {
      old: { dissent_id: id, task: "api", tripped_by: "builder", evidence: "Old observation tk_Abcdefghij0123456789", seq: 9 },
    } }];
  })) };
  const snapshot = reviewedDissents(state);
  assert.ok(!JSON.stringify(snapshot).includes("tk_Abcdefghij0123456789"));
  assert.ok(JSON.stringify(state).includes("tk_Abcdefghij0123456789"), "snapshot does not mutate its source");
  const full = dissentsSection(snapshot);
  assert.ok(full.includes("| no |"), "historical firings do not mark the current predicate fired");
  assert.match(full, /seq 9 task api/);
  const context = buildPostmortemContext({ scope: { execution_id: "exe-test" }, format: "collaborate", seats: ["builder", "tester"], opening: "Review", findings: [], state });
  assert.ok(context.length <= 12000);
  for (const id of Object.keys(state.dissents)) assert.ok(context.includes(id), `includes ${id}`);
});

test("a postmortem conclusion retried after its scoring write does not duplicate it or revert a later assessment", async (t) => {
  const { run, held } = await dissentMeeting(t, { outcomes: ["vindicated"] });
  const { scoreDissent } = await import("../../dist/execution/dissent-scoring.js");
  const artifact = loadRecord(held.project, held.pm).proposed[0];
  const input = { contractId: run.contract.id, orchestrator: "main", dissentId: artifact.target, outcome: artifact.outcome,
    operationKey: `postmortem:${held.pm}:${artifact.id}:${artifact.hash}` };
  // The event was persisted, but the process stopped before saving the concluded record.
  await scoreDissent(run.store, input);
  await scoreDissent(run.store, { ...input, outcome: "refuted", operationKey: undefined });
  const before = await run.store.events({ types: ["dissent.scored"] });
  const done = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "Close the interrupted review", orchestrator: "main", accept: [artifact.id] });
  assert.deepEqual(done.warnings, []);
  assert.equal((await run.store.state()).dissents.fired.score, "refuted");
  assert.deepEqual(await run.store.events({ types: ["dissent.scored"] }), before);
});

for (const winnerStatus of ["held", "concluded"]) {
  test(`overlapping holds cannot overwrite a ${winnerStatus} record`, async (t) => {
    const { repo, ids, work } = await atTheTable(t);
    let release;
    let entered;
    const blocked = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    provider(t, { reply: async ({ index }) => {
      if (index === 0) { entered(); await gate; }
      return `Mechanism reviewed.\nArtifact: rule | project | ${ids[0]} | Keep this accepted prevention rule`;
    } });
    const args = { project: repo.root, work, opening: "Review the mechanism", participants: ["tester"], rounds: 1, ...LLM };
    const slower = handleToolCall("hold_postmortem", args);
    await blocked;
    try {
      const winner = await ok("hold_postmortem", args);
      if (winnerStatus === "concluded") await ok("hold_postmortem", { action: "conclude", pm: winner.pm, closing: "Preserve this closing statement", accept: ["a1"] });
      const saved = loadRecord(winner.project, winner.pm);
      release();
      const loser = await slower;
      assert.equal(loser.isError, true);
      assert.match(loser.content[0].text, new RegExp(`already ${winnerStatus}.*another hold`));
      assert.deepEqual(loadRecord(winner.project, winner.pm), saved, "closing and application history survive");
    } finally { release(); await slower; }
  });
}

for (const failure of ["blob", "event"]) {
  test(`repeat conclude retries failed ${failure} publication once without reapplying artifacts`, async (t) => {
    const { run, held } = await dissentMeeting(t, { outcomes: ["vindicated"] });
    const proto = Object.getPrototypeOf(run.store);
    let broken = true;
    if (failure === "blob") {
      const original = proto.putBlob;
      t.mock.method(proto, "putBlob", async function (content, opts) {
        if (broken && String(content).startsWith("# Postmortem")) throw new Error("record blob unavailable");
        return original.call(this, content, opts);
      });
    } else {
      const original = proto.transact;
      t.mock.method(proto, "transact", function (fn) {
        return original.call(this, async (ctx) => {
          const out = await fn(ctx);
          if (broken && out.events.some((e) => e.type === "postmortem.concluded")) throw new Error("publication event unavailable");
          return out;
        });
      });
    }
    const args = { action: "conclude", pm: held.pm, closing: "Keep the original conclusion", accept: ["a1"], orchestrator: "main" };
    const first = await ok("hold_postmortem", args);
    assert.match(first.warnings.join("\n"), /Repeat conclude to retry publication/);
    assert.equal(loadRecord(held.project, held.pm).status, "concluded");
    assert.equal((await run.store.events({ types: ["postmortem.concluded"] })).length, 0);
    const scores = await run.store.events({ types: ["dissent.scored"] });
    broken = false;
    const repeats = await Promise.all([ok("hold_postmortem", { ...args, closing: "Do not replace the original" }), ok("hold_postmortem", args)]);
    assert.ok(repeats.every((r) => r.already_concluded && !r.warnings.length));
    assert.deepEqual(await run.store.events({ types: ["dissent.scored"] }), scores);
    const conclusions = await run.store.events({ types: ["postmortem.concluded"] });
    assert.equal(conclusions.length, 1);
    assert.equal(conclusions[0].payload.id, held.pm);
    assert.match((await run.store.getBlob(conclusions[0].payload.record)).toString(), /Keep the original conclusion/);
    assert.equal(loadRecord(held.project, held.pm).closing, args.closing);
  });
}

test("a successful score with a failed audit remains applied and retries its audit before publication", async (t) => {
  const { run, held } = await dissentMeeting(t, { outcomes: ["vindicated"] });
  const backup = `${AUDIT_DIR}-pending-test`;
  renameSync(AUDIT_DIR, backup);
  writeFileSync(AUDIT_DIR, "audit storage unavailable");
  let restored = false;
  const restore = () => { if (!restored) { rmSync(AUDIT_DIR); renameSync(backup, AUDIT_DIR); restored = true; } };
  t.after(restore);
  const args = { action: "conclude", pm: held.pm, closing: "Assess the evidence", accept: ["a1"], orchestrator: "main" };
  const result = await ok("hold_postmortem", args);
  assert.equal(result.applied[0].audit_pending, true);
  assert.match(result.applied[0].note, /advisory assessment: vindicated/);
  assert.doesNotMatch(result.applied[0].note, /^failed/);
  assert.match(result.warnings.join("\n"), /was applied but its audit is pending/);
  assert.match(result.tell_the_human, /audit is still pending/);
  assert.equal((await run.store.state()).dissents.fired.score, "vindicated");
  assert.equal(loadRecord(held.project, held.pm).applied[0].audit_pending, true);
  assert.match(await ok("postmortem", { action: "read", pm: held.pm }), /accepted, audit pending/);
  assert.equal((await run.store.events({ types: ["postmortem.concluded"] })).length, 0);
  const scores = await run.store.events({ types: ["dissent.scored"] });
  const stillPending = await ok("hold_postmortem", args);
  assert.equal(stillPending.applied[0].audit_pending, true);
  restore();
  const recovered = await ok("hold_postmortem", args);
  assert.deepEqual(recovered.warnings, []);
  assert.equal(recovered.applied[0].audit_pending, undefined);
  assert.deepEqual(await run.store.events({ types: ["dissent.scored"] }), scores);
  assert.equal((await run.store.events({ types: ["postmortem.concluded"] })).length, 1);
  const entries = readdirSync(AUDIT_DIR).flatMap((n) => readFileSync(join(AUDIT_DIR, n), "utf8").split("\n")).filter((l) => l.includes("postmortem.applied") && l.includes(held.pm));
  assert.equal(entries.length, 1);
  await ok("hold_postmortem", args);
  assert.equal(readdirSync(AUDIT_DIR).flatMap((n) => readFileSync(join(AUDIT_DIR, n), "utf8").split("\n")).filter((l) => l.includes("postmortem.applied") && l.includes(held.pm)).length, 1);
});

for (const field of ["claim", "predicted_failure", "tripwire", "title"]) {
  test(`postmortem assessment checks the reviewed dissent after a ${field} amendment`, async (t) => {
    const { run, held } = await dissentMeeting(t, { outcomes: ["vindicated"] });
    const c = structuredClone((await run.store.state()).contract);
    c.version++;
    if (field === "title") c.title = "Unrelated title correction";
    else c.dissents[0][field] = field === "tripwire" ? { kind: "task_state", task: "api", state: "rejected" } : `Changed ${field}`;
    const blob = await run.store.putBlob(JSON.stringify(c));
    await run.store.transact(() => ({ events: [{ type: "contract.amended", source: runner, payload: {
      contract: c.id, version: c.version, blob, patch_blob: "patch", reason: "Amend the contract", affected_tasks: [],
    } }] }));
    const previous = await run.store.events({ types: ["dissent.scored"] });
    const result = await ok("hold_postmortem", { action: "conclude", pm: held.pm, closing: "Assess only the reviewed prediction", accept: ["a1"], orchestrator: "main" });
    if (field === "title") {
      assert.deepEqual(result.warnings, []);
      assert.equal((await run.store.state()).dissents.fired.score, "vindicated");
    } else {
      assert.match(result.warnings.join("\n"), /stale dissent assessment.*review it again/);
      assert.match(result.applied[0].note, /^failed: stale dissent assessment/);
      assert.deepEqual(await run.store.events({ types: ["dissent.scored"] }), previous);
    }
  });
}
